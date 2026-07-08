// Hover glow + hover preview for feed/profile card grids.
//
// Glow reuses the library's ClipGlow (shared 16×9 canvas repositioned over the
// hovered card). The library wires it through its LibraryHover controller
// (which also runs preview videos); here the same pair — glow + preview — is
// driven by one delegated mouseover/out on the grid, reading the clip id and
// duration from the card's data attributes.
//
// Preview differences vs. the library (local files): the clip streams from the
// share server, so the hover delay is longer (don't hit the network for a
// drive-by hover) and a spinner overlays the thumbnail until playback starts.
//
// The grid/canvas are callback refs backed by state, NOT plain useRefs: these
// grids mount conditionally (profile shows a spinner first, feed can show an
// empty state), so a run-once effect reading ref.current would fire before
// the grid exists and never attach. State-backed refs re-run the effect when
// the nodes actually appear.

import { useEffect, useRef, useState } from "react";
import { ClipGlow } from "../library/ClipGlow";
import { useSettings } from "../settings/SettingsContext";
import { previewStreamUrl } from "./types";

/** Remote stream — hover longer than the library's 100ms before fetching. */
const PREVIEW_DELAY_MS = 450;

interface ActivePreview {
  video: HTMLVideoElement;
  img: HTMLImageElement | null;
  spinner: HTMLElement;
}

export function useCardGlow() {
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

  // Live preview volume (settings), read at play time without re-wiring.
  const { settings } = useSettings();
  const volumeRef = useRef(0.1);
  volumeRef.current = settings.previewVolume ?? 0.1;

  useEffect(() => {
    if (!grid || !canvas) return;

    const glow = new ClipGlow(canvas, grid);
    let currentCard: HTMLElement | null = null;
    let previewTimer: number | null = null;
    let active: ActivePreview | null = null;

    const cleanupPreview = () => {
      if (previewTimer != null) {
        clearTimeout(previewTimer);
        previewTimer = null;
      }
      if (active) {
        try {
          active.video.pause();
        } catch {
          /* ignore */
        }
        active.video.removeAttribute("src");
        active.video.load();
        active.video.remove();
        active.spinner.remove();
        if (active.img) active.img.style.display = "";
        active = null;
      }
    };

    const startPreview = (card: HTMLElement) => {
      const clipId = card.dataset.clipId;
      if (!clipId) return;
      const media = card.querySelector<HTMLElement>(".clip-item-media-container");
      if (!media) return;
      const img = media.querySelector<HTMLImageElement>("img");
      const duration = Number(card.dataset.duration ?? 0);

      const spinner = document.createElement("div");
      spinner.className = "feed-preview-loading";
      spinner.innerHTML = '<div class="feed-spinner"></div>';
      media.appendChild(spinner);

      const video = document.createElement("video");
      video.className = "clip-preview-video";
      video.src = previewStreamUrl(clipId);
      video.loop = true;
      video.volume = volumeRef.current;
      video.preload = "auto";
      video.playsInline = true;
      if (img?.src) video.poster = img.src;

      video.addEventListener("loadedmetadata", () => {
        if (card !== currentCard) return;
        // Long clips: preview from the middle, like the library grid.
        if (duration > 40) {
          try {
            video.currentTime = duration / 2;
          } catch {
            /* ignore */
          }
        }
        video.play().catch(() => {
          // Autoplay rejection / stream error — drop back to the thumbnail.
          if (card === currentCard) cleanupPreview();
        });
      });
      video.addEventListener("playing", () => {
        if (card !== currentCard) return;
        spinner.remove();
        if (img) img.style.display = "none";
        glow.updateSource(video);
      });
      video.addEventListener("error", () => {
        if (card === currentCard) cleanupPreview();
      });

      media.appendChild(video);
      active = { video, img, spinner };
    };

    const onOver = (e: MouseEvent) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>(".clip-item");
      if (!card || !grid.contains(card) || card === currentCard) return;
      currentCard = card;
      glow.show(card);
      cleanupPreview();
      previewTimer = window.setTimeout(() => {
        previewTimer = null;
        if (card === currentCard && card.matches(":hover")) startPreview(card);
      }, PREVIEW_DELAY_MS);
    };
    const onOut = (e: MouseEvent) => {
      const to = e.relatedTarget as HTMLElement | null;
      if (to && to.closest(".clip-item") === currentCard && currentCard) return;
      currentCard = null;
      cleanupPreview();
      glow.hide();
    };

    grid.addEventListener("mouseover", onOver);
    grid.addEventListener("mouseout", onOut);
    return () => {
      cleanupPreview();
      glow.hide();
      grid.removeEventListener("mouseover", onOver);
      grid.removeEventListener("mouseout", onOut);
    };
  }, [grid, canvas]);

  return { gridRef: setGrid, canvasRef: setCanvas };
}
