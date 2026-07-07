// Time-groups a feed clip list into the same ordered sections the library uses
// (reusing library/grouping.ts — no logic is copied), plus a persisted
// collapsed-state map keyed per surface (feed vs. each profile tab). Feed
// Clip.createdAt is an ISO string; groupByTime is fed a ms accessor.

import { useCallback, useEffect, useMemo, useState } from "react";
import { groupByTime } from "../library/grouping";
import type { Clip } from "./types";

export interface FeedGroupData {
  name: string;
  clips: Clip[];
}

function loadCollapsed(key: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
}

export function useFeedGroups(clips: Clip[], collapseKey: string) {
  const groups = useMemo<FeedGroupData[]>(
    () => groupByTime(clips, Date.now(), (c) => new Date(c.createdAt).getTime()),
    [clips],
  );

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadCollapsed(collapseKey));

  const toggle = useCallback((name: string) => {
    setCollapsed((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(collapseKey, JSON.stringify(collapsed));
    } catch {
      /* ignore */
    }
  }, [collapseKey, collapsed]);

  return { groups, collapsed, toggle };
}
