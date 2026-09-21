const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const logger = require('../utils/logger');
const telemetry = require('./telemetry');
const { ffmpeg, ffprobeAsync } = require('./ffmpeg');
const { mapLimit } = require('../utils/pool');

// Concurrent thumbnail validations (fs.access + two small reads each).
const VALIDATE_CONCURRENCY = 16;

const CONCURRENT_GENERATIONS = 4;
const THUMBNAIL_RETRY_ATTEMPTS = 3;
const THUMBNAIL_RETRY_BASE_MS = 1500;
const FAST_PATH_THRESHOLD = 12;
const EPSILON = 0.001;
const META_CORRUPT_COALESCE_MS = 600000;

let THUMBNAIL_CACHE_DIR = null;
const thumbnailQueue = [];
let isProcessingQueue = false;
let completedThumbnails = 0;
// Count of ffmpeg children currently spawned for thumbnail generation. Nothing
// kills them, so stopQueue can at least report how many it orphaned.
let inFlightGenerations = 0;

/**
 * @param {Error} error
 * @returns {number|undefined}
 */
function parseFfmpegExitCode(error) {
  const match = String(error?.message || '').match(/exited with code (-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

// must be called after app is ready
async function initThumbnailCache() {
  THUMBNAIL_CACHE_DIR = path.join(app.getPath('userData'), 'thumbnail-cache');
  try {
    await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  } catch (error) {
    // Rethrown below, which rejects createWindow(): no window is ever created
    // and the splash sits there for 30s. Report it before it disappears.
    telemetry.event('thumbnail_cache_init_failed', {
      kind: telemetry.KIND.CRASH,
      severity: telemetry.SEVERITY.FATAL,
      context: { errno: error?.code },
      error
    });
    throw error;
  }
  logger.info(`Thumbnail cache initialized at: ${THUMBNAIL_CACHE_DIR}`);
  return THUMBNAIL_CACHE_DIR;
}

function getCacheDir() {
  return THUMBNAIL_CACHE_DIR;
}

function generateThumbnailPath(clipPath) {
  const hash = crypto.createHash('md5').update(clipPath).digest('hex');
  return path.join(THUMBNAIL_CACHE_DIR, `${hash}.jpg`);
}

async function saveThumbnailMetadata(thumbnailPath, metadata) {
  const metadataPath = thumbnailPath + '.meta';
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
}

async function getThumbnailMetadata(thumbnailPath) {
  let data = null;
  try {
    const metadataPath = thumbnailPath + '.meta';
    data = await fs.readFile(metadataPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // parse failure (vs read failure) means corrupt; callers treat both as missing
    // so the clip re-probes every open and never self-repairs
    if (data !== null) {
      telemetry.event('thumbnail_meta_corrupt', {
        kind: telemetry.KIND.DEGRADED,
        severity: telemetry.SEVERITY.WARNING,
        context: { file_bytes: Buffer.byteLength(data, 'utf8') },
        coalesceMs: META_CORRUPT_COALESCE_MS
      });
    }
    return null;
  }
}

async function validateThumbnail(clipName, thumbnailPath, getTrimData) {
  try {
    try {
      await fs.access(thumbnailPath);
    } catch (error) {
      logger.info(`${clipName}: No thumbnail file exists`);
      return false;
    }

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
        const startedAtMs = Date.now();
        let stage = 'probe';
        let clipDuration = null;
        let counted = false;

        try {
          const isValid = await validateThumbnail(clipName, thumbnailPath, getTrimData);

          if (!isValid) {
            inFlightGenerations++;
            counted = true;
            const info = await new Promise((resolve, reject) => {
              ffmpeg.ffprobe(clipPath, (err, metadata) => {
                if (err) reject(err);
                else resolve(metadata);
              });
            });

            const trimData = await getTrimData(clipName);
            const duration = info.format.duration;
            clipDuration = Number(duration);
            const startTime = trimData ? trimData.start : (duration > 40 ? duration / 2 : 0);

            stage = 'screenshot';
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

            stage = 'meta_write';
            await saveThumbnailMetadata(thumbnailPath, {
              startTime,
              duration,
              clipName,
              timestamp: Date.now()
            });

            inFlightGenerations--;
            counted = false;
            telemetry.metric('thumbnail_gen_ms', Date.now() - startedAtMs, {
              unit: 'ms',
              dims: { stage: 'queued' }
            });
          }

          completedThumbnails++;

          event.sender.send('thumbnail-progress', {
            current: completedThumbnails,
            total: totalToProcess,
            clipName
          });

        } catch (error) {
          if (counted) inFlightGenerations--;
          logger.error('Error processing thumbnail for', clipName, error);
          if (attempts < THUMBNAIL_RETRY_ATTEMPTS) {
            // a clip the recorder is still writing fails every immediate retry; give it a few
            // seconds to land before the next attempt
            const delayMs = THUMBNAIL_RETRY_BASE_MS * 2 ** attempts;
            setTimeout(() => {
              thumbnailQueue.push({ clipName, event, attempts: attempts + 1, totalToProcess });
              processQueue(getSettings, getTrimData);
            }, delayMs);
          } else {
            // Out of retries. Tell the renderer so the card gets an explicit
            // "no thumbnail" state instead of shimmering forever.
            try {
              event.sender.send('thumbnail-generation-failed', {
                clipName,
                error: error.message
              });
            } catch (_) { /* window gone */ }
            telemetry.event('thumbnail_generation_exhausted', {
              kind: telemetry.KIND.SILENT_FAILURE,
              severity: telemetry.SEVERITY.ERROR,
              context: {
                attempts: attempts + 1,
                stage,
                exit_code: parseFfmpegExitCode(error),
                duration_s: Number.isFinite(clipDuration) ? Math.round(clipDuration) : undefined
              }
            });
          }
        }
      }));

      thumbnailQueue.splice(0, batch.length);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    isProcessingQueue = false;

    if (thumbnailQueue.length === 0) {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('thumbnail-generation-complete');
      });
    } else if (!isProcessingQueue) {
      // new items were pushed mid-batch, restart the loop
      processQueue(getSettings, getTrimData);
    }
  }
}

