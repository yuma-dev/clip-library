/** .clip_metadata file I/O: atomic writes, read/write for names, trim, speed,
 * volume, volume range, tags. */
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const telemetry = require('./telemetry');
const { logActivity } = require('../utils/activity-tracker');

// file utilities

/**
 * telemetry kind from file extension; the filename (with clip name) never leaves this process
 * @param {string} filePath
 * @returns {string} trim|tags|custom_name|speed|volume|volume_range|track_state|track_prefs|gameinfo|other
 */
function metadataKind(filePath) {
  const base = filePath.endsWith('.tmp') ? filePath.slice(0, -4) : filePath;
  switch (path.extname(base).toLowerCase()) {
    case '.trim': return 'trim';
    case '.tags': return 'tags';
    case '.customname': return 'custom_name';
    case '.speed': return 'speed';
    case '.volume': return 'volume';
    case '.volumerange': return 'volume_range';
    case '.trackstate': return 'track_state';
    case '.gameinfo': return 'gameinfo';
    // trackPreferences.json is the only .json written through this path.
    case '.json': return 'track_prefs';
    default: return 'other';
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

async function writeFileWithRetry(filePath, data, retries = 4) {
  const startedAt = Date.now();
  let retryErrno;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await fs.writeFile(filePath, data, { flag: 'w' });
      if (attempt > 0) {
        // AV pressure costing retries on every save is invisible without this.
        telemetry.event('metadata_write_retried', {
          kind: telemetry.KIND.DEGRADED,
          severity: telemetry.SEVERITY.INFO,
          context: {
            attempts: attempt + 1,
            errno: retryErrno,
            total_ms: Date.now() - startedAt,
            kind: metadataKind(filePath)
          },
          coalesceMs: 600000
        });
      }
      return;
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        retryErrno = error.code;
        if (attempt === retries - 1) {
          telemetry.event('metadata_write_retry_exhausted', {
            kind: telemetry.KIND.ERROR,
            severity: telemetry.SEVERITY.ERROR,
            context: { attempts: retries, errno: error.code, kind: metadataKind(filePath) },
            error
          });
          throw error;
        }
        // 25/50/100ms backoff, tolerates AV holds to ~175ms; old flat 100ms
        // sleep put a visible floor under every metadata save
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
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
    await fs.mkdir(dir, { recursive: true });
    await writeFileWithRetry(tempPath, data);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    logger.error(`Error in writeFileAtomically: ${error.message}`);
    // The fallback write is not atomic: a crash mid-write truncates the file.
    telemetry.event('metadata_atomic_fallback', {
      kind: telemetry.KIND.DATA_LOSS,
      severity: telemetry.SEVERITY.WARNING,
      context: { errno: error.code, kind: metadataKind(filePath) },
      error
    });
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

function getMetadataFolder(clipLocation) {
  return path.join(clipLocation, '.clip_metadata');
}

// flat filename key for .clip_metadata/: e.g. highlights/gameplay.mp4 becomes
// highlights--gameplay.mp4; root clips pass through unchanged
function metadataSafeName(clipName) {
  return clipName.replace(/\//g, '--');
}

// custom name

async function saveCustomName(clipName, customName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const customNameFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.customname`);

  // no-op guard: title flushes on every nav/close, so most calls are unchanged.
  // read is ~100x cheaper than the atomic write (AV-scan retry penalty on Windows)
  try {
    const existing = await fs.readFile(customNameFilePath, 'utf8');
    if (existing === customName) return;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // default name (no extension) with nothing stored yet: nothing to persist
      const defaultName = path.basename(clipName, path.extname(clipName));
      if (customName === defaultName) return;
    }
  }

  await ensureDirectoryExists(metadataFolder);
  try {
    await writeFileAtomically(customNameFilePath, customName);
    logger.info(`Custom name saved successfully for ${clipName}`);
    logActivity('rename', { originalName: clipName, newCustomName: customName });
  } catch (error) {
    logger.error(`Error saving custom name for ${clipName}:`, error);
    throw error;
  }
}

async function getCustomName(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const customNameFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.customname`);

  try {
    return await fs.readFile(customNameFilePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// trim data

async function saveTrimData(clipName, trimData, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  await ensureDirectoryExists(metadataFolder);

  const trimFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.trim`);
  try {
    await writeFileAtomically(trimFilePath, JSON.stringify(trimData));
    logger.info(`Trim data saved successfully for ${clipName}`);
    logActivity('trim', { clipName, start: trimData.start, end: trimData.end });
  } catch (error) {
    logger.error(`Error saving trim data for ${clipName}:`, error);
    throw error;
  }
}

async function getTrimData(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const trimFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.trim`);

  let trimData;
  try {
    trimData = await fs.readFile(trimFilePath, 'utf8');
    return JSON.parse(trimData);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // read worked, parse failed: trim points are gone
    if (trimData !== undefined) {
      telemetry.event('metadata_parse_failed', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.ERROR,
        context: { kind: 'trim', file_bytes: Buffer.byteLength(trimData, 'utf8') }
      });
    }
    throw error;
  }
}

async function deleteTrimData(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const trimFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.trim`);

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

// speed

async function saveSpeed(clipName, speed, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  await ensureDirectoryExists(metadataFolder);
  const speedFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.speed`);

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

async function getSpeed(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const speedFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.speed`);

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

// volume

async function saveVolume(clipName, volume, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  await ensureDirectoryExists(metadataFolder);
  const volumeFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.volume`);

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

async function getVolume(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const volumeFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.volume`);

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

/** drops the custom level so loudness matching takes over again */
async function deleteVolume(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const volumeFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.volume`);
  try {
    await fs.unlink(volumeFilePath);
    logActivity('volume_reset', { clipName });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// per-track audio state (multi-track playback)

/**
 * @param {string} clipName
 * @param {object} trackState - { tracks: { [ordinal]: { volume, muted, name } } }
 */
async function saveTrackState(clipName, trackState, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  await ensureDirectoryExists(metadataFolder);
  const filePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.trackstate`);
  try {
    await writeFileAtomically(filePath, JSON.stringify(trackState || { tracks: {} }));
    return { success: true };
  } catch (error) {
    logger.error(`Error saving track state for ${clipName}:`, error);
    return { success: false, error: error.message };
  }
}

// track prefs keyed by name: color+hidden shared across clips, volume stays per-clip.
// stored at userData/trackPreferences.json; cached since only this module writes it
let trackPrefsCache = null;

async function getTrackPreferences(getAppPath) {
  if (trackPrefsCache) return trackPrefsCache;
  let raw;
  try {
    const prefsPath = path.join(getAppPath('userData'), 'trackPreferences.json');
    raw = await fs.readFile(prefsPath, 'utf8');
    const parsed = JSON.parse(raw);
    trackPrefsCache = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (error) {
    if (error.code !== 'ENOENT') logger.error('Error reading track preferences:', error);
    // Every track colour and hidden flag the user set is gone, and the next
    // save writes the empty cache back over the file.
    if (raw !== undefined) {
      telemetry.event('metadata_parse_failed', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.ERROR,
        context: { kind: 'track_prefs', file_bytes: Buffer.byteLength(raw, 'utf8') }
      });
    }
    trackPrefsCache = {};
  }
  return trackPrefsCache;
}

async function saveTrackPreferences(trackName, patch, getAppPath) {
  try {
    const prefsPath = path.join(getAppPath('userData'), 'trackPreferences.json');
    const existing = { ...(await getTrackPreferences(getAppPath)) };
    const current = existing[trackName] || {};
    const next = { ...current, ...(patch || {}) };
    Object.keys(next).forEach((k) => { if (next[k] == null) delete next[k]; });
    if (Object.keys(next).length === 0) {
      delete existing[trackName];
    } else {
      existing[trackName] = next;
    }
    await writeFileAtomically(prefsPath, JSON.stringify(existing));
    trackPrefsCache = existing;
    return { success: true };
  } catch (error) {
    logger.error(`Error saving track preferences for ${trackName}:`, error);
    return { success: false, error: error.message };
  }
}

async function getTrackState(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const filePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.trackstate`);
  let data;
  try {
    data = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && parsed.tracks && typeof parsed.tracks === 'object') {
      return parsed;
    }
    return { tracks: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { tracks: {} };
    logger.error(`Error reading track state for ${clipName}:`, error);
    // volumes/mutes fall back to defaults; next save overwrites the bad file
    if (data !== undefined) {
      telemetry.event('metadata_parse_failed', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.ERROR,
        context: { kind: 'track_state', file_bytes: Buffer.byteLength(data, 'utf8') }
      });
    }
    return { tracks: {} };
  }
}

// volume range

async function saveVolumeRange(clipName, volumeData, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const volumeRangeFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.volumerange`);

  // null = remove range: delete file instead of writing literal "null".
  // player used to call this on every clip open even with nothing to remove
  if (volumeData == null) {
    try {
      await fs.unlink(volumeRangeFilePath);
      logger.info(`Volume range data removed for ${clipName}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`Error removing volume range for ${clipName}:`, error);
        return { success: false, error: error.message };
      }
    }
    return { success: true };
  }

  try {
    await writeFileAtomically(volumeRangeFilePath, JSON.stringify(volumeData));
    logger.info(`Volume range data saved successfully for ${clipName}`);
    return { success: true };
  } catch (error) {
    logger.error(`Error saving volume range for ${clipName}:`, error);
    return { success: false, error: error.message };
  }
}

