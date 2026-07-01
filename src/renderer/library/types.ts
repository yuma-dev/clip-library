// Local library clip (distinct from the web feed `Clip` — plan §5/D3).
// Shape mirrors what `get-clips` returns (main/clips.js), plus tags loaded
// separately via `get-clip-tags`.
export interface LocalClip {
  /** Path relative to the clip location; may contain `/` subfolders. Identity key. */
  originalName: string;
  customName: string;
  /** ms since epoch. */
  createdAt: number;
  thumbnailPath: string | null;
  isTrimmed: boolean;
  tags: string[];
  /** True for clips added since the last session, or added live while running. Drives new-clip highlighting. */
  isNewSinceLastSession?: boolean;
}
