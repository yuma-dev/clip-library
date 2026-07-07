import { memo, useEffect, useRef, useState } from "react";
import { useObserve } from "./visibility";
import { useHover } from "./hoverContext";
import { useSelection } from "./selectionContext";
import { useRename } from "./renameContext";
import { absoluteTime, relativeTime } from "./time";
import { getCachedGameIcon, loadGameIcon, type GameIcon } from "./gameIcon";
import Tooltip from "../ui/Tooltip";
import type { LocalClip } from "./types";
import shimmerUrl from "../../../assets/loading-thumbnail.gif";
import fallbackUrl from "../../../assets/fallback-image.jpg";

interface ClipCardProps {
  clip: LocalClip;
  thumbnailPath: string | null;
  grayscaleIcons: boolean;
}

function ClipCard({ clip, thumbnailPath, grayscaleIcons }: ClipCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const observe = useObserve();
  const hover = useHover();
  const selection = useSelection();
  const rename = useRename();
  const [errored, setErrored] = useState(false);
  const [editing, setEditing] = useState(false);
  const [icon, setIcon] = useState<GameIcon | null>(() => getCachedGameIcon(clip.originalName) ?? null);
  const editRef = useRef<HTMLInputElement>(null);

  // Focus + select the whole title when entering edit mode.
  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editing]);

  // Register with the shared visibility observer (toggles .cv-offscreen), and
  // re-apply the selected class if this card (re)mounts while selected.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (selection?.isSelected(clip.originalName)) el.classList.add("selected");
    return observe ? observe(el) : undefined;
  }, [observe, selection, clip.originalName]);

  // Resolve the game/application icon (cached + deduped at module scope).
  useEffect(() => {
    if (icon) return;
    let alive = true;
    void loadGameIcon(clip.originalName).then((res) => {
      // Most clips resolve to "no icon" — skip the state update (and the
      // card re-render) unless there's actually something to show.
      if (alive && (res.path || res.title)) setIcon(res);
    });
    return () => {
      alive = false;
    };
  }, [clip.originalName, icon]);

  const src = errored ? fallbackUrl : thumbnailPath ? `file://${thumbnailPath}` : shimmerUrl;
  const visibleTags = clip.tags.slice(0, 3);
  const extraTags = clip.tags.slice(3);

  return (
    <div
      className={`clip-item${clip.isNewSinceLastSession ? " is-new" : ""}`}
      ref={ref}
      data-original-name={clip.originalName}
      onMouseEnter={() => {
        if (ref.current && hover) hover.enter(ref.current, clip);
      }}
      onMouseLeave={() => {
        if (hover) hover.leave();
      }}
      onClick={(e) => selection?.onCardClick(e, clip)}
      onContextMenu={(e) => selection?.onCardContextMenu(e, clip)}
    >
      <div className="clip-item-media-container">
        <img
          src={src}
          alt={clip.customName}
          draggable={false}
          loading="lazy"
          decoding="async"
          onError={() => {
            if (thumbnailPath && !errored) setErrored(true);
          }}
        />
        {/* Imperative hover-preview <video> mounts here (display:contents). */}
        <div className="clip-preview-mount" />
      </div>

      <div className="clip-foot">
        <div className="clip-info">
          {editing ? (
            <input
              ref={editRef}
              className="clip-name clip-name-edit"
              defaultValue={clip.customName}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.currentTarget.value = clip.customName; // revert -> blur skips save
                  e.currentTarget.blur();
                }
              }}
              onBlur={(e) => {
                const value = e.currentTarget.value.trim();
                setEditing(false);
                if (rename && value && value !== clip.customName) {
                  void rename(clip.originalName, value);
                }
              }}
            />
          ) : (
            <p
              className="clip-name"
              title={clip.customName}
              onClick={(e) => {
                // Click the title to rename; don't open the player.
                e.stopPropagation();
                if (rename) setEditing(true);
              }}
            >
              {clip.isNewSinceLastSession ? (
                <span className="clip-new-dot" aria-hidden="true" />
              ) : null}
              {clip.customName}
            </p>
          )}

          <div className="clip-meta-row">
            <span className="clip-time" title={absoluteTime(clip.createdAt)}>
              {relativeTime(clip.createdAt)}
            </span>
            {visibleTags.map((tag) => (
              <span className="tag" key={tag} title={tag}>
                {tag}
              </span>
            ))}
            {extraTags.length > 0 ? (
              <Tooltip label={extraTags.join(", ")}>
                <span className="tag more-tags">+{extraTags.length}</span>
              </Tooltip>
            ) : null}
          </div>
        </div>

        {icon?.path ? (
          <span className="clip-game" title={icon.title ?? undefined}>
            <img
              className={grayscaleIcons ? "grayscale" : undefined}
              src={`file://${icon.path}`}
              alt=""
              draggable={false}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default memo(ClipCard);
