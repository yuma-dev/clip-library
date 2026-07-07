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

export interface AppSettings {
  enableDiscordRPC: boolean;
  uiFont: string;
  iconGreyscale: boolean;
  showNewClipsIndicators: boolean;
  previewVolume: number;
  ambientGlow: AmbientGlowSettings;
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

const DEFAULTS: AppSettings = {
  enableDiscordRPC: false,
  uiFont: UI_FONT_DEFAULT,
  // Legacy defaulted greyscale off; the new design defaults it ON (matches the
  // previous App.tsx behavior `s?.iconGreyscale ?? true`).
  iconGreyscale: true,
  showNewClipsIndicators: true,
  previewVolume: 0.1,
  ambientGlow: { ...AMBIENT_GLOW_DEFAULTS },
  ...EXPORT_SETTING_DEFAULTS,
};

function withDefaults(raw: Record<string, unknown> | null | undefined): AppSettings {
  const merged: AppSettings = { ...DEFAULTS, ...(raw ?? {}) } as AppSettings;
  merged.ambientGlow = { ...AMBIENT_GLOW_DEFAULTS, ...((raw?.ambientGlow as object) ?? {}) };
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
  /** Update several top-level keys at once (export presets). */
  patch: (partial: Record<string, unknown>) => Promise<boolean>;
}

const SettingsContext = createContext<SettingsApi | null>(null);

export function useSettings(): SettingsApi {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within <SettingsProvider>");
  return ctx;
}

/** Mirror the canonical object into the wrapped legacy player's shared state. */
function syncLegacyState(settings: AppSettings): void {
  if (window.legacyState) window.legacyState.settings = settings;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [ready, setReady] = useState(false);
  // Canonical copy for read-modify-write saves (state updates are async).
  const canonical = useRef<AppSettings>(DEFAULTS);

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
        applyUiFont(merged.uiFont);
        syncLegacyState(merged);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next: AppSettings): Promise<boolean> => {
    canonical.current = next;
    setSettings(next);
    syncLegacyState(next);
    if (next.uiFont !== undefined) applyUiFont(next.uiFont);
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
      return save(next);
    },
    [save],
  );

  const patch = useCallback(
    (partial: Record<string, unknown>): Promise<boolean> => save({ ...canonical.current, ...partial }),
    [save],
  );

  const api = useMemo(() => ({ settings, ready, set, patch }), [settings, ready, set, patch]);

  return <SettingsContext.Provider value={api}>{children}</SettingsContext.Provider>;
}
