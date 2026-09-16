// Hover profile popover, in-app port of ClipLib website's UserPopover (same
// component, share/src/components/UserPopover.tsx): 120ms open/60ms close hover
// intent, positioned above anchor with viewport flip+clamp, portaled to body.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Heart, MessageSquare, Video } from "lucide-react";
import { participantDisplayName, type DiscordParticipant } from "../library/discord";
import { getShareUserForDiscordId, loadShareUsers, type ShareUser } from "../library/shareIdentity";
import { useAppNav } from "../shell/appNav";
import { fetchUserProfile, getCachedUserProfile } from "../feed/api";
import { getAvatarUrl, type UserProfile } from "../feed/types";

const ENTER_DELAY_MS = 120;
const HIDE_DELAY_MS = 60;
const POPOVER_GAP = 6;
const VIEWPORT_PADDING = 12;

export function discordAvatarUrl(p: DiscordParticipant): string {
  if (p.avatar_url) return p.avatar_url;
  // Discord's default-avatar bucket for users without a custom avatar.
  let index = 0;
  try {
    index = Number((BigInt(p.id) >> 22n) % 6n);
  } catch {
    /* non-numeric id, bucket 0 */
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

// Port of the website popover's join-date formatter.
function formatJoinDate(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 1) return "Joined today";
  if (days < 30) return `Joined ${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Joined ${months}mo ago`;
  const years = Math.floor(months / 12);
  return `Joined ${years}y ago`;
}

interface CommonProps {
  children: ReactNode;
}

// Discord-participant variant (ParticipantAvatars, backward compatible).
interface ParticipantVariantProps extends CommonProps {
  participant: DiscordParticipant;
  cliplibUserId?: undefined;
}

// ClipLib-user variant (feed): id already known, seed head row with overrides.
interface CliplibVariantProps extends CommonProps {
  cliplibUserId: string;
  participant?: undefined;
  displayName?: string;
  username?: string;
  avatarUrl?: string;
}

type UserPopoverProps = ParticipantVariantProps | CliplibVariantProps;

export default function UserPopover(props: UserPopoverProps) {
  const { children } = props;
  const participant = "participant" in props ? props.participant : undefined;
  const directUserId = "cliplibUserId" in props ? props.cliplibUserId : undefined;

  const anchorRef = useRef<HTMLSpanElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const { openProfile } = useAppNav();

  const [visible, setVisible] = useState(false);
  // set the instant hover starts: profile fetch begins during the open delay
  // not after the popover appears, so data is usually ready by then
  const [wanted, setWanted] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // ClipLib match (participant variant); direct variant synthesizes a minimal
  // ShareUser so the fetch path is shared
  const [shareUser, setShareUser] = useState<ShareUser | null>(() =>
    directUserId
      ? {
          id: directUserId,
          username: "username" in props ? props.username ?? "" : "",
          displayName: "displayName" in props ? props.displayName ?? "" : "",
          avatarUrl: "avatarUrl" in props ? props.avatarUrl ?? "" : "",
          discordId: null,
        }
      : participant
        ? getShareUserForDiscordId(participant.id)
        : null,
  );
  const cliplibUserId = shareUser?.id;
  const [profile, setProfile] = useState<UserProfile | null>(() =>
    cliplibUserId ? getCachedUserProfile(cliplibUserId) ?? null : null,
  );

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const scheduleOpen = () => {
    clearTimer();
    setWanted(true);
    timerRef.current = window.setTimeout(() => setVisible(true), ENTER_DELAY_MS);
  };

  const scheduleClose = () => {
    clearTimer();
    timerRef.current = window.setTimeout(() => setVisible(false), HIDE_DELAY_MS);
  };

  useEffect(() => clearTimer, []);

  // resolve the ClipLib match lazily (participant variant), once hover intent starts
  useEffect(() => {
    if (!wanted || shareUser || !participant) return;
    let alive = true;
    void loadShareUsers().then(() => {
      if (alive) setShareUser(getShareUserForDiscordId(participant.id));
    });
    return () => {
      alive = false;
    };
  }, [wanted, shareUser, participant]);

  // fetch profile once we have a ClipLib id and hover intent started, don't wait for visible
  useEffect(() => {
    if (!wanted || !cliplibUserId || profile) return;
    let alive = true;
    void fetchUserProfile(cliplibUserId)
      .then((p) => {
        if (alive) setProfile(p);
      })
      .catch(() => {
        /* registered but profile failed, keep minimal card */
      });
    return () => {
      alive = false;
    };
  }, [wanted, cliplibUserId, profile]);

  // position after render (size is content-dependent): centered above anchor
  // flips below if clipped, clamped to viewport
  useLayoutEffect(() => {
    if (!visible) {
      setPos(null);
      return;
    }
    const anchor = anchorRef.current;
    const popup = popupRef.current;
    if (!anchor || !popup) return;
    const a = anchor.getBoundingClientRect();
    const p = popup.getBoundingClientRect();

    let top = a.top - POPOVER_GAP - p.height;
    if (top < VIEWPORT_PADDING) top = a.bottom + POPOVER_GAP;

    let left = a.left + a.width / 2 - p.width / 2;
    left = Math.min(Math.max(left, VIEWPORT_PADDING), window.innerWidth - p.width - VIEWPORT_PADDING);

    setPos({ left, top });
  }, [visible, shareUser, profile]);

  // anchored to a fixed measurement, bail out if anything moves under us
  useEffect(() => {
    if (!visible) return;
    const close = () => {
      clearTimer();
      setVisible(false);
    };
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [visible]);

  // head-row identity: profile > shareUser overrides > participant snapshot
  const headName =
    profile?.displayName ||
    shareUser?.displayName ||
    (participant ? participantDisplayName(participant) : "") ||
    "Unknown";
  const headHandle = profile?.username || shareUser?.username || participant?.username || "";
  const headAvatar =
    (profile ? getAvatarUrl(profile.discordId, profile.avatarHash, 40) : "") ||
    shareUser?.avatarUrl ||
    (participant ? discordAvatarUrl(participant) : "");

  // registered (has a ClipLib id): head row links to the full profile page
  const linkable = Boolean(cliplibUserId);
  const goToProfile = () => {
    if (cliplibUserId) openProfile(cliplibUserId);
  };

  const badges = profile?.badges ?? [];

  return (
    <span
      ref={anchorRef}
      className="user-popover-anchor"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      {children}
      {visible
        ? createPortal(
            <div
              ref={popupRef}
              className="user-popover"
              role="dialog"
              style={
                pos
                  ? { left: pos.left, top: pos.top }
                  : { left: 0, top: 0, visibility: "hidden" } /* pre-measure pass */
              }
              onMouseEnter={clearTimer}
              onMouseLeave={scheduleClose}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className={`user-popover-head${linkable ? " is-link" : ""}`}
                disabled={!linkable}
                onClick={(e) => {
                  e.stopPropagation();
                  goToProfile();
                }}
              >
                <img
                  className="user-popover-avatar"
                  src={headAvatar}
                  alt={headName}
                  draggable={false}
                />
                <div className="user-popover-names">
                  <div className="user-popover-display">{headName}</div>
                  {headHandle ? <div className="user-popover-handle">@{headHandle}</div> : null}
                </div>
              </button>

              {profile ? (
                <>
                  {profile.bio ? <p className="user-popover-bio">{profile.bio}</p> : null}
                  <div className="user-popover-stats">
                    <span className="user-popover-stat" title="Clips">
                      <Video size={12} />
                      {profile.clipCount}
                    </span>
                    <span className="user-popover-stat" title="Comments">
                      <MessageSquare size={12} />
                      {profile.commentCount}
                    </span>
                    <span className="user-popover-stat" title="Reactions">
                      <Heart size={12} />
                      {profile.reactionCount}
                    </span>
                    {badges.length > 0 ? (
                      <span className="user-popover-badges">
                        {badges.slice(0, 3).map((b) => (
                          <span key={b.slug} className="user-popover-badge" title={b.name}>
                            {b.icon}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                  <div className="user-popover-joined">{formatJoinDate(profile.createdAt)}</div>
                </>
              ) : shareUser ? (
                // registered but profile not yet fetched / fetch failed
                <div className="user-popover-cliplib">
                  <span className="user-popover-cliplib-dot" aria-hidden="true" />
                  On ClipLib{headHandle ? ` as @${headHandle}` : ""}
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