async function handleInitialThumbnails(clipNames, event, getSettings, getTrimData) {
  const settings = await getSettings();
  const initialClips = clipNames.slice(0, FAST_PATH_THRESHOLD);
  // clips the fast path could not probe; the caller retries them on the queue
  let droppedClips = [];

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

  const clipsNeedingGeneration = missingThumbnails.filter(Boolean);

  if (clipsNeedingGeneration.length > 0) {
    logger.info(`Fast-tracking thumbnail generation for ${clipsNeedingGeneration.length} initial clips`);

    const clipData = await Promise.all(
      clipsNeedingGeneration.map(async clipName => {
        const clipPath = path.join(settings.clipLocation, clipName);
        try {
          const trimData = await getTrimData(clipName);
          if (trimData) {
            return { clipName, startTime: trimData.start };
          }

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

    const validClipData = clipData.filter(Boolean);

    // used to be dropped for good here; now handed to the caller's queue for retry+report
    // (clipData keeps clipsNeedingGeneration's order, so the index pairs)
    droppedClips = clipsNeedingGeneration.filter((_, i) => !clipData[i]);
    if (droppedClips.length > 0) {
      telemetry.event('thumbnail_fastpath_dropped', {
        kind: telemetry.KIND.SILENT_FAILURE,
        severity: telemetry.SEVERITY.WARNING,
        context: {
          count: droppedClips.length,
          // names only, no paths, capped so context stays small
          clips: droppedClips.slice(0, 10).map((name) => path.basename(name))
        }
      });
    }

    await Promise.all(
      validClipData.map(async ({ clipName, startTime, duration }) => {
        const clipPath = path.join(settings.clipLocation, clipName);
        const thumbnailPath = generateThumbnailPath(clipPath);
        const startedAtMs = Date.now();
        let counted = false;

        try {
          inFlightGenerations++;
          counted = true;
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

          inFlightGenerations--;
          counted = false;
          telemetry.metric('thumbnail_gen_ms', Date.now() - startedAtMs, {
            unit: 'ms',
            dims: { stage: 'fastpath' }
          });

          event.sender.send('thumbnail-generated', {
            clipName,
            thumbnailPath
          });

        } catch (error) {
          if (counted) inFlightGenerations--;
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
    // dropped clips are not "processed", must not be filtered out of the queue pass below
    processedClips: new Set(clipsNeedingGeneration.filter((name) => !droppedClips.includes(name))),
    droppedClips
  };
}

async function generateThumbnailsProgressively(clipNames, event, getSettings, getTrimData) {
  const settings = await getSettings();

  try {
    const { processed, processedClips, droppedClips } = await handleInitialThumbnails(clipNames, event, getSettings, getTrimData);
    const fastPathDropped = Array.isArray(droppedClips) ? droppedClips : [];

    if (clipNames.length > FAST_PATH_THRESHOLD) {
      const remainingClips = clipNames.slice(FAST_PATH_THRESHOLD).filter(clipName => !processedClips.has(clipName));
      // fast-path failures go on the queue too, which retries and reports instead of leaving an empty card
      let clipsNeedingGeneration = [...fastPathDropped];

      // bounded pool (3 file reads/clip) - used to run one clip at a time for the whole library
      const invalid = await mapLimit(remainingClips, VALIDATE_CONCURRENCY, async (clipName) => {
        const clipPath = path.join(settings.clipLocation, clipName);
        const thumbnailPath = generateThumbnailPath(clipPath);
        try {
          return (await validateThumbnail(clipName, thumbnailPath, getTrimData)) ? null : clipName;
        } catch (error) {
          logger.error(`Error validating thumbnail for ${clipName}:`, error);
          return clipName;
        }
      });
      clipsNeedingGeneration.push(...invalid.filter(Boolean));

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
      // deliberately no else: no completion event for the no-op case
    } else if (fastPathDropped.length > 0) {
      // small library, no queue pass below - start one just for what the fast path couldn't handle
      event.sender.send('thumbnail-validation-start', { total: fastPathDropped.length });
      thumbnailQueue.push(...fastPathDropped.map(clipName => ({
        clipName,
        event,
        totalToProcess: fastPathDropped.length
      })));
      if (!isProcessingQueue) {
        processQueue(getSettings, getTrimData);
      }
    } else if (processed > 0) {
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

async function generateThumbnail(clipName, getSettings) {
  const settings = await getSettings();
  const clipPath = path.join(settings.clipLocation, clipName);
  const thumbnailPath = generateThumbnailPath(clipPath);

  try {
    await fs.access(thumbnailPath);
    return thumbnailPath;
  } catch (error) {
    logger.info(`Generating new thumbnail for ${clipName}`);
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

async function regenerateThumbnailForTrim(clipName, startTime, getSettings) {
  const settings = await getSettings();
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

// called during app quit
function stopQueue() {
  // clearing the array doesn't kill already-spawned ffmpeg children, they're orphaned on quit
  if (inFlightGenerations > 0) {
    telemetry.event('thumbnail_queue_orphaned', {
      kind: telemetry.KIND.DEGRADED,
      severity: telemetry.SEVERITY.WARNING,
      context: { in_flight: inFlightGenerations }
    });
  }
  thumbnailQueue.length = 0;
  isProcessingQueue = false;
}

function isQueueProcessing() {
  return isProcessingQueue;
}

function getQueueLength() {
  return thumbnailQueue.length;
}

module.exports = {
  initThumbnailCache,
  getCacheDir,
  generateThumbnailPath,
  saveThumbnailMetadata,
  getThumbnailMetadata,
  validateThumbnail,
  generateThumbnail,
  generateThumbnailsProgressively,
  handleInitialThumbnails,
  regenerateThumbnailForTrim,
  getThumbnailPath,
  getThumbnailPathsBatch,
  processQueue,
  stopQueue,
  isQueueProcessing,
  getQueueLength
};
