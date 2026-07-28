const path = require('path');
const fs = require('fs').promises;
const { app } = require('electron');
const logger = require('../utils/logger');

// Everything here is best-effort housekeeping for userData files that
// otherwise accumulate forever. Age thresholds are deliberately generous:
// these files only matter for post-mortem debugging, and anything older
// than a month has lost that value.
const MAX_AGE_DAYS = 30;

async function pruneByAge(dir, matches, label) {
  let removed = 0;
  try {
    const files = await fs.readdir(dir);
    const now = Date.now();

    for (const file of files) {
      if (!matches(file)) continue;

      const filePath = path.join(dir, file);
      try {
        const stats = await fs.stat(filePath);
        const daysOld = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24);
        if (daysOld > MAX_AGE_DAYS) {
          await fs.unlink(filePath);
          removed++;
        }
      } catch (_) {
        // Skip files we can't stat or delete; never fail the sweep.
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(`Storage maintenance: failed to prune ${label}: ${error.message}`);
    }
  }
  return removed;
}

// Prune stale userData accumulations:
//  - settings.json.backup-<epoch> written on corrupt settings parses
//  - diagnostics/diagnostics-*.zip bundles generated without an explicit
//    save path (the save-dialog flow writes elsewhere and isn't touched)
async function run() {
  const userDataPath = app.getPath('userData');

  const settingsBackups = await pruneByAge(
    userDataPath,
    (file) => /^settings\.json\.backup-\d+$/.test(file),
    'settings backups'
  );

  const diagnosticsZips = await pruneByAge(
    path.join(userDataPath, 'diagnostics'),
    (file) => /^diagnostics-.*\.zip$/.test(file),
    'diagnostics bundles'
  );

  const total = settingsBackups + diagnosticsZips;
  if (total > 0) {
    logger.info(
      `Storage maintenance: removed ${settingsBackups} old settings backup(s), ${diagnosticsZips} old diagnostics bundle(s)`
    );
  }
}

module.exports = { run };
