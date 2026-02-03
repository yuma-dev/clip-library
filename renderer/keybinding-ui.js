// Settings modal shortcuts tab UI
const { ipcRenderer } = require('electron');
const keybinds = require('./keybinding-manager');

const ACTION_INFO = {
  playPause:             { t: 'Play / Pause',            d: 'Toggle video playback',                     i: 'play_arrow' },
  frameBackward:         { t: 'Frame Backward',          d: 'Step one frame back',                       i: 'keyboard_arrow_left' },
  frameForward:          { t: 'Frame Forward',           d: 'Step one frame forward',                    i: 'keyboard_arrow_right' },
  skipBackward:          { t: 'Skip Backward',           d: 'Jump back 3% of duration',                 i: 'replay' },
  skipForward:           { t: 'Skip Forward',            d: 'Jump forward 3% of duration',              i: 'forward_media' },
  navigatePrev:          { t: 'Previous Clip',           d: 'Open previous clip in list',               i: 'skip_previous' },
  navigateNext:          { t: 'Next Clip',               d: 'Open next clip in list',                   i: 'skip_next' },
  volumeUp:              { t: 'Volume Up',               d: 'Increase playback volume',                 i: 'volume_up' },
  volumeDown:            { t: 'Volume Down',             d: 'Decrease playback volume',                 i: 'volume_down' },
  exportDefault:         { t: 'Export Trimmed Video',    d: 'Export current trim to clipboard',         i: 'smart_display' },
  exportVideo:           { t: 'Export Video (file)',     d: 'Export full video to file',                i: 'video_file' },
  exportAudioFile:       { t: 'Export Audio (file)',     d: 'Export audio to file',                     i: 'audio_file' },
  exportAudioClipboard:  { t: 'Export Audio (clipboard)',d: 'Copy audio to clipboard',                  i: 'music_video' },
  fullscreen:            { t: 'Toggle Fullscreen',       d: 'Enter/exit fullscreen player',             i: 'fullscreen' },
  deleteClip:            { t: 'Delete Clip',             d: 'Delete current clip',                      i: 'delete' },
  setTrimStart:          { t: 'Set Trim Start',          d: 'Mark trim start at playhead',              i: 'line_start' },
  setTrimEnd:            { t: 'Set Trim End',            d: 'Mark trim end at playhead',                i: 'line_end' },
  focusTitle:            { t: 'Focus Title',             d: 'Begin editing title',                      i: 'edit' },
  closePlayer:           { t: 'Close Player',            d: 'Close the fullscreen player',              i: 'close' }
};

let settingsModalRef = null;
let showCustomConfirmRef = null;
let captureBox = null;
let captureAction = null;
const pressed = new Set();

function ensureShortcutsTab() {
  if (!settingsModalRef) return;
  if (settingsModalRef.querySelector('.settings-tab[data-tab="shortcuts"]')) return;

  const tabsContainer = settingsModalRef.querySelector('.settings-tabs');
  const shortcutsTab = document.createElement('div');
  shortcutsTab.className = 'settings-tab';
  shortcutsTab.dataset.tab = 'shortcuts';
  shortcutsTab.textContent = 'Shortcuts';
  tabsContainer.appendChild(shortcutsTab);

  const contentWrapper = settingsModalRef.querySelector('.settings-modal-content');
  const shortcutsContent = document.createElement('div');
  shortcutsContent.className = 'settings-tab-content';
  shortcutsContent.dataset.tab = 'shortcuts';
  shortcutsContent.innerHTML = `
    <div class="settings-group">
      <div id="keybinding-list" class="keybinding-list"></div>
      <p class="kb-hint">Click the key box, then press your new combination.</p>
      <div style="margin-top: 15px;">
        <button id="resetKeybindsBtn" class="settings-button settings-button-secondary">Reset to Defaults</button>
      </div>
    </div>`;

  const footer = contentWrapper.querySelector('.settings-footer');
  contentWrapper.insertBefore(shortcutsContent, footer);
}

function buildCombo(ev) {
  const parts = [];
  if (ev.ctrlKey || ev.metaKey) parts.push('Ctrl');
  if (ev.shiftKey) parts.push('Shift');
  if (ev.altKey) parts.push('Alt');
  const key = ev.key === ' ' ? 'Space' : (ev.key.length === 1 ? ev.key.toUpperCase() : ev.key);
  parts.push(key);
  return parts.join('+');
}

function captureKey(ev) {
  if (!captureBox) return;
  ev.preventDefault();
  pressed.add(ev.code);
  captureBox.textContent = buildCombo(ev);
}

function releaseKey() {
  if (!captureBox) return;
  if (pressed.size > 0) return;

  const displayCombo = captureBox.textContent;
  const normalizedCombo = displayCombo
    .split('+')
    .map(part => (part.length === 1 ? part.toLowerCase() : part))
    .join('+');

  keybinds.setKeybinding(captureAction, normalizedCombo);

  captureBox.classList.remove('editing');
  document.removeEventListener('keydown', captureKey, true);
  document.removeEventListener('keyup', releaseKey, true);
  captureBox = null;
  captureAction = null;
}

function startKeyCapture(e) {
  captureBox = e.currentTarget;
  captureAction = captureBox.dataset.action;
  pressed.clear();
  captureBox.classList.add('editing');
  captureBox.textContent = 'Waiting for keys...';

  document.addEventListener('keydown', captureKey, true);
  document.addEventListener('keyup', releaseKey, true);
}

function populateKeybindingList() {
  const list = document.getElementById('keybinding-list');
  if (!list) return;

  list.innerHTML = '';
  const bindings = keybinds.getAll();
  Object.entries(ACTION_INFO).forEach(([action, info]) => {
    const row = document.createElement('div');
    row.className = 'kb-row';

    let displayBinding = bindings[action] || '';
    if (displayBinding) {
      displayBinding = displayBinding
        .split('+')
        .map(p => (p.length === 1 ? p.toUpperCase() : p))
        .join('+');
    }

    row.innerHTML = `
      <div class="kb-info">
        <div class="kb-label"><span class="kb-icon material-symbols-rounded">${info.i}</span>${info.t}</div>
        <div class="kb-desc">${info.d}</div>
      </div>
      <div class="kb-box" tabindex="0" data-action="${action}" id="kb-box-${action}">${displayBinding}</div>`;

    list.appendChild(row);
  });

  list.querySelectorAll('.kb-box').forEach(box => box.addEventListener('click', startKeyCapture));
}

async function handleResetKeybinds() {
  if (typeof showCustomConfirmRef !== 'function') return;
  const confirmed = await showCustomConfirmRef('Reset all keyboard shortcuts to default values?');
  if (!confirmed) return;

  const defaultKeybindings = await ipcRenderer.invoke('get-default-keybindings');
  for (const [action, defaultCombo] of Object.entries(defaultKeybindings)) {
    await keybinds.setKeybinding(action, defaultCombo);
  }

  populateKeybindingList();
}

function init({ settingsModal, showCustomConfirm }) {
  settingsModalRef = settingsModal;
  showCustomConfirmRef = showCustomConfirm;

  ensureShortcutsTab();
  populateKeybindingList();

  const resetButton = settingsModalRef?.querySelector('#resetKeybindsBtn');
  if (resetButton && !resetButton.dataset.bound) {
    resetButton.addEventListener('click', handleResetKeybinds);
    resetButton.dataset.bound = 'true';
  }
}

module.exports = {
  init,
  populateKeybindingList
};
