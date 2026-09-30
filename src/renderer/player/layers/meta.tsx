import { Image, Sticker, Type, Volume2, type LucideProps } from "lucide-react";
import type { Layer, LayerKind } from "../../../types/clips";
import type { TrackView } from "../Waveform";

export const KIND_NAME: Record<LayerKind, string> = { volume: "Volume change", text: "Text", gif: "GIF", image: "Image" };
export const KIND_HINT: Record<LayerKind, string> = {
  volume: "Louder or quieter for a part",
  text: "Words on the clip",
  gif: "Search KLIPY",
  image: "From your PC",
};

export function KindIcon({ kind, ...props }: { kind: LayerKind } & LucideProps) {
  if (kind === "volume") return <Volume2 {...props} />;
  if (kind === "text") return <Type {...props} />;
  if (kind === "gif") return <Sticker {...props} />;
  return <Image {...props} />;
}

const ALL_TRACKS = "#e8e6ee";

/** device names end in a driver suffix, "Microphone FX (Elgato Virtual Audio)"; tags and
 * buttons show the part before it, the full name stays in the tooltip */
export function shortName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "") || name;
}

/** a track's colour and name as the mixer shows them; single-track clips have one nameless track */
export function trackInfo(tracks: TrackView[] | null, ordinal: number): { name: string; full: string; color: string } {
  const t = tracks?.find((x) => x.ordinal === ordinal);
  const full = t?.name || `Track ${ordinal + 1}`;
  return { name: shortName(full), full, color: t?.color || ALL_TRACKS };
}

export function layerColor(l: Layer, tracks: TrackView[] | null): string {
  if (l.kind === "volume") return l.track === "all" ? ALL_TRACKS : trackInfo(tracks, l.track).color;
  // subtitle lines carry their speaker color, the tags show who talks when
  if (l.kind === "text") return l.source === "subtitles" ? l.color : "#f4f4f6";
  if (l.kind === "gif") return "var(--color-accent-glyph)";
  return "var(--analysis-clr)";
}

/** file:// url for a local media path, keeps a windows drive letter intact */
export function fileUrl(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return "file:///" + parts.map((s, i) => (i === 0 && /^[a-z]:$/i.test(s) ? s : encodeURIComponent(s))).join("/");
}
