import type { LocalClip } from "../library/types";
import { getGameOfClip, getLibraryGames } from "../library/games";

// what the library shows in Discord. one state wins, strongest first: exporting, sharing, editing,
// watching, browsing. details = top line, state = second line; main adds the button. the big image
// is the state's art (art_* assets on the ClipLib Discord app); the badge is the clip's game icon
// when known, else the state's badge_*. browsing has no badge, its art already carries the logo.

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // matches main.js IDLE_TIMEOUT
/** facts rotate this often while browsing; Discord takes ~5 updates per 20 s */
const FACT_MS = 30_000;
/** editing shows this long after the last trim or layer change */
const EDIT_LINGER_MS = 45_000;

export interface PresencePrefs {
  /** the open clip's name; Private clips never show it */
  clipNames: boolean;
  /** the open clip's game art and name */
  game: boolean;
  /** rotating library facts while browsing */
  facts: boolean;
  /** editing, exporting and sharing states */
  editing: boolean;
}

export const PRESENCE_PREFS_DEFAULTS: PresencePrefs = { clipNames: true, game: true, facts: true, editing: true };

export interface PresenceActivity {
  /** 0 playing (default), 3 watching: with start + end Discord draws its own progress bar */
  type?: number;
  details: string;
  state?: string | null;
  largeImageKey: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageText?: string;
  startTimestamp?: number;
  endTimestamp?: number;
}

type EditKind = "trim" | "text" | "subtitles" | "media" | "effects";
const EDIT_LABEL: Record<EditKind, string> = {
  trim: "Trimming",
  text: "Adding text",
  subtitles: "Adding subtitles",
  media: "Adding images and gifs",
  effects: "Adding effects",
};

interface PresenceClip {
  originalName: string;
  customName: string;
  tags?: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const legacyState = (): any => (window as any).legacyState;
/* eslint-enable @typescript-eslint/no-explicit-any */

const videoEl = (): HTMLVideoElement | null =>
  document.getElementById("video-player") as HTMLVideoElement | null;

// mirrors settings.enableDiscordRPC, seeded in init, flipped via setDiscordPresenceEnabled
let enabled = false;
let prefs: PresencePrefs = PRESENCE_PREFS_DEFAULTS;
let lastActivityTime = Date.now();
let library: LocalClip[] = [];
let folderBytes: number | null = null;
let factIndex = 0;
let editing: { kind: EditKind; until: number } | null = null;
let editTimer: ReturnType<typeof setTimeout> | undefined;
let exportPct: number | null = null;
let sharePhase: string | null = null;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)));
  return `${Math.round(bytes / 1024 ** i)} ${units[i]}`;
}

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

// last payload sent; identical consecutive updates are dropped. player open + video
// 'play'/pause/close all fire presence at once, doubling every IPC in perf traces
let lastSent: string | null = null;

function send(activity: PresenceActivity): void {
  if (!enabled) return;
  const key = JSON.stringify(activity);
  if (key === lastSent) return;
  lastSent = key;
  void window.clips.updateDiscordPresence(activity);
}

// dev: window.__presence() returns the last activity sent, Discord itself can't be read back
if (import.meta.env.DEV) {
  (window as unknown as { __presence?: () => unknown }).__presence = () => (lastSent ? JSON.parse(lastSent) : null);
}

/** forgets the last payload so the next update always goes through, used after presence was cleared outside this module */
function resetPresenceDedupe(): void {
  lastSent = null;
}

function libraryFacts(): string[] {
  const clips = library;
  if (clips.length === 0) return [];
  const now = Date.now();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  let today = 0;
  let week = 0;
  let favorites = 0;
  let oldest = Infinity;
  const tags = new Set<string>();
  for (const c of clips) {
    if (c.createdAt >= startOfDay.getTime()) today++;
    if (now - c.createdAt <= 7 * 86_400_000) week++;
    if (c.isFavorite) favorites++;
    if (c.createdAt > 0 && c.createdAt < oldest) oldest = c.createdAt;
    for (const t of c.tags ?? []) if (t !== "Private") tags.add(t);
  }
  const out = [plural(clips.length, "clip")];
  if (today > 0) out.push(`${today.toLocaleString("en-US")} clipped today`);
  else if (week > 0) out.push(`${week.toLocaleString("en-US")} clipped this week`);
  if (favorites > 0) out.push(plural(favorites, "favorite"));
  if (folderBytes) out.push(`${formatBytes(folderBytes)} of clips`);
  if (Number.isFinite(oldest)) {
    out.push(`Clipping since ${new Date(oldest).toLocaleDateString("en-US", { month: "long", year: "numeric" })}`);
  }
  if (prefs.game) {
    const games = getLibraryGames();
    if (games[0]) out.push(`Mostly ${games[0].name}`);
    if (games.length > 1) out.push(`Clips from ${games.length} games`);
  }
  if (tags.size > 0) out.push(plural(tags.size, "tag"));
  return out;
}

