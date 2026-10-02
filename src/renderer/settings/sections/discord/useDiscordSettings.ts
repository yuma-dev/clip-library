import { useCallback, useEffect, useRef, useState } from "react";
import type { DiscordActivity, LiveExtension } from "../../../../types/clips";
import { useToast } from "../../../ui/Toast";

export type LiveSettings = Record<string, Record<string, unknown>>;

export interface PlayingNow {
  id: string;
  name: string;
  icon: string | null;
  /** the card clipdip sends right now, null when the game is hidden */
  card: DiscordActivity | null;
}

/** game presence settings live in clipdip's config.toml, it runs even with the library closed */
export function useGamePresence() {
  const toast = useToast();
  const [presence, setPresence] = useState<boolean | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [live, setLive] = useState<LiveSettings>({});
  const [competing, setCompeting] = useState(true);

  useEffect(() => {
    window.clips.clipdip
      .getConfig()
      .then(
        (r: {
          config?: { discord?: { presence?: boolean; presence_hidden?: string[]; live?: LiveSettings; competing?: boolean } };
        }) => {
        const d = r?.config?.discord;
        setCompeting(d?.competing !== false);
        setPresence(d?.presence !== false);
        setHidden(Array.isArray(d?.presence_hidden) ? d.presence_hidden : []);
        setLive(d?.live && typeof d.live === "object" ? d.live : {});
        },
      )
      .catch(() => setPresence(true));
  }, []);

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        await window.clips.clipdip.setConfig({ discord: patch });
      } catch {
        toast.show("Failed to save setting", "error");
      }
    },
    [toast],
  );

  return {
    presence,
    hidden,
    live,
    competing,
    setCompeting: (on: boolean) => {
      setCompeting(on);
      void save({ competing: on });
    },
    setPresence: (on: boolean) => {
      setPresence(on);
      void save({ presence: on });
    },
    setHidden: (ids: string[]) => {
      setHidden(ids);
      void save({ presence_hidden: ids });
    },
    setLive: (id: string, next: Record<string, unknown>) => {
      setLive((s) => ({ ...s, [id]: next }));
      void save({ live: { [id]: next } });
    },
  };
}

export type CatalogGames = Record<string, { name: string; icon_url?: string | null }>;

let extensionsCache: LiveExtension[] | null = null;
let gamesCache: CatalogGames = {};
// the settings rail and the Discord page can ask at the same time, one clipdip call serves both
let extensionsLoad: Promise<boolean> | null = null;
const loadExtensions = () =>
  (extensionsLoad ??= window.clips.clipdip
    .liveExtensions()
    .then((r) => {
      if (!r.ok || !r.extensions) return false;
      extensionsCache = r.extensions;
      gamesCache = r.games ?? {};
      return true;
    })
    .catch(() => false)
    .then((ok) => {
      if (!ok) extensionsLoad = null;
      return ok;
    }));

