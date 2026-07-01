import { Search, SlidersHorizontal } from "lucide-react";
import Tooltip from "../ui/Tooltip";

interface TopBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  clipCount: number;
}

// Library top bar: search + tag-filter entry + count. The tag filter (the liked
// purple dropdown) is wired up in Phase 5; here it's a disabled placeholder.
export default function TopBar({ query, onQueryChange, clipCount }: TopBarProps) {
  return (
    <div className="topbar">
      <label className="search-box">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search clips..."
        />
      </label>
      <Tooltip label="Tag filtering — Phase 5">
        <button type="button" className="filter-trigger" disabled>
          <SlidersHorizontal size={14} />
          Tags
        </button>
      </Tooltip>
      <div className="clip-counter">{clipCount} clips</div>
    </div>
  );
}
