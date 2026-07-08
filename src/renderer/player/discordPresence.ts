import type { LocalClip } from "../library/types";

// Discord Rich Presence — port of legacy/renderer/discord-manager.js.
//
// Presence lines are composed here and pushed via `update-discord-presence`
// (details = top line, state = bottom line; main adds the logo + GitHub
// button). While a public clip plays, a 1s ticker refreshes the elapsed/total
// "M:SS/M:SS" state line. The ticker interval id is stored on the shared
// legacy state (`state.discordPresenceInterval`) because the legacy player's
// closePlayer() clears it there; `clipStartTime`/`elapsedTime` also live on
// legacy state because the player writes `elapsedTime` on seek.

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

// Gate flag — mirrors settings.enableDiscordRPC (seeded in init, flipped by
// the Settings toggle via setDiscordPresenceEnabled).
let enabled = false;
let lastActivityTime = Date.now();

function formatTime(seconds: number): string {
  if (Number.isNaN(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function updateDiscordPresence(details: string, presenceState: string | null = null): void {
  if (!enabled) return;
  void window.clips.updateDiscordPresence(details, presenceState);
}

/** Per-clip presence: title + live elapsed/total; Private clips hide the title. */
export function updateDiscordPresenceForClip(clip: PresenceClip, isPlaying = true): void {
  const state = legacyState();
  const video = videoEl();
  if (!state || !video || !enabled) return;
  clearInterval(state.discordPresenceInterval);

  if (clip.tags && clip.tags.includes("Private")) {
    updateDiscordPresence("Download Clip Library now!", "");
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

/** Presence for the current view: open clip if any, else grid browsing. */
export function updateDiscordPresenceBasedOnState(): void {
  const state = legacyState();
  if (!state || !enabled) return;
  const video = videoEl();
  if (state.currentClip && video) {
    updateDiscordPresenceForClip(state.currentClip, !video.paused);
  } else {
    const list = (state.currentClipList ?? []) as LocalClip[];
    const publicCount = list.filter((c) => !(c.tags ?? []).includes("Private")).length;
    updateDiscordPresence("Browsing clips", `Total: ${publicCount}`);
  }
}

/** Settings toggle hook — refreshes presence immediately when re-enabled. */
export function setDiscordPresenceEnabled(value: boolean): void {
  enabled = value;
  const state = legacyState();
  if (state?.settings) state.settings.enableDiscordRPC = value;
  if (value) updateDiscordPresenceBasedOnState();
}

let initialized = false;

/**
 * One-time wiring: seed the enabled flag from settings, publish the initial
 * "Browsing clips" presence, track user activity for the 60s idle poll, and
 * answer main's `check-activity-state` (sent on window focus / screen unlock)
 * by re-asserting presence when the user is active or a clip is playing.
 */
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

  // Idle: clear presence after 5 min without input while nothing plays.
  // (Main runs its own 5-min clear on window blur / screen lock.)
  setInterval(() => {
    if (!enabled) return;
    const video = videoEl();
    const playing = video ? !video.paused : false;
    if (Date.now() - lastActivityTime > IDLE_TIMEOUT_MS && !playing) {
      void window.clips.clearDiscordPresence();
    }
  }, 60_000);

  window.clips.onCheckActivityState(() => {
    if (!enabled) return;
    const video = videoEl();
    const playing = video ? !video.paused : false;
    if (Date.now() - lastActivityTime <= IDLE_TIMEOUT_MS || playing) {
      updateDiscordPresenceBasedOnState();
    }
  });
}
