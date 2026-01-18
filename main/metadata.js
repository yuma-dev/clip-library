/**
 * Metadata module - handles .clip_metadata file I/O
 *
 * Provides atomic file writes, and read/write operations for all clip metadata:
 * custom names, trim data, speed, volume, volume range, and tags.
 */

const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const { logActivity } = require('../utils/activity-tracker');

// ============================================================================
// File Utilities
// ============================================================================

/**
 * Ensure a directory exists, creating it if necessary
 * @param {string} dirPath - Path to directory
 */
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

/**
 * Write file with retry logic for permission errors
 * @param {string} filePath - Path to file
 * @param {string} data - Data to write
 * @param {number} retries - Number of retry attempts
 */
async function writeFileWithRetry(filePath, data, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await fs.writeFile(filePath, data, { flag: 'w' });
      return;
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        if (attempt === retries - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } else {
        throw error;
      }
    }
  }
}

/**
 * Write file atomically using temp file + rename
 * @param {string} filePath - Path to file
 * @param {string} data - Data to write
 */
async function writeFileAtomically(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  const dir = path.dirname(filePath);

  try {
    await fs.mkdir(dir, { recursive: true });
    await writeFileWithRetry(tempPath, data);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    logger.error(`Error in writeFileAtomically: ${error.message}`);
    await writeFileWithRetry(filePath, data);
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`Error deleting temp file: ${error.message}`);
      }
    }
  }
}

/**
 * Get the metadata folder path for a clip location
 * @param {string} clipLocation - Base clip folder path
 * @returns {string} Path to .clip_metadata folder
 */
function getMetadataFolder(clipLocation) {
  return path.join(clipLocation, '.clip_metadata');
}

// ============================================================================
// Custom Name
// ============================================================================

/**
 * Save custom name for a clip
 * @param {string} clipName - Original clip filename
 * @param {string} customName - Custom display name
 * @param {Function} getSettings - Function to get settings
 */
async function saveCustomName(clipName, customName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  await ensureDirectoryExists(metadataFolder);

  const customNameFilePath = path.join(metadataFolder, `${clipName}.customname`);
  try {
    await writeFileAtomically(customNameFilePath, customName);
    logger.info(`Custom name saved successfully for ${clipName}`);
    logActivity('rename', { originalName: clipName, newCustomName: customName });
  } catch (error) {
    logger.error(`Error saving custom name for ${clipName}:`, error);
    throw error;
  }
}

/**
 * Get custom name for a clip
 * @param {string} clipName - Original clip filename
 * @param {Function} getSettings - Function to get settings
 * @returns {string|null} Custom name or null if not set
 */
