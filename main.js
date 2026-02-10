if (require("electron-squirrel-startup")) return;
const { app, BrowserWindow, ipcMain, dialog, Menu, powerMonitor, shell } = require("electron");
app.setAppUserModelId('com.yuma-dev.clips');
const { setupTitlebar, attachTitlebarToWindow } = require("custom-electron-titlebar/main");
const logger = require('./utils/logger');
const consoleBuffer = require('./utils/console-log-buffer');
consoleBuffer.patchConsole();

// Benchmark mode detection and harness initialization
const isBenchmarkMode = process.env.CLIPS_BENCHMARK === '1';
let benchmarkHarness = null;
if (isBenchmarkMode) {
  try {
    const { getMainHarness } = require('./benchmark/main-harness');
    benchmarkHarness = getMainHarness();
    benchmarkHarness.markStartup('moduleLoad');
    logger.info('[Benchmark] Main process harness initialized');
  } catch (e) {
    logger.error('[Benchmark] Failed to load harness:', e);
  }
}
const updaterModule = require('./main/updater');
const isDev = !app.isPackaged;
const path = require("path");
const fs = require("fs").promises;
const { loadSettings, saveSettings, updateSettings, getDefaultKeybindings, getClipLocation, setClipLocation } = require("./utils/settings-manager");
const steelSeriesModule = require('./main/steelseries-processor');
const readify = require("readify");
const { logActivity } = require('./utils/activity-tracker');
const diagnosticsModule = require('./diagnostics/collector');
const logUploader = require('./main/log-uploader');
const shareModule = require('./main/share');
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const IDLE_TIMEOUT = 5 * 60 * 1000;
const CLIPLIB_PROTOCOL = 'cliplib';
const CLIPLIB_AUTH_SESSION_TTL_MS = 10 * 60 * 1000;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// FFmpeg module
const ffmpegModule = require('./main/ffmpeg');
const { ffmpeg, ffprobeAsync, generateScreenshot } = ffmpegModule;

// Thumbnails module
const thumbnailsModule = require('./main/thumbnails');

// Metadata module
const metadataModule = require('./main/metadata');

// File watcher module
const fileWatcherModule = require('./main/file-watcher');

// Discord RPC module
const discordModule = require('./main/discord');

// Clips module
const clipsModule = require('./main/clips');

// Dialogs Module - handles all Electron dialog interactions
const dialogsModule = require('./main/dialogs');

// FFmpeg is initialized in the module, verify on startup
ffmpegModule.initFFmpeg().catch(err => {
  logger.error('FFmpeg initialization failed:', err);
});

function sendLog(window, type, message) {
  if (window && !window.isDestroyed()) {
    window.webContents.send('log', { type, message });
  }
}

// Log ffmpeg version
ipcMain.handle('get-ffmpeg-version', async (event) => {
  try {
    const version = await ffmpegModule.getFFmpegVersion();
    sendLog(event.sender.getOwnerBrowserWindow(), 'info', `FFmpeg version: ${version}`);
    return version;
  } catch (error) {
    sendLog(event.sender.getOwnerBrowserWindow(), 'error', `Error getting ffmpeg version: ${error}`);
    throw error;
  }
});

let idleTimer;

let mainWindow;
let settings;
let pendingCliplibAuthSession = null;
let isProcessingProtocolQueue = false;
const queuedProtocolUrls = [];
const queuedCliplibAuthEvents = [];

// Getter for cached settings (used by modules instead of loadSettings which reads from disk)
const getSettings = async () => settings;

function registerCliplibProtocol() {
  try {
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(CLIPLIB_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
        return;
      }
    }
    app.setAsDefaultProtocolClient(CLIPLIB_PROTOCOL);
  } catch (error) {
    logger.warn(`Failed to register ${CLIPLIB_PROTOCOL}:// protocol: ${error.message}`);
  }
}

