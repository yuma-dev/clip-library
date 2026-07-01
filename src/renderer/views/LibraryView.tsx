import { useState } from "react";
import TopBar from "../shell/TopBar";

interface LibraryViewProps {
  clipCount: number;
  ready: boolean;
}

// Shell-phase placeholder. The real time-grouped clip grid, cards, hover preview,
// and context menu land in Phase 3.
export default function LibraryView({ clipCount, ready }: LibraryViewProps) {
  const [query, setQuery] = useState("");

  return (
    <div className="library-view">
      <TopBar query={query} onQueryChange={setQuery} clipCount={clipCount} />
      <div className="library-body">
        <div className="view-placeholder">
          <div className="placeholder-mark dia" aria-hidden="true">◇</div>
          <p>Library grid arrives in Phase 3.</p>
          <p className="muted">{ready ? `${clipCount} clips detected.` : "Loading…"}</p>
        </div>
      </div>
    </div>
  );
}
