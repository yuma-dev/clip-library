// Per-part switches for the boot intro, kept in localStorage and read at the
// next launch. Driven from the dev console (installed by bootReveal.ts):
//
//   __bootIntro.get()                         current switches
//   __bootIntro.set({ chimes: false })        change one or more
//   __bootIntro.reset()                       back to the defaults
//
// Sound: sound (master), woosh, chimes, motesSound, wind, plus 0..1 volumes for the
// whole mix and each layer. Visuals: afterglow, glow (the grid lighting up), parallax,
// motes (the drifting points of light).

const KEY = "clip-library:boot-intro-v1";

export interface BootPrefs {
  /** Master switch for the startup sound (the layers below still apply). */
  sound: boolean;
  woosh: boolean;
  chimes: boolean;
  motesSound: boolean;
  wind: boolean;
  volume: number;
  wooshVolume: number;
  chimesVolume: number;
  motesVolume: number;
  windVolume: number;
  afterglow: boolean;
  glow: boolean;
  parallax: boolean;
  motes: boolean;
}

export const BOOT_DEFAULTS: BootPrefs = {
  sound: true,
  woosh: true,
  chimes: true,
  motesSound: true,
  wind: true,
  volume: 1,
  wooshVolume: 1,
  chimesVolume: 1,
  motesVolume: 1,
  windVolume: 1,
  afterglow: true,
  glow: true,
  parallax: true,
  motes: true,
};

export function getBootPrefs(): BootPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...BOOT_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<BootPrefs>;
    const out = { ...BOOT_DEFAULTS };
    applyValid(out, parsed);
    return out;
  } catch {
    return { ...BOOT_DEFAULTS };
  }
}

export function setBootPrefs(patch: Partial<BootPrefs>): BootPrefs {
  const next = getBootPrefs();
  applyValid(next, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the change lasts for this session only */
  }
  return next;
}

// copies only keys whose type matches the default; volumes clamp to 0..1
function applyValid(into: BootPrefs, from: Partial<BootPrefs>): void {
  const target = into as unknown as Record<string, unknown>;
  for (const k of Object.keys(BOOT_DEFAULTS) as (keyof BootPrefs)[]) {
    const v = from[k];
    if (typeof v !== typeof BOOT_DEFAULTS[k]) continue;
    if (typeof v === "number") {
      if (Number.isFinite(v)) target[k] = Math.min(1, Math.max(0, v));
    } else {
      target[k] = v;
    }
  }
}

/** Per-layer level the intro plays at; 0 means the layer stays silent. */
export function bootSoundLevels(p: BootPrefs): Record<"woosh" | "chimes" | "motes" | "wind", number> {
  const master = p.sound ? p.volume : 0;
  return {
    woosh: p.woosh ? master * p.wooshVolume : 0,
    chimes: p.chimes ? master * p.chimesVolume : 0,
    motes: p.motesSound ? master * p.motesVolume : 0,
    wind: p.wind ? master * p.windVolume : 0,
  };
}

export function resetBootPrefs(): BootPrefs {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return { ...BOOT_DEFAULTS };
}

declare global {
  interface Window {
    __bootIntro?: {
      get: () => BootPrefs;
      set: (patch: Partial<BootPrefs>) => BootPrefs;
      reset: () => BootPrefs;
    };
  }
}

/** Dev console hook. Changes apply at the next launch. */
export function installBootPrefsConsole(): void {
  window.__bootIntro = {
    get: getBootPrefs,
    set: (patch) => {
      const next = setBootPrefs(patch);
      console.info("[boot intro] saved; applies at the next launch", next);
      return next;
    },
    reset: () => {
      const next = resetBootPrefs();
      console.info("[boot intro] defaults restored; apply at the next launch", next);
      return next;
    },
  };
}
