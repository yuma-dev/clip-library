// Shared contract for the component-mockup exporter (docs/component-mockups.md).
// An ExportSpec describes ONE render: scene, fixture, and the CSS selectors that
// split the result into exportable layers; harness + capture script stay permanent.

import type { LocalClip } from "../library/types";
import type { GameIcon } from "../library/gameIcon";
import type { Track, CursorKey } from "./timeline";

/** One clip's worth of captured IPC responses, replayed by the mock window.clips. */
export interface ClipFixture {
  clip: LocalClip;
  /** get-game-icon result: { path, title, discord }, carries participants too. */
  gameIcon?: GameIcon | null;
}

export interface ExportSpec {
  version?: 1;
  /** Raster density, independent of logical UI proportions. Defaults to 2. */
  captureScale?: number;
  media?: { kind: "clip" | "color"; path?: string; thumbnail?: string; color?: string; duration?: number; offset?: number };
  cursorTheme?: { theme: string; shapes: Record<string, { src: string; width: number; height: number; hotspot: [number, number] }> };
  clock?: string;
  timeline?: { duration: number; fps?: number; tracks?: Track[]; cursor?: CursorKey[] };
  viewport?: { width: number; height: number };
  /** Registered scene id (see export/scenes.tsx). */
  scene: string;
  /** Solid colour painted behind the composite (glow uses screen-blend over it). */
  background?: string;
  card?: { width?: number; glowOverflow?: number };
  /** Free-form flags forwarded to the scene (e.g. grayscaleIcons). */
  props?: Record<string, unknown>;
  fixtures: ClipFixture[];
  /** Layer name to CSS selector; null means the whole composite. Read by the capture script. */
  layers?: Record<string, string | null | { selector: string; exclude?: string[]; blend?: string }>;
  /** ms to settle after fonts/mount before signalling ready (icon IPC debounce is ~50ms). */
  settleMs?: number;
}

declare global {
  interface Window {
    __EXPORT_SPEC__?: ExportSpec;
    __EXPORT_SEEK__?: (time: number) => Promise<void>;
    __EXPORT_SCENE_SEEK__?: (time: number) => Promise<void>;
    __CLIPLIB_RENDER_CLOCK__?: { time: number; draws: Set<(seconds: number) => void> };
  }
}
