import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check } from "lucide-react";
import "../../../assets/setsu/setsu-logo.css";
import "../../../assets/setsu/setsu-logo.js";

type SetsuLogoInstance = { reveal(opts?: { name?: boolean }): Promise<void> };
type SetsuLogoCtor = new (root: HTMLElement, opts?: { size?: number }) => SetsuLogoInstance;

// the logo plays its reveal with the name once the panel has risen into place
const REVEAL_DELAY_MS = 700;
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
// the readings behind the name (checked against jisho.org): setsuna is where it's shortened from,
// the other three are kanji read setsu. 刹 alone means temple, so it only shows inside 刹那
const READINGS = [
  { kanji: "刹那", reading: "setsuna", meaning: "an instant" },
  { kanji: "切", reading: "setsu", meaning: "cut" },
  { kanji: "接", reading: "setsu", meaning: "connect" },
  { kanji: "摂", reading: "setsu", meaning: "take in" },
];
// the tiles come up one by one once the card has risen in
const TILES_AT_S = 0.95;
const TILE_STEP_S = 0.09;

/** the one-time "ClipLib is now Setsu" card (RebrandGate decides when) */
export default function RebrandIntro({ open, onClose }: { open: boolean; onClose: () => void }) {
  return createPortal(<AnimatePresence>{open ? <Panel onClose={onClose} /> : null}</AnimatePresence>, document.body);
}

function Panel({ onClose }: { onClose: () => void }) {
  const logoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const Ctor = (window as unknown as { SetsuLogo?: SetsuLogoCtor }).SetsuLogo;
    if (!logoRef.current || !Ctor) return;
    const logo = new Ctor(logoRef.current, { size: 88 });
    const t = window.setTimeout(() => void logo.reveal({ name: true }), REVEAL_DELAY_MS);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // the library blurs and dims slowly behind the card rising from the bottom
    <motion.div
      className="ob-backdrop"
      initial={{ backgroundColor: "rgba(0, 0, 0, 0)", backdropFilter: "blur(0px)" }}
      animate={{ backgroundColor: "rgba(0, 0, 0, 0.62)", backdropFilter: "blur(14px)" }}
      exit={{ backgroundColor: "rgba(0, 0, 0, 0)", backdropFilter: "blur(0px)" }}
      transition={{ duration: 0.9, ease: "easeOut" }}
    >
      <motion.section
        className="ob-brand"
        role="dialog"
        aria-modal="true"
        aria-label="ClipLib is now Setsu"
        initial={{ y: "70vh", opacity: 0 }}
        animate={{ y: 0, opacity: 1, transition: { duration: 0.8, ease: EASE_OUT, delay: 0.15 } }}
        exit={{ y: "40vh", opacity: 0, transition: { duration: 0.35, ease: [0.7, 0, 0.84, 0] } }}
      >
        <div className="ob-brand-stage">
          <div ref={logoRef} />
        </div>
        <div className="ob-brand-copy">
          <div className="ob-kicker">
            <span className="dia">◇</span> New name
          </div>
          <h1 className="ob-title">ClipLib is now Setsu</h1>
          <p className="ob-lede">
            This project never really had a name. I shortened clip library to ClipLib so it wasn't just a
            description, and I've been looking for the right one ever since.
          </p>
          <p className="ob-lede ob-brand-more">
            I settled on <span className="ob-brand-name">Setsu</span>, short for setsuna. It's also how you read
            the kanji for three more things:
          </p>
          <ul className="ob-kanji">
            {READINGS.map((r, i) => (
              <motion.li
                key={r.kanji}
                className={i === 0 ? "ob-kanji-tile is-root" : "ob-kanji-tile"}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: EASE_OUT, delay: TILES_AT_S + i * TILE_STEP_S }}
              >
                <span className="ob-kanji-reading">{r.reading}</span>
                <span className="ob-kanji-char" lang="ja">
                  {r.kanji}
                </span>
                <span className="ob-kanji-meaning">{r.meaning}</span>
              </motion.li>
            ))}
          </ul>
          <p className="ob-lede ob-brand-more">Together that's pretty much what this project is to me.</p>
        </div>
        <footer className="ob-footer">
          <span />
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            <Check size={14} /> Got it
          </button>
        </footer>
      </motion.section>
    </motion.div>
  );
}
