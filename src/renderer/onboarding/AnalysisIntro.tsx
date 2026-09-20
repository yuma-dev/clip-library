import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check } from "lucide-react";
import { useSettings } from "../settings/SettingsContext";
import { useAnalysis } from "../shell/useAnalysis";
import { ONBOARDING_VERSION } from "./version";
import AnalysisStep from "./AnalysisStep";

// a library run needs at least this many clips queued to count as the one-time listen
const LIBRARY_RUN_MIN = 3;

/** one-time card for people who already did the tour: opens the first time the library listen
 * starts, the same content as the tour's analysis step, dismissed with one button */
export default function AnalysisIntro() {
  const { settings, ready, set } = useSettings();
  const analysis = useAnalysis();
  const [open, setOpen] = useState(false);

  const tourDone = Number(settings.onboardingVersion ?? 0) >= ONBOARDING_VERSION;
  const seen = settings.analysisIntroSeen === true;

  useEffect(() => {
    if (!ready || open || seen || !tourDone) return;
    if (analysis.running && analysis.pending >= LIBRARY_RUN_MIN) setOpen(true);
  }, [ready, open, seen, tourDone, analysis.running, analysis.pending]);

  // devtools: __showAnalysisIntro() opens it regardless of the flag
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__showAnalysisIntro = () => {
      setOpen(true);
      return "analysis intro: open";
    };
  }, []);

  const close = () => {
    setOpen(false);
    void set("analysisIntroSeen", true);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div className="ob-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
          <motion.section
            className="ob-panel ob-panel--intro"
            role="dialog"
            aria-modal="true"
            aria-label="ClipLib hears your clips"
            initial={{ y: 22, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 14, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <div className="ob-body">
              <div className="ob-step">
                <AnalysisStep />
              </div>
            </div>
            <footer className="ob-footer">
              <span />
              <div className="ob-footer-nav">
                <button type="button" className="btn btn-primary" onClick={close}>
                  <Check size={14} /> Got it
                </button>
              </div>
            </footer>
          </motion.section>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
