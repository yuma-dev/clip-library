// Profile page — in-app port of the reference website UserProfilePage.tsx,
// adapted to the app's design language (kebab-case `profile-` classes + design
// tokens, no Tailwind). Rendered as an overlay by App.tsx over the routed view.
//
// Shows the public profile card (banner, avatar, bio, badges, stats), a
// posted / mentioned / favs tab strip, and the matching clip grid. For the
// signed-in user's own profile a subtle strip explains that only published
// clips appear here and links back to the local library.

import { useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { fetchUserProfile } from "./api";
import { fetchMe } from "./me";
import { useFeedClips } from "./useFeedClips";
import { openFeedClip } from "./feedPlayerBus";
import FeedClipCard from "./FeedClipCard";
import { useCardGlow } from "./useCardGlow";
import InfiniteScroll from "./InfiniteScroll";
import SkeletonCards from "./SkeletonCards";
import { useStreamedSlice } from "../ui/useStreamedSlice";
import { ObserveContext, useVisibilityObserver } from "../library/visibility";
import { getAvatarUrl, mediaUrl, type Clip, type UserProfile } from "./types";
import { useAppNav } from "../shell/appNav";
import "./feed.css";
import "./profile.css";

const GRADIENT_MAP: Record<string, string> = {
  sunset: "linear-gradient(135deg, #ff6b35, #f72585)",
  ocean: "linear-gradient(135deg, #0077b6, #00b4d8)",
  forest: "linear-gradient(135deg, #2d6a4f, #52b788)",
  galaxy: "linear-gradient(135deg, #7209b7, #3a0ca3)",
  fire: "linear-gradient(135deg, #e63946, #ff6d00)",
  midnight: "linear-gradient(135deg, #1d3557, #457b9d)",
  aurora: "linear-gradient(135deg, #06d6a0, #7209b7)",
  rose: "linear-gradient(135deg, #ff758f, #ff4d6d)",
};

type ProfileTab = "posted" | "mentioned" | "favs";
const TAB_STORAGE_PREFIX = "profile:tab:v1:";

function parseTab(value: string | null): ProfileTab {
  if (value === "posted" || value === "mentioned" || value === "favs") return value;
  return "posted";
}

function loadTab(userId: string): ProfileTab {
  try {
    return parseTab(sessionStorage.getItem(`${TAB_STORAGE_PREFIX}${userId}`));
  } catch {
    return "posted";
  }
}

export default function ProfilePage({ userId }: { userId: string }) {
  const { closeProfile, openLibrary } = useAppNav();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isOwnProfile, setIsOwnProfile] = useState(false);
  const [activeTab, setActiveTab] = useState<ProfileTab>(() => loadTab(userId));

  // Load the profile whenever the target user changes.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    setProfile(null);
    setActiveTab(loadTab(userId));
    fetchUserProfile(userId)
      .then((p) => {
        if (alive) setProfile(p);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  // Determine whether this is the signed-in user's own public profile.
  useEffect(() => {
    let alive = true;
    fetchMe()
      .then((me) => {
        if (alive) setIsOwnProfile(Boolean(me && me.id === userId));
      })
      .catch(() => {
        if (alive) setIsOwnProfile(false);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  // Persist the selected tab per profile.
  useEffect(() => {
    try {
      sessionStorage.setItem(`${TAB_STORAGE_PREFIX}${userId}`, activeTab);
    } catch {
      /* ignore quota errors */
    }
  }, [activeTab, userId]);

  const clipOptions = useMemo(() => {
    if (activeTab === "mentioned") return { mention: userId };
    if (activeTab === "favs") return { favorite: userId };
    return { user: userId };
  }, [activeTab, userId]);

  const listPersistKey = `profile:v1:${userId}:${activeTab}`;
  const { clips, loading: clipsLoading, hasMore, total, loadMore, updateClipReaction, updateClipFavorite } =
    useFeedClips(clipOptions, listPersistKey);

  const handleOpen = (clip: Clip) =>
    openFeedClip(clip, clips, {
      onReactionUpdate: updateClipReaction,
      onFavoriteUpdate: updateClipFavorite,
    });
  const { gridRef, canvasRef } = useCardGlow();
  // Streamed mounting + offscreen culling — same mechanics as the other grids.
  const shownClips = useStreamedSlice(clips, true) ?? [];
  const observe = useVisibilityObserver();

  if (loading) {
    return (
      <div className="profile-page">
        <div className="profile-scroll clip-scroll">
          <div className="profile-inner">
            <button type="button" className="profile-back" onClick={closeProfile}>
              ← Back
            </button>
            <div className="profile-loading">
              <div className="profile-spinner" aria-label="Loading" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="profile-page">
        <div className="profile-scroll clip-scroll">
          <div className="profile-inner">
            <button type="button" className="profile-back" onClick={closeProfile}>
              ← Back
            </button>
            <p className="profile-error">User not found.</p>
          </div>
        </div>
      </div>
    );
  }

  const accentColor = profile.accentColor || "#8b5cf6";

  const bannerStyle: React.CSSProperties = {};
  if (
    profile.bannerType === "gradient" &&
    profile.bannerGradient &&
    GRADIENT_MAP[profile.bannerGradient]
  ) {
    bannerStyle.background = GRADIENT_MAP[profile.bannerGradient];
  } else if (profile.bannerType !== "image") {
    bannerStyle.background = `linear-gradient(135deg, ${accentColor}30, ${accentColor}10)`;
  }

  const tabs: { key: ProfileTab; label: string; count?: number }[] = [
    { key: "posted", label: "Posted", count: profile.clipCount },
    { key: "mentioned", label: "Mentioned" },
    { key: "favs", label: "Favs", count: profile.favoriteCount },
  ];

  const emptyMessage =
    activeTab === "posted"
      ? "No clips posted yet."
      : activeTab === "mentioned"
        ? "Not featured in any clips yet."
        : "No favorites yet.";

  return (
    <div className="profile-page">
      <div className="profile-scroll clip-scroll">
        <div className="profile-inner">
          <button type="button" className="profile-back" onClick={closeProfile}>
            ← Back
          </button>

          {/* Profile card */}
          <div className="profile-card">
            <div className="profile-banner" style={bannerStyle}>
              {profile.bannerType === "image" && profile.bannerUrl && (
                <img src={mediaUrl(profile.bannerUrl)} alt="" className="profile-banner-img" />
              )}
              <div className="profile-banner-fade" />
            </div>

            <div className="profile-card-body">
              <div className="profile-avatar-row">
                <img
                  className="profile-avatar"
                  src={getAvatarUrl(profile.discordId, profile.avatarHash, 128)}
                  alt={profile.displayName}
                  style={{ borderColor: "var(--color-bg-card)" }}
                />
                <div className="profile-names">
                  <h1 className="profile-display">{profile.displayName}</h1>
                  <p className="profile-handle">@{profile.username}</p>
                </div>
              </div>

              {profile.bio && <p className="profile-bio">{profile.bio}</p>}

              {profile.badges.length > 0 && (
                <div className="profile-badges">
                  {profile.badges.map((badge) => (
                    <span
                      key={badge.slug}
                      className="profile-badge"
                      style={{
                        borderColor: `${accentColor}40`,
                        backgroundColor: `${accentColor}08`,
                      }}
                      title={badge.description || badge.name}
                    >
                      <span>{badge.icon}</span>
                      <span>{badge.name}</span>
                    </span>
                  ))}
                </div>
              )}

              <div className="profile-stats">
                <span className="profile-stat">
                  <span className="profile-stat-num">{profile.clipCount}</span>
                  <span className="profile-stat-label">clips</span>
                </span>
                <span className="profile-stat">
                  <span className="profile-stat-num">{profile.commentCount}</span>
                  <span className="profile-stat-label">comments</span>
                </span>
                <span className="profile-stat">
                  <span className="profile-stat-num">{profile.reactionCount}</span>
                  <span className="profile-stat-label">reactions</span>
                </span>
              </div>

              {isOwnProfile && (
                <div className="profile-own-strip">
                  <Lock size={14} className="profile-own-icon" />
                  <span className="profile-own-text">
                    This is your public profile — only clips you've published appear here. Your
                    private library stays on this PC.
                  </span>
                  <button type="button" className="profile-own-btn" onClick={openLibrary}>
                    Open Library
                  </button>
                </div>
              )}

              {/* Tabs */}
              <div className="profile-tabs">
                {tabs.map((tab) => {
                  const active = activeTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      className={`profile-tab${active ? " active" : ""}`}
                      onClick={() => setActiveTab(tab.key)}
                    >
                      <span>{tab.label}</span>
                      {tab.count !== undefined && tab.count > 0 && (
                        <span className="profile-tab-count">{tab.count}</span>
                      )}
                      <span
                        className="profile-tab-underline"
                        style={active ? { backgroundColor: accentColor } : undefined}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Clips grid — library-sized cards, flat (no time groups: the tab
              already scopes the list, headers would just add noise). */}
          <div className="profile-grid-wrap">
            {clips.length === 0 && !clipsLoading ? (
              <p className="profile-empty">{emptyMessage}</p>
            ) : (
              <div className="clip-grid profile-clip-grid" ref={gridRef}>
                <div className="clip-glow-wrap" aria-hidden="true">
                  <canvas className="clip-glow-canvas" ref={canvasRef} width={16} height={9} />
                </div>
                <div className="clip-group-content">
                  <ObserveContext.Provider value={observe}>
                    {shownClips.map((clip) => (
                      <FeedClipCard
                        key={clip.id}
                        clip={clip}
                        onReactionUpdate={updateClipReaction}
                        onFavoriteUpdate={updateClipFavorite}
                        onOpen={handleOpen}
                      />
                    ))}
                  </ObserveContext.Provider>
                </div>
              </div>
            )}
            <InfiniteScroll onLoadMore={loadMore} hasMore={hasMore} loading={clipsLoading} />
            {hasMore && clips.length > 0 ? (
              <SkeletonCards count={total != null ? total - clips.length : null} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
