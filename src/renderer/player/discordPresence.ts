import type { LocalClip } from "../library/types";

// port of legacy/renderer/discord-manager.js. details = top line, state = bottom line (main adds
// logo + button). ticker interval lives on state.discordPresenceInterval (legacy closePlayer
// clears it there); clipStartTime/elapsedTime also live on legacy state (player writes elapsedTime on seek)

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // matches main.js IDLE_TIMEOUT

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
let lastActivityTime = Date.now();

function formatTime(seconds: number): string {
  if (Number.isNaN(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// last payload sent; identical consecutive updates are dropped. player open + video
// 'play'/pause/close all fire presence at once, doubling every IPC in perf traces
let lastSent: { details: string; state: string | null } | null = null;

/** forgets the last payload so the next update always goes through, used after presence was cleared outside this module */
function resetPresenceDedupe(): void {
  lastSent = null;
}

export function updateDiscordPresence(details: string, presenceState: string | null = null): void {
  if (!enabled) return;
  if (lastSent && lastSent.details === details && lastSent.state === presenceState) return;
  lastSent = { details, state: presenceState };
  void window.clips.updateDiscordPresence(details, presenceState);
}

/** Per-clip presence: title + live elapsed/total; Private clips hide the title. */
export function updateDiscordPresenceForClip(clip: PresenceClip, isPlaying = true): void {
  const state = legacyState();
  const video = videoEl();
  if (!state || !video || !enabled) return;
  clearInterval(state.discordPresenceInterval);

  if (clip.tags && clip.tags.includes("Private")) {
    updateDiscordPresence("Download ClipLib now!", "");
    return;
  }

  if (isPlaying) state.clipStartTime = Date.now() - (state.elapsedTime ?? 0) * 1000;
  const tick = () => {
    if (isPlaying) state.elapsedTime = Math.floor((Date.now() - state.clipStartTime) / 1000);
    const total = Math.floor(video.duration) || 0;
    updateDiscordPresence(clip.customName, `${formatTime(state.elapsedTime ?? 0)}/${formatTime(total)}`);
  };
  tick();
  if (isPlaying) state.discordPresenceInterval = setInterval(tick, 1000);
}

// startup tag batches change the clip list several times within ~1s, each distinct "Total: N"
// defeats the dedupe; trailing debounce coalesces them
let browseDebounce: ReturnType<typeof setTimeout> | undefined;

/** Presence for the current view: open clip if any, else grid browsing. */
export function updateDiscordPresenceBasedOnState(): void {
  const state = legacyState();
  if (!state || !enabled) return;
  const video = videoEl();
  if (state.currentClip && video) {
    clearTimeout(browseDebounce);
    updateDiscordPresenceForClip(state.currentClip, !video.paused);
  } else {
    clearTimeout(browseDebounce);
    browseDebounce = setTimeout(() => {
      const s = legacyState();
      if (!s || !enabled || s.currentClip) return;
      const list = (s.currentClipList ?? []) as LocalClip[];
      const publicCount = list.filter((c) => !(c.tags ?? []).includes("Private")).length;
      updateDiscordPresence("Browsing clips", `Total: ${publicCount}`);
    }, 1_000);
  }
}

/** settings toggle hook, refreshes presence immediately when re-enabled */
export function setDiscordPresenceEnabled(value: boolean): void {
  enabled = value;
  const state = legacyState();
  if (state?.settings) state.settings.enableDiscordRPC = value;
  resetPresenceDedupe();
  if (value) updateDiscordPresenceBasedOnState();
}

let initialized = false;

/** seeds enabled from settings, publishes initial "Browsing clips", tracks activity for the 60s
 * idle poll, and re-asserts presence on main's check-activity-state (focus/unlock) */
export function initDiscordPresence(): void {
  if (initialized) return;
  initialized = true;

  window.clips
    .getSettings()
    .then((s: { enableDiscordRPC?: boolean } | null) => {
      enabled = Boolean(s?.enableDiscordRPC);
      if (enabled) updateDiscordPresenceBasedOnState();
    })
    .catch(() => {});

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
    if (Date.now() - lastActivityTime > IDLE_TIMEOUT_MS && !playing) {
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
