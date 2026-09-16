const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const telemetry = require('./telemetry');
const thumbnailsModule = require('./thumbnails');
const { mapLimit } = require('../utils/pool');

// concurrent fs.stat calls during a library walk
const STAT_CONCURRENCY = 32;
const { logActivity } = require('../utils/activity-tracker');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mov']);

// count from the last successful getClips(); kept so callers that only need
// the count (telemetry) skip a rescan. null = no successful scan yet this session
let lastClipCount = null;

/** skips dirs starting with '.' and 'icons'. statFailures tallies stat
 * errors across the recursion; only the top-level call reports the event
 * @param {string} dir
 * @param {string} baseDir
 * @param {number} [depth]
 * @param {object} [statFailures]
 * @returns {Promise<Array<{name: string, date: Date}>>}
 */
async function walkClips(dir, baseDir, depth = 0, statFailures = null) {
  const dropped = statFailures || { count: 0, errno: undefined };
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    logger.error(`Error reading directory ${dir}:`, error);
    // This whole subtree just vanished from the library with no user-visible sign.
    telemetry.event('clips_subtree_unreadable', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.ERROR,
      context: { errno: error.code, depth },
      coalesceMs: 60000,
      error
    });
    return [];
  }

  // bounded stat pool: sequential costs ~180us x N clips; unbounded fan-out
  // queues thousands of stats on the libuv threadpool and starves other file ops at startup
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'icons') dirs.push(entry.name);
    } else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(entry.name);
    }
  }
  const subtrees = Promise.all(dirs.map((name) => walkClips(path.join(dir, name), baseDir, depth + 1, dropped)));
  const stats = await mapLimit(files, STAT_CONCURRENCY, async (name) => {
    const fullPath = path.join(dir, name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    try {
      const st = await fs.stat(fullPath);
      return { name: relativePath, date: st.mtime };
    } catch (error) {
      logger.error(`Error reading stats for ${fullPath}:`, error);
      // tallied, not reported per file: one bad drive drops thousands
      dropped.count += 1;
      if (!dropped.errno) dropped.errno = error.code;
      return null;
    }
  });
  const clips = [...stats.filter(Boolean), ...(await subtrees).flat()];
  if (!statFailures && dropped.count > 0) {
    telemetry.event('clip_stat_dropped', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { errno: dropped.errno, count: dropped.count }
    });
  }
  return clips;
}

/** flattens a relative clip path into a safe .clip_metadata/ key, e.g.
 * "highlights/gameplay.mp4" becomes "highlights--gameplay.mp4"; root clips are unchanged */
function metadataSafeName(clipName) {
  return clipName.replace(/\//g, '--');
}

// Module state
let periodicSaveInterval = null;

function getLastClipsFilePath() {
  return path.join(app.getPath('userData'), 'last-clips.json');
}

// snapshots the current clip list for next-session comparison
async function saveCurrentClipList(getSettings) {
  const LAST_CLIPS_FILE = getLastClipsFilePath();
  // which step we died on, for telemetry only
  let stage = 'scan';

  try {
    const settings = await getSettings();
    const clipsFolder = settings?.clipLocation;

    if (!clipsFolder) {
      logger.warn('No clip location set, skipping clip list save');
      return;
    }

    const files = await walkClips(clipsFolder, clipsFolder);
    const clipNames = files.map((file) => file.name);

    const clipListData = {
      timestamp: Date.now(),
      clips: clipNames
    };

    const tempFile = LAST_CLIPS_FILE + '.tmp';
    const jsonData = JSON.stringify(clipListData, null, 2);

    stage = 'write';
    await fs.writeFile(tempFile, jsonData, 'utf8');

    stage = 'verify';
    const verification = await fs.readFile(tempFile, 'utf8');
    stage = 'parse';
    JSON.parse(verification);

    stage = 'rename';
    await fs.rename(tempFile, LAST_CLIPS_FILE);

    logger.info(`Saved ${clipNames.length} clips for next session comparison`);
  } catch (error) {
    logger.error('Error saving current clip list:', error);
    telemetry.event('clip_list_save_failed', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { errno: error.code, stage },
      error
    });

    try {
      const tempFile = LAST_CLIPS_FILE + '.tmp';
      await fs.unlink(tempFile);
    } catch (cleanupError) {
    }
  }
}

