const { ipcRenderer } = require('electron');

// Default keybindings should match those defined in settings-manager.js
const DEFAULT_KEYBINDINGS = {
  playPause: 'Space',
  frameBackward: ',',
  frameForward: '.',
  skipBackward: 'ArrowLeft',
  skipForward: 'ArrowRight',
  navigatePrev: 'Ctrl+ArrowLeft',
  navigateNext: 'Ctrl+ArrowRight',
  volumeUp: 'ArrowUp',
  volumeDown: 'ArrowDown',
  exportDefault: 'e',
  exportVideo: 'Ctrl+E',
  exportAudioFile: 'Ctrl+Shift+E',
  exportAudioClipboard: 'Shift+E',
  fullscreen: 'f',
  deleteClip: 'Delete',
  setTrimStart: '[',
  setTrimEnd: ']',
  focusTitle: 'Tab',
  closePlayer: 'Escape'
};

let keybindings = { ...DEFAULT_KEYBINDINGS };

function normaliseCombo(str) {
  // Normalise string like "ctrl+shift+E" to "Ctrl+Shift+E" for comparison
  return str
    .split('+')
    .map(part => {
      const p = part.trim();
      if (!p) return '';
      // Single-character keys compare case-insensitively – store as lowercase
      if (p.length === 1) return p.toLowerCase();
      return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    })
    .join('+');
}

function buildEventCombo(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  // Use e.key for single characters; special case for Space
  let keyPart = e.key;
  if (keyPart === ' ') keyPart = 'Space';
  if (keyPart.length === 1) keyPart = keyPart.toLowerCase();
  parts.push(keyPart);
  return normaliseCombo(parts.join('+'));
}

function getActionFromEvent(e) {
  const combo = buildEventCombo(e);
  for (const [action, binding] of Object.entries(keybindings)) {
    if (normaliseCombo(binding) === combo) {
      return action;
    }
  }
  return null;
}

function getKey(action) {
  return keybindings[action] || null;
}

async function initKeybindings() {
  try {
    const settings = await ipcRenderer.invoke('get-settings');
    if (settings && settings.keybindings && typeof settings.keybindings === 'object') {
      keybindings = { ...DEFAULT_KEYBINDINGS, ...settings.keybindings };
    }
  } catch (error) {
    // Fallback to defaults on error
    console.error('[KeybindingManager] Failed to load settings:', error);
  }
}

async function setKeybinding(action, combo) {
  keybindings[action] = normaliseCombo(combo);
  // Persist immediately
  try {
    const settings = await ipcRenderer.invoke('get-settings');
    const newSettings = { ...settings, keybindings };
    await ipcRenderer.invoke('save-settings', newSettings);
  } catch (error) {
    console.error('[KeybindingManager] Failed to save keybindings:', error);
  }
}

function getAll() {
  return { ...keybindings };
}

module.exports = {
  initKeybindings,
  getActionFromEvent,
  getKey,
  setKeybinding,
  getAll
}; 