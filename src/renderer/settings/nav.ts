import { useSyncExternalStore } from "react";
import {
  AudioLines,
  Bell,
  Clapperboard,
  FolderOpen,
  HardDrive,
  Info,
  Keyboard,
  Mic,
  MonitorPlay,
  Palette,
  Settings2,
  Share2,
  Video,
  Videotape,
  type LucideIcon,
} from "lucide-react";
import DiscordIcon from "./sections/discord/DiscordIcon";

export type SectionId =
  | "general"
  | "discord"
  | "appearance"
  | "player"
  | "audio"
  | "export"
  | "storage"
  | "shortcuts"
  | "cliplib"
  | "about"
  | "clipdip-general"
  | "clipdip-video"
  | "clipdip-audio"
  | "clipdip-output"
  | "clipdip-hotkeys"
  | "clipdip-notifications";

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  blurb: string;
}

export const NAV_GROUPS: { label?: string; items: SectionDef[] }[] = [
  {
    label: "ClipLib",
    items: [
      { id: "general", label: "General", icon: Settings2, blurb: "Library location, games, and tags" },
      { id: "discord", label: "Discord", icon: DiscordIcon, blurb: "Your status while you play and in the library" },
      { id: "appearance", label: "Appearance", icon: Palette, blurb: "Font and library visuals" },
      { id: "player", label: "Player", icon: MonitorPlay, blurb: "Previews and the ambient glow" },
      { id: "audio", label: "Audio", icon: AudioLines, blurb: "Waveforms and even loudness across clips" },
      { id: "export", label: "Export & Import", icon: Clapperboard, blurb: "Export presets and clip imports" },
      { id: "storage", label: "Storage", icon: HardDrive, blurb: "What takes up space, and ways to get it back" },
      { id: "shortcuts", label: "Shortcuts", icon: Keyboard, blurb: "Player keyboard bindings" },
      { id: "cliplib", label: "ClipLib", icon: Share2, blurb: "Account, invite codes, and API tokens" },
      { id: "about", label: "About", icon: Info, blurb: "Version, updates, and diagnostics" },
    ],
  },
  {
    label: "Clipdip",
    items: [
      { id: "clipdip-general", label: "General", icon: Videotape, blurb: "Process, autostart, and diagnostics" },
      { id: "clipdip-video", label: "Video", icon: Video, blurb: "Replay buffer, capture, and quality" },
      { id: "clipdip-audio", label: "Audio", icon: Mic, blurb: "Recorded sources and mixing" },
      { id: "clipdip-output", label: "Output", icon: FolderOpen, blurb: "Where clips land and how they're named" },
      { id: "clipdip-hotkeys", label: "Hotkeys", icon: Keyboard, blurb: "Global capture keys" },
      { id: "clipdip-notifications", label: "Notifications", icon: Bell, blurb: "The on-screen save overlay" },
    ],
  },
];

export const ALL_SECTIONS = NAV_GROUPS.flatMap((g) => g.items);

// deep links say "clipdip" for the whole group
const ALIASES: Record<string, SectionId> = { clipdip: "clipdip-general" };

export function resolveSection(section: string | undefined): SectionId | null {
  if (!section) return null;
  const id = ALIASES[section] ?? section;
  return ALL_SECTIONS.some((s) => s.id === id) ? (id as SectionId) : null;
}

/** what settings should bring into view after a jump: a row or group by title, or a Discord game */
export interface SettingsFocus {
  title?: string;
  game?: string;
  nonce: number;
}

// the open section lives outside React so the sidebar and the page share it without App plumbing
let state: { section: SectionId; focus: SettingsFocus | null } = { section: "general", focus: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openSection(section: SectionId, focus?: Omit<SettingsFocus, "nonce">): void {
  state = { section, focus: focus ? { ...focus, nonce: Date.now() } : null };
  emit();
}

export function useSettingsNav(): { section: SectionId; focus: SettingsFocus | null } {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
