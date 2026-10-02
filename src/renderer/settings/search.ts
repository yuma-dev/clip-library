import { ALL_SECTIONS, type SectionId } from "./nav";

// row and group titles per section, as the sections render them (SetRow/SetGroup title), plus words
// people search for that the titles don't use. a renamed row still finds its section through the
// section name, it just loses the jump to the row
const TITLES: Record<SectionId, string[]> = {
  general: ["Clip library location", "Current location", "Games", "Find games for older clips", "Tags", "Manage tags", "Startup sound", "Play a sound at startup"],
  discord: [
    "While you play",
    "Show the game you're in",
    "Ranked as Competing",
    "Hours played",
    "Games that show",
    "In the library",
    "Show what you're doing",
    "Clip names",
    "The clip's game",
    "Library facts",
    "Editing and exporting",
  ],
  appearance: ["App font", "Interface font", "New clip indicators", "Greyscale game icons"],
  player: ["Playback", "Preview volume", "Ambient glow", "Card hover glow"],
  audio: ["Audio analysis", "Loudness match"],
  export: ["Export", "Master export preset", "Current strategy", "Import", "Import from SteelSeries"],
  storage: ["Clip folder", "Clean up"],
  shortcuts: ["Player shortcuts"],
  cliplib: ["ClipLib account", "API tokens", "Create token", "Invite codes", "Invite friends"],
  about: ["Updates", "Check for updates", "Report a problem", "Send diagnostics", "Anonymous diagnostics"],
  "clipdip-general": ["Enable Clipdip", "Start with Windows", "Process", "Clipdip binary", "Diagnostics"],
  "clipdip-video": [
    "Replay buffer",
    "Replay length",
    "Capture",
    "Monitor",
    "Frame rate",
    "Codec",
    "Include cursor",
    "Quality",
    "Recording quality",
    "Quality mode",
    "Target bitrate",
    "Keyframe interval",
    "Capture method",
  ],
  "clipdip-audio": ["Sources", "Recorded tracks", "Mixing", "Combined mix track"],
  "clipdip-output": [
    "Clips folder",
    "Filename",
    "Audio bitrate",
    "Game metadata",
    "Capture game metadata",
    "Extract game icon",
    "Save Discord call info",
    "Keep raw files",
    "FFmpeg path",
  ],
  "clipdip-hotkeys": ["Hotkeys"],
  "clipdip-notifications": ["Show notification", "Play sound", "Position", "Auto-dismiss", "Health alerts", "Preview on screen", "Recent notifications"],
};

const SYNONYMS: Partial<Record<SectionId, string>> = {
  discord: "rich presence rpc status activity game details",
  appearance: "theme look font",
  player: "glow volume preview",
  audio: "loudness normalize waveform",
  export: "render preset share",
  storage: "disk space delete",
  shortcuts: "keybinds keys",
  cliplib: "account login token invite",
  about: "version update bug",
  "clipdip-video": "fps bitrate resolution encoder nvenc av1 hevc h264 qp",
  "clipdip-audio": "mic microphone desktop tracks",
  "clipdip-output": "folder path name",
  "clipdip-hotkeys": "keybind shortcut save clip",
  "clipdip-notifications": "toast overlay popup",
};

export interface SearchHit {
  section: SectionId;
  /** the row to bring into view, null when only the section matched */
  title: string | null;
  /** a Discord game with live details */
  game?: { id: string; name: string };
}

/** sections first by best match, rows under them; `games` adds Discord's live detail games */
export function searchSettings(query: string, games: { id: string; name: string }[] = []): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: (SearchHit & { rank: number })[] = [];
  for (const s of ALL_SECTIONS) {
    const label = s.label.toLowerCase();
    if (label.startsWith(q)) hits.push({ section: s.id, title: null, rank: 0 });
    else if (label.includes(q) || s.blurb.toLowerCase().includes(q) || (SYNONYMS[s.id] ?? "").includes(q))
      hits.push({ section: s.id, title: null, rank: 2 });
    for (const t of TITLES[s.id]) {
      const l = t.toLowerCase();
      if (l.startsWith(q)) hits.push({ section: s.id, title: t, rank: 1 });
      else if (l.includes(q)) hits.push({ section: s.id, title: t, rank: 3 });
    }
  }
  for (const g of games) {
    const l = g.name.toLowerCase();
    if (l.startsWith(q) || l.includes(` ${q}`)) hits.push({ section: "discord", title: null, game: g, rank: 1 });
  }
  return hits.sort((a, b) => a.rank - b.rank).slice(0, 12);
}
