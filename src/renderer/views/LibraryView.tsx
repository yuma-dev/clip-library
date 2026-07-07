import { memo } from "react";
import ClipGrid from "../library/ClipGrid";
import type { UseClips } from "../library/useClips";
import type { LocalClip } from "../library/types";

interface LibraryViewProps {
  lib: UseClips;
  /** Clips after search + tag + collection filtering. */
  clips: LocalClip[];
  grayscaleIcons: boolean;
  /** Settings → show new-clip indicators (dot + card highlight). */
  showNewIndicators: boolean;
  /** Settings → hover preview volume (0–1). */
  previewVolume: number;
  /** Assignable global tags for the card "Manage tags" menu. */
  globalTags: string[];
  /** Create a new global tag (used by "Manage tags" → create). */
  addGlobalTag: (tag: string) => void;
}

function LibraryView({
  lib,
  clips,
  grayscaleIcons,
  showNewIndicators,
  previewVolume,
  globalTags,
  addGlobalTag,
}: LibraryViewProps) {
  return (
    <div className="library-view">
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
        <ClipGrid
          clips={clips}
          thumbnails={lib.thumbnails}
          grayscaleIcons={grayscaleIcons}
          showNewIndicators={showNewIndicators}
          previewVolume={previewVolume}
          clipLocation={lib.clipLocation}
          removeClips={lib.removeClips}
          renameClip={lib.renameClip}
          setClipTags={lib.setClipTags}
          globalTags={globalTags}
          addGlobalTag={addGlobalTag}
        />
      )}

      {lib.generatingCount > 0 ? (
        <div className="thumb-gen-indicator">Generating {lib.generatingCount} thumbnails…</div>
      ) : null}
    </div>
  );
}

// Memoized so app-shell state changes (rail width, route, …) don't reconcile
// the 2,000-card grid underneath.
export default memo(LibraryView);