async function getVolumeRange(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const volumeRangeFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.volumerange`);

  let volumeData;
  try {
    volumeData = await fs.readFile(volumeRangeFilePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    logger.error(`Error reading volume range for ${clipName}:`, error);
    throw error;
  }

  try {
    return JSON.parse(volumeData);
  } catch {
    // self-heal: opens no longer overwrite this file, so delete it here.
    // record what we destroyed since it's the user's data
    logger.error(`Corrupt volume range file for ${clipName}; removing it`);
    telemetry.event('volume_range_self_deleted', {
      kind: telemetry.KIND.DATA_LOSS,
      severity: telemetry.SEVERITY.WARNING,
      context: { file_bytes: Buffer.byteLength(volumeData, 'utf8') }
    });
    await fs.unlink(volumeRangeFilePath).catch(() => {});
    return null;
  }
}

// clip tags

async function getClipTags(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const tagsFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.tags`);

  let tagsData;
  try {
    tagsData = await fs.readFile(tagsFilePath, 'utf8');
    return JSON.parse(tagsData);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    logger.error('Error reading tags:', error);
    // Returning [] means the next save persists an empty tag list over the file.
    // Counts only here: tag text never leaves the machine.
    telemetry.event('tags_lost_on_parse', {
      kind: telemetry.KIND.DATA_LOSS,
      severity: telemetry.SEVERITY.ERROR,
      context: {
        file_bytes: tagsData !== undefined ? Buffer.byteLength(tagsData, 'utf8') : undefined,
        errno: error.code
      }
    });
    return [];
  }
}

