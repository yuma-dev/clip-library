// Hover glow for feed/profile card grids — reuses the library's ClipGlow
// (shared 16×9 canvas repositioned over the hovered card). The library wires
// it through its LibraryHover controller (which also runs preview videos);
// the feed has no previews, so a thin delegated mouseover/out is enough.

import { useEffect, useRef } from "react";
import { ClipGlow } from "../library/ClipGlow";

export function useCardGlow() {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const grid = gridRef.current;
    const canvas = canvasRef.current;
    if (!grid || !canvas) return;

    const glow = new ClipGlow(canvas, grid);
    let currentCard: HTMLElement | null = null;

    const onOver = (e: MouseEvent) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>(".clip-item");
      if (!card || !grid.contains(card) || card === currentCard) return;
      currentCard = card;
      glow.show(card);
    };
    const onOut = (e: MouseEvent) => {
      const to = e.relatedTarget as HTMLElement | null;
      if (to && to.closest(".clip-item") === currentCard && currentCard) return;
      currentCard = null;
      glow.hide();
    };

    grid.addEventListener("mouseover", onOver);
    grid.addEventListener("mouseout", onOut);
    return () => {
      glow.hide();
      grid.removeEventListener("mouseover", onOver);
      grid.removeEventListener("mouseout", onOut);
    };
  }, []);

  return { gridRef, canvasRef };
}
