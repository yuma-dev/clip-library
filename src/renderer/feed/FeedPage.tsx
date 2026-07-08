// In-app ClipLib feed. Ported from the reference website FeedPage, adapted to
// the app's shell conventions (custom classes + design tokens; scrolls in a
// .clip-scroll container like LibraryView).
//
// Filters live in the SIDEBAR while this route is active (FeedRailFilters ↔
// feedFilters store); this page only renders the grid. The clip fetch starts
// immediately — it does NOT wait for the auth verification round-trip; a 401
// (not connected) falls through to the connect prompt.

import { useEffect, useMemo } from "react";
import { Film } from "lucide-react";
import { useProfile } from "../shell/useProfile";
import { useFeedClips } from "./useFeedClips";
import { openFeedClip } from "./feedPlayerBus";
import { feedPersistKey, setFeedGames, useFeedFilters } from "./feedFilters";
import FeedGroup from "./FeedGroup";
import { useFeedGroups } from "./useFeedGroups";
import { useCardGlow } from "./useCardGlow";
import { ObserveContext, useVisibilityObserver } from "../library/visibility";
import InfiniteScroll from "./InfiniteScroll";
import type { Clip } from "./types";
import "./feed.css";

const FEED_COLLAPSE_KEY = "cliplib-feed:collapsed-groups";

export default function FeedPage() {
  const profile = useProfile();
  const filters = useFeedFilters();
  const { gridRef, canvasRef } = useCardGlow();
  // Offscreen culling — same .cv-offscreen mechanism as the library grid.
  const observe = useVisibilityObserver();

  const options = useMemo(
    () => ({ user: filters.user, mention: filters.mention, game: filters.game, sort: filters.sort }),
    [filters.user, filters.mention, filters.game, filters.sort],
  );
  const listPersistKey = feedPersistKey(filters);

  const { clips, loading, hasMore, error, loadMore, updateClipReaction, updateClipFavorite } =
    useFeedClips(options, listPersistKey);

  const { groups, collapsed, toggle } = useFeedGroups(clips, FEED_COLLAPSE_KEY);

  // Feed the sidebar's game filter with the distinct games seen so far.
  useEffect(() => {
    const set = new Set<string>();
    clips.forEach((c) => {
      if (c.game) set.add(c.game);
    });
    setFeedGames(Array.from(set).sort());
  }, [clips]);

  const handleOpen = (clip: Clip) =>
    openFeedClip(clip, clips, {
      onReactionUpdate: updateClipReaction,
      onFavoriteUpdate: updateClipFavorite,
    });

  // Connect prompt: shown whenever we know we're logged out (verified) or the
  // fetch itself came back 401 — cached clips must NOT keep an unauthenticated
  // feed browsable. `verifying` keeps the first fetch unblocked on startup.
  const notConnected = (!profile.connected && !profile.verifying) || error?.status === 401;

  if (notConnected) {
    return (
      <div className="feed-view">
        <div className="clip-empty">
          <div className="clip-empty-mark" aria-hidden="true">
            ◇
          </div>
          <p className="clip-empty-title">Connect to ClipLib</p>
          <p className="clip-empty-sub">Sign in to browse the shared clip feed.</p>
          <button type="button" className="feed-connect-btn" onClick={profile.connect}>
            Connect ClipLib
          </button>
        </div>
      </div>
    );
  }

  return (
    <ObserveContext.Provider value={observe}>
    <div className="feed-view">
      <div className="feed-scroll clip-scroll">
        {clips.length === 0 && !loading ? (
          <div className="feed-inner">
            <div className="clip-empty">
              <div className="feed-empty-icon" aria-hidden="true">
                <Film size={56} />
              </div>
              <p className="clip-empty-title">No clips yet</p>
              <p className="clip-empty-sub">
                Share a clip from the desktop app to see it here.
              </p>
            </div>
          </div>
        ) : (
          <div className="clip-grid feed-clip-grid" ref={gridRef}>
            <div className="clip-glow-wrap" aria-hidden="true">
              <canvas className="clip-glow-canvas" ref={canvasRef} width={16} height={9} />
            </div>
            {groups.map((group) => (
              <FeedGroup
                key={group.name}
                name={group.name}
                clips={group.clips}
                collapsed={Boolean(collapsed[group.name])}
                onToggle={toggle}
                onReactionUpdate={updateClipReaction}
                onFavoriteUpdate={updateClipFavorite}
                onOpen={handleOpen}
              />
            ))}
            <InfiniteScroll onLoadMore={loadMore} hasMore={hasMore} loading={loading} />
          </div>
        )}
      </div>
    </div>
    </ObserveContext.Provider>
  );
}
