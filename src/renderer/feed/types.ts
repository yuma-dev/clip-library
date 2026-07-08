// Shared types + helpers for the in-app ClipLib feed.
//
// Ported from the reference website (React 19 + Tailwind) — see
// `cliplib share/src/hooks/useClips.ts`, `ClipCard.tsx`, `ClipDetailPage.tsx`,
// `UserProfilePage.tsx`, `CommentSection.tsx`. Interfaces are kept verbatim so
// the API surface matches the server 1:1.

export interface ClipUser {
  id: string;
  username: string;
  displayName: string;
  avatarHash: string | null;
  discordId: string;
}

export interface ClipMentionUser {
  id: string;
  displayName: string;
  avatarHash: string | null;
  discordId: string;
}

export interface Clip {
  id: string;
  userId: string;
  user: ClipUser;
  title: string;
  description: string | null;
  game: string | null;
  fileSize: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  status: string;
  createdAt: string;
  mentions: ClipMentionUser[];
  reactionCounts: Record<string, number>;
  userReactions: string[];
  isFavorited: boolean;
  commentCount: number;
  thumbnailUrl: string | null;
}

// Clip detail page adds share-token fields (website ClipDetailPage.tsx).
export interface ClipDetail extends Omit<Clip, "commentCount" | "thumbnailUrl"> {
  commentCount: number;
  publicToken: string | null;
  publicUrl: string | null;
}

export interface Comment {
  id: string;
  content: string;
  createdAt: string;
  user: ClipUser;
}

export interface BadgeInfo {
  slug: string;
  name: string;
  icon: string;
  description: string | null;
  awardedAt: string;
}

export interface UserProfile {
  id: string;
  discordId: string;
  username: string;
  displayName: string;
  avatarHash: string | null;
  bio: string | null;
  bannerType: string | null;
  bannerGradient: string | null;
  bannerUrl: string | null;
  accentColor: string | null;
  badges: BadgeInfo[];
  clipCount: number;
  commentCount: number;
  reactionCount: number;
  favoriteCount: number;
  createdAt: string;
}

// Directory user (GET /users?all=true) plus the optional clipCount the feed
// filter dropdowns may surface.
export interface ShareUser {
  id: string;
  discordId: string;
  username: string;
  displayName: string;
  avatarHash: string | null;
  clipCount?: number;
}

export const SERVER_URL = "https://friends.cliplib.app";

// Emoji lookup (website ClipCard.tsx) + an ordered, labelled list for pickers.
export const REACTION_EMOJI: Record<string, string> = {
  fire: "\u{1F525}",
  funny: "\u{1F602}",
  clean: "\u{1F3AF}",
  insane: "\u{1F480}",
  love: "\u{2764}\u{FE0F}",
  crying: "\u{1F62D}",
};

export interface ReactionDef {
  emoji: string;
  icon: string;
  label: string;
}

export const REACTIONS: ReactionDef[] = [
  { emoji: "fire", icon: REACTION_EMOJI.fire, label: "Fire" },
  { emoji: "funny", icon: REACTION_EMOJI.funny, label: "Funny" },
  { emoji: "clean", icon: REACTION_EMOJI.clean, label: "Clean" },
  { emoji: "insane", icon: REACTION_EMOJI.insane, label: "Insane" },
  { emoji: "love", icon: REACTION_EMOJI.love, label: "Love" },
  { emoji: "crying", icon: REACTION_EMOJI.crying, label: "Crying" },
];

/** Discord CDN avatar URL from id + hash (website AuthContext.getAvatarUrl). */
export function getAvatarUrl(discordId: string, avatarHash: string | null, size = 64): string {
  if (avatarHash) {
    return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.webp?size=${size}`;
  }
  const index = (BigInt(discordId) >> 22n) % 6n;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/**
 * Absolutize a server-relative media path (e.g. a `thumbnailUrl` starting with
 * `/`) against the ClipLib server. Absolute URLs and empty values pass through.
 * The main process injects the Authorization header for friends.cliplib.app, so
 * the returned URL can be used directly in <img>/<video> src.
 */
export function mediaUrl(path: string | null | undefined): string {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `${SERVER_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Authenticated full-clip stream URL (main injects auth headers for this host). */
export function streamUrl(clipId: string): string {
  return `${SERVER_URL}/api/clips/${clipId}/stream`;
}

/** Low-resolution preview stream — used by the card hover previews. */
export function previewStreamUrl(clipId: string): string {
  return `${SERVER_URL}/api/clips/${clipId}/stream/preview`;
}

export function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatRelativeTime(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
