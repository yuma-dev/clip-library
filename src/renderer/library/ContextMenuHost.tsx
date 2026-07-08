import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, FolderOpen, Plus, RotateCcw, Scissors, Search, Tag, Trash2, Upload } from "lucide-react";
import ContextMenu from "../ui/ContextMenu";
import { MenuDivider, MenuItem, MenuList } from "../ui/Menu";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/ConfirmDialog";
import type { LocalClip } from "./types";

export interface ContextMenuHandle {
  /**
   * Open the menu for a clip. When `selection` holds more than one clip (the
   * right-clicked card is part of a multi-selection), the menu switches to
   * bulk mode and every action applies to all of them.
   */
  open(x: number, y: number, clip: LocalClip, selection?: LocalClip[]): void;
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
 *
 * Single vs. multi: the host always works on a `clips` array. With one clip it
 * renders the classic per-clip menu; with several, actions loop over all of
 * them and the tag panel's checkmark means "every selected clip has this tag".
 */
const ContextMenuHost = forwardRef<ContextMenuHandle, ContextMenuHostProps>(function ContextMenuHost(
  { onDeleted, setClipTags, globalTags, addGlobalTag },
  ref,
) {
  const [state, setState] = useState<{ x: number; y: number; clips: LocalClip[] } | null>(null);
  const [view, setView] = useState<View>("root");
  // Live per-clip tag sets, seeded on open — gives instant checkbox feedback
  // without waiting for the grid's clip list to re-flow down.
  const [tagMap, setTagMap] = useState<Map<string, Set<string>>>(new Map());
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { confirm } = useConfirm();

  useImperativeHandle(
    ref,
    () => ({
      open: (x, y, clip, selection) => {
        const clips = selection && selection.length > 1 ? selection : [clip];
        setState({ x, y, clips });
        setView("root");
        setQuery("");
        setTagMap(new Map(clips.map((c) => [c.originalName, new Set(c.tags)])));
      },
    }),
    [],
  );

  const close = () => setState(null);
  const clips = state?.clips ?? [];
  const clip = clips[0];
  const multi = clips.length > 1;

  const revealClip = () => {
    if (clip) window.clips.revealClip(clip.originalName);
    close();
  };
  const resetTrim = async () => {
    if (clips.length === 0) return;
    const targets = clips;
    close();
    let failed = 0;
    for (const t of targets) {
      try {
        await window.clips.deleteTrim(t.originalName);
      } catch {
        failed++;
      }
    }
    if (failed === 0) toast.show(multi ? `Trim reset on ${targets.length} clips` : "Trim reset", "success");
    else toast.show(`Failed to reset trim on ${failed} of ${targets.length} clips`, "error");
  };
  const resetCache = async () => {
    if (clips.length === 0) return;
    const targets = clips;
    close();
    let failed = 0;
    for (const t of targets) {
      try {
        await window.clips.resetClipCache(t.originalName);
      } catch {
        failed++;
      }
    }
    if (failed === 0)
      toast.show(multi ? `Cached metadata reset on ${targets.length} clips` : "Cached metadata reset", "success");
    else toast.show(`Failed to reset cache on ${failed} of ${targets.length} clips`, "error");
  };
  const deleteClips = async () => {
    if (clips.length === 0) return;
    const targets = clips;
    close();
    const ok = await confirm({
      title: multi ? `Delete ${targets.length} clips` : "Delete clip",
      message: multi
        ? `Delete ${targets.length} selected clips? This permanently removes the files.`
        : `Delete “${targets[0].customName}”? This permanently removes the file.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    let failed = 0;
    for (const t of targets) {
      try {
        await window.clips.deleteClip(t.originalName);
        onDeleted(t.originalName);
      } catch {
        failed++;
      }
    }
    if (failed === 0) toast.show(multi ? `${targets.length} clips deleted` : "Clip deleted", "success");
    else toast.show(`Failed to delete ${failed} of ${targets.length} clips`, "error");
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

  /** Checked = every clip in scope carries the tag. */
  const tagChecked = (tag: string) =>
    clips.length > 0 && clips.every((c) => tagMap.get(c.originalName)?.has(tag));

  /** Add the tag everywhere it's missing, or (if all have it) remove it everywhere. */
  const toggleTag = (tag: string) => {
    const allHave = tagChecked(tag);
    const next = new Map(tagMap);
    for (const c of clips) {
      const cur = new Set(tagMap.get(c.originalName) ?? []);
      if (allHave) {
        if (!cur.delete(tag)) continue;
      } else {
        if (cur.has(tag)) continue;
        cur.add(tag);
      }
      next.set(c.originalName, cur);
      setClipTags(c.originalName, [...cur]);
    }
    setTagMap(next);
  };
  const createTag = () => {
    if (!canCreate) return;
    addGlobalTag(trimmed);
    // New tag: nobody has it yet, so toggle = add to every selected clip.
    toggleTag(trimmed);
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
          {multi ? (
            <>
              <div className="ctx-multi-head">{clips.length} clips selected</div>
              <MenuDivider />
            </>
          ) : null}
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
          {!multi ? (
            <MenuItem icon={<FolderOpen size={15} />} onClick={revealClip}>
              Reveal in Explorer
            </MenuItem>
          ) : null}
          <MenuDivider />
          <MenuItem icon={<Trash2 size={15} />} danger onClick={deleteClips}>
            {multi ? `Delete ${clips.length} clips` : "Delete"}
          </MenuItem>
        </MenuList>
      ) : (
        <div className="menu ctx-tags">
          <button type="button" className="ctx-tags-head" onClick={() => setView("root")}>
            <ChevronLeft size={14} />
            <span>{multi ? `Manage tags · ${clips.length} clips` : "Manage tags"}</span>
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
                    // Shift+Enter always creates; plain Enter toggles the
                    // closest existing match, falling back to create when there
                    // is no match at all.
                    if (e.shiftKey) {
                      createTag();
                      return;
                    }
                    const match = closestMatch();
                    if (match) {
                      toggleTag(match);
                      setQuery("");
                    } else {
                      createTag();
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
              const checked = tagChecked(tag);
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