function extractCliplibProtocolUrl(args = []) {
  if (!Array.isArray(args)) return null;
  return args.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(`${CLIPLIB_PROTOCOL}://`)) || null;
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function queueCliplibAuthEvent(eventPayload) {
  if (!eventPayload || typeof eventPayload !== 'object') return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    queuedCliplibAuthEvents.push(eventPayload);
    return;
  }
  const isLoading = typeof mainWindow.webContents.isLoadingMainFrame === 'function'
    ? mainWindow.webContents.isLoadingMainFrame()
    : mainWindow.webContents.isLoading();
  if (isLoading) {
    queuedCliplibAuthEvents.push(eventPayload);
    return;
  }
  mainWindow.webContents.send('cliplib-auth-event', eventPayload);
}

function flushCliplibAuthEvents() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const isLoading = typeof mainWindow.webContents.isLoadingMainFrame === 'function'
    ? mainWindow.webContents.isLoadingMainFrame()
    : mainWindow.webContents.isLoading();
  if (isLoading) {
    return;
  }
  while (queuedCliplibAuthEvents.length > 0) {
    const payload = queuedCliplibAuthEvents.shift();
    mainWindow.webContents.send('cliplib-auth-event', payload);
  }
}

async function clearLegacySharingToken() {
  if (!settings?.sharing || typeof settings.sharing !== 'object') return;
  if (!settings.sharing.apiToken) return;

  settings.sharing.apiToken = '';
  try {
    await saveSettings(settings);
  } catch (error) {
    logger.warn(`Failed to clear legacy sharing token from settings: ${error.message}`);
  }
}

async function migrateLegacySharingTokenIfPresent() {
  const legacyToken = typeof settings?.sharing?.apiToken === 'string'
    ? settings.sharing.apiToken.trim()
    : '';
  if (!legacyToken) return;

  const existingToken = await shareModule.getStoredApiToken();
  if (!existingToken) {
    await shareModule.setStoredApiToken(legacyToken);
  }
  await clearLegacySharingToken();
}

function hasValidPendingCliplibSession() {
  if (!pendingCliplibAuthSession) return false;
  return (Date.now() - pendingCliplibAuthSession.createdAt) <= CLIPLIB_AUTH_SESSION_TTL_MS;
}

async function handleCliplibProtocolUrl(protocolUrl) {
  const parsed = shareModule.parseDesktopAuthCallbackUrl(protocolUrl);
  if (!parsed.ok) {
    queueCliplibAuthEvent({
      status: 'error',
      message: parsed.error || 'Invalid ClipLib auth callback.'
    });
    return;
  }

  if (!hasValidPendingCliplibSession()) {
    pendingCliplibAuthSession = null;
    queueCliplibAuthEvent({
      status: 'error',
      message: 'No active ClipLib login session. Start login again from Settings.'
    });
    return;
  }

  if (parsed.session !== pendingCliplibAuthSession.session) {
    queueCliplibAuthEvent({
      status: 'error',
      message: 'ClipLib login session mismatch. Please retry login.'
    });
    return;
  }

  const expectedServerUrl = pendingCliplibAuthSession.serverUrl;
  pendingCliplibAuthSession = null;

  try {
    await shareModule.setStoredApiToken(parsed.token);
    await clearLegacySharingToken();

    const verify = await shareModule.testConnection(getSettings, {
      serverUrl: expectedServerUrl,
      apiToken: parsed.token
    });

    if (!verify?.success) {
      await shareModule.clearStoredApiToken();
      queueCliplibAuthEvent({
        status: 'error',
        message: verify?.error || 'ClipLib login succeeded but token verification failed.'
      });
      return;
    }

    queueCliplibAuthEvent({
      status: 'success',
      displayName: verify.displayName || 'Unknown user'
    });
  } catch (error) {
    try {
      await shareModule.clearStoredApiToken();
    } catch (_) {
      // ignore cleanup errors
    }
    queueCliplibAuthEvent({
      status: 'error',
      message: `ClipLib login failed: ${error.message}`
    });
  } finally {
    focusMainWindow();
  }
}

async function processQueuedProtocolUrls() {
  if (isProcessingProtocolQueue || !app.isReady() || !settings) {
    return;
  }

  isProcessingProtocolQueue = true;
  try {
    while (queuedProtocolUrls.length > 0) {
      const nextUrl = queuedProtocolUrls.shift();
      await handleCliplibProtocolUrl(nextUrl);
    }
  } finally {
    isProcessingProtocolQueue = false;
  }
}

