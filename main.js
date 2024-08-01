if (require("electron-squirrel-startup")) return;
const { app, BrowserWindow, ipcMain, clipboard, dialog, Menu } = require("electron");
const { setupTitlebar, attachTitlebarToWindow } = require("custom-electron-titlebar/main");
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
const readify = require("readify");
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const DiscordRPC = require('discord-rpc');
const clientId = '1264368321013219449';
const IDLE_TIMEOUT = 5 * 60 * 1000;
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const ffprobePath = require('@ffprobe-installer/ffprobe').path.replace('app.asar', 'app.asar.unpacked');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

execFile(ffmpegPath, ['-version'], (error, stdout, stderr) => {
  if (error) {
    console.error('Error getting ffmpeg version:', error);
  } else {
    console.log('FFmpeg version:', stdout);
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
fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true }).catch(console.error);

let mainWindow;
let settings;

setupTitlebar();

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
      console.log("Error");
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
}

app.whenReady().then(() => {
  createWindow();
  checkForUpdates();
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
    console.log('Discord RPC connected successfully');
    rpcReady = true;
    updateDiscordPresence('Browsing clips');
  });
  rpc.login({ clientId }).catch(error => {
    console.error('Failed to initialize Discord RPC:', error);
  });
}

function updateDiscordPresence(details, state = null) {
  if (!rpcReady || !settings.enableDiscordRPC) {
    console.log('RPC not ready or disabled');
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

  console.log('Updating Discord presence:', activity);
  rpc.setActivity(activity).catch(error => {
    console.error('Failed to update Discord presence:', error);
  });
}

function clearDiscordPresence() {
  if (rpcReady) {
    rpc.clearActivity().catch(console.error);
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
        const customNamePath = path.join(
          metadataFolder,
          `${file.name}.customname`,
        );
        const trimPath = path.join(metadataFolder, `${file.name}.trim`);
        let customName;
        let isTrimmed = false;

        try {
          customName = await fs.readFile(customNamePath, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT")
            console.error("Error reading custom name:", error);
          customName = path.basename(file.name, path.extname(file.name));
        }

        try {
          await fs.access(trimPath);
          isTrimmed = true;
        } catch (error) {
          // If trim file doesn't exist, isTrimmed remains false
        }

        const thumbnailPath = generateThumbnailPath(
          path.join(clipsFolder, file.name),
        );

        return {
          originalName: file.name,
          customName: customName,
          createdAt: file.date.getTime(),
          thumbnailPath: thumbnailPath,
          isTrimmed: isTrimmed,
        };
      });

    const clipInfos = await Promise.all(clipInfoPromises);
    return clipInfos;
  } catch (error) {
    console.error("Error reading directory:", error);
    return [];
  }
});

function setupFileWatcher(clipLocation) {
  const watcher = chokidar.watch(clipLocation, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true
  });

  watcher.on('add', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (['.mp4', '.avi', '.mov'].includes(ext)) {
      const fileName = path.basename(filePath);
      mainWindow.webContents.send('new-clip-added', fileName);
    }
  });
}

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-new-clip-info', async (event, fileName) => {
  const filePath = path.join(settings.clipLocation, fileName);
  const stats = await fs.stat(filePath);
  return {
    originalName: fileName,
    customName: path.basename(fileName, path.extname(fileName)),
    createdAt: stats.birthtimeMs || stats.ctimeMs,
  };
});

