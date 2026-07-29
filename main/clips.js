// Imports
const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const telemetry = require('./telemetry');
const thumbnailsModule = require('./thumbnails');
const { logActivity } = require('../utils/activity-tracker');

// Supported video extensions
const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mov']);

// Size of the library as of the last successful getClips(). Kept so callers
// that only need the count (telemetry) never trigger another tree walk.
// null means "no successful scan yet this session".
let lastClipCount = null;

/**
 * Recursively walk a directory and collect video files with their relative paths.
 * Skips directories starting with '.' (like .clip_metadata) and 'icons'.
 * @param {string} dir - Current directory to scan
 * @param {string} baseDir - Root clip directory (for computing relative paths)
 * @param {number} [depth] - Recursion depth, for telemetry only
 * @param {object} [statFailures] - Shared stat-failure tally; only the
 *        top-level call reports it, so one walk emits one event.
 * @returns {Promise<Array<{name: string, date: Date}>>} Array of clip entries
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

  // Stat files and recurse into subdirectories concurrently — a sequential
  // await-per-file walk costs ~180µs × N clips (366ms at 2,000 clips).
  const tasks = entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'icons') return [];
      return walkClips(fullPath, baseDir, depth + 1, dropped);
    }
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) {
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        try {
          const stats = await fs.stat(fullPath);
          return [{ name: relativePath, date: stats.mtime }];
        } catch (error) {
          logger.error(`Error reading stats for ${fullPath}:`, error);
          // Tallied, not reported per file: one bad drive drops thousands.
          dropped.count += 1;
          if (!dropped.errno) dropped.errno = error.code;
        }
      }
    }
    return [];
  });
  const clips = (await Promise.all(tasks)).flat();
  if (!statFailures && dropped.count > 0) {
    telemetry.event('clip_stat_dropped', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { errno: dropped.errno, count: dropped.count }
    });
  }
  return clips;
}

/**
 * Convert a clip's relative path (originalName) into a flat filename
 * safe for use as a metadata file key in .clip_metadata/.
 * e.g., "highlights/gameplay.mp4" -> "highlights--gameplay.mp4"
 * Root clips like "gameplay.mp4" are returned unchanged.
 */
function metadataSafeName(clipName) {
  return clipName.replace(/\//g, '--');
}

// Module state
let periodicSaveInterval = null;

/**
 * Path to the last-clips snapshot file.
 */
function getLastClipsFilePath() {
  return path.join(app.getPath('userData'), 'last-clips.json');
}

/**
 * Snapshot the current clip list for next-session comparison.
 */
async function saveCurrentClipList(getSettings) {
  const LAST_CLIPS_FILE = getLastClipsFilePath();
  // Which step we died on, for telemetry only.
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
      // Ignore cleanup errors
    }
  }
}

/**
 * Path to the watched-clips file: the set of clips the user has ever opened
 * in the player. A clip is "new" until it appears in this set.
 */
function getWatchedClipsFilePath() {
  return path.join(app.getPath('userData'), 'watched-clips.json');
}

// In-memory watched set, loaded once per process. null = not loaded yet.
let watchedClips = null;

/**
 * Load the watched set from disk into `watchedClips`.
 * Returns false when the file doesn't exist yet (pre-migration installs).
 */
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
      // Every clip in the library gets re-flagged as new after this.
      telemetry.event('watched_clips_reset', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.ERROR,
        context: {
          // The in-memory set is always empty here (we only get this far when
          // it has not been loaded yet); file_bytes carries the real magnitude.
          prior_size: watchedClips ? watchedClips.size : 0,
          file_bytes: data == null ? 0 : Buffer.byteLength(data, 'utf8'),
          errno: error.code
        },
        error
      });
      // Unreadable/corrupt: start over rather than flagging the whole library.
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
      // Ignore cleanup errors
    }
  }
}

/**
 * Record that clips were opened in the player, so they stop counting as new.
 */
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

/**
 * "New" clips = clips on disk the user has never opened in the player.
 *
 * Migration: installs that predate watched tracking only have the old
 * last-clips.json session snapshot. Its contents seed the watched set —
 * anything that wasn't "new since last session" under the old scheme is
 * treated as already watched, so highlights carry over unchanged. With
 * neither file (true first run) the whole library is seeded as watched.
 */
