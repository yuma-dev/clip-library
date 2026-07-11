// Shared contract for the component-mockup exporter (docs/component-mockups.md).
//
// An ExportSpec is a self-contained, disposable description of ONE render: which
// registered scene to mount, the captured `window.clips` fixture to replay, and
// the CSS selectors that split the result into exportable layers. The harness
// (main-export.tsx) and the capture script (scripts/export-capture.mjs) are the
// permanent, component-agnostic pieces; specs + fixtures are per-extraction inputs.

import type { LocalClip } from "../library/types";
import type { GameIcon } from "../library/gameIcon";

/** One clip's worth of captured IPC responses, replayed by the mock window.clips. */
export interface ClipFixture {
  clip: LocalClip;
  /** get-game-icon result: { path, title, discord } — carries participants too. */
  gameIcon?: GameIcon | null;
}

export interface ExportSpec {
  /** Registered scene id (see export/scenes.tsx). */
  scene: string;
  /** Solid colour painted behind the composite (glow uses screen-blend over it). */
  background?: string;
  /** Card geometry knobs for the clipCard scene. */
  card?: { width?: number; glowOverflow?: number };
  /** Free-form flags forwarded to the scene (e.g. grayscaleIcons). */
  props?: Record<string, unknown>;
  /** Fixtures replayed through the stub window.clips. */
  fixtures: ClipFixture[];
  /** Layer name -> CSS selector; null means the whole composite. Read by the capture script. */
  layers?: Record<string, string | null>;
  /** ms to settle after fonts/mount before signalling ready (icon IPC debounce is ~50ms). */
  settleMs?: number;
}

declare global {
  interface Window {
    __EXPORT_SPEC__?: ExportSpec;
  }
}
