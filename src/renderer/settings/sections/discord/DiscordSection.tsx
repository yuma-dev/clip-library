import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gamepad2, Library } from "lucide-react";
import { SetGroup, SetRow } from "../../rows";
import Toggle from "../../../ui/Toggle";
import PresenceGamesModal from "../../PresenceGamesModal";
import { useSettings } from "../../SettingsContext";
import { useToast } from "../../../ui/Toast";
import {
  PRESENCE_PREFS_DEFAULTS,
  previewLibraryStates,
  setDiscordPresenceEnabled,
  setPresencePrefs,
  type PresenceActivity,
  type PresencePrefs,
} from "../../../player/discordPresence";
import { getGameOfClip, useLibraryGames } from "../../../library/games";
import type { UseClips } from "../../../library/useClips";
import type { DiscordActivity, LiveExtension } from "../../../../types/clips";
import GameList from "./GameList";
import RotatingPreview, { type PreviewMoment } from "./RotatingPreview";
import { extMoments, type GameIcons } from "./moments";
import {
  featuredScenario,
  prefetchPreviews,
  useGamePresence,
  useLiveExtensions,
  usePlayingNow,
  type CatalogGames,
  type LiveSettings,
} from "./useDiscordSettings";
import { useSettingsNav } from "../../nav";
import "./discord.css";

/** game id to icon. clipdip's current list wins: icons saved with played games and clips can be stale */
function useGameIcons(catalog: CatalogGames): { icons: GameIcons; seen: Set<string> } {
  const library = useLibraryGames();
  const [played, setPlayed] = useState<Array<{ id: string; name: string; icon_url?: string | null }>>([]);
  useEffect(() => {
    window.clips
      .getPlayedGames()
      .then(setPlayed)
      .catch(() => setPlayed([]));
  }, []);
  return useMemo(() => {
    const m: GameIcons = new Map();
    for (const g of played) m.set(g.id, { name: g.name, icon: g.icon_url ?? null });
    for (const g of library) if (g.icon_url) m.set(g.id, { name: g.name, icon: g.icon_url });
    for (const [id, g] of Object.entries(catalog)) if (g.icon_url) m.set(id, { name: g.name, icon: g.icon_url });
    return { icons: m, seen: new Set([...played, ...library].map((g) => g.id)) };
  }, [catalog, library, played]);
}

const isOn = (ext: LiveExtension, live: LiveSettings) => live[ext.id]?.enabled !== false;
const short = (name: string) => name.replace(/ of Legends and TFT$/, "").replace(/ 4, 5 and 6$/, "");

/** the library's card as main sends it (main/discord.js buildActivity) */
function libraryCard(a: PresenceActivity): DiscordActivity {
  return {
    type: a.type,
    name: "ClipLib",
    details: a.details,
    state: a.state ?? undefined,
    timestamps: a.startTimestamp || a.endTimestamp ? { start: a.startTimestamp, end: a.endTimestamp } : undefined,
    assets: {
      large_image: a.largeImageKey,
      large_text: a.largeImageText ?? "ClipLib",
      small_image: a.smallImageKey,
      small_text: a.smallImageText,
    },
    buttons: [{ label: "Get ClipLib", url: "https://cliplib.app" }],
  };
}

/** hover changes what the rail shows. entering waits a moment so sweeping across the list doesn't
 * fetch every game on the way, leaving waits a beat so moving between rows doesn't flicker */
function useHover<T>(): [T | null, (v: T) => void, () => void] {
  const [value, setValue] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // stable, so the list doesn't re-render when only the preview changes
  const enter = useCallback((v: T) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setValue(v), 140);
  }, []);
  const leave = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setValue(null), 220);
  }, []);
  return [value, enter, leave];
}

