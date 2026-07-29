const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const telemetry = require('./telemetry');

const STORE_PATH = path.join(app.getPath('userData'), 'cliplib-auth.json');
const STORE_VERSION = 1;

function encodePlain(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodePlain(base64Value) {
  return Buffer.from(base64Value, 'base64').toString('utf8');
}

function buildRecord(token) {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(token);
    return {
      version: STORE_VERSION,
      mode: 'safeStorage',
      value: encrypted.toString('base64')
    };
  }

  logger.warn('safeStorage encryption unavailable; storing ClipLib token with base64 fallback.');
  telemetry.event('auth_token_plaintext_fallback', {
    kind: telemetry.KIND.DEGRADED,
    severity: telemetry.SEVERITY.WARNING
  });
  return {
    version: STORE_VERSION,
    mode: 'plain',
    value: encodePlain(token)
  };
}

function decodeRecord(record) {
  if (!record || typeof record !== 'object') return '';
  if (typeof record.value !== 'string' || !record.value.trim()) return '';

  if (record.mode === 'safeStorage') {
    if (!safeStorage.isEncryptionAvailable()) {
      // The user is reported as "not connected" with nothing telling them
      // their stored token can no longer be read (OS keyring reset, profile
      // copied to another machine).
      telemetry.event('auth_token_undecryptable', {
        kind: telemetry.KIND.ERROR,
        severity: telemetry.SEVERITY.ERROR,
        context: { mode: record.mode, reason: 'encryption_unavailable' }
      });
      throw new Error('Token storage is encrypted but safeStorage is unavailable.');
    }
    let decrypted;
    try {
      decrypted = safeStorage.decryptString(Buffer.from(record.value, 'base64'));
    } catch (error) {
      // Same outcome, different cause: the key is there but it is not ours.
      telemetry.event('auth_token_undecryptable', {
        kind: telemetry.KIND.ERROR,
        severity: telemetry.SEVERITY.ERROR,
        context: { mode: record.mode, reason: 'decrypt_failed' }
      });
      throw error;
    }
    return typeof decrypted === 'string' ? decrypted.trim() : '';
  }

  if (record.mode === 'plain') {
    return decodePlain(record.value).trim();
  }

  return '';
}

// In-memory cache: the token is needed on every share API call and every
// media request (header injection), so skip the file read + decrypt after
// the first resolution. `null` = not yet read; '' = known-absent.
let cachedToken = null;

async function getToken() {
  if (cachedToken !== null) return cachedToken;
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cachedToken = decodeRecord(parsed);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Failed reading ClipLib auth token store:', error);
      telemetry.event('auth_token_read_failed', {
        kind: telemetry.KIND.SILENT_FAILURE,
        severity: telemetry.SEVERITY.WARNING,
        context: { errno: error?.code }
      });
      return ''; // transient failure — don't cache
    }
    cachedToken = '';
  }
  return cachedToken;
}

async function setToken(token) {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!trimmed) {
    throw new Error('Cannot store an empty ClipLib token.');
  }
  const record = buildRecord(trimmed);
  await fs.writeFile(STORE_PATH, JSON.stringify(record, null, 2), 'utf8');
  cachedToken = trimmed;
}

async function clearToken() {
  try {
    await fs.unlink(STORE_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  } finally {
    cachedToken = '';
  }
}

module.exports = {
  getToken,
  setToken,
  clearToken
};
