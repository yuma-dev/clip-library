import { memo, useDeferredValue, useEffect, useState } from "react";
import ClipCard from "./ClipCard";
import type { ClipGroupData } from "./grouping";
import type { LocalClip } from "./types";

interface ClipGroupProps {
  group: ClipGroupData;
  thumbnails: Map<string, string | null>;
  grayscaleIcons: boolean;
  collapsed: boolean;
  onToggle: (name: string) => void;
}

// Mounting a card costs ~2ms (React + layout + paint), so an 800-clip group
// mounted in one commit blocks paint for ~2s. Instead: mount a screenful
// immediately, then stream the rest one chunk per frame — time-to-content is
// one small commit, and no single frame does unbounded work.
const INITIAL_CARDS = 24;
const CARDS_PER_FRAME = 80;

function ClipGroup({ group, thumbnails, grayscaleIcons, collapsed, onToggle }: ClipGroupProps) {
  // The header reacts to `collapsed` urgently (instant diamond/aria feedback);
  // the card mounting below runs as a deferred, interruptible render.
  const expanded = !useDeferredValue(collapsed);

  const [visible, setVisible] = useState(INITIAL_CARDS);

  // Render-phase derived-state adjustments (group identity is stabilized by
  // ClipGrid, so `group.clips` changing means membership really changed):
  //  - collapsing resets the budget while content is unmounted, so a
  //    re-expand streams again instead of replaying one giant commit;
  //  - a shrunk list clamps the budget (never renders past the end);
  //  - a grown list keeps the current budget and streams up via the effect,
  //    so already-mounted cards are never unmounted (no flicker).
  const [prev, setPrev] = useState<{ clips: LocalClip[]; expanded: boolean }>({
    clips: group.clips,
    expanded,
  });
  if (prev.clips !== group.clips || prev.expanded !== expanded) {
    setPrev({ clips: group.clips, expanded });
    if (!expanded) {
      if (visible !== INITIAL_CARDS) setVisible(INITIAL_CARDS);
    } else if (group.clips.length < visible) {
      setVisible(Math.max(INITIAL_CARDS, group.clips.length));
    }
  }

  useEffect(() => {
    if (!expanded || visible >= group.clips.length) return;
    // rAF paces streaming to the display, but Chromium suspends rAF for
    // hidden/occluded windows — the timeout fallback keeps the stream
    // draining so the grid is complete when the user comes back.
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      advanced = true;
      setVisible((v) => Math.min(v + CARDS_PER_FRAME, group.clips.length));
    };
    const raf = requestAnimationFrame(advance);
    const timer = window.setTimeout(advance, 64);
    return () => {
      advanced = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [expanded, visible, group.clips.length]);

  const shown = expanded ? group.clips.slice(0, Math.min(visible, group.clips.length)) : null;

  return (
    <section className="clip-group">
      <button
        type="button"
        className="clip-group-header"
        onClick={() => onToggle(group.name)}
        aria-expanded={!collapsed}
      >
        {/* ◆ gradient diamond — rotates 45° when the group is open (design). */}
        <span className={`clip-group-diamond${collapsed ? "" : " open"}`} aria-hidden="true" />
        <h2 className="clip-group-title">{group.name}</h2>
        <span className="clip-group-count">{group.clips.length}</span>
        <span className="clip-group-divider" />
      </button>

      {shown ? (
        <div className="clip-group-content">
          {shown.map((clip) => (
            <ClipCard
              key={clip.originalName}
              clip={clip}
              thumbnailPath={thumbnails.get(clip.originalName) ?? null}
              grayscaleIcons={grayscaleIcons}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default memo(ClipGroup);
