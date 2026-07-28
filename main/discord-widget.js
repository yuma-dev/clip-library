// Discord profile widget stats pusher (widgets v2, owner-only experiment).
//
// Pushes library stats to the ClipLib Discord application's identity-profile
// endpoint, which feeds the profile widget configured in the dev portal.
// Discord currently only lets the application OWNER add this widget to their
// profile, so the feature is hard-gated:
//   - it only activates when <userData>/discord-widget.json exists (the bot
//     token lives there, never in the repo or settings.json), and
//   - the locally logged-in Discord user must match ALLOWED_DISCORD_USER_ID,
//     verified via a Discord RPC handshake.
const { app } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

// The widget's Discord application (shared with clipdip's voice integration).
const APPLICATION_ID = '1523640943218000042';
// Only this Discord account may receive pushes (the app owner).
const ALLOWED_DISCORD_USER_ID = '178525733600100352';

const TOKEN_FILE = () => path.join(app.getPath('userData'), 'discord-widget.json');
const ACTIVITY_LOG_DIR = () => path.join(app.getPath('userData'), 'activity_logs');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi']);
// Footage hours are estimated from bytes at a typical clip bitrate; probing
// 2000+ files with ffprobe on every push is not worth the accuracy.
const ASSUMED_MBPS = 20;

const INITIAL_DELAY_MS = 45 * 1000;
const PUSH_INTERVAL_MS = 60 * 60 * 1000;

let getSettings = null;
let timer = null;
let botToken = null;
let userVerified = false;

async function init(getSettingsFn) {
  getSettings = getSettingsFn;

  try {
    const raw = await fs.readFile(TOKEN_FILE(), 'utf8');
    botToken = JSON.parse(raw).botToken || null;
  } catch {
    return; // no token file -> feature disabled on this machine
  }
  if (!botToken) return;

  logger.info('Discord widget: token file found, scheduling stat pushes');
  setTimeout(() => pushSafely(), INITIAL_DELAY_MS);
  timer = setInterval(() => pushSafely(), PUSH_INTERVAL_MS);
}

function destroy() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function pushSafely() {
  try {
    if (!(await verifyLoggedInUser())) return;
    const stats = await gatherStats();
    await pushStats(stats);
    logger.info('Discord widget: stats pushed', { total_clips: stats.total_clips });
  } catch (error) {
    logger.error('Discord widget: push failed:', error);
  }
}

// The RPC handshake's READY payload includes the logged-in user, which is the
// only local way to confirm whose profile the widget would update. Verified
// once per app run; if Discord isn't running yet we retry on the next tick.
async function verifyLoggedInUser() {
  if (userVerified) return true;

  const DiscordRPC = require('discord-rpc');
  const rpc = new DiscordRPC.Client({ transport: 'ipc' });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('RPC handshake timeout')), 10000);
      rpc.on('ready', () => { clearTimeout(timeout); resolve(); });
      rpc.login({ clientId: APPLICATION_ID }).catch((e) => { clearTimeout(timeout); reject(e); });
    });
    const loggedInId = rpc.user && rpc.user.id;
    if (loggedInId === ALLOWED_DISCORD_USER_ID) {
      userVerified = true;
    } else {
      logger.info(`Discord widget: logged-in user ${loggedInId} is not the app owner, skipping`);
    }
  } catch (error) {
    logger.info('Discord widget: could not verify Discord user (client not running?):', error.message);
  } finally {
    try { rpc.destroy(); } catch { /* already closed */ }
  }
  return userVerified;
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(p, out);
    } else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
      try { out.push({ path: p, stat: await fs.stat(p) }); } catch { /* deleted mid-scan */ }
    }
  }
  return out;
}

async function watchedHours() {
  let seconds = 0;
  let files;
  try {
    files = await fs.readdir(ACTIVITY_LOG_DIR());
  } catch {
    return 0;
  }
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue;
    const content = await fs.readFile(path.join(ACTIVITY_LOG_DIR(), name), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'watch_session') seconds += entry.details?.durationSeconds ?? 0;
      } catch { /* corrupt line */ }
    }
  }
  return Math.round(seconds / 3600);
}

// Clips are named "<process name> HH.MM.SS DD.MM.YYYY"; strip the timestamp
// tokens and engine suffixes to get a displayable game name.
function gameOf(filePath) {
  return path.basename(filePath, path.extname(filePath))
    .replace(/(\s+\d{1,2}\.\d{1,2}\.\d{2,4}){1,2}\s*(\(\d+\))?$/, '')
    .replace(/(-Win64|-Win32|-Shipping|-DX\d+|\.exe)+$/gi, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

async function gatherStats() {
  const settings = await getSettings();
  const files = await walk(settings.clipLocation);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const totalBytes = files.reduce((sum, f) => sum + f.stat.size, 0);
  const newest = files.reduce((a, b) => (!a || b.stat.mtimeMs > a.stat.mtimeMs ? b : a), null);

  return {
    total_clips: files.length,
    total_hours: Math.round((totalBytes * 8) / (ASSUMED_MBPS * 1e6) / 3600),
    clips_this_week: files.filter((f) => f.stat.mtimeMs >= weekAgo).length,
    watched_hours: await watchedHours(),
    storage_gb: Math.round(totalBytes / 1e9),
    last_clip_title: newest ? gameOf(newest.path) || path.basename(newest.path) : '—',
  };
}

async function pushStats(stats) {
  // Field types: 1 = string, 2 = number. total_clips goes as a string so the
  // widget shows the full number instead of Discord's "2K" abbreviation.
  const payload = {
    username: 'ClipLib',
    data: {
      dynamic: [
        { type: 1, name: 'total_clips', value: String(stats.total_clips) },
        { type: 2, name: 'total_hours', value: stats.total_hours },
        { type: 2, name: 'clips_this_week', value: stats.clips_this_week },
        { type: 2, name: 'watched_hours', value: stats.watched_hours },
        { type: 2, name: 'storage_gb', value: stats.storage_gb },
        { type: 1, name: 'last_clip_title', value: String(stats.last_clip_title) },
      ],
    },
  };

  const url = `https://discord.com/api/v9/applications/${APPLICATION_ID}/users/${ALLOWED_DISCORD_USER_ID}/identities/0/profile`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${botToken}`,
      'User-Agent': 'DiscordBot (https://github.com/yuma-dev/clip-library, 1.0.0)',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`identity profile PATCH failed: ${response.status} ${await response.text()}`);
  }
}

module.exports = { init, destroy };