export default function DiscordSection({ lib }: { lib: UseClips }) {
  const { settings, set } = useSettings();
  const toast = useToast();
  const game = useGamePresence();
  const { extensions, games: catalog, failed } = useLiveExtensions();
  const playing = usePlayingNow();
  const { icons, seen } = useGameIcons(catalog);
  const libraryGames = useLibraryGames();
  const [open, setOpenRaw] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ key: string; nonce: number } | null>(null);
  const setOpen = useCallback((id: string | null) => {
    setOpenRaw(id);
    setPicked(null);
  }, []);
  const onPick = useCallback((key: string) => setPicked({ key, nonce: Date.now() }), []);
  // game.setLive is a new function each render, the list gets a steady one
  const setLiveRef = useRef(game.setLive);
  setLiveRef.current = game.setLive;
  const setLive = useCallback((id: string, next: Record<string, unknown>) => setLiveRef.current(id, next), []);
  const [gamesOpen, setGamesOpen] = useState(false);
  const [tab, setTab] = useState<"game" | "library">("game");
  const [hoverExt, enterExt, leaveExt] = useHover<string>();

  // a settings search for a game opens its row
  const { focus } = useSettingsNav();
  useEffect(() => {
    if (focus?.game) setOpen(focus.game);
  }, [focus]);

  const prefs: PresencePrefs = { ...PRESENCE_PREFS_DEFAULTS, ...(settings.discordPresence ?? {}) };
  const rpcOn = Boolean(settings.enableDiscordRPC);
  const setPref = async (key: keyof PresencePrefs, value: boolean) => {
    const next = { ...prefs, [key]: value };
    setPresencePrefs(next);
    if (!(await set("discordPresence", next))) toast.show("Failed to save setting", "error");
  };
  const toggleRpc = async (enabled: boolean) => {
    const ok = await set("enableDiscordRPC", enabled);
    try {
      await window.clips.toggleDiscordRpc(enabled);
    } catch {
      /* the saved setting still applies next launch */
    }
    setDiscordPresenceEnabled(enabled);
    if (!ok) toast.show("Failed to save setting", "error");
  };

  const steamOn = game.live.steam?.enabled !== false;
  const playtime = steamOn ? (game.live.steam ?? {}) : undefined;
  const competing = game.competing;
  const listed = useMemo(() => (extensions ?? []).filter((e) => e.listed), [extensions]);
  const covered = new Set(listed.flatMap((e) => e.game_ids));

  // your games first: the ones with clips, most clipped first, then ones clipdip has seen you play
  const yours = useMemo(() => {
    const clipCount = new Map(libraryGames.map((g) => [g.id, g.count] as const));
    const score = (e: LiveExtension) =>
      Math.max(0, ...e.game_ids.map((id) => (clipCount.get(id) ?? 0) * 10 + (seen.has(id) ? 1 : 0)));
    return listed.filter((e) => score(e) > 0).sort((a, b) => score(b) - score(a));
  }, [listed, libraryGames, seen]);

  // while you play: your real card when a game runs, a game without live details (just clipped, a few
  // clips in, nothing yet), then every game with live details that's on
  const plain = libraryGames.find((g) => !covered.has(g.id)) ?? libraryGames[0];
  const plainReq = (clips: string) => ({
    game: plain?.name ?? "Your game",
    icon: plain?.icon_url ?? null,
    total_clips: lib.clips.length || undefined,
    playtime,
    clips,
  });
  const gameMoments: PreviewMoment[] = [
    ...(playing?.card ? [{ key: "now", label: `Right now, ${playing.name}`, live: playing.card }] : []),
    { key: "plain", label: plain?.name ?? "Any game", reqs: ["fresh", "count", "none"].map(plainReq) },
    ...yours
      .filter((e) => isOn(e, game.live))
      .slice(0, 6)
      .map((e) => ({
        key: e.id,
        label: short(e.name),
        reqs: [
          {
            id: e.id,
            settings: game.live[e.id] ?? {},
            scenario: featuredScenario(e.scenarios),
            icon: e.game_ids.map((id) => icons.get(id)?.icon).find(Boolean) ?? null,
            playtime,
            competing,
          },
        ],
      })),
  ];

  // in the library: the same functions as the real card, on your newest clip that has a game
  const sampleClip = useMemo(() => {
    const games = getGameOfClip();
    const c = lib.clips.find((x) => games.has(x.originalName) && !x.tags?.includes("Private")) ?? lib.clips[0];
    return { originalName: c?.originalName ?? "", customName: c?.customName || "the 1v4 nobody believed", tags: c?.tags };
  }, [lib.clips]);
  const libMoments = useMemo<PreviewMoment[]>(
    () =>
      previewLibraryStates(prefs, sampleClip).map((x) => ({
        key: x.key,
        label: x.label,
        cards: x.variants.map(libraryCard),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sampleClip, prefs.clipNames, prefs.game, prefs.facts, prefs.editing],
  );

  // every game's scenarios load in one clipdip call when the page opens, pictures included, so hovering
  // and opening rows swaps the preview on the spot
  const allReqs = useMemo(
    () =>
      JSON.stringify(
        listed.flatMap((e) =>
          extMoments(e, game.live[e.id] ?? {}, icons, e.steam_game ? playtime : undefined, competing).flatMap((m) => m.reqs ?? []),
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listed, game.live, icons, JSON.stringify(playtime), competing],
  );
  useEffect(() => {
    prefetchPreviews(JSON.parse(allReqs));
  }, [allReqs]);

  // the rail follows the mouse first, then the open game, else the tab
  const hovered = hoverExt ? listed.find((e) => e.id === hoverExt) : undefined;
  const railExt = hovered ?? (open ? listed.find((e) => e.id === open) : undefined) ?? null;
  const railMoments = railExt
    ? extMoments(railExt, game.live[railExt.id] ?? {}, icons, railExt.steam_game ? playtime : undefined, competing)
    : tab === "game"
      ? gameMoments
      : libMoments;
  const railKey = railExt ? `ext:${railExt.id}:${isOn(railExt, game.live)}` : tab;
  const railOff = railExt || tab === "game" ? game.presence === false : !rpcOn;
  // a merely hovered game runs through its scenarios faster; the open one holds a picked scenario
  const railFast = Boolean(railExt && railExt.id !== open);
  const railPick = railExt && railExt.id === open ? picked : null;

  return (
    <div className="span-2 dset">
      <div className="dset-frame">
        <aside className="dset-side">
          <div className="dset-rail">
            <div className="dset-tabs" role="tablist">
              <button
                type="button"
                className={!railExt && tab === "game" ? "on" : ""}
                onClick={() => {
                  setOpen(null);
                  setTab("game");
                }}
              >
                <Gamepad2 size={13} /> While you play
              </button>
              <button
                type="button"
                className={!railExt && tab === "library" ? "on" : ""}
                onClick={() => {
                  setOpen(null);
                  setTab("library");
                }}
              >
                <Library size={13} /> In the library
              </button>
            </div>
            <RotatingPreview key={railKey} moments={railMoments} off={railOff} fast={railFast} pick={railPick} />
          </div>

          <div className="dset-compact">
            <div>
              <SetGroup title="While you play">
                <SetRow title="Show the game you're in" description="With a ClipLib badge and your clips">
                  <Toggle
                    checked={game.presence !== false}
                    disabled={game.presence === null}
                    onChange={game.setPresence}
                    aria-label="Show the game you're in"
                  />
                </SetRow>
                <SetRow title="Ranked as Competing" description="Shows above the game's own status">
                  <Toggle
                    checked={game.competing}
                    disabled={game.presence === false}
                    onChange={game.setCompeting}
                    aria-label="Ranked as Competing"
                  />
                </SetRow>
                <SetRow title="Hours played" description="Steam games, on the picture's hover">
                  <Toggle
                    checked={steamOn}
                    disabled={game.presence === false}
                    onChange={(v) => game.setLive("steam", { ...(game.live.steam ?? {}), enabled: v })}
                    aria-label="Hours played"
                  />
                </SetRow>
                <SetRow title="Games that show" description={game.hidden.length === 0 ? "Every game" : `${game.hidden.length} hidden`}>
                  <button type="button" className="btn" onClick={() => setGamesOpen(true)} disabled={game.presence === false}>
                    Choose
                  </button>
                </SetRow>
              </SetGroup>
            </div>

            <div>
              <SetGroup title="In the library">
                <SetRow title="Show what you're doing" description="Browsing, watching, editing">
                  <Toggle checked={rpcOn} onChange={(v) => void toggleRpc(v)} aria-label="Show what you're doing in the library" />
                </SetRow>
                <SetRow title="Clip names" description="Private clips never show theirs">
                  <Toggle checked={prefs.clipNames} disabled={!rpcOn} onChange={(v) => void setPref("clipNames", v)} aria-label="Clip names" />
                </SetRow>
                <SetRow title="The clip's game" description="Its art and name">
                  <Toggle checked={prefs.game} disabled={!rpcOn} onChange={(v) => void setPref("game", v)} aria-label="The clip's game" />
                </SetRow>
                <SetRow title="Library facts" description="Rotating stats while browsing">
                  <Toggle checked={prefs.facts} disabled={!rpcOn} onChange={(v) => void setPref("facts", v)} aria-label="Library facts" />
                </SetRow>
                <SetRow title="Editing and exporting" description="Trims, layers, exports, shares">
                  <Toggle checked={prefs.editing} disabled={!rpcOn} onChange={(v) => void setPref("editing", v)} aria-label="Editing and exporting" />
                </SetRow>
              </SetGroup>
            </div>
          </div>
        </aside>

        <GameList
          extensions={extensions}
          failed={failed}
          yours={yours}
          live={game.live}
          setLive={setLive}
          icons={icons}
          playing={playing}
          gamePresence={game.presence !== false}
          open={open}
          onOpen={setOpen}
          onHover={enterExt}
          onLeave={leaveExt}
          picked={picked?.key ?? null}
          onPick={onPick}
        />
      </div>

      <PresenceGamesModal open={gamesOpen} onClose={() => setGamesOpen(false)} hidden={game.hidden} onChange={game.setHidden} />
    </div>
  );
}
