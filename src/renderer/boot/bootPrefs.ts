// Per-part switches for the boot intro, kept in localStorage and read at the
// next launch. Driven from the dev console (installed by bootReveal.ts):
//
//   __bootIntro.get()                         current switches
//   __bootIntro.set({ chimes: false })        change one or more
//   __bootIntro.reset()                       back to the defaults
//
// Sound: sound (master), woosh, chimes, motesSound, wind. Visuals: afterglow, glow
// (the grid lighting up), parallax, motes (the drifting points of light).

const KEY = "clip-library:boot-intro-v1";

export interface BootPrefs {
  /** Master switch for the startup sound (the layers below still apply). */
  sound: boolean;
  woosh: boolean;
  chimes: boolean;
  motesSound: boolean;
  wind: boolean;
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
    for (const k of Object.keys(BOOT_DEFAULTS) as (keyof BootPrefs)[]) {
      if (typeof parsed[k] === "boolean") (out as Record<string, unknown>)[k] = parsed[k];
    }
    return out;
  } catch {
    return { ...BOOT_DEFAULTS };
  }
}

export function setBootPrefs(patch: Partial<BootPrefs>): BootPrefs {
  const next = { ...getBootPrefs() };
  for (const k of Object.keys(BOOT_DEFAULTS) as (keyof BootPrefs)[]) {
    if (typeof patch[k] === "boolean") (next as Record<string, unknown>)[k] = patch[k];
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the change lasts for this session only */
  }
  return next;
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
