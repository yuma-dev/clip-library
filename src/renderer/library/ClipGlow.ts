// Faithful React-era port of the legacy ClipGlowManager (video-player.js:271).
// A SINGLE shared 16x9 canvas lives behind the cards (in .clip-grid, unclipped)
// and is repositioned over the hovered card with a 55px overflow so the colour
// bleeds onto the surroundings. drawImage() downscales the thumbnail/preview
// video to 16x9 (keeping spatial colour), then CSS blows it up + blurs it.
// While a preview video plays, it redraws at 30fps with a 0.2 blend (temporal
// smoothing). All imperative — no React state on the per-frame loop.
import { glowConfig } from "./glowConfig";

export class ClipGlow {
  private readonly ctx: CanvasRenderingContext2D | null;
  private currentSource: HTMLImageElement | HTMLVideoElement | null = null;
  private rafId: number | null = null;
  private isActive = false;
  private lastDrawTime = 0;
  private readonly frameInterval = 1000 / 30;
  private readonly blendFactor = 0.2;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gridEl: HTMLElement,
  ) {
    this.ctx = canvas.getContext("2d", { alpha: true, willReadFrequently: false });
    if (this.ctx) this.ctx.filter = "blur(1px)";
  }

  show(cardEl: HTMLElement): void {
    if (this.reducedMotion || !this.ctx) return;
    const img = cardEl.querySelector<HTMLImageElement>(".clip-item-media-container img");
    if (img && img.complete && img.naturalWidth > 0) {
      this.currentSource = img;
      this.draw(true);
    }
    this.position(cardEl);
    this.canvas.classList.add("visible");
    this.isActive = true;
    this.lastDrawTime = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  /** Switch sampling from the static thumbnail to the live preview video. */
  updateSource(video: HTMLVideoElement): void {
    if (!this.isActive) return;
    this.currentSource = video;
    this.draw(true);
  }

  hide(): void {
    this.isActive = false;
    this.currentSource = null;
    this.canvas.classList.remove("visible");
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private position(cardEl: HTMLElement): void {
    const media = cardEl.querySelector<HTMLElement>(".clip-item-media-container");
    if (!media) return;
    const g = this.gridEl.getBoundingClientRect();
    const m = media.getBoundingClientRect();
    const o = glowConfig.overflow;
    this.canvas.style.left = `${m.left - g.left - o}px`;
    this.canvas.style.top = `${m.top - g.top - o + glowConfig.yShift}px`;
    this.canvas.style.width = `${m.width + o * 2}px`;
    this.canvas.style.height = `${m.height + o * 2}px`;
  }

  private draw(force = false): void {
    const { ctx } = this;
    const src = this.currentSource;
    if (!ctx || !src) return;
    try {
      if (src instanceof HTMLVideoElement) {
        if (src.readyState < 2) return;
      } else if (!src.complete || src.naturalWidth === 0) {
        return;
      }
      ctx.globalAlpha = force ? 1 : this.blendFactor;
      ctx.drawImage(src, 0, 0, this.canvas.width, this.canvas.height);
      ctx.globalAlpha = 1;
    } catch {
      /* drawImage can throw on not-yet-ready media; ignore. */
    }
  }

  private loop = (ts: number): void => {
    if (!this.isActive) return;
    const src = this.currentSource;
    if (src instanceof HTMLVideoElement && !src.paused) {
      const elapsed = ts - this.lastDrawTime;
      if (elapsed >= this.frameInterval) {
        this.draw();
        this.lastDrawTime = ts - (elapsed % this.frameInterval);
      }
    }
    this.rafId = requestAnimationFrame(this.loop);
  };
}
