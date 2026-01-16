/**
 * Thumbnails module - handles thumbnail generation, caching, and validation
 *
 * Provides thumbnail generation with queue processing, validation against trim data,
 * and metadata caching for efficient thumbnail management.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const logger = require('../logger');
const { ffmpeg, ffprobeAsync } = require('./ffmpeg');

// Constants
const CONCURRENT_GENERATIONS = 4;
const THUMBNAIL_RETRY_ATTEMPTS = 3;
const FAST_PATH_THRESHOLD = 12;
const EPSILON = 0.001;

// Module state
let THUMBNAIL_CACHE_DIR = null;
const thumbnailQueue = [];
let isProcessingQueue = false;
let completedThumbnails = 0;

/**
 * Initialize thumbnail cache directory
 * Must be called after app is ready
 */
async function initThumbnailCache() {
  THUMBNAIL_CACHE_DIR = path.join(app.getPath('userData'), 'thumbnail-cache');
  await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  logger.info(`Thumbnail cache initialized at: ${THUMBNAIL_CACHE_DIR}`);
  return THUMBNAIL_CACHE_DIR;
}

/**
 * Get the cache directory path
 * @returns {string} Path to thumbnail cache directory
 */
function getCacheDir() {
  return THUMBNAIL_CACHE_DIR;
}

/**
 * Generate thumbnail path from clip path using MD5 hash
 * @param {string} clipPath - Full path to the clip file
 * @returns {string} Path to the thumbnail file
 */
function generateThumbnailPath(clipPath) {
  const hash = crypto.createHash('md5').update(clipPath).digest('hex');
  return path.join(THUMBNAIL_CACHE_DIR, `${hash}.jpg`);
}

/**
 * Save thumbnail metadata to .meta file
 * @param {string} thumbnailPath - Path to thumbnail file
 * @param {object} metadata - Metadata object to save
 */
async function saveThumbnailMetadata(thumbnailPath, metadata) {
  const metadataPath = thumbnailPath + '.meta';
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
}

/**
 * Get thumbnail metadata from .meta file
 * @param {string} thumbnailPath - Path to thumbnail file
 * @returns {object|null} Metadata object or null if not found
 */