ipcMain.handle("save-custom-name", async (event, originalName, customName) => {
  try {
    await saveCustomNameData(originalName, customName);
    return { success: true, customName };
  } catch (error) {
    console.error("Error in save-custom-name handler:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-clip-info", async (event, clipName) => {
  const clipPath = path.join(settings.clipLocation, clipName);
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(clipPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
});

ipcMain.handle("get-trim", async (event, clipName) => {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");
  const trimFilePath = path.join(metadataFolder, `${clipName}.trim`);

  try {
    const trimData = await fs.readFile(trimFilePath, "utf8");
    return JSON.parse(trimData);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null; // No trim data exists
    }
    console.error(`Error reading trim data for ${clipName}:`, error);
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
    console.log(`Speed saved successfully for ${clipName}: ${speed}`);
    return { success: true };
  } catch (error) {
    console.error(`Error saving speed for ${clipName}:`, error);
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
      console.warn(`Invalid speed data for ${clipName}, using default`);
      return 1;
    }
    return parsedSpeed;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`No speed data found for ${clipName}, using default`);
      return 1; // Default speed if not set
    }
    console.error(`Error reading speed for ${clipName}:`, error);
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
    console.log(`Volume saved successfully for ${clipName}: ${volume}`);
    return { success: true };
  } catch (error) {
    console.error(`Error saving volume for ${clipName}:`, error);
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
      console.warn(`Invalid volume data for ${clipName}, using default`);
      return 1;
    }
    return parsedVolume;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`No volume data found for ${clipName}, using default`);
      return 1; // Default volume if not set
    }
    console.error(`Error reading volume for ${clipName}:`, error);
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
    console.error("Error reading tags:", error);
    return [];
  }
});

ipcMain.handle("save-clip-tags", async (event, clipName, tags) => {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");
  const tagsFilePath = path.join(metadataFolder, `${clipName}.tags`);

  try {
    await fs.writeFile(tagsFilePath, JSON.stringify(tags));
    return { success: true };
  } catch (error) {
    console.error("Error saving tags:", error);
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
    console.error("Error reading global tags:", error);
    return [];
  }
});

