import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, FolderOpen, Plus, RotateCcw, Scissors, Search, Tag, Trash2, Upload } from "lucide-react";
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
  /** Persist + propagate a clip's tag list (drives the "Manage tags" panel). */
  setClipTags: (originalName: string, tags: string[]) => void;
  /** Assignable global tags, in display order. */
  globalTags: string[];
  /** Create a brand-new global tag. */
  addGlobalTag: (tag: string) => void;
}

type View = "root" | "tags";

/**
 * Isolated context-menu host: holds its own open/position/clip state so that
 * opening the menu does NOT re-render the (2000-card) grid. Cards trigger it
 * imperatively via the ref handle. "Manage tags" swaps the menu in place for a
 * searchable tag panel (Phase 5); Export stays stubbed until Phase 6.
 */
const ContextMenuHost = forwardRef<ContextMenuHandle, ContextMenuHostProps>(function ContextMenuHost(
  { onDeleted, setClipTags, globalTags, addGlobalTag },
  ref,
) {
  const [state, setState] = useState<{ x: number; y: number; clip: LocalClip } | null>(null);
  const [view, setView] = useState<View>("root");
  // The clip's live tag set, seeded on open — gives instant checkbox feedback
  // without waiting for the grid's clip list to re-flow down.
  const [tagSet, setTagSet] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { confirm } = useConfirm();

  useImperativeHandle(
    ref,
    () => ({
      open: (x, y, clip) => {
        setState({ x, y, clip });
        setView("root");
        setQuery("");
        setTagSet(new Set(clip.tags));
      },
    }),
    [],
  );

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

  // --- Tag panel ---
  const q = query.trim().toLowerCase();
  const shownTags = useMemo(() => {
    const list = globalTags.filter((t) => t.toLowerCase().includes(q));
    if (!q) return list;
    return [...list].sort((a, b) => a.toLowerCase().indexOf(q) - b.toLowerCase().indexOf(q));
  }, [globalTags, q]);
  const trimmed = query.trim();
  // The "+" button creates only a genuinely new tag (legacy behavior).
  const canCreate =
    trimmed.length > 0 && !globalTags.some((t) => t.toLowerCase() === trimmed.toLowerCase());
  // Enter toggles the closest existing match: exact, else prefix (legacy).
  const closestMatch = () =>
    q ? globalTags.find((t) => t.toLowerCase() === q || t.toLowerCase().startsWith(q)) : undefined;

  const applyTags = (next: Set<string>) => {
    if (clip) setClipTags(clip.originalName, [...next]);
  };
  const toggleTag = (tag: string) => {
    setTagSet((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      applyTags(next);
      return next;
    });
  };
  const createTag = () => {
    if (!canCreate) return;
    addGlobalTag(trimmed);
    setTagSet((prev) => {
      const next = new Set(prev);
      next.add(trimmed);
      applyTags(next);
      return next;
    });
    setQuery("");
    searchRef.current?.focus();
  };

  const openTags = () => {
    setView("tags");
    // Focus the search once the panel has swapped in.
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  return (
    <ContextMenu open={state !== null} x={state?.x ?? 0} y={state?.y ?? 0} onClose={close}>
      {view === "root" ? (
        <MenuList>
          <MenuItem icon={<Upload size={15} />} disabled>
            Export (Phase 6)
          </MenuItem>
          <button type="button" role="menuitem" className="menu-item ctx-submenu" onClick={openTags}>
            <span className="menu-icon">
              <Tag size={15} />
            </span>
            <span className="menu-label">Manage tags</span>
            <ChevronRight size={14} className="ctx-submenu-caret" />
          </button>
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
      ) : (
        <div className="menu ctx-tags">
          <button type="button" className="ctx-tags-head" onClick={() => setView("root")}>
            <ChevronLeft size={14} />
            <span>Manage tags</span>
          </button>
          <div className="ctx-tags-search-row">
            <label className="ctx-tags-search">
              <Search size={13} />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tags…"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    // Escape backs out of the panel instead of closing the menu.
                    e.stopPropagation();
                    if (query) setQuery("");
                    else setView("root");
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    // Enter toggles the closest existing match; never creates.
                    const match = closestMatch();
                    if (match) {
                      toggleTag(match);
                      setQuery("");
                    }
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="ctx-tags-add"
              title={canCreate ? `Create “${trimmed}”` : "Type a new tag name to create it"}
              aria-label="Create tag"
              disabled={!canCreate}
              onClick={createTag}
            >
              <Plus size={15} strokeWidth={2.5} />
            </button>
          </div>
          <div className="ctx-tags-list">
            {shownTags.map((tag) => {
              const checked = tagSet.has(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  className={`ctx-tag-row${checked ? " checked" : ""}`}
                  onClick={() => toggleTag(tag)}
                  title={tag}
                >
                  <span className="ctx-tag-check" aria-hidden="true">
                    {checked ? <Check size={12} strokeWidth={3} /> : null}
                  </span>
                  <span className="ctx-tag-label">{tag}</span>
                </button>
              );
            })}
            {shownTags.length === 0 ? (
              <div className="ctx-tags-empty">
                {trimmed ? "No matching tags — press + to create" : "No tags"}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </ContextMenu>
  );
});

export default ContextMenuHost;
