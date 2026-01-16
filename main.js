if (require("electron-squirrel-startup")) return;
const { app, BrowserWindow, ipcMain, dialog, Menu, powerMonitor, shell } = require("electron");
app.setAppUserModelId('com.yuma-dev.clips');
const { setupTitlebar, attachTitlebarToWindow } = require("custom-electron-titlebar/main");
const logger = require('./logger');

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
const { checkForUpdates } = require('./updater');
const isDev = !app.isPackaged;
const path = require("path");
const chokidar = require("chokidar");
const fs = require("fs").promises;
const { loadSettings, saveSettings } = require("./settings-manager");
const SteelSeriesProcessor = require('./steelseries-processor');
const readify = require("readify");
const { logActivity } = require('./activity-tracker');
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
  setupFileWatcher(settings.clipLocation);
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

function setupFileWatcher(clipLocation) {
  if (!clipLocation) {
    logger.warn('No clip location provided for file watcher');
    return;
  }

  // Clean up any existing watcher
  if (global.fileWatcher) {
    global.fileWatcher.close();
  }

  const watcher = chokidar.watch(clipLocation, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,  // Don't fire events for existing files
    awaitWriteFinish: {   // Wait for file to be fully written
      stabilityThreshold: 2000,
      pollInterval: 100
    }
  });

  watcher.on('add', async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) {
      const fileName = path.basename(filePath);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('new-clip-added', fileName);
      }
    }
  });

  // Store watcher reference for cleanup
  global.fileWatcher = watcher;

  logger.info(`File watcher set up for: ${clipLocation}`);
}

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
    await saveCustomNameData(originalName, customName);
    // Log the rename activity
    logActivity('rename', { originalName, newCustomName: customName });
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
  logger.info(`Getting trim data for: ${clipName}`);
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");
  const trimFilePath = path.join(metadataFolder, `${clipName}.trim`);

  try {
    const trimData = await fs.readFile(trimFilePath, "utf8");
    logger.info(`Found trim data for ${clipName}:`, trimData);
    return JSON.parse(trimData);
  } catch (error) {
    if (error.code === "ENOENT") {
      logger.info(`No trim data found for ${clipName}`);
      return null;
    }
    logger.error(`Error reading trim data for ${clipName}:`, error);
    throw error;
  }
});

