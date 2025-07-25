if (require("electron-squirrel-startup")) return;
const { app, BrowserWindow, ipcMain, clipboard, dialog, Menu, powerMonitor, shell } = require("electron");
app.setAppUserModelId('com.yuma-dev.clips');
const { setupTitlebar, attachTitlebarToWindow } = require("custom-electron-titlebar/main");
const logger = require('./logger');
const { exec, execFile } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);
const { checkForUpdates } = require('./updater');
const isDev = !app.isPackaged;
const path = require("path");
const chokidar = require("chokidar");
const fs = require("fs").promises;
const os = require("os");
const crypto = require("crypto");
const { loadSettings, saveSettings } = require("./settings-manager");
const SteelSeriesProcessor = require('./steelseries-processor');
const readify = require("readify");
const { logActivity } = require('./activity-tracker');
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const DiscordRPC = require('discord-rpc');
const clientId = '1264368321013219449';
const IDLE_TIMEOUT = 5 * 60 * 1000;
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const ffprobePath = require('@ffprobe-installer/ffprobe').path.replace('app.asar', 'app.asar.unpacked');
const CONCURRENT_GENERATIONS = 4; // Maximum concurrent FFmpeg processes
const thumbnailQueue = [];
const THUMBNAIL_RETRY_ATTEMPTS = 3;
const FAST_PATH_THRESHOLD = 12;
let isProcessingQueue = false;
let completedThumbnails = 0;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

execFile(ffmpegPath, ['-version'], (error, stdout, stderr) => {
  if (error) {
    logger.error('Error getting ffmpeg version:', error);
  } else {
    logger.info('FFmpeg version:', stdout);
  }
});

function sendLog(window, type, message) {
  if (window && !window.isDestroyed()) {
    window.webContents.send('log', { type, message });
  }
}

// Log ffmpeg version
ipcMain.handle('get-ffmpeg-version', async (event) => {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-version'], (error, stdout, stderr) => {
      if (error) {
        sendLog(event.sender.getOwnerBrowserWindow(), 'error', `Error getting ffmpeg version: ${error}`);
        reject(error);
      } else {
        sendLog(event.sender.getOwnerBrowserWindow(), 'info', `FFmpeg version: ${stdout}`);
        resolve(stdout);
      }
    });
  });
});

let idleTimer;

const THUMBNAIL_CACHE_DIR = path.join(
  app.getPath("userData"),
  "thumbnail-cache",
);

// Ensure cache directory exists
fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true }).catch(logger.error);

let mainWindow;
let settings;

setupTitlebar();

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