/**
 * bounded-concurrency async map; unbounded fan-out made per-clip IPC average 70ms+/call
 * @param {Array} items
 * @param {number} limit - max in-flight
 * @param {Function} mapper - async (item) => result
 * @returns {Promise<Array>} results in input order
 */
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await mapper(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * @param {string[]} clipNames
 * @param {Function} getSettings
 * @returns {Promise<Object<string, string[]>>} clipName to tags (missing file: empty array)
 */
async function getClipTagsBatch(clipNames, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const names = Array.isArray(clipNames) ? clipNames : [];

  const entries = await mapWithConcurrency(names, 32, async (clipName) => {
    const tagsFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.tags`);
    let tagsData;
    try {
      tagsData = await fs.readFile(tagsFilePath, 'utf8');
      const parsed = JSON.parse(tagsData);
      return [clipName, Array.isArray(parsed) ? parsed : []];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Error reading tags:', error);
        // same loss as single-clip path; coalesced to one event per bad batch
        telemetry.event('tags_lost_on_parse', {
          kind: telemetry.KIND.DATA_LOSS,
          severity: telemetry.SEVERITY.ERROR,
          context: {
            file_bytes: tagsData !== undefined ? Buffer.byteLength(tagsData, 'utf8') : undefined,
            errno: error.code,
            batch_size: names.length
          }
        });
      }
      return [clipName, []];
    }
  });
  return Object.fromEntries(entries);
}

async function saveClipTags(clipName, tags, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const tagsFilePath = path.join(metadataFolder, `${metadataSafeName(clipName)}.tags`);

  try {
    await fs.writeFile(tagsFilePath, JSON.stringify(tags));
    logActivity('tags_update_clip', { clipName, tags });
    return { success: true };
  } catch (error) {
    logger.error('Error saving tags:', error);
    return { success: false, error: error.message };
  }
}

// global tags

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

async function removeTagFromAllClips(tagToRemove, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);

  let modifiedCount = 0;
  let scannedCount = 0;
  let failedCount = 0;

  try {
    const files = await fs.readdir(metadataFolder);
    const tagFiles = files.filter(file => file.endsWith('.tags'));
    scannedCount = tagFiles.length;

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
        failedCount++;
      }
    }
  } catch (error) {
    logger.info('No metadata folder found or couldn\'t read it');
    // missing folder is normal; any other error means nothing ran but success is still reported
    if (error.code !== 'ENOENT') {
      telemetry.event('tag_migration_partial', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.ERROR,
        context: { scanned: 0, modified: 0, failed: 0, op: 'remove', errno: error.code },
        error
      });
    }
    return { success: true, modifiedCount: 0 };
  }

  // skipped files keep the deleted tag while the UI reports success
  if (failedCount > 0) {
    telemetry.event('tag_migration_partial', {
      kind: telemetry.KIND.DATA_LOSS,
      severity: telemetry.SEVERITY.ERROR,
      context: { scanned: scannedCount, modified: modifiedCount, failed: failedCount, op: 'remove' }
    });
  }

  logger.info(`Tag deletion completed: modified ${modifiedCount} files`);
  return { success: true, modifiedCount };
}

async function updateTagInAllClips(oldTag, newTag, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);

  let modifiedCount = 0;
  let scannedCount = 0;
  let failedCount = 0;

  try {
    const files = await fs.readdir(metadataFolder);
    const tagFiles = files.filter(file => file.endsWith('.tags'));
    scannedCount = tagFiles.length;

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
        failedCount++;
      }
    }
  } catch (error) {
    logger.info('No metadata folder found or couldn\'t read it');
    // missing folder is normal; any other error means nothing ran but success is still reported
    if (error.code !== 'ENOENT') {
      telemetry.event('tag_migration_partial', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.ERROR,
        context: { scanned: 0, modified: 0, failed: 0, op: 'update', errno: error.code },
        error
      });
    }
    return { success: true, modifiedCount: 0 };
  }

  // skipped files keep the old tag name while the UI reports success
  if (failedCount > 0) {
    telemetry.event('tag_migration_partial', {
      kind: telemetry.KIND.DATA_LOSS,
      severity: telemetry.SEVERITY.ERROR,
      context: { scanned: scannedCount, modified: modifiedCount, failed: failedCount, op: 'update' }
    });
  }

  logger.info(`Tag update completed: modified ${modifiedCount} files`);
  return { success: true, modifiedCount };
}

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

// game info (read-only for now)

async function getGameIcon(clipName, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const gameInfoPath = path.join(metadataFolder, `${metadataSafeName(clipName)}.gameinfo`);

  let raw;
  try {
    raw = await fs.readFile(gameInfoPath, 'utf8');
  } catch (error) {
    // Most clips simply have no .gameinfo; only a real read error is a signal.
    if (error.code !== 'ENOENT') {
      telemetry.event('gameinfo_unreadable', {
        kind: telemetry.KIND.SILENT_FAILURE,
        severity: telemetry.SEVERITY.WARNING,
        context: { count: 1, batch_size: 1, stage: 'single', errno: error.code },
        coalesceMs: 600000
      });
    }
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    telemetry.event('gameinfo_unreadable', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { count: 1, batch_size: 1, stage: 'single_parse' },
      coalesceMs: 600000
    });
    return null;
  }

  const response = { path: null, title: parsed.window_title || null, discord: normalizeDiscordInfo(parsed.discord) };

  if (parsed.icon_file) {
    const iconPath = path.join(settings.clipLocation, 'icons', parsed.icon_file);
    try {
      await fs.access(iconPath);
      response.path = iconPath;
    } catch {
      // icon missing: leave null
      telemetry.event('gameinfo_unreadable', {
        kind: telemetry.KIND.SILENT_FAILURE,
        severity: telemetry.SEVERITY.WARNING,
        context: { count: 1, batch_size: 1, stage: 'single_icon' },
        coalesceMs: 600000
      });
    }
  }

  return response;
}

/**
 * normalizes the recorder's `discord` block in .gameinfo (channel + call participants)
 * @param {any} raw
 * @returns {object|null} { channel_id, channel_name, guild_id, participants[] } or null
 */
function normalizeDiscordInfo(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.participants)) return null;

  const participants = raw.participants
    .filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id)
    .map((p) => ({
      id: p.id,
      username: typeof p.username === 'string' ? p.username : '',
      global_name: typeof p.global_name === 'string' ? p.global_name : null,
      nick: typeof p.nick === 'string' ? p.nick : null,
      bot: p.bot === true,
      avatar_url: typeof p.avatar_url === 'string' ? p.avatar_url : null
    }));
  if (participants.length === 0) return null;

  return {
    channel_id: typeof raw.channel_id === 'string' ? raw.channel_id : null,
    channel_name: typeof raw.channel_name === 'string' ? raw.channel_name : null,
    guild_id: typeof raw.guild_id === 'string' ? raw.guild_id : null,
    participants
  };
}

/**
 * icon existence checks deduped per icon path (few distinct games, many clips)
 * @param {string[]} clipNames
 * @param {Function} getSettings
 * @returns {Promise<Object<string, {path: string|null, title: string|null}|null>>}
 */
async function getGameIconsBatch(clipNames, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const names = Array.isArray(clipNames) ? clipNames : [];

  // iconPath to Promise<boolean> (exists), shared across the batch
  const iconExists = new Map();
  const checkIcon = (iconPath) => {
    let pending = iconExists.get(iconPath);
    if (!pending) {
      pending = fs.access(iconPath).then(() => true, () => false);
      iconExists.set(iconPath, pending);
    }
    return pending;
  };

  // Tallied across the batch: a broken library would otherwise emit per clip.
  let unreadable = 0;
  let iconsMissing = 0;

  const entries = await mapWithConcurrency(names, 32, async (clipName) => {
    const gameInfoPath = path.join(metadataFolder, `${metadataSafeName(clipName)}.gameinfo`);

    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(gameInfoPath, 'utf8'));
    } catch (error) {
      // no .gameinfo is normal for most clips
      if (error.code !== 'ENOENT') unreadable += 1;
      return [clipName, null];
    }

    const response = { path: null, title: parsed.window_title || null, discord: normalizeDiscordInfo(parsed.discord) };
    if (parsed.icon_file) {
      const iconPath = path.join(settings.clipLocation, 'icons', parsed.icon_file);
      if (await checkIcon(iconPath)) response.path = iconPath;
      else iconsMissing += 1;
    }
    return [clipName, response];
  });

  if (unreadable > 0 || iconsMissing > 0) {
    telemetry.event('gameinfo_unreadable', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: {
        count: unreadable,
        icons_missing: iconsMissing,
        batch_size: names.length,
        stage: 'icons'
      },
      coalesceMs: 600000
    });
  }
  return Object.fromEntries(entries);
}

/**
 * every human Discord participant across the clips' .gameinfo, for @mention search.
 * Newest snapshot per id wins (renamed user shows current name); bots dropped.
 * @param {string[]} clipNames
 * @param {Function} getSettings
 * @returns {Promise<{ people: object[], byClip: Object<string,string[]> }>}
 */
async function getClipParticipants(clipNames, getSettings) {
  const settings = await getSettings();
  const metadataFolder = getMetadataFolder(settings.clipLocation);
  const names = Array.isArray(clipNames) ? clipNames : [];

  // id to { at, participant, count }; at = newest clip mtime seen for the id
  const people = new Map();
  const byClip = {};
  let unreadable = 0;

  await mapWithConcurrency(names, 32, async (clipName) => {
    const gameInfoPath = path.join(metadataFolder, `${metadataSafeName(clipName)}.gameinfo`);

    let raw;
    let mtime = 0;
    try {
      raw = await fs.readFile(gameInfoPath, 'utf8');
      // mtime stands in for record time, avoids threading createdAt through IPC
      mtime = (await fs.stat(gameInfoPath).catch(() => null))?.mtimeMs ?? 0;
    } catch (error) {
      // no .gameinfo is normal for most clips
      if (error.code !== 'ENOENT') unreadable += 1;
      return;
    }

    let discord;
    try {
      discord = normalizeDiscordInfo(JSON.parse(raw).discord);
    } catch {
      unreadable += 1;
      return;
    }
    if (!discord) return;

    const ids = [];
    for (const p of discord.participants) {
      if (p.bot) continue;
      ids.push(p.id);
      const existing = people.get(p.id);
      if (!existing) {
        people.set(p.id, { at: mtime, participant: p, count: 1 });
      } else {
        existing.count += 1;
        if (mtime >= existing.at) {
          existing.at = mtime;
          existing.participant = p;
        }
      }
    }
    if (ids.length > 0) byClip[clipName] = ids;
  });

  if (unreadable > 0) {
    // these clips drop out of @mention search silently
    telemetry.event('gameinfo_unreadable', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { count: unreadable, batch_size: names.length, stage: 'participants' },
      coalesceMs: 600000
    });
  }

  const list = [...people.values()]
    .sort((a, b) => b.count - a.count)
    .map(({ participant, count }) => ({ ...participant, count }));

  return { people: list, byClip };
}

// tag preferences

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
  deleteVolume,

  // Volume range
  saveVolumeRange,
  getVolumeRange,

  // Per-track audio state
  saveTrackState,
  getTrackState,

  // Global per-device track preferences (color, hidden)
  getTrackPreferences,
  saveTrackPreferences,

  // Clip tags
  getClipTags,
  getClipTagsBatch,
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
  getGameIcon,
  getGameIconsBatch,
  getClipParticipants
};
