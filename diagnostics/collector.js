const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const { app } = require('electron');
const logger = require('../utils/logger');
const consoleBuffer = require('../utils/console-log-buffer');
const rendererConsole = require('../main/renderer-console-capture');
const clipdipModule = require('../main/clipdip');

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

// Console output only exists in memory (main: patched console ring buffer;
// renderer: webContents 'console-message' capture) — dump both so the zip
// carries what never reached the log file.
function collectConsoleBuffers(archive, manifest) {
    const buffers = [
        {
            archivePath: 'console/main-console.txt',
            text: consoleBuffer.getBufferText(),
            description: 'Main-process console output (in-memory ring buffer)'
        },
        {
            archivePath: 'console/renderer-console.txt',
            text: rendererConsole.getBufferText(),
            description: 'Renderer console output (captured via console-message)'
        }
    ];
    for (const { archivePath, text, description } of buffers) {
        const content = text || '(empty)';
        archive.append(content, { name: archivePath });
        manifest.files.push({
            archivePath,
            sourcePath: null,
            size: Buffer.byteLength(content),
            type: 'generated',
            description
        });
    }
}

// Clipdip (the integrated recorder) keeps its own logs and state under
// %LOCALAPPDATA%\clipdip and %APPDATA%\clipdip — a recording bug report is
// useless without them. Secrets (control.json token, discord_tokens.json)
// are excluded by the bridge's candidate list.
async function collectClipdipData(archive, manifest) {
    try {
        const files = await clipdipModule.collectDiagnosticFiles();
        for (const file of files) {
            const archivePath = `clipdip/${file.name}`;
            archive.file(file.path, { name: archivePath });
            manifest.files.push({
                archivePath,
                sourcePath: file.path,
                size: file.size,
                type: 'clipdip',
                description: file.description
            });
        }
    } catch (error) {
        logger.warn('Failed to collect clipdip diagnostic files:', error);
    }

    try {
        const snapshot = await clipdipModule.getDiagnosticsSnapshot();
        const json = JSON.stringify(snapshot, null, 2);
        archive.append(json, { name: 'clipdip/status.json' });
        manifest.files.push({
            archivePath: 'clipdip/status.json',
            sourcePath: null,
            size: Buffer.byteLength(json),
            type: 'generated',
            description: 'Live clipdip state (ring buffer usage, pipeline status) — memory-only, lost after restart'
        });
    } catch (error) {
        logger.warn('Failed to capture clipdip status snapshot:', error);
    }
}

// Crashpad minidumps are the only trace of a native crash; nothing reaches
// the app log. Metadata only (dumps can be tens of MB); the JSON tells us
// whether crashes happened and where support can ask the user to fetch them.
async function collectCrashDumps(archive, manifest) {
    const report = {
        crashDumpsPath: null,
        dumpCount: 0,
        dumps: [],
        lastCrashReport: null
    };

    try {
        report.crashDumpsPath = app.getPath('crashDumps');
    } catch {
        // crashDumps path unavailable on this platform/build; still emit the JSON
    }

    try {
        const { crashReporter } = require('electron');
        const last = crashReporter.getLastCrashReport();
        if (last) {
            report.lastCrashReport = { id: last.id, date: last.date };
        }
    } catch {
        // crashReporter not started; nothing to report
    }

    if (report.crashDumpsPath && (await pathExists(report.crashDumpsPath))) {
        // Windows Crashpad puts .dmp files under reports\; macOS/Linux use
        // completed/new/pending. Scan all so the collector is layout-agnostic.
        for (const sub of ['reports', 'completed', 'new', 'pending']) {
            const dir = path.join(report.crashDumpsPath, sub);
            if (!(await pathExists(dir))) continue;
            try {
                for (const entry of await fsp.readdir(dir)) {
                    if (!entry.toLowerCase().endsWith('.dmp')) continue;
                    try {
                        const stat = await fsp.stat(path.join(dir, entry));
                        report.dumps.push({
                            file: `${sub}/${entry}`,
                            size: stat.size,
                            modifiedAt: stat.mtime.toISOString()
                        });
                    } catch {
                        // Skip unreadable dump
                    }
                }
            } catch {
                // Skip unreadable directory
            }
        }
        report.dumps.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
        report.dumpCount = report.dumps.length;
    }

    const json = JSON.stringify(report, null, 2);
    archive.append(json, { name: 'crashes/crashpad-dumps.json' });
    manifest.files.push({
        archivePath: 'crashes/crashpad-dumps.json',
        sourcePath: report.crashDumpsPath,
        size: Buffer.byteLength(json),
        type: 'generated',
        description: 'Crashpad minidump metadata (native crash evidence; dumps themselves stay on disk)'
    });
}

async function createDiagnosticsBundle(options = {}) {
    const progressCallback = typeof options === 'function'
        ? options
        : options.progressCallback;
    const explicitPath = typeof options === 'object' ? options.savePath : undefined;
    const note = typeof options === 'object' && typeof options.note === 'string'
        ? options.note.trim()
        : '';

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

    const totalStages = 8;
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

    if (note) {
        archive.append(note, { name: 'note.txt' });
        manifest.files.push({
            archivePath: 'note.txt',
            sourcePath: null,
            size: Buffer.byteLength(note),
            type: 'generated',
            description: "User's description of the problem"
        });
    }

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

    collectConsoleBuffers(archive, manifest);
    emitProgress(progressCallback, 'console-buffers', ++completed, totalStages);

    await collectClipdipData(archive, manifest);
    emitProgress(progressCallback, 'clipdip', ++completed, totalStages);

    await collectCrashDumps(archive, manifest);
    emitProgress(progressCallback, 'crash-dumps', ++completed, totalStages);

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
async function generateDiagnosticsZip(targetPath, eventSender, options = {}) {
    if (!targetPath) {
        return { success: false, error: 'No output path provided' };
    }

    try {
        const result = await createDiagnosticsBundle({
            savePath: targetPath,
            note: options?.note,
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

