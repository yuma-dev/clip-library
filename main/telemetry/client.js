// HTTP transport. Speaks the same contract clipdip's Rust client does
// (clipdip/crates/diagnostics/src/client.rs), plus the cliplib-only routes.
//
// Status contract:
//   2xx             -> accepted, drop the batch
//   429             -> retry after Retry-After seconds
//   404 / 501       -> endpoint not deployed yet, RETRY with backoff
//   other 4xx       -> permanent, DROP the batch (never retried)
//   5xx / transport -> retry with backoff
//
// The 404 case matters during rollout: the client ships before the server grows
// /v1/ingest, and treating "not deployed yet" as permanent would silently throw
// away everything collected in the meantime. The queue is capped at 5000 lines
// keeping the newest, so retrying an endpoint that never appears is bounded.
//
// Deliberately uses http/https directly rather than axios: this module is on
// the startup path and axios is one of the lazy-loaded modules main.js works
// hard to keep off it.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_BASE_URL = 'https://logs.yuma-homeserver.online';
const REQUEST_TIMEOUT_MS = 20000;

function resolveBaseUrl() {
  return (process.env.CLIPDIP_INGEST_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function resolveIngestKey() {
  if (process.env.CLIPDIP_INGEST_KEY) return process.env.CLIPDIP_INGEST_KEY;
  try {
    const { key } = require('../ingest-key.generated.json');
    if (key) return key;
  } catch {
    /* not generated in this checkout */
  }
  return null;
}

/**
 * @returns {Promise<{outcome:'accepted'|'drop'|'retry', status?:number, retryAfterS?:number, body?:any}>}
 */
function post(pathname, payload, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const key = resolveIngestKey();
  if (!key) return Promise.resolve({ outcome: 'drop', status: 0 });

  let target;
  try {
    target = new URL(pathname, resolveBaseUrl());
  } catch {
    return Promise.resolve({ outcome: 'drop', status: 0 });
  }

  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const useHttps = target.protocol === 'https:';
  const requestFn = useHttps ? https.request : http.request;

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = requestFn(
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port || (useHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-Clipdip-Key': key
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode || 0;
          const text = Buffer.concat(chunks).toString('utf8');
          if (status >= 200 && status < 300) {
            let parsed = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              parsed = null;
            }
            return done({ outcome: 'accepted', status, body: parsed });
          }
          if (status === 429) {
            const raw = res.headers['retry-after'];
            const retryAfterS = raw ? Number.parseInt(String(raw), 10) : null;
            return done({
              outcome: 'retry',
              status,
              retryAfterS: Number.isFinite(retryAfterS) ? retryAfterS : null
            });
          }
          if (status === 404 || status === 501) return done({ outcome: 'retry', status });
          if (status >= 400 && status < 500) return done({ outcome: 'drop', status });
          return done({ outcome: 'retry', status });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      done({ outcome: 'retry', status: 0 });
    });
    req.on('error', () => done({ outcome: 'retry', status: 0 }));
    req.write(body);
    req.end();
  });
}

module.exports = { post, resolveIngestKey, resolveBaseUrl, DEFAULT_BASE_URL };
