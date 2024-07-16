if (require('electron-squirrel-startup')) return;
const { app, BrowserWindow, ipcMain, clipboard, dialog, Menu } = require('electron');
const { setupTitlebar, attachTitlebarToWindow } = require("custom-electron-titlebar/main");
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);


const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const { loadSettings, saveSettings } = require('./settings-manager');
const readify = require('readify');
const delay = ms => new Promise(res => setTimeout(res, ms));
const isDev = !app.isPackaged;

const THUMBNAIL_CACHE_DIR = path.join(app.getPath('userData'), 'thumbnail-cache');

// Ensure cache directory exists
fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true }).catch(console.error);

let mainWindow;
let settings;

setupTitlebar();

async function createWindow() {
  settings = await loadSettings();

  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    titleBarStyle: 'hidden',
    titleBarOverlay: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  attachTitlebarToWindow(mainWindow);
  mainWindow.loadFile("index.html");
  mainWindow.maximize();
  Menu.setApplicationMenu(null);
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function generateThumbnailPath(clipPath) {
  const hash = crypto.createHash('md5').update(clipPath).digest('hex');
  return path.join(THUMBNAIL_CACHE_DIR, `${hash}.jpg`);
}
ipcMain.handle('get-clips', async () => {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, '.clip_metadata');
  
  try {
    const result = await readify(clipsFolder, {
      type: 'raw',
      sort: 'date',
      order: 'desc'
    });

    const clipInfoPromises = result.files
      .filter(file => ['.mp4', '.avi', '.mov'].includes(path.extname(file.name).toLowerCase()))
      .map(async (file) => {
        const customNamePath = path.join(metadataFolder, `${file.name}.customname`);
        const trimPath = path.join(metadataFolder, `${file.name}.trim`);
        let customName;
        let isTrimmed = false;

        try {
          customName = await fs.readFile(customNamePath, 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') console.error('Error reading custom name:', error);
          customName = path.basename(file.name, path.extname(file.name));
        }

        try {
          await fs.access(trimPath);
          isTrimmed = true;
        } catch (error) {
          // If trim file doesn't exist, isTrimmed remains false
        }

        const thumbnailPath = generateThumbnailPath(path.join(clipsFolder, file.name));

        return {
          originalName: file.name,
          customName: customName,
          createdAt: file.date.getTime(),
          thumbnailPath: thumbnailPath,
          isTrimmed: isTrimmed
        };
      });

    const clipInfos = await Promise.all(clipInfoPromises);
    return clipInfos;

  } catch (error) {
    console.error('Error reading directory:', error);
    return [];
  }
});

ipcMain.handle("save-custom-name", async (event, originalName, customName) => {
  try {
    await saveCustomNameData(originalName, customName);
    return { success: true, customName };
  } catch (error) {
    console.error('Error in save-custom-name handler:', error);
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
  const metadataFolder = path.join(clipsFolder, '.clip_metadata');
  const trimFilePath = path.join(metadataFolder, `${clipName}.trim`);
  
  try {
    const trimData = await fs.readFile(trimFilePath, "utf8");
    return JSON.parse(trimData);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // No trim data exists
    }
    console.error(`Error reading trim data for ${clipName}:`, error);
    throw error;
  }
});

async function saveCustomNameData(clipName, customName) {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, '.clip_metadata');
  await ensureDirectoryExists(metadataFolder);

  const customNameFilePath = path.join(metadataFolder, `${clipName}.customname`);
  try {
    await writeFileAtomically(customNameFilePath, customName);
    await setHiddenAttribute(customNameFilePath);
    console.log(`Custom name saved successfully for ${clipName}`);
  } catch (error) {
    console.error(`Error saving custom name for ${clipName}:`, error);
    throw error;
  }
}