ipcMain.handle("save-global-tags", async (event, tags) => {
  const tagsFilePath = path.join(app.getPath("userData"), "global_tags.json");
  try {
    await fs.writeFile(tagsFilePath, JSON.stringify(tags));
    return { success: true };
  } catch (error) {
    console.error("Error saving global tags:", error);
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
    console.log(`Custom name saved successfully for ${clipName}`);
  } catch (error) {
    console.error(`Error saving custom name for ${clipName}:`, error);
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
    console.log(`Trim data saved successfully for ${clipName}`);
  } catch (error) {
    console.error(`Error saving trim data for ${clipName}:`, error);
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
    console.error(`Error in writeFileAtomically: ${error.message}`);
    // If rename fails, try direct write as a fallback
    await writeFileWithRetry(filePath, data);
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch (error) {
      // Ignore error if temp file doesn't exist
      if (error.code !== "ENOENT")
        console.error(`Error deleting temp file: ${error.message}`);
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

ipcMain.handle(
  "generate-thumbnails-progressively",
  async (event, clipNames) => {
    for (let i = 0; i < clipNames.length; i++) {
      const clipName = clipNames[i];
      const clipPath = path.join(settings.clipLocation, clipName);
      const thumbnailPath = generateThumbnailPath(clipPath);

      try {
        await fs.access(thumbnailPath);
        // Thumbnail exists, skip generation
        event.sender.send("thumbnail-generated", { clipName, thumbnailPath });
      } catch (error) {
        // Thumbnail doesn't exist, generate it
        try {
          await new Promise((resolve, reject) => {
            ffmpeg(clipPath)
              .outputOptions(['-frames:v 1']) // Capture only the first frame
              .output(thumbnailPath)
              .size('640x360')
              .on("end", () => {
                event.sender.send("thumbnail-generated", {
                  clipName,
                  thumbnailPath,
                });
                resolve();
              })
              .on("error", (err) => {
                console.error(`Error generating thumbnail for ${clipName}:`, err);
                // Send a message to indicate the thumbnail generation failed
                event.sender.send("thumbnail-generation-failed", {
                  clipName,
                  error: err.message,
                });
                resolve(); // Resolve promise to continue with next thumbnail
              })
              .run();
          });
        } catch (err) {
          console.error(`Unexpected error for ${clipName}:`, err);
        }
      }

      // Send progress update
      event.sender.send("thumbnail-progress", {
        current: i + 1,
        total: clipNames.length,
      });
    }
  },
);

ipcMain.handle("generate-thumbnail", async (event, clipName) => {
  const clipPath = path.join(settings.clipLocation, clipName);
  const thumbnailPath = generateThumbnailPath(clipPath);

  try {
    // Check if cached thumbnail exists
    await fs.access(thumbnailPath);
    return thumbnailPath;
  } catch (error) {
    console.log(`Generating new thumbnail for ${clipName}`);
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
          console.log(`Thumbnail generated successfully for ${clipName}`);
          resolve(thumbnailPath);
        })
        .on("error", (err) => {
          console.error(`Error generating thumbnail for ${clipName}:`, err);
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
    console.error("Error in save-trim handler:", error);
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

  const maxRetries = 160;
  const retryDelay = 62; // 1 second

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      // Attempt to close any open file handles
      await delay(1000);

      if (process.platform === "win32") {
        try {
          await execPromise(
            `taskkill /F /IM "explorer.exe" /FI "MODULES eq ${path.basename(clipPath)}"`,
          );
        } catch (error) {
          console.warn("Failed to kill processes:", error);
        }
      }

      // Delete the files
      for (const file of filesToDelete) {
        try {
          if (file === clipPath) {
            await fs.unlink(file);
          } else {
            await fs.unlink(file);
          }
        } catch (e) {
          if (e.code !== "ENOENT") {
            throw e;
          }
        }
      }

      return { success: true };
    } catch (error) {
      if (error.code === "EBUSY" && retry < maxRetries - 1) {
        // If the file is busy and we haven't reached max retries, wait and try again
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      } else {
        console.error(`Error deleting clip ${clipName}:`, error);
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

ipcMain.handle("open-save-dialog", async (event, type) => {
  const options = {
    filters: type === "audio" 
      ? [{ name: "Audio Files", extensions: ["mp3"] }]
      : [{ name: "Video Files", extensions: ["mp4"] }],
  };
  const result = await dialog.showSaveDialog(options);
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
    
    return { success: true, path: outputPath };
  } catch (error) {
    console.error("Error exporting video:", error);
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
    
    return { success: true, path: outputPath };
  } catch (error) {
    console.error("Error exporting trimmed video:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.on('ffmpeg-fallback', () => {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('show-fallback-notice');
  });
});

function exportVideoWithFallback(inputPath, outputPath, start, end, volume, speed) {
  return new Promise((resolve, reject) => {
    const duration = end - start;
    let usingFallback = false;
    
    let command = ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(duration)
      .audioFilters(`volume=${volume}`)
      .videoFilters(`setpts=${1/speed}*PTS`)
      .audioFilters(`atempo=${speed}`);

    command.outputOptions(['-c:v h264_nvenc', '-preset slow', '-crf 23'])
      .on('start', (commandLine) => {
        console.log('Spawned FFmpeg with command: ' + commandLine);
      })
      .on('progress', (progress) => {
        ipcMain.emit('ffmpeg-progress', progress.percent);
      })
      .on('error', (err, stdout, stderr) => {
        console.log('Hardware encoding failed, falling back to software encoding');
        console.log('Error:', err.message);
        console.log('stdout:', stdout);
        console.log('stderr:', stderr);
        
        usingFallback = true;
        ipcMain.emit('ffmpeg-fallback');

        ffmpeg(inputPath)
          .setStartTime(start)
          .setDuration(duration)
          .audioFilters(`volume=${volume}`)
          .videoFilters(`setpts=${1/speed}*PTS`)
          .audioFilters(`atempo=${speed}`)
          .outputOptions(['-c:v libx264', '-preset medium', '-crf 23'])
          .on('progress', (progress) => {
            ipcMain.emit('ffmpeg-progress', progress.percent);
          })
          .on('end', () => resolve(usingFallback))
          .on('error', (err, stdout, stderr) => {
            console.error('FFmpeg error:', err.message);
            console.error('FFmpeg stdout:', stdout);
            console.error('FFmpeg stderr:', stderr);
            reject(err);
          })
          .save(outputPath);
      })
      .on('end', () => resolve(usingFallback))
      .save(outputPath);
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

  return { success: true, path: outputPath };
});

// Helper function to get video information
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
}
