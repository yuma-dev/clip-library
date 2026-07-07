import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import Popover from "./Popover";

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Muted second line under the label. */
  hint?: string;
  /** Per-option style (e.g. render each font option in its own family). */
  style?: CSSProperties;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Trigger width in px (menu matches at minimum). */
  width?: number;
  "aria-label"?: string;
}

/**
 * Custom select built on Popover — dark, keyboard-navigable (arrows + Enter +
 * Escape via Popover), with per-option styling native <select> can't do.
 */
export default function Select({ value, options, onChange, disabled, width = 230, ...aria }: SelectProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setActive(idx < 0 ? 0 : idx);
    // Scroll the selected option into view once the menu mounts.
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-idx="${idx < 0 ? 0 : idx}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }, [open, options, value]);

  const commit = (idx: number) => {
    const opt = options[idx];
    if (!opt) return;
    setOpen(false);
    if (opt.value !== value) onChange(opt.value);
    anchorRef.current?.focus();
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((prev) => {
        const next = Math.min(options.length - 1, Math.max(0, prev + (e.key === "ArrowDown" ? 1 : -1)));
        listRef.current?.querySelector<HTMLElement>(`[data-idx="${next}"]`)?.scrollIntoView({ block: "nearest" });
        return next;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(active);
    }
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="select-trigger"
        style={{ width }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={aria["aria-label"]}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="select-value" style={selected?.style}>
          {selected?.label ?? value}
        </span>
        <ChevronDown size={14} className="select-caret" />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef}>
        <div className="menu select-menu" role="listbox" ref={listRef} style={{ minWidth: width }}>
          {options.map((opt, idx) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              data-idx={idx}
              className={`select-option${opt.value === value ? " selected" : ""}${idx === active ? " active" : ""}`}
              onMouseEnter={() => setActive(idx)}
              onClick={() => commit(idx)}
            >
              <span className="select-option-main" style={opt.style}>
                <span className="select-option-label">{opt.label}</span>
                {opt.hint ? <span className="select-option-hint">{opt.hint}</span> : null}
              </span>
              {opt.value === value ? <Check size={14} className="select-check" /> : null}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
