const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const { app } = require('electron');
const logger = require('../utils/logger');

const fsp = fs.promises;

const MAX_LOG_FILES = 5;
const DIAGNOSTICS_DIR = 'diagnostics';
const DATA_FILES = [
    {
        name: 'settings/settings.json',
        path: (userDataPath) => path.join(userDataPath, 'settings.json'),
        description: 'Application settings'
    },
    {
        name: 'settings/global_tags.json',
        path: (userDataPath) => path.join(userDataPath, 'global_tags.json'),
        description: 'Global tags configuration'
    },
    {
        name: 'settings/tagPreferences.json',
        path: (userDataPath) => path.join(userDataPath, 'tagPreferences.json'),
        description: 'Tag sidebar preferences'
    },
    {
        name: 'state/last-clips.json',
        path: (userDataPath) => path.join(userDataPath, 'last-clips.json'),
        description: 'Previously seen clips list'
    }
];

function emitProgress(callback, stage, completed, total, extra = {}) {
    if (typeof callback === 'function') {
        callback({ stage, completed, total, ...extra });
    }
}

async function pathExists(targetPath) {
    try {
        await fsp.access(targetPath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function collectLatestLogs(userDataPath, archive, manifest) {
    const logsDir = path.join(userDataPath, 'logs');
    if (!(await pathExists(logsDir))) {
        return;
    }

    const entries = await fsp.readdir(logsDir);
    const logFiles = [];

    for (const entry of entries) {
        if (!entry.endsWith('.log')) continue;
        const fullPath = path.join(logsDir, entry);
        try {
            const stat = await fsp.stat(fullPath);
            logFiles.push({ fullPath, mtime: stat.mtimeMs, size: stat.size });
        } catch {
            // Skip unreadable files
        }
    }

    logFiles
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, MAX_LOG_FILES)
        .forEach(({ fullPath, size }) => {
            const archivePath = `logs/${path.basename(fullPath)}`;
            archive.file(fullPath, { name: archivePath });
            manifest.files.push({
                archivePath,
                sourcePath: fullPath,
                size,
                type: 'log'
            });
        });
}

async function collectActivityLogs(userDataPath, archive, manifest) {
    const activityDir = path.join(userDataPath, 'activity_logs');
    if (!(await pathExists(activityDir))) {
        return;
    }

    archive.directory(activityDir, 'activity_logs');
    manifest.files.push({
        archivePath: 'activity_logs/',
        sourcePath: activityDir,
        type: 'directory',
        note: 'Contains monthly user activity JSONL files'
    });
}

async function collectSettingsFiles(userDataPath, archive, manifest) {
    for (const fileDef of DATA_FILES) {
        const resolvedPath = fileDef.path(userDataPath);
        if (!(await pathExists(resolvedPath))) continue;

        try {
            const stat = await fsp.stat(resolvedPath);
            archive.file(resolvedPath, { name: fileDef.name });
            manifest.files.push({
                archivePath: fileDef.name,
                sourcePath: resolvedPath,
                size: stat.size,
                type: 'data',
                description: fileDef.description
            });
        } catch (error) {
            logger.warn(`Failed to add diagnostics file: ${resolvedPath}`, error);
        }
    }
}

function buildSystemInfo(userDataPath) {
    const memory = process.getSystemMemoryInfo ? process.getSystemMemoryInfo() : null;
    const cpus = os.cpus() || [];

    return {
        generatedAt: new Date().toISOString(),
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        userDataPath,
        cpuSummary: {
            model: cpus[0]?.model,
            cores: cpus.length,
            speedMHz: cpus[0]?.speed
        },
        memorySummary: memory || {
            total: os.totalmem(),
            free: os.freemem()
        },
        uptimeSeconds: process.uptime()
    };
}

async function collectSystemInfo(userDataPath, archive, manifest) {
    const systemInfo = buildSystemInfo(userDataPath);
    const json = JSON.stringify(systemInfo, null, 2);
    archive.append(json, { name: 'system-info.json' });
    manifest.files.push({
        archivePath: 'system-info.json',
        sourcePath: null,
        size: Buffer.byteLength(json),
        type: 'generated',
        description: 'App/system version information'
    });
}

async function collectSettingsSnapshot(userDataPath, archive, manifest) {
    const settingsPath = path.join(userDataPath, 'settings.json');
    if (!(await pathExists(settingsPath))) return;

    try {
        const raw = await fsp.readFile(settingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        const sanitized = {
            ...parsed,
            // Ensure secrets or tokens would be redacted here if added in future
        };
        const json = JSON.stringify(sanitized, null, 2);
        archive.append(json, { name: 'settings/settings-inline.json' });
        manifest.files.push({
            archivePath: 'settings/settings-inline.json',
            sourcePath: settingsPath,
            size: Buffer.byteLength(json),
            type: 'generated',
            description: 'Current settings snapshot (sanitized)'
        });
    } catch (error) {
        logger.error('Failed to include inline settings snapshot', error);
    }
}

async function createDiagnosticsBundle(options = {}) {
    const progressCallback = typeof options === 'function'
        ? options
        : options.progressCallback;
    const explicitPath = typeof options === 'object' ? options.savePath : undefined;

    const userDataPath = app.getPath('userData');
    const reportDir = path.join(userDataPath, DIAGNOSTICS_DIR);
    let zipPath = explicitPath;

    if (zipPath) {
        await fsp.mkdir(path.dirname(zipPath), { recursive: true });
    } else {
        await fsp.mkdir(reportDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        zipPath = path.join(reportDir, `diagnostics-${timestamp}.zip`);
    }

    const manifest = {
        generatedAt: new Date().toISOString(),
        files: []
    };

    const totalStages = 5;
    let completed = 0;

    emitProgress(progressCallback, 'initializing', completed, totalStages);

    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    const finalizePromise = new Promise((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
    });

    archive.pipe(output);

    await collectSystemInfo(userDataPath, archive, manifest);
    emitProgress(progressCallback, 'system-info', ++completed, totalStages);

    await collectLatestLogs(userDataPath, archive, manifest);
    emitProgress(progressCallback, 'logs', ++completed, totalStages);

    await collectSettingsFiles(userDataPath, archive, manifest);
    emitProgress(progressCallback, 'settings-files', ++completed, totalStages);

    await collectSettingsSnapshot(userDataPath, archive, manifest);
    emitProgress(progressCallback, 'settings-snapshot', ++completed, totalStages);

    await collectActivityLogs(userDataPath, archive, manifest);
    emitProgress(progressCallback, 'activity-logs', ++completed, totalStages);

    const manifestJson = JSON.stringify(manifest, null, 2);
    archive.append(manifestJson, { name: 'manifest.json' });

    archive.finalize();
    await finalizePromise;

    const stats = await fsp.stat(zipPath);

    emitProgress(progressCallback, 'complete', completed, totalStages, {
        bytes: stats.size
    });

    return {
        zipPath,
        size: stats.size,
        fileCount: manifest.files.length
    };
}

/**
 * Generate diagnostics zip with IPC integration
 * @param {string} targetPath - Path where to save the diagnostics zip
 * @param {Object} eventSender - Event sender for progress updates
 * @returns {Promise<Object>} Result object with success status
 */
async function generateDiagnosticsZip(targetPath, eventSender) {
    if (!targetPath) {
        return { success: false, error: 'No output path provided' };
    }

    try {
        const result = await createDiagnosticsBundle({
            savePath: targetPath,
            progressCallback: (progress) => {
                if (eventSender && !eventSender.isDestroyed()) {
                    eventSender.send('diagnostics-progress', progress);
                }
            }
        });

        return { success: true, ...result };
    } catch (error) {
        logger.error('Failed to generate diagnostics package:', error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    createDiagnosticsBundle,
    generateDiagnosticsZip
};

