import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Search, X } from "lucide-react";
import { ALL_SECTIONS, NAV_GROUPS, openSection, useSettingsNav } from "../settings/nav";
import { searchSettings, type SearchHit } from "../settings/search";
import { useLiveExtensions } from "../settings/sections/discord/useDiscordSettings";
import { routes, type Route } from "../routes";

/** the rail while settings is open: back, settings search, the sections */
export default function SettingsRail({ back, onBack }: { back: Route; onBack: () => void }) {
  const { section } = useSettingsNav();
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // game names only load once someone searches, the list costs a clipdip call
  const { extensions, games } = useLiveExtensions(query.trim().length > 0);
  const liveGames = useMemo(
    () =>
      (extensions ?? [])
        .filter((e) => e.listed)
        .flatMap((e) => [{ id: e.id, name: e.name }, ...e.game_ids.map((g) => ({ id: e.id, name: games[g]?.name ?? "" }))])
        .filter((g, i, all) => g.name && all.findIndex((x) => x.name === g.name) === i),
    [extensions, games],
  );
  const hits = useMemo(() => searchSettings(query, liveGames), [query, liveGames]);
  useEffect(() => setHi(0), [query]);

  // ctrl+k (or ctrl+f) jumps to the search while settings is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "f")) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pick = (h: SearchHit) => {
    openSection(h.section, h.game ? { game: h.game.id } : h.title ? { title: h.title } : undefined);
    setQuery("");
    input.current?.blur();
  };
  const backLabel = routes.find((r) => r.id === back)?.label ?? "Library";

  return (
    <>
      <button type="button" className="rail-item settings-back" data-rail-tip={`Back to ${backLabel}`} onClick={onBack}>
        <span className="r-ico">
          <ArrowLeft size={17} />
        </span>
        <span className="rail-label">{backLabel}</span>
      </button>

      <label className="r-search settings-search" data-rail-tip="Search settings">
        <span className="r-ico">
          <Search size={16} />
        </span>
        <div className="r-search-field">
          <input
            ref={input}
            className="r-label settings-search-input"
            value={query}
            spellCheck={false}
            placeholder="Search settings"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
              else if (e.key === "ArrowDown") setHi((i) => Math.min(i + 1, hits.length - 1));
              else if (e.key === "ArrowUp") setHi((i) => Math.max(i - 1, 0));
              else if (e.key === "Enter" && hits[hi]) pick(hits[hi]);
              else return;
              e.preventDefault();
            }}
          />
        </div>
        {query ? (
          <button type="button" className="settings-search-clear r-label" aria-label="Clear" onClick={() => setQuery("")}>
            <X size={13} />
          </button>
        ) : (
          <kbd className="settings-search-kbd r-label">Ctrl K</kbd>
        )}
      </label>

      <nav className="rail-nav settings-rail-nav" aria-label="Settings sections">
        {query ? (
          hits.length ? (
            hits.map((h, i) => {
              const s = ALL_SECTIONS.find((x) => x.id === h.section)!;
              const Icon = s.icon;
              const groupLabel = NAV_GROUPS.find((g) => g.items.includes(s))?.label;
              return (
                <button
                  key={`${h.section}:${h.title ?? h.game?.name ?? ""}`}
                  type="button"
                  className={`rail-item settings-hit${i === hi ? " active" : ""}`}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(h)}
                >
                  <span className="r-ico">
                    <Icon size={16} />
                  </span>
                  <span className="settings-hit-text r-label">
                    <b>{h.game?.name ?? h.title ?? s.label}</b>
                    <small>
                      {h.game ? "Discord, live game details" : h.title ? `${groupLabel === "Clipdip" ? "Clipdip " : ""}${s.label}` : s.blurb}
                    </small>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="settings-hit-empty r-label">Nothing called that</div>
          )
        ) : (
          NAV_GROUPS.map((group, gi) => (
            <div key={group.label ?? gi} className="settings-rail-group">
              {group.label ? <div className="settings-rail-label r-label">{group.label}</div> : null}
              {group.items.map(({ id, label, icon: Icon }) => {
                const active = section === id;
                return (
                  <button
                    key={id}
                    type="button"
                    data-rail-tip={group.label === "Clipdip" ? `Clipdip ${label}` : label}
                    className={`rail-item${active ? " active" : ""}`}
                    onClick={() => openSection(id)}
                  >
                    {active ? <span className="rail-item-mark" aria-hidden="true" /> : null}
                    <span className="r-ico">
                      <Icon size={16} />
                    </span>
                    <span className="rail-label">{label}</span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </nav>
    </>
  );
}
