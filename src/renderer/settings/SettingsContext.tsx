import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { applyUiFont, UI_FONT_DEFAULT } from "./fonts";
import { EXPORT_SETTING_DEFAULTS } from "./exportPresets";
import { applyKeybindings } from "../player/keybindings";
import {
  applyCardGlowSettings,
  CARD_GLOW_DEFAULTS,
  type CardGlowSettings,
} from "../library/glowConfig";

// The persisted settings object (main process settings-manager). Loosely typed
// on purpose — main owns the file; we only read/patch the keys we know.
export interface AmbientGlowSettings {
  enabled: boolean;
  smoothing: number;
  fps: number;
  blur: number;
  saturation: number;
  opacity: number;
}

export type { CardGlowSettings };

export interface AppSettings {
  enableDiscordRPC: boolean;
  uiFont: string;
  iconGreyscale: boolean;
  showNewClipsIndicators: boolean;
  previewVolume: number;
  ambientGlow: AmbientGlowSettings;
  cardGlow: CardGlowSettings;
  exportPreset: string;
  exportQuality: string;
  exportSizeGoal: string;
  exportQualityBias: string;
  exportSpeedBias: string;
  keybindings?: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export const AMBIENT_GLOW_DEFAULTS: AmbientGlowSettings = {
  enabled: true,
  smoothing: 0.5,
  fps: 30,
  blur: 80,
  saturation: 1.5,
  opacity: 0.7,
};

export { CARD_GLOW_DEFAULTS };

export const SETTINGS_DEFAULTS: AppSettings = {
  enableDiscordRPC: false,
  uiFont: UI_FONT_DEFAULT,
  // Legacy defaulted greyscale off; the new design defaults it ON (matches the
  // previous App.tsx behavior `s?.iconGreyscale ?? true`).
  iconGreyscale: true,
  showNewClipsIndicators: true,
  onboardingVersion: 0,
  previewVolume: 0.1,
  ambientGlow: { ...AMBIENT_GLOW_DEFAULTS },
  cardGlow: { ...CARD_GLOW_DEFAULTS },
  ...EXPORT_SETTING_DEFAULTS,
};

function withDefaults(raw: Record<string, unknown> | null | undefined): AppSettings {
  const merged: AppSettings = { ...SETTINGS_DEFAULTS, ...(raw ?? {}) } as AppSettings;
  merged.ambientGlow = { ...AMBIENT_GLOW_DEFAULTS, ...((raw?.ambientGlow as object) ?? {}) };
  merged.cardGlow = { ...CARD_GLOW_DEFAULTS, ...((raw?.cardGlow as object) ?? {}) };
  return merged;
}

interface SettingsApi {
  settings: AppSettings;
  ready: boolean;
  /**
   * Update one setting by dot-path (e.g. `set("ambientGlow.blur", 60)`),
   * optimistically in memory, then persist the whole object. Resolves false
   * if the save failed (state is left at the optimistic value; main keeps the
   * old file — a rare enough case that we surface it via the return value
   * rather than reverting mid-interaction).
   */
  set: (path: string, value: unknown) => Promise<boolean>;
  /** Update several top-level keys at once (export presets, resets). */
  patch: (partial: Record<string, unknown>) => Promise<boolean>;
  /** Step back/forward through this session's settings changes (Ctrl+Z / Ctrl+Shift+Z). */
  undo: () => boolean;
  redo: () => boolean;
}

const SettingsContext = createContext<SettingsApi | null>(null);

export function useSettings(): SettingsApi {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within <SettingsProvider>");
  return ctx;
}

const HISTORY_LIMIT = 100;

/**
 * All cross-cutting side effects of a settings object live here, so every
 * write path (set / patch / undo / redo / initial load) behaves identically:
 * font, legacy-player state, player keybindings, ambient glow, card glow.
 */
function applySideEffects(next: AppSettings, prev: AppSettings | null): void {
  if (window.legacyState) window.legacyState.settings = next;
  applyUiFont(next.uiFont);
  applyKeybindings(next.keybindings ?? {});
  applyCardGlowSettings(next.cardGlow);
  if (!prev || prev.ambientGlow !== next.ambientGlow) {
    window.legacyPlayer?.applyAmbientGlowSettings(next.ambientGlow);
  }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(SETTINGS_DEFAULTS);
  const [ready, setReady] = useState(false);
  // Canonical copy for read-modify-write saves (state updates are async).
  const canonical = useRef<AppSettings>(SETTINGS_DEFAULTS);
  const undoStack = useRef<AppSettings[]>([]);
  const redoStack = useRef<AppSettings[]>([]);

  useEffect(() => {
    let cancelled = false;
    window.clips
      .getSettings()
      .then((raw) => {
        if (cancelled) return;
        const merged = withDefaults(raw);
        canonical.current = merged;
        setSettings(merged);
        setReady(true);
        applySideEffects(merged, null);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = useCallback(async (next: AppSettings, fromHistory: boolean): Promise<boolean> => {
    const prev = canonical.current;
    if (!fromHistory) {
      undoStack.current.push(prev);
      if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
      redoStack.current = [];
    }
    canonical.current = next;
    setSettings(next);
    applySideEffects(next, prev);
    try {
      await window.clips.saveSettings(next);
      return true;
    } catch {
      return false;
    }
  }, []);

  const set = useCallback(
    (path: string, value: unknown): Promise<boolean> => {
      const keys = path.split(".");
      const next: AppSettings = { ...canonical.current };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let target: any = next;
      for (let i = 0; i < keys.length - 1; i++) {
        target[keys[i]] = { ...(target[keys[i]] ?? {}) };
        target = target[keys[i]];
      }
      target[keys[keys.length - 1]] = value;
      return commit(next, false);
    },
    [commit],
  );

  const patch = useCallback(
    (partial: Record<string, unknown>): Promise<boolean> =>
      commit({ ...canonical.current, ...partial }, false),
    [commit],
  );

  const undo = useCallback((): boolean => {
    const prev = undoStack.current.pop();
    if (!prev) return false;
    redoStack.current.push(canonical.current);
    void commit(prev, true);
    return true;
  }, [commit]);

  const redo = useCallback((): boolean => {
    const next = redoStack.current.pop();
    if (!next) return false;
    undoStack.current.push(canonical.current);
    void commit(next, true);
    return true;
  }, [commit]);

  const api = useMemo(
    () => ({ settings, ready, set, patch, undo, redo }),
    [settings, ready, set, patch, undo, redo],
  );

  return <SettingsContext.Provider value={api}>{children}</SettingsContext.Provider>;
}
