const { app, BrowserWindow, ipcMain, clipboard, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const { loadSettings, saveSettings } = require('./settings-manager');
const readify = require('readify');

const THUMBNAIL_CACHE_DIR = path.join(app.getPath('userData'), 'thumbnail-cache');

// Ensure cache directory exists
fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true }).catch(console.error);

let mainWindow;
let settings;

async function createWindow() {
  settings = await loadSettings();

  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile("index.html");
  Menu.setApplicationMenu(null);
  mainWindow.webContents.openDevTools();
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
  try {
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

ipcMain.handle('get-thumbnail-path', async (event, clipName) => {
  const thumbnailsDir = path.join(app.getPath('userData'), 'thumbnails');
  const thumbnailName = `${path.parse(clipName).name}_thumb.jpg`;
  const thumbnailPath = path.join(thumbnailsDir, thumbnailName);
  
  try {
    await fs.access(thumbnailPath);
    return thumbnailPath;
  } catch (error) {
    console.error(`Thumbnail not found for ${clipName}:`, error);
    return null;
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
      await closeFileHandles(clipPath);

      // Delete the files
      for (const file of filesToDelete) {
        try {
          await fs.unlink(file);
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
  // This is a placeholder function. Implementing this correctly depends on how
  // you're handling file operations in your app. You might need to keep track
  // of open file handles and close them here.
  
  // For now, we'll just make sure the video player is not using the file
  if (global.mainWindow) {
    global.mainWindow.webContents.send('close-video-player');
  }

  // Wait a bit to allow any file operations to complete
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
