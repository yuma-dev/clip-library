// local library clip, distinct from the web feed `Clip` (plan section 5/D3)
// shape mirrors get-clips (main/clips.js); tags load separately via get-clip-tags
export interface LocalClip {
  /** path relative to the clip location, may contain `/` subfolders. identity key */
  originalName: string;
  customName: string;
  /** ms since epoch */
  createdAt: number;
  thumbnailPath: string | null;
  isTrimmed: boolean;
  tags: string[];
  /** true for clips added since last session or live while running; drives new-clip highlighting */
  isNewSinceLastSession?: boolean;
}