async function createWindow() {
  settings = await loadSettings();
  setupFileWatcher(settings.clipLocation);

  if (settings.enableDiscordRPC) {
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
  const win = await createWindow();

  // Kick off the update check once the window exists
  checkForUpdatesInBackground(win);
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

function generateThumbnailPath(clipPath) {
  const hash = crypto.createHash("md5").update(clipPath).digest("hex");
  return path.join(THUMBNAIL_CACHE_DIR, `${hash}.jpg`);
}

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

        const thumbnailPath = generateThumbnailPath(fullPath);

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

  watcher.on('add', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (['.mp4', '.avi', '.mov'].includes(ext)) {
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
  const clipPath = path.join(settings.clipLocation, clipName);
  const thumbnailPath = generateThumbnailPath(clipPath);
  
  try {
    // Try to get metadata from cache first
    const metadata = await getThumbnailMetadata(thumbnailPath);
    if (metadata && metadata.duration) {
      return {
        format: {
          filename: clipPath,
          duration: metadata.duration
        }
      };
    }

    // If no cached metadata, get it from ffprobe and cache it
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(clipPath, async (err, info) => {
        if (err) reject(err);
        else {
          // Cache the metadata
          const existingMetadata = await getThumbnailMetadata(thumbnailPath) || {};
          await saveThumbnailMetadata(thumbnailPath, {
            ...existingMetadata,
            duration: info.format.duration,
            timestamp: Date.now()
          });
          resolve(info);
        }
      });
    });
  } catch (error) {
    logger.error('Error getting clip info:', error);
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

// In main.js, modify the 'get-thumbnail-path' handler
ipcMain.handle("get-thumbnail-path", async (event, clipName) => {
  const clipPath = path.join(settings.clipLocation, clipName);
  const thumbnailPath = generateThumbnailPath(clipPath);

  try {
    await fs.access(thumbnailPath);
    return thumbnailPath;
  } catch (error) {
    // Instead of throwing an error, return null if the thumbnail doesn't exist
    return null;
  }
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

async function validateThumbnail(clipName, thumbnailPath) {
  const EPSILON = 0.001;
  
  try {
    // First check if thumbnail exists
    try {
      await fs.access(thumbnailPath);
    } catch (error) {
      logger.info(`${clipName}: No thumbnail file exists`);
      return false;
    }

    // Then check if metadata exists
    try {
      const metadata = await getThumbnailMetadata(thumbnailPath);
      if (!metadata) {
        return false;
      }

      const currentTrimData = await getTrimData(clipName);
      
      if (currentTrimData) {
        const isValid = Math.abs(metadata.startTime - currentTrimData.start) < EPSILON;
        /*
        logger.info(`${clipName}: Validating trim data:`, {
          metadataStartTime: metadata.startTime,
          trimStartTime: currentTrimData.start,
          diff: Math.abs(metadata.startTime - currentTrimData.start),
          isValid
        });
        */
        return isValid;
      }

      if (metadata.duration) {
        const expectedStartTime = metadata.duration > 40 ? metadata.duration / 2 : 0;
        const isValid = Math.abs(metadata.startTime - expectedStartTime) < 0.1;
        if (!isValid) {
          logger.info(`${clipName}: Start time mismatch - Metadata: ${metadata.startTime}, Expected: ${expectedStartTime}`);
        }
        return isValid;
      }

      logger.info(`${clipName}: Missing duration in metadata`);
      return false;
    } catch (error) {
      logger.info(`${clipName}: No metadata file exists`);
      return false;
    }
  } catch (error) {
    logger.error(`Error validating thumbnail for ${clipName}:`, error);
    return false;
  }
}

async function saveThumbnailMetadata(thumbnailPath, metadata) {
  const metadataPath = thumbnailPath + '.meta';
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
}

async function getThumbnailMetadata(thumbnailPath) {
  try {
    const metadataPath = thumbnailPath + '.meta';
    const data = await fs.readFile(metadataPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

async function processQueue() {
  if (isProcessingQueue || thumbnailQueue.length === 0) return;

  isProcessingQueue = true;
  completedThumbnails = 0;
  
  try {
    while (thumbnailQueue.length > 0) {
      const batch = thumbnailQueue.slice(0, CONCURRENT_GENERATIONS);
      if (batch.length === 0) break;

      const totalToProcess = batch[0].totalToProcess;

      await Promise.all(batch.map(async ({ clipName, event, attempts = 0 }) => {
        const clipPath = path.join(settings.clipLocation, clipName);
        const thumbnailPath = generateThumbnailPath(clipPath);

        try {
          const isValid = await validateThumbnail(clipName, thumbnailPath);
          
          if (!isValid) {
            // Get video info first
            const info = await new Promise((resolve, reject) => {
              ffmpeg.ffprobe(clipPath, (err, metadata) => {
                if (err) reject(err);
                else resolve(metadata);
              });
            });

            const trimData = await getTrimData(clipName);
            const duration = info.format.duration;
            const startTime = trimData ? trimData.start : (duration > 40 ? duration / 2 : 0);

            await new Promise((resolve, reject) => {
              ffmpeg(clipPath)
                .screenshots({
                  timestamps: [startTime],
                  filename: path.basename(thumbnailPath),
                  folder: path.dirname(thumbnailPath),
                  size: '640x360'
                })
                .on('end', resolve)
                .on('error', reject);
            });

            await saveThumbnailMetadata(thumbnailPath, {
              startTime,
              duration,
              clipName,
              timestamp: Date.now()
            });
          }

          completedThumbnails++;
          
          event.sender.send("thumbnail-progress", {
            current: completedThumbnails,
            total: totalToProcess,
            clipName
          });

        } catch (error) {
          logger.error("Error processing thumbnail for", clipName, error);
          if (attempts < THUMBNAIL_RETRY_ATTEMPTS) {
            thumbnailQueue.push({ clipName, event, attempts: attempts + 1 });
          }
        }
      }));

      thumbnailQueue.splice(0, batch.length);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    isProcessingQueue = false;
    
    // Only send completion event if queue is actually empty
    if (thumbnailQueue.length === 0) {
      const event = batch?.[0]?.event;
      if (event) {
        event.sender.send("thumbnail-generation-complete");
      }
    } else if (!isProcessingQueue) {
      // If there are still items in queue, restart processing
      processQueue();
    }
  }
}

app.on('before-quit', () => {
  // Clear the queue
  thumbnailQueue.length = 0;
});

ipcMain.handle("regenerate-thumbnail-for-trim", async (event, clipName, startTime) => {
  const clipPath = path.join(settings.clipLocation, clipName);
  const thumbnailPath = generateThumbnailPath(clipPath);

  try {
    // Generate new thumbnail at trim point
    await new Promise((resolve, reject) => {
      ffmpeg(clipPath)
        .screenshots({
          timestamps: [startTime],
          filename: path.basename(thumbnailPath),
          folder: path.dirname(thumbnailPath),
          size: '640x360'
        })
        .on('end', resolve)
        .on('error', reject);
    });

    // Save new metadata
    await saveThumbnailMetadata(thumbnailPath, {
      startTime,
      clipName,
      timestamp: Date.now()
    });

    return { success: true, thumbnailPath };
  } catch (error) {
    logger.error('Error regenerating thumbnail:', error);
    return { success: false, error: error.message };
  }
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

async function handleInitialThumbnails(clipNames, event) {
  const initialClips = clipNames.slice(0, 12);
  
  // Quick parallel check for existence
  const missingThumbnails = await Promise.all(
    initialClips.map(async clipName => {
      const clipPath = path.join(settings.clipLocation, clipName);
      const thumbnailPath = generateThumbnailPath(clipPath);
      try {
        await fs.access(thumbnailPath);
        return null;
      } catch {
        return clipName;
      }
    })
  );

  // Filter out nulls
  const clipsNeedingGeneration = missingThumbnails.filter(Boolean);

  if (clipsNeedingGeneration.length > 0) {
    logger.info(`Fast-tracking thumbnail generation for ${clipsNeedingGeneration.length} initial clips`);
    
    // Get correct timestamps first
    const clipData = await Promise.all(
      clipsNeedingGeneration.map(async clipName => {
        const clipPath = path.join(settings.clipLocation, clipName);
        try {
          // Check trim data first
          const trimData = await getTrimData(clipName);
          if (trimData) {
            return { clipName, startTime: trimData.start };
          }

          // If no trim data, get duration
          const info = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(clipPath, (err, metadata) => {
              if (err) reject(err);
              else resolve(metadata);
            });
          });
          
          const duration = info.format.duration;
          return { 
            clipName, 
            startTime: duration > 40 ? duration / 2 : 0,
            duration 
          };
        } catch (error) {
          logger.error(`Error getting data for ${clipName}:`, error);
          return null;
        }
      })
    );

    // Filter out failed clips
    const validClipData = clipData.filter(Boolean);

    // Generate all in parallel with correct timestamps
    await Promise.all(
      validClipData.map(async ({ clipName, startTime, duration }, index) => {
        const clipPath = path.join(settings.clipLocation, clipName);
        const thumbnailPath = generateThumbnailPath(clipPath);

        try {
          await new Promise((resolve, reject) => {
            ffmpeg(clipPath)
              .screenshots({
                timestamps: [startTime],
                filename: path.basename(thumbnailPath),
                folder: path.dirname(thumbnailPath),
                size: '640x360'
              })
              .on('end', resolve)
              .on('error', reject);
          });

          // Save metadata
          await saveThumbnailMetadata(thumbnailPath, {
            startTime,
            duration,
            clipName,
            timestamp: Date.now()
          });

          // Only send the thumbnail generated event, no progress events
          event.sender.send("thumbnail-generated", {
            clipName,
            thumbnailPath
          });

        } catch (error) {
          logger.error(`Error generating thumbnail for ${clipName}:`, error);
          event.sender.send("thumbnail-generation-failed", {
            clipName,
            error: error.message
          });
        }
      })
    );
  }

  return {
    processed: clipsNeedingGeneration.length,
    processedClips: new Set(clipsNeedingGeneration)
  };
}

ipcMain.handle("generate-thumbnails-progressively", async (event, clipNames) => {
  try {
    // Handle initial clips first (silently)
    const { processed, processedClips } = await handleInitialThumbnails(clipNames, event);
    
    // Process remaining clips if any
    if (clipNames.length > 12) {
      const remainingClips = clipNames.slice(12).filter(clipName => !processedClips.has(clipName));
      let clipsNeedingGeneration = [];
      
      // Validate remaining clips
      for (const clipName of remainingClips) {
        const clipPath = path.join(settings.clipLocation, clipName);
        const thumbnailPath = generateThumbnailPath(clipPath);
        
        try {
          const isValid = await validateThumbnail(clipName, thumbnailPath);
          if (!isValid) {
            clipsNeedingGeneration.push(clipName);
          }
        } catch (error) {
          logger.error(`Error validating thumbnail for ${clipName}:`, error);
          clipsNeedingGeneration.push(clipName);
        }
      }

      // Only show progress and start queue if there are clips to process
      if (clipsNeedingGeneration.length > 0) {
        event.sender.send("thumbnail-validation-start", {
          total: clipsNeedingGeneration.length
        });

        thumbnailQueue.length = 0;
        thumbnailQueue.push(...clipsNeedingGeneration.map(clipName => ({ 
          clipName, 
          event,
          totalToProcess: clipsNeedingGeneration.length
        })));
        
        if (!isProcessingQueue) {
          processQueue();
        }
      }
      // Note: No else clause here - we don't send completion for no-op cases
    } else if (processed > 0) {
      // Only send completion if we actually processed initial clips
      event.sender.send("thumbnail-generation-complete");
    }
    
    return { 
      needsGeneration: processed + (thumbnailQueue.length || 0), 
      total: clipNames.length,
      initialProcessed: processed
    };
  } catch (error) {
    logger.error('Error in thumbnail generation:', error);
    throw error;
  }
});


ipcMain.handle("generate-thumbnail", async (event, clipName) => {
  const clipPath = path.join(settings.clipLocation, clipName);
  const thumbnailPath = generateThumbnailPath(clipPath);

  try {
    // Check if cached thumbnail exists
    await fs.access(thumbnailPath);
    return thumbnailPath;
  } catch (error) {
    logger.info(`Generating new thumbnail for ${clipName}`);
    // If thumbnail doesn't exist, generate it
    return new Promise((resolve, reject) => {
      ffmpeg(clipPath)
        .screenshots({
          count: 1,
          timemarks: ["00:00:00"],
          folder: path.dirname(thumbnailPath),
          filename: path.basename(thumbnailPath),
          size: "640x360",
        })
        .on("end", () => {
          logger.info(`Thumbnail generated successfully for ${clipName}`);
          resolve(thumbnailPath);
        })
        .on("error", (err) => {
          logger.error(`Error generating thumbnail for ${clipName}:`, err);
          reject(err);
        });
    });
  }
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
  const thumbnailPath = generateThumbnailPath(clipPath);

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
  const inputPath = path.join(settings.clipLocation, clipName);
  const outputPath = savePath || path.join(os.tmpdir(), `exported_${Date.now()}_${clipName}`);

  try {
    await exportVideoWithFallback(inputPath, outputPath, start, end, volume, speed);
    
    // Add clipboard functionality here
    if (!savePath) {
      if (process.platform === "win32") {
        clipboard.writeBuffer("FileNameW", Buffer.from(outputPath + "\0", "ucs2"));
      } else {
        clipboard.writeText(outputPath);
      }
    }
    
    // Log export activity
    logActivity('export', {
      clipName,
      format: 'video',
      destination: savePath ? 'file' : 'clipboard',
      start,
      end,
      volume,
      speed
    });
    return { success: true, path: outputPath };
  } catch (error) {
    logger.error("Error exporting video:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("export-trimmed-video", async (event, clipName, start, end, volume, speed) => {
  const inputPath = path.join(settings.clipLocation, clipName);
  const outputPath = path.join(os.tmpdir(), `trimmed_${Date.now()}_${clipName}`);

  try {
    await exportVideoWithFallback(inputPath, outputPath, start, end, volume, speed);
    
    // Add clipboard functionality here
    if (process.platform === "win32") {
      clipboard.writeBuffer("FileNameW", Buffer.from(outputPath + "\0", "ucs2"));
    } else {
      clipboard.writeText(outputPath);
    }
    
    // Log export activity
    logActivity('export', {
      clipName,
      format: 'video',
      destination: 'trimmed_clipboard', // Specific destination for this action
      start,
      end,
      volume,
      speed
    });
    return { success: true, path: outputPath };
  } catch (error) {
    logger.error("Error exporting trimmed video:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.on('ffmpeg-fallback', () => {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('show-fallback-notice');
  });
});

// In main.js

async function exportVideoWithFallback(inputPath, outputPath, start, end, volume, speed) {
  // Load volume range data if it exists
  const clipName = path.basename(inputPath);
  const metadataFolder = path.join(path.dirname(inputPath), '.clip_metadata');
  const volumeRangeFilePath = path.join(metadataFolder, `${clipName}.volumerange`);
  
  let volumeData = null;
  try {
    const volumeDataRaw = await fs.readFile(volumeRangeFilePath, 'utf8');
    volumeData = JSON.parse(volumeDataRaw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading volume range data:', error);
    }
  }

  return new Promise((resolve, reject) => {
    const duration = end - start;
    let usingFallback = false;
    let lastProgressTime = Date.now();
    let totalFrames = 0;
    let processedFrames = 0;
    
    ffmpeg.ffprobe(inputPath, async (err, metadata) => {
      if (err) {
        logger.error('Error getting video info:', err);
        return;
      }
      
      const fps = eval(metadata.streams[0].r_frame_rate);
      totalFrames = Math.ceil(duration * fps);
      
      const settings = await loadSettings();
      const quality = settings.exportQuality;

      let command = ffmpeg(inputPath)
        .setStartTime(start)
        .setDuration(duration)
        .videoFilters(`setpts=${1/speed}*PTS`)
        .audioFilters(`atempo=${speed}`);

      // Apply volume filter
      if (volumeData) {
        // Convert absolute timestamps to relative timestamps based on trim
        const relativeStart = Math.max(0, volumeData.start - start);
        const relativeEnd = Math.min(duration, volumeData.end - start);
        
        if (relativeStart < duration && relativeEnd > 0) {
          // Complex volume filter for the specified range
          command.audioFilters([
            `volume=${volume}`,
            `volume=${volumeData.level}:enable='between(t,${relativeStart},${relativeEnd})'`
          ]);
        } else {
          command.audioFilters(`volume=${volume}`);
        }
      } else {
        command.audioFilters(`volume=${volume}`);
      }

      switch (quality) {
        case 'lossless':
          command.outputOptions([
            '-c:v h264_nvenc',
            '-preset p7',
            '-rc:v constqp',
            '-qp 16',
            '-profile:v high',
            '-b:a 256k'
          ]);
          break;
        case 'high':
          command.outputOptions([
            '-c:v h264_nvenc',
            '-preset p4',
            '-rc vbr',
            '-cq 20',
            '-b:v 8M',
            '-maxrate 10M',
            '-bufsize 10M',
            '-profile:v high',
            '-rc-lookahead 32'
          ]);
          break;
        default: // discord
          command.outputOptions([
            '-c:v h264_nvenc',
            '-preset slow',
            '-crf 23'
          ]);
      }

      command.outputOptions([
        '-progress pipe:1',
        '-stats_period 0.1'
      ])
      .on('start', (commandLine) => {
        logger.info('Spawned FFmpeg with command: ' + commandLine);
      })
      .on('stderr', (stderrLine) => {
        // Parse frame information from stderr
        const frameMatch = stderrLine.match(/frame=\s*(\d+)/);
        if (frameMatch) {
          processedFrames = parseInt(frameMatch[1]);
          const progress = Math.min((processedFrames / totalFrames) * 100, 99.9);
          
          // Only emit progress if enough time has passed or it's a significant change
          const now = Date.now();
          if (now - lastProgressTime >= 100) { // Throttle updates to max 10 per second
            ipcMain.emit('ffmpeg-progress', progress);
            lastProgressTime = now;
          }
        }
      })
      .on('error', (err, stdout, stderr) => {
        logger.warn('Hardware encoding failed, falling back to software encoding');
        logger.error('Error:', err.message);
        logger.error('stdout:', stdout);
        logger.error('stderr:', stderr);
        
        usingFallback = true;
        ipcMain.emit('ffmpeg-fallback');

        // Reset progress tracking for fallback
        processedFrames = 0;
        lastProgressTime = Date.now();

        ffmpeg(inputPath)
          .setStartTime(start)
          .setDuration(duration)
          .audioFilters(`volume=${volume}`)
          .videoFilters(`setpts=${1/speed}*PTS`)
          .audioFilters(`atempo=${speed}`)
          .outputOptions([
            '-c:v libx264',
            '-preset medium',
            '-crf 23',
            '-progress pipe:1',
            '-stats_period 0.1'
          ])
          .on('stderr', (stderrLine) => {
            const frameMatch = stderrLine.match(/frame=\s*(\d+)/);
            if (frameMatch) {
              processedFrames = parseInt(frameMatch[1]);
              const progress = Math.min((processedFrames / totalFrames) * 100, 99.9);
              
              const now = Date.now();
              if (now - lastProgressTime >= 100) {
                ipcMain.emit('ffmpeg-progress', progress);
                lastProgressTime = now;
              }
            }
          })
          .on('end', () => {
            ipcMain.emit('ffmpeg-progress', 100);
            resolve(usingFallback);
          })
          .on('error', (err, stdout, stderr) => {
            logger.error('FFmpeg error:', err.message);
            logger.error('FFmpeg stdout:', stdout);
            logger.error('FFmpeg stderr:', stderr);
            reject(err);
          })
          .save(outputPath);
      })
      .on('end', () => {
        ipcMain.emit('ffmpeg-progress', 100);
        resolve(usingFallback);
      })
      .save(outputPath);
    });
  });
}

ipcMain.on('ffmpeg-progress', (percent) => {
  // Send progress to all renderer processes
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('export-progress', percent);
  });
});

ipcMain.handle("export-audio", async (event, clipName, start, end, volume, speed, savePath) => {
  const inputPath = path.join(settings.clipLocation, clipName);
  const outputPath = savePath || path.join(os.tmpdir(), `audio_${Date.now()}_${path.parse(clipName).name}.mp3`);

  // Adjust duration based on speed
  const adjustedDuration = (end - start) / speed;

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(adjustedDuration)
      .audioFilters(`volume=${volume},atempo=${speed}`)
      .output(outputPath)
      .audioCodec("libmp3lame")
      .on("end", resolve)
      .on("error", reject)
      .run();
  });

  if (!savePath) {
    if (process.platform === "win32") {
      clipboard.writeBuffer("FileNameW", Buffer.from(outputPath + "\0", "ucs2"));
    } else {
      clipboard.writeText(outputPath);
    }
  }

  // Log export activity
  logActivity('export', {
    clipName,
    format: 'audio',
    destination: savePath ? 'file' : 'clipboard',
    start,
    end,
    volume,
    speed
  });
  return { success: true, path: outputPath };
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