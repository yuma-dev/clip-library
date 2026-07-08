import { useSyncExternalStore } from "react";
import {
  enableGridNavigation,
  getVisibleCards,
  isGridNavigationEnabled,
  moveGridSelection,
  openCurrentGridSelection,
  type GridDirection,
} from "../library/gridNavigation";

// Gamepad support — port of legacy/renderer/gamepad-manager.js.
//
// A 16ms poll loop reads connected pads. Buttons are edge-triggered and mapped
// through `controller.buttonMappings` (settings) over the Xbox-layout default
// below. Context routing matches legacy: player overlay open → playback
// controls; grid view → d-pad drives grid navigation, A opens, B/Start-combo
// raise a quit confirm. Right stick seeks/changes volume in the player and
// scrolls the grid outside it.

type GamepadAction =
  | "playPause"
  | "closePlayer"
  | "exportDefault"
  | "fullscreen"
  | "navigatePrev"
  | "navigateNext"
  | "setTrimStart"
  | "setTrimEnd"
  | "focusTitle"
  | "exportVideo"
  | "volumeUp"
  | "volumeDown"
  | "skipBackward"
  | "skipForward"
  | "quitApp"
  | null;

// Xbox layout: A B X Y LB RB LT RT Back Start LS RS DUp DDown DLeft DRight.
const DEFAULT_BUTTON_MAPPINGS: Record<number, GamepadAction> = {
  0: "playPause",
  1: "closePlayer",
  2: "exportDefault",
  3: "fullscreen",
  4: "navigatePrev",
  5: "navigateNext",
  6: "setTrimStart",
  7: "setTrimEnd",
  8: "focusTitle",
  9: "exportVideo",
  10: null,
  11: null,
  12: "volumeUp",
  13: "volumeDown",
  14: "skipBackward",
  15: "skipForward",
};

// Left stick: discrete grid nav (must re-cross the deadzone to repeat).
// Right stick: continuous seek / volume. Deadzones are the effective legacy
// runtime values (the settings analogMappings block was never applied).
const LEFT_STICK = { x: 0, y: 1, deadzone: 0.4 };
const RIGHT_STICK = { x: 2, y: 3, deadzone: 0.2 };

interface GamepadDeps {
  navigateToVideo(direction: number): void;
  exportDefault(): void;
  exportVideo(): void;
  /** React confirm dialog (quit prompt). Resolves true to quit. */
  confirm(options: {
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }): Promise<boolean>;
}

let deps: GamepadDeps | null = null;

// Tunables (overridden by settings.controller).
let seekSensitivity = 0.5; // seconds of video per second of full stick deflection… × stick value
let volumeSensitivity = 0.1;
let buttonMappings: Record<number, GamepadAction> = { ...DEFAULT_BUTTON_MAPPINGS };
let managerEnabled = true;

// --- Connection store (drives the React indicator chip) ---
interface ConnectionState {
  connected: boolean;
  id: string | null;
}
let connection: ConnectionState = { connected: false, id: null };
const connListeners = new Set<() => void>();
function setConnection(next: ConnectionState): void {
  connection = next;
  if (window.legacyState) window.legacyState.isGamepadActive = next.connected;
  for (const l of connListeners) l();
}
export function useGamepadConnection(): ConnectionState {
  return useSyncExternalStore(
    (cb) => {
      connListeners.add(cb);
      return () => connListeners.delete(cb);
    },
    () => connection,
  );
}

// --- Poll state ---
const connectedPads = new Set<number>();
const lastButtons = new Map<number, boolean[]>();
const lastSticks = new Map<number, { x: number; y: number }>();
let lastQuitCombo = false;
let lastAnalogTime = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function playerActive(): boolean {
  const overlay = document.getElementById("player-overlay");
  return Boolean(overlay && overlay.style.display === "block");
}

function videoEl(): HTMLVideoElement | null {
  return document.getElementById("video-player") as HTMLVideoElement | null;
}

function gridScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".route-host:not(.hidden) .clip-scroll");
}

// --- Quit confirm (React dialog; A confirms, B cancels while open) ---
let quitConfirmOpen = false;
async function showQuitConfirm(): Promise<void> {
  if (quitConfirmOpen || !deps) return;
  quitConfirmOpen = true;
  try {
    const ok = await deps.confirm({
      title: "Quit Clip Library?",
      message: "Close the app now?",
      confirmLabel: "Quit (A)",
      cancelLabel: "Cancel (B)",
    });
    if (ok) await window.clips.quitApp();
  } finally {
    quitConfirmOpen = false;
  }
}
function clickModalButton(selector: string): void {
  document.querySelector<HTMLButtonElement>(`.modal-backdrop ${selector}`)?.click();
}

