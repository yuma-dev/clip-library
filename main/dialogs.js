/**
 * Dialog Handlers Module
 *
 * Manages all Electron dialog interactions for file/folder selection and save operations.
 * These functions show native OS dialogs for user file system interactions.
 */

// Imports
const { dialog, app } = require('electron');
const path = require('path');

/**
 * Show save dialog for diagnostics zip file
 * @param {BrowserWindow} mainWindow - The main window to attach the dialog to
 * @returns {Promise<string|null>} File path if saved, null if canceled
 */
async function showDiagnosticsSaveDialog(mainWindow) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultDirectory = app.getPath('documents');
  const defaultPath = path.join(defaultDirectory, `clips-diagnostics-${timestamp}.zip`);

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Diagnostics Zip',
    defaultPath,
    buttonLabel: 'Save Diagnostics',
    filters: [{ name: 'Zip Files', extensions: ['zip'] }]
  });

  return result.canceled ? null : result.filePath;
}

/**
 * Show folder selection dialog (for clip location)
 * @param {BrowserWindow} mainWindow - The main window to attach the dialog to
 * @returns {Promise<string|null>} Folder path if selected, null if canceled
 */
async function showFolderDialog(mainWindow) {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
}

/**
 * Show save dialog for video/audio export
 * @param {BrowserWindow} mainWindow - The main window to attach the dialog to
 * @param {string} type - Export type: "audio" or "video"
 * @param {string} clipName - Original clip name
 * @param {string} customName - Custom name if set
 * @returns {Promise<string|null>} File path if saved, null if canceled
 */
async function showSaveDialog(mainWindow, type, clipName, customName) {
  const extension = type === "audio" ? ".mp3" : ".mp4";
  const defaultName = (customName || clipName || "clip") + extension;

  const options = {
    defaultPath: defaultName,
    filters: type === "audio"
      ? [{ name: "Audio Files", extensions: ["mp3"] }]
      : [{ name: "Video Files", extensions: ["mp4"] }],
  };

  const result = await dialog.showSaveDialog(mainWindow, options);
  return result.canceled ? null : result.filePath;
}

/**
 * Show folder selection dialog for SteelSeries import
 * @returns {Promise<string|null>} Folder path if selected, null if canceled
 */
async function showSteelSeriesFolderDialog() {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select your SteelSeries Clips Folder'
  });

  return result.canceled ? null : result.filePaths[0];
}

module.exports = {
  showDiagnosticsSaveDialog,
  showFolderDialog,
  showSaveDialog,
  showSteelSeriesFolderDialog
};
