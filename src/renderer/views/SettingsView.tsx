import { useEffect, useMemo, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import GeneralSection from "../settings/sections/GeneralSection";
import AppearanceSection from "../settings/sections/AppearanceSection";
import PlayerSection from "../settings/sections/PlayerSection";
import LoudnessSection from "../settings/sections/LoudnessSection";
import AnalysisSection from "../settings/sections/AnalysisSection";
import ExportSection from "../settings/sections/ExportSection";
import StorageSection from "../settings/sections/StorageSection";
import ShortcutsSection from "../settings/sections/ShortcutsSection";
import AboutSection from "../settings/sections/AboutSection";
import CliplibSection from "../settings/sections/CliplibSection";
import DiscordSection from "../settings/sections/discord/DiscordSection";
import { ClipdipProvider } from "../settings/sections/clipdip/ClipdipContext";
import ClipdipGeneralSection from "../settings/sections/clipdip/ClipdipGeneralSection";
import ClipdipVideoSection from "../settings/sections/clipdip/ClipdipVideoSection";
import ClipdipAudioSection from "../settings/sections/clipdip/ClipdipAudioSection";
import ClipdipOutputSection from "../settings/sections/clipdip/ClipdipOutputSection";
import ClipdipHotkeysSection from "../settings/sections/clipdip/ClipdipHotkeysSection";
import ClipdipNotificationsSection from "../settings/sections/clipdip/ClipdipNotificationsSection";
import { useSettings } from "../settings/SettingsContext";
import { ALL_SECTIONS, useSettingsNav, type SectionId } from "../settings/nav";
import { useToast } from "../ui/Toast";
import type { UseClips } from "../library/useClips";
import type { UseLibraryFilter } from "../library/useLibraryFilter";

export { NAV_GROUPS } from "../settings/nav";

interface SettingsViewProps {
  lib: UseClips;
  filter: UseLibraryFilter;
}

export default function SettingsView({ lib, filter }: SettingsViewProps) {
  const { section, focus } = useSettingsNav();
  const active = ALL_SECTIONS.find((s) => s.id === section) ?? ALL_SECTIONS[0];
  const { undo, redo } = useSettings();
  const toast = useToast();

  // real thumbnail feeds glow previews (newest clip with one) so they match your content
  const sampleThumb = useMemo(() => {
    for (const clip of lib.clips) {
      const t = lib.thumbnails.get(clip.originalName);
      if (t) return t;
    }
    return null;
  }, [lib.clips, lib.thumbnails]);

  // ctrl+z / ctrl+shift+z (or ctrl+y) step through this session's settings
  // changes; text fields keep native undo, handled only outside editable targets
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

  // a search hit brings its row into view once the page has mounted (it animates in over 140 ms)
  useEffect(() => {
    if (!focus?.title) return;
    const t = setTimeout(() => {
      const els = document.querySelectorAll<HTMLElement>(".settings-page .set-row-title, .settings-page .set-group-title");
      const el = [...els].find((e) => e.textContent?.trim().toLowerCase().startsWith(focus.title!.toLowerCase()));
      const target = el?.closest<HTMLElement>(".set-row, .set-group") ?? el;
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.remove("settings-flash");
      void target.offsetWidth;
      target.classList.add("settings-flash");
    }, 220);
    return () => clearTimeout(t);
  }, [focus]);

  // section render map, adding a section stays one line
  const renderers: Record<SectionId, () => ReactNode> = {
    general: () => <GeneralSection lib={lib} filter={filter} />,
    discord: () => <DiscordSection lib={lib} />,
    appearance: () => <AppearanceSection />,
    player: () => <PlayerSection sampleThumb={sampleThumb} />,
    audio: () => (
      <>
        <AnalysisSection />
        <LoudnessSection lib={lib} />
      </>
    ),
    export: () => <ExportSection />,
    storage: () => <StorageSection lib={lib} />,
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
      <div className="settings-content">
        {/* Shared clipdip state survives switches between clipdip sections;
            its polling only runs while one of them is active. */}
        <ClipdipProvider active={section.startsWith("clipdip")}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={section}
              className={`settings-page${section === "discord" ? " wide" : ""}`}
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
