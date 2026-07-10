import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Clapperboard,
  Info,
  Keyboard,
  MonitorPlay,
  Palette,
  Settings2,
  Share2,
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
import ClipperSection from "../settings/sections/ClipperSection";
import { useSettings } from "../settings/SettingsContext";
import { useToast } from "../ui/Toast";
import type { UseClips } from "../library/useClips";
import type { UseLibraryFilter } from "../library/useLibraryFilter";

type SectionId =
  | "general"
  | "clipper"
  | "appearance"
  | "player"
  | "export"
  | "shortcuts"
  | "cliplib"
  | "about";

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; blurb: string }[] = [
  { id: "general", label: "General", icon: Settings2, blurb: "Library location, integrations, and tags" },
  { id: "clipper", label: "Clipper", icon: Videotape, blurb: "Replay buffer, hotkeys, and recording" },
  { id: "appearance", label: "Appearance", icon: Palette, blurb: "Font and library visuals" },
  { id: "player", label: "Player", icon: MonitorPlay, blurb: "Previews and the ambient glow" },
  { id: "export", label: "Export & Import", icon: Clapperboard, blurb: "Export presets and clip imports" },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard, blurb: "Player keyboard bindings" },
  { id: "cliplib", label: "ClipLib", icon: Share2, blurb: "Account, invite codes, and API tokens" },
  { id: "about", label: "About", icon: Info, blurb: "Version, updates, and diagnostics" },
];

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
    if (SECTIONS.some((s) => s.id === intent.section)) {
      setSection(intent.section as SectionId);
    }
  }, [intent]);
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
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

  return (
    <div className="settings-view">
      {/* Section rail (inside the view — the app rail stays for top-level nav). */}
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav-title">Settings</div>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
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
      </nav>

      <div className="settings-content">
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

            {section === "general" ? <GeneralSection lib={lib} filter={filter} /> : null}
            {section === "clipper" ? <ClipperSection /> : null}
            {section === "appearance" ? <AppearanceSection /> : null}
            {section === "player" ? <PlayerSection sampleThumb={sampleThumb} /> : null}
            {section === "export" ? <ExportSection /> : null}
            {section === "shortcuts" ? <ShortcutsSection /> : null}
            {section === "cliplib" ? <CliplibSection /> : null}
            {section === "about" ? <AboutSection /> : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
