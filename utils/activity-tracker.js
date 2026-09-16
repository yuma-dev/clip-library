const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const logger = require('./logger');

const getLogFilePath = (year, month) => {
    const userDataPath = app.getPath('userData');
    const logDir = path.join(userDataPath, 'activity_logs');
    const monthString = String(month).padStart(2, '0');
    return path.join(logDir, `user_activity_log_${year}-${monthString}.jsonl`);
};

const ensureLogDirectoryExists = async () => {
    const userDataPath = app.getPath('userData');
    const logDir = path.join(userDataPath, 'activity_logs');
    try {
        await fs.mkdir(logDir, { recursive: true });
    } catch (error) {
        logger.error('Failed to create activity log directory:', error);
    }
};

// appendFile would create the dir anyway; this just pre-creates it, fire-and-forget
ensureLogDirectoryExists();

/**
 * @param {string} type
 * @param {object} details
 */
const logActivity = async (type, details) => {
    try {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1; // getMonth() is 0-indexed
        const timestamp = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString();

        const logEntry = {
            timestamp,
            year,
            month,
            type,
            details: details || {},
        };

        const logFilePath = getLogFilePath(year, month);
        const logLine = JSON.stringify(logEntry) + '\n';

        await fs.appendFile(logFilePath, logLine, 'utf8');

    } catch (error) {
        logger.error('Failed to log user activity:', { type, details, error: error.message });
    }
};

module.exports = { logActivity }; 