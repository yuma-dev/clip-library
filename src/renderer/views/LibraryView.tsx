import ClipGrid from "../library/ClipGrid";
import type { UseClips } from "../library/useClips";
import type { LocalClip } from "../library/types";

interface LibraryViewProps {
  lib: UseClips;
  /** Clips after search + tag + collection filtering. */
  clips: LocalClip[];
  grayscaleIcons: boolean;
}

export default function LibraryView({ lib, clips, grayscaleIcons }: LibraryViewProps) {
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
          clipLocation={lib.clipLocation}
          removeClips={lib.removeClips}
          renameClip={lib.renameClip}
        />
      )}

      {lib.generatingCount > 0 ? (
        <div className="thumb-gen-indicator">Generating {lib.generatingCount} thumbnails…</div>
      ) : null}
    </div>
  );
}
