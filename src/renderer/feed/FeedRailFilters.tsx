// Sidebar filter sections for the feed route — rendered by Sidebar in place
// of the library's Collections/Tags/stats when route === "feed". Reads and
// writes the shared feedFilters store that FeedPage queries from.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import {
  clearFeedFilters,
  ensureFeedUsersLoaded,
  hasActiveFeedFilters,
  setFeedFilters,
  useFeedFilterUsers,
  useFeedFilters,
  useFeedGames,
  SORTS,
  type FeedSort,
} from "./feedFilters";
import { getAvatarUrl, type ShareUser } from "./types";
import "./feed.css";

const SORT_LABELS: Record<FeedSort, string> = {
  newest: "Newest",
  reactions: "Most reactions",
  comments: "Most comments",
};

function RailUserPicker({
  label,
  users,
  value,
  onChange,
}: {
  label: string;
  users: ShareUser[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = users.find((u) => u.id === value);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="fr-picker">
      <button
        type="button"
        className={`fr-picker-btn${selected ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        {selected ? (
          <>
            <img
              className="fr-picker-avatar"
              src={getAvatarUrl(selected.discordId, selected.avatarHash, 20)}
              alt=""
            />
            <span className="fr-picker-label">{selected.displayName}</span>
          </>
        ) : (
          <span className="fr-picker-label muted">{label}</span>
        )}
        {selected ? (
          <span
            className="fr-picker-clear"
            role="button"
            aria-label="Clear"
            onClick={(e) => {
              e.stopPropagation();
              onChange(undefined);
              setOpen(false);
            }}
          >
            <X size={12} />
          </span>
        ) : (
          <ChevronDown size={12} className="fr-picker-chevron" />
        )}
      </button>

      {open && (
        <div className="fr-picker-menu">
          {users.map((u) => (
            <button
              key={u.id}
              type="button"
              className={`fr-picker-item${value === u.id ? " active" : ""}`}
              onClick={() => {
                onChange(value === u.id ? undefined : u.id);
                setOpen(false);
              }}
            >
              <img
                className="fr-picker-avatar"
                src={getAvatarUrl(u.discordId, u.avatarHash, 20)}
                alt=""
              />
              <span className="fr-picker-label">{u.displayName}</span>
              {value === u.id ? <Check size={13} /> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FeedRailFilters() {
  const filters = useFeedFilters();
  const users = useFeedFilterUsers();
  const games = useFeedGames();

  useEffect(() => {
    ensureFeedUsersLoaded();
  }, []);

  return (
    <div className="rail-section rail-section-fixed fr-rail">
      <div className="rail-section-head">
        <span className="rail-section-title">Filters</span>
        {hasActiveFeedFilters(filters) ? (
          <button type="button" className="fr-clear" onClick={clearFeedFilters}>
            Clear
          </button>
        ) : null}
      </div>

      <div className="fr-field">
        <span className="fr-field-label">Posted by</span>
        <RailUserPicker
          label="Anyone"
          users={users}
          value={filters.user}
          onChange={(id) => setFeedFilters({ user: id })}
        />
      </div>

      <div className="fr-field">
        <span className="fr-field-label">Featuring</span>
        <RailUserPicker
          label="Anyone"
          users={users}
          value={filters.mention}
          onChange={(id) => setFeedFilters({ mention: id })}
        />
      </div>

      {games.length > 0 ? (
        <div className="fr-field">
          <span className="fr-field-label">Game</span>
          <select
            className="fr-select"
            value={filters.game || ""}
            onChange={(e) => setFeedFilters({ game: e.target.value || undefined })}
          >
            <option value="">All games</option>
            {games.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="fr-field">
        <span className="fr-field-label">Sort</span>
        <select
          className="fr-select"
          value={filters.sort}
          onChange={(e) => setFeedFilters({ sort: e.target.value as FeedSort })}
        >
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