function queueProtocolUrl(protocolUrl) {
  if (typeof protocolUrl !== 'string' || !protocolUrl.trim()) {
    return;
  }
  queuedProtocolUrls.push(protocolUrl.trim());
  processQueuedProtocolUrls().catch((error) => {
    logger.error('Failed processing queued protocol URLs:', error);
  });
}

setupTitlebar();

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

const initialProtocolUrl = extractCliplibProtocolUrl(process.argv);
if (initialProtocolUrl) {
  queuedProtocolUrls.push(initialProtocolUrl);
}

app.on('second-instance', (event, commandLine) => {
  const protocolUrl = extractCliplibProtocolUrl(commandLine);
  if (protocolUrl) {
    queueProtocolUrl(protocolUrl);
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow().catch((error) => {
      logger.error('Failed to create window on second-instance event:', error);
    });
  }
  focusMainWindow();
});

app.on('open-url', (event, protocolUrl) => {
  event.preventDefault();
  queueProtocolUrl(protocolUrl);
});

async function createWindow() {
  if (benchmarkHarness) benchmarkHarness.markStartup('settingsLoad');
  settings = await loadSettings();
  if (benchmarkHarness) benchmarkHarness.endStartup('settingsLoad');
  try {
    await migrateLegacySharingTokenIfPresent();
  } catch (error) {
    logger.warn(`Legacy sharing token migration failed: ${error.message}`);
  }

  // Initialize thumbnail cache
  await thumbnailsModule.initThumbnailCache();

  if (benchmarkHarness) benchmarkHarness.markStartup('fileWatcherSetup');
  fileWatcherModule.setupFileWatcher(settings.clipLocation, {
    onNewClip: (fileName) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('new-clip-added', fileName);
      }
    }
  });
  if (benchmarkHarness) benchmarkHarness.endStartup('fileWatcherSetup');

  // Skip Discord RPC in benchmark mode to avoid external dependencies
  if (settings.enableDiscordRPC && !isBenchmarkMode) {
    discordModule.initDiscordRPC(getSettings);
  }

  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    titleBarStyle: "hidden",
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    frame: false,
    titleBarOverlay: {
      color: '#1e1e1e',
      symbolColor: '#e0e0e0',
      height: 30
    },
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false,
      enableRemoteModule: true
    },
  });

  attachTitlebarToWindow(mainWindow);
  mainWindow.loadFile("index.html");
  mainWindow.maximize();
  Menu.setApplicationMenu(null);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key.toLowerCase() === 'i' && input.control && input.shift) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    flushCliplibAuthEvents();
    processQueuedProtocolUrls().catch((error) => {
      logger.error('Failed processing protocol queue after renderer load:', error);
    });
  });
  
  if (isDev) {
    try {
      require("electron-reloader")(module, {
        debug: process.env.CLIPS_RELOADER_DEBUG === '1',
        watchRenderer: true,
      });
    } catch (_) {
      logger.info("Error");
    }
  }

  // detect idling

  mainWindow.on('focus', () => {
    clearTimeout(idleTimer);
    if (settings.enableDiscordRPC) {
      mainWindow.webContents.send('check-activity-state');
    }
  });

  mainWindow.on('blur', () => {
    if (settings.enableDiscordRPC) {
      idleTimer = setTimeout(() => {
        discordModule.clearDiscordPresence();
      }, IDLE_TIMEOUT);
    }
  });

  powerMonitor.on('unlock-screen', () => {
    clearTimeout(idleTimer);
    if (settings.enableDiscordRPC) {
      mainWindow.webContents.send('check-activity-state');
    }
  });

  powerMonitor.on('lock-screen', () => {
    if (settings.enableDiscordRPC) {
      discordModule.clearDiscordPresence();
    }
  });

  // Always resolve with the created window so callers can await it
  return mainWindow;
}

