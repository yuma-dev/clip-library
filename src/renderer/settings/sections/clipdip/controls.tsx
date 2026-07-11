import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronRight, KeyRound } from "lucide-react";
import Slider from "../../../ui/Slider";
import { useClipdip, type LiveStatus } from "./ClipdipContext";

/** Text input that commits on blur/Enter (clipdip settings write TOML + reload). */
export function CommitInput({
  value,
  onCommit,
  onDraft,
  disabled,
  mono,
  width = 260,
  placeholder,
}: {
  value: string;
  onCommit: (value: string) => void;
  /** Fired on every keystroke (live previews). */
  onDraft?: (value: string) => void;
  disabled?: boolean;
  mono?: boolean;
  width?: number;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  return (
    <input
      type="text"
      className={`cliplib-input${mono ? " set-mono" : ""}`}
      style={{ width, flex: "none" }}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        onDraft?.(e.target.value);
      }}
      onBlur={() => {
        editing.current = false;
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Hotkey capture. Physical-key (`e.code`) to canonical token understood by
// the Rust parser (crates/hotkey parse_vk). Using `e.code` instead of `e.key`
// makes capture immune to Shift mutations and keyboard layouts. Only keys in
// this map can be recorded, so anything saved registers on the backend.
// ---------------------------------------------------------------------------

const CODE_TO_TOKEN: Record<string, string> = (() => {
  const m: Record<string, string> = {
    Space: "Space", Tab: "Tab", Enter: "Enter", NumpadEnter: "Enter",
    Backspace: "Backspace", Insert: "Insert", Delete: "Delete",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    PrintScreen: "PrintScreen", ScrollLock: "ScrollLock", Pause: "Pause",
    CapsLock: "CapsLock", NumLock: "NumLock",
    NumpadAdd: "NumPlus", NumpadSubtract: "NumMinus",
    NumpadMultiply: "NumMult", NumpadDivide: "NumDiv", NumpadDecimal: "NumDot",
    Semicolon: ";", Equal: "=", Comma: ",", Minus: "-", Period: ".",
    Slash: "/", Backquote: "`", BracketLeft: "[", Backslash: "\\",
    BracketRight: "]", Quote: "'",
  };
  for (let i = 0; i < 26; i++) {
    const c = String.fromCharCode(65 + i);
    m[`Key${c}`] = c;
  }
  for (let i = 0; i <= 9; i++) {
    m[`Digit${i}`] = String(i);
    m[`Numpad${i}`] = `Num${i}`;
  }
  for (let i = 1; i <= 24; i++) m[`F${i}`] = `F${i}`;
  return m;
})();

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "AltLeft", "AltRight",
  "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight",
]);

function modifierTokens(e: KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Win");
  return mods;
}

function KeyChip({ children, ghost }: { children: ReactNode; ghost?: boolean }) {
  return <span className={`hotkey-chip${ghost ? " ghost" : ""}`}>{children}</span>;
}

export function HotkeyCapture({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [heldMods, setHeldMods] = useState<string[]>([]);
  const [rejected, setRejected] = useState(false);
  const rejectTimer = useRef<number | null>(null);
  const parts = value ? value.split("+").map((s) => s.trim()).filter(Boolean) : [];

  useEffect(() => {
    if (!recording) {
      setHeldMods([]);
      return;
    }
    const flashRejected = () => {
      setRejected(true);
      if (rejectTimer.current) clearTimeout(rejectTimer.current);
      rejectTimer.current = window.setTimeout(() => setRejected(false), 1100);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setRecording(false);
        return;
      }
      if (MODIFIER_CODES.has(e.code)) {
        setHeldMods(modifierTokens(e));
        return;
      }
      const token = CODE_TO_TOKEN[e.code];
      if (!token) {
        flashRejected();
        return;
      }
      onChange([...modifierTokens(e), token].join("+"));
      setRecording(false);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (MODIFIER_CODES.has(e.code)) setHeldMods(modifierTokens(e));
    };
    // Capture phase so the recorder beats any other in-app shortcut.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [recording, onChange]);

  useEffect(
    () => () => {
      if (rejectTimer.current) clearTimeout(rejectTimer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      className={`hotkey-capture${recording ? " recording" : ""}${rejected ? " rejected" : ""}`}
      disabled={disabled}
      onClick={() => setRecording(!recording)}
      onBlur={() => setRecording(false)}
    >
      {recording ? (
        rejected ? (
          <span className="hotkey-capture-msg error">
            <AlertTriangle size={11} /> Key not supported
          </span>
        ) : (
          <span className="hotkey-capture-msg">
            <span className="hotkey-capture-dot" />
            {heldMods.length ? (
              <span className="hotkey-capture-mods">
                {heldMods.map((mod) => (
                  <KeyChip key={mod} ghost>
                    {mod}
                  </KeyChip>
                ))}
                <span className="hotkey-capture-plus">+</span>
              </span>
            ) : (
              "Press keys"
            )}
          </span>
        )
      ) : (
        <span className="hotkey-capture-keys">
          {parts.map((p, i) => (
            <span key={i} className="hotkey-capture-part">
              {i > 0 ? <span className="hotkey-capture-plus">+</span> : null}
              <KeyChip>{p}</KeyChip>
            </span>
          ))}
          {!parts.length ? <span className="hotkey-capture-empty">Not set</span> : null}
        </span>
      )}
      <KeyRound size={11} className="hotkey-capture-icon" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// 2x2 corner picker for the notification overlay position.
// ---------------------------------------------------------------------------

const CORNERS = ["top_left", "top_right", "bottom_left", "bottom_right"] as const;

export function CornerPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`corner-picker${disabled ? " disabled" : ""}`} role="radiogroup" aria-label="Notification corner">
      {CORNERS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          aria-label={c.replace(/_/g, " ")}
          className={`corner-picker-slot ${c.replace("_", "-")}${c === value ? " active" : ""}`}
          disabled={disabled}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset slider: maps a discrete preset list onto Slider, showing "Custom"
// when the current config doesn't match any preset.
// ---------------------------------------------------------------------------

export function PresetSlider({
  presets,
  activeIndex,
  onPick,
  disabled,
  "aria-label": ariaLabel,
}: {
  presets: { label: string }[];
  /** -1 = custom (no preset matches). */
  activeIndex: number;
  onPick: (index: number) => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const custom = activeIndex === -1;
  return (
    <Slider
      value={custom ? Math.floor(presets.length / 2) : activeIndex}
      min={0}
      max={presets.length - 1}
      step={1}
      disabled={disabled}
      onCommit={onPick}
      format={(i) => (custom ? "Custom" : presets[i]?.label ?? "Custom")}
      aria-label={ariaLabel}
    />
  );
}

/** Collapsible "Advanced" block at the bottom of a group. */
export function Disclosure({
  label = "Advanced",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="set-disclosure">
      <button type="button" className="set-disclosure-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className={`set-disclosure-caret${open ? " open" : ""}`} />
        {label}
      </button>
      {open ? <div className="set-disclosure-body">{children}</div> : null}
    </div>
  );
}

/** Pipeline status pill: Recording / Capture error / Starting, from live status. */
export function PipelinePill({ live }: { live: LiveStatus | null }) {
  if (!live) return null;
  const error = live.pipeline_error ?? null;
  const runningPipe = Boolean(live.pipeline_running);
  const tone = error ? "error" : runningPipe ? "rec" : "idle";
  return (
    <span className={`clipdip-pill ${tone}`} title={error ?? undefined}>
      <span className="clipdip-pill-dot" />
      {error ? "Capture error" : runningPipe ? "Recording" : "Starting"}
    </span>
  );
}

/** Process badge + pipeline pill for group headers across clipdip sections. */
export function ClipdipStatusBadge() {
  const { status, live, running } = useClipdip();
  return (
    <>
      {running ? <PipelinePill live={live} /> : null}
      <span className="set-badge" style={{ opacity: 0.9 }}>
        {status == null
          ? "Checking"
          : status.supported === false
            ? "Unsupported"
            : !status.binaryFound
              ? "Binary not found"
              : running
                ? "Running"
                : "Stopped"}
      </span>
    </>
  );
}
