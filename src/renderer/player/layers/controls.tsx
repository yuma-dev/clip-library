import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";
import type { LayerAnim, TextLayer, TextStyle } from "../../../types/clips";
import { ANIM_S, TEXT_COLORS, TEXT_SIZE_MAX, TEXT_SIZE_MIN, TEXT_STYLES, clamp } from "./model";
import { textLook } from "./rasterize";

/** the popover's building blocks, shared with the subtitles panel so both read the same */

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pl-lp-row">
      <span className="pl-lp-label">{label}</span>
      {children}
    </div>
  );
}

/** the mixer's own vocabulary: the fill is the control. drag sets, arrows nudge, double click resets */
export function FillSlider({ value, min, max, reset, step, color, name, text, onChange, label, onReset }: {
  value: number;
  min: number;
  max: number;
  reset: number;
  step: number;
  color: string;
  name: string;
  text: string;
  label: string;
  onChange: (v: number) => void;
  /** double click; without it the slider goes back to reset */
  onReset?: () => void;
}) {
  const round = (v: number) => clamp(Math.round(v / step) * step, min, max);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.dataset.dragging = "true";
    const setFrom = (x: number) => {
      const r = el.getBoundingClientRect();
      let v = min + clamp((x - r.left) / r.width, 0, 1) * (max - min);
      // sticks to the reset value near it
      if (Math.abs(v - reset) < (max - min) * 0.02) v = reset;
      onChange(round(v));
    };
    setFrom(e.clientX);
    const move = (ev: PointerEvent) => setFrom(ev.clientX);
    const up = () => {
      delete el.dataset.dragging;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <div
      className="pl-lp-level"
      style={{ "--fill": `${((clamp(value, min, max) - min) / (max - min)) * 100}%`, "--unity": `${((reset - min) / (max - min)) * 100}%`, "--c": color } as CSSProperties}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      title="Drag to set, double click to reset"
      onPointerDown={onDown}
      onDoubleClick={() => (onReset ? onReset() : onChange(reset))}
      onKeyDown={(e) => {
        const d = (e.shiftKey ? 5 : 1) * step;
        if (e.key === "ArrowRight" || e.key === "ArrowUp") onChange(round(value + d));
        else if (e.key === "ArrowLeft" || e.key === "ArrowDown") onChange(round(value - d));
        else return;
        e.preventDefault();
      }}
    >
      <div className="pl-lp-level-fill" />
      <div className="pl-lp-level-unity" />
      <span className="pl-lp-level-name">{name}</span>
      <span className="pl-lp-level-value">{text}</span>
    </div>
  );
}

