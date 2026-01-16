const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const readify = require('readify');
const logger = require('../utils/logger');

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

module.exports = {
  saveCurrentClipList,
  getNewClipsInfo,
  startPeriodicSave,
  stopPeriodicSave
};
