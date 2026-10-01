import { gameIconSrc, useLibraryGames } from "../library/games";
import type { UseLibraryFilter } from "../library/useLibraryFilter";

/** games the library's clips are from, most clipped first; a click filters the grid to one */
export default function RailGames({ filter }: { filter: UseLibraryFilter }) {
  const games = useLibraryGames();
  if (games.length === 0) return null;

  return (
    <div className="rail-section rail-section-fixed rail-games">
      <div className="rail-section-head">
        <span className="rail-section-title">Games</span>
        <span className="rail-section-count">({games.length})</span>
      </div>
      {/* four rows tall, the rest scrolls under a fade like the tag list */}
      <div className={`rail-games-wrap${games.length > 4 ? " more" : ""}`}>
        <div className="rail-collections rail-games-list">
          {games.map((g) => {
            const src = gameIconSrc(g);
            const isActive = filter.game === g.id;
            return (
              <button
                key={g.id}
                type="button"
                data-rail-tip={g.name}
                title={g.name}
                className={`rail-collection${isActive ? " active" : ""}`}
                onClick={() => filter.setGame(isActive ? null : g.id)}
              >
                {src ? (
                  <img className="rail-game-icon" src={src} alt="" loading="lazy" draggable={false} />
                ) : (
                  <span className="rail-game-icon blank" aria-hidden="true" />
                )}
                <span className="rail-label">{g.name}</span>
                <span className="rail-collection-count r-label">{g.count}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
