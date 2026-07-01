import { useEffect, useRef, useState } from "react";
import { useObserve } from "./visibility";
import { useHover } from "./hoverContext";
import { absoluteTime, relativeTime } from "./time";
import Tooltip from "../ui/Tooltip";
import type { LocalClip } from "./types";
import shimmerUrl from "../../../assets/loading-thumbnail.gif";
import fallbackUrl from "../../../assets/fallback-image.jpg";

interface ClipCardProps {
  clip: LocalClip;
  thumbnailPath: string | null;
}

export default function ClipCard({ clip, thumbnailPath }: ClipCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const observe = useObserve();
  const hover = useHover();
  const [errored, setErrored] = useState(false);

  // Register with the shared visibility observer (toggles .cv-offscreen).
  useEffect(() => {
    if (ref.current && observe) return observe(ref.current);
  }, [observe]);

  const src = errored ? fallbackUrl : thumbnailPath ? `file://${thumbnailPath}` : shimmerUrl;
  const visibleTags = clip.tags.slice(0, 3);
  const extraTags = clip.tags.slice(3);

  return (
    <div
      className="clip-item"
      ref={ref}
      data-original-name={clip.originalName}
      onMouseEnter={() => {
        if (ref.current && hover) hover.enter(ref.current, clip);
      }}
      onMouseLeave={() => {
        if (hover) hover.leave();
      }}
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
        {/* Imperative hover-preview <video> is mounted here (display:contents),
            so React never reconciles it. */}
        <div className="clip-preview-mount" />
      </div>

      {visibleTags.length > 0 ? (
        <div className="tag-container">
          {visibleTags.map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
          {extraTags.length > 0 ? (
            <Tooltip label={extraTags.join(", ")}>
              <span className="tag more-tags">+{extraTags.length}</span>
            </Tooltip>
          ) : null}
        </div>
      ) : null}

      <div className="clip-info">
        <p className="clip-name" title={clip.customName}>
          {clip.customName}
        </p>
        <p className="clip-time" title={absoluteTime(clip.createdAt)}>
          {relativeTime(clip.createdAt)}
        </p>
      </div>
    </div>
  );
}
