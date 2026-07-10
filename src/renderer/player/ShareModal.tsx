// Publish-to-ClipLib modal, opened from the player's upload button. Collects
// title + "featuring" mentions (registered ClipLib users), then hands the
// export+upload to the existing share-clip IPC (main/share.js) and renders
// its progress events. Payload mirrors the legacy buildSharePayload
// (legacy/renderer.js:1942): current trim window, per-clip volume, live speed.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Upload, X } from "lucide-react";
import { useToast } from "../ui/Toast";
import { invalidateFeedListCache } from "../feed/useFeedClips";

interface ShareUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  /** Linked Discord user id, if the ClipLib account is connected to one. */
  discordId?: string | null;
}

interface ShareProgress {
  phase: "preparing" | "exporting" | "uploading" | "done" | "failed";
  percent?: number;
  error?: string;
  clipUrl?: string | null;
}

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
}

type Stage = "form" | "working" | "done" | "failed";

export default function ShareModal({ open, onClose }: ShareModalProps) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [users, setUsers] = useState<ShareUser[] | null>(null);
  const [usersError, setUsersError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<Stage>("form");
  const [progress, setProgress] = useState<ShareProgress | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Discord ids of the people recorded in this clip's .gameinfo — used to
  // preselect the matching ClipLib accounts in the "Featuring" list.
  const [clipDiscordIds, setClipDiscordIds] = useState<Set<string> | null>(null);
  // The upload keeps running main-side if the modal unmounts; guard state sets.
  const aliveRef = useRef(true);
  // Guards the one-time auto-preselect so it can't clobber manual edits.
  const preselectedRef = useRef(false);

  // Reset per open, seeding the title from the player's live title input.
  useEffect(() => {
    if (!open) return;
    aliveRef.current = true;
    const titleInput = document.getElementById("clip-title") as HTMLInputElement | null;
    const current = window.legacyState?.currentClip as
      | { originalName: string; customName: string }
      | undefined;
    setTitle((titleInput?.value ?? "").trim() || current?.customName || "");
    setSelected(new Set());
    setSearch("");
    setStage("form");
    setProgress(null);
    setClipUrl(null);
    setCopied(false);
    setClipDiscordIds(null);
    preselectedRef.current = false;

    // Load the Discord participants recorded in this clip so we can preselect
    // the ClipLib accounts linked to them.
    const clipName = current?.originalName;
    if (clipName) {
      void window.clips
        .getClipParticipants([clipName])
        .then((res) => {
          if (!aliveRef.current) return;
          const ids = res?.byClip?.[clipName] ?? [];
          setClipDiscordIds(new Set(ids));
        })
        .catch(() => {
          if (aliveRef.current) setClipDiscordIds(new Set());
        });
    } else {
      setClipDiscordIds(new Set());
    }

    return () => {
      aliveRef.current = false;
    };
  }, [open]);

  // Load mentionable users when the form shows.
  useEffect(() => {
    if (!open || users) return;
    void window.clips
      .getShareUsers()
      .then((res: { success?: boolean; users?: ShareUser[] } | null) => {
        if (!aliveRef.current) return;
        if (res?.success && Array.isArray(res.users)) setUsers(res.users);
        else setUsersError(true);
      })
      .catch(() => {
        if (aliveRef.current) setUsersError(true);
      });
  }, [open, users]);

  // Once both the user list and the clip's participants have loaded, preselect
  // every ClipLib account whose linked Discord id appears in the clip. Runs
  // once per open (preselectedRef) so it never overrides manual toggles.
  useEffect(() => {
    if (!open || preselectedRef.current || !users || !clipDiscordIds) return;
    preselectedRef.current = true;
    if (clipDiscordIds.size === 0) return;
    const matched = users
      .filter((u) => u.discordId && clipDiscordIds.has(u.discordId))
      .map((u) => u.id);
    if (matched.length > 0) setSelected(new Set(matched));
  }, [open, users, clipDiscordIds]);

  useEffect(() => {
    if (!open) return;
    const unsub = window.clips.onShareUploadProgress((payload: ShareProgress) => {
      if (!aliveRef.current || !payload) return;
      setProgress(payload);
      if (payload.phase === "done") {
        setStage("done");
        setClipUrl(payload.clipUrl ?? null);
      } else if (payload.phase === "failed") {
        setStage("failed");
      }
    });
    return unsub;
  }, [open]);

  const filteredUsers = useMemo(() => {
    if (!users) return [];
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q),
    );
  }, [users, search]);

  const toggleUser = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const publish = useCallback(async () => {
    const state = window.legacyState;
    const player = window.legacyPlayer;
    const video = document.getElementById("video-player") as HTMLVideoElement | null;
    const current = state?.currentClip as { originalName: string; customName: string } | undefined;
    if (!state || !player || !current) return;

    setStage("working");
    setProgress({ phase: "preparing", percent: 0 });

    let volume = 1;
    try {
      volume = (await player.loadVolume(current.originalName)) ?? 1;
    } catch {
      /* default volume */
    }

    // Per-track mix snapshot (null for single-track clips). Without this the
    // uploaded clip ignores individually-adjusted track volumes — see the
    // normal export path in playerExport.ts, which passes the same mix.
    let audioMix: unknown = null;
    try {
      audioMix = player.getActiveAudioTracksManager?.()?.getExportMix?.() ?? null;
    } catch {
      /* single-track / not ready */
    }

    const payload = {
      clipName: current.originalName,
      start: state.trimStartTime,
      end: state.trimEndTime,
      volume,
      speed: video?.playbackRate ?? 1,
      audioMix,
      metadata: {
        title: title.trim() || current.customName,
        tags: Array.isArray((current as { tags?: string[] }).tags)
          ? (current as { tags?: string[] }).tags
          : [],
        mentions: [...selected],
      },
    };

    try {
      const result = (await window.clips.shareClip(payload)) as {
        success?: boolean;
        clipUrl?: string | null;
        error?: string;
      } | null;
      if (!aliveRef.current) return;
      if (result?.success) {
        // The feed caches its list per filter in sessionStorage with a 30s
        // fresh-skip; drop it so opening the feed after this upload refetches
        // and shows the new clip instead of the stale cached list.
        invalidateFeedListCache();
        setStage("done");
        setClipUrl(result.clipUrl ?? null);
      } else {
        setStage("failed");
        setProgress({ phase: "failed", error: result?.error || "Upload failed." });
      }
    } catch (err) {
      if (!aliveRef.current) return;
      setStage("failed");
      setProgress({ phase: "failed", error: err instanceof Error ? err.message : "Upload failed." });
    }
  }, [title, selected]);

  const copyLink = useCallback(() => {
    if (!clipUrl) return;
    void navigator.clipboard.writeText(clipUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, [clipUrl]);

  if (!open) return null;

  const percent = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)));
  const phaseLabel =
    progress?.phase === "exporting"
      ? "Exporting clip…"
      : progress?.phase === "uploading"
        ? "Uploading…"
        : "Preparing…";

  return createPortal(
    <div
      className="share-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && stage !== "working") onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div className="share-modal" role="dialog" aria-label="Publish to ClipLib">
        <div className="share-modal-head">
          <h2>Publish to ClipLib</h2>
          <button
            type="button"
            className="share-modal-close"
            aria-label="Close"
            disabled={stage === "working"}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {stage === "form" && (
          <>
            <label className="share-modal-label" htmlFor="share-title">
              Title
            </label>
            <input
              id="share-title"
              className="share-modal-input"
              maxLength={100}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />

            <label className="share-modal-label" htmlFor="share-featuring">
              Featuring
            </label>
            {selected.size > 0 && users ? (
              <div className="share-modal-chips">
                {users
                  .filter((u) => selected.has(u.id))
                  .map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      className="share-modal-chip"
                      onClick={() => toggleUser(u.id)}
                      title="Remove"
                    >
                      {u.avatarUrl ? <img src={u.avatarUrl} alt="" /> : null}
                      {u.displayName}
                      <X size={12} />
                    </button>
                  ))}
              </div>
            ) : null}
            <input
              id="share-featuring"
              className="share-modal-input"
              placeholder="Search friends…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="share-modal-users">
              {usersError ? (
                <p className="share-modal-muted">Couldn't load users.</p>
              ) : !users ? (
                <p className="share-modal-muted">Loading…</p>
              ) : filteredUsers.length === 0 ? (
                <p className="share-modal-muted">No matches.</p>
              ) : (
                filteredUsers.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className={`share-modal-user${selected.has(u.id) ? " is-selected" : ""}`}
                    onClick={() => toggleUser(u.id)}
                  >
                    {u.avatarUrl ? <img src={u.avatarUrl} alt="" /> : <span className="share-modal-user-fallback" />}
                    <span className="share-modal-user-name">{u.displayName}</span>
                    <span className="share-modal-user-handle">@{u.username}</span>
                    {selected.has(u.id) ? <Check size={14} /> : null}
                  </button>
                ))
              )}
            </div>

            <div className="share-modal-actions">
              <button type="button" className="share-modal-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="share-modal-primary" onClick={() => void publish()}>
                <Upload size={14} />
                Publish
              </button>
            </div>
          </>
        )}

        {stage === "working" && (
          <div className="share-modal-progress">
            <p>{phaseLabel}</p>
            <div className="share-modal-bar">
              <div className="share-modal-bar-fill" style={{ width: `${percent}%` }} />
            </div>
            <p className="share-modal-muted">{percent}%</p>
          </div>
        )}

        {stage === "done" && (
          <div className="share-modal-result">
            <p>Clip published! It'll appear in the feed once processing finishes.</p>
            <div className="share-modal-actions">
              {clipUrl ? (
                <button type="button" className="share-modal-secondary" onClick={copyLink}>
                  <Copy size={14} />
                  {copied ? "Copied!" : "Copy link"}
                </button>
              ) : null}
              <button
                type="button"
                className="share-modal-primary"
                onClick={() => {
                  toast.show("Published to ClipLib");
                  onClose();
                }}
              >
                Done
              </button>
            </div>
          </div>
        )}

        {stage === "failed" && (
          <div className="share-modal-result">
            <p className="share-modal-error">{progress?.error || "Upload failed."}</p>
            <div className="share-modal-actions">
              <button type="button" className="share-modal-secondary" onClick={onClose}>
                Close
              </button>
              <button type="button" className="share-modal-primary" onClick={() => setStage("form")}>
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
