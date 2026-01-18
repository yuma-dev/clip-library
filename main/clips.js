const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const readify = require('readify');
const logger = require('../utils/logger');
const thumbnailsModule = require('./thumbnails');
const { logActivity } = require('../utils/activity-tracker');

let periodicSaveInterval = null;

function getLastClipsFilePath() {
  return path.join(app.getPath('userData'), 'last-clips.json');
}

async function saveCurrentClipList(getSettings) {
  const LAST_CLIPS_FILE = getLastClipsFilePath();

  try {
    const settings = await getSettings();
    const clipsFolder = settings?.clipLocation;

    if (!clipsFolder) {
      logger.warn('No clip location set, skipping clip list save');
      return;
    }

    const result = await readify(clipsFolder, {
      type: 'raw',
      sort: 'date',
      order: 'desc'
    });

    const clipNames = result.files
      .filter((file) => ['.mp4', '.avi', '.mov'].includes(path.extname(file.name).toLowerCase()))
      .map((file) => file.name);

    const clipListData = {
      timestamp: Date.now(),
      clips: clipNames
    };

    const tempFile = LAST_CLIPS_FILE + '.tmp';
    const jsonData = JSON.stringify(clipListData, null, 2);

    await fs.writeFile(tempFile, jsonData, 'utf8');

    const verification = await fs.readFile(tempFile, 'utf8');
    JSON.parse(verification);

    await fs.rename(tempFile, LAST_CLIPS_FILE);

    logger.info(`Saved ${clipNames.length} clips for next session comparison`);
  } catch (error) {
    logger.error('Error saving current clip list:', error);

    try {
      const tempFile = LAST_CLIPS_FILE + '.tmp';
      await fs.unlink(tempFile);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
  }
}

async function getNewClipsInfo(getSettings) {
  const LAST_CLIPS_FILE = getLastClipsFilePath();

  try {
    const settings = await getSettings();

    let previousClips = [];
    try {
      const data = await fs.readFile(LAST_CLIPS_FILE, 'utf8');

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

        try {
          const backupPath = LAST_CLIPS_FILE + '.backup.' + Date.now();
          await fs.copyFile(LAST_CLIPS_FILE, backupPath);
          logger.info(`Backed up corrupted file to: ${backupPath}`);
        } catch (backupError) {
          logger.error('Failed to backup corrupted file:', backupError);
        }
      }

      return { newClips: [], totalNewCount: 0 };
    }

    const clipsFolder = settings?.clipLocation;
    const result = await readify(clipsFolder, {
      type: 'raw',
      sort: 'date',
      order: 'desc'
    });

    const currentClips = result.files
      .filter((file) => ['.mp4', '.avi', '.mov'].includes(path.extname(file.name).toLowerCase()))
      .map((file) => file.name);

    const newClips = currentClips.filter((clipName) => !previousClips.includes(clipName));

    logger.info(`Found ${newClips.length} new clips since last session`);

    return {
      newClips,
      totalNewCount: newClips.length
    };
  } catch (error) {
    logger.error('Error getting new clips info:', error);
    return { newClips: [], totalNewCount: 0 };
  }
}

/**
 * Retrieves clip information for a newly detected clip file.
 * 
 * This function gathers metadata about a clip, prioritizing recording timestamps
 * from metadata files over filesystem timestamps when available. It creates a
 * basic clip info object without any trim or editing data.
 * 
 * @async
 * @param {Function} getSettings - Async function that returns the application settings object
 * @param {string} fileName - The name of the clip file (including extension)
 * @returns {Promise<Object>} A promise that resolves to a clip info object containing:
 *   @returns {string} return.originalName - The original filename of the clip
 *   @returns {string} return.customName - The filename without extension, used as default display name
 *   @returns {number} return.createdAt - Timestamp in milliseconds (prioritizes recording time from metadata, falls back to file creation time)
 *   @returns {Array} return.tags - An empty array initialized for future tag assignment
 * 
 * @throws {Error} If the file cannot be accessed or stat() fails
 * 
 * @example
 * const clipInfo = await getNewClipInfo(getSettings, 'gameplay_2024.mp4');
 * // Returns:
 * // {
 * //   originalName: 'gameplay_2024.mp4',
 * //   customName: 'gameplay_2024',
 * //   createdAt: 1704067200000,
 * //   tags: []
 * // }
 */
async function getNewClipInfo(getSettings, fileName) {
  const settings = await getSettings();
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
}

function startPeriodicSave(getSettings) {
  stopPeriodicSave();

  periodicSaveInterval = setInterval(() => {
    saveCurrentClipList(getSettings).catch((error) => {
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

/**
 * Reads the clips directory, collects metadata for each video file,
 * and returns normalized clip information sorted by newest first.
 *
 * - Supports .mp4, .avi, .mov
 * - Skips non-existent files
 * - Reads optional metadata files (.customname, .trim, .date)
 * - Falls back cleanly when metadata is missing
 *
 * @param {Function} getSettings
 *        Async function that resolves to an object containing at least:
 *        { clipLocation: string }
 *
 * @returns {Promise<Array<{
 *   originalName: string,
 *   customName: string,
 *   createdAt: number,
 *   thumbnailPath: string,
 *   isTrimmed: boolean
 * }>>}
 * Resolves to an array of clip metadata objects.
 * Returns an empty array on failure.
 */
async function getClips(getSettings) {
  const settings = await getSettings();
  const clipsFolder = settings?.clipLocation;
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
}

/**
 * Helper function for delays
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Delete a clip and all its associated metadata
 * @param {string} clipName - Name of the clip to delete
 * @param {Function} getSettings - Function that returns settings
 * @param {Object} thumbnailsModule - Thumbnails module for path generation
 * @param {Object} videoPlayer - Optional video player element to clear
 * @returns {Promise<Object>} Result object with success status
 */
async function deleteClip(clipName, getSettings, thumbnailsModule, videoPlayer) {
  const settings = await getSettings();
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
    error: "Failed to delete clip after multiple attempts. The file may be in use.",
  };
}

/**
 * Reveal a clip in the file explorer
 * @param {string} clipName - Name of the clip to reveal
 * @param {Function} getSettings - Function that returns settings
 * @returns {Promise<Object>} Result object with success status
 */
async function revealClip(clipName, getSettings) {
  try {
    const settings = await getSettings();
    const clipPath = path.join(settings.clipLocation, clipName);
    shell.showItemInFolder(clipPath);
    return { success: true };
  } catch (error) {
    logger.error('Error revealing clip:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  saveCurrentClipList,
  getNewClipsInfo,
  getNewClipInfo,
  startPeriodicSave,
  stopPeriodicSave,
  getClips,
  deleteClip,
  revealClip
};
