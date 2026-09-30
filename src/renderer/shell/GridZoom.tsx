import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Grid2x2, Grid3x3 } from "lucide-react";
import { useSettings } from "../settings/SettingsContext";
import {
  applyGridSize,
  getGridSize,
  GRID_SIZE_MAX,
  GRID_SIZE_MIN,
  GRID_SIZE_STEP,
  GRID_ZOOM_EVENT,
} from "../library/gridDensity";

// one save per gesture, not per wheel notch or drag tick (each save rewrites settings.json)
const SAVE_DELAY_MS = 400;

/** card size slider in the titlebar. stays mounted off the library route so a saved size
 * still applies; `hidden` only hides it */
export default function GridZoom({ hidden }: { hidden: boolean }) {
  const { settings, set } = useSettings();
  const [size, setSize] = useState(getGridSize);
  const saveTimer = useRef(0);
  // no default in settings-manager on purpose: a missing key keeps the size from localStorage
  const saved = typeof settings.gridCardSize === "number" ? settings.gridCardSize : null;

  // settings load and settings undo; skipped while our own save is pending so a late commit
  // can't snap the grid back mid-gesture
  useEffect(() => {
    if (saved == null || saveTimer.current) return;
    setSize(applyGridSize(saved));
  }, [saved]);

  const save = (px: number) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = 0;
      void set("gridCardSize", px);
    }, SAVE_DELAY_MS);
  };

  // ctrl+wheel and ctrl+0 over the grid apply in gridDensity.ts, the slider follows
  useEffect(() => {
    const onZoom = (e: Event) => {
      const px = (e as CustomEvent<number>).detail;
      setSize(px);
      save(px);
    };
    window.addEventListener(GRID_ZOOM_EVENT, onZoom);
    return () => window.removeEventListener(GRID_ZOOM_EVENT, onZoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const fill = ((size - GRID_SIZE_MIN) / (GRID_SIZE_MAX - GRID_SIZE_MIN)) * 100;

  return (
    <div
      className={`grid-zoom${hidden ? " hidden" : ""}`}
      title="Card size. Ctrl+scroll on the grid zooms, Ctrl+0 resets"
    >
      <Grid3x3 size={13} aria-hidden="true" />
      <input
        type="range"
        min={GRID_SIZE_MIN}
        max={GRID_SIZE_MAX}
        step={GRID_SIZE_STEP}
        value={size}
        aria-label="Card size"
        style={{ "--fill": `${fill}%` } as CSSProperties}
        onChange={(e) => {
          const px = applyGridSize(Number(e.target.value));
          setSize(px);
          save(px);
        }}
      />
      <Grid2x2 size={13} aria-hidden="true" />
    </div>
  );
}
