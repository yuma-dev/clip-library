import type { LocalClip } from "./types";

export const SHUFFLE_OPTIONS = [
  { token: "shuffle", label: "Shuffle all dates", months: 0 },
  { token: "older:1m", label: "Exclude the last month", months: 1 },
  { token: "older:2m", label: "Exclude the last 2 months", months: 2 },
  { token: "older:3m", label: "Exclude the last 3 months", months: 3 },
  { token: "older:6m", label: "Exclude the last 6 months", months: 6 },
  { token: "older:1y", label: "Exclude the last year", months: 12 },
] as const;

/** Last recognized choice wins; incomplete commands still preview shuffle. */
export function shuffleSettings(query: string) {
  let enabled = false;
  let months = 0;
  for (const term of query.toLowerCase().split(/\s+/)) {
    if (!term.startsWith("?")) continue;
    enabled = true;
    const option = SHUFFLE_OPTIONS.find((o) => `?${o.token}` === term);
    if (option) months = option.months;
  }
  return { enabled, months };
}

/** Calendar months, clamping month-end rather than overflowing into next month. */
export function monthsBefore(now: number, months: number): number {
  const date = new Date(now);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() - months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return date.getTime();
}

/** Seeded per-file ranks keep surviving clips in order when filters/metadata change. */
export function shuffleClips(clips: LocalClip[], seed: number): LocalClip[] {
  const rank = (name: string) => {
    let hash = seed | 0;
    for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    return (hash ^ (hash >>> 16)) >>> 0;
  };
  return clips.map((clip) => ({ clip, rank: rank(clip.originalName) }))
    .sort((a, b) => a.rank - b.rank || a.clip.originalName.localeCompare(b.clip.originalName))
    .map(({ clip }) => clip);
}
