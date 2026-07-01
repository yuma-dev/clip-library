import { forwardRef, useImperativeHandle, useState } from "react";
import { FolderOpen, RotateCcw, Scissors, Tag, Trash2, Upload } from "lucide-react";
import ContextMenu from "../ui/ContextMenu";
import { MenuDivider, MenuItem, MenuList } from "../ui/Menu";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/ConfirmDialog";
import type { LocalClip } from "./types";

export interface ContextMenuHandle {
  open(x: number, y: number, clip: LocalClip): void;
}

interface ContextMenuHostProps {
  onDeleted: (originalName: string) => void;
}

/**
 * Isolated context-menu host: holds its own open/position/clip state so that
 * opening the menu does NOT re-render the (2020-card) grid. Cards trigger it
 * imperatively via the ref handle. Export/Tags are stubs until Phases 6/5;
 * opening a clip in the player lands in Phase 4.
 */
const ContextMenuHost = forwardRef<ContextMenuHandle, ContextMenuHostProps>(function ContextMenuHost(
  { onDeleted },
  ref,
) {
  const [state, setState] = useState<{ x: number; y: number; clip: LocalClip } | null>(null);
  const toast = useToast();
  const { confirm } = useConfirm();

  useImperativeHandle(ref, () => ({ open: (x, y, clip) => setState({ x, y, clip }) }), []);

  const close = () => setState(null);
  const clip = state?.clip;

  const revealClip = () => {
    if (clip) window.clips.revealClip(clip.originalName);
    close();
  };
  const resetTrim = async () => {
    if (!clip) return;
    close();
    try {
      await window.clips.deleteTrim(clip.originalName);
      toast.show("Trim reset", "success");
    } catch {
      toast.show("Failed to reset trim", "error");
    }
  };
  const resetCache = async () => {
    if (!clip) return;
    close();
    try {
      await window.clips.resetClipCache(clip.originalName);
      toast.show("Cached metadata reset", "success");
    } catch {
      toast.show("Failed to reset cache", "error");
    }
  };
  const deleteClip = async () => {
    if (!clip) return;
    const target = clip;
    close();
    const ok = await confirm({
      title: "Delete clip",
      message: `Delete “${target.customName}”? This permanently removes the file.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await window.clips.deleteClip(target.originalName);
      onDeleted(target.originalName);
      toast.show("Clip deleted", "success");
    } catch {
      toast.show("Failed to delete clip", "error");
    }
  };

  return (
    <ContextMenu open={state !== null} x={state?.x ?? 0} y={state?.y ?? 0} onClose={close}>
      <MenuList>
        <MenuItem icon={<Upload size={15} />} disabled>
          Export (Phase 6)
        </MenuItem>
        <MenuItem icon={<Tag size={15} />} disabled>
          Manage tags (Phase 5)
        </MenuItem>
        <MenuDivider />
        <MenuItem icon={<Scissors size={15} />} onClick={resetTrim}>
          Reset trim
        </MenuItem>
        <MenuItem icon={<RotateCcw size={15} />} onClick={resetCache}>
          Reset cached metadata
        </MenuItem>
        <MenuItem icon={<FolderOpen size={15} />} onClick={revealClip}>
          Reveal in Explorer
        </MenuItem>
        <MenuDivider />
        <MenuItem icon={<Trash2 size={15} />} danger onClick={deleteClip}>
          Delete
        </MenuItem>
      </MenuList>
    </ContextMenu>
  );
});

export default ContextMenuHost;
