const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const { app } = require('electron');
const logger = require('../utils/logger');
const consoleBuffer = require('../utils/console-log-buffer');
const rendererConsole = require('./renderer-console-capture');
const clipdipModule = require('./clipdip');

const DEFAULT_ENDPOINT = 'https://logs.yuma-homeserver.online/api/logs';
const HARD_CODED_API_KEY = 'db3ca26bdfa8e080866b54ec533d9828f4cfe96cee8ff3bba44ced6f26885cfe';

// Tail caps keep a single upload sane: the current-session main log is
// usually small (one file per launch) but clipdip's rolling log can hit its
// 10 MB rotation limit mid-session.
const MAIN_LOG_TAIL_BYTES = 8 * 1024 * 1024;
const CLIPDIP_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const CLIPDIP_OLD_LOG_TAIL_BYTES = 512 * 1024;
const DIAG_QUEUE_MAX_EVENTS = 100;
const NOTE_MAX_CHARS = 20000;

async function tailFile(filePath, maxBytes) {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf8');
    return start > 0
      ? `[... truncated: showing last ${length} of ${size} bytes ...]\n${text}`
      : text;
  } finally {
    await handle.close();
  }
}

async function tailFileSafe(filePath, maxBytes) {
  try {
    return await tailFile(filePath, maxBytes);
  } catch (error) {
    return error.code === 'ENOENT' ? '' : `(unreadable: ${error.message})`;
  }
}

// diag-queue.jsonl holds clipdip's unflushed crash/capture-failure events;
// each line carries a base64-gzipped log tail we already upload separately,
// so strip that field and keep the event metadata.
function summarizeDiagQueue(raw) {
  if (!raw) return '';
  const lines = raw.split(/\r?\n/).filter(Boolean).slice(-DIAG_QUEUE_MAX_EVENTS);
  return lines
    .map((line) => {
      try {
        const { log, ...rest } = JSON.parse(line);
        return JSON.stringify({ ...rest, log: log ? `(gzip tail, ${log.length} b64 chars omitted)` : undefined });
      } catch {
        return line;
      }
    })
    .join('\n');
}

function section(title, text) {
  return [`--- ${title} ---`, text || '(empty)', ''];
}

function buildPayload({
  note,
  mainLogText,
  mainConsoleText,
  rendererConsoleText,
  mainLogPath,
  clipdipStatus,
  clipdipSections
}) {
  const header = [
    '=== Clip Library Session Logs ===',
    `Generated: ${new Date().toISOString()}`,
    `App version: ${app?.getVersion ? app.getVersion() : '(unknown)'}`,
    mainLogPath ? `Main log file: ${mainLogPath}` : 'Main log file: (unknown)',
    ''
  ];

  const parts = [
    ...header,
    ...section('Problem Description', note),
    ...section('Main Log File', mainLogText),
    ...section('Main Console Output', mainConsoleText),
    ...section('Renderer Console Output', rendererConsoleText),
    ...section('Clipdip Status Snapshot', clipdipStatus)
  ];
  for (const { title, text } of clipdipSections || []) {
    parts.push(...section(title, text));
  }
  return parts.join('\n');
}

// Gather everything clipdip-side that belongs in a text upload. Never throws:
// a machine without clipdip just gets empty sections.
async function collectClipdipSections() {
  const sections = [];
  let statusText = '';
  try {
    const snapshot = await clipdipModule.getDiagnosticsSnapshot();
    statusText = JSON.stringify(snapshot, null, 2);
  } catch (error) {
    statusText = `(status unavailable: ${error.message})`;
  }
  try {
    const files = await clipdipModule.collectDiagnosticFiles();
    const byName = new Map(files.map((f) => [f.name, f]));
    const addTail = async (name, title, maxBytes) => {
      const file = byName.get(name);
      if (!file) return;
      sections.push({ title, text: await tailFileSafe(file.path, maxBytes) });
    };
    await addTail('clipdip.log', 'Clipdip Log (tail)', CLIPDIP_LOG_TAIL_BYTES);
    await addTail('clipdip.log.old', 'Clipdip Previous Log (tail)', CLIPDIP_OLD_LOG_TAIL_BYTES);
    await addTail('config.toml', 'Clipdip Config', 64 * 1024);
    await addTail('notification-history.json', 'Clipdip Notification History', 512 * 1024);
    const diagQueue = byName.get('diag-queue.jsonl');
    if (diagQueue) {
      const raw = await tailFileSafe(diagQueue.path, 4 * 1024 * 1024);
      sections.push({ title: 'Clipdip Pending Crash/Failure Events', text: summarizeDiagQueue(raw) });
    }
  } catch (error) {
    sections.push({ title: 'Clipdip Files', text: `(collection failed: ${error.message})` });
  }
  return { statusText, sections };
}

