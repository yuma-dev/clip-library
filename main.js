if (require("electron-squirrel-startup")) return;
const { app, BrowserWindow, ipcMain, dialog, Menu, powerMonitor, shell } = require("electron");
app.setAppUserModelId('com.yuma-dev.clips');
const { setupTitlebar, attachTitlebarToWindow } = require("custom-electron-titlebar/main");
const logger = require('./utils/logger');

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
const { checkForUpdates } = require('./main/updater');
const isDev = !app.isPackaged;
const path = require("path");
const fs = require("fs").promises;
const { loadSettings, saveSettings } = require("./utils/settings-manager");
const SteelSeriesProcessor = require('./main/steelseries-processor');
const readify = require("readify");
const { logActivity } = require('./utils/activity-tracker');
const { createDiagnosticsBundle } = require('./diagnostics/collector');
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const DiscordRPC = require('discord-rpc');
const clientId = '1264368321013219449';
const IDLE_TIMEOUT = 5 * 60 * 1000;

// FFmpeg module
const ffmpegModule = require('./main/ffmpeg');
const { ffmpeg, ffprobeAsync, generateScreenshot } = ffmpegModule;

// Thumbnails module
const thumbnailsModule = require('./main/thumbnails');

// Metadata module
const metadataModule = require('./main/metadata');

// File watcher module
const fileWatcherModule = require('./main/file-watcher');

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

// Getter for cached settings (used by modules instead of loadSettings which reads from disk)
const getSettings = async () => settings;

setupTitlebar();

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

