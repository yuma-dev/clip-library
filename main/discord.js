const DiscordRPC = require('discord-rpc');
const logger = require('../utils/logger');
const clipdip = require('./clipdip');

// the ClipLib app, shared with clipdip's game presence and voice roster; it has the `logo` asset
const CLIENT_ID = '1523640943218000042';
// clipdip shows "Playing <game>" under this same Discord app while a game runs; the library's
// "Browsing clips" steps aside then, two pipes on one app would fight over the activity
const GAME_POLL_MS = 15000;

// Discord takes ~5 activity updates per 20 s (Game SDK docs; the old RPC docs say one per 15 s) and
// silently drops the rest, which is what made presence feel slow. Important changes (a new state,
// image or badge, play/pause, a seek) go out at once while the budget lasts; text-only changes
// (rotating facts, export percent) wait until SLOW_MS after the last send. Newest always wins.
const BUDGET = 5;
const WINDOW_MS = 20000;
const SLOW_MS = 15000;
const BUTTONS = [{ label: 'Get ClipLib', url: 'https://cliplib.app' }];

let rpc = null;
let rpcReady = false;
let getSettings = null;
// what the library wants shown; kept while Discord isn't connected yet and while a game shows
let desired = null;
let yielded = false;
let gamePoll = null;
// what Discord has (null = cleared), the pending update, and recent send times for the budget
let shown = null;
let pending = null;
let sentAt = [];
let pumpTimer = null;

async function checkGamePresence() {
  if (!rpcReady || !rpc) return;
  const res = await clipdip.control('game_status').catch(() => null);
  const gameShowing = Boolean(res?.ok && res.presence);
  if (gameShowing !== yielded) {
    yielded = gameShowing;
    apply();
  }
}

async function initDiscordRPC(getSettingsFn) {
  getSettings = getSettingsFn;

  const settings = await getSettings();
  if (!settings || !settings.enableDiscordRPC) {
    return;
  }

  if (rpc) {
    return;
  }

  rpc = new DiscordRPC.Client({ transport: 'ipc' });

  rpc.on('ready', async () => {
    logger.info('Discord RPC connected successfully');
    rpcReady = true;
    shown = null;
    sentAt = [];
    await checkGamePresence();
    if (!desired) desired = buildActivity({ details: 'Browsing clips', largeImageKey: 'art_browse' });
    apply();
    clearInterval(gamePoll);
    gamePoll = setInterval(() => void checkGamePresence(), GAME_POLL_MS);
  });

  rpc.login({ clientId: CLIENT_ID }).catch((error) => {
    logger.error('Failed to initialize Discord RPC:', error);
  });
}

// Discord rejects text fields outside 2..128 chars, a one-letter clip name would drop the whole update
function fitText(value) {
  if (value === null || value === undefined) return undefined;
  const s = String(value).slice(0, 128);
  return s.length >= 2 ? s : s.padEnd(2, ' ');
}

const toMs = (v) => {
  const n = v instanceof Date ? v.getTime() : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};

/** raw SET_ACTIVITY activity; discord-rpc's setActivity drops `type`, Watching (3) needs it */
function buildActivity(spec) {
  const activity = {
    type: Number.isInteger(spec.type) ? spec.type : 0,
    details: fitText(spec.details),
    assets: {
      large_image: spec.largeImageKey || 'logo',
      large_text: fitText(spec.largeImageText ?? 'ClipLib'),
    },
    buttons: BUTTONS,
    instance: false,
  };
  if (spec.state !== null && spec.state !== undefined) activity.state = fitText(spec.state);
  if (spec.smallImageKey) {
    activity.assets.small_image = spec.smallImageKey;
    activity.assets.small_text = fitText(spec.smallImageText);
  }
  const start = toMs(spec.startTimestamp);
  const end = toMs(spec.endTimestamp);
  if (start || end) activity.timestamps = { ...(start ? { start } : {}), ...(end ? { end } : {}) };
  return activity;
}

// a seek moves the timestamps by seconds; recomputing them on a play event drifts by milliseconds
const DRIFT_MS = 1500;
const near = (a, b) => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && Math.abs(a - b) <= DRIFT_MS);

function sameTimestamps(a, b) {
  const x = a?.timestamps;
  const y = b?.timestamps;
  if (!x || !y) return !x && !y;
  return near(x.start, y.start) && near(x.end, y.end);
}

function sameActivity(a, b) {
  if (!a || !b) return a === b;
  const strip = (v) => JSON.stringify({ ...v, timestamps: undefined });
  return strip(a) === strip(b) && sameTimestamps(a, b);
}

function importantChange(prev, next) {
  if (!prev || !next) return true;
  return (
    prev.type !== next.type ||
    prev.details !== next.details ||
    prev.assets.large_image !== next.assets.large_image ||
    prev.assets.small_image !== next.assets.small_image ||
    !sameTimestamps(prev, next)
  );
}

/** queues `activity` (null clears) under the rate budget */
function want(activity) {
  if (sameActivity(activity, shown)) {
    pending = null;
    clearTimeout(pumpTimer);
    return;
  }
  pending = { activity, important: importantChange(shown, activity) };
  pump();
}

function pump() {
  clearTimeout(pumpTimer);
  if (!pending || !rpcReady || !rpc) return;
  const now = Date.now();
  sentAt = sentAt.filter((t) => now - t < WINDOW_MS);
  let at = now;
  if (sentAt.length >= BUDGET) at = sentAt[0] + WINDOW_MS;
  if (!pending.important && sentAt.length > 0) at = Math.max(at, sentAt[sentAt.length - 1] + SLOW_MS);
  if (at > now) {
    pumpTimer = setTimeout(pump, at - now + 20);
    return;
  }
  const { activity } = pending;
  pending = null;
  sentAt.push(now);
  shown = activity;
  const args = activity ? { pid: process.pid, activity } : { pid: process.pid };
  rpc.request('SET_ACTIVITY', args).catch((error) => {
    logger.error('Failed to update Discord presence:', error);
    // let the next update retry instead of being deduped against a send that never landed
    shown = null;
  });
}

function apply() {
  want(yielded ? null : desired);
}

// the renderer sends a full activity ({type, details, state, largeImageKey, largeImageText,
// smallImageKey, smallImageText, startTimestamp, endTimestamp}); the old (details, state,
// startTimestamp) form still works
async function updateDiscordPresence(details, state = null, startTimestamp = null) {
  const spec = details && typeof details === 'object' ? details : { details, state, startTimestamp };
  desired = buildActivity(spec);
  const settings = getSettings ? await getSettings() : null;
  if (!rpcReady || !settings || !settings.enableDiscordRPC) return;
  apply();
}

function clearDiscordPresence() {
  desired = null;
  if (rpcReady && rpc) apply();
}

function destroyDiscordRPC() {
  desired = null;
  pending = null;
  shown = null;
  sentAt = [];
  clearTimeout(pumpTimer);
  clearInterval(gamePoll);
  gamePoll = null;
  yielded = false;
  if (!rpc) {
    rpcReady = false;
    return;
  }

  try {
    rpc.destroy();
  } catch (error) {
    logger.error('Error destroying Discord RPC client:', error);
  } finally {
    rpc = null;
    rpcReady = false;
  }
}

module.exports = {
  initDiscordRPC,
  updateDiscordPresence,
  clearDiscordPresence,
  destroyDiscordRPC
};
