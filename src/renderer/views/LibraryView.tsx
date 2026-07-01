import { useState } from "react";
import TopBar from "../shell/TopBar";
import ClipGrid from "../library/ClipGrid";
import type { UseClips } from "../library/useClips";

interface LibraryViewProps {
  lib: UseClips;
}

export default function LibraryView({ lib }: LibraryViewProps) {
  // Search is wired up in Phase 5; the query is captured here for now.
  const [query, setQuery] = useState("");

  return (
    <div className="library-view">
      <TopBar query={query} onQueryChange={setQuery} clipCount={lib.clips.length} />

      {lib.loading ? (
        <div className="library-body">
          <div className="view-placeholder">
            <div className="placeholder-mark dia" aria-hidden="true">
              ◇
            </div>
            <p>Loading clips…</p>
          </div>
        </div>
      ) : (
        <ClipGrid clips={lib.clips} thumbnails={lib.thumbnails} clipLocation={lib.clipLocation} />
      )}

      {lib.generatingCount > 0 ? (
        <div className="thumb-gen-indicator">Generating {lib.generatingCount} thumbnails…</div>
      ) : null}
    </div>
  );
}
