// Badge manager modal (admin only) — in-app port of the website
// BadgeManagerModal.tsx. Two tabs: "Assign" (award/revoke a badge to a user)
// and "Manage" (create / rename / delete badges). Reuses `.share-modal-*`
// styling plus `.badge-mgr-*` extras in profile.css.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  fetchAdminBadges,
  fetchShareUsersAll,
  createBadge,
  updateBadge,
  deleteBadge,
  awardBadge,
  revokeBadge,
} from "./api";
import { getAvatarUrl, type AdminBadge, type ShareUser } from "./types";

type Tab = "assign" | "manage";

interface BadgeManagerModalProps {
  open: boolean;
  onClose: () => void;
}

export default function BadgeManagerModal({ open, onClose }: BadgeManagerModalProps) {
  const [tab, setTab] = useState<Tab>("assign");
  const [badges, setBadges] = useState<AdminBadge[]>([]);
  const [users, setUsers] = useState<ShareUser[]>([]);
  const [selectedBadge, setSelectedBadge] = useState("");
  const [selectedUser, setSelectedUser] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [newIcon, setNewIcon] = useState("");
  const [newName, setNewName] = useState("");
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editIcon, setEditIcon] = useState("");
  const [editName, setEditName] = useState("");

  const aliveRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    aliveRef.current = true;
    setMessage(null);
    setEditingSlug(null);
    void loadBadges();
    void fetchShareUsersAll()
      .then((u) => aliveRef.current && setUsers(u))
      .catch(() => {});
    return () => {
      aliveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const loadBadges = async () => {
    try {
      const b = await fetchAdminBadges();
      if (aliveRef.current) setBadges(b);
    } catch {
      /* ignore */
    }
  };

  if (!open) return null;

  const run = async (fn: () => Promise<void>, success: string) => {
    setLoading(true);
    setMessage(null);
    try {
      await fn();
      if (!aliveRef.current) return;
      setMessage({ type: "success", text: success });
      await loadBadges();
    } catch (err) {
      if (aliveRef.current) {
        setMessage({ type: "error", text: err instanceof Error ? err.message : "Action failed." });
      }
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  };

  const onCreate = () => {
    if (!newIcon.trim() || !newName.trim()) return;
    void run(async () => {
      await createBadge(newIcon.trim(), newName.trim());
      setNewIcon("");
      setNewName("");
    }, `Created badge "${newName.trim()}"`);
  };

  const onSaveEdit = () => {
    if (!editingSlug || !editIcon.trim() || !editName.trim()) return;
    const slug = editingSlug;
    void run(async () => {
      await updateBadge(slug, editIcon.trim(), editName.trim());
      setEditingSlug(null);
    }, "Badge updated");
  };

  const onAward = () => {
    if (!selectedBadge || !selectedUser) return;
    const user = users.find((u) => u.id === selectedUser);
    const badge = badges.find((b) => b.slug === selectedBadge);
    void run(
      () => awardBadge(selectedUser, selectedBadge),
      `Awarded "${badge?.name}" to ${user?.displayName}`,
    );
  };

  const onRevoke = () => {
    if (!selectedBadge || !selectedUser) return;
    const user = users.find((u) => u.id === selectedUser);
    const badge = badges.find((b) => b.slug === selectedBadge);
    void run(
      () => revokeBadge(selectedUser, selectedBadge),
      `Revoked "${badge?.name}" from ${user?.displayName}`,
    );
  };

  const filteredUsers = users.filter(
    (u) =>
      u.displayName.toLowerCase().includes(userSearch.toLowerCase()) ||
      u.username.toLowerCase().includes(userSearch.toLowerCase()),
  );

  return createPortal(
    <div
      className="share-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div className="share-modal badge-mgr-modal" role="dialog" aria-label="Manage badges">
        <div className="share-modal-head">
          <div className="badge-mgr-tabs">
            <button
              type="button"
              className={`badge-mgr-tab${tab === "assign" ? " active" : ""}`}
              onClick={() => {
                setTab("assign");
                setMessage(null);
              }}
            >
              Assign
            </button>
            <button
              type="button"
              className={`badge-mgr-tab${tab === "manage" ? " active" : ""}`}
              onClick={() => {
                setTab("manage");
                setMessage(null);
                setEditingSlug(null);
              }}
            >
              Manage
            </button>
          </div>
          <button type="button" className="share-modal-close" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {tab === "assign" ? (
          <>
            <label className="share-modal-label">Select Badge</label>
            <div className="badge-mgr-chips">
              {badges.length === 0 ? (
                <p className="share-modal-muted">No badges yet. Create one in the Manage tab.</p>
              ) : (
                badges.map((badge) => (
                  <button
                    key={badge.slug}
                    type="button"
                    className={`badge-mgr-chip${selectedBadge === badge.slug ? " selected" : ""}`}
                    onClick={() => setSelectedBadge(badge.slug)}
                  >
                    <span>{badge.icon}</span>
                    <span>{badge.name}</span>
                    <span className="badge-mgr-muted">({badge.userCount})</span>
                  </button>
                ))
              )}
            </div>

            <label className="share-modal-label">Select User</label>
            <input
              type="text"
              className="share-modal-input"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Search users…"
            />
            <div className="share-modal-users badge-mgr-users">
              {filteredUsers.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={`share-modal-user${selectedUser === u.id ? " is-selected" : ""}`}
                  onClick={() => setSelectedUser(u.id)}
                >
                  <img src={getAvatarUrl(u.discordId, u.avatarHash, 24)} alt={u.displayName} />
                  <span className="share-modal-user-name">{u.displayName}</span>
                  <span className="share-modal-user-handle">@{u.username}</span>
                </button>
              ))}
            </div>

            {message && (
              <p className={message.type === "success" ? "badge-mgr-ok" : "share-modal-error"}>
                {message.text}
              </p>
            )}

            <div className="share-modal-actions">
              <button
                type="button"
                className="badge-mgr-danger"
                disabled={!selectedBadge || !selectedUser || loading}
                onClick={onRevoke}
              >
                Revoke
              </button>
              <button
                type="button"
                className="share-modal-primary"
                disabled={!selectedBadge || !selectedUser || loading}
                onClick={onAward}
              >
                {loading ? "Working…" : "Award"}
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="share-modal-label">Create Badge</label>
            <div className="badge-mgr-create">
              <input
                type="text"
                className="share-modal-input badge-mgr-icon-input"
                value={newIcon}
                onChange={(e) => setNewIcon(e.target.value)}
                placeholder="Emoji"
                maxLength={4}
              />
              <input
                type="text"
                className="share-modal-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onCreate()}
                placeholder="Badge name…"
                maxLength={30}
              />
              <button
                type="button"
                className="share-modal-primary"
                disabled={!newIcon.trim() || !newName.trim() || loading}
                onClick={onCreate}
              >
                Add
              </button>
            </div>

            <label className="share-modal-label">Existing Badges</label>
            <div className="badge-mgr-list">
              {badges.length === 0 ? (
                <p className="share-modal-muted">No badges yet</p>
              ) : (
                badges.map((badge) =>
                  editingSlug === badge.slug ? (
                    <div key={badge.slug} className="badge-mgr-row editing">
                      <input
                        type="text"
                        className="share-modal-input badge-mgr-icon-input"
                        value={editIcon}
                        onChange={(e) => setEditIcon(e.target.value)}
                        maxLength={4}
                      />
                      <input
                        type="text"
                        className="share-modal-input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && onSaveEdit()}
                        maxLength={30}
                        autoFocus
                      />
                      <button
                        type="button"
                        className="badge-mgr-link accent"
                        disabled={loading}
                        onClick={onSaveEdit}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="badge-mgr-link"
                        onClick={() => setEditingSlug(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div key={badge.slug} className="badge-mgr-row">
                      <span className="badge-mgr-row-icon">{badge.icon}</span>
                      <span className="badge-mgr-row-name">{badge.name}</span>
                      <span className="badge-mgr-muted">({badge.userCount})</span>
                      {badge.category === "auto" && <span className="badge-mgr-auto">auto</span>}
                      <span className="badge-mgr-row-spacer" />
                      <button
                        type="button"
                        className="badge-mgr-link"
                        onClick={() => {
                          setEditingSlug(badge.slug);
                          setEditIcon(badge.icon);
                          setEditName(badge.name);
                          setMessage(null);
                        }}
                      >
                        Edit
                      </button>
                      {badge.category !== "auto" && (
                        <button
                          type="button"
                          className="badge-mgr-link danger"
                          disabled={loading}
                          onClick={() => void run(() => deleteBadge(badge.slug), "Badge deleted")}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  ),
                )
              )}
            </div>

            {message && (
              <p className={message.type === "success" ? "badge-mgr-ok" : "share-modal-error"}>
                {message.text}
              </p>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