async function createWindow() {
  if (benchmarkHarness) benchmarkHarness.markStartup('settingsLoad');
  settings = await loadSettings();
  if (benchmarkHarness) benchmarkHarness.endStartup('settingsLoad');

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
    initDiscordRPC();
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
  
  if (isDev) {
    try {
      require("electron-reloader")(module, {
        debug: true,
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
        clearDiscordPresence();
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
      clearDiscordPresence();
    }
  });

  // Always resolve with the created window so callers can await it
  return mainWindow;
}

async function checkForUpdatesInBackground(mainWindow) {
  try {
    await checkForUpdates(mainWindow);
  } catch (error) {
    logger.error('Background update check failed:', error);
  }
}

app.whenReady().then(async () => {
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
  startPeriodicSave();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

let rpc = null;
let rpcReady = false;

function initDiscordRPC() {
  rpc = new DiscordRPC.Client({ transport: 'ipc' });
  rpc.on('ready', () => {
    logger.info('Discord RPC connected successfully');
    rpcReady = true;
    updateDiscordPresence('Browsing clips');
  });
  rpc.login({ clientId }).catch(error => {
    logger.error('Failed to initialize Discord RPC:', error);
  });
}

function updateDiscordPresence(details, state = null) {
  if (!rpcReady || !settings.enableDiscordRPC) {
    logger.info('RPC not ready or disabled');
    return;
  }

  const activity = {
    details: String(details),
    largeImageKey: 'app_logo',
    largeImageText: 'Clip Library',
    buttons: [{ label: 'View on GitHub', url: 'https://github.com/yuma-dev/clip-library' }]
  };

  if (state !== null) {
    activity.state = String(state);
  }

  rpc.setActivity(activity).catch(error => {
    logger.error('Failed to update Discord presence:', error);
  });
}

function clearDiscordPresence() {
  if (rpcReady) {
    rpc.clearActivity().catch(logger.error);
  }
}

ipcMain.handle('update-discord-presence', (event, details, state, startTimestamp) => {
  clearTimeout(idleTimer);
  updateDiscordPresence(details, state, startTimestamp);
});

ipcMain.handle('toggle-discord-rpc', async (event, enable) => {
  settings.enableDiscordRPC = enable;
  await saveSettings(settings);
  if (enable && !rpc) {
    initDiscordRPC();
  } else if (!enable && rpc) {
    clearDiscordPresence();
    rpc.destroy();
    rpc = null;
    rpcReady = false;
  }
});

ipcMain.handle('clear-discord-presence', () => {
  clearDiscordPresence();
});

ipcMain.handle('get-settings', () => {
  return settings;
});

ipcMain.handle("get-clips", async () => {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");

  try {
    const result = await readify(clipsFolder, {
      type: "raw",
      sort: "date",
      order: "desc",
    });

    const clipInfoPromises = result.files
      .filter((file) =>
        [".mp4", ".avi", ".mov"].includes(
          path.extname(file.name).toLowerCase(),
        ),
      )
      .map(async (file) => {
        const fullPath = path.join(clipsFolder, file.name);
        
        // Check if file exists before processing
        try {
          await fs.access(fullPath);
        } catch (error) {
          // File doesn't exist, skip it
          logger.info(`Skipping non-existent file: ${file.name}`);
          return null;
        }

        const customNamePath = path.join(
          metadataFolder,
          `${file.name}.customname`,
        );
        const trimPath = path.join(metadataFolder, `${file.name}.trim`);
        const datePath = path.join(metadataFolder, `${file.name}.date`);
        let customName;
        let isTrimmed = false;
        let createdAt = file.date.getTime();

        try {
          customName = await fs.readFile(customNamePath, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT")
            logger.error("Error reading custom name:", error);
          customName = path.basename(file.name, path.extname(file.name));
        }

        try {
          await fs.access(trimPath);
          isTrimmed = true;
        } catch (error) {
          // If trim file doesn't exist, isTrimmed remains false
        }

        // Try to read recording timestamp from metadata
        try {
          const dateStr = await fs.readFile(datePath, "utf8");
          // Parse ISO 8601 date string (e.g., "2023-08-02T22:07:31+02:00")
          const recordingDate = new Date(dateStr);
          if (!isNaN(recordingDate.getTime())) {
            createdAt = recordingDate.getTime();
            logger.info(`Using recording timestamp for ${file.name}: ${dateStr}`);
          }
        } catch (error) {
          if (error.code !== "ENOENT") {
            logger.error("Error reading date metadata:", error);
          }
          // If date file doesn't exist or is invalid, keep using the file system date
        }

        const thumbnailPath = thumbnailsModule.generateThumbnailPath(fullPath);

        return {
          originalName: file.name,
          customName: customName,
          createdAt: createdAt,
          thumbnailPath: thumbnailPath,
          isTrimmed: isTrimmed,
        };
      });

    const clipInfos = (await Promise.all(clipInfoPromises)).filter(Boolean); // Remove null entries
    return clipInfos;
  } catch (error) {
    logger.error("Error reading directory:", error);
    return [];
  }
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await checkForUpdates(mainWindow, { silent: true });
    return result;
  } catch (error) {
    logger.error('Manual update check failed:', error);
    return { updateAvailable: false, error: error.message || 'Check failed' };
  }
});

ipcMain.handle('get-new-clip-info', async (event, fileName) => {
  const filePath = path.join(settings.clipLocation, fileName);
  const metadataFolder = path.join(settings.clipLocation, ".clip_metadata");
  const datePath = path.join(metadataFolder, `${fileName}.date`);
  const stats = await fs.stat(filePath);
  
  // Default to file system time
  let createdAt = stats.birthtimeMs || stats.ctimeMs;

  // Try to read recording timestamp from metadata if available
  try {
    const dateStr = await fs.readFile(datePath, "utf8");
    // Parse ISO 8601 date string (e.g., "2023-08-02T22:07:31+02:00")
    const recordingDate = new Date(dateStr);
    if (!isNaN(recordingDate.getTime())) {
      createdAt = recordingDate.getTime();
      logger.info(`Using recording timestamp for new clip ${fileName}: ${dateStr}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.error("Error reading date metadata for new clip:", error);
    }
    // If date file doesn't exist or is invalid, keep using the file system time
  }
  
  // Create bare minimum clip info without any trim data
  const newClipInfo = {
    originalName: fileName,
    customName: path.basename(fileName, path.extname(fileName)),
    createdAt: createdAt,
    tags: [] // Initialize with empty tags array
  };

  return newClipInfo;
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
  logger.info(`[main] get-clip-info requested for: ${clipName}`);
  const clipPath = path.join(settings.clipLocation, clipName);
  const thumbnailPath = thumbnailsModule.generateThumbnailPath(clipPath);
  
  try {
    // Check if file exists first
    try {
      await fs.access(clipPath);
      logger.info(`[main] Clip file exists: ${clipPath}`);
    } catch (accessError) {
      logger.error(`[main] Clip file does not exist: ${clipPath}`, accessError);
      throw new Error(`Clip file not found: ${clipName}`);
    }

    // Try to get metadata from cache first
    const metadata = await thumbnailsModule.getThumbnailMetadata(thumbnailPath);
    if (metadata && metadata.duration) {
      logger.info(`[main] Using cached metadata for ${clipName} - duration: ${metadata.duration}`);
      return {
        format: {
          filename: clipPath,
          duration: metadata.duration
        }
      };
    }

    logger.info(`[main] No cached metadata found, running ffprobe for: ${clipName}`);
    // If no cached metadata, get it from ffprobe and cache it
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(clipPath, async (err, info) => {
        if (err) {
          logger.error(`[main] ffprobe failed for ${clipName}:`, err);
          reject(err);
        } else {
          logger.info(`[main] ffprobe successful for ${clipName} - duration: ${info.format.duration}`);
          // Cache the metadata
          const existingMetadata = await thumbnailsModule.getThumbnailMetadata(thumbnailPath) || {};
          await thumbnailsModule.saveThumbnailMetadata(thumbnailPath, {
            ...existingMetadata,
            duration: info.format.duration,
            timestamp: Date.now()
          });
          resolve(info);
        }
      });
    });
  } catch (error) {
    logger.error(`[main] Error getting clip info for ${clipName}:`, error);
    throw error;
  }
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
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultDirectory = app.getPath('documents');
  const defaultPath = path.join(defaultDirectory, `clips-diagnostics-${timestamp}.zip`);

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Diagnostics Zip',
    defaultPath,
    buttonLabel: 'Save Diagnostics',
    filters: [{ name: 'Zip Files', extensions: ['zip'] }]
  });

  return result.canceled ? null : result.filePath;
});

ipcMain.handle('generate-diagnostics-zip', async (event, targetPath) => {
  const sender = event.sender;

  if (!targetPath) {
    return { success: false, error: 'No output path provided' };
  }

  try {
    const result = await createDiagnosticsBundle({
      savePath: targetPath,
      progressCallback: (progress) => {
        if (sender && !sender.isDestroyed()) {
          sender.send('diagnostics-progress', progress);
        }
      }
    });

    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to generate diagnostics package:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("remove-tag-from-all-clips", async (event, tagToRemove) => {
  return metadataModule.removeTagFromAllClips(tagToRemove, getSettings);
});

ipcMain.handle("update-tag-in-all-clips", async (event, oldTag, newTag) => {
  return metadataModule.updateTagInAllClips(oldTag, newTag, getSettings);
});

ipcMain.handle("get-clip-location", () => {
  return settings.clipLocation;
});

ipcMain.handle("set-clip-location", async (event, newLocation) => {
  settings.clipLocation = newLocation;
  await saveSettings(settings);
  return settings.clipLocation;
});

ipcMain.handle("open-folder-dialog", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle("get-thumbnail-path", async (event, clipName) => {
  return thumbnailsModule.getThumbnailPath(clipName, getSettings);
});

ipcMain.handle("get-thumbnail-paths-batch", async (event, clipNames) => {
  return thumbnailsModule.getThumbnailPathsBatch(clipNames, getSettings);
});

app.on('before-quit', () => {
  // Stop periodic saves
  stopPeriodicSave();

  // Stop thumbnail queue processing
  thumbnailsModule.stopQueue();

  // Save current clip list for next session comparison
  saveCurrentClipList();
});

ipcMain.handle("regenerate-thumbnail-for-trim", async (event, clipName, startTime) => {
  return thumbnailsModule.regenerateThumbnailForTrim(clipName, startTime, getSettings);
});

// In main.js
ipcMain.handle('save-settings', async (event, newSettings) => {
  try {
    await saveSettings(newSettings);
    settings = newSettings; // Update main process settings
    return newSettings;
  } catch (error) {
    logger.error('Error in save-settings handler:', error); 
    throw error;
  }
});

// Get default keybindings from settings-manager
ipcMain.handle('get-default-keybindings', () => {
  const { DEFAULT_SETTINGS } = require('./utils/settings-manager');
  return DEFAULT_SETTINGS.keybindings;
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
  const clipPath = path.join(settings.clipLocation, clipName);
  const metadataFolder = path.join(settings.clipLocation, ".clip_metadata");
  const customNamePath = path.join(metadataFolder, `${clipName}.customname`);
  const trimDataPath = path.join(metadataFolder, `${clipName}.trim`);
  const thumbnailPath = thumbnailsModule.generateThumbnailPath(clipPath);

  const filesToDelete = [clipPath, customNamePath, trimDataPath, thumbnailPath];

  if (videoPlayer) {
    videoPlayer.src = "";
  }

  const maxRetries = 50; // Up to ~5 seconds total retry time
  const retryDelay = 100; // 0.1 s between attempts

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      // Try deleting immediately; we'll retry quickly if the file is still busy.
      for (const file of filesToDelete) {
        try {
          if (process.platform === 'win32') {
            // Move the file to the Recycle Bin for a more native deletion behaviour
            await shell.trashItem(file);
          } else {
            // Fallback for non-Windows platforms (should not be hit in our use-case)
            await fs.unlink(file);
          }
        } catch (e) {
          // If trashing failed because the file is missing, continue silently
          if (e.code === 'ENOENT') {
            continue;
          }

          // If trashing failed for another reason on Windows, fall back to a direct unlink
          if (process.platform === 'win32') {
            try {
              await fs.unlink(file);
              continue;
            } catch (e2) {
              if (e2.code === 'ENOENT') {
                continue;
              }
              throw e2;
            }
          }

          // Throw other unexpected errors so the retry logic can handle them
          throw e;
        }
      }

      // Log deletion activity
      logActivity('delete', { clipName });
      return { success: true };
    } catch (error) {
      if ((error.code === "EBUSY" || error.code === "EPERM") && retry < maxRetries - 1) {
        // If the file is busy and we haven't reached max retries, wait and try again
        await delay(retryDelay);
      } else {
        logger.error(`Error deleting clip ${clipName}:`, error);
        return { success: false, error: error.message };
      }
    }
  }

  // If we've exhausted all retries
  return {
    success: false,
    error:
      "Failed to delete clip after multiple attempts. The file may be in use.",
  };
});

// Reveal clip in File Explorer
ipcMain.handle('reveal-clip', async (event, clipName) => {
  try {
    const clipPath = path.join(settings.clipLocation, clipName);
    shell.showItemInFolder(clipPath);
    return { success: true };
  } catch (error) {
    logger.error('Error revealing clip:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("open-save-dialog", async (event, type, clipName, customName) => {
  const extension = type === "audio" ? ".mp3" : ".mp4";
  const defaultName = (customName || clipName || "clip") + extension;
  
  const options = {
    defaultPath: defaultName,
    filters: type === "audio" 
      ? [{ name: "Audio Files", extensions: ["mp3"] }]
      : [{ name: "Video Files", extensions: ["mp4"] }],
  };
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result.canceled ? null : result.filePath;
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
  try {
    const prefsPath = path.join(app.getPath('userData'), 'tagPreferences.json');
    const prefs = await fs.readFile(prefsPath, 'utf8');
    return JSON.parse(prefs);
  } catch (error) {
    return null;
  }
});

ipcMain.handle('save-tag-preferences', async (event, preferences) => {
  try {
    const prefsPath = path.join(app.getPath('userData'), 'tagPreferences.json');
    await fs.writeFile(prefsPath, JSON.stringify(preferences));
    return true;
  } catch (error) {
    console.error('Error saving tag preferences:', error);
    return false;
  }
});

ipcMain.handle('open-folder-dialog-steelseries', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select your SteelSeries Clips Folder'
  });
  
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('import-steelseries-clips', async (event, sourcePath) => {
  try {
    const settings = await loadSettings();
    const clipLocation = settings.clipLocation;

    // Add "Imported" to global tags if it doesn't exist
    let globalTags = [];
    try {
      const tagsFilePath = path.join(app.getPath("userData"), "global_tags.json");
      try {
        const tagsData = await fs.readFile(tagsFilePath, "utf8");
        globalTags = JSON.parse(tagsData);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
        // File doesn't exist yet, use empty array
      }

      if (!globalTags.includes("Imported")) {
        globalTags.push("Imported");
        await fs.writeFile(tagsFilePath, JSON.stringify(globalTags));
      }
    } catch (error) {
      logger.error("Error managing global tags:", error);
    }

    const processor = new SteelSeriesProcessor(
      sourcePath,
      clipLocation,
      (current, total) => {
        event.sender.send('steelseries-progress', { current, total });
      },
      (message) => {
        event.sender.send('steelseries-log', { type: 'info', message });
      }
    );

    // Log import start
    logActivity('import_start', { source: 'steelseries', sourcePath });

    await processor.processFolder();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
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

const LAST_CLIPS_FILE = path.join(app.getPath('userData'), 'last-clips.json');

async function saveCurrentClipList() {
  try {
    const clipsFolder = settings.clipLocation;
    
    if (!clipsFolder) {
      logger.warn('No clip location set, skipping clip list save');
      return;
    }

    // Get current clip list (just the originalNames for comparison)
    const result = await readify(clipsFolder, {
      type: "raw",
      sort: "date", 
      order: "desc",
    });

    const clipNames = result.files
      .filter((file) =>
        [".mp4", ".avi", ".mov"].includes(
          path.extname(file.name).toLowerCase(),
        ),
      )
      .map(file => file.name);

    const clipListData = {
      timestamp: Date.now(),
      clips: clipNames
    };

    // Use atomic write to prevent corruption
    const tempFile = LAST_CLIPS_FILE + '.tmp';
    const jsonData = JSON.stringify(clipListData, null, 2);
    
    // Write to temp file first
    await fs.writeFile(tempFile, jsonData, 'utf8');
    
    // Verify the temp file was written correctly
    const verification = await fs.readFile(tempFile, 'utf8');
    JSON.parse(verification); // This will throw if invalid JSON
    
    // Atomically replace the original file
    await fs.rename(tempFile, LAST_CLIPS_FILE);
    
    logger.info(`Saved ${clipNames.length} clips for next session comparison`);
  } catch (error) {
    logger.error('Error saving current clip list:', error);
    
    // Clean up temp file if it exists
    try {
      const tempFile = LAST_CLIPS_FILE + '.tmp';
      await fs.unlink(tempFile);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
  }
}

async function getNewClipsInfo() {
  try {
    // Load previously saved clip list
    let previousClips = [];
    try {
      const data = await fs.readFile(LAST_CLIPS_FILE, 'utf8');
      
      // Check for empty file
      if (data.trim().length === 0) {
        logger.warn('Empty clip list file, treating as first run');
        return { newClips: [], totalNewCount: 0 };
      }
      
      const parsed = JSON.parse(data);
      previousClips = parsed.clips || [];
      logger.info(`Loaded ${previousClips.length} clips from previous session`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Error reading previous clip list:', error);
        // Try to backup corrupted file
        try {
          const backupPath = LAST_CLIPS_FILE + '.backup.' + Date.now();
          await fs.copyFile(LAST_CLIPS_FILE, backupPath);
          logger.info(`Backed up corrupted file to: ${backupPath}`);
        } catch (backupError) {
          logger.error('Failed to backup corrupted file:', backupError);
        }
      }
      // First time running, file doesn't exist, or corrupted - no previous clips
      return { newClips: [], totalNewCount: 0 };
    }

    // Get current clip list
    const clipsFolder = settings.clipLocation;
    const result = await readify(clipsFolder, {
      type: "raw",
      sort: "date",
      order: "desc",
    });

    const currentClips = result.files
      .filter((file) =>
        [".mp4", ".avi", ".mov"].includes(
          path.extname(file.name).toLowerCase(),
        ),
      )
      .map(file => file.name);

    // Find new clips (clips that weren't in the previous list)
    const newClips = currentClips.filter(clipName => !previousClips.includes(clipName));
    
    logger.info(`Found ${newClips.length} new clips since last session`);
    
    return {
      newClips: newClips,
      totalNewCount: newClips.length
    };
  } catch (error) {
    logger.error('Error getting new clips info:', error);
    return { newClips: [], totalNewCount: 0 };
  }
}

ipcMain.handle('get-new-clips-info', async () => {
  return await getNewClipsInfo();
});

ipcMain.handle('save-clip-list-immediately', async () => {
  await saveCurrentClipList();
});

// Periodic save to prevent data loss
let periodicSaveInterval;

function startPeriodicSave() {
  // Save every 5 minutes
  periodicSaveInterval = setInterval(() => {
    saveCurrentClipList().catch(error => {
      logger.error('Error in periodic save:', error);
    });
  }, 5 * 60 * 1000);
}

function stopPeriodicSave() {
  if (periodicSaveInterval) {
    clearInterval(periodicSaveInterval);
    periodicSaveInterval = null;
  }
}

