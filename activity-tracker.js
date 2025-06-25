const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const logger = require('./logger');

const getLogFilePath = (year, month) => {
    const userDataPath = app.getPath('userData');
    // Store logs in a dedicated subdirectory within userData
    const logDir = path.join(userDataPath, 'activity_logs');
    // Format month to be two digits (e.g., 01, 07, 12)
    const monthString = String(month).padStart(2, '0');
    return path.join(logDir, `user_activity_log_${year}-${monthString}.jsonl`);
};

const ensureLogDirectoryExists = async () => {
    const userDataPath = app.getPath('userData');
    const logDir = path.join(userDataPath, 'activity_logs');
    try {
        // Ensure the directory exists, creating it if necessary
        await fs.mkdir(logDir, { recursive: true });
    } catch (error) {
        // Log an error if directory creation fails, but don't block execution
        logger.error('Failed to create activity log directory:', error);
    }
};

// Ensure the log directory exists when the module is loaded.
// We run this immediately but don't wait for it to complete,
// as appendFile will create the directory if needed anyway,
// but this pre-creates it in most cases.
ensureLogDirectoryExists();

/**
 * Logs a user activity event to the appropriate yearly log file.
 * @param {string} type - The type of activity (e.g., 'rename', 'trim', 'export').
 * @param {object} details - An object containing specific details about the event.
 */
const logActivity = async (type, details) => {
    try {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1; // getMonth() is 0-indexed, add 1
        const timestamp = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString();

        const logEntry = {
            timestamp,
            year,
            month, // Optionally include month in the log entry itself
            type,
            details: details || {},
        };

        const logFilePath = getLogFilePath(year, month);
        // Convert the entry to a JSON string and add a newline
        const logLine = JSON.stringify(logEntry) + '\n';

        // Append the log line to the file, creating the file if it doesn't exist.
        // Use 'utf8' encoding.
        await fs.appendFile(logFilePath, logLine, 'utf8');
        // Optional: Uncomment to log activity for debugging purposes
        // logger.debug(`Logged activity: ${type}`, details);

    } catch (error) {
        // Log any errors during the file writing process
        logger.error('Failed to log user activity:', { type, details, error: error.message });
    }
};

module.exports = { logActivity }; 