import { useEffect, useMemo, useState } from "react";
import { Gamepad2, Search } from "lucide-react";
import Modal from "../ui/Modal";
import Toggle from "../ui/Toggle";
import { gameIconSrc, useLibraryGames, type LibraryGame } from "../library/games";

interface PresenceGamesModalProps {
  open: boolean;
  onClose: () => void;
  /** game ids kept out of the Discord status */
  hidden: string[];
  onChange: (hidden: string[]) => void;
}

/** which games may show in the Discord status: whatever runs now, every game clipdip ever showed,
 * and the games the library has clips of */
export default function PresenceGamesModal({ open, onClose, hidden, onChange }: PresenceGamesModalProps) {
  const libraryGames = useLibraryGames();
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<LibraryGame | null>(null);
  const [played, setPlayed] = useState<Array<LibraryGame & { last_seen: number }>>([]);

  // a game you just started may not have a clip yet, it still belongs in the list
  useEffect(() => {
    if (!open) return;
    window.clips
      .getPlayedGames()
      .then((list) => setPlayed(list.map((g) => ({ ...g, iconPath: null, count: 0 }))))
      .catch(() => setPlayed([]));
    window.clips.clipdip
      .control("game_status")
      .then((r) => {
        const g = (r as { game?: { id: string; name: string; icon_url?: string | null } | null })?.game;
        setPlaying(g ? { id: g.id, name: g.name, icon_url: g.icon_url ?? null, iconPath: null, count: 0 } : null);
      })
      .catch(() => setPlaying(null));
  }, [open]);

  // playing now first, then games played without a clip yet, newest first, then the library's games
  const games = useMemo(() => {
    const clipped = new Map(libraryGames.map((g) => [g.id, g] as const));
    const list: LibraryGame[] = [];
    const seen = new Set<string>();
    const add = (g: LibraryGame) => {
      if (seen.has(g.id)) return;
      seen.add(g.id);
      list.push(clipped.get(g.id) ?? g);
    };
    if (playing) add(playing);
    for (const g of played) if (!clipped.has(g.id)) add(g);
    for (const g of libraryGames) add(g);
    const q = query.trim().toLowerCase();
    return q ? list.filter((g) => g.name.toLowerCase().includes(q)) : list;
  }, [libraryGames, played, playing, query]);

  const hiddenSet = new Set(hidden);
  const toggle = (id: string, show: boolean) => {
    const next = new Set(hidden);
    if (show) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={480}
      title={
        <>
          <Gamepad2 size={15} className="dia" /> Games in Discord status
        </>
      }
    >
      <div className="tagman">
        <div className="tagman-search-row">
          <label className="tagman-search">
            <Search size={14} />
            <input value={query} placeholder="Search games…" onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>
        <div className="tagman-list">
          {games.length === 0 ? <div className="tagman-empty">No games yet.</div> : null}
          {games.map((g) => {
            const src = gameIconSrc(g);
            const shown = !hiddenSet.has(g.id);
            return (
              <div className="tagman-row" key={g.id}>
                {src ? (
                  <img className="ctx-game-icon" src={src} alt="" loading="lazy" draggable={false} />
                ) : (
                  <span className="ctx-game-icon" aria-hidden="true" />
                )}
                <span className="tagman-name" title={g.name}>
                  {g.name}
                </span>
                <span className="tagman-count">
                  {playing?.id === g.id ? "playing now" : g.count > 0 ? `${g.count} clip${g.count === 1 ? "" : "s"}` : "no clips yet"}
                </span>
                <div className="tagman-actions">
                  <Toggle checked={shown} onChange={(v) => toggle(g.id, v)} aria-label={`Show ${g.name} in Discord status`} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
