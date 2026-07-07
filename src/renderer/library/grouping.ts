import type { LocalClip } from "./types";

// Time grouping — mirrors legacy renderer.js getTimeGroup/getGroupOrder
// (24h-diff based, not calendar based, to match existing behavior).
export function getTimeGroup(ts: number, now: number): string {
  const diffDays = Math.floor((now - ts) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays <= 7) return "This Week";
  if (diffDays <= 30) return "This Month";
  const d = new Date(ts);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear()) return "This Year";
  return String(d.getFullYear());
}

const SPECIAL_ORDER: Record<string, number> = {
  Today: 0,
  Yesterday: 1,
  "This Week": 2,
  "This Month": 3,
  "This Year": 4,
};

export function getGroupOrder(name: string): number {
  if (name in SPECIAL_ORDER) return SPECIAL_ORDER[name];
  const year = Number.parseInt(name, 10);
  if (!Number.isNaN(year)) return 100 + (3000 - year); // recent years first
  return 999;
}

export interface ClipGroupData {
  name: string;
  clips: LocalClip[];
}

/**
 * Group already-newest-first items into ordered time sections. Generic over the
 * item type so both the local library (LocalClip, createdAt in ms) and the feed
 * (Clip, createdAt as an ISO string) share the exact same time-bucketing +
 * ordering logic — callers supply a `getTs` that returns milliseconds.
 */
export function groupByTime<T>(
  items: T[],
  now: number,
  getTs: (item: T) => number,
): { name: string; clips: T[] }[] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const name = getTimeGroup(getTs(item), now);
    let bucket = map.get(name);
    if (!bucket) {
      bucket = [];
      map.set(name, bucket);
    }
    bucket.push(item);
  }
  return [...map.entries()]
    .map(([name, clips]) => ({ name, clips }))
    .sort((a, b) => getGroupOrder(a.name) - getGroupOrder(b.name));
}

/** Group already-newest-first clips into ordered time sections. */
export function groupClips(clips: LocalClip[], now: number): ClipGroupData[] {
  return groupByTime(clips, now, (c) => c.createdAt);
}