/** watched-clips file: clips the user has opened in the player; a clip is
 * "new" until it appears here */
function getWatchedClipsFilePath() {
  return path.join(app.getPath('userData'), 'watched-clips.json');
}

// in-memory watched set, loaded once per process; null = not loaded yet
let watchedClips = null;

/** loads into watchedClips; returns false if the file doesn't exist yet (pre-migration installs) */
async function loadWatchedClips() {
  if (watchedClips) return true;
  let data = null;
  try {
    data = await fs.readFile(getWatchedClipsFilePath(), 'utf8');
    const parsed = JSON.parse(data);
    watchedClips = new Set(Array.isArray(parsed.watched) ? parsed.watched : []);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading watched clips file:', error);
      // every clip in the library gets re-flagged as new after this
      telemetry.event('watched_clips_reset', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.ERROR,
        context: {
          // set is always empty here (not loaded yet); file_bytes carries the real magnitude
          prior_size: watchedClips ? watchedClips.size : 0,
          file_bytes: data == null ? 0 : Buffer.byteLength(data, 'utf8'),
          errno: error.code
        },
        error
      });
      // unreadable/corrupt: start over rather than flagging the whole library
      watchedClips = new Set();
      return true;
    }
    return false;
  }
}

async function saveWatchedClips() {
  if (!watchedClips) return;
  const file = getWatchedClipsFilePath();
  const tempFile = file + '.tmp';
  try {
    await fs.writeFile(tempFile, JSON.stringify({ watched: [...watchedClips] }), 'utf8');
    await fs.rename(tempFile, file);
  } catch (error) {
    logger.error('Error saving watched clips file:', error);
    try {
      await fs.unlink(tempFile);
    } catch {
    }
  }
}

// records clips opened in the player, so they stop counting as new
async function markClipsWatched(clipNames) {
  const names = (Array.isArray(clipNames) ? clipNames : [clipNames]).filter(Boolean);
  if (names.length === 0) return;
  if (!(await loadWatchedClips())) watchedClips = new Set();
  let changed = false;
  for (const name of names) {
    if (!watchedClips.has(name)) {
      watchedClips.add(name);
      changed = true;
    }
  }
  if (changed) await saveWatchedClips();
}

/** "new" = never opened in the player. Migration: pre-tracking installs seed
 * watched from the old last-clips.json snapshot; true first run (neither file) seeds the whole library as watched */
