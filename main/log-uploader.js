const http = require('http');
const https = require('https');
const { URL } = require('url');
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

async function uploadSessionLogs({ rendererConsoleLogs } = {}) {
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

module.exports = {
  uploadSessionLogs
};
