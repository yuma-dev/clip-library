const util = require('util');
const path = require('path');

const DEFAULT_MAX_ENTRIES = 2000;
const MAX_ENTRIES = Number(process.env.CONSOLE_LOG_BUFFER_MAX) || DEFAULT_MAX_ENTRIES;

const buffer = [];
const original = {};
let patched = false;

function stringifyValue(value) {
  if (value instanceof Error) {
    return value.stack || value.message || String(value);
  }

  if (typeof value === 'string') return value;

  try {
    return util.inspect(value, {
      depth: 4,
      colors: false,
      compact: true,
      breakLength: Infinity
    });
  } catch (error) {
    return String(value);
  }
}

function formatArgs(args) {
  return args.map(stringifyValue).join(' ');
}

function pushEntry(level, args) {
  const timestamp = new Date().toISOString();
  const source = getCallerLocation();
  const location = source && !argsContainLocation(args) ? ` (${source})` : '';
  buffer.push(`${timestamp} ${level.toUpperCase()}${location} ${formatArgs(args)}`);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
}

function argsContainLocation(args) {
  if (!Array.isArray(args) || args.length === 0) return false;
  const first = args[0];
  if (typeof first !== 'string') return false;
  return /\[[^\]]+]\s+\([^)]+:\d+:\d+\)/.test(first);
}

function getCallerLocation() {
  const originalPrepare = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_, stack) => stack;
    const err = new Error();
    Error.captureStackTrace(err, getCallerLocation);
    const stack = err.stack;
    if (!Array.isArray(stack)) return '';

    for (const callsite of stack) {
      const fileName = callsite.getFileName();
      if (!fileName) continue;
      if (fileName.includes('console-log-buffer.js')) continue;
      if (fileName.includes('node:internal') || fileName.includes('internal/')) continue;
      if (fileName.includes('electron/js2c')) continue;
      if (fileName.includes('node_modules')) continue;

      const line = callsite.getLineNumber();
      const column = callsite.getColumnNumber();
      const normalized = fileName.replace(/\\/g, '/');
      const cwd = (typeof process !== 'undefined' && process.cwd)
        ? process.cwd().replace(/\\/g, '/')
        : '';
      const base = cwd && normalized.startsWith(cwd)
        ? normalized.slice(cwd.length + 1)
        : normalized;
      return `${base}:${line}:${column}`;
    }
  } catch (_) {
    // Fall through to string parsing below
  } finally {
    Error.prepareStackTrace = originalPrepare;
  }

  try {
    const err = new Error();
    if (!err.stack) return '';
    const lines = err.stack.split('\n').slice(1);
    for (const line of lines) {
      if (!line) continue;
      if (line.includes('console-log-buffer.js')) continue;
      if (line.includes('node:internal') || line.includes('internal/')) continue;
      if (line.includes('electron/js2c')) continue;
      if (line.includes('node_modules')) continue;
      const trimmed = line.trim().replace(/^at\s+/, '');
      const match = trimmed.match(/\(?([A-Za-z]:[^)]+|\S+):(\d+):(\d+)\)?$/);
      if (!match) continue;
      const rawPath = match[1];
      const cwd = (typeof process !== 'undefined' && process.cwd)
        ? process.cwd().replace(/\\/g, '/')
        : '';
      const normalized = rawPath.replace(/\\/g, '/');
      const base = cwd && normalized.startsWith(cwd)
        ? normalized.slice(cwd.length + 1)
        : normalized;
      return `${base}:${match[2]}:${match[3]}`;
    }
  } catch (_) {
    return '';
  }

  return '';
}

function patchConsole() {
  if (patched) return;
  patched = true;

  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    if (typeof console[level] !== 'function') return;
    original[level] = console[level].bind(console);
    console[level] = (...args) => {
      try {
        pushEntry(level, args);
      } catch (_) {
        // Intentionally ignore buffer failures
      }
      original[level](...args);
    };
  });
}

function getBufferText() {
  return buffer.join('\n');
}

function clearBuffer() {
  buffer.length = 0;
}

function getEntryCount() {
  return buffer.length;
}

module.exports = {
  patchConsole,
  getBufferText,
  clearBuffer,
  getEntryCount
};
