import type { LayerKind } from "../../../types/clips";
import { getActionFromEvent } from "../keybindings";
import { add, canPaste, copySelected, duplicateSelected, getLayers, paste, redo, remove, select, setMenu, undo } from "./store";

const ADD: Record<string, LayerKind> = {
  addVolumeLayer: "volume",
  addTextLayer: "text",
  addGifLayer: "gif",
  addImageLayer: "image",
  addZoomLayer: "zoom",
  addSpeedLayer: "speed",
  addBlurLayer: "blur",
  addSoundLayer: "sound",
};

/** layer keys, in the capture phase so they win over the player's own: Delete removes the
 * selected layer instead of the clip, Escape closes the popover instead of the player. undo, redo,
 * copy, paste and duplicate are the usual ctrl keys and not rebindable */
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
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      const done =
        k === "z" ? (e.shiftKey ? redo() : undo()) :
        k === "y" && !e.shiftKey ? redo() :
        k === "c" && !e.shiftKey && sel ? copySelected() :
        k === "v" && !e.shiftKey && canPaste() ? paste() :
        k === "d" && !e.shiftKey && sel ? duplicateSelected() :
        null;
      // undo with nothing left still eats the key, it means nothing else in the player
      if (done !== null || k === "z" || k === "y") {
        stop();
        return;
      }
    }
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
    if (t?.closest(".pl-lp, .pl-more, .pl-layer, .pl-tag, .pl-blur, .pl-zoombox")) return;
    select(null);
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onDown, true);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onDown, true);
  };
}