async function checkForUpdatesInBackground(mainWindow) {
  try {
    await updaterModule.checkForUpdates(mainWindow);
  } catch (error) {
    logger.error('Background update check failed:', error);
  }
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) {
    return;
  }

  registerCliplibProtocol();

  if (benchmarkHarness) {
    benchmarkHarness.endStartup('moduleLoad');
    benchmarkHarness.recordAppReady();
    benchmarkHarness.markStartup('windowCreation');
  }

  const win = await createWindow();

  if (benchmarkHarness) benchmarkHarness.endStartup('windowCreation');

  // Wait for the renderer to be fully loaded before checking for updates
  win.webContents.once('did-finish-load', () => {
    logger.info('Renderer did-finish-load event fired');
    
    // Skip update check in benchmark mode
    if (isBenchmarkMode) {
      logger.info('[Benchmark] Skipping update check in benchmark mode');
      return;
    }
    
    // Add a small delay to ensure the renderer's IPC listeners are set up
    setTimeout(() => {
      logger.info('Starting update check after delay');
      checkForUpdatesInBackground(win);
    }, 1500);
  });
  
  // Start periodic saves to prevent data loss
  clipsModule.startPeriodicSave(getSettings);

  processQueuedProtocolUrls().catch((error) => {
    logger.error('Failed processing startup protocol queue:', error);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('update-discord-presence', (event, details, state, startTimestamp) => {
  clearTimeout(idleTimer);
  discordModule.updateDiscordPresence(details, state);
});

ipcMain.handle('toggle-discord-rpc', async (event, enable) => {
  settings.enableDiscordRPC = enable;
  await saveSettings(settings);
  if (enable) {
    await discordModule.initDiscordRPC(getSettings);
  } else {
    discordModule.clearDiscordPresence();
    discordModule.destroyDiscordRPC();
  }
});

ipcMain.handle('clear-discord-presence', () => {
  discordModule.clearDiscordPresence();
});

ipcMain.handle('get-settings', () => {
  return settings;
});

ipcMain.handle("get-clips", async () => {
  return await clipsModule.getClips(getSettings);
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('quit-app', () => {
  app.quit();
});

ipcMain.handle('check-for-updates', async () => {
  return updaterModule.checkForUpdates(mainWindow, { silent: true });
});

ipcMain.handle('get-new-clip-info', async (event, fileName) => {
  return await clipsModule.getNewClipInfo(getSettings, fileName);
});

ipcMain.handle("save-custom-name", async (event, originalName, customName) => {
  try {
    await metadataModule.saveCustomName(originalName, customName, getSettings);
    return { success: true, customName };
  } catch (error) {
    logger.error("Error in save-custom-name handler:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-clip-info", async (event, clipName) => {
  return ffmpegModule.getClipInfo(clipName, getSettings, thumbnailsModule);
});

ipcMain.handle("get-trim", async (event, clipName) => {
  return metadataModule.getTrimData(clipName, getSettings);
});

ipcMain.handle("save-speed", async (event, clipName, speed) => {
  return metadataModule.saveSpeed(clipName, speed, getSettings);
});

ipcMain.handle("get-speed", async (event, clipName) => {
  return metadataModule.getSpeed(clipName, getSettings);
});

ipcMain.handle("save-volume", async (event, clipName, volume) => {
  return metadataModule.saveVolume(clipName, volume, getSettings);
});

ipcMain.handle("get-volume", async (event, clipName) => {
  return metadataModule.getVolume(clipName, getSettings);
});

ipcMain.handle("get-clip-tags", async (event, clipName) => {
  return metadataModule.getClipTags(clipName, getSettings);
});

ipcMain.handle("save-clip-tags", async (event, clipName, tags) => {
  return metadataModule.saveClipTags(clipName, tags, getSettings);
});

ipcMain.handle("load-global-tags", async () => {
  return metadataModule.loadGlobalTags(app.getPath.bind(app));
});

ipcMain.handle("save-global-tags", async (event, tags) => {
  return metadataModule.saveGlobalTags(tags, app.getPath.bind(app));
});

ipcMain.handle("restore-missing-global-tags", async () => {
  return metadataModule.restoreMissingGlobalTags(getSettings, app.getPath.bind(app));
});

ipcMain.handle('show-diagnostics-save-dialog', async () => {
  return dialogsModule.showDiagnosticsSaveDialog(mainWindow);
});

ipcMain.handle('generate-diagnostics-zip', async (event, targetPath) => {
  return diagnosticsModule.generateDiagnosticsZip(targetPath, event.sender);
});

ipcMain.handle('upload-session-logs', async (event, payload) => {
  return logUploader.uploadSessionLogs(payload);
});

ipcMain.handle('test-share-connection', async (event, overrides) => {
  return shareModule.testConnection(getSettings, overrides || {});
});

ipcMain.handle('start-cliplib-auth', async (event, overrides) => {
  const serverUrl = shareModule.DEFAULT_SERVER_URL;
  const requestedServerUrl = overrides?.serverUrl || serverUrl;
  const normalizedServerUrl = typeof requestedServerUrl === 'string' ? requestedServerUrl.trim() : serverUrl;

  try {
    const session = shareModule.generateDesktopAuthSessionId();
    const authUrl = shareModule.buildDesktopAuthUrl(normalizedServerUrl, session);
    pendingCliplibAuthSession = {
      session,
      serverUrl: normalizedServerUrl,
      createdAt: Date.now()
    };

    await shell.openExternal(authUrl);
    return {
      success: true
    };
  } catch (error) {
    pendingCliplibAuthSession = null;
    logger.error('Failed to start ClipLib desktop auth:', error);
    return {
      success: false,
      error: `Unable to open ClipLib login: ${error.message}`
    };
  }
});

ipcMain.handle('disconnect-cliplib-auth', async () => {
  pendingCliplibAuthSession = null;
  try {
    await shareModule.clearStoredApiToken();
    await clearLegacySharingToken();
    return { success: true };
  } catch (error) {
    logger.error('Failed to disconnect ClipLib auth:', error);
    return {
      success: false,
      error: `Unable to disconnect ClipLib account: ${error.message}`
    };
  }
});

ipcMain.handle('share-clip', async (event, payload) => {
  const sender = event.sender;
  const progressHandler = (progressPayload) => {
    if (!sender || sender.isDestroyed()) return;
    sender.send('share-upload-progress', progressPayload);
  };
  return shareModule.shareClip(payload, getSettings, ffmpegModule, progressHandler);
});

ipcMain.handle('get-share-users', async (event, overrides) => {
  return shareModule.fetchMentionableUsers(getSettings, overrides || {});
});

ipcMain.handle("remove-tag-from-all-clips", async (event, tagToRemove) => {
  return metadataModule.removeTagFromAllClips(tagToRemove, getSettings);
});

ipcMain.handle("update-tag-in-all-clips", async (event, oldTag, newTag) => {
  return metadataModule.updateTagInAllClips(oldTag, newTag, getSettings);
});

ipcMain.handle("get-clip-location", async () => {
  const location = await getClipLocation(getSettings);
  return location;
});

ipcMain.handle("set-clip-location", async (event, newLocation) => {
  const location = await setClipLocation(getSettings, newLocation);
  settings.clipLocation = newLocation; // Update cached settings
  return location;
});

ipcMain.handle("open-folder-dialog", async () => {
  return dialogsModule.showFolderDialog(mainWindow);
});

ipcMain.handle("get-thumbnail-path", async (event, clipName) => {
  return thumbnailsModule.getThumbnailPath(clipName, getSettings);
});

ipcMain.handle("get-thumbnail-paths-batch", async (event, clipNames) => {
  return thumbnailsModule.getThumbnailPathsBatch(clipNames, getSettings);
});

app.on('before-quit', () => {
  // Stop periodic saves
  clipsModule.stopPeriodicSave();

  // Stop thumbnail queue processing
  thumbnailsModule.stopQueue();

  // Save current clip list for next session comparison
  clipsModule.saveCurrentClipList(getSettings);
});

ipcMain.handle("regenerate-thumbnail-for-trim", async (event, clipName, startTime) => {
  return thumbnailsModule.regenerateThumbnailForTrim(clipName, startTime, getSettings);
});

// In main.js
ipcMain.handle('save-settings', async (event, newSettings) => {
  try {
    const updated = await updateSettings(newSettings);
    settings = updated; // Update main process settings cache
    return updated;
  } catch (error) {
    logger.error('Error in save-settings handler:', error);
    throw error;
  }
});

// Get default keybindings from settings-manager
ipcMain.handle('get-default-keybindings', () => {
  return getDefaultKeybindings();
});

ipcMain.handle("generate-thumbnails-progressively", async (event, clipNames) => {
  // Wrapper to call metadata module's getTrimData with getSettings
  const getTrimDataWrapper = (clipName) => metadataModule.getTrimData(clipName, getSettings);
  return thumbnailsModule.generateThumbnailsProgressively(clipNames, event, getSettings, getTrimDataWrapper);
});


ipcMain.handle("generate-thumbnail", async (event, clipName) => {
  return thumbnailsModule.generateThumbnail(clipName, getSettings);
});

ipcMain.handle("save-trim", async (event, clipName, start, end) => {
  try {
    await metadataModule.saveTrimData(clipName, { start, end }, getSettings);
    return { success: true };
  } catch (error) {
    logger.error("Error in save-trim handler:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("delete-trim", async (event, clipName) => {
  try {
    await metadataModule.deleteTrimData(clipName, getSettings);
    return { success: true };
  } catch (error) {
    logger.error("Error in delete-trim handler:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("delete-clip", async (event, clipName, videoPlayer) => {
  return clipsModule.deleteClip(clipName, getSettings, thumbnailsModule, videoPlayer);
});

// Reveal clip in File Explorer
ipcMain.handle('reveal-clip', async (event, clipName) => {
  return clipsModule.revealClip(clipName, getSettings);
});

ipcMain.handle("open-save-dialog", async (event, type, clipName, customName) => {
  return dialogsModule.showSaveDialog(mainWindow, type, clipName, customName);
});

ipcMain.handle("export-video", async (event, clipName, start, end, volume, speed, savePath) => {
  return ffmpegModule.exportVideo(clipName, start, end, volume, speed, savePath, getSettings);
});

ipcMain.handle("export-trimmed-video", async (event, clipName, start, end, volume, speed) => {
  return ffmpegModule.exportTrimmedVideo(clipName, start, end, volume, speed, getSettings);
});

ipcMain.handle("export-audio", async (event, clipName, start, end, volume, speed, savePath) => {
  return ffmpegModule.exportAudio(clipName, start, end, volume, speed, savePath, getSettings);
});

ipcMain.handle('get-tag-preferences', async () => {
  return metadataModule.getTagPreferences(app.getPath.bind(app));
});

ipcMain.handle('save-tag-preferences', async (event, preferences) => {
  return metadataModule.saveTagPreferences(preferences, app.getPath.bind(app));
});

ipcMain.handle('open-folder-dialog-steelseries', async () => {
  return dialogsModule.showSteelSeriesFolderDialog();
});

ipcMain.handle('import-steelseries-clips', async (event, sourcePath) => {
  return steelSeriesModule.importSteelSeriesClips(
    sourcePath,
    loadSettings,
    app.getPath.bind(app),
    event.sender
  );
});

ipcMain.handle('save-volume-range', async (event, clipName, volumeData) => {
  return metadataModule.saveVolumeRange(clipName, volumeData, getSettings);
});

ipcMain.handle('get-volume-range', async (event, clipName) => {
  return metadataModule.getVolumeRange(clipName, getSettings);
});

// Handler to log watch sessions from the renderer
ipcMain.handle('log-watch-session', (event, sessionData) => {
  if (sessionData && sessionData.durationSeconds > 0) {
    logActivity('watch_session', sessionData);
  }
  // No return value needed
});

ipcMain.handle("get-game-icon", async (event, clipName) => {
  return metadataModule.getGameIcon(clipName, getSettings);
});

ipcMain.handle('get-new-clips-info', async () => {
  return await clipsModule.getNewClipsInfo(getSettings);
});

ipcMain.handle('save-clip-list-immediately', async () => {
  await clipsModule.saveCurrentClipList(getSettings);
});