async function getNewClipsInfo(getSettings, knownNames) {
  try {
    const settings = await getSettings();
    const clipsFolder = settings?.clipLocation;
    if (!clipsFolder) return { newClips: [], totalNewCount: 0 };

    // renderer passes names from its own get-clips scan; only walk again if it didn't
    const currentClips = Array.isArray(knownNames)
      ? knownNames
      : (await walkClips(clipsFolder, clipsFolder)).map((file) => file.name);

    if (!(await loadWatchedClips())) {
      let previousClips = null;
      try {
        const data = await fs.readFile(getLastClipsFilePath(), 'utf8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed.clips)) previousClips = parsed.clips;
      } catch (error) {
        // missing/corrupt snapshot: treated as first run below. missing file
        // is the normal pre-migration case; anything else lost the seed
        if (error.code !== 'ENOENT') {
          telemetry.event('watched_migration_failed', {
            kind: telemetry.KIND.SILENT_FAILURE,
            severity: telemetry.SEVERITY.WARNING,
            context: { errno: error.code },
            error
          });
        }
      }
      watchedClips = new Set(previousClips ?? currentClips);
      logger.info(
        previousClips
          ? `Seeded watched clips from last-session snapshot (${watchedClips.size} clips)`
          : `First run: seeded all ${watchedClips.size} clips as watched`
      );
      await saveWatchedClips();
    }

    // prune deleted clips so the file doesn't grow forever
    const current = new Set(currentClips);
    const before = watchedClips.size;
    for (const name of watchedClips) {
      if (!current.has(name)) watchedClips.delete(name);
    }
    if (watchedClips.size !== before) await saveWatchedClips();

    const newClips = currentClips.filter((clipName) => !watchedClips.has(clipName));
    logger.info(`Found ${newClips.length} unwatched clips`);

    return {
      newClips,
      totalNewCount: newClips.length
    };
  } catch (error) {
    logger.error('Error getting new clips info:', error);
    return { newClips: [], totalNewCount: 0 };
  }
}

/** recording timestamp from metadata beats file creation time when available
 * @param {Function} getSettings
 * @param {string} fileName
 * @returns {Promise<Object>}
 */
async function getNewClipInfo(getSettings, fileName) {
  const settings = await getSettings();
  const filePath = path.join(settings.clipLocation, fileName);
  const metadataFolder = path.join(settings.clipLocation, ".clip_metadata");
  const datePath = path.join(metadataFolder, `${metadataSafeName(fileName)}.date`);
  const stats = await fs.stat(filePath);

  // default to file system time
  let createdAt = stats.birthtimeMs || stats.ctimeMs;

  try {
    const dateStr = await fs.readFile(datePath, "utf8");
    // ISO 8601, e.g. "2023-08-02T22:07:31+02:00"
    const recordingDate = new Date(dateStr);
    if (!isNaN(recordingDate.getTime())) {
      createdAt = recordingDate.getTime();
      logger.info(`Using recording timestamp for new clip ${fileName}: ${dateStr}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.error("Error reading date metadata for new clip:", error);
    }
  }

  const newClipInfo = {
    originalName: fileName,
    customName: path.basename(fileName, path.extname(fileName)),
    createdAt: createdAt,
    tags: []
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

/** newest first; .mp4/.avi/.mov; missing optional metadata files
 * (.customname/.trim/.date) fall back cleanly. returns [] on failure
 * @param {Function} getSettings - resolves to { clipLocation: string }
 * @returns {Promise<Array<{originalName: string, customName: string, createdAt: number, thumbnailPath: string, isTrimmed: boolean}>>}
 */
async function getClips(getSettings) {
  const settings = await getSettings();
  const clipsFolder = settings?.clipLocation;
  const metadataFolder = path.join(clipsFolder, ".clip_metadata");

  const scanStartedAt = Date.now();

  try {
    // dev profiler spans, no-op in production (global.__perf only exists in dev)
    const tScan = global.__perf?.now();
    const files = await walkClips(clipsFolder, clipsFolder);
    if (tScan != null) global.__perf.fsSpan('scan-clips-dir', tScan, global.__perf.now() - tScan, { clips: files.length });
    files.sort((a, b) => b.date.getTime() - a.date.getTime());

    const tMeta = global.__perf?.now();

    // one readdir instead of ~3 ENOENT probes per clip through the fs thread
    // pool; lowercased both sides since NTFS is case-insensitive and casing can drift
    let metadataFiles = new Set();
    try {
      metadataFiles = new Set((await fs.readdir(metadataFolder)).map((f) => f.toLowerCase()));
    } catch (error) {
      // missing folder: no metadata, Set stays empty. any other errno means
      // metadata exists but is unreadable, so every clip loses its custom name/trim flag silently
      if (error.code !== 'ENOENT') {
        telemetry.event('clip_metadata_dir_unreadable', {
          kind: telemetry.KIND.DATA_LOSS,
          severity: telemetry.SEVERITY.ERROR,
          context: { errno: error.code, clips: files.length },
          error
        });
      }
    }
    const hasMetadata = (name) => metadataFiles.has(name.toLowerCase());

    const clipInfoPromises = files
      .map(async (file) => {
        const fullPath = path.join(clipsFolder, file.name);
        // walkClips() stat'ed this file moments ago, no existence re-check

        const safeName = metadataSafeName(file.name);
        let customName = path.basename(file.name, path.extname(file.name));
        const isTrimmed = hasMetadata(`${safeName}.trim`);
        let createdAt = file.date.getTime();

        if (hasMetadata(`${safeName}.customname`)) {
          try {
            customName = await fs.readFile(path.join(metadataFolder, `${safeName}.customname`), "utf8");
          } catch (error) {
            logger.error("Error reading custom name:", error);
          }
        }

        // recording timestamp beats file mtime when present
        if (hasMetadata(`${safeName}.date`)) {
          try {
            const dateStr = await fs.readFile(path.join(metadataFolder, `${safeName}.date`), "utf8");
            // ISO 8601, e.g. "2023-08-02T22:07:31+02:00"
            const recordingDate = new Date(dateStr);
            if (!isNaN(recordingDate.getTime())) {
              createdAt = recordingDate.getTime();
            }
          } catch (error) {
            logger.error("Error reading date metadata:", error);
          }
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

    const clipInfos = (await Promise.all(clipInfoPromises)).filter(Boolean);
    if (tMeta != null) global.__perf.span('read-clip-metadata', tMeta, global.__perf.now() - tMeta, { clips: clipInfos.length });
    telemetry.metric('library_scan_ms', Date.now() - scanStartedAt, { unit: 'ms' });
    lastClipCount = clipInfos.length;
    return clipInfos;
  } catch (error) {
    logger.error("Error reading directory:", error);
    // library renders empty, which reads to the user as "no clips"
    telemetry.event('clips_scan_failed', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.ERROR,
      context: { errno: error.code },
      error
    });
    return [];
  }
}

/** mirrors walkClips' concurrent stat strategy but counts every file (video,
 * thumbnail, metadata) for the folder's real disk footprint */
async function dirSize(dir, failures = null) {
  // shared tally so one sweep reports once instead of per unreadable entry
  const failed = failures || { count: 0, errno: undefined };
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    failed.count += 1;
    if (!failed.errno) failed.errno = error.code;
    return 0;
  }
  const tasks = entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return dirSize(fullPath, failed);
    if (entry.isFile()) {
      try {
        return (await fs.stat(fullPath)).size;
      } catch (error) {
        failed.count += 1;
        if (!failed.errno) failed.errno = error.code;
        return 0;
      }
    }
    return 0;
  });
  const total = (await Promise.all(tasks)).reduce((a, b) => a + b, 0);
  if (!failures && failed.count > 0) {
    // under-reported size looks like the user freed space they still use
    telemetry.event('folder_size_underreported', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { errno_count: failed.count, errno: failed.errno }
    });
  }
  return total;
}

// cached so repeated renderer polls don't re-walk the tree; nothing needs
// this fresh, so a stale-but-cheap hit within TTL beats another sweep
let folderSizeCache = { location: null, bytes: 0, at: 0 };
const FOLDER_SIZE_TTL = 4 * 60 * 1000; // 4 min, comfortably below the 5-min poll

/** total bytes of the clip folder; recomputed at most once per TTL, cached
 * otherwise. runs in the main process, never touches renderer perf */
async function getClipsFolderSize(getSettings) {
  const settings = await getSettings();
  const clipsFolder = settings?.clipLocation;
  if (!clipsFolder) return { bytes: 0 };

  const now = Date.now();
  if (
    folderSizeCache.location === clipsFolder &&
    now - folderSizeCache.at < FOLDER_SIZE_TTL
  ) {
    return { bytes: folderSizeCache.bytes };
  }

  try {
    const bytes = await dirSize(clipsFolder);
    telemetry.metric('folder_size_ms', Date.now() - now, { unit: 'ms' });
    folderSizeCache = { location: clipsFolder, bytes, at: now };
    return { bytes };
  } catch (error) {
    logger.error('Error computing clips folder size:', error);
    // fall back to the last known value rather than flashing 0
    return { bytes: folderSizeCache.location === clipsFolder ? folderSizeCache.bytes : 0 };
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** deletes a clip and its metadata (.customname/.trim/thumbnail)
 * @param {string} clipName
 * @param {Function} getSettings
 * @param {Object} thumbnailsModule
 * @param {Object} videoPlayer
 * @returns {Promise<Object>}
 */
async function deleteClip(clipName, getSettings, thumbnailsModule, videoPlayer) {
  const settings = await getSettings();
  const clipPath = path.join(settings.clipLocation, clipName);
  const metadataFolder = path.join(settings.clipLocation, ".clip_metadata");
  const safeName = metadataSafeName(clipName);
  const customNamePath = path.join(metadataFolder, `${safeName}.customname`);
  const trimDataPath = path.join(metadataFolder, `${safeName}.trim`);
  const thumbnailPath = thumbnailsModule.generateThumbnailPath(clipPath);

  const filesToDelete = [clipPath, customNamePath, trimDataPath, thumbnailPath];

  if (videoPlayer) {
    videoPlayer.src = "";
  }

  const maxRetries = 50; // ~5s total retry time
  const retryDelay = 100; // 0.1 s between attempts

  // telemetry only: which mechanism produced the last error, and its errno
  let via = process.platform === 'win32' ? 'trash' : 'unlink';
  let retryErrno;

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      for (const file of filesToDelete) {
        try {
          if (process.platform === 'win32') {
            via = 'trash';
            await shell.trashItem(file);
          } else {
            via = 'unlink';
            await fs.unlink(file);
          }
        } catch (e) {
          if (e.code === 'ENOENT') {
            continue;
          }

          if (process.platform === 'win32') {
            try {
              via = 'unlink';
              await fs.unlink(file);
              continue;
            } catch (e2) {
              if (e2.code === 'ENOENT') {
                continue;
              }
              throw e2;
            }
          }

          // let unexpected errors reach the retry logic below
          throw e;
        }
      }

      logActivity('delete', { clipName });
      if (retry > 0) {
        // locked files cost up to ~5s of retries today with nothing reported
        telemetry.event('clip_delete_retried', {
          kind: telemetry.KIND.DEGRADED,
          severity: telemetry.SEVERITY.INFO,
          context: { retries_used: retry, errno: retryErrno },
          coalesceMs: 600000
        });
      }
      return { success: true };
    } catch (error) {
      if ((error.code === "EBUSY" || error.code === "EPERM") && retry < maxRetries - 1) {
        retryErrno = error.code;
        await delay(retryDelay);
      } else {
        logger.error(`Error deleting clip ${clipName}:`, error);
        telemetry.event('clip_delete_failed', {
          kind: telemetry.KIND.ERROR,
          severity: telemetry.SEVERITY.ERROR,
          context: { errno: error.code, retries_used: retry, via },
          error
        });
        return { success: false, error: error.message };
      }
    }
  }

  return {
    success: false,
    error: "Failed to delete clip after multiple attempts. The file may be in use.",
  };
}

/**
 * @param {string} clipName
 * @param {Function} getSettings
 * @returns {Promise<Object>}
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

/** count from the last successful getClips(), no rescan
 * @returns {number|null} null if none yet
 */
function getLastClipCount() {
  return lastClipCount;
}

module.exports = {
  saveCurrentClipList,
  getNewClipsInfo,
  markClipsWatched,
  getNewClipInfo,
  startPeriodicSave,
  stopPeriodicSave,
  getClips,
  getLastClipCount,
  getClipsFolderSize,
  deleteClip,
  revealClip
};