ipcMain.handle("save-speed", async (event, clipName, speed) => {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");
  await ensureDirectoryExists(metadataFolder);
  const speedFilePath = path.join(metadataFolder, `${clipName}.speed`);

  try {
    await writeFileAtomically(speedFilePath, speed.toString());
    logger.info(`Speed saved successfully for ${clipName}: ${speed}`);
    // Log speed change
    logActivity('speed_change', { clipName, speed });
    return { success: true };
  } catch (error) {
    logger.error(`Error saving speed for ${clipName}:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-speed", async (event, clipName) => {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");
  const speedFilePath = path.join(metadataFolder, `${clipName}.speed`);

  try {
    const speedData = await fs.readFile(speedFilePath, "utf8");
    const parsedSpeed = parseFloat(speedData);
    if (isNaN(parsedSpeed)) {
      logger.warn(`Invalid speed data for ${clipName}, using default`);
      return 1;
    }
    return parsedSpeed;
  } catch (error) {
    if (error.code === "ENOENT") {
      logger.info(`No speed data found for ${clipName}, using default`);
      return 1; // Default speed if not set
    }
    logger.error(`Error reading speed for ${clipName}:`, error);
    throw error;
  }
});

ipcMain.handle("save-volume", async (event, clipName, volume) => {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");
  await ensureDirectoryExists(metadataFolder);
  const volumeFilePath = path.join(metadataFolder, `${clipName}.volume`);

  try {
    await writeFileAtomically(volumeFilePath, volume.toString());
    logger.info(`Volume saved successfully for ${clipName}: ${volume}`);
    // Log volume change
    logActivity('volume_change', { clipName, volume });
    return { success: true };
  } catch (error) {
    logger.error(`Error saving volume for ${clipName}:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-volume", async (event, clipName) => {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");
  const volumeFilePath = path.join(metadataFolder, `${clipName}.volume`);

  try {
    const volumeData = await fs.readFile(volumeFilePath, "utf8");
    const parsedVolume = parseFloat(volumeData);
    if (isNaN(parsedVolume)) {
      logger.warn(`Invalid volume data for ${clipName}, using default`);
      return 1;
    }
    return parsedVolume;
  } catch (error) {
    if (error.code === "ENOENT") {
      logger.info(`No volume data found for ${clipName}, using default`);
      return 1; // Default volume if not set
    }
    logger.error(`Error reading volume for ${clipName}:`, error);
    throw error;
  }
});

ipcMain.handle("get-clip-tags", async (event, clipName) => {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");
  const tagsFilePath = path.join(metadataFolder, `${clipName}.tags`);

  try {
    const tagsData = await fs.readFile(tagsFilePath, "utf8");
    return JSON.parse(tagsData);
  } catch (error) {
    if (error.code === "ENOENT") {
      return []; // No tags file exists
    }
    logger.error("Error reading tags:", error);
    return [];
  }
});

ipcMain.handle("save-clip-tags", async (event, clipName, tags) => {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");
  const tagsFilePath = path.join(metadataFolder, `${clipName}.tags`);

  try {
    await fs.writeFile(tagsFilePath, JSON.stringify(tags));
    // Log clip tags update
    logActivity('tags_update_clip', { clipName, tags });
    return { success: true };
  } catch (error) {
    logger.error("Error saving tags:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("load-global-tags", async () => {
  const tagsFilePath = path.join(app.getPath("userData"), "global_tags.json");
  try {
    const tagsData = await fs.readFile(tagsFilePath, "utf8");
    return JSON.parse(tagsData);
  } catch (error) {
    if (error.code === "ENOENT") {
      return []; // No tags file exists yet
    }
    logger.error("Error reading global tags:", error);
    return [];
  }
});

ipcMain.handle("save-global-tags", async (event, tags) => {
  const tagsFilePath = path.join(app.getPath("userData"), "global_tags.json");
  try {
    await fs.writeFile(tagsFilePath, JSON.stringify(tags));
    // Log global tags update
    logActivity('tags_update_global', { tags });
    return { success: true };
  } catch (error) {
    logger.error("Error saving global tags:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("restore-missing-global-tags", async () => {
  try {
    const clipsFolder = settings.clipLocation;
    const metadataFolder = path.join(clipsFolder, ".clip_metadata");
    
    // Get all .tags files
    let allClipTags = new Set();
    
    try {
      const files = await fs.readdir(metadataFolder);
      const tagFiles = files.filter(file => file.endsWith('.tags'));
      
      for (const tagFile of tagFiles) {
        try {
          const tagFilePath = path.join(metadataFolder, tagFile);
          const tagsData = await fs.readFile(tagFilePath, "utf8");
          const tags = JSON.parse(tagsData);
          
          // Add all tags from this clip to our set
          tags.forEach(tag => allClipTags.add(tag));
        } catch (error) {
          // Skip files that can't be read or parsed
          logger.warn(`Could not read tags from ${tagFile}:`, error.message);
        }
      }
    } catch (error) {
      // Metadata folder doesn't exist or can't be read
      logger.info("No metadata folder found or couldn't read it");
      return { success: true, restoredCount: 0 };
    }
    
    // Load current global tags
    const tagsFilePath = path.join(app.getPath("userData"), "global_tags.json");
    let currentGlobalTags = [];
    try {
      const tagsData = await fs.readFile(tagsFilePath, "utf8");
      currentGlobalTags = JSON.parse(tagsData);
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error("Error reading global tags during restore:", error);
      }
      currentGlobalTags = [];
    }
    const currentGlobalTagsSet = new Set(currentGlobalTags);
    
    // Find missing tags
    const missingTags = [...allClipTags].filter(tag => !currentGlobalTagsSet.has(tag));
    
         if (missingTags.length > 0) {
       // Add missing tags to global tags
       const updatedGlobalTags = [...currentGlobalTags, ...missingTags];
       
       // Save updated global tags
       await fs.writeFile(tagsFilePath, JSON.stringify(updatedGlobalTags));
      
      logger.info(`Restored ${missingTags.length} missing global tags:`, missingTags);
      logActivity('tags_restore_global', { restoredTags: missingTags, count: missingTags.length });
      
      return { success: true, restoredCount: missingTags.length, restoredTags: missingTags };
    } else {
      logger.info("No missing global tags found");
      return { success: true, restoredCount: 0 };
    }
    
  } catch (error) {
    logger.error("Error restoring missing global tags:", error);
    return { success: false, error: error.message };
  }
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
  try {
    const clipsFolder = settings.clipLocation;
    const metadataFolder = path.join(clipsFolder, ".clip_metadata");
    
    let modifiedCount = 0;
    
    try {
      const files = await fs.readdir(metadataFolder);
      const tagFiles = files.filter(file => file.endsWith('.tags'));
      
      logger.info(`Checking ${tagFiles.length} .tags files for tag "${tagToRemove}"`);
      
      for (const tagFile of tagFiles) {
        try {
          const tagFilePath = path.join(metadataFolder, tagFile);
          const tagsData = await fs.readFile(tagFilePath, "utf8");
          const tags = JSON.parse(tagsData);
          
          // Check if this file contains the tag to remove
          const tagIndex = tags.indexOf(tagToRemove);
          if (tagIndex > -1) {
            // Remove the tag and save the file
            tags.splice(tagIndex, 1);
            await fs.writeFile(tagFilePath, JSON.stringify(tags));
            modifiedCount++;
            logger.info(`Removed tag "${tagToRemove}" from ${tagFile}`);
          }
        } catch (error) {
          // Skip files that can't be read or parsed
          logger.warn(`Could not process tags file ${tagFile}:`, error.message);
        }
      }
    } catch (error) {
      // Metadata folder doesn't exist or can't be read
      logger.info("No metadata folder found or couldn't read it");
      return { success: true, modifiedCount: 0 };
    }
    
    logger.info(`Tag deletion completed: modified ${modifiedCount} files`);
    return { success: true, modifiedCount };
    
  } catch (error) {
    logger.error("Error removing tag from all clips:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("update-tag-in-all-clips", async (event, oldTag, newTag) => {
  try {
    const clipsFolder = settings.clipLocation;
    const metadataFolder = path.join(clipsFolder, ".clip_metadata");
    
    let modifiedCount = 0;
    
    try {
      const files = await fs.readdir(metadataFolder);
      const tagFiles = files.filter(file => file.endsWith('.tags'));
      
      logger.info(`Checking ${tagFiles.length} .tags files for tag "${oldTag}" to update to "${newTag}"`);
      
      for (const tagFile of tagFiles) {
        try {
          const tagFilePath = path.join(metadataFolder, tagFile);
          const tagsData = await fs.readFile(tagFilePath, "utf8");
          const tags = JSON.parse(tagsData);
          
          // Check if this file contains the old tag
          const tagIndex = tags.indexOf(oldTag);
          if (tagIndex > -1) {
            // Update the tag and save the file
            tags[tagIndex] = newTag;
            await fs.writeFile(tagFilePath, JSON.stringify(tags));
            modifiedCount++;
            logger.info(`Updated tag "${oldTag}" to "${newTag}" in ${tagFile}`);
          }
        } catch (error) {
          // Skip files that can't be read or parsed
          logger.warn(`Could not process tags file ${tagFile}:`, error.message);
        }
      }
    } catch (error) {
      // Metadata folder doesn't exist or can't be read
      logger.info("No metadata folder found or couldn't read it");
      return { success: true, modifiedCount: 0 };
    }
    
    logger.info(`Tag update completed: modified ${modifiedCount} files`);
    return { success: true, modifiedCount };
    
  } catch (error) {
    logger.error("Error updating tag in all clips:", error);
    return { success: false, error: error.message };
  }
});

async function saveCustomNameData(clipName, customName) {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");
  await ensureDirectoryExists(metadataFolder);

  const customNameFilePath = path.join(
    metadataFolder,
    `${clipName}.customname`,
  );
  try {
    await writeFileAtomically(customNameFilePath, customName);
    logger.info(`Custom name saved successfully for ${clipName}`);
  } catch (error) {
    logger.error(`Error saving custom name for ${clipName}:`, error);
    throw error;
  }
}

async function saveTrimData(clipName, trimData) {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");
  await ensureDirectoryExists(metadataFolder);

  const trimFilePath = path.join(metadataFolder, `${clipName}.trim`);
  try {
    await writeFileAtomically(trimFilePath, JSON.stringify(trimData));
    logger.info(`Trim data saved successfully for ${clipName}`);
    // Log trim activity
    logActivity('trim', { clipName, start: trimData.start, end: trimData.end });
  } catch (error) {
    logger.error(`Error saving trim data for ${clipName}:`, error);
    throw error;
  }
}

async function ensureDirectoryExists(dirPath) {
  try {
    await fs.access(dirPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      await fs.mkdir(dirPath, { recursive: true });
    } else {
      throw error;
    }
  }
}

async function writeFileWithRetry(filePath, data, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await fs.writeFile(filePath, data, { flag: "w" });
      return;
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        if (attempt === retries - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100)); // Wait 100ms before retry
      } else {
        throw error;
      }
    }
  }
}

async function writeFileAtomically(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  const dir = path.dirname(filePath);

  try {
    // Ensure the directory exists
    await fs.mkdir(dir, { recursive: true });

    await writeFileWithRetry(tempPath, data);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    logger.error(`Error in writeFileAtomically: ${error.message}`);
    // If rename fails, try direct write as a fallback
    await writeFileWithRetry(filePath, data);
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch (error) {
      // Ignore error if temp file doesn't exist
      if (error.code !== "ENOENT")
        logger.error(`Error deleting temp file: ${error.message}`);
    }
  }
}

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
  return thumbnailsModule.getThumbnailPath(clipName, loadSettings);
});

