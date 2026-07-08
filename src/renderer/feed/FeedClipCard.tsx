// Feed clip card — ports the reference website ClipCard, adapted to the app's
// visual language (custom classes + design tokens, not Tailwind). Shares the
// library card's hover feel (translateY(-3px), border + shadow) via feed.css.

import { memo } from "react";
import { Bookmark, Film, MessageSquare } from "lucide-react";
import {
  formatDuration,
  formatRelativeTime,
  getAvatarUrl,
  mediaUrl,
  REACTION_EMOJI,
  type Clip,
} from "./types";
import { toggleReaction, toggleFavorite } from "./api";
import UserPopover from "../ui/UserPopover";
import { useAppNav } from "../shell/appNav";

interface FeedClipCardProps {
  clip: Clip;
  onReactionUpdate: (clipId: string, emoji: string, action: "added" | "removed") => void;
  onFavoriteUpdate: (clipId: string, action: "added" | "removed") => void;
  onOpen: (clip: Clip) => void;
}

function FeedClipCard({ clip, onReactionUpdate, onFavoriteUpdate, onOpen }: FeedClipCardProps) {
  const { openProfile } = useAppNav();

  const topReactions = Object.entries(clip.reactionCounts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  const handleReaction = async (e: React.MouseEvent, emoji: string) => {
    e.stopPropagation();
    const isActive = clip.userReactions.includes(emoji);
    const expectedAction: "added" | "removed" = isActive ? "removed" : "added";
    // Optimistic update
    onReactionUpdate(clip.id, emoji, expectedAction);
    try {
      const res = await toggleReaction(clip.id, emoji);
      // If server disagrees, revert
      if (res.action !== expectedAction) {
        onReactionUpdate(clip.id, emoji, res.action === "added" ? "removed" : "added");
      }
    } catch {
      onReactionUpdate(clip.id, emoji, isActive ? "added" : "removed");
    }
  };

  const handleFavorite = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const expectedAction: "added" | "removed" = clip.isFavorited ? "removed" : "added";
    onFavoriteUpdate(clip.id, expectedAction);
    try {
      const res = await toggleFavorite(clip.id);
      if (res.action !== expectedAction) {
        onFavoriteUpdate(clip.id, res.action === "added" ? "removed" : "added");
      }
    } catch {
      onFavoriteUpdate(clip.id, clip.isFavorited ? "added" : "removed");
    }
  };

  const thumb = mediaUrl(clip.thumbnailUrl);
  const mentions = clip.mentions.slice(0, 4);
  const extraMentions = clip.mentions.length - mentions.length;

  return (
    <article
      className="clip-item feed-card"
      data-clip-id={clip.id}
      data-duration={clip.duration ?? 0}
      onClick={() => onOpen(clip)}
    >
      <div className="clip-item-media-container feed-card-media">
        {thumb ? (
          <img src={thumb} alt={clip.title} loading="lazy" />
        ) : (
          <div className="feed-card-media-empty" aria-hidden="true">
            <Film size={40} />
          </div>
        )}

        {/* Mentions — top-left stacked avatars (reuse library classes). */}
        {clip.mentions.length > 0 && (
          <div className="clip-participants" onClick={(e) => e.stopPropagation()}>
            {mentions.map((mention, i) => {
              const avatarUrl = getAvatarUrl(mention.discordId, mention.avatarHash, 32);
              return (
                <UserPopover
                  key={mention.id}
                  cliplibUserId={mention.id}
                  displayName={mention.displayName}
                  avatarUrl={avatarUrl}
                >
                  <span
                    className="clip-participant"
                    style={{ marginLeft: i > 0 ? "-8px" : 0, zIndex: 10 - i, position: "relative" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      openProfile(mention.id);
                    }}
                  >
                    <img src={avatarUrl} alt={mention.displayName} />
                  </span>
                </UserPopover>
              );
            })}
            {extraMentions > 0 && (
              <span className="clip-participants-more" style={{ zIndex: 0 }}>
                +{extraMentions}
              </span>
            )}
          </div>
        )}

        {/* Duration badge — top-right. */}
        {clip.duration ? (
          <span className="feed-card-duration">{formatDuration(clip.duration)}</span>
        ) : null}

        {/* Reactions — bottom-left. */}
        {topReactions.length > 0 && (
          <div className="feed-card-reactions" onClick={(e) => e.stopPropagation()}>
            {topReactions.map(([emoji, count]) => {
              const isActive = clip.userReactions.includes(emoji);
              return (
                <button
                  key={emoji}
                  type="button"
                  className={`feed-reaction${isActive ? " active" : ""}`}
                  onClick={(e) => handleReaction(e, emoji)}
                >
                  <span>{REACTION_EMOJI[emoji]}</span>
                  <span>{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Comment count — bottom-right. */}
        {clip.commentCount > 0 && (
          <span className="feed-card-comments">
            <MessageSquare size={13} />
            {clip.commentCount}
          </span>
        )}

        {/* Processing overlay. */}
        {clip.status === "processing" && (
          <div className="feed-card-processing">
            <span>Processing…</span>
          </div>
        )}
      </div>

      {/* Footer: text column (title over byline, library-card metrics) + bookmark. */}
      <div className="feed-card-foot">
        <div className="feed-card-info">
          <h3 className="feed-card-title" title={clip.title}>
            {clip.title}
          </h3>
          <div className="feed-card-byline">
            <UserPopover
              cliplibUserId={clip.user.id}
              displayName={clip.user.displayName}
              username={clip.user.username}
              avatarUrl={getAvatarUrl(clip.user.discordId, clip.user.avatarHash, 24)}
            >
              <span
                className="feed-card-uploader-link"
                onClick={(e) => {
                  e.stopPropagation();
                  openProfile(clip.user.id);
                }}
              >
                <img
                  className="feed-card-avatar"
                  src={getAvatarUrl(clip.user.discordId, clip.user.avatarHash, 24)}
                  alt={clip.user.displayName}
                />
                <span className="feed-card-uploader">{clip.user.displayName}</span>
              </span>
            </UserPopover>
            <span className="feed-card-dot">·</span>
            <span className="feed-card-time">{formatRelativeTime(clip.createdAt)}</span>
            {clip.game && (
              <>
                <span className="feed-card-dot">·</span>
                <span className="feed-card-game">{clip.game}</span>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          className={`feed-card-fav${clip.isFavorited ? " active" : ""}`}
          onClick={handleFavorite}
          title={clip.isFavorited ? "Remove bookmark" : "Bookmark"}
          aria-label={clip.isFavorited ? "Remove bookmark" : "Bookmark"}
        >
          <Bookmark size={15} fill={clip.isFavorited ? "currentColor" : "none"} />
        </button>
      </div>
    </article>
  );
}

export default memo(FeedClipCard);