// --- Action routing (edge-triggered button presses) ---
function handleAction(action: Exclude<GamepadAction, null>): void {
  const lp = window.legacyPlayer;

  if (quitConfirmOpen) {
    if (action === "playPause") clickModalButton(".btn-primary");
    else if (action === "closePlayer") clickModalButton(".btn-ghost");
    return;
  }

  if (playerActive() && lp) {
    lp.showControls?.();
    switch (action) {
      case "playPause":
        if (videoEl()?.src) lp.togglePlayPause?.();
        break;
      case "closePlayer":
        // Exit fullscreen first; a second press closes (legacy behavior).
        if (lp.isVideoInFullscreen?.(videoEl())) lp.toggleFullscreen?.();
        else void lp.closePlayer?.();
        break;
      case "navigatePrev":
        deps?.navigateToVideo(-1);
        break;
      case "navigateNext":
        deps?.navigateToVideo(1);
        break;
      case "skipBackward":
        lp.skipTime?.(-1);
        break;
      case "skipForward":
        lp.skipTime?.(1);
        break;
      case "volumeUp":
        lp.changeVolume?.(0.1);
        break;
      case "volumeDown":
        lp.changeVolume?.(-0.1);
        break;
      case "exportDefault":
        deps?.exportDefault();
        break;
      case "exportVideo":
        deps?.exportVideo();
        break;
      case "fullscreen":
        lp.toggleFullscreen?.();
        break;
      case "setTrimStart":
        lp.setTrimPoint?.("start");
        break;
      case "setTrimEnd":
        lp.setTrimPoint?.("end");
        break;
      case "focusTitle":
        (document.getElementById("clip-title") as HTMLInputElement | null)?.focus();
        break;
      default:
        break;
    }
    return;
  }

  // Grid context.
  switch (action) {
    case "closePlayer":
    case "quitApp":
      void showQuitConfirm();
      break;
    case "playPause":
    case "exportDefault":
      // First press summons the focus ring; the next one opens the selection.
      if (!isGridNavigationEnabled()) enableGridNavigation();
      else openCurrentGridSelection();
      break;
    case "volumeUp":
      gridMove("up");
      break;
    case "volumeDown":
      gridMove("down");
      break;
    case "skipBackward":
      gridMove("left");
      break;
    case "skipForward":
      gridMove("right");
      break;
    default:
      break;
  }
}

function gridMove(direction: GridDirection): void {
  if (!isGridNavigationEnabled()) enableGridNavigation();
  else moveGridSelection(direction);
}

// --- Analog routing ---
// NOTE: the legacy per-tick amounts (x * sensitivity * dt ≈ 0.008) could never
// pass legacy's own >0.1 apply-gate, so stick seek/volume were dead in the old
// renderer. Implemented usably here: full deflection ≈ sensitivity × 10 per
// second (default 5 s/s seek, 1.0/s volume), still scaled by the settings keys.
function handleSeek(amount: number): void {
  const video = videoEl();
  if (!video || !Number.isFinite(video.duration)) return;
  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + amount));
  window.legacyPlayer?.showControls?.();
}

function processAnalog(pad: Gamepad): void {
  const now = performance.now();
  const dt = lastAnalogTime ? Math.min((now - lastAnalogTime) / 1000, 0.1) : 0.016;
  lastAnalogTime = now;

  const rx = pad.axes[RIGHT_STICK.x] ?? 0;
  const ry = pad.axes[RIGHT_STICK.y] ?? 0;
  const inPlayer = playerActive();

  // Right stick: seek / volume in the player, scroll in the grid.
  if (Math.abs(rx) > RIGHT_STICK.deadzone) {
    if (inPlayer) handleSeek(rx * seekSensitivity * 10 * dt);
    else if (Math.abs(rx) > 0.3) gridScroller()?.scrollBy({ left: rx * 15 });
  }
  if (Math.abs(ry) > RIGHT_STICK.deadzone) {
    if (inPlayer) {
      window.legacyPlayer?.changeVolume?.(-ry * volumeSensitivity * 10 * dt);
    } else if (Math.abs(ry) > 0.3) {
      gridScroller()?.scrollBy({ top: ry * 15 });
    }
  }

  // Left stick: discrete grid navigation, edge-triggered on deadzone crossing
  // (must return inside the deadzone before it fires again — legacy behavior).
  const lx = pad.axes[LEFT_STICK.x] ?? 0;
  const ly = pad.axes[LEFT_STICK.y] ?? 0;
  const last = lastSticks.get(pad.index) ?? { x: 0, y: 0 };
  const dz = LEFT_STICK.deadzone;
  if (!inPlayer) {
    if (Math.abs(lx) > dz && Math.abs(last.x) <= dz) gridMove(lx > 0 ? "right" : "left");
    if (Math.abs(ly) > dz && Math.abs(last.y) <= dz) gridMove(ly > 0 ? "down" : "up");
  }
  lastSticks.set(pad.index, { x: lx, y: ly });
}

