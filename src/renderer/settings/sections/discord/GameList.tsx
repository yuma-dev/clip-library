import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Search, X } from "lucide-react";
import Toggle from "../../../ui/Toggle";
import type { LiveExtension } from "../../../../types/clips";
import ExtensionConfig from "./ExtensionConfig";
import { GENRES, OTHER_GENRE, genreOf } from "./genres";
import type { GameIcons } from "./moments";
import type { LiveSettings, PlayingNow } from "./useDiscordSettings";

type Filter = "all" | "yours" | "setup" | "off";

const isOn = (ext: LiveExtension, live: LiveSettings) => live[ext.id]?.enabled !== false;

interface GameListProps {
  extensions: LiveExtension[] | null;
  failed: boolean;
  /** most clipped first, then games clipdip has seen you play */
  yours: LiveExtension[];
  live: LiveSettings;
  setLive: (id: string, next: Record<string, unknown>) => void;
  icons: GameIcons;
  playing: PlayingNow | null;
  gamePresence: boolean;
  open: string | null;
  onOpen: (id: string | null) => void;
  onHover: (id: string) => void;
  onLeave: () => void;
  picked: string | null;
  onPick: (scenario: string) => void;
}

/** every game with live details, grouped; a row opens into its settings right where it is */
function GameList(p: GameListProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const listed = useMemo(() => (p.extensions ?? []).filter((e) => e.listed), [p.extensions]);
  const icon = (e: LiveExtension) => e.game_ids.map((id) => p.icons.get(id)?.icon).find(Boolean) ?? null;

  const q = query.trim().toLowerCase();
  const matches = (e: LiveExtension) => {
    if (filter === "setup" && !e.setup) return false;
    if (filter === "off" && isOn(e, p.live)) return false;
    if (!q) return true;
    const names = e.game_ids.map((id) => p.icons.get(id)?.name ?? "").join(" ");
    return `${e.name} ${names} ${e.blurb}`.toLowerCase().includes(q);
  };

  const groups = useMemo(() => {
    const yours = new Set(p.yours.map((e) => e.id));
    const out: { name: string; items: LiveExtension[] }[] = [{ name: "Your games", items: p.yours }];
    if (filter !== "yours") {
      for (const g of [...GENRES.map((x) => x.name), OTHER_GENRE]) {
        out.push({ name: g, items: listed.filter((e) => !yours.has(e.id) && genreOf(e.id) === g) });
      }
    }
    return out.map((g) => ({ ...g, items: g.items.filter(matches) })).filter((g) => g.items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listed, p.yours, filter, q, p.live, p.icons]);

  const offCount = listed.filter((e) => !isOn(e, p.live)).length;
  const chips: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "All", n: listed.length },
    { id: "yours", label: "Your games", n: p.yours.length },
    { id: "setup", label: "Needs setup", n: listed.filter((e) => e.setup).length },
    ...(offCount ? [{ id: "off" as Filter, label: "Off", n: offCount }] : []),
  ];

  // rows sliding under a still mouse while scrolling aren't a hover, previewing them made scrolling lag
  const scrolling = useRef(false);
  const scrollEnd = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onScroll = () => {
    scrolling.current = true;
    clearTimeout(scrollEnd.current);
    scrollEnd.current = setTimeout(() => (scrolling.current = false), 160);
  };
  // the first mouse move after a scroll picks up the row under it
  const hovered = useRef<string | null>(null);
  const hover = (id: string) => {
    if (scrolling.current || hovered.current === id) return;
    hovered.current = id;
    p.onHover(id);
  };
  const leave = () => {
    hovered.current = null;
    p.onLeave();
  };

  // the open row stays in view, also when a settings search opened it from elsewhere
  const rows = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (!p.open) return;
    const t = setTimeout(() => rows.current.get(p.open!)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 240);
    return () => clearTimeout(t);
  }, [p.open]);

  return (
    <section className={`dl${p.gamePresence ? "" : " dim"}`}>
      <div className="dl-bar">
        <label className="dl-search">
          <Search size={14} />
          <input value={query} placeholder={`Search ${listed.length || ""} games`} onChange={(e) => setQuery(e.target.value)} />
          {query ? (
            <button type="button" aria-label="Clear" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          ) : null}
        </label>
        {chips.map((c) => (
          <button key={c.id} type="button" className={`dl-chip${filter === c.id ? " on" : ""}`} onClick={() => setFilter(c.id)}>
            {c.label} <span>{c.n}</span>
          </button>
        ))}
        {p.playing ? (
          <span className="dl-playing">
            <i /> Playing {p.playing.name}
          </span>
        ) : null}
      </div>

      <div className="dl-scroll" onScroll={onScroll} onMouseLeave={leave}>
        {p.failed ? <div className="dl-empty">Couldn't load the list. Is ClipLib's recorder installed?</div> : null}
        {!p.extensions && !p.failed ? (
          <div className="dl-group">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="dl-row skeleton" />
            ))}
          </div>
        ) : null}
        {p.extensions && groups.length === 0 ? <div className="dl-empty">No game like that yet.</div> : null}
        {groups.map((g) => (
          <div key={g.name} className="dl-group">
            <div className="dl-group-head">
              <b>{g.name}</b>
              <span>{g.items.length}</span>
            </div>
            {g.items.map((e) => {
              const on = isOn(e, p.live);
              const open = p.open === e.id;
              const ic = icon(e);
              const live = p.playing && e.game_ids.includes(p.playing.id);
              return (
                <div
                  key={e.id}
                  ref={(el) => {
                    if (el) rows.current.set(e.id, el);
                    else rows.current.delete(e.id);
                  }}
                  className={`dl-row${open ? " open" : ""}${on ? "" : " off"}`}
                  onMouseEnter={() => hover(e.id)}
                  onMouseMove={() => hover(e.id)}
                >
                  {/* the banner only shows on hover, an open row is about its settings */}
                  {e.art && !open ? <div className="dl-art" style={{ backgroundImage: `url("${e.art}")` }} /> : null}
                  <button type="button" className="dl-head" aria-expanded={open} onClick={() => p.onOpen(open ? null : e.id)}>
                    {ic ? <img src={ic} alt="" draggable={false} /> : <span className="dl-noicon" />}
                    <span className="dl-text">
                      <b>
                        {e.name}
                        {on && e.setup ? <em className="dl-badge">Setup</em> : null}
                        {live ? <em className="dl-live">Playing now</em> : null}
                      </b>
                      <small>{e.blurb}</small>
                    </span>
                    <span className="dl-views">
                      {e.scenarios.slice(0, 3).map((s) => (
                        <span key={s.key}>{s.label}</span>
                      ))}
                      {e.scenarios.length > 3 ? <span>+{e.scenarios.length - 3}</span> : null}
                    </span>
                    <ChevronDown size={16} className="dl-chev" />
                  </button>
                  <div className="dl-toggle">
                    <Toggle
                      checked={on}
                      onChange={(v) => p.setLive(e.id, { ...(p.live[e.id] ?? {}), enabled: v })}
                      aria-label={`Live details for ${e.name}`}
                    />
                  </div>
                  <AnimatePresence initial={false}>
                    {open ? (
                      <motion.div
                        key="cfg"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.3, 0.7, 0.2, 1] }}
                        style={{ overflow: "hidden" }}
                      >
                        <ExtensionConfig
                          ext={e}
                          settings={p.live[e.id] ?? {}}
                          onChange={(next) => p.setLive(e.id, next)}
                          playing={p.playing}
                          gamePresence={p.gamePresence}
                          picked={p.picked}
                          onPick={p.onPick}
                        />
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

export default memo(GameList);
