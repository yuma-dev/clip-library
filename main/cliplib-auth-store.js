const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');

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
      throw new Error('Token storage is encrypted but safeStorage is unavailable.');
    }
    const decrypted = safeStorage.decryptString(Buffer.from(record.value, 'base64'));
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