ipcMain.handle("get-thumbnail-paths-batch", async (event, clipNames) => {
  return thumbnailsModule.getThumbnailPathsBatch(clipNames, loadSettings);
});

async function getTrimData(clipName) {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");
  const trimFilePath = path.join(metadataFolder, `${clipName}.trim`);

  try {
    const trimData = await fs.readFile(trimFilePath, "utf8");
    return JSON.parse(trimData);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

app.on('before-quit', () => {
  // Stop periodic saves
  stopPeriodicSave();

  // Stop thumbnail queue processing
  thumbnailsModule.stopQueue();

  // Save current clip list for next session comparison
  saveCurrentClipList();
});

ipcMain.handle("regenerate-thumbnail-for-trim", async (event, clipName, startTime) => {
  return thumbnailsModule.regenerateThumbnailForTrim(clipName, startTime, loadSettings);
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
  const { DEFAULT_SETTINGS } = require('./settings-manager');
  return DEFAULT_SETTINGS.keybindings;
});

ipcMain.handle("generate-thumbnails-progressively", async (event, clipNames) => {
  return thumbnailsModule.generateThumbnailsProgressively(clipNames, event, loadSettings, getTrimData);
});


ipcMain.handle("generate-thumbnail", async (event, clipName) => {
  return thumbnailsModule.generateThumbnail(clipName, loadSettings);
});

ipcMain.handle("save-trim", async (event, clipName, start, end) => {
  try {
    await saveTrimData(clipName, { start, end });
    return { success: true };
  } catch (error) {
    logger.error("Error in save-trim handler:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("delete-trim", async (event, clipName) => {
  try {
    const clipsFolder = settings.clipLocation;
    const metadataFolder = path.join(clipsFolder, ".clip_metadata");
    const trimFilePath = path.join(metadataFolder, `${clipName}.trim`);
    
    // Delete the trim file if it exists
    try {
      await fs.unlink(trimFilePath);
      logger.info(`Deleted trim data for ${clipName}`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.info(`No trim data file found for ${clipName} (already deleted or never existed)`);
      } else {
        throw error;
      }
    }
    
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
  return ffmpegModule.exportVideo(clipName, start, end, volume, speed, savePath, loadSettings);
});

ipcMain.handle("export-trimmed-video", async (event, clipName, start, end, volume, speed) => {
  return ffmpegModule.exportTrimmedVideo(clipName, start, end, volume, speed, loadSettings);
});

ipcMain.handle("export-audio", async (event, clipName, start, end, volume, speed, savePath) => {
  return ffmpegModule.exportAudio(clipName, start, end, volume, speed, savePath, loadSettings);
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
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, '.clip_metadata');
  const volumeRangeFilePath = path.join(metadataFolder, `${clipName}.volumerange`);

  try {
    await writeFileAtomically(volumeRangeFilePath, JSON.stringify(volumeData));
    logger.info(`Volume range data saved successfully for ${clipName}`);
    return { success: true };
  } catch (error) {
    logger.error(`Error saving volume range for ${clipName}:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-volume-range', async (event, clipName) => {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, '.clip_metadata');
  const volumeRangeFilePath = path.join(metadataFolder, `${clipName}.volumerange`);

  try {
    const volumeData = await fs.readFile(volumeRangeFilePath, 'utf8');
    return JSON.parse(volumeData);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // No volume range data exists
    }
    logger.error(`Error reading volume range for ${clipName}:`, error);
    throw error;
  }
});

// Handler to log watch sessions from the renderer
ipcMain.handle('log-watch-session', (event, sessionData) => {
  if (sessionData && sessionData.durationSeconds > 0) {
    logActivity('watch_session', sessionData);
  }
  // No return value needed
});

ipcMain.handle("get-game-icon", async (event, clipName) => {
  try {
    const clipsFolder = settings.clipLocation;
    const metadataFolder = path.join(clipsFolder, ".clip_metadata");
    const gameInfoPath = path.join(metadataFolder, `${clipName}.gameinfo`);

    // Attempt to read the optional .gameinfo file
    let raw;
    try {
      raw = await fs.readFile(gameInfoPath, "utf8");
    } catch {
      return null; // no metadata
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // malformed json
    }

    const response = { path: null, title: parsed.window_title || null };

    if (parsed.icon_file) {
      const iconPath = path.join(clipsFolder, "icons", parsed.icon_file);
      try {
        await fs.access(iconPath);
        response.path = iconPath;
      } catch {
        // icon missing -> leave null
      }
    }

    return response;
  } catch {
    return null;
  }
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

