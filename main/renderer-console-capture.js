// Renderer console capture — main-process side.
//
// The renderer's console.* output only exists in DevTools; nothing persists
// it. Diagnostics (log upload + zip) need it, and the old approach — the
// renderer passing its own buffer over IPC — broke silently when the React
// UI stopped filling it in. Capturing via webContents 'console-message'
// works for every window without renderer cooperation.
const DEFAULT_MAX_ENTRIES = 2000;
const MAX_ENTRIES = Number(process.env.CONSOLE_LOG_BUFFER_MAX) || DEFAULT_MAX_ENTRIES;

const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

const buffer = [];

function pushEntry(level, message, line, sourceId) {
  const timestamp = new Date().toISOString();
  const source = sourceId ? ` (${sourceId}${line ? `:${line}` : ''})` : '';
  buffer.push(`${timestamp} ${level}${source} ${message}`);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
}

function attach(webContents, label = 'renderer') {
  webContents.on('console-message', (event, legacyLevel, legacyMessage, legacyLine, legacySourceId) => {
    try {
      // Electron is migrating this event from positional args to a params
      // object on `event`; accept both shapes.
      const details = event && typeof event === 'object' && 'message' in event ? event : null;
      const rawLevel = details ? details.level : legacyLevel;
      const message = details ? details.message : legacyMessage;
      const line = details ? details.lineNumber : legacyLine;
      const sourceId = details ? details.sourceId : legacySourceId;
      const level = typeof rawLevel === 'number'
        ? (LEVEL_NAMES[rawLevel] || 'LOG')
        : String(rawLevel || 'log').toUpperCase();
      pushEntry(`[${label}] ${level}`, String(message ?? ''), line, sourceId);
    } catch (_) {
      // Never let diagnostics capture break the window
    }
  });
}

function getBufferText() {
  return buffer.join('\n');
}

function getEntryCount() {
  return buffer.length;
}

module.exports = {
  attach,
  getBufferText,
  getEntryCount
};