function postLogs({ endpoint, apiKey, content, title, redirectCount = 0 }) {
  const target = new URL(endpoint);
  if (title) {
    target.searchParams.set('title', title);
  }

  const body = JSON.stringify({ title, content });
  const useHttps = target.protocol === 'https:';
  const requestFn = useHttps ? https.request : http.request;

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  };

  if (apiKey) {
    headers['X-API-Key'] = apiKey;
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const options = {
    method: 'POST',
    hostname: target.hostname,
    port: target.port || (useHttps ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    headers
  };

  return new Promise((resolve, reject) => {
    const req = requestFn(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectCount >= 5) {
            return reject(new Error('Upload redirect limit exceeded'));
          }
          const redirected = new URL(res.headers.location, target);
          return resolve(postLogs({
            endpoint: redirected.toString(),
            apiKey,
            content,
            title,
            redirectCount: redirectCount + 1
          }));
        }
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`Upload failed (${res.statusCode}): ${responseText}`));
        }
        try {
          const parsed = JSON.parse(responseText);
          resolve(parsed);
        } catch (error) {
          const urlMatch = responseText.match(/https?:\/\/\S+/);
          if (urlMatch) {
            resolve({ url: urlMatch[0], raw: responseText });
            return;
          }
          reject(new Error(`Upload response was not valid JSON: ${responseText.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function uploadSessionLogs({ rendererConsoleLogs, note } = {}) {
  const apiKey = process.env.LOGS_API_KEY || HARD_CODED_API_KEY;
  const endpoint = process.env.LOGS_API_URL || DEFAULT_ENDPOINT;

  if (!apiKey) {
    return { success: false, error: 'Missing LOGS_API_KEY environment variable.' };
  }

  let mainLogPath = '';
  let mainLogText = '';
  try {
    mainLogPath = logger.getLogPath();
    if (mainLogPath) {
      mainLogText = await tailFile(mainLogPath, MAIN_LOG_TAIL_BYTES);
    }
  } catch (error) {
    logger.warn('Failed to read main log file for upload:', error);
  }

  const mainConsoleText = consoleBuffer.getBufferText();
  // Captured main-side via webContents 'console-message'; the payload field
  // stays as a fallback for callers that still pass their own buffer.
  const rendererConsoleText = rendererConsole.getBufferText() || rendererConsoleLogs || '';
  const { statusText: clipdipStatus, sections: clipdipSections } = await collectClipdipSections();

  const content = buildPayload({
    note: typeof note === 'string' ? note.trim().slice(0, NOTE_MAX_CHARS) : '',
    mainLogText,
    mainConsoleText,
    rendererConsoleText,
    mainLogPath,
    clipdipStatus,
    clipdipSections
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const title = `clip-library-logs-${timestamp}.txt`;

  try {
    const response = await postLogs({
      endpoint,
      apiKey,
      content,
      title
    });
    return { success: true, ...response, title };
  } catch (error) {
    logger.error('Failed to upload session logs:', error);
    return { success: false, error: error.message };
  }
}

// ---------- full bundle upload (zip → /v1/bundles) ---------------------------
// Same server contract clipdip's Rust uploader speaks (see
// clipdip/crates/diagnostics/src/client.rs::upload_bundle): multipart with
// install_id/app_version/source/user_note fields plus the zip, authenticated
// by X-Clipdip-Key. The key is build-time injected (scripts/gen-ingest-key.mjs
// writes the gitignored ingest-key.generated.json); without it we fall back
// to the text log upload so the button never dead-ends.

const DEFAULT_BUNDLE_BASE = 'https://logs.yuma-homeserver.online';
// Server rejects bundles over ~50 MB; stop earlier with a clear message.
const MAX_BUNDLE_BYTES = 45 * 1024 * 1024;

function resolveIngestKey() {
  if (process.env.CLIPDIP_INGEST_KEY) return process.env.CLIPDIP_INGEST_KEY;
  try {
    const { key } = require('./ingest-key.generated.json');
    if (key) return key;
  } catch {
    /* not generated in this checkout */
  }
  return null;
}

// Bundles are correlated server-side by install id. Prefer clipdip's (so
// manual bundles line up with its automatic crash reports); machines without
// clipdip get a cliplib-local one.
async function getInstallId() {
  try {
    const entry = (await clipdipModule.collectDiagnosticFiles()).find((f) => f.name === 'install_id');
    if (entry) {
      const id = (await fs.readFile(entry.path, 'utf8')).trim();
      if (id) return id;
    }
  } catch {
    /* fall through to the local id */
  }
  const fallbackPath = path.join(app.getPath('userData'), 'install_id');
  try {
    const id = (await fs.readFile(fallbackPath, 'utf8')).trim();
    if (id) return id;
  } catch {
    /* first run */
  }
  const id = crypto.randomUUID();
  await fs.writeFile(fallbackPath, id, 'utf8').catch(() => {});
  return id;
}

function postBundle({ base, key, zip, installId, appVersion, note }) {
  const target = new URL('/v1/bundles', base);
  const boundary = `----cliplib${crypto.randomUUID().replace(/-/g, '')}`;
  const parts = [];
  const textField = (name, value) =>
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  textField('install_id', installId);
  textField('app_version', appVersion);
  // "manual" is the value the server already accepts from clipdip's own
  // uploader; cliplib bundles are distinguishable by filename + app_version.
  textField('source', 'manual');
  if (note) textField('user_note', note);
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cliplib-diagnostics.zip"\r\nContent-Type: application/zip\r\n\r\n`
  ));
  parts.push(zip);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const useHttps = target.protocol === 'https:';
  const requestFn = useHttps ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port || (useHttps ? 443 : 80),
        path: target.pathname,
        headers: {
          'X-Clipdip-Key': key,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        },
        timeout: 120000
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`Bundle upload failed (${res.statusCode}): ${text.slice(0, 200)}`));
          }
          try {
            const parsed = JSON.parse(text);
            if (parsed.bundle_id == null) return reject(new Error('Server did not return a bundle_id'));
            resolve(parsed.bundle_id);
          } catch {
            reject(new Error(`Bundle response was not valid JSON: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Bundle upload timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function uploadDiagnosticsBundle({ note, progressCallback } = {}) {
  const trimmedNote = typeof note === 'string' ? note.trim().slice(0, NOTE_MAX_CHARS) : '';
  const key = resolveIngestKey();
  if (!key) {
    logger.warn('No diagnostics ingest key in this build, falling back to the text log upload');
    const result = await uploadSessionLogs({ note: trimmedNote });
    return { ...result, mode: 'text' };
  }

  // Lazy: pulls in archiver, which is deliberately kept off the startup path.
  const { createDiagnosticsBundle } = require('../diagnostics/collector');
  const tmpPath = path.join(app.getPath('temp'), `cliplib-diagnostics-${Date.now()}.zip`);
  try {
    await createDiagnosticsBundle({ savePath: tmpPath, note: trimmedNote, progressCallback });
    const zip = await fs.readFile(tmpPath);
    if (zip.length > MAX_BUNDLE_BYTES) {
      return {
        success: false,
        error: `Bundle is ${(zip.length / 1024 / 1024).toFixed(1)} MB (server limit is ~50 MB). Use "Save zip" and share it manually.`
      };
    }
    const installId = await getInstallId();
    const base = process.env.CLIPDIP_INGEST_URL || DEFAULT_BUNDLE_BASE;
    const bundleId = await postBundle({
      base,
      key,
      zip,
      installId,
      appVersion: app.getVersion(),
      note: trimmedNote
    });
    return { success: true, bundleId, size: zip.length, mode: 'bundle' };
  } catch (error) {
    logger.error('Diagnostics bundle upload failed:', error);
    return { success: false, error: error.message };
  } finally {
    fs.unlink(tmpPath).catch(() => {});
  }
}

module.exports = {
  uploadSessionLogs,
  uploadDiagnosticsBundle
};