function browseActivity(): PresenceActivity {
  const facts = prefs.facts ? libraryFacts() : [];
  const total = library.length;
  return {
    details: "Browsing clips",
    state: facts.length ? facts[factIndex % facts.length] : null,
    largeImageKey: "art_browse",
    largeImageText: total ? `${plural(total, "clip")}${folderBytes ? ` · ${formatBytes(folderBytes)}` : ""}` : "ClipLib",
  };
}

const isPrivate = (clip: PresenceClip) => Boolean(clip.tags?.includes("Private"));

/** the clip's game, when shown and known */
function gameOf(clip: PresenceClip): { name: string; art: string | null } | null {
  if (!prefs.game || isPrivate(clip)) return null;
  const id = getGameOfClip().get(clip.originalName);
  const g = id ? getLibraryGames().find((x) => x.id === id) : undefined;
  return g ? { name: g.name, art: g.icon_url } : null;
}

const clipTitle = (clip: PresenceClip, fallback: string) =>
  prefs.clipNames && !isPrivate(clip) ? clip.customName : fallback;

/** the game's icon as the badge, or the state's own badge when the clip has no known game */
function badge(clip: PresenceClip | undefined, key: string, text: string): Pick<PresenceActivity, "smallImageKey" | "smallImageText"> {
  const game = clip ? gameOf(clip) : null;
  return game?.art ? { smallImageKey: game.art, smallImageText: game.name } : { smallImageKey: key, smallImageText: text };
}

// playing: a Watching activity with start + end, Discord moves the progress bar itself, so there
// is nothing to send until play, pause, a seek or a speed change. paused: the position as text.
function watchActivity(clip: PresenceClip, video: HTMLVideoElement): PresenceActivity {
  const playing = !video.paused;
  const game = gameOf(clip);
  const base = {
    type: 3,
    details: clipTitle(clip, "Watching a clip"),
    largeImageKey: "art_watch",
    largeImageText: playing ? "Watching a clip" : "Paused",
    ...badge(clip, playing ? "badge_play_filled" : "badge_pause_filled", playing ? "Playing" : "Paused"),
  };
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (!playing || duration <= 0) {
    return { ...base, state: `Paused at ${formatTime(video.currentTime)}/${formatTime(duration)}` };
  }
  const rate = video.playbackRate > 0 ? video.playbackRate : 1;
  const start = Date.now() - (video.currentTime / rate) * 1000;
  return {
    ...base,
    state: game ? `A ${game.name} clip` : null,
    startTimestamp: Math.round(start),
    endTimestamp: Math.round(start + (duration / rate) * 1000),
  };
}

function editActivity(clip: PresenceClip, kind: EditKind): PresenceActivity {
  return {
    details: "Editing a clip",
    state: EDIT_LABEL[kind],
    largeImageKey: "art_edit",
    largeImageText: EDIT_LABEL[kind],
    ...badge(clip, kind === "trim" ? "badge_edit_scissors" : "badge_edit", EDIT_LABEL[kind]),
  };
}

function exportActivity(pct: number): PresenceActivity {
  const clip = legacyState()?.currentClip as PresenceClip | undefined;
  return {
    details: "Exporting a clip",
    state: `${pct}% done`,
    largeImageKey: "art_edit",
    largeImageText: "Exporting",
    ...badge(clip, "badge_export", "Exporting"),
  };
}

function shareActivity(phase: string): PresenceActivity {
  const clip = legacyState()?.currentClip as PresenceClip | undefined;
  return {
    details: "Sharing a clip",
    state: phase === "uploading" ? "Uploading" : "Getting it ready",
    largeImageKey: "art_watch",
    largeImageText: "Sharing",
    ...badge(clip, "badge_share", "Sharing"),
  };
}

/** builds the activity for whatever is going on right now and sends it if it changed */
function refresh(): void {
  if (!enabled) return;
  if (prefs.editing && exportPct !== null) return send(exportActivity(exportPct));
  if (prefs.editing && sharePhase !== null) return send(shareActivity(sharePhase));
  const clip = legacyState()?.currentClip as PresenceClip | undefined;
  const video = videoEl();
  if (clip && video) {
    if (prefs.editing && editing && editing.until > Date.now()) return send(editActivity(clip, editing.kind));
    return send(watchActivity(clip, video));
  }
  send(browseActivity());
}

// the old per-call API stays for the legacy player's callbacks

/** legacy `updateDiscordPresence(details, state)`: only its "Browsing clips" on close matters,
 * its post-trim "Editing a clip" fires as the player closes and would linger */
export function updateDiscordPresence(details: string, _state: string | null = null): void {
  if (details === "Browsing clips") {
    editing = null;
    refresh();
  }
}