async function getThumbnailMetadata(thumbnailPath) {
  try {
    const metadataPath = thumbnailPath + '.meta';
    const data = await fs.readFile(metadataPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

/**
 * Validate if a thumbnail is up-to-date with current trim data
 * @param {string} clipName - Name of the clip file
 * @param {string} thumbnailPath - Path to thumbnail file
 * @param {Function} getTrimData - Function to get trim data for a clip
 * @returns {boolean} True if thumbnail is valid
 */
async function validateThumbnail(clipName, thumbnailPath, getTrimData) {
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

/**
 * Process the thumbnail generation queue
 * @param {Function} getSettings - Function to get current settings
 * @param {Function} getTrimData - Function to get trim data for a clip
 */
async function processQueue(getSettings, getTrimData) {
  if (isProcessingQueue || thumbnailQueue.length === 0) return;

  isProcessingQueue = true;
  completedThumbnails = 0;

  const settings = await getSettings();

  try {
    while (thumbnailQueue.length > 0) {
      const batch = thumbnailQueue.slice(0, CONCURRENT_GENERATIONS);
      if (batch.length === 0) break;

      const totalToProcess = batch[0].totalToProcess;

      await Promise.all(batch.map(async ({ clipName, event, attempts = 0 }) => {
        const clipPath = path.join(settings.clipLocation, clipName);
        const thumbnailPath = generateThumbnailPath(clipPath);

        try {
          const isValid = await validateThumbnail(clipName, thumbnailPath, getTrimData);

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

          event.sender.send('thumbnail-progress', {
            current: completedThumbnails,
            total: totalToProcess,
            clipName
          });

        } catch (error) {
          logger.error('Error processing thumbnail for', clipName, error);
          if (attempts < THUMBNAIL_RETRY_ATTEMPTS) {
            thumbnailQueue.push({ clipName, event, attempts: attempts + 1, totalToProcess });
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
      // Get event from last processed batch if available
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('thumbnail-generation-complete');
      });
    } else if (!isProcessingQueue) {
      // If there are still items in queue, restart processing
      processQueue(getSettings, getTrimData);
    }
  }
}

/**
 * Handle fast-path thumbnail generation for initial visible clips
 * @param {string[]} clipNames - Array of clip names
 * @param {object} event - IPC event object
 * @param {Function} getSettings - Function to get current settings
 * @param {Function} getTrimData - Function to get trim data for a clip
 * @returns {object} Object with processed count and processedClips Set
 */
async function handleInitialThumbnails(clipNames, event, getSettings, getTrimData) {
  const settings = await getSettings();
  const initialClips = clipNames.slice(0, FAST_PATH_THRESHOLD);

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
      validClipData.map(async ({ clipName, startTime, duration }) => {
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
          event.sender.send('thumbnail-generated', {
            clipName,
            thumbnailPath
          });

        } catch (error) {
          logger.error(`Error generating thumbnail for ${clipName}:`, error);
          event.sender.send('thumbnail-generation-failed', {
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

/**
 * Generate thumbnails progressively for all clips
 * @param {string[]} clipNames - Array of clip names
 * @param {object} event - IPC event object
 * @param {Function} getSettings - Function to get current settings
 * @param {Function} getTrimData - Function to get trim data for a clip
 * @returns {object} Generation status object
 */
async function generateThumbnailsProgressively(clipNames, event, getSettings, getTrimData) {
  const settings = await getSettings();

  try {
    // Handle initial clips first (silently)
    const { processed, processedClips } = await handleInitialThumbnails(clipNames, event, getSettings, getTrimData);

    // Process remaining clips if any
    if (clipNames.length > FAST_PATH_THRESHOLD) {
      const remainingClips = clipNames.slice(FAST_PATH_THRESHOLD).filter(clipName => !processedClips.has(clipName));
      let clipsNeedingGeneration = [];

      // Validate remaining clips
      for (const clipName of remainingClips) {
        const clipPath = path.join(settings.clipLocation, clipName);
        const thumbnailPath = generateThumbnailPath(clipPath);

        try {
          const isValid = await validateThumbnail(clipName, thumbnailPath, getTrimData);
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
        event.sender.send('thumbnail-validation-start', {
          total: clipsNeedingGeneration.length
        });

        thumbnailQueue.length = 0;
        thumbnailQueue.push(...clipsNeedingGeneration.map(clipName => ({
          clipName,
          event,
          totalToProcess: clipsNeedingGeneration.length
        })));

        if (!isProcessingQueue) {
          processQueue(getSettings, getTrimData);
        }
      }
      // Note: No else clause here - we don't send completion for no-op cases
    } else if (processed > 0) {
      // Only send completion if we actually processed initial clips
      event.sender.send('thumbnail-generation-complete');
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
}

/**
 * Generate a single thumbnail for a clip
 * @param {string} clipName - Name of the clip file
 * @param {Function} getSettings - Function to get current settings
 * @returns {string} Path to the generated thumbnail
 */
async function generateThumbnail(clipName, getSettings) {
  const settings = await getSettings();
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
          timemarks: ['00:00:00'],
          folder: path.dirname(thumbnailPath),
          filename: path.basename(thumbnailPath),
          size: '640x360',
        })
        .on('end', () => {
          logger.info(`Thumbnail generated successfully for ${clipName}`);
          resolve(thumbnailPath);
        })
        .on('error', (err) => {
          logger.error(`Error generating thumbnail for ${clipName}:`, err);
          reject(err);
        });
    });
  }
}

/**
 * Regenerate thumbnail at a specific timestamp (for trim updates)
 * @param {string} clipName - Name of the clip file
 * @param {number} startTime - Timestamp in seconds
 * @param {Function} getSettings - Function to get current settings
 * @returns {object} Result object with success status and thumbnailPath
 */
async function regenerateThumbnailForTrim(clipName, startTime, getSettings) {
  const settings = await getSettings();
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
}

/**
 * Get thumbnail path for a clip, checking if it exists
 * @param {string} clipName - Name of the clip file
 * @param {Function} getSettings - Function to get current settings
 * @returns {string|null} Path to thumbnail or null if not found
 */
async function getThumbnailPath(clipName, getSettings) {
  const settings = await getSettings();
  const clipPath = path.join(settings.clipLocation, clipName);
  const thumbnailPath = generateThumbnailPath(clipPath);

  try {
    await fs.access(thumbnailPath);
    return thumbnailPath;
  } catch (error) {
    return null;
  }
}

/**
 * Get thumbnail paths for multiple clips in batch
 * @param {string[]} clipNames - Array of clip names
 * @param {Function} getSettings - Function to get current settings
 * @returns {object} Object mapping clip names to thumbnail paths (or null)
 */
async function getThumbnailPathsBatch(clipNames, getSettings) {
  const settings = await getSettings();
  const results = {};

  await Promise.all(clipNames.map(async (clipName) => {
    const clipPath = path.join(settings.clipLocation, clipName);
    const thumbnailPath = generateThumbnailPath(clipPath);

    try {
      await fs.access(thumbnailPath);
      results[clipName] = thumbnailPath;
    } catch (error) {
      results[clipName] = null;
    }
  }));

  return results;
}

/**
 * Stop queue processing and clear the queue
 * Called during app quit
 */
function stopQueue() {
  thumbnailQueue.length = 0;
  isProcessingQueue = false;
}

/**
 * Check if queue is currently processing
 * @returns {boolean}
 */
function isQueueProcessing() {
  return isProcessingQueue;
}

/**
 * Get current queue length
 * @returns {number}
 */
function getQueueLength() {
  return thumbnailQueue.length;
}

module.exports = {
  // Initialization
  initThumbnailCache,
  getCacheDir,

  // Path generation
  generateThumbnailPath,

  // Metadata
  saveThumbnailMetadata,
  getThumbnailMetadata,

  // Validation
  validateThumbnail,

  // Generation
  generateThumbnail,
  generateThumbnailsProgressively,
  handleInitialThumbnails,
  regenerateThumbnailForTrim,

  // Path lookup
  getThumbnailPath,
  getThumbnailPathsBatch,

  // Queue management
  processQueue,
  stopQueue,
  isQueueProcessing,
  getQueueLength
};
