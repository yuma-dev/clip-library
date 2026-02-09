const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('../utils/logger');
const { logActivity } = require('../utils/activity-tracker');

const DEFAULT_SERVER_URL = 'https://friends.cliplib.app';
const API_TOKEN_REGEX = /^[a-f0-9]{64}$/i;
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
  return typeof input === 'string' ? input.trim() : '';
}

function resolveSharingConfig(settings, overrides = {}) {
  const sharing = settings?.sharing || {};
  const serverUrl = normalizeServerUrl(overrides.serverUrl || sharing.serverUrl);
  const apiToken = sanitizeToken(overrides.apiToken || sharing.apiToken);
  return { serverUrl, apiToken };
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
  const { serverUrl, apiToken } = resolveSharingConfig(settings, overrides);

  if (!apiToken) {
    return { success: false, connected: false, error: 'API token is not configured.' };
  }

  if (!API_TOKEN_REGEX.test(apiToken)) {
    return { success: false, connected: false, error: 'API token must be a 64-character hex string.' };
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

  if (typeof input.game === 'string' && input.game.trim()) {
    output.game = input.game.trim();
  } else if (input.game === null) {
    output.game = null;
  }

  return Object.keys(output).length > 0 ? output : null;
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
  const { serverUrl, apiToken } = resolveSharingConfig(settings);

  if (!apiToken) {
    return { success: false, status: 401, error: 'API token is not configured.' };
  }

  if (!API_TOKEN_REGEX.test(apiToken)) {
    return { success: false, status: 401, error: 'API token must be a 64-character hex string.' };
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

module.exports = {
  DEFAULT_SERVER_URL,
  testConnection,
  shareClip
};