export function Seg<T extends string | number | boolean>({ value, options, onPick }: { value: T; options: Array<[T, ReactNode]>; onPick: (v: T) => void }) {
  return (
    <div className="pl-lp-seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={value === v ? "is-on" : undefined} onClick={() => onPick(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Seg's look, but each button switches on and off by itself */
export function Toggles<T extends string>({ value, options, onChange }: { value: T[]; options: Array<[T, ReactNode, string]>; onChange: (v: T[]) => void }) {
  return (
    <div className="pl-lp-seg is-fit">
      {options.map(([v, label, title]) => {
        const on = value.includes(v);
        return (
          <button
            key={v}
            type="button"
            aria-pressed={on}
            className={on ? "is-on" : undefined}
            title={title}
            onClick={() => onChange(on ? value.filter((x) => x !== v) : [...value, v])}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function StyleTiles({ value, color, onPick }: { value: TextStyle; color: string; onPick: (s: TextStyle) => void }) {
  return (
    <div className="pl-lp-styles">
      {TEXT_STYLES.map((s) => (
        <button key={s.id} type="button" className={value === s.id ? "is-on" : undefined} onClick={() => onPick(s.id)}>
          <span className={`pl-lt pl-lt-${s.id}`} style={{ "--c": color } as CSSProperties}>
            Aa
          </span>
          <em>{s.name}</em>
        </button>
      ))}
    </div>
  );
}

/** preset swatches, a picker for anything else, and an optional extra swatch in front */
export function Swatches({ value, onPick, lead }: { value: string | null; onPick: (c: string) => void; lead?: ReactNode }) {
  const custom = value !== null && !TEXT_COLORS.includes(value.toLowerCase());
  return (
    <div className="pl-lp-swatches">
      {lead}
      {TEXT_COLORS.map((c) => (
        <button key={c} type="button" aria-label={`Color ${c}`} className={value?.toLowerCase() === c ? "is-on" : undefined} style={{ background: c }} onClick={() => onPick(c)} />
      ))}
      <label className={`pl-lp-custom${custom ? " is-on" : ""}`} title="Any color" style={custom ? ({ "--pick": value } as CSSProperties) : undefined}>
        <input type="color" value={value ?? "#ffffff"} onChange={(e) => onPick(e.target.value)} />
      </label>
    </div>
  );
}

// the middle size reads as 100%
export const TEXT_SIZE_BASE = 4.6;

export function SizeSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <FillSlider
      label="Size"
      value={value}
      min={TEXT_SIZE_MIN}
      max={TEXT_SIZE_MAX}
      reset={TEXT_SIZE_BASE}
      step={0.1}
      color="#f4f4f6"
      name=""
      text={`${Math.round((value / TEXT_SIZE_BASE) * 100)}%`}
      onChange={onChange}
    />
  );
}

/** four by two show or hide choices; each previews its motion on hover */
export function AnimGrid({ list, value, out, onPick }: { list: Array<[LayerAnim, string]>; value: LayerAnim; out?: boolean; onPick: (a: LayerAnim) => void }) {
  return (
    <div className={`pl-lp-anims${out ? " is-out" : ""}`}>
      {list.map(([v, n]) => (
        <button key={v} type="button" className={value === v ? "is-on" : undefined} onClick={() => onPick(v)}>
          <span className="pl-lp-demo">
            <b className={`is-${v}`}>A</b>
          </span>
          {n}
        </button>
      ))}
    </div>
  );
}

/** the fine settings, off to the side of a popover so they're only there when wanted */
export function Flyout({ title, onClose, style, children }: { title: string; onClose: () => void; style?: CSSProperties; children: ReactNode }) {
  return (
    <div className="pl-more" style={style} onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
      <div className="pl-lp-head">
        <span className="pl-lp-title">{title}</span>
        <button type="button" className="pl-lp-icon" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      {children}
    </div>
  );
}

/** one fine setting: the name sits in the slider, double click goes back to the default */
export function Detail({ label, value, min, max, step, def, fmt, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  def: number;
  fmt: (v: number) => string;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <FillSlider
      label={label}
      value={value}
      min={min}
      max={max}
      reset={def}
      step={step}
      color="#f4f4f6"
      name={label}
      text={fmt(value)}
      onChange={onChange}
      onReset={() => onChange(undefined)}
    />
  );
}

const secs = (v: number) => `${v.toFixed(2)} s`;
const pctOf = (v: number) => `${Math.round(v * 100)}%`;
const em = (v: number) => (v === 0 ? "none" : v.toFixed(2));

export type TextDetails = Pick<TextLayer, "outline" | "shadow" | "boxOpacity" | "spacing" | "opacity" | "din" | "dout">;

/** outline, shadow, box, spacing, opacity and animation lengths of a text layer, or of every
 * subtitle line when the panel passes its shared style in */
export function TextDetailRows({ l, onChange }: { l: TextDetails & { style: TextStyle }; onChange: (patch: Partial<TextDetails>) => void }) {
  const look = textLook(l as TextLayer);
  return (
    <>
      <Row label="Text">
        <Detail label="Outline" value={look.outline} min={0} max={0.5} step={0.01} def={textLook({ style: l.style } as TextLayer).outline} fmt={em} onChange={(outline) => onChange({ outline })} />
        <Detail label="Shadow" value={look.shadow} min={0} max={2} step={0.05} def={textLook({ style: l.style } as TextLayer).shadow} fmt={pctOf} onChange={(shadow) => onChange({ shadow })} />
        {l.style === "box" ? (
          <Detail label="Box" value={look.boxOpacity} min={0} max={1} step={0.01} def={0.82} fmt={pctOf} onChange={(boxOpacity) => onChange({ boxOpacity })} />
        ) : null}
        <Detail label="Spacing" value={look.spacing} min={-0.05} max={0.3} step={0.005} def={textLook({ style: l.style } as TextLayer).spacing} fmt={(v) => v.toFixed(2)} onChange={(spacing) => onChange({ spacing })} />
        <Detail label="Opacity" value={l.opacity ?? 1} min={0} max={1} step={0.01} def={1} fmt={pctOf} onChange={(opacity) => onChange({ opacity })} />
      </Row>
      <AnimLengthRows l={l} onChange={onChange} />
    </>
  );
}

export function AnimLengthRows({ l, onChange }: { l: Pick<TextLayer, "din" | "dout">; onChange: (patch: { din?: number; dout?: number }) => void }) {
  return (
    <Row label="Animation">
      <Detail label="Show" value={l.din ?? ANIM_S} min={0.05} max={2} step={0.05} def={ANIM_S} fmt={secs} onChange={(din) => onChange({ din })} />
      <Detail label="Hide" value={l.dout ?? ANIM_S} min={0.05} max={2} step={0.05} def={ANIM_S} fmt={secs} onChange={(dout) => onChange({ dout })} />
    </Row>
  );
}
