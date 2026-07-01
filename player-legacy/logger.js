const path = require('path');
const fs = require('fs').promises;
const util = require('util');

// Log level definitions with both console colors and clean log formats
const LOG_LEVELS = {
    INFO: {
        console: '\x1b[32m',
        label: 'INFO',
        cleanLabel: 'INFO'
    },
    WARN: {
        console: '\x1b[33m',
        label: 'WARN',
        cleanLabel: 'WARNING'
    },
    ERROR: {
        console: '\x1b[31m',
        label: 'ERROR',
        cleanLabel: 'ERROR'
    },
    DEBUG: {
        console: '\x1b[36m',
        label: 'DEBUG',
        cleanLabel: 'DEBUG'
    }
};

class Logger {
    constructor() {
        this.isRenderer = process.type === 'renderer';
        this.logPath = '';
        this.currentLogFile = '';

        if (this.isRenderer) {
            const { ipcRenderer } = require('electron');
            this.ipc = ipcRenderer;
        } else {
            const { app, ipcMain } = require('electron');
            this.ipc = ipcMain;
            this.app = app;
            this.setupMainProcess();
        }
    }

    setupMainProcess() {
        this.ipc.handle('logger-write', async (event, { type, message, data, error }) => {
            const formattedMessage = this.formatLogMessage(type, message, data, error);
            await this.writeToFile(formattedMessage);
        });

        this.initializeMain();
    }

    async initializeMain() {
        try {
            // Ensure we only access Electron paths after the app is ready
            if (!this.app.isReady()) {
                await new Promise(res => this.app.once('ready', res));
            }

            this.logPath = path.join(this.app.getPath('userData'), 'logs');
            await fs.mkdir(this.logPath, { recursive: true });
            
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            this.currentLogFile = path.join(this.logPath, `app-${timestamp}.log`);
            
            await this.writeInitialLogEntry();
        } catch (error) {
            console.error('Failed to initialize logger:', error);
        }
    }

    async writeInitialLogEntry() {
        const border = '='.repeat(80);
        const startMessage = [
            border,
            'Log Session Started',
            `Timestamp: ${new Date().toISOString()}`,
            border,
            ''
        ].join('\n');
        await fs.writeFile(this.currentLogFile, startMessage, 'utf8');
    }

    async logSystemInfo() {
        if (this.isRenderer) return;

        const systemInfo = [
            'System Information:',
            '-'.repeat(50),
            `App Version:      ${this.app.getVersion()}`,
            `Electron:         ${process.versions.electron}`,
            `Chrome:           ${process.versions.chrome}`,
            `Node:             ${process.versions.node}`,
            `Platform:         ${process.platform}`,
            `Architecture:     ${process.arch}`,
            `Process Type:     ${process.type}`,
            `User Data Path:   ${this.app.getPath('userData')}`,
            '-'.repeat(50),
            ''
        ].join('\n');

        await this.writeToFile(systemInfo);
    }

    async cleanOldLogs() {
        if (this.isRenderer) return;

        try {
            const files = await fs.readdir(this.logPath);
            const now = new Date();
            
            for (const file of files) {
                if (!file.endsWith('.log')) continue;
                
                const filePath = path.join(this.logPath, file);
                const stats = await fs.stat(filePath);
                const daysOld = (now - stats.mtime) / (1000 * 60 * 60 * 24);
                
                if (daysOld > 7) {
                    await fs.unlink(filePath);
                }
            }
        } catch (error) {
            console.error('Failed to clean old logs:', error);
        }
    }

    formatLogMessage(type, message, data = null, error = null) {
        const timestamp = new Date().toISOString();
        const caller = this.getCallerLocation();
        const location = caller ? ` (${caller})` : '';
        let formatted = `${timestamp} ${type.padEnd(7)} [${process.type}]${location} `;

        // Handle message and data
        if (typeof data !== 'undefined' && data !== null) {
            if (typeof data === 'object') {
                const objString = util.inspect(data, {
                    depth: null,
                    colors: false,
                    compact: true,
                    breakLength: Infinity
                });
                formatted += `${message} ${objString}`;
            } else {
                if (message.endsWith(':')) {
                    formatted += `${message} ${data}`;
                } else {
                    formatted += `${message}${data}`;
                }
            }
        } else {
            formatted += message;
        }

        if (error) {
            formatted += `\nError: ${error.message}`;
            if (error.stack) {
                formatted += `\nStack: ${error.stack}`;
            }
        }

        return formatted;
    }