async function saveTrimData(clipName, trimData) {
  const clipsFolder = settings.clipLocation;
  const metadataFolder = path.join(clipsFolder, '.clip_metadata');
  await ensureDirectoryExists(metadataFolder);

  const trimFilePath = path.join(metadataFolder, `${clipName}.trim`);
  try {
    await writeFileAtomically(trimFilePath, JSON.stringify(trimData));
    setHiddenAttribute(trimFilePath);
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
    if (error.code === 'ENOENT') {
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
    if (error.code === 'ENOENT') {
      await fs.mkdir(dirPath, { recursive: true });
    } else {
      throw error;
    }
  }
}

async function writeFileWithRetry(filePath, data, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await fs.writeFile(filePath, data, { flag: 'w' });
      return;
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        if (attempt === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms before retry
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
  } catch (error) {
    console.error(`Error in writeFileAtomically: ${error.message}`);
    // If rename fails, try direct write as a fallback
    await writeFileWithRetry(filePath, data);
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch (error) {
      // Ignore error if temp file doesn't exist
      if (error.code !== 'ENOENT') console.error(`Error deleting temp file: ${error.message}`);
    }
  }
}

function setHiddenAttribute(filePath) {
  if (process.platform === 'win32') {
    try {
      require('child_process').execSync(`attrib +h "${filePath}"`, { stdio: 'ignore' });
    } catch (error) {
      console.error(`Failed to set hidden attribute: ${error.message}`);
    }
  }
  else { console.error('setHiddenAttribute is not implemented for this platform'); }
}
ipcMain.handle('get-clip-location', () => {
  return settings.clipLocation;
});

ipcMain.handle('set-clip-location', async (event, newLocation) => {
  settings.clipLocation = newLocation;
  await saveSettings(settings);
  return settings.clipLocation;
});

ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// In main.js, modify the 'get-thumbnail-path' handler
ipcMain.handle('get-thumbnail-path', async (event, clipName) => {
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

// Modify the 'generate-thumbnails-progressively' handler
ipcMain.handle('generate-thumbnails-progressively', async (event, clipNames) => {
  for (let i = 0; i < clipNames.length; i++) {
    const clipName = clipNames[i];
    const clipPath = path.join(settings.clipLocation, clipName);
    const thumbnailPath = generateThumbnailPath(clipPath);

    try {
      await fs.access(thumbnailPath);
      // Thumbnail exists, skip generation
      event.sender.send('thumbnail-generated', { clipName, thumbnailPath });
    } catch (error) {
      // Thumbnail doesn't exist, generate it
      await new Promise((resolve, reject) => {
        ffmpeg(clipPath)
          .screenshots({
            count: 1,
            timemarks: ['00:00:00'],
            folder: path.dirname(thumbnailPath),
            filename: path.basename(thumbnailPath),
            size: '640x360'
          })
          .on('end', () => {
            event.sender.send('thumbnail-generated', { clipName, thumbnailPath });
            resolve();
          })
          .on('error', (err) => {
            console.error(`Error generating thumbnail for ${clipName}:`, err);
            reject(err);
          });
      });
    }

    // Send progress update
    event.sender.send('thumbnail-progress', { current: i + 1, total: clipNames.length });
  }
});

ipcMain.handle('generate-thumbnail', async (event, clipName) => {
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
          timemarks: ['00:00:00'],
          folder: path.dirname(thumbnailPath),
          filename: path.basename(thumbnailPath),
          size: '640x360'
        })
        .on('end', () => {
          console.log(`Thumbnail generated successfully for ${clipName}`);
          resolve(thumbnailPath);
        })
        .on('error', (err) => {
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
    console.error('Error in save-trim handler:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-clip', async (event, clipName) => {
  const clipPath = path.join(settings.clipLocation, clipName);
  const metadataFolder = path.join(settings.clipLocation, '.clip_metadata');
  const customNamePath = path.join(metadataFolder, `${clipName}.customname`);
  const trimDataPath = path.join(metadataFolder, `${clipName}.trim`);
  const thumbnailPath = generateThumbnailPath(clipPath);

  const filesToDelete = [clipPath, customNamePath, trimDataPath, thumbnailPath];

  const maxRetries = 5;
  const retryDelay = 1000; // 1 second

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      // Attempt to close any open file handles
      await delay(1000);

      if (process.platform === 'win32') {
        try {
          await execPromise(`taskkill /F /IM "explorer.exe" /FI "MODULES eq ${path.basename(clipPath)}"`);
        } catch (error) {
          console.warn('Failed to kill processes:', error);
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
          if (e.code !== 'ENOENT') { // Ignore error if file doesn't exist
            throw e;
          }
        }
      }

      return { success: true };
    } catch (error) {
      if (error.code === 'EBUSY' && retry < maxRetries - 1) {
        // If the file is busy and we haven't reached max retries, wait and try again
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        console.error(`Error deleting clip ${clipName}:`, error);
        return { success: false, error: error.message };
      }
    }
  }

  // If we've exhausted all retries
  return { success: false, error: 'Failed to delete clip after multiple attempts. The file may be in use.' };
});

async function closeFileHandles(filePath) {
  // Normalize the file path to ensure consistent comparison
  const normalizedPath = path.normalize(filePath);

  // Close the video player in the renderer process
  if (global.mainWindow) {
    global.mainWindow.webContents.send('close-video-player');
  }

  // Wait for a moment to allow the renderer to close the video player
  await new Promise(resolve => setTimeout(resolve, 500));

  if (process.platform === 'win32') {
    try {
      // Create a temporary directory
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'handle-'));

      // Copy handle.exe to the temporary directory
      const handlePath = path.join(__dirname, 'handle.exe');
      const tempHandlePath = path.join(tempDir, 'handle.exe');
      await fs.copyFile(handlePath, tempHandlePath);

      // Run handle.exe from the temporary directory
      const command = `"${tempHandlePath}" -nobanner -accepteula -a -u "${normalizedPath}"`;
      await execPromise(command, { cwd: tempDir });

      // Clean up: remove the temporary directory
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to close handles using handle.exe:', error);
    }
  } else if (process.platform === 'linux') {
    try {
      // On Linux, use fuser to identify and kill processes using the file
      const command = `fuser -k "${normalizedPath}"`;
      await execPromise(command);
    } catch (error) {
      console.warn('Failed to close handles using fuser:', error);
    }
  } else if (process.platform === 'darwin') {
    try {
      // On macOS, use lsof to identify processes using the file
      const { stdout } = await execPromise(`lsof -t "${normalizedPath}"`);
      const pids = stdout.split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), 'SIGTERM');
        } catch (killError) {
          console.warn(`Failed to kill process ${pid}:`, killError);
        }
      }
    } catch (error) {
      console.warn('Failed to close handles using lsof:', error);
    }
  }

  // Force garbage collection to release any lingering file handles
  if (global.gc) {
    global.gc();
  }

  // Wait a bit more to ensure all operations have completed
  await new Promise(resolve => setTimeout(resolve, 500));
}

ipcMain.handle('export-trimmed-video', async (event, clipName, start, end) => {
  try {
    const inputPath = path.join(settings.clipLocation, clipName);
    const outputPath = path.join(os.tmpdir(), `trimmed_${Date.now()}_${clipName}`);

    await new Promise((resolve, reject) => {
      let progress = 0;
      ffmpeg(inputPath)
        .setStartTime(start)
        .setDuration(end - start)
        .output(outputPath)
        .on('progress', (info) => {
          progress = info.percent;
          event.sender.send('export-progress', progress);
        })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    if (process.platform === 'win32') {
      clipboard.writeBuffer('FileNameW', Buffer.from(outputPath + '\0', 'ucs2'));
    } else {
      clipboard.writeText(outputPath);
    }

    return { success: true, path: outputPath };
  } catch (error) {
    console.error('Error in export-trimmed-video:', error);
    return { success: false, error: error.message };
  }
});