async function getNewClipsInfo(getSettings) {
  try {
    const settings = await getSettings();
    const clipsFolder = settings?.clipLocation;
    if (!clipsFolder) return { newClips: [], totalNewCount: 0 };

    const files = await walkClips(clipsFolder, clipsFolder);
    const currentClips = files.map((file) => file.name);

    if (!(await loadWatchedClips())) {
      let previousClips = null;
      try {
        const data = await fs.readFile(getLastClipsFilePath(), 'utf8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed.clips)) previousClips = parsed.clips;
      } catch (error) {
        // Missing/corrupt snapshot -> treat as first run below. A missing file
        // is the normal pre-migration case; anything else lost the seed.
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

    // Prune deleted clips so the file doesn't grow forever.
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
  const datePath = path.join(metadataFolder, `${metadataSafeName(fileName)}.date`);
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

  const scanStartedAt = Date.now();

  try {
    // Dev profiler spans (no-op in production — global.__perf only exists in dev).
    const tScan = global.__perf?.now();
    const files = await walkClips(clipsFolder, clipsFolder);
    if (tScan != null) global.__perf.fsSpan('scan-clips-dir', tScan, global.__perf.now() - tScan, { clips: files.length });
    // Sort by date descending (newest first)
    files.sort((a, b) => b.date.getTime() - a.date.getTime());

    const tMeta = global.__perf?.now();

    // One readdir of .clip_metadata instead of ~3 existence probes per clip:
    // most clips have no .customname/.trim/.date file, so probing costs
    // thousands of ENOENT round-trips through the fs thread pool for nothing.
    // Lowercased on both sides: NTFS is case-insensitive, so a clip whose
    // on-disk casing drifted from its metadata file's casing must still match
    // (the old fs.access probes were case-insensitive too).
    let metadataFiles = new Set();
    try {
      metadataFiles = new Set((await fs.readdir(metadataFolder)).map((f) => f.toLowerCase()));
    } catch (error) {
      // Folder missing -> no metadata exists; the Set stays empty. Any other
      // errno means the metadata is there but unreadable, so every clip in the
      // library silently loses its custom name and trim flag.
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
        // walkClips() stat'ed this file moments ago — no existence re-check.

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

        // Recording timestamp beats file mtime when present.
        if (hasMetadata(`${safeName}.date`)) {
          try {
            const dateStr = await fs.readFile(path.join(metadataFolder, `${safeName}.date`), "utf8");
            // Parse ISO 8601 date string (e.g., "2023-08-02T22:07:31+02:00")
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

    const clipInfos = (await Promise.all(clipInfoPromises)).filter(Boolean); // Remove null entries
    if (tMeta != null) global.__perf.span('read-clip-metadata', tMeta, global.__perf.now() - tMeta, { clips: clipInfos.length });
    telemetry.metric('library_scan_ms', Date.now() - scanStartedAt, { unit: 'ms' });
    lastClipCount = clipInfos.length;
    return clipInfos;
  } catch (error) {
    logger.error("Error reading directory:", error);
    // The library renders empty, which reads to the user as "no clips".
    telemetry.event('clips_scan_failed', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.ERROR,
      context: { errno: error.code },
      error
    });
    return [];
  }
}

/**
 * Recursively sum the byte size of every file under `dir`. Mirrors walkClips'
 * concurrent stat strategy but counts ALL files (videos, thumbnails, metadata)
 * so the total reflects the folder's real disk footprint.
 */
async function dirSize(dir, failures = null) {
  // Shared tally so one sweep reports once instead of per unreadable entry.
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
    // Under-reported size looks like the user freed space they still use.
    telemetry.event('folder_size_underreported', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { errno_count: failed.count, errno: failed.errno }
    });
  }
  return total;
}

// Cached folder-size result so repeated renderer polls don't re-walk the tree.
// Nothing depends on this value being fresh, so a stale-but-cheap hit within
// the TTL is preferred over another full stat sweep.
let folderSizeCache = { location: null, bytes: 0, at: 0 };
const FOLDER_SIZE_TTL = 4 * 60 * 1000; // 4 min — comfortably below the 5-min poll.

/**
 * Total disk usage (bytes) of the configured clip folder. Recomputed at most
 * once per TTL; returns the cached value instantly otherwise. Runs entirely in
 * the main process off the UI thread, so it never touches renderer perf.
 */
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
    // Fall back to the last known value rather than flashing 0.
    return { bytes: folderSizeCache.location === clipsFolder ? folderSizeCache.bytes : 0 };
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
  const safeName = metadataSafeName(clipName);
  const customNamePath = path.join(metadataFolder, `${safeName}.customname`);
  const trimDataPath = path.join(metadataFolder, `${safeName}.trim`);
  const thumbnailPath = thumbnailsModule.generateThumbnailPath(clipPath);

  const filesToDelete = [clipPath, customNamePath, trimDataPath, thumbnailPath];

  if (videoPlayer) {
    videoPlayer.src = "";
  }

  const maxRetries = 50; // Up to ~5 seconds total retry time
  const retryDelay = 100; // 0.1 s between attempts

  // Telemetry only: which mechanism produced the last error, and its errno.
  let via = process.platform === 'win32' ? 'trash' : 'unlink';
  let retryErrno;

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      // Try deleting immediately; we'll retry quickly if the file is still busy.
      for (const file of filesToDelete) {
        try {
          if (process.platform === 'win32') {
            // Move the file to the Recycle Bin for a more native deletion behaviour
            via = 'trash';
            await shell.trashItem(file);
          } else {
            // Fallback for non-Windows platforms (should not be hit in our use-case)
            via = 'unlink';
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

          // Throw other unexpected errors so the retry logic can handle them
          throw e;
        }
      }

      // Log deletion activity
      logActivity('delete', { clipName });
      if (retry > 0) {
        // Locked files cost up to ~5s of retries today with nothing reported.
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
        // If the file is busy and we haven't reached max retries, wait and try again
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

/**
 * Clip count from the last successful getClips(), without rescanning.
 * @returns {number|null} null when no scan has succeeded yet.
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
