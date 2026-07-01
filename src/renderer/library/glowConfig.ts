// Live glow tuning via the DevTools console (like window.clipGrid). Visual
// params (opacity/blur/saturate/brightness) are applied as CSS variables on
// the glow canvas; geometry (overflow/yShift) is read by ClipGlow on each hover.
//
//   window.clipGlow.opacity(0.5)   // overall strength (screen blend over black)
//   window.clipGlow.blur(40)       // px
//   window.clipGlow.saturate(1.6)
//   window.clipGlow.brightness(1)
//   window.clipGlow.overflow(55)   // px bleed around the thumbnail
//   window.clipGlow.yShift(-6)     // nudge up (-) / down (+) to balance
//   window.clipGlow.get() / .reset()

const STORAGE_KEY = "clip-library:glow";

export interface GlowConfig {
  opacity: number;
  blur: number;
  saturate: number;
  brightness: number;
  overflow: number;
  yShift: number;
}

const DEFAULTS: GlowConfig = {
  opacity: 0.6,
  blur: 45,
  saturate: 1.6,
  brightness: 1.0,
  overflow: 55,
  yShift: 0,
};

// Shared mutable config; ClipGlow reads overflow/yShift from it.
export const glowConfig: GlowConfig = { ...DEFAULTS };

function applyVars(): void {
  const root = document.documentElement.style;
  root.setProperty("--glow-opacity", String(glowConfig.opacity));
  root.setProperty("--glow-blur", `${glowConfig.blur}px`);
  root.setProperty("--glow-sat", String(glowConfig.saturate));
  root.setProperty("--glow-bright", String(glowConfig.brightness));
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(glowConfig));
  } catch {
    /* ignore */
  }
}

function num(v: unknown, current: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : current;
}

export function initGlowTuner(): void {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (stored && typeof stored === "object") Object.assign(glowConfig, DEFAULTS, stored);
  } catch {
    /* ignore */
  }
  applyVars();

  const api = {
    opacity(v: number) {
      glowConfig.opacity = num(v, glowConfig.opacity);
      applyVars();
      save();
      return glowConfig.opacity;
    },
    blur(v: number) {
      glowConfig.blur = num(v, glowConfig.blur);
      applyVars();
      save();
      return glowConfig.blur;
    },
    saturate(v: number) {
      glowConfig.saturate = num(v, glowConfig.saturate);
      applyVars();
      save();
      return glowConfig.saturate;
    },
    brightness(v: number) {
      glowConfig.brightness = num(v, glowConfig.brightness);
      applyVars();
      save();
      return glowConfig.brightness;
    },
    overflow(v: number) {
      glowConfig.overflow = num(v, glowConfig.overflow);
      save();
      return glowConfig.overflow;
    },
    yShift(v: number) {
      glowConfig.yShift = num(v, glowConfig.yShift);
      save();
      return glowConfig.yShift;
    },
    get() {
      return { ...glowConfig };
    },
    reset() {
      Object.assign(glowConfig, DEFAULTS);
      applyVars();
      save();
      return { ...glowConfig };
    },
  };

  (window as unknown as { clipGlow: typeof api }).clipGlow = api;
  // eslint-disable-next-line no-console
  console.log(
    "%c[clipGlow]",
    "color:#c774e0;font-weight:bold",
    "tune: .opacity(0.5) .blur(40) .saturate(1.6) .brightness(1) .overflow(55) .yShift(-6); .get()/.reset()",
  );
}
