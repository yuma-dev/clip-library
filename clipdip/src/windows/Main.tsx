import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { invoke, listen } from "@/lib/tauri";
import UpdateBanner from "@/components/UpdateBanner";
import {
  Plus, Trash2, ExternalLink,
  Film, Video, Mic, FolderOpen, Keyboard, Bell,
  Monitor, Cpu, Gauge, MousePointer2, Music2,
  KeyRound, Volume2, MapPin, Timer, Disc,
  Settings2, Sparkles, ChevronRight, ChevronLeft, Check, X,
  AlertTriangle, CircleCheck, RefreshCw, Headphones, Users,
  ShieldCheck, Upload,
} from "lucide-react";

// ---------- design tokens ---------------------------------------------------
// The overlay notification is the visual identity: charcoal card, violet
// comet body, magenta comet head, lavender-white tip. The settings UI
// borrows the same palette. Hex (not oklch) so the `${ACCENT}22`
// alpha-suffix pattern used throughout produces valid 8-digit hex colors.

const ACCENT = "#8b5cf6";      // violet — comet body
const ACCENT_DIM = "#6d44c9";  // deeper violet — gradient tails
const ACCENT_HOT = "#d844dd";  // magenta — comet head
const ACCENT_TIP = "#f3e8ff";  // lavender white — comet tip / highlights
const REC_ROSE = "#f43f5e";    // overlay recording dot

const MONO = '"Cascadia Mono", Consolas, "JetBrains Mono", ui-monospace, monospace';

// ---------- types -----------------------------------------------------------

interface AudioSource {
  kind: "system_loopback" | "microphone" | "process_loopback";
  device_id?: string;
}

type CodecPreference = "prefer_av1" | "force_h264" | "force_av1";

type RateControl =
  | { mode: "constant_qp"; qp: number }
  | { mode: "vbr"; avg_bps: number };

type RecordingQuality =
  | { mode: "match_clips" }
  | { mode: "constant_qp"; qp: number };

type CaptureBackend = "auto" | "wgc" | "dxgi";

interface Config {
  replay_seconds: number;
  video: {
    output_index: number;
    capture_backend: CaptureBackend;
    fps: number;
    bitrate_bps: number;
    include_cursor: boolean;
    gop_seconds: number;
    codec: CodecPreference;
    rate_control: RateControl;
    recording_quality: RecordingQuality;
  };
  audio: { sources: AudioSource[]; include_mix: boolean };
  output: {
    directory: string;
    filename_stem: string;
    ffmpeg_path: string | null;
    keep_sidecars: boolean;
    audio_bitrate_bps: number;
  };
  hotkey: { save_clip: string; rename_clip: string; toggle_recording: string };
  notifications: {
    enabled: boolean;
    sound: boolean;
    corner: string;
    auto_dismiss_secs: number;
  };
  metadata: {
    enabled: boolean;
    capture_icon: boolean;
    ignored_processes: string[];
  };
  discord: {
    enabled: boolean;
  };
}

interface MonitorInfo { index: number; name: string; width: number; height: number; }

interface AudioDeviceInfo {
  id: string;
  friendly_name: string;
  flow: "Render" | "Capture";
  is_default: boolean;
}

// ---------- tab definitions -------------------------------------------------

type TabId = "video" | "audio" | "output" | "hotkeys" | "notifications";

const TABS: { id: TabId; label: string; Icon: typeof Film }[] = [
  { id: "video",         label: "Video",         Icon: Video },
  { id: "audio",         label: "Audio",         Icon: Mic },
  { id: "output",        label: "Output",        Icon: FolderOpen },
  { id: "hotkeys",       label: "Hotkeys",       Icon: Keyboard },
  { id: "notifications", label: "Notifications", Icon: Bell },
];

// ---------- layout primitives -----------------------------------------------

function PanelHeader({
  Icon, title, subtitle,
}: { Icon: typeof Film; title: string; subtitle?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 24 }}>
      <div className="comet-tile" style={{
        width: 38, height: 38, borderRadius: 10,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: `linear-gradient(145deg, ${ACCENT}26, ${ACCENT_HOT}14), rgb(28,28,32)`,
        boxShadow: `0 8px 22px -10px ${ACCENT}66`,
        color: ACCENT_TIP,
        flexShrink: 0,
      }}>
        <Icon size={18} strokeWidth={1.8} />
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
        <h2 style={{
          margin: 0,
          font: "600 19px/1.1 Inter, sans-serif",
          color: "rgba(255,255,255,0.96)",
          letterSpacing: "-0.018em",
        }}>{title}</h2>
        {subtitle && (
          <p style={{
            margin: "5px 0 0",
            font: "400 12.5px/1.5 Inter, sans-serif",
            color: "rgba(255,255,255,0.5)",
            maxWidth: 580,
          }}>{subtitle}</p>
        )}
      </div>
    </div>
  );
}

function Row({
  Icon, label, hint, children, vertical, badge,
}: {
  Icon?: typeof Film;
  label: string;
  hint?: string;
  children: React.ReactNode;
  vertical?: boolean;
  badge?: string;
}) {
  // Each row is a miniature of the overlay card: charcoal surface, hairline
  // ring instead of a border, soft drop shadow, violet whisper on hover.
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        flexDirection: vertical ? "column" : "row",
        alignItems: vertical ? "stretch" : "center",
        gap: vertical ? 10 : 16,
        padding: "13px 15px",
        borderRadius: 10,
        background: hover ? "rgb(26,26,31)" : "rgb(23,23,28)",
        boxShadow: hover
          ? `0 0 0 1px rgba(255,255,255,0.08), 0 14px 28px -18px rgba(0,0,0,0.7), 0 0 24px -14px ${ACCENT}55`
          : "0 0 0 1px rgba(255,255,255,0.05), 0 10px 24px -18px rgba(0,0,0,0.6)",
        transition: "background .16s, box-shadow .16s",
      }}>
      <div style={{ flex: vertical ? "0 0 auto" : 1, minWidth: 0, display: "flex", alignItems: "flex-start", gap: 11 }}>
        {Icon && (
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, borderRadius: 6,
            background: hover ? `linear-gradient(145deg, ${ACCENT}26, ${ACCENT_HOT}12)` : "rgba(255,255,255,0.04)",
            color: hover ? ACCENT_TIP : "rgba(255,255,255,0.55)",
            flexShrink: 0,
            marginTop: 1,
            transition: "background .16s, color .16s",
          }}>
            <Icon size={12} strokeWidth={1.9} />
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              font: "500 13px/1.3 Inter, sans-serif",
              color: "rgba(255,255,255,0.92)",
              letterSpacing: "-0.005em",
            }}>{label}</div>
            {badge && (
              <span style={{
                font: '500 9px/1 "JetBrains Mono", monospace',
                color: "rgba(255,255,255,0.55)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                padding: "3px 5px",
                borderRadius: 3,
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.08)",
              }}>{badge}</span>
            )}
          </div>
          {hint && (
            <div style={{
              font: "400 11.5px/1.45 Inter, sans-serif",
              color: "rgba(255,255,255,0.42)",
              marginTop: 4,
              maxWidth: 440,
            }}>{hint}</div>
          )}
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: "30px 38px 38px",
      maxWidth: 880,
      margin: "0 auto",
      animation: "panel-in .28s cubic-bezier(.26,1,.42,1) both",
    }}>
      {children}
    </div>
  );
}

function PanelBody({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {children}
    </div>
  );
}

function AdvancedDisclosure({
  open, onToggle, children,
}: { open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <button
        onClick={onToggle}
        style={{
          display: "inline-flex", alignItems: "center", gap: 7,
          padding: "6px 10px",
          borderRadius: 6,
          background: "transparent",
          border: "1px solid rgba(255,255,255,0.06)",
          color: "rgba(255,255,255,0.55)",
          font: "500 11.5px/1 Inter, sans-serif",
          cursor: "pointer",
          transition: "all .12s",
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.035)";
          (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.8)";
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
          (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.55)";
        }}
      >
        <Settings2 size={11} />
        {open ? "Hide advanced" : "Show advanced"}
        <ChevronRight
          size={11}
          style={{ transform: open ? "rotate(90deg)" : "rotate(0)", transition: "transform .15s" }}
        />
      </button>
      {open && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ---------- design-style slider ---------------------------------------------

function DesignSlider({
  value, onChange, min, max, step = 1, format,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number; max: number; step?: number;
  format?: (v: number) => string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const display = format ? format(value) : String(value);
  return (
    <div style={{ width: 280, display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ flex: 1, position: "relative", height: 18, display: "flex", alignItems: "center" }}>
        <div style={{
          position: "absolute", left: 0, right: 0, height: 4,
          borderRadius: 2, background: "rgba(255,255,255,0.07)",
          border: "1px solid rgba(255,255,255,0.04)",
        }} />
        <div style={{
          position: "absolute", left: 0, width: `${pct}%`, height: 4,
          borderRadius: 2,
          background: `linear-gradient(90deg, ${ACCENT_DIM}, ${ACCENT} 70%, ${ACCENT_HOT})`,
          boxShadow: `0 0 10px ${ACCENT}66`,
        }} />
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          style={{
            position: "absolute", inset: 0, width: "100%",
            margin: 0, padding: 0, opacity: 0, cursor: "pointer",
          }}
        />
        <div style={{
          position: "absolute", left: `calc(${pct}% - 7px)`,
          width: 14, height: 14, borderRadius: 999,
          background: ACCENT_TIP,
          boxShadow: `0 0 0 1px rgba(0,0,0,0.4), 0 2px 6px rgba(0,0,0,0.5), 0 0 10px ${ACCENT}55`,
          pointerEvents: "none",
        }} />
      </div>
      <div style={{
        minWidth: 64, textAlign: "right",
        font: '500 11.5px/1 "JetBrains Mono", monospace',
        color: "rgba(255,255,255,0.88)",
        letterSpacing: "-0.005em",
        whiteSpace: "nowrap",
      }}>{display}</div>
    </div>
  );
}

// ---------- design-style toggle ---------------------------------------------

function DesignToggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => !disabled && onChange(!value)}
      aria-pressed={value}
      disabled={disabled}
      style={{
        width: 34, height: 20, padding: 2,
        borderRadius: 999, border: 0,
        background: value
          ? `linear-gradient(135deg, ${ACCENT}, ${ACCENT_HOT})`
          : "rgba(255,255,255,0.09)",
        boxShadow: value
          ? `0 0 14px ${ACCENT}66, inset 0 0 0 1px rgba(255,255,255,0.12)`
          : "inset 0 0 0 1px rgba(255,255,255,0.06)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        transition: "background .18s, box-shadow .18s",
        display: "block", position: "relative",
        flexShrink: 0,
      }}
    >
      <span style={{
        display: "block",
        width: 16, height: 16, borderRadius: 999,
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,0.35)",
        transform: value ? "translateX(14px)" : "translateX(0)",
        transition: "transform .18s cubic-bezier(.5,1.6,.4,1)",
      }} />
    </button>
  );
}

// ---------- design-style select ---------------------------------------------

