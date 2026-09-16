// Entry point for the component-mockup exporter (export.html). Reads a spec from
// window.__EXPORT_SPEC__, mounts the named scene, then flips data-export-ready
// once fonts/images settle. Component-agnostic; see docs/component-mockups.md.

import "@fontsource-variable/inter";
import ReactDOM from "react-dom/client";
import { installMockClips } from "./mockClips";
import { scenes } from "./scenes";
import type { ExportSpec } from "./types";
import "../styles.css";
import "../player/player.css"; // .mixer__* styles for the audioMixer scene

const spec: ExportSpec = window.__EXPORT_SPEC__ ?? { scene: "clipCard", fixtures: [] };

installMockClips(spec.fixtures ?? []);

const Scene = scenes[spec.scene];
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(Scene ? Scene(spec) : <div style={{ color: "#fff" }}>unknown scene: {spec.scene}</div>);

async function signalReady(): Promise<void> {
  const settle = spec.settleMs ?? 250;
  try {
    await (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
  } catch {
    /* fonts API absent, ignore */
  }
  // Let the ~50ms game-icon IPC debounce flush and avatars mount.
  await new Promise((r) => setTimeout(r, settle));
  await Promise.all(
    Array.from(document.images).map((img) =>
      img.complete ? Promise.resolve() : img.decode().catch(() => {}),
    ),
  );
  // Second short settle for late-arriving remote (Discord CDN) avatars.
  await new Promise((r) => setTimeout(r, 60));
  document.documentElement.setAttribute("data-export-ready", "1");
}

void signalReady();
