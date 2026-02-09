const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const logger = require('../utils/logger');
const { logActivity } = require('../utils/activity-tracker');
const authStore = require('./cliplib-auth-store');

const DEFAULT_SERVER_URL = 'https://friends.cliplib.app';
const DESKTOP_AUTH_CALLBACK_URL = 'cliplib://auth';
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const CONNECTION_TIMEOUT_MS = 10000;
const UPLOAD_TIMEOUT_MS = 180000;
const MAX_REDIRECTS = 5;

function normalizeServerUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return DEFAULT_SERVER_URL;
  return raw.replace(/\/+$/, '');
}

function sanitizeToken(input) {
  if (typeof input !== 'string') return '';
  const token = input.trim();
  if (!token || /[\r\n]/.test(token)) {
    return '';
  }
  return token;
}

async function resolveSharingConfig(settings, overrides = {}) {
  const sharing = settings?.sharing || {};
  const serverUrl = normalizeServerUrl(overrides.serverUrl || DEFAULT_SERVER_URL);
  const overrideToken = sanitizeToken(overrides.apiToken);
  if (overrideToken) {
    return { serverUrl, apiToken: overrideToken };
  }

  const storedToken = sanitizeToken(await authStore.getToken());
  if (storedToken) {
    return { serverUrl, apiToken: storedToken };
  }

  const legacyToken = sanitizeToken(sharing.apiToken);
  if (legacyToken) {
    // Seamless migration path from prior plaintext settings token.
    try {
      await authStore.setToken(legacyToken);
    } catch (error) {
      logger.warn(`Failed to migrate legacy sharing token to secure storage: ${error.message}`);
    }
  }

  const apiToken = legacyToken;
  return { serverUrl, apiToken };
}

function generateDesktopAuthSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function buildDesktopAuthUrl(serverUrl, sessionId) {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) {
    throw new Error('Missing desktop auth session id.');
  }
  const authUrl = new URL('/auth/app', normalizedServerUrl);
  authUrl.searchParams.set('callback', DESKTOP_AUTH_CALLBACK_URL);
  authUrl.searchParams.set('session', normalizedSessionId);
  return authUrl.toString();
}

function parseDesktopAuthCallbackUrl(callbackUrl) {
  try {
    const parsed = new URL(callbackUrl);
    if (parsed.protocol !== 'cliplib:') {
      return { ok: false, error: 'Invalid protocol for auth callback.' };
    }

    const target = (parsed.hostname || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
    if (target !== 'auth') {
      return { ok: false, error: 'Invalid callback target.' };
    }

    const token = sanitizeToken(parsed.searchParams.get('token') || '');
    const session = (parsed.searchParams.get('session') || '').trim();
    if (!token) {
      return { ok: false, error: 'Missing token in auth callback.' };
    }
    if (!session) {
      return { ok: false, error: 'Missing session in auth callback.' };
    }

    return {
      ok: true,
      token,
      session
    };
  } catch (_) {
    return { ok: false, error: 'Malformed auth callback URL.' };
  }
}

async function setStoredApiToken(token) {
  const normalized = sanitizeToken(token);
  if (!normalized) {
    throw new Error('Cannot store empty API token.');
  }
  await authStore.setToken(normalized);
}

async function clearStoredApiToken() {
  await authStore.clearToken();
}

async function getStoredApiToken() {
  return sanitizeToken(await authStore.getToken());
}

function buildErrorMessage(statusCode, bodyJson, bodyText, fallback) {
  if (bodyJson && typeof bodyJson.error === 'string' && bodyJson.error.trim()) {
    return bodyJson.error.trim();
  }
  if (typeof bodyText === 'string' && bodyText.trim()) {
    return `HTTP ${statusCode}: ${bodyText.trim().slice(0, 220)}`;
  }
  return fallback;
}

async function parseJsonSafe(text) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = CONNECTION_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const bodyText = await response.text();
    const bodyJson = await parseJsonSafe(bodyText);
    return { response, bodyText, bodyJson };
  } finally {
    clearTimeout(timeout);
  }
}

