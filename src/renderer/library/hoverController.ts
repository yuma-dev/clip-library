import type { ClipGlow } from "./ClipGlow";
import { isBootHeld } from "../boot/bootHold";
import type { LocalClip } from "./types";

// Node's path.join via the nodeIntegration global require, matches how the legacy renderer built
// file:// URLs.
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

/** Card hover: shows glow immediately, then after 100ms a looping preview
 * <video> (trim.start or mid-clip); cancellation via a per-hover token. */
export class LibraryHover {
  private activePreview: PreviewContext | null = null;
  private previewTimer: number | null = null;
  private previewVolume = 0.1;

  constructor(
    private readonly glow: ClipGlow,
    private clipLocation: string,
  ) {
    // A resting-cursor preview decodes/drives the glow at 30fps forever if left running; stop on
    // blur/hidden, restart on next hover.
    window.addEventListener("blur", this.onWindowAway);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private readonly onWindowAway = (): void => {
    this.leave();
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) this.leave();
  };

  setClipLocation(loc: string): void {
    this.clipLocation = loc;
  }

  /** Settings, preview volume; also applied live to a playing preview. */
  setPreviewVolume(volume: number): void {
    this.previewVolume = volume;
    if (this.activePreview?.video) this.activePreview.video.volume = volume;
  }

  enter(cardEl: HTMLElement, clip: LocalClip): void {
    // No preview during boot reveal: cursor often rests on the grid then, and
    // the first <video> costs the GPU a decoder + encoder-capability probe.
    if (isBootHeld()) return;
    this.glow.show(cardEl);
    this.cleanupPreview();

    const ctx: PreviewContext = { token: Symbol("preview") };
    this.activePreview = ctx;

    this.previewTimer = window.setTimeout(async () => {
      if (this.activePreview !== ctx) return;

      let startTime = 0;
      try {
        // Cheap IPC (trim.start or cached midpoint); never getClipInfo here
        // cold cache runs a ~300ms ffprobe that serially stalls every hover.
        startTime = Number(await window.clips.getPreviewStartTime(clip.originalName)) || 0;
      } catch {
        /* default to 0 */
      }
      if (this.activePreview !== ctx || !cardEl.matches(":hover")) return;
      // Hovered card is the likeliest next open: warm probe/audio now (main does one clip at a
      // time, off the click path).
      window.clips.warmClipOpen?.(clip.originalName).catch(() => undefined);

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
            /* autoplay rejection, leave the thumbnail visible */
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
    window.removeEventListener("blur", this.onWindowAway);
    document.removeEventListener("visibilitychange", this.onVisibility);
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