/** `enabled` false skips the clipdip call until it turns true (settings search only needs it once typed) */
export function useLiveExtensions(enabled = true): { extensions: LiveExtension[] | null; games: CatalogGames; failed: boolean } {
  const [extensions, setExtensions] = useState(extensionsCache);
  const [games, setGames] = useState(gamesCache);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadExtensions().then((ok) => {
      if (!alive) return;
      if (ok) {
        setExtensions(extensionsCache);
        setGames(gamesCache);
      } else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return { extensions, games, failed };
}

/** the running game and its card, polled while the page is open */
export function usePlayingNow(): PlayingNow | null {
  const [playing, setPlaying] = useState<PlayingNow | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      window.clips.clipdip
        .control("game_status")
        .then((r) => {
          if (!alive) return;
          const s = r as {
            game?: { id: string; name: string; icon_url?: string | null } | null;
            card?: DiscordActivity | null;
          };
          const next = s?.game ? { id: s.game.id, name: s.game.name, icon: s.game.icon_url ?? null, card: s.card ?? null } : null;
          // same answer, same object: a fresh one every poll re-rendered the whole games list
          setPlaying((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
        })
        .catch(() => alive && setPlaying(null));
    void tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return playing;
}

export type PreviewReq = Parameters<typeof window.clips.clipdip.livePreview>[0];

// one clipdip call per distinct request; cycling previews come back around to the same ones
const previewCache = new Map<string, Promise<DiscordActivity | null>>();
// cards whose pictures are loaded too, readable during render so switching to one paints at once
const ready = new Map<string, DiscordActivity>();
// held so the decoded pictures stay in memory while settings is open
const images = new Map<string, Promise<void>>();

function preloadImage(url: string): Promise<void> {
  let p = images.get(url);
  if (!p) {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    p = img.decode().catch(() => undefined);
    images.set(url, p);
  }
  return p;
}

const pictures = (a: DiscordActivity) =>
  [a.assets?.large_image, a.assets?.small_image].filter((u): u is string => Boolean(u && /^https?:/.test(u)));

/** a card counts as ready once its pictures are decoded, or after 1.5 s for a slow one (an 8 MB gif) */
function settle(key: string, p: Promise<DiscordActivity | null>): Promise<DiscordActivity | null> {
  const done = p.then(async (a) => {
    if (!a) {
      // a failure shouldn't stick
      previewCache.delete(key);
      return null;
    }
    await Promise.race([Promise.all(pictures(a).map(preloadImage)), new Promise((r) => setTimeout(r, 1500))]);
    ready.set(key, a);
    return a;
  });
  previewCache.set(key, done);
  return done;
}

function fetchPreview(key: string): Promise<DiscordActivity | null> {
  return (
    previewCache.get(key) ??
    settle(
      key,
      window.clips.clipdip
        .livePreview(JSON.parse(key) as PreviewReq)
        .then((r) => (r.ok && r.activity ? r.activity : null))
        .catch(() => null),
    )
  );
}

/** a sample card from clipdip's own composer; a ready one shows on the same frame, otherwise the last
 * card stays until the new one and its pictures are in */
export function useCardPreview(req: PreviewReq | null) {
  const key = req ? JSON.stringify(req) : "";
  const known = key ? ready.get(key) : undefined;
  const [activity, setActivity] = useState<DiscordActivity | null>(known ?? null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (!key) return;
    const mine = ++seq.current;
    const hit = ready.get(key);
    if (hit) {
      setActivity(hit);
      setLoading(false);
      return;
    }
    // only a wait you'd notice dims the card
    const dim = setTimeout(() => mine === seq.current && setLoading(true), 250);
    // toggles come in bursts; one call per burst
    const t = setTimeout(() => {
      void fetchPreview(key).then((a) => {
        if (mine !== seq.current) return;
        clearTimeout(dim);
        if (a) setActivity(a);
        setLoading(false);
      });
    }, previewCache.has(key) ? 0 : 120);
    return () => {
      clearTimeout(t);
      clearTimeout(dim);
    };
  }, [key]);
  return { activity: known ?? activity, loading };
}

/** warms the cache for previews a cycle will reach soon, the missing ones in one clipdip call */
export function prefetchPreviews(reqs: PreviewReq[]): void {
  const keys = [...new Set(reqs.map((r) => JSON.stringify(r)))].filter((k) => !previewCache.has(k));
  if (keys.length === 0) return;
  // a main process older than the renderer (dev reload) has no batch call yet
  if (keys.length === 1 || !window.clips.clipdip.livePreviews) {
    for (const k of keys) void fetchPreview(k);
    return;
  }
  const batch = window.clips.clipdip
    .livePreviews(keys.map((k) => JSON.parse(k) as PreviewReq))
    .then((r) => (r.ok && r.activities ? r.activities : []))
    .catch(() => [] as Array<DiscordActivity | null>);
  keys.forEach((key, i) => void settle(key, batch.then((list) => list[i] ?? null)));
}

/** the scenario that shows a game best: in a match rather than a menu */
export function featuredScenario(scenarios: Array<{ key: string; label: string }>): string {
  const want = ["game", "match", "live", "in_game", "server", "fh5", "race"];
  return (want.map((k) => scenarios.find((s) => s.key === k)).find(Boolean) ?? scenarios[0])?.key ?? "";
}