function DesignSelect<T extends string | number>({
  value, onChange, options, width = 200,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; sub?: string }[];
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find(o => o.value === value) || options[0];
  return (
    <div style={{ position: "relative", width }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%", height: 32, padding: "0 10px 0 12px",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
          borderRadius: 7,
          background: "rgba(255,255,255,0.045)",
          border: "1px solid rgba(255,255,255,0.09)",
          font: "500 12px/1 Inter, sans-serif",
          color: "rgba(255,255,255,0.92)",
          cursor: "pointer", textAlign: "left",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current?.label}
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ flexShrink: 0, opacity: 0.55 }}>
          <path d="M2 4 L5 7 L8 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
          <div style={{
            position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4,
            background: "rgba(20,20,24,0.97)",
            backdropFilter: "blur(18px)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 7,
            boxShadow: "0 14px 36px rgba(0,0,0,0.5)",
            padding: 3, zIndex: 51,
            maxHeight: 280, overflowY: "auto",
          }}>
            {options.map(o => (
              <button
                key={String(o.value)}
                onClick={() => { onChange(o.value); setOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  width: "100%", padding: "8px 10px",
                  borderRadius: 5, border: 0,
                  background: o.value === value ? "rgba(255,255,255,0.06)" : "transparent",
                  font: "500 12px/1.2 Inter, sans-serif",
                  color: "rgba(255,255,255,0.9)",
                  cursor: "pointer", textAlign: "left",
                }}
                onMouseEnter={e => { if (o.value !== value) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
                onMouseLeave={e => { if (o.value !== value) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <span style={{
                  width: 4, height: 4, borderRadius: 999, flexShrink: 0,
                  background: o.value === value ? ACCENT : "transparent",
                }} />
                <span style={{ flex: 1 }}>
                  <span style={{ display: "block" }}>{o.label}</span>
                  {o.sub && (
                    <span style={{
                      display: "block",
                      font: "400 10.5px/1.2 Inter, sans-serif",
                      color: "rgba(255,255,255,0.42)",
                      marginTop: 2,
                    }}>{o.sub}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- design-style text input -----------------------------------------

function DesignTextInput({
  value, onChange, placeholder, mono = false, width = 280, trailing,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  width?: number;
  trailing?: React.ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{
      width,
      display: "flex", alignItems: "center", gap: 6,
      padding: "0 10px",
      height: 32,
      borderRadius: 7,
      background: "rgba(255,255,255,0.045)",
      border: `1px solid ${focused ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.09)"}`,
      boxShadow: focused ? `0 0 0 3px ${ACCENT}22` : "none",
      transition: "border-color .12s, box-shadow .12s",
    }}>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        spellCheck={false}
        style={{
          flex: 1, minWidth: 0,
          background: "transparent", border: 0, outline: 0, padding: 0, margin: 0,
          color: "rgba(255,255,255,0.92)",
          font: mono
            ? '500 11.5px/1 "JetBrains Mono", ui-monospace, monospace'
            : "500 12px/1 Inter, sans-serif",
        }}
      />
      {trailing}
    </div>
  );
}

// ---------- hotkey capture --------------------------------------------------

// Physical-key (`e.code`) → canonical token understood by the Rust parser
// (crates/hotkey parse_vk). Using `e.code` instead of `e.key` makes capture
// immune to Shift mutations ("Shift+1" used to record as "Shift+!") and to
// keyboard layouts. Only keys in this map can be recorded, so anything we
// save is guaranteed to register on the backend.
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
  if (e.ctrlKey)  mods.push("Ctrl");
  if (e.altKey)   mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey)  mods.push("Win");
  return mods;
}

function KeyChip({ children, ghost }: { children: React.ReactNode; ghost?: boolean }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: 22, height: 22, padding: "0 6px",
      borderRadius: 4,
      background: "rgba(255,255,255,0.07)",
      border: "1px solid rgba(255,255,255,0.1)",
      font: `500 11px/1 ${MONO}`,
      color: ghost ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.9)",
    }}>{children}</span>
  );
}

function HotkeyCapture({
  value, onChange, minWidth = 168,
}: { value: string; onChange: (v: string) => void; minWidth?: number }) {
  const [recording, setRecording] = useState(false);
  const [heldMods, setHeldMods] = useState<string[]>([]);
  const [rejected, setRejected] = useState(false);
  const rejectTimer = useRef<number | null>(null);
  const parts = value ? value.split("+").map(s => s.trim()).filter(Boolean) : [];

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

  useEffect(() => () => {
    if (rejectTimer.current) clearTimeout(rejectTimer.current);
  }, []);

  return (
    <button
      onClick={() => setRecording(!recording)}
      style={{
        height: 34, padding: "0 6px 0 10px",
        display: "flex", alignItems: "center", gap: 8,
        borderRadius: 8,
        background: recording ? "rgba(139,92,246,0.08)" : "rgba(255,255,255,0.045)",
        border: `1px solid ${rejected ? REC_ROSE + "aa" : recording ? ACCENT + "88" : "rgba(255,255,255,0.09)"}`,
        boxShadow: rejected
          ? `0 0 0 3px ${REC_ROSE}22`
          : recording ? `0 0 0 3px ${ACCENT}22, 0 0 18px ${ACCENT}33` : "none",
        cursor: "pointer",
        transition: "all .15s",
        minWidth,
      }}
    >
      {recording ? (
        rejected ? (
          <span style={{
            font: "500 11.5px/1 Inter, sans-serif",
            color: REC_ROSE,
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <AlertTriangle size={11} />
            Key not supported
          </span>
        ) : (
          <span style={{
            font: "500 11.5px/1 Inter, sans-serif",
            color: "rgba(255,255,255,0.78)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: 999,
              background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT_HOT})`,
              boxShadow: `0 0 8px ${ACCENT}aa`,
              animation: "pulse 1.2s infinite",
            }} />
            {heldMods.length ? (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {heldMods.map(mod => <KeyChip key={mod} ghost>{mod}</KeyChip>)}
                <span style={{ color: "rgba(255,255,255,0.35)" }}>+ …</span>
              </span>
            ) : "Press keys…"}
          </span>
        )
      ) : (
        <span style={{ display: "flex", alignItems: "center", gap: 3, flex: 1 }}>
          {parts.map((p, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 3 }}>
              {i > 0 && <span style={{ color: "rgba(255,255,255,0.3)", font: "500 11px/1 Inter, sans-serif" }}>+</span>}
              <KeyChip>{p}</KeyChip>
            </span>
          ))}
          {!parts.length && (
            <span style={{ font: "500 11.5px/1 Inter, sans-serif", color: "rgba(255,255,255,0.4)" }}>Not set</span>
          )}
        </span>
      )}
      <span style={{
        marginLeft: "auto",
        width: 22, height: 22, borderRadius: 4,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        color: recording ? ACCENT_TIP : "rgba(255,255,255,0.45)",
      }}>
        <KeyRound size={11} />
      </span>
    </button>
  );
}

// ---------- corner picker ---------------------------------------------------

function CornerPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const corners = [
    { value: "top_left",     x: 0, y: 0 },
    { value: "top_right",    x: 1, y: 0 },
    { value: "bottom_left",  x: 0, y: 1 },
    { value: "bottom_right", x: 1, y: 1 },
  ];
  return (
    <div style={{
      width: 96, height: 60, borderRadius: 6,
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.08)",
      position: "relative", padding: 6,
    }}>
      {corners.map(c => {
        const active = c.value === value;
        return (
          <button
            key={c.value}
            onClick={() => onChange(c.value)}
            title={c.value.replace("_", " ")}
            style={{
              position: "absolute",
              top:    c.y === 0 ? 6 : "auto",
              bottom: c.y === 1 ? 6 : "auto",
              left:   c.x === 0 ? 6 : "auto",
              right:  c.x === 1 ? 6 : "auto",
              width: 24, height: 14, padding: 0, border: 0, borderRadius: 2,
              background: active ? `linear-gradient(135deg, ${ACCENT}, ${ACCENT_HOT})` : "rgba(255,255,255,0.07)",
              boxShadow: active ? `0 0 10px ${ACCENT}77, inset 0 0 0 1px rgba(255,255,255,0.2)` : "inset 0 0 0 1px rgba(255,255,255,0.04)",
              cursor: "pointer", transition: "all .12s",
            }}
          />
        );
      })}
    </div>
  );
}

// ---------- title bar -------------------------------------------------------

function TitleBar({
  saveStatus, onReplayOnboarding,
}: {
  saveStatus: "idle" | "saving" | "saved" | "error";
  onReplayOnboarding: () => void;
}) {
  const winAction = async (action: "minimize" | "maximize" | "close") => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (action === "minimize") win.minimize();
      else if (action === "maximize") win.toggleMaximize();
      else win.close();
    } catch { /* no-op in browser */ }
  };

  return (
    <div style={{
      height: 36, flexShrink: 0,
      display: "flex", alignItems: "center",
      borderBottom: "1px solid rgba(255,255,255,0.04)",
    }}>
      {/* Logo */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "0 14px",
        pointerEvents: "none",
      }}>
        <img src="/logo250x250.png" width="16" height="16" draggable={false}
          style={{ imageRendering: "auto", filter: `drop-shadow(0 0 6px ${ACCENT}66)` }} />
        <span style={{
          font: "600 12px/1 Inter, sans-serif",
          color: "rgba(255,255,255,0.78)",
          letterSpacing: "0.01em",
        }}>ClipDip</span>
      </div>

      {/* Drag region */}
      <div data-tauri-drag-region style={{ flex: 1, height: "100%" }} />

      {/* Autosave status */}
      {saveStatus !== "idle" && (
        <div style={{
          font: "500 11px/1 Inter, sans-serif",
          color: saveStatus === "error" ? "#ef4444"
               : saveStatus === "saved" ? "#d8b4fe"
               : "rgba(255,255,255,0.5)",
          display: "flex", alignItems: "center", gap: 5,
          marginRight: 12,
          transition: "color .15s, opacity .15s",
        }}>
          {saveStatus === "saving" && <span style={{ width: 6, height: 6, borderRadius: 999, background: "rgba(255,255,255,0.5)" }} />}
          {saveStatus === "saved"  && <Check size={11} />}
          {saveStatus === "error"  && <AlertTriangle size={11} />}
          {saveStatus === "saving" ? "Saving…"
           : saveStatus === "saved" ? "Saved"
           : "Save failed"}
        </div>
      )}

      {/* Replay onboarding */}
      <button
        onClick={onReplayOnboarding}
        title="Run setup again"
        style={{
          height: 24, padding: "0 9px", marginRight: 8,
          display: "inline-flex", alignItems: "center", gap: 5,
          borderRadius: 5, border: 0,
          background: "rgba(255,255,255,0.045)",
          color: "rgba(255,255,255,0.7)",
          font: "500 11px/1 Inter, sans-serif",
          cursor: "pointer",
          transition: "background .12s, color .12s",
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.09)";
          (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.95)";
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.045)";
          (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.7)";
        }}
      >
        <Sparkles size={11} />
        Setup
      </button>

      {/* Window controls */}
      <div style={{ display: "flex" }}>
        {([
          { id: "minimize", d: "M2 6 L10 6" },
          { id: "maximize", d: "M2 2 L10 2 L10 10 L2 10 Z" },
          { id: "close",    d: "M2 2 L10 10 M2 10 L10 2" },
        ] as { id: "minimize" | "maximize" | "close"; d: string }[]).map(b => (
          <button
            key={b.id}
            onClick={() => winAction(b.id)}
            style={{
              width: 44, height: 36, border: 0,
              background: "transparent", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "rgba(255,255,255,0.5)",
              transition: "background .1s, color .1s",
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background =
                b.id === "close" ? "rgba(232,17,35,0.9)" : "rgba(255,255,255,0.06)";
              (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.9)";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
              (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.5)";
            }}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d={b.d} stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- top tab bar -----------------------------------------------------

function TopTabs({
  active, onChange, pipelineError, pipelineRunning,
}: {
  active: TabId;
  onChange: (id: TabId) => void;
  pipelineError: string | null;
  pipelineRunning: boolean;
}) {
  return (
    <div style={{
      flexShrink: 0,
      display: "flex", alignItems: "center",
      padding: "10px 14px 0",
      borderBottom: "1px solid rgba(255,255,255,0.04)",
      background: "rgba(0,0,0,0.18)",
      gap: 4,
    }}>
      {TABS.map(t => {
        const isActive = t.id === active;
        const Icon = t.Icon;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              position: "relative",
              display: "inline-flex", alignItems: "center", gap: 7,
              padding: "9px 13px 11px",
              border: 0, background: "transparent",
              marginBottom: -1,
              cursor: "pointer",
              color: isActive ? "rgba(255,255,255,0.96)" : "rgba(255,255,255,0.55)",
              font: `${isActive ? 600 : 500} 12.5px/1 Inter, sans-serif`,
              letterSpacing: "-0.005em",
              transition: "color .12s",
            }}
            onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.82)"; }}
            onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.55)"; }}
          >
            <Icon size={14} strokeWidth={isActive ? 2.1 : 1.8}
              style={{ color: isActive ? ACCENT_TIP : undefined, transition: "color .12s" }} />
            {t.label}
            {/* Comet-trail underline: violet tail fading into magenta head */}
            <span style={{
              position: "absolute", left: 10, right: 10, bottom: 0, height: 2,
              borderRadius: 2,
              background: `linear-gradient(90deg, ${ACCENT}00, ${ACCENT} 35%, ${ACCENT_HOT})`,
              boxShadow: `0 0 8px ${ACCENT}aa`,
              opacity: isActive ? 1 : 0,
              transform: isActive ? "scaleX(1)" : "scaleX(0.4)",
              transformOrigin: "center",
              transition: "opacity .18s, transform .22s cubic-bezier(.26,1.25,.42,1)",
              pointerEvents: "none",
            }} />
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      {/* Pipeline status pill — the rose dot mirrors the overlay's
          recording indicator, so "capture is live" reads the same in
          both surfaces. */}
      <div style={{
        marginBottom: 8,
        padding: "5px 10px",
        borderRadius: 999,
        background: pipelineError
          ? "rgba(239,68,68,0.1)"
          : pipelineRunning
          ? `${REC_ROSE}14`
          : "rgba(255,255,255,0.03)",
        border: `1px solid ${pipelineError ? "rgba(239,68,68,0.22)" : pipelineRunning ? `${REC_ROSE}33` : "rgba(255,255,255,0.06)"}`,
        display: "flex", alignItems: "center", gap: 7,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: 999, flexShrink: 0,
          background: pipelineError ? "#ef4444" : pipelineRunning ? REC_ROSE : "rgba(255,255,255,0.3)",
          boxShadow: pipelineRunning && !pipelineError ? `0 0 7px ${REC_ROSE}cc` : "none",
          animation: pipelineRunning && !pipelineError ? "pulse 2s infinite" : "none",
        }} />
        <span style={{
          font: "500 10.5px/1 Inter, sans-serif",
          color: pipelineError ? "#ef4444" : pipelineRunning ? REC_ROSE : "rgba(255,255,255,0.5)",
        }}>
          {pipelineError ? "Capture error" : pipelineRunning ? "Recording" : "Starting…"}
        </span>
      </div>
    </div>
  );
}

// ---------- audio sources ---------------------------------------------------

function audioKindIcon(k: AudioSource["kind"]) {
  if (k === "microphone") return Mic;
  if (k === "process_loopback") return Cpu;
  return Volume2;
}

const DEFAULT_DEVICE_VALUE = "__default__";

function deviceOptionsFor(
  kind: AudioSource["kind"],
  devices: AudioDeviceInfo[],
): { value: string; label: string; sub?: string }[] {
  if (kind === "process_loopback") return [];
  const flow = kind === "microphone" ? "Capture" : "Render";
  const filtered = devices.filter(d => d.flow === flow);
  const def = filtered.find(d => d.is_default);
  return [
    {
      value: DEFAULT_DEVICE_VALUE,
      label: "System default",
      sub: def ? `Currently: ${def.friendly_name}` : "Follows Windows default",
    },
    ...filtered.map(d => ({
      value: d.id,
      label: d.friendly_name,
      sub: d.is_default ? "Default" : undefined,
    })),
  ];
}

function AudioSourcesList({
  sources, setSources, devices, devicesLoading, onRefreshDevices,
}: {
  sources: AudioSource[];
  setSources: (s: AudioSource[]) => void;
  devices: AudioDeviceInfo[];
  devicesLoading: boolean;
  onRefreshDevices: () => void;
}) {
  const update = (idx: number, patch: Partial<AudioSource>) =>
    setSources(sources.map((s, i) => i === idx ? { ...s, ...patch } : s));
  const remove = (idx: number) => setSources(sources.filter((_, i) => i !== idx));
  const add = (kind: AudioSource["kind"]) => setSources([...sources, { kind }]);

  const kindOptions: { value: AudioSource["kind"]; label: string; sub?: string }[] = [
    { value: "system_loopback",  label: "System output", sub: "Game audio, music, calls" },
    { value: "microphone",       label: "Microphone",    sub: "Your voice" },
    { value: "process_loopback", label: "Process loopback", sub: "Audio from one specific app" },
  ];

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sources.map((src, i) => {
          const KindIcon = audioKindIcon(src.kind);
          const devOpts = deviceOptionsFor(src.kind, devices);
          const selectedDeviceValue = src.device_id ?? DEFAULT_DEVICE_VALUE;
          // If the saved device_id no longer exists in enumeration, surface it
          // so the user can see what's selected even if disconnected.
          const knownDevice = devices.find(d => d.id === src.device_id);
          const showStaleWarning =
            src.kind !== "process_loopback" &&
            !!src.device_id &&
            !knownDevice &&
            !devicesLoading;

          return (
            <div key={i} style={{
              display: "flex", flexDirection: "column", gap: 8,
              padding: "10px 10px 12px 12px",
              borderRadius: 9,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.055)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 26, height: 26, borderRadius: 6,
                  background: `${ACCENT}1f`,
                  color: ACCENT,
                  flexShrink: 0,
                }}>
                  <KindIcon size={13} strokeWidth={1.9} />
                </span>
                <DesignSelect<AudioSource["kind"]>
                  value={src.kind}
                  onChange={kind => update(i, { kind, device_id: undefined })}
                  options={kindOptions}
                  width={200}
                />
                <span style={{
                  font: '500 9px/1 "JetBrains Mono", monospace',
                  color: "rgba(255,255,255,0.45)",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  padding: "3px 5px",
                  borderRadius: 3,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.07)",
                }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => remove(i)}
                  title="Remove"
                  style={{
                    width: 30, height: 30, borderRadius: 6,
                    border: 0, background: "transparent", cursor: "pointer",
                    color: "rgba(255,255,255,0.4)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLElement).style.background = "rgba(255,80,80,0.12)";
                    (e.currentTarget as HTMLElement).style.color = "oklch(0.7 0.18 25)";
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                    (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.4)";
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>

              {src.kind !== "process_loopback" && (
                <div style={{ display: "flex", alignItems: "center", gap: 9, paddingLeft: 36 }}>
                  <Headphones size={11} color="rgba(255,255,255,0.4)" />
                  <span style={{
                    font: "500 11px/1 Inter, sans-serif",
                    color: "rgba(255,255,255,0.5)",
                  }}>Device</span>
                  <DesignSelect<string>
                    value={selectedDeviceValue}
                    onChange={v => update(i, { device_id: v === DEFAULT_DEVICE_VALUE ? undefined : v })}
                    options={
                      showStaleWarning
                        ? [
                            ...devOpts,
                            {
                              value: src.device_id!,
                              label: "(disconnected device)",
                              sub: src.device_id,
                            },
                          ]
                        : devOpts
                    }
                    width={280}
                  />
                  {showStaleWarning && (
                    <span title="Device not currently connected" style={{ display: "inline-flex", color: "#f59e0b" }}>
                      <AlertTriangle size={12} />
                    </span>
                  )}
                </div>
              )}

              {src.kind === "process_loopback" && (
                <div style={{
                  paddingLeft: 36,
                  font: "400 11px/1.4 Inter, sans-serif",
                  color: "rgba(255,255,255,0.42)",
                }}>
                  Process-specific capture targets the focused game window. No device pick needed.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add row */}
      <div style={{
        marginTop: 12,
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
      }}>
        {([
          { kind: "system_loopback", label: "Add system output", Icon: Volume2 },
          { kind: "microphone",      label: "Add microphone",    Icon: Mic },
        ] as { kind: AudioSource["kind"]; label: string; Icon: typeof Mic }[]).map(b => (
          <button
            key={b.kind}
            onClick={() => add(b.kind)}
            style={{
              padding: "8px 12px",
              display: "inline-flex", alignItems: "center", gap: 6,
              borderRadius: 7,
              background: "rgba(255,255,255,0.04)",
              border: "1px dashed rgba(255,255,255,0.14)",
              color: "rgba(255,255,255,0.78)",
              font: "500 11.5px/1 Inter, sans-serif",
              cursor: "pointer",
              transition: "all .12s",
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.07)";
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.22)";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.14)";
            }}
          >
            <Plus size={11} />
            <b.Icon size={11} />
            {b.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          onClick={onRefreshDevices}
          disabled={devicesLoading}
          title="Re-scan audio devices"
          style={{
            padding: "8px 11px",
            display: "inline-flex", alignItems: "center", gap: 6,
            borderRadius: 7,
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.07)",
            color: "rgba(255,255,255,0.55)",
            font: "500 11.5px/1 Inter, sans-serif",
            cursor: devicesLoading ? "wait" : "pointer",
            opacity: devicesLoading ? 0.5 : 1,
          }}
        >
          <RefreshCw size={11} style={{
            animation: devicesLoading ? "spin 1s linear infinite" : "none",
          }} />
          Refresh
        </button>
      </div>
    </div>
  );
}

// ---------- onboarding modal ------------------------------------------------

const ONBOARDING_KEY = "clipdip.onboarded.v1";

function OnboardingModal({
  config, setConfig, monitors, devices, devicesLoading, onRefreshDevices, onClose,
}: {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
  monitors: MonitorInfo[];
  devices: AudioDeviceInfo[];
  devicesLoading: boolean;
  onRefreshDevices: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const steps = [
    { id: "monitor", title: "Pick your display",   Icon: Monitor,    blurb: "Which screen do you want ClipDip to capture? Multi-monitor setups capture one at a time." },
    { id: "hotkey",  title: "Set your save key",   Icon: Keyboard,   blurb: "When you press this, the last few seconds of gameplay are written to disk. Use something rare so it doesn't clash with in-game keys." },
    { id: "folder",  title: "Where do clips go?",  Icon: FolderOpen, blurb: "Pick a folder you'll actually find later. You can always change this." },
    { id: "audio",   title: "What sound to record?", Icon: Mic,      blurb: "Mix any number of sources. Most people want both: the game's audio plus their mic." },
    { id: "discord", title: "Connect Discord",     Icon: Users,      blurb: "Save who you were in a call with, on every clip. One-time connect — approve the popup in Discord. Optional; skip if you don't want it." },
  ];
  const cur = steps[step];
  const isLast = step === steps.length - 1;

  // Live Discord connection status for the connect step.
  const [discordStatus, setDiscordStatus] = useState<DiscordStatus | null>(null);
  const [discordBusy, setDiscordBusy] = useState(false);
  useEffect(() => {
    const refresh = () => invoke<DiscordStatus>("discord_status").then(setDiscordStatus).catch(() => {});
    refresh();
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, []);
  const connectDiscord = async () => {
    setDiscordBusy(true);
    try { await invoke("discord_connect"); } catch (e) { console.error("discord_connect:", e); }
    finally { setDiscordBusy(false); }
  };

  const patchVideo = (k: keyof Config["video"], v: unknown) =>
    setConfig(prev => prev ? { ...prev, video: { ...prev.video, [k]: v } } : prev);
  const patchOutput = (k: keyof Config["output"], v: unknown) =>
    setConfig(prev => prev ? { ...prev, output: { ...prev.output, [k]: v } } : prev);
  const patchHotkey = (k: keyof Config["hotkey"], v: string) =>
    setConfig(prev => prev ? { ...prev, hotkey: { ...prev.hotkey, [k]: v } } : prev);
  const setSources = (srcs: AudioSource[]) =>
    setConfig(prev => prev ? { ...prev, audio: { ...prev.audio, sources: srcs } } : prev);

  const finish = () => {
    try { localStorage.setItem(ONBOARDING_KEY, "1"); } catch { /* private mode */ }
    onClose();
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(0,0,0,0.55)",
      backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 32,
      animation: "fadeIn .15s ease-out",
    }}>
      <div style={{
        width: 560, maxHeight: "calc(100% - 32px)",
        display: "flex", flexDirection: "column",
        background: "rgba(18,18,22,0.98)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 14,
        boxShadow: "0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.02)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          padding: "20px 22px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
          display: "flex", alignItems: "center", gap: 14,
        }}>
          <div style={{
            width: 42, height: 42, borderRadius: 10,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: `linear-gradient(135deg, ${ACCENT}33, ${ACCENT_DIM}18)`,
            border: `1px solid ${ACCENT}44`,
            color: ACCENT,
            flexShrink: 0,
          }}>
            <cur.Icon size={20} strokeWidth={1.8} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              font: '500 10.5px/1 "JetBrains Mono", monospace',
              color: "rgba(255,255,255,0.36)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 5,
            }}>
              Step {step + 1} of {steps.length}
            </div>
            <div style={{
              font: "600 17px/1.2 Inter, sans-serif",
              color: "rgba(255,255,255,0.96)",
              letterSpacing: "-0.015em",
            }}>{cur.title}</div>
          </div>
          <button
            onClick={finish}
            title="Skip setup"
            style={{
              width: 28, height: 28, borderRadius: 6,
              border: 0, background: "transparent", cursor: "pointer",
              color: "rgba(255,255,255,0.45)",
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "background .12s, color .12s",
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)";
              (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.9)";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
              (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.45)";
            }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 22px 4px", overflowY: "auto" }}>
          <p style={{
            margin: "0 0 18px",
            font: "400 13px/1.5 Inter, sans-serif",
            color: "rgba(255,255,255,0.6)",
          }}>{cur.blurb}</p>

          {cur.id === "monitor" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(monitors.length ? monitors : [{ index: 0, name: "Primary display", width: 1920, height: 1080 }]).map(m => {
                const isActive = config.video.output_index === m.index;
                return (
                  <button
                    key={m.index}
                    onClick={() => patchVideo("output_index", m.index)}
                    style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "12px 14px",
                      borderRadius: 9,
                      border: `1px solid ${isActive ? ACCENT + "66" : "rgba(255,255,255,0.08)"}`,
                      background: isActive ? `${ACCENT}14` : "rgba(255,255,255,0.025)",
                      boxShadow: isActive ? `0 0 0 3px ${ACCENT}22` : "none",
                      cursor: "pointer", textAlign: "left",
                      transition: "all .12s",
                    }}
                  >
                    <Monitor size={18} color={isActive ? ACCENT : "rgba(255,255,255,0.5)"} strokeWidth={1.8} />
                    <div style={{ flex: 1 }}>
                      <div style={{
                        font: "600 13px/1.2 Inter, sans-serif",
                        color: "rgba(255,255,255,0.95)",
                      }}>
                        Display {m.index + 1}{m.index === 0 ? " · primary" : ""}
                      </div>
                      <div style={{
                        font: '400 11px/1 "JetBrains Mono", monospace',
                        color: "rgba(255,255,255,0.42)",
                        marginTop: 4,
                      }}>
                        {m.width} × {m.height}{m.name ? ` · ${m.name}` : ""}
                      </div>
                    </div>
                    {isActive && <CircleCheck size={16} color={ACCENT} />}
                  </button>
                );
              })}
            </div>
          )}

          {cur.id === "hotkey" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{
                padding: "14px 16px",
                borderRadius: 9,
                background: "rgba(255,255,255,0.025)",
                border: "1px solid rgba(255,255,255,0.05)",
                display: "flex", alignItems: "center", gap: 14,
              }}>
                <span style={{
                  font: "500 13px/1.2 Inter, sans-serif",
                  color: "rgba(255,255,255,0.85)",
                  flex: 1,
                }}>Save clip</span>
                <HotkeyCapture
                  value={config.hotkey.save_clip}
                  onChange={v => patchHotkey("save_clip", v)}
                  minWidth={180}
                />
              </div>
              <div style={{
                padding: "10px 12px",
                borderRadius: 7,
                background: "rgba(245,158,11,0.07)",
                border: "1px solid rgba(245,158,11,0.18)",
                display: "flex", gap: 9,
                font: "400 11.5px/1.45 Inter, sans-serif",
                color: "rgba(255,255,255,0.7)",
              }}>
                <AlertTriangle size={13} color="#f59e0b" style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  Avoid common combos like Ctrl+Shift+S — games hijack those.
                  Ctrl+Alt+F-keys are the safest bets.
                </span>
              </div>
            </div>
          )}

          {cur.id === "folder" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <DesignTextInput
                value={config.output.directory}
                onChange={v => patchOutput("directory", v)}
                placeholder="C:\Users\You\Videos\Clipdip"
                mono
                width={"100%" as unknown as number}
              />
              <button
                onClick={() => invoke("open_clips_folder")}
                style={{
                  alignSelf: "flex-start",
                  padding: "7px 11px",
                  display: "inline-flex", alignItems: "center", gap: 6,
                  borderRadius: 6,
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "rgba(255,255,255,0.85)",
                  font: "500 11.5px/1 Inter, sans-serif",
                  cursor: "pointer",
                }}
              >
                <ExternalLink size={11} />
                Open folder
              </button>
            </div>
          )}

          {cur.id === "audio" && (
            <AudioSourcesList
              sources={config.audio.sources}
              setSources={setSources}
              devices={devices}
              devicesLoading={devicesLoading}
              onRefreshDevices={onRefreshDevices}
            />
          )}

          {cur.id === "discord" && (() => {
            const st = discordStatus?.state;
            const featureOff = st === "disabled";
            const connected = st === "connected";
            const statusText =
              st === "connected" ? `Connected as ${discordStatus?.user ?? "?"}`
              : st === "connecting" ? "Connecting… approve the popup in Discord"
              : st === "discord_not_running" ? "Discord isn't running"
              : st === "needs_authorization" ? "Not connected yet"
              : st === "error" ? "Connection error — try again"
              : featureOff ? "Unavailable in this build"
              : "Checking…";
            return (
              <div style={{
                padding: "16px 16px",
                borderRadius: 10,
                background: "rgba(255,255,255,0.025)",
                border: `1px solid ${connected ? "rgba(120,220,150,0.35)" : "rgba(255,255,255,0.07)"}`,
                display: "flex", alignItems: "center", gap: 14,
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 9, flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: connected ? "rgba(120,220,150,0.14)" : "rgba(255,255,255,0.04)",
                  color: connected ? "rgb(120,220,150)" : "rgba(255,255,255,0.5)",
                }}>
                  {connected ? <CircleCheck size={20} /> : <Users size={20} strokeWidth={1.8} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ font: "600 13px/1.2 Inter, sans-serif", color: "rgba(255,255,255,0.92)" }}>
                    {connected ? "Discord connected" : "Discord"}
                  </div>
                  <div style={{ font: "400 11.5px/1.3 Inter, sans-serif", color: "rgba(255,255,255,0.5)", marginTop: 4 }}>
                    {statusText}
                  </div>
                </div>
                {!featureOff && !connected && (
                  <button
                    onClick={connectDiscord}
                    disabled={discordBusy}
                    style={{
                      padding: "9px 16px", borderRadius: 7, border: 0, flexShrink: 0,
                      background: `linear-gradient(180deg, ${ACCENT}, ${ACCENT_DIM})`,
                      color: "#0a1416", font: "600 12px/1 Inter, sans-serif",
                      cursor: discordBusy ? "default" : "pointer", opacity: discordBusy ? 0.6 : 1,
                    }}
                  >
                    {discordBusy ? "…" : "Connect"}
                  </button>
                )}
              </div>
            );
          })()}
        </div>

        {/* Step dots */}
        <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "16px 0 4px" }}>
          {steps.map((_, i) => (
            <span key={i} style={{
              width: i === step ? 18 : 6, height: 6, borderRadius: 999,
              background: i === step ? ACCENT : i < step ? `${ACCENT}55` : "rgba(255,255,255,0.12)",
              transition: "all .18s",
            }} />
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: "14px 18px 18px",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <button
            onClick={finish}
            style={{
              padding: "9px 14px",
              border: 0, background: "transparent", cursor: "pointer",
              color: "rgba(255,255,255,0.5)",
              font: "500 12px/1 Inter, sans-serif",
              borderRadius: 6,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.85)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.5)"; }}
          >
            Skip
          </button>
          <div style={{ flex: 1 }} />
          {step > 0 && (
            <button
              onClick={() => setStep(s => s - 1)}
              style={{
                padding: "9px 12px",
                display: "inline-flex", alignItems: "center", gap: 5,
                borderRadius: 7,
                background: "rgba(255,255,255,0.045)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "rgba(255,255,255,0.85)",
                font: "500 12px/1 Inter, sans-serif",
                cursor: "pointer",
              }}
            >
              <ChevronLeft size={13} />
              Back
            </button>
          )}
          <button
            onClick={() => isLast ? finish() : setStep(s => s + 1)}
            style={{
              padding: "10px 16px",
              display: "inline-flex", alignItems: "center", gap: 6,
              borderRadius: 7,
              background: `linear-gradient(180deg, ${ACCENT}, ${ACCENT_DIM})`,
              border: 0,
              color: "#0a1416",
              font: "600 12.5px/1 Inter, sans-serif",
              cursor: "pointer",
              boxShadow: `0 4px 16px ${ACCENT}33`,
            }}
          >
            {isLast ? <>Finish <Check size={13} /></> : <>Next <ChevronRight size={13} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- panel: recording ------------------------------------------------

// ---------- panel: video ----------------------------------------------------

// Named quality presets over the encoder's QP. The +6-QP-halves-size rule
// of thumb makes the steps roughly 25% / 50% / 100% / 160% of the default.
// QP is on the H.264 0–51 scale; the encoder matches AV1 internally.
const QUALITY_PRESETS = [
  { qp: 32, label: "Space saver",  desc: "Visibly compressed — roughly a quarter of High quality's file size." },
  { qp: 26, label: "Balanced",     desc: "Looks great in motion at about half of High quality's file size." },
  { qp: 20, label: "High quality", desc: "Crisp, clean picture — the default." },
  { qp: 16, label: "Maximum",      desc: "Near-perfect picture. Files get large." },
];

// Quality used while a manual recording (start/stop hotkey) is running.
// Recordings are meant to be kept and uploaded, so they get their own —
// typically higher — quality than the always-on replay buffer. qp: null
// means "match clips" (no boost).
const RECORDING_PRESETS: { qp: number | null; label: string; desc: string }[] = [
  { qp: null, label: "Match clips",   desc: "Recordings use the same quality as replay clips." },
  { qp: 16,   label: "High",          desc: "Noticeably crisper than clips with a modest size bump." },
  { qp: 14,   label: "Studio",        desc: "About twice the clip bitrate — clean enough to master a YouTube upload from. The default." },
  { qp: 12,   label: "Near-lossless", desc: "Practically indistinguishable from the source. Files get very large on long recordings." },
];

type BufferStats = {
  measuring: boolean;
  mb_per_minute: number;
  clip_mb: number;
  buffered_secs: number;
};

/// Live file-size readout, measured from the actual encoded bytes in the
/// replay ring — honest numbers that track whatever is on screen right now.
function SizeEstimate({ replaySeconds }: { replaySeconds: number }) {
  const [stats, setStats] = useState<BufferStats | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      invoke<BufferStats>("get_buffer_stats")
        .then(s => { if (alive) setStats(s); })
        .catch(() => { if (alive) setStats(null); });
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const fmt = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));

  return (
    <div style={{
      marginTop: 2,
      padding: "10px 12px",
      borderRadius: 10,
      background: "rgb(20,20,25)",
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.045)",
      display: "flex", gap: 9, alignItems: "flex-start",
      font: "400 11.5px/1.45 Inter, sans-serif",
      color: "rgba(255,255,255,0.62)",
    }}>
      <Gauge size={13} style={{ flexShrink: 0, marginTop: 1, color: ACCENT_TIP + "99" }} />
      {stats?.measuring ? (
        <span>
          At current screen activity: ≈{" "}
          <b style={{ color: "rgba(255,255,255,0.85)", fontWeight: 600 }}>
            {fmt(stats.mb_per_minute)} MB per minute
          </b>
          {" "}— a {replaySeconds} s clip ≈{" "}
          <b style={{ color: "rgba(255,255,255,0.85)", fontWeight: 600 }}>
            {fmt(stats.clip_mb)} MB
          </b>
          . Quality changes apply right away (the replay buffer restarts and refills).
        </span>
      ) : (
        <span>Measuring clip size from the live buffer…</span>
      )}
    </div>
  );
}

function VideoPanel({
  config, patch, patchVideo, monitors, advanced, setAdvanced,
}: {
  config: Config;
  patch: <K extends keyof Config>(k: K, v: Config[K]) => void;
  patchVideo: (k: keyof Config["video"], v: unknown) => void;
  monitors: MonitorInfo[];
  advanced: boolean;
  setAdvanced: (v: boolean) => void;
}) {
  const monitorOptions = useMemo(() => {
    if (!monitors.length) return [
      { value: 0, label: "Display 1 · primary" },
      { value: 1, label: "Display 2" },
      { value: 2, label: "Display 3" },
    ];
    return monitors.map(m => ({
      value: m.index,
      label: `Display ${m.index + 1}${m.index === 0 ? " · primary" : ""}`,
      sub: `${m.width} × ${m.height}`,
    }));
  }, [monitors]);

  // Which preset the current config corresponds to; -1 = custom (VBR mode
  // or a QP that doesn't match any preset, e.g. set via Advanced).
  const presetIdx = config.video.rate_control.mode === "constant_qp"
    ? QUALITY_PRESETS.findIndex(p => p.qp === (config.video.rate_control as { mode: "constant_qp"; qp: number }).qp)
    : -1;

  // Which recording-quality preset is active; -1 = custom QP set via Advanced.
  const recPresetIdx = config.video.recording_quality.mode === "match_clips"
    ? 0
    : RECORDING_PRESETS.findIndex(p => p.qp === (config.video.recording_quality as { mode: "constant_qp"; qp: number }).qp);

  return (
    <PanelShell>
      <PanelHeader Icon={Video} title="Video" subtitle="ClipDip keeps a rolling buffer of recent gameplay. Tune what gets captured and how heavy the file is." />
      <PanelBody>
        <Row Icon={Timer} label="Replay buffer" hint="The longest clip you can save. Larger buffers use more memory.">
          <DesignSlider
            value={config.replay_seconds}
            onChange={v => patch("replay_seconds", v)}
            min={10} max={300} step={5}
            format={v => `${v} s`}
          />
        </Row>
        <Row Icon={Monitor} label="Monitor" hint="Pick the display to capture. Multi-monitor setups capture one at a time.">
          <DesignSelect<number>
            value={config.video.output_index}
            onChange={v => patchVideo("output_index", v)}
            options={monitorOptions}
            width={240}
          />
        </Row>
        <Row Icon={Gauge} label="Frame rate" hint="Higher is smoother but produces larger files.">
          <DesignSlider
            value={config.video.fps}
            onChange={v => patchVideo("fps", v)}
            min={30} max={240} step={1}
            format={v => `${v} fps`}
          />
        </Row>
        <Row Icon={Cpu} label="Codec" hint="AV1 needs an RTX 40-series GPU or newer. ‘Prefer AV1’ uses it when available and silently falls back to H.264.">
          <DesignSelect<CodecPreference>
            value={config.video.codec}
            onChange={v => patchVideo("codec", v)}
            options={[
              { value: "prefer_av1", label: "Prefer AV1", sub: "Falls back to H.264 if unsupported" },
              { value: "force_h264", label: "H.264",      sub: "Widest compatibility" },
              { value: "force_av1",  label: "AV1 only",   sub: "Requires RTX 40+ / Arc" },
            ]}
            width={240}
          />
        </Row>
        <Row
          Icon={Sparkles}
          label="Quality & size"
          hint={presetIdx === -1
            ? "Custom encoder settings are active (see Advanced). Moving this slider replaces them with a preset."
            : QUALITY_PRESETS[presetIdx].desc}
        >
          <DesignSlider
            value={presetIdx === -1 ? 2 : presetIdx}
            onChange={i => patchVideo("rate_control", { mode: "constant_qp", qp: QUALITY_PRESETS[i].qp })}
            min={0} max={QUALITY_PRESETS.length - 1} step={1}
            format={i => (presetIdx === -1 ? "Custom" : QUALITY_PRESETS[i]?.label ?? "Custom")}
          />
        </Row>
        <Row
          Icon={Disc}
          label="Recording quality"
          hint={config.video.rate_control.mode !== "constant_qp"
            ? "Only applies in Constant quality mode — variable bitrate can't be boosted mid-session."
            : recPresetIdx === -1
              ? "A custom recording QP is active (see Advanced). Moving this slider replaces it with a preset."
              : RECORDING_PRESETS[recPresetIdx].desc}
        >
          <DesignSlider
            value={recPresetIdx === -1 ? 2 : recPresetIdx}
            onChange={i => {
              const p = RECORDING_PRESETS[i];
              patchVideo(
                "recording_quality",
                p.qp === null ? { mode: "match_clips" } : { mode: "constant_qp", qp: p.qp },
              );
            }}
            min={0} max={RECORDING_PRESETS.length - 1} step={1}
            format={i => (recPresetIdx === -1 ? "Custom" : RECORDING_PRESETS[i]?.label ?? "Custom")}
          />
        </Row>
        <SizeEstimate replaySeconds={config.replay_seconds} />
        <Row Icon={MousePointer2} label="Include cursor" hint="Draws the mouse cursor into the captured frame.">
          <DesignToggle value={config.video.include_cursor} onChange={v => patchVideo("include_cursor", v)} />
        </Row>

        <AdvancedDisclosure open={advanced} onToggle={() => setAdvanced(!advanced)}>
          <Row Icon={Sparkles} label="Quality mode" hint="Constant quality keeps the picture clean and lets bitrate float with the scene. Variable bitrate pins an average target instead." badge="adv">
            <DesignSelect<RateControl["mode"]>
              value={config.video.rate_control.mode}
              onChange={mode => {
                const next: RateControl =
                  mode === "constant_qp"
                    ? { mode: "constant_qp", qp: 20 }
                    : { mode: "vbr", avg_bps: config.video.bitrate_bps };
                patchVideo("rate_control", next);
              }}
              options={[
                { value: "constant_qp", label: "Constant quality", sub: "Recommended — same model as ShadowPlay" },
                { value: "vbr",         label: "Variable bitrate", sub: "Pin an average data rate" },
              ]}
              width={240}
            />
          </Row>
          {config.video.rate_control.mode === "constant_qp" ? (
            <Row Icon={Gauge} label="Quality (QP)" hint="Lower = better quality, larger files. 0–51 scale (AV1 is matched internally). +6 ≈ half the file size." badge="adv">
              <DesignSlider
                value={config.video.rate_control.qp}
                onChange={qp => patchVideo("rate_control", { mode: "constant_qp", qp })}
                min={1} max={51} step={1}
                format={v => `QP ${v}`}
              />
            </Row>
          ) : (
            <Row Icon={Gauge} label="Target bitrate" hint="Average rate the encoder aims for. 25 Mbps is sane for 1080p60." badge="adv">
              <DesignSlider
                value={config.video.rate_control.avg_bps}
                onChange={avg_bps => {
                  patchVideo("rate_control", { mode: "vbr", avg_bps });
                  patchVideo("bitrate_bps", avg_bps);
                }}
                min={5_000_000} max={80_000_000} step={500_000}
                format={v => `${(v / 1_000_000).toFixed(1)} Mbps`}
              />
            </Row>
          )}
          {config.video.rate_control.mode === "constant_qp" &&
            config.video.recording_quality.mode === "constant_qp" && (
            <Row Icon={Gauge} label="Recording QP" hint="QP used while a manual recording is running. Values above the clip QP are treated as ‘match clips’ — a recording never encodes worse than clips." badge="adv">
              <DesignSlider
                value={config.video.recording_quality.qp}
                onChange={qp => patchVideo("recording_quality", { mode: "constant_qp", qp })}
                min={1} max={51} step={1}
                format={v => `QP ${v}`}
              />
            </Row>
          )}
          <Row Icon={Timer} label="Keyframe interval" hint="How often the encoder writes a full frame. Lower is more seek-friendly but heavier." badge="adv">
            <DesignSlider
              value={config.video.gop_seconds}
              onChange={v => patchVideo("gop_seconds", v)}
              min={0.5} max={5} step={0.1}
              format={v => `${v.toFixed(1)} s`}
            />
          </Row>
          <Row Icon={Monitor} label="Capture method" hint="Auto is recommended. Windows Graphics Capture sees fullscreen games that the legacy DXGI path records as a desktop or frozen image — only pick DXGI if capture misbehaves on your setup." badge="adv">
            <DesignSelect<CaptureBackend>
              value={config.video.capture_backend ?? "auto"}
              onChange={v => patchVideo("capture_backend", v)}
              options={[
                { value: "auto", label: "Auto",                     sub: "Recommended — WGC, falls back to DXGI" },
                { value: "wgc",  label: "Windows Graphics Capture", sub: "Captures fullscreen games reliably" },
                { value: "dxgi", label: "DXGI Desktop Duplication", sub: "Legacy — blind to fullscreen games" },
              ]}
              width={240}
            />
          </Row>
        </AdvancedDisclosure>
      </PanelBody>
    </PanelShell>
  );
}

// ---------- panel: audio ----------------------------------------------------

function AudioPanel({
  config, setSources, setIncludeMix, devices, devicesLoading, onRefreshDevices,
}: {
  config: Config;
  setSources: (s: AudioSource[]) => void;
  setIncludeMix: (v: boolean) => void;
  devices: AudioDeviceInfo[];
  devicesLoading: boolean;
  onRefreshDevices: () => void;
}) {
  const mixDisabled = config.audio.sources.length < 2;
  return (
    <PanelShell>
      <PanelHeader
        Icon={Mic}
        title="Audio"
        subtitle="Mix any number of audio sources into the clip. Sources are recorded simultaneously and combined."
      />
      <PanelBody>
        <Row Icon={Music2} label="Sources" hint="Add as many as you like. Each source can pin to a specific device, or follow the system default." vertical>
          <AudioSourcesList
            sources={config.audio.sources}
            setSources={setSources}
            devices={devices}
            devicesLoading={devicesLoading}
            onRefreshDevices={onRefreshDevices}
          />
        </Row>
        <Row
          Icon={Volume2}
          label="Combined mix track"
          hint={
            mixDisabled
              ? "Needs at least two sources before a combined mix makes sense."
              : "Add a combined 'Mix' track as the first audio stream of the clip. Per-source tracks are kept either way."
          }
        >
          <DesignToggle
            value={!mixDisabled && config.audio.include_mix}
            onChange={setIncludeMix}
            disabled={mixDisabled}
          />
        </Row>
      </PanelBody>
    </PanelShell>
  );
}

// ---------- panel: output ---------------------------------------------------

type FilenameVariableInfo = { token: string; description: string; example: string };

/// Live preview of the filename template plus a collapsible reference of
/// every available [variable]. Clicking a variable appends it to the
/// template.
function FilenameTemplateHelp({ template, onInsert }: {
  template: string;
  onInsert: (token: string) => void;
}) {
  const [vars, setVars] = useState<FilenameVariableInfo[]>([]);
  const [preview, setPreview] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    invoke<FilenameVariableInfo[]>("get_filename_variables").then(setVars).catch(() => {});
  }, []);

  // Debounced live preview while the user types.
  useEffect(() => {
    const t = window.setTimeout(() => {
      invoke<string>("preview_filename", { template }).then(setPreview).catch(() => {});
    }, 150);
    return () => window.clearTimeout(t);
  }, [template]);

  const chip: React.CSSProperties = {
    display: "inline-block",
    padding: "2px 6px",
    borderRadius: 4,
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "rgba(255,255,255,0.78)",
    font: "500 11px/1.4 Consolas, ui-monospace, monospace",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <div style={{
      marginTop: 2,
      padding: "10px 12px",
      borderRadius: 10,
      background: "rgb(20,20,25)",
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.045)",
      font: "400 11.5px/1.5 Inter, sans-serif",
      color: "rgba(255,255,255,0.62)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          Preview:{" "}
          <b style={{ color: "rgba(255,255,255,0.85)", fontWeight: 600, fontFamily: "Consolas, ui-monospace, monospace" }}>
            {preview}.mp4
          </b>
        </span>
        <button
          onClick={() => setOpen(!open)}
          style={{
            background: "none", border: "none", padding: 0, flexShrink: 0,
            color: "#c4b5fd", cursor: "pointer",
            font: "500 11.5px/1.4 Inter, sans-serif",
          }}
        >
          {open ? "Hide variables" : "Show variables"}
        </button>
      </div>
      {open && (
        <div style={{
          marginTop: 10,
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          columnGap: 12, rowGap: 5,
          alignItems: "baseline",
        }}>
          {vars.map(v => (
            <React.Fragment key={v.token}>
              <span style={chip} title="Click to add to the template" onClick={() => onInsert(v.token)}>
                [{v.token}]
              </span>
              <span>{v.description}</span>
              <span style={{ color: "rgba(255,255,255,0.4)", fontFamily: "Consolas, ui-monospace, monospace", fontSize: 11 }}>
                {v.example}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

interface DiscordStatus {
  state: "disabled" | "connecting" | "discord_not_running" | "needs_authorization" | "connected" | "error";
  user?: string;
  message?: string;
}

/// Discord call-roster capture: enable toggle + a live connection status
/// and Connect/Disconnect controls. Status is polled from the backend
/// manager so it reflects the real RPC state (Discord closed, awaiting the
/// authorize popup, connected as user, …).
function DiscordSettings({ enabled, onToggle }: { enabled: boolean; onToggle: (v: boolean) => void }) {
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    invoke<DiscordStatus>("discord_status").then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const st = status?.state;
  const featureOff = st === "disabled";
  const connected = st === "connected";

  const statusText =
    st === "connected" ? `Connected as ${status?.user ?? "?"}`
    : st === "connecting" ? "Connecting…"
    : st === "discord_not_running" ? "Discord not running"
    : st === "needs_authorization" ? "Not connected"
    : st === "error" ? "Connection error"
    : featureOff ? "Unavailable in this build"
    : "…";

  const connect = async () => {
    setBusy(true);
    try { await invoke("discord_connect"); } catch (e) { console.error("discord_connect:", e); }
    finally { setBusy(false); setTimeout(refresh, 300); }
  };
  const disconnect = async () => {
    try { await invoke("discord_disconnect"); } catch (e) { console.error("discord_disconnect:", e); }
    finally { setTimeout(refresh, 300); }
  };

  const btnStyle: React.CSSProperties = {
    height: 26, padding: "0 12px", borderRadius: 5, border: 0,
    background: `linear-gradient(145deg, ${ACCENT}, ${ACCENT_HOT})`,
    color: "#fff", font: "600 11px/1 Inter, sans-serif",
    cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
    display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
  };
  const ghostBtn: React.CSSProperties = {
    height: 26, padding: "0 12px", borderRadius: 5,
    border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.05)",
    color: "rgba(255,255,255,0.8)", font: "600 11px/1 Inter, sans-serif",
    cursor: "pointer", flexShrink: 0,
  };

  return (
    <>
      <Row
        Icon={Users}
        label="Save Discord call infos"
        hint="Saves who you were in a call with on clip capture."
      >
        <DesignToggle value={enabled} onChange={onToggle} disabled={featureOff} />
      </Row>
      {enabled && (
        <Row Icon={Users} label="Discord connection" hint={status?.message ?? "Status of the background connection to your Discord client."}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{
              font: "500 11.5px/1 Inter, sans-serif",
              color: connected ? "rgba(120,220,150,0.95)" : "rgba(255,255,255,0.55)",
            }}>{statusText}</span>
            {!featureOff && (connected
              ? <button style={ghostBtn} onClick={disconnect}>Disconnect</button>
              : <button style={btnStyle} onClick={connect} disabled={busy}>
                  {busy ? "…" : "Connect"}
                </button>
            )}
          </div>
        </Row>
      )}
    </>
  );
}

interface TelemetryStatus {
  enabled: boolean;
  configured: boolean;
  install_id: string;
}

/// Anonymous, opt-out diagnostics: a toggle plus a manual "export & upload
/// diagnostics" action. Self-contained — reads/writes its own state via the
/// dedicated backend commands (telemetry is deliberately kept out of the
/// general config round-trip), so toggling it never restarts the pipeline.
function TelemetrySettings() {
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<"idle" | "working" | "done" | "error">("idle");

  useEffect(() => {
    invoke<TelemetryStatus>("get_telemetry_status").then(setStatus).catch(() => {});
  }, []);

  const enabled = status?.enabled ?? true;
  const configured = status?.configured ?? false;

  const toggle = async (v: boolean) => {
    setBusy(true);
    // Optimistic — reflect the switch immediately.
    setStatus(s => (s ? { ...s, enabled: v } : s));
    try {
      await invoke("set_telemetry_enabled", { enabled: v });
    } catch (e) {
      console.error("set_telemetry_enabled:", e);
      setStatus(s => (s ? { ...s, enabled: !v } : s)); // revert on failure
    } finally {
      setBusy(false);
    }
  };

  const doUpload = async () => {
    setUpload("working");
    try {
      await invoke<number>("upload_diagnostics_bundle", { note: null });
      setUpload("done");
      setTimeout(() => setUpload("idle"), 4000);
    } catch (e) {
      console.error("upload_diagnostics_bundle:", e);
      setUpload("error");
      setTimeout(() => setUpload("idle"), 4000);
    }
  };

  const ghostBtn: React.CSSProperties = {
    height: 26, padding: "0 12px", borderRadius: 5,
    border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.05)",
    color: "rgba(255,255,255,0.8)", font: "600 11px/1 Inter, sans-serif",
    cursor: upload === "working" ? "default" : "pointer", opacity: upload === "working" ? 0.6 : 1,
    display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
  };

  const uploadLabel =
    upload === "working" ? "Uploading…"
    : upload === "done" ? "Uploaded ✓"
    : upload === "error" ? "Upload failed"
    : "Export & upload";

  return (
    <>
      <Row
        Icon={ShieldCheck}
        label="Send anonymous diagnostics"
        hint={
          configured
            ? "Reports capture failures and crashes with a random install ID — no account, no personal data. Helps us fix issues we can't see."
            : "Diagnostics reporting is not available in this build."
        }
      >
        <DesignToggle value={enabled} onChange={toggle} disabled={busy || !configured} />
      </Row>
      {configured && (
        <Row
          Icon={Upload}
          label="Diagnostic bundle"
          hint="Zip your logs and config and upload them so we can debug a specific problem you're seeing."
        >
          <button style={ghostBtn} onClick={doUpload} disabled={upload === "working"}>
            <Upload size={11} />
            {uploadLabel}
          </button>
        </Row>
      )}
    </>
  );
}

function OutputPanel({
  config, patchOutput, patchMetadata, patchDiscord, advanced, setAdvanced,
  autostartEnabled, autostartIsDev, onToggleAutostart,
}: {
  config: Config;
  patchOutput: (k: keyof Config["output"], v: unknown) => void;
  patchMetadata: (k: keyof Config["metadata"], v: unknown) => void;
  patchDiscord: (k: keyof Config["discord"], v: unknown) => void;
  advanced: boolean;
  setAdvanced: (v: boolean) => void;
  autostartEnabled: boolean;
  autostartIsDev: boolean;
  onToggleAutostart: (v: boolean) => void;
}) {
  return (
    <PanelShell>
      <PanelHeader Icon={FolderOpen} title="Output" subtitle="Where finished clips land and how they're named." />
      <PanelBody>
        <Row Icon={FolderOpen} label="Clips folder" hint="Where finished .mp4 files are written.">
          <DesignTextInput
            value={config.output.directory}
            onChange={v => patchOutput("directory", v)}
            mono width={300}
            trailing={
              <button
                onClick={() => invoke("open_clips_folder")}
                title="Open folder"
                style={{
                  height: 24, padding: "0 9px",
                  borderRadius: 4, border: 0,
                  background: "rgba(255,255,255,0.06)",
                  color: "rgba(255,255,255,0.78)",
                  font: "500 10.5px/1 Inter, sans-serif",
                  cursor: "pointer",
                  flexShrink: 0,
                  display: "flex", alignItems: "center", gap: 4,
                }}
              >
                <ExternalLink size={10} />
              </button>
            }
          />
        </Row>
        <Row Icon={Film} label="Filename" hint="Template with [variables]. A number like (2) is appended only when the name is already taken.">
          <DesignTextInput value={config.output.filename_stem} onChange={v => patchOutput("filename_stem", v)} mono width={300} />
        </Row>
        <FilenameTemplateHelp
          template={config.output.filename_stem}
          onInsert={token => patchOutput("filename_stem", `${config.output.filename_stem}[${token}]`)}
        />
        <Row Icon={Volume2} label="Audio bitrate" hint="Quality of the embedded AAC audio track.">
          <DesignSlider
            value={config.output.audio_bitrate_bps}
            onChange={v => patchOutput("audio_bitrate_bps", v)}
            min={64_000} max={320_000} step={32_000}
            format={v => `${(v / 1000).toFixed(0)} kbps`}
          />
        </Row>
        <Row
          Icon={Sparkles}
          label="Capture game metadata"
          hint="Writes a .gameinfo sidecar per clip with the foreground window title — useful for grouping clips by game in browsers like Clipter."
        >
          <DesignToggle value={config.metadata.enabled} onChange={v => patchMetadata("enabled", v)} />
        </Row>
        <Row
          Icon={Sparkles}
          label="Extract game icon"
          hint="Saves the foreground app's icon as PNG into icons/. Deduped per executable."
        >
          <DesignToggle
            value={config.metadata.capture_icon}
            onChange={v => patchMetadata("capture_icon", v)}
            disabled={!config.metadata.enabled}
          />
        </Row>

        <DiscordSettings
          enabled={config.discord.enabled}
          onToggle={v => patchDiscord("enabled", v)}
        />

        <TelemetrySettings />

        <Row
          Icon={Settings2}
          label="Start with Windows"
          hint={
            autostartIsDev
              ? "Autostart is disabled in development mode."
              : "Launches ClipDip automatically when you log into Windows."
          }
        >
          <DesignToggle
            value={autostartEnabled}
            onChange={onToggleAutostart}
            disabled={autostartIsDev}
          />
        </Row>

        <AdvancedDisclosure open={advanced} onToggle={() => setAdvanced(!advanced)}>
          <Row Icon={Film} label="Keep raw files" hint="Preserve the unmuxed sidecar files next to each clip." badge="adv">
            <DesignToggle value={config.output.keep_sidecars} onChange={v => patchOutput("keep_sidecars", v)} />
          </Row>
          <Row Icon={Cpu} label="FFmpeg path" hint="Leave blank to let ClipDip find a bundled or PATH-installed ffmpeg." badge="adv">
            <DesignTextInput
              value={config.output.ffmpeg_path || ""}
              onChange={v => patchOutput("ffmpeg_path", v || null)}
              placeholder="Auto-detect"
              mono width={300}
            />
          </Row>
        </AdvancedDisclosure>
      </PanelBody>
    </PanelShell>
  );
}

// ---------- panel: hotkeys --------------------------------------------------

function HotkeysPanel({ config, patchHotkey }: {
  config: Config;
  patchHotkey: (k: keyof Config["hotkey"], v: string) => void;
}) {
  return (
    <PanelShell>
      <PanelHeader Icon={Keyboard} title="Hotkeys" subtitle="Global shortcuts — they work even inside fullscreen games. Click a field, press the combo you want, or Esc to cancel. Letters, digits, F1–F24, numpad, arrows and most punctuation are all fair game." />
      <PanelBody>
        <Row Icon={Film} label="Save clip" hint="Captures the replay buffer into a new clip.">
          <HotkeyCapture value={config.hotkey.save_clip} onChange={v => patchHotkey("save_clip", v)} />
        </Row>
        <Row Icon={KeyRound} label="Rename last clip" hint="Focuses the rename field in the fly-in notification.">
          <HotkeyCapture value={config.hotkey.rename_clip} onChange={v => patchHotkey("rename_clip", v)} />
        </Row>
        <Row Icon={Disc} label="Start / stop recording" hint="Press once to start a manual recording, again to save it as a clip.">
          <HotkeyCapture value={config.hotkey.toggle_recording} onChange={v => patchHotkey("toggle_recording", v)} />
        </Row>
        <div style={{
          marginTop: 8,
          padding: "10px 12px",
          borderRadius: 10,
          background: "rgba(245,158,11,0.06)",
          boxShadow: "inset 0 0 0 1px rgba(245,158,11,0.16)",
          display: "flex", gap: 9,
          font: "400 11.5px/1.45 Inter, sans-serif",
          color: "rgba(255,255,255,0.62)",
        }}>
          <AlertTriangle size={13} color="#f59e0b" style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            ClipDip only listens — it can't stop the game from also seeing the key. Pick combos games
            are unlikely to use; Ctrl+Alt+F9 through F12 are typically safe.
          </span>
        </div>
      </PanelBody>
    </PanelShell>
  );
}

// ---------- overlay preview --------------------------------------------------

/// Stage buttons that fire the real overlay on screen via `test_overlay`
/// — the actual toast, in the configured corner, with current settings.
function OverlayPreviewRow({ enabled }: { enabled: boolean }) {
  const [recDot, setRecDot] = useState(false);
  const fire = (stage: string) =>
    invoke("test_overlay", { stage }).catch(err => console.error("test_overlay:", err));

  const stageBtn = (primary: boolean): React.CSSProperties => ({
    height: 30, padding: "0 13px",
    display: "inline-flex", alignItems: "center", gap: 6,
    borderRadius: 8, border: 0,
    background: !enabled
      ? "rgba(255,255,255,0.05)"
      : primary
      ? `linear-gradient(135deg, ${ACCENT}, ${ACCENT_HOT})`
      : "rgba(255,255,255,0.06)",
    boxShadow: !enabled
      ? "none"
      : primary
      ? `0 0 16px ${ACCENT}55`
      : "inset 0 0 0 1px rgba(255,255,255,0.09)",
    color: !enabled ? "rgba(255,255,255,0.35)" : primary ? "#fff" : "rgba(255,255,255,0.82)",
    font: "600 11.5px/1 Inter, sans-serif",
    cursor: enabled ? "pointer" : "not-allowed",
    transition: "filter .12s, box-shadow .12s",
  });
  const hoverable = (e: React.MouseEvent, on: boolean) => {
    if (enabled) (e.currentTarget as HTMLElement).style.filter = on ? "brightness(1.15)" : "none";
  };

  return (
    <Row
      Icon={Sparkles}
      label="Preview on screen"
      hint="Fires the real overlay in the configured corner — position, timing, animation and sound, no clip required. The save flow includes the rename field, so you can try that too."
      vertical
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => fire("flow")}
          disabled={!enabled}
          style={stageBtn(true)}
          onMouseEnter={e => hoverable(e, true)}
          onMouseLeave={e => hoverable(e, false)}
        >
          <Film size={11} />
          Clip saved
        </button>
        <button
          onClick={() => fire("notice")}
          disabled={!enabled}
          style={stageBtn(false)}
          onMouseEnter={e => hoverable(e, true)}
          onMouseLeave={e => hoverable(e, false)}
        >
          <Disc size={11} />
          Recording started
        </button>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          height: 30, padding: "0 11px",
          borderRadius: 8,
          background: "rgba(255,255,255,0.03)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.07)",
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: 999,
            background: recDot && enabled ? REC_ROSE : "rgba(255,255,255,0.18)",
            boxShadow: recDot && enabled ? `0 0 7px ${REC_ROSE}cc` : "none",
            transition: "background .15s, box-shadow .15s",
          }} />
          <span style={{ font: "500 11.5px/1 Inter, sans-serif", color: "rgba(255,255,255,0.7)" }}>
            Recording dot
          </span>
          <DesignToggle
            value={recDot && enabled}
            disabled={!enabled}
            onChange={v => { setRecDot(v); fire(v ? "rec_on" : "rec_off"); }}
          />
        </div>
      </div>
    </Row>
  );
}

// ---------- panel: notifications --------------------------------------------

function NotificationsPanel({ config, patchNotif }: {
  config: Config;
  patchNotif: (k: keyof Config["notifications"], v: unknown) => void;
}) {
  return (
    <PanelShell>
      <PanelHeader Icon={Bell} title="Notifications" subtitle="The fly-in toast that appears whenever a clip is saved." />
      <PanelBody>
        <Row Icon={Bell} label="Show notification" hint="The clip-saved toast with rename input.">
          <DesignToggle value={config.notifications.enabled} onChange={v => patchNotif("enabled", v)} />
        </Row>
        <Row Icon={Volume2} label="Play sound" hint="A short audible chirp when a clip lands.">
          <DesignToggle value={config.notifications.sound} onChange={v => patchNotif("sound", v)} disabled={!config.notifications.enabled} />
        </Row>
        <Row Icon={MapPin} label="Position" hint="Where the notification appears on the active display.">
          <CornerPicker value={config.notifications.corner} onChange={v => patchNotif("corner", v)} />
        </Row>
        <Row Icon={Timer} label="Auto-dismiss" hint="How long the toast stays before sliding out. Set to 0 to keep it open.">
          <DesignSlider
            value={config.notifications.auto_dismiss_secs}
            onChange={v => patchNotif("auto_dismiss_secs", v)}
            min={0} max={30} step={1}
            format={v => v === 0 ? "Never" : `${v} s`}
          />
        </Row>
        <OverlayPreviewRow enabled={config.notifications.enabled} />
      </PanelBody>
    </PanelShell>
  );
}

// ---------- main component --------------------------------------------------

export default function MainWindow() {
  const [config, setConfig] = useState<Config | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("video");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<AudioDeviceInfo[]>([]);
  const [audioDevicesLoading, setAudioDevicesLoading] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const [videoAdv, setVideoAdv] = useState(false);
  const [outputAdv, setOutputAdv] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartIsDev, setAutostartIsDev] = useState(false);

  const loadedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  // Capture-relevant config slice as of the last applied pipeline state.
  // When a save changes this slice, the pipeline must restart for the new
  // settings to take effect (encoder/audio/replay length only apply at
  // pipeline start).
  const captureCfgRef = useRef<string | null>(null);
  // Everything the pipeline bakes in at start: capture settings plus the
  // mux-bound output options (audio bitrate, sidecars, ffmpeg path read
  // from the pipeline's startup config — directory/filename are re-read
  // per save and don't belong here).
  const captureSlice = (c: Config) =>
    JSON.stringify({
      v: c.video, r: c.replay_seconds, a: c.audio,
      ab: c.output.audio_bitrate_bps, ks: c.output.keep_sidecars, fp: c.output.ffmpeg_path,
    });
  // Hotkeys re-register without a pipeline restart — track them separately.
  const hotkeyCfgRef = useRef<string | null>(null);
  const hotkeySlice = (c: Config) => JSON.stringify(c.hotkey);

  // Load config
  useEffect(() => {
    invoke<Config>("get_config")
      .then(cfg => {
        setConfig(cfg);
        try {
          if (!localStorage.getItem(ONBOARDING_KEY)) setShowOnboarding(true);
        } catch { /* private mode — just skip */ }
      })
      .catch(() => {
        setConfig({
          replay_seconds: 60,
          video: { output_index: 0, capture_backend: "auto", fps: 60, bitrate_bps: 30_000_000, include_cursor: true, gop_seconds: 1.0, codec: "prefer_av1", rate_control: { mode: "constant_qp", qp: 20 }, recording_quality: { mode: "constant_qp", qp: 14 } },
          audio: { sources: [{ kind: "system_loopback" }, { kind: "microphone" }], include_mix: true },
          output: { directory: "C:\\Users\\User\\Videos\\Clipdip", filename_stem: "[app] [HH].[mm].[ss] - [dd].[MM].[yyyy]", ffmpeg_path: null, keep_sidecars: false, audio_bitrate_bps: 192_000 },
          hotkey: { save_clip: "Ctrl+Alt+F10", rename_clip: "Ctrl+F10", toggle_recording: "Ctrl+Alt+F9" },
          notifications: { enabled: true, sound: true, corner: "top_right", auto_dismiss_secs: 10 },
          metadata: { enabled: false, capture_icon: true, ignored_processes: [] },
          discord: { enabled: false },
        });
      });
  }, []);

  // Load autostart status
  useEffect(() => {
    invoke<{ enabled: boolean; is_dev: boolean }>("get_autostart_info")
      .then(info => {
        setAutostartEnabled(info.enabled);
        setAutostartIsDev(info.is_dev);
      })
      .catch(err => {
        console.error("failed to get autostart status:", err);
      });
  }, []);

  // Pull monitor list once
  useEffect(() => {
    invoke<MonitorInfo[]>("list_monitors").then(setMonitors).catch(() => setMonitors([]));
  }, []);

  // Audio devices: load on mount, refresh on window focus (user may have
  // plugged in headphones since we last looked), expose manual refresh.
  const refreshAudioDevices = useCallback(() => {
    setAudioDevicesLoading(true);
    invoke<AudioDeviceInfo[]>("list_audio_devices")
      .then(setAudioDevices)
      .catch(err => {
        console.error("list_audio_devices failed:", err);
        setAudioDevices([]);
      })
      .finally(() => setAudioDevicesLoading(false));
  }, []);
  useEffect(() => {
    refreshAudioDevices();
    const onFocus = () => refreshAudioDevices();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshAudioDevices]);

  // Autosave on config change (debounced)
  useEffect(() => {
    if (!config) return;
    if (!loadedRef.current) {
      loadedRef.current = true;
      captureCfgRef.current = captureSlice(config);
      hotkeyCfgRef.current = hotkeySlice(config);
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    saveTimerRef.current = window.setTimeout(async () => {
      setSaveStatus("saving");
      try {
        await invoke("update_config", { config });
        setSaveStatus("saved");
        // Capture settings only apply at pipeline start — restart it so
        // quality presets etc. take effect (and the size readout follows).
        const slice = captureSlice(config);
        if (captureCfgRef.current !== slice) {
          captureCfgRef.current = slice;
          invoke("restart_pipeline").catch(() => {});
        }
        // Re-register global hotkeys live — without this, an edited
        // hotkey only took effect after an app restart.
        const hkSlice = hotkeySlice(config);
        if (hotkeyCfgRef.current !== hkSlice) {
          hotkeyCfgRef.current = hkSlice;
          invoke("reload_hotkeys").catch(() => {});
        }
      } catch {
        setSaveStatus("error");
      }
      idleTimerRef.current = window.setTimeout(() => setSaveStatus("idle"), 1500);
    }, 350);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [config]);

  // Initial pipeline state
  useEffect(() => {
    invoke<boolean>("get_pipeline_running").then(setPipelineRunning).catch(() => {});
  }, []);

  // Pipeline status listeners
  useEffect(() => {
    const u1 = listen<string>("pipeline-error", e => setPipelineError(e.payload));
    const u2 = listen<{ running: boolean }>("pipeline-status", e => setPipelineRunning(e.payload.running));
    return () => { u1.then(f => f()); u2.then(f => f()); };
  }, []);

  const patch = useCallback(<K extends keyof Config>(key: K, val: Config[K]) => {
    setConfig(prev => prev ? { ...prev, [key]: val } : prev);
  }, []);

  const patchVideo = useCallback((k: keyof Config["video"], v: unknown) => {
    setConfig(prev => prev ? { ...prev, video: { ...prev.video, [k]: v } } : prev);
  }, []);

  const patchOutput = useCallback((k: keyof Config["output"], v: unknown) => {
    setConfig(prev => prev ? { ...prev, output: { ...prev.output, [k]: v } } : prev);
  }, []);

  const patchHotkey = useCallback((k: keyof Config["hotkey"], v: string) => {
    setConfig(prev => prev ? { ...prev, hotkey: { ...prev.hotkey, [k]: v } } : prev);
  }, []);

  const patchNotif = useCallback((k: keyof Config["notifications"], v: unknown) => {
    setConfig(prev => prev ? { ...prev, notifications: { ...prev.notifications, [k]: v } } : prev);
  }, []);

  const patchMetadata = useCallback((k: keyof Config["metadata"], v: unknown) => {
    setConfig(prev => prev ? { ...prev, metadata: { ...prev.metadata, [k]: v } } : prev);
  }, []);

  const patchDiscord = useCallback((k: keyof Config["discord"], v: unknown) => {
    setConfig(prev => prev ? { ...prev, discord: { ...prev.discord, [k]: v } as Config["discord"] } : prev);
  }, []);

  const setSources = useCallback((srcs: AudioSource[]) => {
    setConfig(prev => prev ? { ...prev, audio: { ...prev.audio, sources: srcs } } : prev);
  }, []);

  const setIncludeMix = useCallback((v: boolean) => {
    setConfig(prev => prev ? { ...prev, audio: { ...prev.audio, include_mix: v } } : prev);
  }, []);

  const replayOnboarding = useCallback(() => {
    try { localStorage.removeItem(ONBOARDING_KEY); } catch { /* */ }
    setShowOnboarding(true);
  }, []);

  if (!config) {
    return (
      <div style={{
        width: "100%", height: "100%",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgb(10,10,14)",
        color: "rgba(255,255,255,0.4)",
        font: "400 13px/1 Inter, sans-serif",
      }}>
        Loading configuration…
      </div>
    );
  }

  return (
    <div style={{
      width: "100%", height: "100%",
      display: "flex", flexDirection: "column",
      // Charcoal base with two faint comet-colored auroras — enough to
      // tint the room, not enough to fight the content.
      background: `
        radial-gradient(900px 420px at 85% -10%, ${ACCENT}14, transparent 65%),
        radial-gradient(700px 380px at -10% 110%, ${ACCENT_HOT}0d, transparent 60%),
        rgb(10,10,14)`,
      backdropFilter: "blur(30px) saturate(140%)",
      WebkitBackdropFilter: "blur(30px) saturate(140%)",
      color: "rgba(255,255,255,0.9)",
      font: "400 13px/1.4 Inter, sans-serif",
      userSelect: "none",
      overflow: "hidden",
    }}>
      <TitleBar saveStatus={saveStatus} onReplayOnboarding={replayOnboarding} />

      <TopTabs
        active={activeTab}
        onChange={setActiveTab}
        pipelineError={pipelineError}
        pipelineRunning={pipelineRunning}
      />

      <main style={{
        flex: 1, minWidth: 0, minHeight: 0,
        overflowY: "auto",
        background: "transparent",
      }}>
        {activeTab === "video"         && <VideoPanel config={config} patch={patch} patchVideo={patchVideo} monitors={monitors} advanced={videoAdv} setAdvanced={setVideoAdv} />}
        {activeTab === "audio"         && <AudioPanel config={config} setSources={setSources} setIncludeMix={setIncludeMix} devices={audioDevices} devicesLoading={audioDevicesLoading} onRefreshDevices={refreshAudioDevices} />}
        {activeTab === "output"        && (
          <OutputPanel
            config={config}
            patchOutput={patchOutput}
            patchMetadata={patchMetadata}
            patchDiscord={patchDiscord}
            advanced={outputAdv}
            setAdvanced={setOutputAdv}
            autostartEnabled={autostartEnabled}
            autostartIsDev={autostartIsDev}
            onToggleAutostart={async (enabled) => {
              try {
                await invoke("set_autostart_status", { enabled });
                setAutostartEnabled(enabled);
              } catch (err) {
                console.error("failed to set autostart:", err);
                alert(String(err));
              }
            }}
          />
        )}
        {activeTab === "hotkeys"       && <HotkeysPanel config={config} patchHotkey={patchHotkey} />}
        {activeTab === "notifications" && <NotificationsPanel config={config} patchNotif={patchNotif} />}
        <div style={{ height: 60 }} />
      </main>

      <UpdateBanner />

      {showOnboarding && (
        <OnboardingModal
          config={config}
          setConfig={setConfig}
          monitors={monitors}
          devices={audioDevices}
          devicesLoading={audioDevicesLoading}
          onRefreshDevices={refreshAudioDevices}
          onClose={() => setShowOnboarding(false)}
        />
      )}
    </div>
  );
}