async function testConnection(getSettings, overrides = {}) {
  const settings = await getSettings();
  const { serverUrl, apiToken } = await resolveSharingConfig(settings, overrides);

  if (!apiToken) {
    return { success: false, connected: false, error: 'API token is not configured.' };
  }

  try {
    const { response, bodyText, bodyJson } = await fetchWithTimeout(
      `${serverUrl}/api/auth/me`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`
        }
      },
      CONNECTION_TIMEOUT_MS
    );

    if (response.status === 200 && bodyJson && typeof bodyJson === 'object') {
      const displayName = bodyJson.displayName || bodyJson.username || bodyJson.discordId || 'Unknown user';
      return {
        success: true,
        connected: true,
        serverUrl,
        displayName,
        user: bodyJson
      };
    }

    return {
      success: false,
      connected: false,
      status: response.status,
      error: buildErrorMessage(response.status, bodyJson, bodyText, 'Connection test failed.')
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { success: false, connected: false, error: 'Connection timed out.' };
    }
    return {
      success: false,
      connected: false,
      error: `Connection failed: ${error.message}`
    };
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function buildMetadataPayload(input = {}) {
  const output = {};

  if (typeof input.title === 'string' && input.title.trim()) {
    output.title = input.title.trim();
  }

  if (Array.isArray(input.tags)) {
    const tags = input.tags
      .filter((tag) => typeof tag === 'string')
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag.length > 0);

    if (tags.length > 0) {
      output.tags = [...new Set(tags)];
    }
  }

  if (Array.isArray(input.mentions)) {
    const mentions = input.mentions
      .filter((id) => typeof id === 'string')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (mentions.length > 0) {
      output.mentions = [...new Set(mentions)];
    }
  }

  return Object.keys(output).length > 0 ? output : null;
}

function normalizeMentionUser(rawUser = {}) {
  const id = typeof rawUser.id === 'string' ? rawUser.id.trim() : '';
  if (!id) return null;

  const username = typeof rawUser.username === 'string' ? rawUser.username.trim() : '';
  const displayNameRaw = typeof rawUser.displayName === 'string' ? rawUser.displayName.trim() : '';
  const displayName = displayNameRaw || username || id;
  const avatarUrl = typeof rawUser.avatarUrl === 'string' ? rawUser.avatarUrl.trim() : '';

  return {
    id,
    username,
    displayName,
    avatarUrl
  };
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.mkv':
      return 'video/x-matroska';
    case '.webm':
      return 'video/webm';
    case '.avi':
      return 'video/x-msvideo';
    default:
      return 'application/octet-stream';
  }
}

async function postMultipartClip({
  endpoint,
  apiToken,
  filePath,
  metadataJson,
  timeoutMs = UPLOAD_TIMEOUT_MS,
  redirectCount = 0
}) {
  const target = new URL(endpoint);
  const useHttps = target.protocol === 'https:';
  const requestFn = useHttps ? https.request : http.request;

  const boundary = `----ClipLibBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const filename = path.basename(filePath).replace(/"/g, '_');
  const fileStats = await fsp.stat(filePath);

  const metadataPart = metadataJson
    ? `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadataJson}\r\n`
    : '';

  const filePartHeader =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${getMimeType(filePath)}\r\n\r\n`;

  const closingPart = `\r\n--${boundary}--\r\n`;

  const contentLength =
    Buffer.byteLength(metadataPart, 'utf8') +
    Buffer.byteLength(filePartHeader, 'utf8') +
    fileStats.size +
    Buffer.byteLength(closingPart, 'utf8');

  const options = {
    method: 'POST',
    hostname: target.hostname,
    port: target.port || (useHttps ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': contentLength
    }
  };

  return new Promise((resolve, reject) => {
    const req = requestFn(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', async () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');

        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectCount >= MAX_REDIRECTS) {
            reject(new Error('Upload redirect limit exceeded.'));
            return;
          }

          try {
            const redirectedUrl = new URL(res.headers.location, target).toString();
            const redirected = await postMultipartClip({
              endpoint: redirectedUrl,
              apiToken,
              filePath,
              metadataJson,
              timeoutMs,
              redirectCount: redirectCount + 1
            });
            resolve(redirected);
          } catch (error) {
            reject(error);
          }
          return;
        }

        resolve({
          statusCode: res.statusCode || 0,
          bodyText
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Upload timed out.'));
    });

    req.on('error', reject);

    req.write(metadataPart);
    req.write(filePartHeader);

    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', (streamError) => {
      req.destroy(streamError);
    });
    fileStream.on('end', () => {
      req.write(closingPart);
      req.end();
    });
    fileStream.pipe(req, { end: false });
  });
}

async function cleanupTempFile(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(`Failed to clean up temp shared clip ${filePath}: ${error.message}`);
    }
  }
}

async function shareClip(payload, getSettings, ffmpegModule) {
  if (!payload || typeof payload !== 'object') {
    return { success: false, error: 'Missing share payload.' };
  }

  const { clipName, start, end, volume, speed } = payload;
  if (!clipName) {
    return { success: false, error: 'Missing clip name.' };
  }

  const settings = await getSettings();
  const { serverUrl, apiToken } = await resolveSharingConfig(settings);

  if (!apiToken) {
    return { success: false, status: 401, error: 'API token is not configured.' };
  }

  let exportedPath = null;

  try {
    const exportResult = await ffmpegModule.exportTrimmedVideoForShare(
      clipName,
      start,
      end,
      volume,
      speed,
      getSettings
    );

    if (!exportResult?.success || !exportResult.path) {
      return { success: false, error: exportResult?.error || 'Failed to export clip for sharing.' };
    }

    exportedPath = exportResult.path;

    const fileStats = await fsp.stat(exportedPath);
    if (fileStats.size > MAX_UPLOAD_BYTES) {
      return {
        success: false,
        status: 400,
        error: `File too large (${formatBytes(fileStats.size)}). Maximum allowed size is 500 MB.`
      };
    }

    const metadataPayload = buildMetadataPayload(payload.metadata);
    const metadataJson = metadataPayload ? JSON.stringify(metadataPayload) : null;

    const uploadResponse = await postMultipartClip({
      endpoint: `${serverUrl}/api/clips`,
      apiToken,
      filePath: exportedPath,
      metadataJson
    });

    const bodyJson = await parseJsonSafe(uploadResponse.bodyText);

    if (uploadResponse.statusCode === 202) {
      logActivity('share_clip', {
        clipName,
        remoteId: bodyJson?.id || null,
        status: bodyJson?.status || 'processing',
        serverUrl
      });

      return {
        success: true,
        id: bodyJson?.id || null,
        status: bodyJson?.status || 'processing'
      };
    }

    return {
      success: false,
      status: uploadResponse.statusCode,
      error: buildErrorMessage(
        uploadResponse.statusCode,
        bodyJson,
        uploadResponse.bodyText,
        'Failed to upload clip.'
      )
    };
  } catch (error) {
    logger.error('Share upload failed:', error);
    return { success: false, error: `Share failed: ${error.message}` };
  } finally {
    await cleanupTempFile(exportedPath);
  }
}

async function fetchMentionableUsers(getSettings, overrides = {}) {
  const settings = await getSettings();
  const { serverUrl, apiToken } = await resolveSharingConfig(settings, overrides);

  if (!apiToken) {
    return { success: false, status: 401, error: 'API token is not configured.' };
  }

  try {
    const { response, bodyText, bodyJson } = await fetchWithTimeout(
      `${serverUrl}/api/users?all=true`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`
        }
      },
      CONNECTION_TIMEOUT_MS
    );

    if (response.status === 200 && bodyJson && Array.isArray(bodyJson.users)) {
      const users = bodyJson.users
        .map(normalizeMentionUser)
        .filter(Boolean)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));

      return {
        success: true,
        users
      };
    }

    return {
      success: false,
      status: response.status,
      error: buildErrorMessage(response.status, bodyJson, bodyText, 'Failed to fetch users.')
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { success: false, error: 'Request for users timed out.' };
    }

    return {
      success: false,
      error: `Failed to fetch users: ${error.message}`
    };
  }
}

module.exports = {
  DEFAULT_SERVER_URL,
  DESKTOP_AUTH_CALLBACK_URL,
  buildDesktopAuthUrl,
  parseDesktopAuthCallbackUrl,
  generateDesktopAuthSessionId,
  getStoredApiToken,
  setStoredApiToken,
  clearStoredApiToken,
  testConnection,
  shareClip,
  fetchMentionableUsers
};