/** Per-clip presence on open, play, pause, seek and speed change. No ticker: Discord draws the
 * progress from the activity's timestamps. */
export function updateDiscordPresenceForClip(_clip: PresenceClip, _isPlaying = true): void {
  const state = legacyState();
  if (!state || !enabled) return;
  // an interval from an older build would still tick here
  clearInterval(state.discordPresenceInterval);
  refresh();
}

// startup tag batches change the clip list several times within ~1s; trailing debounce coalesces them
let browseDebounce: ReturnType<typeof setTimeout> | undefined;

/** Presence for the current view: open clip if any, else grid browsing. */
export function updateDiscordPresenceBasedOnState(): void {
  const state = legacyState();
  if (!state || !enabled) return;
  clearTimeout(browseDebounce);
  if (state.currentClip && videoEl()) {
    updateDiscordPresenceForClip(state.currentClip, !videoEl()!.paused);
  } else {
    browseDebounce = setTimeout(refresh, 1_000);
  }
}

/** the whole library, not the filtered grid; facts are about everything */
export function setPresenceLibrary(clips: LocalClip[]): void {
  library = clips;
}

export function setPresencePrefs(next: Partial<PresencePrefs> | null | undefined): void {
  prefs = { ...PRESENCE_PREFS_DEFAULTS, ...(next ?? {}) };
  refresh();
}

/** a trim drag or layer change; editing shows until EDIT_LINGER_MS after the last one */
export function markEditing(kind: EditKind): void {
  editing = { kind, until: Date.now() + EDIT_LINGER_MS };
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    editing = null;
    refresh();
  }, EDIT_LINGER_MS + 50);
  refresh();
}

/** 0..100 while an export runs, null when done; steps of 10 keep Discord's rate limit happy */
export function setExportProgress(pct: number | null): void {
  const next = pct === null || pct >= 100 ? null : Math.floor(pct / 10) * 10;
  if (next === exportPct) return;
  exportPct = next;
  refresh();
}

/** share modal phase while it exports and uploads, null otherwise */
export function setSharePhase(phase: "exporting" | "uploading" | null): void {
  if (phase === sharePhase) return;
  sharePhase = phase;
  refresh();
}

/** settings toggle hook, refreshes presence immediately when re-enabled */
export function setDiscordPresenceEnabled(value: boolean): void {
  enabled = value;
  const state = legacyState();
  if (state?.settings) state.settings.enableDiscordRPC = value;
  resetPresenceDedupe();
  if (value) updateDiscordPresenceBasedOnState();
}

function fetchFolderSize(): void {
  window.clips
    .getClipsFolderSize()
    .then((res: { bytes?: number } | null) => {
      if (typeof res?.bytes === "number") folderBytes = res.bytes;
    })
    .catch(() => {});
}

let initialized = false;

/** seeds enabled + prefs from settings, publishes the first presence, tracks activity for the
 * idle clear, re-asserts presence on main's check-activity-state (focus/unlock) */
export function initDiscordPresence(): void {
  if (initialized) return;
  initialized = true;

  window.clips
    .getSettings()
    .then((s: { enableDiscordRPC?: boolean; discordPresence?: Partial<PresencePrefs> } | null) => {
      enabled = Boolean(s?.enableDiscordRPC);
      prefs = { ...PRESENCE_PREFS_DEFAULTS, ...(s?.discordPresence ?? {}) };
      if (enabled) updateDiscordPresenceBasedOnState();
    })
    .catch(() => {});

  // main caches the folder walk; the size is only a fact, a slow refresh is plenty
  setTimeout(fetchFolderSize, 10_000);
  setInterval(fetchFolderSize, 10 * 60_000);

  setInterval(() => {
    factIndex++;
    const state = legacyState();
    if (enabled && !(state?.currentClip && videoEl())) refresh();
  }, FACT_MS);

  const onActivity = () => {
    lastActivityTime = Date.now();
  };
  document.addEventListener("mousemove", onActivity);
  document.addEventListener("keydown", onActivity);

  // clears presence after 5 min without input while nothing plays; main runs its own 5-min clear on blur/lock
  setInterval(() => {
    if (!enabled) return;
    const video = videoEl();
    const playing = video ? !video.paused : false;
    if (Date.now() - lastActivityTime > IDLE_TIMEOUT_MS && !playing && exportPct === null) {
      resetPresenceDedupe();
      void window.clips.clearDiscordPresence();
    }
  }, 60_000);

  window.clips.onCheckActivityState(() => {
    if (!enabled) return;
    const video = videoEl();
    const playing = video ? !video.paused : false;
    if (Date.now() - lastActivityTime <= IDLE_TIMEOUT_MS || playing) {
      // main may have cleared presence while blurred/locked; force the re-assert even if payload
      // matches last send
      resetPresenceDedupe();
      updateDiscordPresenceBasedOnState();
    }
  });
}
