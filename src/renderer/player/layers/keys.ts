import type { LayerKind } from "../../../types/clips";
import { getActionFromEvent } from "../keybindings";
import { add, getLayers, remove, select, setMenu } from "./store";

const ADD: Record<string, LayerKind> = {
  addVolumeLayer: "volume",
  addTextLayer: "text",
  addGifLayer: "gif",
  addImageLayer: "image",
};

/** layer keys, in the capture phase so they win over the player's own: Delete removes the
 * selected layer instead of the clip, Escape closes the popover instead of the player */
export function installLayerKeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!document.body.classList.contains("player-open")) return;
    if (document.getElementById("clip-share-modal")?.classList.contains("is-open")) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("input, textarea, [contenteditable='true']")) return;
    const { sel, menu } = getLayers();
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (sel && (e.key === "Delete" || e.key === "Backspace")) {
      stop();
      remove(sel);
      return;
    }
    if (e.key === "Escape" && (sel || menu)) {
      stop();
      if (menu) setMenu(false);
      else select(null);
      return;
    }
    if (e.repeat) return;
    const action = getActionFromEvent(e);
    const kind = action ? ADD[action] : undefined;
    if (kind) {
      stop();
      add(kind);
    }
  };
  // a press anywhere but the popover, its details or a layer (on the video or its tag) lets go of
  // the selection
  const onDown = (e: PointerEvent) => {
    if (!getLayers().sel) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest(".pl-lp, .pl-more, .pl-layer, .pl-tag")) return;
    select(null);
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onDown, true);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onDown, true);
  };
}