async function getCustomName(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const customNameFilePath = path.join(metadataFolder, `${clipName}.customname`);

  try {
    return await fs.readFile(customNameFilePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// ============================================================================
// Trim Data
// ============================================================================

/**
 * Save trim data for a clip
 * @param {string} clipName - Clip filename
 * @param {object} trimData - Trim data { start, end }
 * @param {Function} getSettings - Function to get settings
 */
async function saveTrimData(clipName, trimData, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  await ensureDirectoryExists(metadataFolder);

  const trimFilePath = path.join(metadataFolder, `${clipName}.trim`);
  try {
    await writeFileAtomically(trimFilePath, JSON.stringify(trimData));
    logger.info(`Trim data saved successfully for ${clipName}`);
    logActivity('trim', { clipName, start: trimData.start, end: trimData.end });
  } catch (error) {
    logger.error(`Error saving trim data for ${clipName}:`, error);
    throw error;
  }
}

/**
 * Get trim data for a clip
 * @param {string} clipName - Clip filename
 * @param {Function} getSettings - Function to get settings
 * @returns {object|null} Trim data or null if not set
 */
async function getTrimData(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const trimFilePath = path.join(metadataFolder, `${clipName}.trim`);

  try {
    const trimData = await fs.readFile(trimFilePath, 'utf8');
    return JSON.parse(trimData);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Delete trim data for a clip
 * @param {string} clipName - Clip filename
 * @param {Function} getSettings - Function to get settings
 */
async function deleteTrimData(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const trimFilePath = path.join(metadataFolder, `${clipName}.trim`);

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
}

// ============================================================================
// Speed
// ============================================================================

/**
 * Save playback speed for a clip
 * @param {string} clipName - Clip filename
 * @param {number} speed - Playback speed multiplier
 * @param {Function} getSettings - Function to get settings
 */
async function saveSpeed(clipName, speed, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  await ensureDirectoryExists(metadataFolder);
  const speedFilePath = path.join(metadataFolder, `${clipName}.speed`);

  try {
    await writeFileAtomically(speedFilePath, speed.toString());
    logger.info(`Speed saved successfully for ${clipName}: ${speed}`);
    logActivity('speed_change', { clipName, speed });
    return { success: true };
  } catch (error) {
    logger.error(`Error saving speed for ${clipName}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Get playback speed for a clip
 * @param {string} clipName - Clip filename
 * @param {Function} getSettings - Function to get settings
 * @returns {number} Speed multiplier (default 1)
 */
async function getSpeed(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const speedFilePath = path.join(metadataFolder, `${clipName}.speed`);

  try {
    const speedData = await fs.readFile(speedFilePath, 'utf8');
    const parsedSpeed = parseFloat(speedData);
    if (isNaN(parsedSpeed)) {
      logger.warn(`Invalid speed data for ${clipName}, using default`);
      return 1;
    }
    return parsedSpeed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return 1;
    }
    logger.error(`Error reading speed for ${clipName}:`, error);
    throw error;
  }
}

// ============================================================================
// Volume
// ============================================================================

/**
 * Save volume level for a clip
 * @param {string} clipName - Clip filename
 * @param {number} volume - Volume level
 * @param {Function} getSettings - Function to get settings
 */
async function saveVolume(clipName, volume, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  await ensureDirectoryExists(metadataFolder);
  const volumeFilePath = path.join(metadataFolder, `${clipName}.volume`);

  try {
    await writeFileAtomically(volumeFilePath, volume.toString());
    logger.info(`Volume saved successfully for ${clipName}: ${volume}`);
    logActivity('volume_change', { clipName, volume });
    return { success: true };
  } catch (error) {
    logger.error(`Error saving volume for ${clipName}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Get volume level for a clip
 * @param {string} clipName - Clip filename
 * @param {Function} getSettings - Function to get settings
 * @returns {number} Volume level (default 1)
 */
async function getVolume(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const volumeFilePath = path.join(metadataFolder, `${clipName}.volume`);

  try {
    const volumeData = await fs.readFile(volumeFilePath, 'utf8');
    const parsedVolume = parseFloat(volumeData);
    if (isNaN(parsedVolume)) {
      logger.warn(`Invalid volume data for ${clipName}, using default`);
      return 1;
    }
    return parsedVolume;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return 1;
    }
    logger.error(`Error reading volume for ${clipName}:`, error);
    throw error;
  }
}

// ============================================================================
// Volume Range
// ============================================================================

/**
 * Save volume range adjustment data for a clip
 * @param {string} clipName - Clip filename
 * @param {object} volumeData - Volume range data { start, end, level }
 * @param {Function} getSettings - Function to get settings
 */
async function saveVolumeRange(clipName, volumeData, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const volumeRangeFilePath = path.join(metadataFolder, `${clipName}.volumerange`);

  try {
    await writeFileAtomically(volumeRangeFilePath, JSON.stringify(volumeData));
    logger.info(`Volume range data saved successfully for ${clipName}`);
    return { success: true };
  } catch (error) {
    logger.error(`Error saving volume range for ${clipName}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Get volume range adjustment data for a clip
 * @param {string} clipName - Clip filename
 * @param {Function} getSettings - Function to get settings
 * @returns {object|null} Volume range data or null if not set
 */
async function getVolumeRange(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const volumeRangeFilePath = path.join(metadataFolder, `${clipName}.volumerange`);

  try {
    const volumeData = await fs.readFile(volumeRangeFilePath, 'utf8');
    return JSON.parse(volumeData);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    logger.error(`Error reading volume range for ${clipName}:`, error);
    throw error;
  }
}

// ============================================================================
// Clip Tags
// ============================================================================

/**
 * Get tags for a specific clip
 * @param {string} clipName - Clip filename
 * @param {Function} getSettings - Function to get settings
 * @returns {string[]} Array of tag names
 */
async function getClipTags(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const tagsFilePath = path.join(metadataFolder, `${clipName}.tags`);

  try {
    const tagsData = await fs.readFile(tagsFilePath, 'utf8');
    return JSON.parse(tagsData);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    logger.error('Error reading tags:', error);
    return [];
  }
}

/**
 * Save tags for a specific clip
 * @param {string} clipName - Clip filename
 * @param {string[]} tags - Array of tag names
 * @param {Function} getSettings - Function to get settings
 */
async function saveClipTags(clipName, tags, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const tagsFilePath = path.join(metadataFolder, `${clipName}.tags`);

  try {
    await fs.writeFile(tagsFilePath, JSON.stringify(tags));
    logActivity('tags_update_clip', { clipName, tags });
    return { success: true };
  } catch (error) {
    logger.error('Error saving tags:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Global Tags
// ============================================================================

/**
 * Load global tags list
 * @param {Function} getAppPath - Function to get app paths (app.getPath)
 * @returns {string[]} Array of global tag names
 */
async function loadGlobalTags(getAppPath) {
  const tagsFilePath = path.join(getAppPath('userData'), 'global_tags.json');
  try {
    const tagsData = await fs.readFile(tagsFilePath, 'utf8');
    return JSON.parse(tagsData);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    logger.error('Error reading global tags:', error);
    return [];
  }
}

/**
 * Save global tags list
 * @param {string[]} tags - Array of global tag names
 * @param {Function} getAppPath - Function to get app paths (app.getPath)
 */
async function saveGlobalTags(tags, getAppPath) {
  const tagsFilePath = path.join(getAppPath('userData'), 'global_tags.json');
  try {
    await fs.writeFile(tagsFilePath, JSON.stringify(tags));
    logActivity('tags_update_global', { tags });
    return { success: true };
  } catch (error) {
    logger.error('Error saving global tags:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Remove a tag from all clips
 * @param {string} tagToRemove - Tag name to remove
 * @param {Function} getSettings - Function to get settings
 */
async function removeTagFromAllClips(tagToRemove, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);

  let modifiedCount = 0;

  try {
    const files = await fs.readdir(metadataFolder);
    const tagFiles = files.filter(file => file.endsWith('.tags'));

    logger.info(`Checking ${tagFiles.length} .tags files for tag "${tagToRemove}"`);

    for (const tagFile of tagFiles) {
      try {
        const tagFilePath = path.join(metadataFolder, tagFile);
        const tagsData = await fs.readFile(tagFilePath, 'utf8');
        const tags = JSON.parse(tagsData);

        const tagIndex = tags.indexOf(tagToRemove);
        if (tagIndex > -1) {
          tags.splice(tagIndex, 1);
          await fs.writeFile(tagFilePath, JSON.stringify(tags));
          modifiedCount++;
          logger.info(`Removed tag "${tagToRemove}" from ${tagFile}`);
        }
      } catch (error) {
        logger.warn(`Could not process tags file ${tagFile}:`, error.message);
      }
    }
  } catch (error) {
    logger.info('No metadata folder found or couldn\'t read it');
    return { success: true, modifiedCount: 0 };
  }

  logger.info(`Tag deletion completed: modified ${modifiedCount} files`);
  return { success: true, modifiedCount };
}

/**
 * Update a tag name in all clips
 * @param {string} oldTag - Current tag name
 * @param {string} newTag - New tag name
 * @param {Function} getSettings - Function to get settings
 */
async function updateTagInAllClips(oldTag, newTag, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);

  let modifiedCount = 0;

  try {
    const files = await fs.readdir(metadataFolder);
    const tagFiles = files.filter(file => file.endsWith('.tags'));

    logger.info(`Checking ${tagFiles.length} .tags files for tag "${oldTag}" to update to "${newTag}"`);

    for (const tagFile of tagFiles) {
      try {
        const tagFilePath = path.join(metadataFolder, tagFile);
        const tagsData = await fs.readFile(tagFilePath, 'utf8');
        const tags = JSON.parse(tagsData);

        const tagIndex = tags.indexOf(oldTag);
        if (tagIndex > -1) {
          tags[tagIndex] = newTag;
          await fs.writeFile(tagFilePath, JSON.stringify(tags));
          modifiedCount++;
          logger.info(`Updated tag "${oldTag}" to "${newTag}" in ${tagFile}`);
        }
      } catch (error) {
        logger.warn(`Could not process tags file ${tagFile}:`, error.message);
      }
    }
  } catch (error) {
    logger.info('No metadata folder found or couldn\'t read it');
    return { success: true, modifiedCount: 0 };
  }

  logger.info(`Tag update completed: modified ${modifiedCount} files`);
  return { success: true, modifiedCount };
}

/**
 * Restore missing global tags from clip tag files
 * @param {Function} getSettings - Function to get settings
 * @param {Function} getAppPath - Function to get app paths (app.getPath)
 */
async function restoreMissingGlobalTags(getSettings, getAppPath) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);

  let allClipTags = new Set();

  try {
    const files = await fs.readdir(metadataFolder);
    const tagFiles = files.filter(file => file.endsWith('.tags'));

    for (const tagFile of tagFiles) {
      try {
        const tagFilePath = path.join(metadataFolder, tagFile);
        const tagsData = await fs.readFile(tagFilePath, 'utf8');
        const tags = JSON.parse(tagsData);
        tags.forEach(tag => allClipTags.add(tag));
      } catch (error) {
        logger.warn(`Could not read tags from ${tagFile}:`, error.message);
      }
    }
  } catch (error) {
    logger.info('No metadata folder found or couldn\'t read it');
    return { success: true, restoredCount: 0 };
  }

  // Load current global tags
  const tagsFilePath = path.join(getAppPath('userData'), 'global_tags.json');
  let currentGlobalTags = [];
  try {
    const tagsData = await fs.readFile(tagsFilePath, 'utf8');
    currentGlobalTags = JSON.parse(tagsData);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading global tags during restore:', error);
    }
    currentGlobalTags = [];
  }
  const currentGlobalTagsSet = new Set(currentGlobalTags);

  // Find missing tags
  const missingTags = [...allClipTags].filter(tag => !currentGlobalTagsSet.has(tag));

  if (missingTags.length > 0) {
    const updatedGlobalTags = [...currentGlobalTags, ...missingTags];
    await fs.writeFile(tagsFilePath, JSON.stringify(updatedGlobalTags));

    logger.info(`Restored ${missingTags.length} missing global tags:`, missingTags);
    logActivity('tags_restore_global', { restoredTags: missingTags, count: missingTags.length });

    return { success: true, restoredCount: missingTags.length, restoredTags: missingTags };
  } else {
    logger.info('No missing global tags found');
    return { success: true, restoredCount: 0 };
  }
}

// ============================================================================
// Game Info (read-only for now)
// ============================================================================

/**
 * Get game icon info for a clip
 * @param {string} clipName - Clip filename
 * @param {Function} getSettings - Function to get settings
 * @returns {object|null} Game icon info { path, title } or null
 */
async function getGameIcon(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const gameInfoPath = path.join(metadataFolder, `${clipName}.gameinfo`);

  let raw;
  try {
    raw = await fs.readFile(gameInfoPath, 'utf8');
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const response = { path: null, title: parsed.window_title || null };

  if (parsed.icon_file) {
    const iconPath = path.join(settings.clipLocation, 'icons', parsed.icon_file);
    try {
      await fs.access(iconPath);
      response.path = iconPath;
    } catch {
      // icon missing -> leave null
    }
  }

  return response;
}

// ============================================================================
// Tag Preferences
// ============================================================================

/**
 * Get tag preferences from userData
 * @param {Function} getAppPath - Function to get app path (app.getPath.bind(app))
 * @returns {Promise<Object|null>} Tag preferences object or null if not found
 */
async function getTagPreferences(getAppPath) {
  try {
    const prefsPath = path.join(getAppPath('userData'), 'tagPreferences.json');
    const prefs = await fs.readFile(prefsPath, 'utf8');
    return JSON.parse(prefs);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading tag preferences:', error);
    }
    return null;
  }
}

/**
 * Save tag preferences to userData
 * @param {Object} preferences - Tag preferences to save
 * @param {Function} getAppPath - Function to get app path (app.getPath.bind(app))
 * @returns {Promise<boolean>} True if saved successfully
 */
async function saveTagPreferences(preferences, getAppPath) {
  try {
    const prefsPath = path.join(getAppPath('userData'), 'tagPreferences.json');
    await fs.writeFile(prefsPath, JSON.stringify(preferences));
    return true;
  } catch (error) {
    logger.error('Error saving tag preferences:', error);
    return false;
  }
}

module.exports = {
  // File utilities
  ensureDirectoryExists,
  writeFileAtomically,
  getMetadataFolder,

  // Custom name
  saveCustomName,
  getCustomName,

  // Trim data
  saveTrimData,
  getTrimData,
  deleteTrimData,

  // Speed
  saveSpeed,
  getSpeed,

  // Volume
  saveVolume,
  getVolume,

  // Volume range
  saveVolumeRange,
  getVolumeRange,

  // Clip tags
  getClipTags,
  saveClipTags,

  // Global tags
  loadGlobalTags,
  saveGlobalTags,
  removeTagFromAllClips,
  updateTagInAllClips,
  restoreMissingGlobalTags,

  // Tag preferences
  getTagPreferences,
  saveTagPreferences,

  // Game info
  getGameIcon
};
