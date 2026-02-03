const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const consoleBuffer = require('../utils/console-log-buffer');

const DEFAULT_ENDPOINT = 'https://logs.yuma-homeserver.online/api/logs';
const HARD_CODED_API_KEY = 'db3ca26bdfa8e080866b54ec533d9828f4cfe96cee8ff3bba44ced6f26885cfe';

function buildPayload({ mainLogText, mainConsoleText, rendererConsoleText, mainLogPath }) {
  const header = [
    '=== Clip Library Session Logs ===',
    `Generated: ${new Date().toISOString()}`,
    mainLogPath ? `Main log file: ${mainLogPath}` : 'Main log file: (unknown)',
    ''
  ];

  return [
    ...header,
    '--- Main Log File ---',
    mainLogText || '(empty)',
    '',
    '--- Main Console Output ---',
    mainConsoleText || '(empty)',
    '',
    '--- Renderer Console Output ---',
    rendererConsoleText || '(empty)',
    ''
  ].join('\n');
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
      mainLogText = await fs.readFile(mainLogPath, 'utf8');
    }
  } catch (error) {
    logger.warn('Failed to read main log file for upload:', error);
  }

  const mainConsoleText = consoleBuffer.getBufferText();
  const rendererConsoleText = rendererConsoleLogs || '';

  const content = buildPayload({
    mainLogText,
    mainConsoleText,
    rendererConsoleText,
    mainLogPath
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
