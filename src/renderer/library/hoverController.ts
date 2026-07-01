import type { ClipGlow } from "./ClipGlow";
import type { LocalClip } from "./types";

// Node's path.join via the (nodeIntegration) global require — matches how the
// legacy renderer built file:// URLs for local clips.
const nodeRequire = (window as unknown as { require?: (m: string) => { join: (...p: string[]) => string } }).require;
function clipFileUrl(clipLocation: string, originalName: string): string {
  const full = nodeRequire ? nodeRequire("path").join(clipLocation, originalName) : `${clipLocation}/${originalName}`;
  return `file://${full}`;
}

interface PreviewContext {
  token: symbol;
  video?: HTMLVideoElement;
  img?: HTMLImageElement | null;
}

/**
 * Orchestrates card hover: shows the shared glow immediately, and after a 100ms
 * delay creates a looping preview <video> in the card (start at trim.start or
 * mid-clip), hiding the thumbnail and feeding the live video to the glow.
 * Cancellation is via a per-hover token (legacy `state.activePreview`).
 * (Warm-audio-on-hover is deferred to Phase 4, when the player consumes it.)
 */
export class LibraryHover {
  private activePreview: PreviewContext | null = null;
  private previewTimer: number | null = null;
  private previewVolume = 0.1;

  constructor(
    private readonly glow: ClipGlow,
    private clipLocation: string,
  ) {}

  setClipLocation(loc: string): void {
    this.clipLocation = loc;
  }

  enter(cardEl: HTMLElement, clip: LocalClip): void {
    this.glow.show(cardEl);
    this.cleanupPreview();

    const ctx: PreviewContext = { token: Symbol("preview") };
    this.activePreview = ctx;

    this.previewTimer = window.setTimeout(async () => {
      if (this.activePreview !== ctx) return;

      let startTime = 0;
      try {
        const trim = await window.clips.getTrim(clip.originalName);
        if (trim && typeof trim.start === "number") {
          startTime = trim.start;
        } else {
          const info = await window.clips.getClipInfo(clip.originalName);
          const duration = Number(info?.format?.duration ?? 0);
          startTime = duration > 40 ? duration / 2 : 0;
        }
      } catch {
        /* default to 0 */
      }
      if (this.activePreview !== ctx || !cardEl.matches(":hover")) return;

      const media = cardEl.querySelector<HTMLElement>(".clip-item-media-container");
      if (!media) return;
      const mount = cardEl.querySelector<HTMLElement>(".clip-preview-mount") ?? media;
      const img = media.querySelector<HTMLImageElement>("img");

      const video = document.createElement("video");
      video.className = "clip-preview-video";
      video.src = clipFileUrl(this.clipLocation, clip.originalName);
      video.loop = true;
      video.volume = this.previewVolume;
      video.preload = "metadata";
      video.playsInline = true;
      if (img) video.poster = img.src;

      video.addEventListener("loadedmetadata", () => {
        if (this.activePreview !== ctx || !cardEl.matches(":hover")) {
          this.cleanupPreview();
          return;
        }
        if (img) img.style.display = "none";
        try {
          video.currentTime = startTime;
        } catch {
          /* ignore */
        }
        video
          .play()
          .then(() => this.glow.updateSource(video))
          .catch(() => {
            /* autoplay rejection — leave the thumbnail visible */
          });
      });

      mount.appendChild(video);
      ctx.video = video;
      ctx.img = img;
    }, 100);
  }

  leave(): void {
    this.cleanupPreview();
    this.glow.hide();
  }

  dispose(): void {
    this.cleanupPreview();
    this.glow.hide();
  }

  private cleanupPreview(): void {
    if (this.previewTimer != null) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    const ctx = this.activePreview;
    this.activePreview = null;
    if (ctx?.video) {
      try {
        ctx.video.pause();
      } catch {
        /* ignore */
      }
      ctx.video.removeAttribute("src");
      ctx.video.load();
      ctx.video.remove();
    }
    if (ctx?.img) ctx.img.style.display = "";
  }
}