    async log(type, message, data = null, error = null) {
        let finalMessage = '';
        let finalData = data;

        // Handle different message formats
        if (typeof message === 'string' && data !== null && data !== undefined) {
            finalMessage = message;
            finalData = data;
        } else if (typeof message === 'object' && data === null) {
            finalMessage = '';
            finalData = message;
        } else {
            finalMessage = String(message);
        }

        // Format the message
        const fileMessage = this.formatLogMessage(type, finalMessage, finalData, error);
        let consoleMessage = fileMessage;

        // Add colors for console output
        if (type === 'INFO') consoleMessage = `\x1b[32m${fileMessage}\x1b[0m`;
        else if (type === 'WARN') consoleMessage = `\x1b[33m${fileMessage}\x1b[0m`;
        else if (type === 'ERROR') consoleMessage = `\x1b[31m${fileMessage}\x1b[0m`;
        else if (type === 'DEBUG') consoleMessage = `\x1b[36m${fileMessage}\x1b[0m`;

        // Console output
        console[type.toLowerCase()](consoleMessage);

        // File output
        if (this.isRenderer) {
            try {
                await this.ipc.invoke('logger-write', { 
                    type,
                    message: finalMessage,
                    data: finalData,
                    error 
                });
            } catch (err) {
                console.error('Failed to send log to main process:', err);
            }
        } else {
            await this.writeToFile(fileMessage);
        }
    }

    // Convenience methods
    async info(message, data = null) {
        await this.log('INFO', message, data);
    }

    async warn(message, data = null) {
        await this.log('WARN', message, data);
    }

    async error(message, error = null, data = null) {
        if (error instanceof Error) {
            await this.log('ERROR', message, data, error);
        } else {
            await this.log('ERROR', message, error);
        }
    }

    async debug(message, data = null) {
        await this.log('DEBUG', message, data);
    }

    async writeToFile(message) {
        if (this.isRenderer) return;

        try {
            // Lazily initialise the log file if it has not been set up yet.
            if (!this.currentLogFile) {
                await this.initializeMain();
            }

            await fs.appendFile(this.currentLogFile, message + '\n', 'utf8');
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }

    getCallerLocation() {
        const originalPrepare = Error.prepareStackTrace;
        try {
            Error.prepareStackTrace = (_, stack) => stack;
            const err = new Error();
            Error.captureStackTrace(err, this.getCallerLocation);
            const stack = err.stack;
            if (!Array.isArray(stack)) return '';

            for (const callsite of stack) {
                const fileName = callsite.getFileName();
                if (!fileName) continue;
                const normalizedFileName = fileName.replace(/\\/g, '/');
                if (normalizedFileName.includes('/utils/logger.js')) continue;
                if (normalizedFileName.includes('node:internal') || normalizedFileName.includes('/internal/')) continue;
                if (normalizedFileName.includes('electron/js2c')) continue;
                if (normalizedFileName.includes('/node_modules/')) continue;

                const line = callsite.getLineNumber();
                const column = callsite.getColumnNumber();
                const normalized = normalizedFileName;
                const cwd = (typeof process !== 'undefined' && process.cwd)
                    ? process.cwd().replace(/\\/g, '/')
                    : '';
                const base = cwd && normalized.startsWith(cwd)
                    ? normalized.slice(cwd.length + 1)
                    : normalized;
                return `${base}:${line}:${column}`;
            }
        } catch (_) {
            return '';
        } finally {
            Error.prepareStackTrace = originalPrepare;
        }

        return '';
    }

    getLogPath() {
        return this.currentLogFile;
    }
}

let logger;
if (process.type === 'renderer') {
    logger = new Logger();
} else {
    logger = new Logger();
}

module.exports = logger;
