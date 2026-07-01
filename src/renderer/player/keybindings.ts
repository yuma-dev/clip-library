// Player keybindings — ported from the legacy renderer/keybinding-manager.js.
// Maps KeyboardEvents to action names the wrapped legacy player switches on
// (playPause, frameForward, fullscreen, …). Loaded from settings with a
// fallback to defaults; rebinding UI lands with Settings (Phase 7).

export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  playPause: "Space",
  frameBackward: ",",
  frameForward: ".",
  skipBackward: "ArrowLeft",
  skipForward: "ArrowRight",
  navigatePrev: "Ctrl+ArrowLeft",
  navigateNext: "Ctrl+ArrowRight",
  volumeUp: "ArrowUp",
  volumeDown: "ArrowDown",
  exportDefault: "e",
  exportVideo: "Ctrl+E",
  exportAudioFile: "Ctrl+Shift+E",
  exportAudioClipboard: "Shift+E",
  fullscreen: "f",
  deleteClip: "Delete",
  setTrimStart: "[",
  setTrimEnd: "]",
  focusTitle: "Tab",
  closePlayer: "Escape",
};

let keybindings: Record<string, string> = { ...DEFAULT_KEYBINDINGS };

/** Normalize a combo string ("ctrl+shift+E" -> "Ctrl+Shift+e") for comparison. */
function normaliseCombo(str: string): string {
  return str
    .split("+")
    .map((part) => {
      const p = part.trim();
      if (!p) return "";
      // Single-character keys compare case-insensitively — store lowercase.
      if (p.length === 1) return p.toLowerCase();
      return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    })
    .join("+");
}

/** Build a normalized combo string from a KeyboardEvent. */
function buildEventCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  let keyPart = e.key;
  if (keyPart === " ") keyPart = "Space";
  if (keyPart.length === 1) keyPart = keyPart.toLowerCase();
  parts.push(keyPart);
  return normaliseCombo(parts.join("+"));
}

/** Map a key event to the configured action name (or null). */
export function getActionFromEvent(e: KeyboardEvent): string | null {
  const combo = buildEventCombo(e);
  for (const [action, binding] of Object.entries(keybindings)) {
    if (normaliseCombo(binding) === combo) return action;
  }
  return null;
}

/** Load keybindings from settings (merged over defaults). */
export async function initKeybindings(): Promise<void> {
  try {
    const settings = await window.clips.getSettings();
    if (settings?.keybindings && typeof settings.keybindings === "object") {
      keybindings = { ...DEFAULT_KEYBINDINGS, ...settings.keybindings };
    }
  } catch {
    /* keep defaults */
  }
}
