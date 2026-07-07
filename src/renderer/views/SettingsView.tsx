import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Clapperboard,
  Info,
  Keyboard,
  MonitorPlay,
  Palette,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import GeneralSection from "../settings/sections/GeneralSection";
import AppearanceSection from "../settings/sections/AppearanceSection";
import PlayerSection from "../settings/sections/PlayerSection";
import ExportSection from "../settings/sections/ExportSection";
import ShortcutsSection from "../settings/sections/ShortcutsSection";
import AboutSection from "../settings/sections/AboutSection";
import type { UseClips } from "../library/useClips";
import type { UseLibraryFilter } from "../library/useLibraryFilter";

type SectionId = "general" | "appearance" | "player" | "export" | "shortcuts" | "about";

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; blurb: string }[] = [
  { id: "general", label: "General", icon: Settings2, blurb: "Library location, integrations, and tags" },
  { id: "appearance", label: "Appearance", icon: Palette, blurb: "Font and library visuals" },
  { id: "player", label: "Player", icon: MonitorPlay, blurb: "Previews and the ambient glow" },
  { id: "export", label: "Export & Import", icon: Clapperboard, blurb: "Export presets and clip imports" },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard, blurb: "Player keyboard bindings" },
  { id: "about", label: "About", icon: Info, blurb: "Version, updates, and diagnostics" },
];

interface SettingsViewProps {
  lib: UseClips;
  filter: UseLibraryFilter;
}

export default function SettingsView({ lib, filter }: SettingsViewProps) {
  const [section, setSection] = useState<SectionId>("general");
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

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
            {section === "appearance" ? <AppearanceSection /> : null}
            {section === "player" ? <PlayerSection /> : null}
            {section === "export" ? <ExportSection /> : null}
            {section === "shortcuts" ? <ShortcutsSection /> : null}
            {section === "about" ? <AboutSection /> : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