// --- Poll loop ---
function pollPads(): void {
  const pads = navigator.getGamepads();
  for (const index of connectedPads) {
    const pad = pads[index];
    if (!pad) continue;

    // Quit combo: Back + Start together.
    const combo = Boolean(pad.buttons[8]?.pressed && pad.buttons[9]?.pressed);
    if (combo && !lastQuitCombo) handleAction("quitApp");
    lastQuitCombo = combo;

    const last = lastButtons.get(index) ?? [];
    pad.buttons.forEach((button, i) => {
      const pressed = button.pressed;
      if (pressed && !last[i] && !combo) {
        const action = buttonMappings[i];
        if (action) handleAction(action);
      }
      last[i] = pressed;
    });
    lastButtons.set(index, last);

    processAnalog(pad);
  }
}

function startPolling(): void {
  if (pollTimer || !managerEnabled || connectedPads.size === 0) return;
  lastAnalogTime = 0;
  pollTimer = setInterval(pollPads, 16);
}
function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function onConnected(pad: Gamepad): void {
  connectedPads.add(pad.index);
  lastButtons.set(pad.index, []);
  lastSticks.set(pad.index, { x: 0, y: 0 });
  setConnection({ connected: true, id: pad.id });
  startPolling();
  if (playerActive()) {
    window.legacyPlayer?.showControls?.();
  } else if (getVisibleCards().length > 0 && !isGridNavigationEnabled()) {
    // Grid view: summon the focus ring shortly after connecting (legacy 500ms).
    setTimeout(() => {
      if (connection.connected && !playerActive()) enableGridNavigation();
    }, 500);
  }
}

function onDisconnected(pad: Gamepad): void {
  connectedPads.delete(pad.index);
  lastButtons.delete(pad.index);
  lastSticks.delete(pad.index);
  if (connectedPads.size === 0) {
    stopPolling();
    setConnection({ connected: false, id: null });
    window.legacyPlayer?.resetControlsTimeout?.();
  }
}

export function isGamepadConnected(): boolean {
  return connection.connected;
}

let initialized = false;

/** One-time wiring; applies `settings.controller` and starts listening. */
export function initGamepad(dependencies: GamepadDeps): void {
  if (initialized) return;
  initialized = true;
  deps = dependencies;

  // The legacy player re-enables grid navigation on close via
  // state.gamepadManager.isGamepadConnected() — hand it a live shim.
  if (window.legacyState) {
    window.legacyState.gamepadManager = { isGamepadConnected };
  }

  window.clips
    .getSettings()
    .then((s: { controller?: Record<string, unknown> } | null) => {
      const c = s?.controller;
      if (!c) return;
      if (typeof c.seekSensitivity === "number") seekSensitivity = c.seekSensitivity;
      if (typeof c.volumeSensitivity === "number") volumeSensitivity = c.volumeSensitivity;
      if (c.buttonMappings && typeof c.buttonMappings === "object") {
        for (const [k, v] of Object.entries(c.buttonMappings as Record<string, GamepadAction>)) {
          buttonMappings[Number(k)] = v;
        }
      }
      if (c.enabled === false) {
        managerEnabled = false;
        stopPolling();
      }
    })
    .catch(() => {});

  window.addEventListener("gamepadconnected", (e) => onConnected((e as GamepadEvent).gamepad));
  window.addEventListener("gamepaddisconnected", (e) => onDisconnected((e as GamepadEvent).gamepad));

  // Pads connected before this ran (Chromium only reports them after input,
  // but a reload mid-session sees them immediately).
  for (const pad of navigator.getGamepads()) {
    if (pad) onConnected(pad);
  }
}
