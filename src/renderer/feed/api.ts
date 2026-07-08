// Thin typed client over `window.clips.shareApiRequest` for the feed.
//
// The main process authenticates every call (injects the bearer token) and
// returns `{ success, status?, data?, error? }`. We surface a typed
// `FeedApiError` on failure so callers can distinguish the 401 "not connected"
// case from other errors.

import type { Clip, ClipDetail, Comment, ShareUser, UserProfile } from "./types";

export class FeedApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "FeedApiError";
    this.status = status;
  }
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await window.clips.shareApiRequest({ method, path, body });
  if (!res.success) {
    throw new FeedApiError(res.error || "Request failed", res.status);
  }
  return res.data as T;
}

export interface FetchClipsParams {
  limit?: number;
  cursor?: string | null;
  user?: string;
  mention?: string;
  game?: string;
  sort?: string;
  favorite?: string;
}

export interface FetchClipsResult {
  clips: Clip[];
  nextCursor: string | null;
  /** Full result-set size for this filter combination (null on older servers). */
  total: number | null;
}

export async function fetchClips(params: FetchClipsParams): Promise<FetchClipsResult> {
  const search = new URLSearchParams();
  search.set("limit", String(params.limit ?? 20));
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.user) search.set("user", params.user);
  if (params.mention) search.set("mention", params.mention);
  if (params.game) search.set("game", params.game);
  if (params.sort) search.set("sort", params.sort);
  if (params.favorite) search.set("favorite", params.favorite);
  const data = await request<{ clips: Clip[]; nextCursor: string | null; total?: number }>(
    `/clips?${search.toString()}`,
  );
  return {
    clips: data.clips ?? [],
    nextCursor: data.nextCursor ?? null,
    total: typeof data.total === "number" ? data.total : null,
  };
}

export async function toggleReaction(
  clipId: string,
  emoji: string,
): Promise<{ action: "added" | "removed" }> {
  return request<{ action: "added" | "removed" }>(`/clips/${clipId}/reactions`, "POST", { emoji });
}

export async function toggleFavorite(clipId: string): Promise<{ action: "added" | "removed" }> {
  return request<{ action: "added" | "removed" }>(`/clips/${clipId}/favorite`, "POST");
}

export async function fetchShareUsersAll(): Promise<ShareUser[]> {
  const data = await request<{ users: ShareUser[] }>(`/users?all=true`);
  return data.users ?? [];
}

export async function fetchClipDetail(clipId: string): Promise<ClipDetail> {
  return request<ClipDetail>(`/clips/${clipId}`);
}

export async function fetchComments(clipId: string): Promise<Comment[]> {
  const data = await request<{ comments: Comment[] }>(`/clips/${clipId}/comments`);
  return data.comments ?? [];
}

export async function postComment(clipId: string, content: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(`/clips/${clipId}/comments`, "POST", { content });
  return data.comment;
}

/** Note: the delete route is /clips/comments/:id (not nested under the clip). */
export async function deleteComment(commentId: string): Promise<void> {
  await request<unknown>(`/clips/comments/${commentId}`, "DELETE");
}

// ---- User profiles (shared session cache: popovers + profile pages) ----

const profileCache = new Map<string, UserProfile>();
const profileInflight = new Map<string, Promise<UserProfile>>();

export function getCachedUserProfile(userId: string): UserProfile | undefined {
  return profileCache.get(userId);
}

export function fetchUserProfile(userId: string): Promise<UserProfile> {
  const cached = profileCache.get(userId);
  if (cached) return Promise.resolve(cached);
  const pending = profileInflight.get(userId);
  if (pending) return pending;
  const promise = request<UserProfile>(`/users/${userId}`)
    .then((profile) => {
      profileCache.set(userId, profile);
      return profile;
    })
    .finally(() => profileInflight.delete(userId));
  profileInflight.set(userId, promise);
  return promise;
}

/** Force-refresh a profile (e.g. after visiting a profile page). */
export function invalidateUserProfile(userId: string): void {
  profileCache.delete(userId);
}
