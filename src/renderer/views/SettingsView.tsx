import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  Clapperboard,
  FolderOpen,
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
import GeneralSection from "../settings/sections/GeneralSection";
import AppearanceSection from "../settings/sections/AppearanceSection";
import PlayerSection from "../settings/sections/PlayerSection";
import ExportSection from "../settings/sections/ExportSection";
import ShortcutsSection from "../settings/sections/ShortcutsSection";
import AboutSection from "../settings/sections/AboutSection";
import CliplibSection from "../settings/sections/CliplibSection";
import { ClipdipProvider } from "../settings/sections/clipdip/ClipdipContext";
import ClipdipGeneralSection from "../settings/sections/clipdip/ClipdipGeneralSection";
import ClipdipVideoSection from "../settings/sections/clipdip/ClipdipVideoSection";
import ClipdipAudioSection from "../settings/sections/clipdip/ClipdipAudioSection";
import ClipdipOutputSection from "../settings/sections/clipdip/ClipdipOutputSection";
import ClipdipHotkeysSection from "../settings/sections/clipdip/ClipdipHotkeysSection";
import ClipdipNotificationsSection from "../settings/sections/clipdip/ClipdipNotificationsSection";
import { useSettings } from "../settings/SettingsContext";
import { useToast } from "../ui/Toast";
import type { UseClips } from "../library/useClips";
import type { UseLibraryFilter } from "../library/useLibraryFilter";

type SectionId =
  | "general"
  | "appearance"
  | "player"
  | "export"
  | "shortcuts"
  | "cliplib"
  | "about"
  | "clipdip-general"
  | "clipdip-video"
  | "clipdip-audio"
  | "clipdip-output"
  | "clipdip-hotkeys"
  | "clipdip-notifications";

interface SectionDef {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  blurb: string;
}

const NAV_GROUPS: { label?: string; items: SectionDef[] }[] = [
  {
    items: [
      { id: "general", label: "General", icon: Settings2, blurb: "Library location, integrations, and tags" },
      { id: "appearance", label: "Appearance", icon: Palette, blurb: "Font and library visuals" },
      { id: "player", label: "Player", icon: MonitorPlay, blurb: "Previews and the ambient glow" },
      { id: "export", label: "Export & Import", icon: Clapperboard, blurb: "Export presets and clip imports" },
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

const ALL_SECTIONS = NAV_GROUPS.flatMap((g) => g.items);

/** Deep-link intent section -> nav section (legacy "clipdip" targets the group). */
const INTENT_ALIASES: Record<string, SectionId> = { clipdip: "clipdip-general" };

interface SettingsViewProps {
  lib: UseClips;
  filter: UseLibraryFilter;
  /** Deep-link intent from main (cliplib://settings/<section>). The nonce
   *  re-applies the section on repeated tray clicks. */
  intent?: { section?: string; nonce: number } | null;
}

export default function SettingsView({ lib, filter, intent }: SettingsViewProps) {
  const [section, setSection] = useState<SectionId>("general");

  useEffect(() => {
    if (!intent?.section) return;
    const target = INTENT_ALIASES[intent.section] ?? intent.section;
    if (ALL_SECTIONS.some((s) => s.id === target)) {
      setSection(target as SectionId);
    }
  }, [intent]);
  const active = ALL_SECTIONS.find((s) => s.id === section) ?? ALL_SECTIONS[0];
  const { undo, redo } = useSettings();
  const toast = useToast();

  // A real library thumbnail feeds the glow previews (newest clip that has
  // one), so they show what the glow actually looks like on your content.
  const sampleThumb = useMemo(() => {
    for (const clip of lib.clips) {
      const t = lib.thumbnails.get(clip.originalName);
      if (t) return t;
    }
    return null;
  }, [lib.clips, lib.thumbnails]);

  // Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) step through this session's settings
  // changes while the settings view is open. Text fields keep their native
  // undo — we only handle the shortcut outside editable targets.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      const isRedo = key === "y" || (key === "z" && e.shiftKey);
      const done = isRedo ? redo() : undo();
      if (done) toast.show(isRedo ? "Redid settings change" : "Undid settings change");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, toast]);

  // Section render map — adding a section stays one line.
  const renderers: Record<SectionId, () => ReactNode> = {
    general: () => <GeneralSection lib={lib} filter={filter} />,
    appearance: () => <AppearanceSection />,
    player: () => <PlayerSection sampleThumb={sampleThumb} />,
    export: () => <ExportSection />,
    shortcuts: () => <ShortcutsSection />,
    cliplib: () => <CliplibSection />,
    about: () => <AboutSection />,
    "clipdip-general": () => <ClipdipGeneralSection />,
    "clipdip-video": () => <ClipdipVideoSection />,
    "clipdip-audio": () => <ClipdipAudioSection />,
    "clipdip-output": () => <ClipdipOutputSection />,
    "clipdip-hotkeys": () => <ClipdipHotkeysSection />,
    "clipdip-notifications": () => <ClipdipNotificationsSection />,
  };

  return (
    <div className="settings-view">
      {/* Section rail (inside the view — the app rail stays for top-level nav). */}
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav-title">Settings</div>
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label ?? gi} className="settings-nav-group">
            {group.label ? <div className="settings-nav-label">{group.label}</div> : null}
            {group.items.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`settings-nav-item${section === id ? " active" : ""}`}
                onClick={() => setSection(id)}
              >
                <Icon size={15} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="settings-content">
        {/* Shared clipdip state survives switches between clipdip sections;
            its polling only runs while one of them is active. */}
        <ClipdipProvider active={section.startsWith("clipdip")}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={section}
              className="settings-page"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.14 }}
            >
              <header className="settings-page-head">
                <h2 className="settings-page-title">{active.label}</h2>
                <p className="settings-page-blurb">{active.blurb}</p>
              </header>

              {renderers[section]()}
            </motion.div>
          </AnimatePresence>
        </ClipdipProvider>
      </div>
    </div>
  );
}
