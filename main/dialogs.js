const { dialog, app } = require('electron');
const path = require('path');

/**
 * @param {BrowserWindow} mainWindow
 * @returns {Promise<string|null>}
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
 * @param {BrowserWindow} mainWindow
 * @returns {Promise<string|null>}
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
 * @param {BrowserWindow} mainWindow
 * @param {string} type - "audio" or "video"
 * @param {string} clipName
 * @param {string} customName
 * @returns {Promise<string|null>}
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

/** @returns {Promise<string|null>} */
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
