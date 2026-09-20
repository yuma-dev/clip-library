// Entry point for the component-mockup exporter (export.html). Reads a spec from
// window.__EXPORT_SPEC__, mounts the named scene, then flips data-export-ready
// once fonts/images settle. Component-agnostic; see docs/component-mockups.md.

import "@fontsource-variable/inter";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";
import { frameSpec, paintCursor } from "./timeline";
import { installMockClips } from "./mockClips";
import { scenes } from "./scenes";
import type { ExportSpec } from "./types";
import "../styles.css";
import "../player/player.css"; // .mixer__* styles for the audioMixer scene

const spec: ExportSpec = window.__EXPORT_SPEC__ ?? { scene: "clipCard", fixtures: [] };
window.__CLIPLIB_RENDER_CLOCK__ = { time:0, draws:new Set() };

installMockClips(spec.fixtures ?? []);

const Scene = scenes[spec.scene];
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
if (!Scene) throw new Error(`unknown export scene: ${spec.scene}`);
const motionStyle = document.createElement("style");
motionStyle.textContent = spec.scene === 'hero' ? 'body {overflow:hidden} #export-root *{transition:none!important}' : "#export-root *, #export-root *::before, #export-root *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } body { overflow: hidden; }";
document.head.append(motionStyle);
window.__EXPORT_SEEK__ = async (time) => {
  window.__CLIPLIB_RENDER_CLOCK__!.time = time;
  const next = frameSpec(spec, time);
  installMockClips(next.fixtures);
  flushSync(() => root.render(<Scene {...next} />));
  await document.fonts.ready;
  await Promise.all(Array.from(document.images).map(img => img.decode().catch(() => {})));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  for (const draw of window.__CLIPLIB_RENDER_CLOCK__!.draws) draw(time);
  const editor = document.querySelector<HTMLInputElement>(".clip-name-edit");
  if (editor) { editor.focus(); editor.setSelectionRange(editor.dataset.selectAll === "true" ? 0 : editor.value.length, editor.value.length); }
  for (const popup of document.querySelectorAll<HTMLElement>("[data-anchor]")) {
    const anchor = document.querySelector(popup.dataset.anchor!);
    if (!anchor) continue;
    const rootBox = document.getElementById("export-root")!.getBoundingClientRect(), a = anchor.getBoundingClientRect(), p = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(12, Math.min(a.left - rootBox.left + a.width / 2 - p.width / 2, rootBox.width - p.width - 12))}px`;
    popup.style.top = `${a.top - rootBox.top - p.height - 6 < 12 ? a.bottom - rootBox.top + 6 : a.top - rootBox.top - p.height - 6}px`;
  }
  for (const video of Array.from(document.querySelectorAll<HTMLVideoElement>("video[data-export-video]"))) {
    if (video.error) throw new Error(`export video failed: ${video.currentSrc}`);
    if (video.readyState < 2) await waitForMedia(video, "loadeddata");
    const target = Math.min(video.dataset.time !== undefined ? Number(video.dataset.time) : Number(video.dataset.offset ?? 0) + time, Math.max(0, video.duration - 0.001));
    if (Math.abs(video.currentTime - target) > 0.0001) {
      const ready = waitForMedia(video, "seeked");
      video.currentTime = target;
      await ready;
    }
    video.pause();
  }
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas[data-glow-source]")) {
    const source = document.querySelector<HTMLImageElement | HTMLVideoElement>(canvas.dataset.glowSource!);
    const ctx = canvas.getContext("2d");
    if (ctx && source) { ctx.clearRect(0, 0, 16, 9); ctx.filter = "blur(1px)"; ctx.drawImage(source, 0, 0, 16, 9); }
    else if (ctx && next.media?.kind === "color") { ctx.fillStyle = next.media.color!; ctx.fillRect(0, 0, 16, 9); }
  }
  await window.__EXPORT_SCENE_SEEK__?.(time);
  if (spec.timeline?.cursor?.length) await paintCursor(spec.timeline.cursor, time, spec.cursorTheme);
  if(spec.scene==='hero'&&(Number(next.props?.time)<17.4||Number(next.props?.time)>=31))document.querySelector<HTMLElement>('[data-export-cursor]')?.style.setProperty('visibility','hidden');
};
const initialFrame = window.__EXPORT_SEEK__(0);

function waitForMedia(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener("error", fail); };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error(`export video failed or timed out: ${video.currentSrc}`)); };
    const timer = setTimeout(fail, 15000);
    video.addEventListener(event, done, { once: true });
    video.addEventListener("error", fail, { once: true });
  });
}

async function signalReady(): Promise<void> {
  await initialFrame;
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

void signalReady().catch((error: Error) => { document.documentElement.dataset.exportError = error.message; });
