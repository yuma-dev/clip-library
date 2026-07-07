import { useMemo, useState } from "react";
import { Check, Pencil, Plus, Search, Tag, Trash2, X } from "lucide-react";
import Modal from "../ui/Modal";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/Toast";
import type { UseClips } from "../library/useClips";
import type { UseLibraryFilter } from "../library/useLibraryFilter";

interface TagManagerModalProps {
  open: boolean;
  onClose: () => void;
  lib: UseClips;
  filter: UseLibraryFilter;
}

/**
 * Global tag management (settings → "Manage tags"): create, rename across all
 * clips, and delete across all clips — the legacy tag-management dialog,
 * rebuilt on the shared modal/tag primitives.
 */
export default function TagManagerModal({ open, onClose, lib, filter }: TagManagerModalProps) {
  const confirm = useConfirm();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const clip of lib.clips) {
      for (const tag of clip.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
    }
    return map;
  }, [lib.clips]);

  const q = query.trim().toLowerCase();
  const visible = filter.globalTags.filter((t) => !q || t.toLowerCase().includes(q));
  const canCreate =
    query.trim().length > 0 && !filter.globalTags.some((t) => t.toLowerCase() === query.trim().toLowerCase());

  const create = () => {
    if (!canCreate) return;
    filter.addGlobalTag(query.trim());
    toast.show(`Tag "${query.trim()}" created`, "success");
    setQuery("");
  };

  const commitRename = async (oldTag: string) => {
    const newTag = draft.trim();
    setEditing(null);
    if (!newTag || newTag === oldTag) return;
    if (filter.globalTags.some((t) => t.toLowerCase() === newTag.toLowerCase() && t !== oldTag)) {
      toast.show(`A tag named "${newTag}" already exists`, "error");
      return;
    }
    setBusy(oldTag);
    try {
      await window.clips.updateTagInAllClips(oldTag, newTag);
      filter.renameGlobalTag(oldTag, newTag);
      lib.renameTagInClips(oldTag, newTag);
      toast.show(`Renamed "${oldTag}" to "${newTag}"`, "success");
    } catch (err) {
      toast.show(`Rename failed: ${(err as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (tag: string) => {
    const used = counts.get(tag) ?? 0;
    const ok = await confirm.confirm({
      title: "Delete tag",
      message:
        used > 0
          ? `Delete "${tag}"? It will be removed from ${used} clip${used === 1 ? "" : "s"}.`
          : `Delete "${tag}"?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(tag);
    try {
      await window.clips.removeTagFromAllClips(tag);
      filter.removeGlobalTag(tag);
      lib.removeTagFromClips(tag);
      toast.show(`Tag "${tag}" deleted`, "success");
    } catch (err) {
      toast.show(`Delete failed: ${(err as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={480}
      title={
        <>
          <Tag size={15} className="dia" /> Manage tags
          <span className="tagman-total">{filter.globalTags.length}</span>
        </>
      }
    >
      <div className="tagman">
        <div className="tagman-search-row">
          <label className="tagman-search">
            <Search size={14} />
            <input
              value={query}
              placeholder="Search or create a tag…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate) create();
              }}
            />
          </label>
          <button type="button" className="btn btn-primary tagman-create" disabled={!canCreate} onClick={create}>
            <Plus size={14} /> Create
          </button>
        </div>

        <div className="tagman-list">
          {visible.length === 0 ? (
            <div className="tagman-empty">
              {filter.globalTags.length === 0
                ? "No tags yet — type a name above to create one."
                : canCreate
                  ? `Press Enter to create "${query.trim()}".`
                  : "No tags match."}
            </div>
          ) : null}
          {visible.map((tag) => {
            const used = counts.get(tag) ?? 0;
            const isEditing = editing === tag;
            return (
              <div className={`tagman-row${busy === tag ? " busy" : ""}`} key={tag}>
                {isEditing ? (
                  <input
                    className="tagman-edit"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(tag);
                      else if (e.key === "Escape") setEditing(null);
                    }}
                    onBlur={() => void commitRename(tag)}
                  />
                ) : (
                  <>
                    <span className="tagman-name" title={tag}>
                      {tag}
                    </span>
                    <span className="tagman-count">
                      {used} clip{used === 1 ? "" : "s"}
                    </span>
                  </>
                )}
                <div className="tagman-actions">
                  {isEditing ? (
                    <>
                      <button type="button" className="tagman-btn" title="Save" onMouseDown={(e) => e.preventDefault()} onClick={() => void commitRename(tag)}>
                        <Check size={14} />
                      </button>
                      <button type="button" className="tagman-btn" title="Cancel" onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(null)}>
                        <X size={14} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="tagman-btn"
                        title="Rename tag"
                        disabled={busy !== null}
                        onClick={() => {
                          setEditing(tag);
                          setDraft(tag);
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="tagman-btn danger"
                        title="Delete tag"
                        disabled={busy !== null}
                        onClick={() => void remove(tag)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <p className="tagman-hint">Renaming or deleting a tag updates every clip that uses it.</p>
      </div>
    </Modal>
  );
}
