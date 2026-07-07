import { useState } from "react";

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  /** Fired continuously while dragging (live preview). */
  onInput?: (value: number) => void;
  /** Fired once on release (persist). */
  onCommit: (value: number) => void;
  /** Renders the value label to the right of the track. */
  format?: (value: number) => string;
  disabled?: boolean;
  "aria-label"?: string;
}

/**
 * Range slider with a live value label. Local state tracks the drag so the
 * label/track update every frame; the (usually IPC-saving) commit fires only
 * on release — same input/change split as the legacy settings sliders.
 */
export default function Slider({
  value,
  min,
  max,
  step,
  onInput,
  onCommit,
  format,
  disabled,
  ...aria
}: SliderProps) {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;
  const pct = ((shown - min) / (max - min)) * 100;

  return (
    <div className={`set-slider${disabled ? " disabled" : ""}`}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        aria-label={aria["aria-label"]}
        style={{ "--fill": `${pct}%` } as React.CSSProperties}
        onChange={(e) => {
          const v = Number(e.target.value);
          setDragging(v);
          onInput?.(v);
        }}
        onPointerUp={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          setDragging(null);
          onCommit(v);
        }}
        onKeyUp={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (v !== value) {
            setDragging(null);
            onCommit(v);
          }
        }}
      />
      <span className="set-slider-value">{format ? format(shown) : String(shown)}</span>
    </div>
  );
}
