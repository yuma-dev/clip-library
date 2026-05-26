import { useEffect, useState, useCallback, useRef } from "react";
import { invoke, listen } from "@/lib/tauri";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { formatBitrate } from "@/lib/utils";
import { Plus, Trash2, ExternalLink } from "lucide-react";

// ---------- design tokens ---------------------------------------------------

const TEAL = "oklch(0.74 0.13 195)";
const TEAL_DIM = "oklch(0.62 0.11 195)";

// ---------- types -----------------------------------------------------------

interface AudioSource {
  kind: "system_loopback" | "microphone" | "process_loopback";
  device_id?: string;
}

interface Config {
  replay_seconds: number;
  video: {
    output_index: number;
    fps: number;
    bitrate_bps: number;
    include_cursor: boolean;
    gop_seconds: number;
  };
  audio: { sources: AudioSource[] };
  output: {
    directory: string;
    filename_stem: string;
    ffmpeg_path: string | null;
    keep_sidecars: boolean;
    audio_bitrate_bps: number;
  };
  hotkey: { save_clip: string; rename_clip: string };
  notifications: {
    enabled: boolean;
    sound: boolean;
    corner: string;
    auto_dismiss_secs: number;
  };
}

// ---------- sections config -------------------------------------------------

const SECTIONS = [
  { id: "recording",     label: "Recording",      num: 1 },
  { id: "video",         label: "Video",           num: 2 },
  { id: "audio",         label: "Audio",           num: 3 },
  { id: "output",        label: "Output",          num: 4 },
  { id: "hotkeys",       label: "Hotkeys",         num: 5 },
  { id: "notifications", label: "Notifications",   num: 6 },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

// ---------- layout primitives -----------------------------------------------

function SectionHeader({
  num, title, subtitle,
}: { num: number; title: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <span style={{
          font: '500 11px/1 "JetBrains Mono", monospace',
          color: "rgba(255,255,255,0.32)",
          letterSpacing: "0.04em",
        }}>{String(num).padStart(2, "0")}</span>
        <h2 style={{
          margin: 0,
          font: "600 20px/1 Inter, sans-serif",
          color: "rgba(255,255,255,0.95)",
          letterSpacing: "-0.015em",
        }}>{title}</h2>
      </div>
      {subtitle && (
        <p style={{
          margin: "0 0 0 32px",
          font: "400 12.5px/1.5 Inter, sans-serif",
          color: "rgba(255,255,255,0.5)",
          maxWidth: 520,
        }}>{subtitle}</p>
      )}
    </div>
  );
}

function Row({
  label, hint, children, vertical, badge,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  vertical?: boolean;
  badge?: string;
}) {
  return (
    <div style={{
      display: "flex",
      flexDirection: vertical ? "column" : "row",
      alignItems: vertical ? "stretch" : "center",
      gap: vertical ? 8 : 16,
    }}>
      <div style={{ flex: vertical ? "0 0 auto" : 1, minWidth: 0 }}>
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
            marginTop: 3,
            maxWidth: 440,
          }}>{hint}</div>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function SectionShell({
  id, children,
}: { id: string; children: React.ReactNode }) {
  return (
    <section id={`sec-${id}`} style={{
      padding: "30px 36px 26px",
      borderBottom: "1px solid rgba(255,255,255,0.04)",
    }}>
      {children}
    </section>
  );
}

function SectionBody({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginLeft: 32, display: "flex", flexDirection: "column", gap: 18 }}>
      {children}
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
          background: `linear-gradient(90deg, ${TEAL_DIM}, ${TEAL})`,
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
          background: "#fff",
          boxShadow: "0 0 0 1px rgba(0,0,0,0.4), 0 2px 6px rgba(0,0,0,0.5)",
          pointerEvents: "none",
        }} />
      </div>
      <div style={{
        minWidth: 60, textAlign: "right",
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
          ? `linear-gradient(180deg, ${TEAL}, ${TEAL_DIM})`
          : "rgba(255,255,255,0.09)",
        boxShadow: value
          ? `0 0 12px ${TEAL}55, inset 0 0 0 1px rgba(255,255,255,0.1)`
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
  options: { value: T; label: string }[];
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find(o => o.value === value) || options[0];
  return (
    <div style={{ position: "relative", width }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%", height: 30, padding: "0 10px 0 12px",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
          borderRadius: 6,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          font: "500 12px/1 Inter, sans-serif",
          color: "rgba(255,255,255,0.9)",
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
            maxHeight: 240, overflowY: "auto",
          }}>
            {options.map(o => (
              <button
                key={String(o.value)}
                onClick={() => { onChange(o.value); setOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  width: "100%", padding: "7px 10px",
                  borderRadius: 4, border: 0,
                  background: o.value === value ? "rgba(255,255,255,0.06)" : "transparent",
                  font: "500 12px/1 Inter, sans-serif",
                  color: "rgba(255,255,255,0.9)",
                  cursor: "pointer", textAlign: "left",
                }}
                onMouseEnter={e => { if (o.value !== value) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
                onMouseLeave={e => { if (o.value !== value) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <span style={{
                  width: 4, height: 4, borderRadius: 999, flexShrink: 0,
                  background: o.value === value ? TEAL : "transparent",
                }} />
                <span>{o.label}</span>
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
      height: 30,
      borderRadius: 6,
      background: "rgba(255,255,255,0.04)",
      border: `1px solid ${focused ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.08)"}`,
      boxShadow: focused ? `0 0 0 3px ${TEAL}22` : "none",
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

function HotkeyCapture({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);
  const parts = value ? value.split("+").map(s => s.trim()) : [];

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      const pressed: string[] = [];
      if (e.ctrlKey)  pressed.push("Ctrl");
      if (e.altKey)   pressed.push("Alt");
      if (e.shiftKey) pressed.push("Shift");
      if (e.metaKey)  pressed.push("Win");
      const key = e.key;
      if (!["Control", "Alt", "Shift", "Meta"].includes(key)) {
        pressed.push(key.length === 1 ? key.toUpperCase() : key);
        onChange(pressed.join("+"));
        setRecording(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [recording, onChange]);

  return (
    <button
      onClick={() => setRecording(!recording)}
      style={{
        height: 30, padding: "0 4px 0 10px",
        display: "flex", alignItems: "center", gap: 8,
        borderRadius: 6,
        background: recording ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.04)",
        border: `1px solid ${recording ? TEAL + "88" : "rgba(255,255,255,0.08)"}`,
        boxShadow: recording ? `0 0 0 3px ${TEAL}22` : "none",
        cursor: "pointer",
        transition: "all .12s",
        minWidth: 156,
      }}
    >
      {recording ? (
        <span style={{
          font: "500 11.5px/1 Inter, sans-serif",
          color: "rgba(255,255,255,0.78)",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: 999,
            background: TEAL,
            animation: "pulse 1.2s infinite",
          }} />
          Press keys…
        </span>
      ) : (
        <span style={{ display: "flex", alignItems: "center", gap: 3, flex: 1 }}>
          {parts.map((p, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 3 }}>
              {i > 0 && <span style={{ color: "rgba(255,255,255,0.3)", font: "500 11px/1 Inter, sans-serif" }}>+</span>}
              <span style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                minWidth: 22, height: 22, padding: "0 6px",
                borderRadius: 4,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                font: '500 11px/1 "JetBrains Mono", monospace',
                color: "rgba(255,255,255,0.88)",
              }}>{p}</span>
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
        color: "rgba(255,255,255,0.45)",
      }}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M9 2 L10 3 L4 9 L2 10 L3 8 L9 2 Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
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
      width: 90, height: 56, borderRadius: 5,
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.08)",
      position: "relative", padding: 5,
    }}>
      {corners.map(c => {
        const active = c.value === value;
        return (
          <button
            key={c.value}
            onClick={() => onChange(c.value)}
            style={{
              position: "absolute",
              top:    c.y === 0 ? 5 : "auto",
              bottom: c.y === 1 ? 5 : "auto",
              left:   c.x === 0 ? 5 : "auto",
              right:  c.x === 1 ? 5 : "auto",
              width: 22, height: 14, padding: 0, border: 0, borderRadius: 2,
              background: active ? `linear-gradient(180deg, ${TEAL}, ${TEAL_DIM})` : "rgba(255,255,255,0.07)",
              boxShadow: active ? `0 0 8px ${TEAL}66, inset 0 0 0 1px rgba(255,255,255,0.2)` : "inset 0 0 0 1px rgba(255,255,255,0.04)",
              cursor: "pointer", transition: "all .12s",
            }}
          />
        );
      })}
    </div>
  );
}

// ---------- title bar -------------------------------------------------------

function TitleBar({ saveStatus, onSave, saving }: {
  saveStatus: "idle" | "saved" | "error";
  onSave: () => void;
  saving: boolean;
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
      height: 32, flexShrink: 0,
      display: "flex", alignItems: "center",
      borderBottom: "1px solid rgba(255,255,255,0.04)",
    }}>
      {/* Logo */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "0 16px",
        pointerEvents: "none",
      }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="1" width="14" height="14" rx="3" fill={TEAL} opacity="0.9" />
          <path d="M5 8 L7.5 10.5 L11 6" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{
          font: "600 11px/1 Inter, sans-serif",
          color: "rgba(255,255,255,0.72)",
          letterSpacing: "0.02em",
        }}>ClipDip</span>
      </div>

      {/* Drag region */}
      <div data-tauri-drag-region style={{ flex: 1, height: "100%" }} />

      {/* Save status */}
      {saveStatus !== "idle" && (
        <div style={{
          font: "500 11px/1 Inter, sans-serif",
          color: saveStatus === "saved" ? "#22c55e" : "#ef4444",
          marginRight: 12,
        }}>
          {saveStatus === "saved" ? "Saved" : "Save failed"}
        </div>
      )}

      {/* Save button */}
      <button
        onClick={onSave}
        disabled={saving}
        style={{
          height: 22, padding: "0 10px",
          marginRight: 8,
          borderRadius: 4, border: 0,
          background: `linear-gradient(180deg, ${TEAL}, ${TEAL_DIM})`,
          color: "rgba(0,0,0,0.85)",
          font: "600 10.5px/1 Inter, sans-serif",
          cursor: saving ? "not-allowed" : "pointer",
          opacity: saving ? 0.6 : 1,
          transition: "opacity .12s",
          flexShrink: 0,
        }}
      >
        {saving ? "Saving…" : "Save"}
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
              width: 44, height: 32, border: 0,
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

// ---------- sidebar ---------------------------------------------------------

function Sidebar({ active, onNavigate, pipelineError, pipelineRunning }: {
  active: SectionId;
  onNavigate: (id: SectionId) => void;
  pipelineError: string | null;
  pipelineRunning: boolean;
}) {
  return (
    <nav style={{
      width: 196, flexShrink: 0,
      padding: "20px 12px",
      borderRight: "1px solid rgba(255,255,255,0.04)",
      display: "flex", flexDirection: "column", gap: 1,
      background: "rgba(0,0,0,0.18)",
    }}>
      <div style={{
        font: "500 9.5px/1 Inter, sans-serif",
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: "rgba(255,255,255,0.32)",
        padding: "6px 12px 12px",
      }}>Configure</div>

      {SECTIONS.map((s) => {
        const isActive = s.id === active;
        return (
          <button
            key={s.id}
            onClick={() => onNavigate(s.id)}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "8px 12px",
              border: 0, background: "transparent",
              borderRadius: 5, cursor: "pointer", textAlign: "left",
              color: isActive ? "rgba(255,255,255,0.96)" : "rgba(255,255,255,0.62)",
              position: "relative", transition: "color .12s",
              width: "100%",
            }}
            onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.03)"; }}
            onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            {isActive && (
              <span style={{
                position: "absolute", left: 0, top: 8, bottom: 8, width: 2,
                borderRadius: 1, background: TEAL,
              }} />
            )}
            <span style={{
              font: '500 11px/1 "JetBrains Mono", monospace',
              color: isActive ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.3)",
              minWidth: 18,
            }}>{String(s.num).padStart(2, "0")}</span>
            <span style={{
              font: `${isActive ? 600 : 500} 13px/1 Inter, sans-serif`,
              letterSpacing: "-0.005em",
            }}>{s.label}</span>
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      {/* Status */}
      <div style={{
        margin: "8px 12px",
        padding: "7px 10px",
        borderRadius: 6,
        background: pipelineError
          ? "rgba(239,68,68,0.1)"
          : pipelineRunning
          ? "rgba(34,197,94,0.08)"
          : "rgba(255,255,255,0.03)",
        border: `1px solid ${pipelineError ? "rgba(239,68,68,0.2)" : pipelineRunning ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.05)"}`,
        display: "flex", alignItems: "center", gap: 7,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: 999, flexShrink: 0,
          background: pipelineError ? "#ef4444" : pipelineRunning ? "#22c55e" : "rgba(255,255,255,0.2)",
          animation: pipelineRunning && !pipelineError ? "pulse 2s infinite" : "none",
        }} />
        <span style={{
          font: "500 10.5px/1 Inter, sans-serif",
          color: pipelineError ? "#ef4444" : pipelineRunning ? "#22c55e" : "rgba(255,255,255,0.4)",
        }}>
          {pipelineError ? "Error" : pipelineRunning ? "Recording" : "Starting…"}
        </span>
      </div>

      {/* Footer */}
      <div style={{
        padding: "8px 12px",
        font: '400 10.5px/1.4 "JetBrains Mono", monospace',
        color: "rgba(255,255,255,0.28)",
        letterSpacing: "0.01em",
      }}>
        ClipDip v0.1.0<br />
        config.toml · synced
      </div>
    </nav>
  );
}

// ---------- audio sources ---------------------------------------------------

function AudioSourcesList({
  sources, setSources,
}: {
  sources: AudioSource[];
  setSources: (s: AudioSource[]) => void;
}) {
  const update = (idx: number, patch: Partial<AudioSource>) =>
    setSources(sources.map((s, i) => i === idx ? { ...s, ...patch } : s));
  const remove = (idx: number) => setSources(sources.filter((_, i) => i !== idx));
  const add = () => setSources([...sources, { kind: "microphone" }]);

  const kindOptions: { value: AudioSource["kind"]; label: string }[] = [
    { value: "system_loopback",  label: "System output" },
    { value: "microphone",       label: "Microphone" },
    { value: "process_loopback", label: "Process loopback" },
  ];

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {sources.map((src, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 8px 8px 10px",
            borderRadius: 7,
            background: "rgba(255,255,255,0.025)",
            border: "1px solid rgba(255,255,255,0.05)",
          }}>
            <span style={{
              font: '500 10px/1 "JetBrains Mono", monospace',
              color: "rgba(255,255,255,0.32)",
              minWidth: 18,
            }}>{String(i + 1).padStart(2, "0")}</span>
            <DesignSelect<AudioSource["kind"]>
              value={src.kind}
              onChange={kind => update(i, { kind, device_id: undefined })}
              options={kindOptions}
              width={180}
            />
            <div style={{ flex: 1 }} />
            <button
              onClick={() => remove(i)}
              style={{
                width: 28, height: 28, borderRadius: 5,
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
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={add}
        style={{
          marginTop: 10,
          padding: "7px 12px",
          display: "inline-flex", alignItems: "center", gap: 6,
          borderRadius: 6,
          background: "rgba(255,255,255,0.04)",
          border: "1px dashed rgba(255,255,255,0.14)",
          color: "rgba(255,255,255,0.7)",
          font: "500 12px/1 Inter, sans-serif",
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
        Add audio source
      </button>
    </div>
  );
}

// ---------- main component --------------------------------------------------

export default function MainWindow() {
  const [config, setConfig] = useState<Config | null>(null);
  const [activeNav, setActiveNav] = useState<SectionId>("recording");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Load config
  useEffect(() => {
    invoke<Config>("get_config")
      .then(setConfig)
      .catch(() => {
        setConfig({
          replay_seconds: 60,
          video: { output_index: 0, fps: 60, bitrate_bps: 25_000_000, include_cursor: true, gop_seconds: 1.0 },
          audio: { sources: [{ kind: "system_loopback" }, { kind: "microphone" }] },
          output: { directory: "C:\\Users\\User\\Videos\\Clipdip", filename_stem: "clipdip", ffmpeg_path: null, keep_sidecars: false, audio_bitrate_bps: 192_000 },
          hotkey: { save_clip: "Ctrl+Alt+F10", rename_clip: "Ctrl+F10" },
          notifications: { enabled: true, sound: true, corner: "bottom_right", auto_dismiss_secs: 8 },
        });
      });
  }, []);

  // Listen for pipeline events
  useEffect(() => {
    const u1 = listen<string>("pipeline-error", e => setPipelineError(e.payload));
    const u2 = listen<{ running: boolean }>("pipeline-status", e => setPipelineRunning(e.payload.running));
    return () => { u1.then(f => f()); u2.then(f => f()); };
  }, []);

  // Scroll-spy: update active nav based on scroll position
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const onScroll = () => {
      let best: SectionId = SECTIONS[0].id;
      for (const sec of SECTIONS) {
        const el = document.getElementById(`sec-${sec.id}`);
        if (el && el.offsetTop - sc.scrollTop <= 40) best = sec.id;
      }
      setActiveNav(best);
    };
    sc.addEventListener("scroll", onScroll);
    return () => sc.removeEventListener("scroll", onScroll);
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

  const onNavigate = useCallback((id: SectionId) => {
    setActiveNav(id);
    const el = document.getElementById(`sec-${id}`);
    if (el && scrollerRef.current) {
      scrollerRef.current.scrollTo({ top: el.offsetTop - 8, behavior: "smooth" });
    }
  }, []);

  const save = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    try {
      await invoke("update_config", { config });
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveStatus("idle"), 2500);
    }
  }, [config]);

  if (!config) {
    return (
      <div style={{
        width: "100%", height: "100%",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(10,10,14,0.92)",
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
      background: "rgba(10,10,14,0.96)",
      backdropFilter: "blur(30px) saturate(140%)",
      WebkitBackdropFilter: "blur(30px) saturate(140%)",
      color: "rgba(255,255,255,0.9)",
      font: "400 13px/1.4 Inter, sans-serif",
      userSelect: "none",
      overflow: "hidden",
    }}>
      <TitleBar saveStatus={saveStatus} onSave={save} saving={saving} />

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <Sidebar
          active={activeNav}
          onNavigate={onNavigate}
          pipelineError={pipelineError}
          pipelineRunning={pipelineRunning}
        />

        <main
          ref={scrollerRef}
          style={{
            flex: 1, minWidth: 0,
            overflowY: "auto",
            background: "transparent",
          }}
        >
          {/* Recording */}
          <SectionShell id="recording">
            <SectionHeader num={1} title="Recording" subtitle="ClipDip keeps a rolling buffer of recent gameplay. When you hit the save shortcut, the last N seconds become a clip." />
            <SectionBody>
              <Row label="Replay buffer" hint="The longest clip you can save. Larger buffers use more memory.">
                <DesignSlider
                  value={config.replay_seconds}
                  onChange={v => patch("replay_seconds", v)}
                  min={10} max={300} step={5}
                  format={v => `${v} s`}
                />
              </Row>
            </SectionBody>
          </SectionShell>

          {/* Video */}
          <SectionShell id="video">
            <SectionHeader num={2} title="Video" subtitle="What ClipDip captures and how heavy the file is." />
            <SectionBody>
              <Row label="Monitor" hint="Pick the display to capture. Multi-monitor setups capture only one at a time.">
                <DesignSelect<number>
                  value={config.video.output_index}
                  onChange={v => patchVideo("output_index", v)}
                  options={[
                    { value: 0, label: "Display 1 · primary" },
                    { value: 1, label: "Display 2" },
                    { value: 2, label: "Display 3" },
                  ]}
                  width={220}
                />
              </Row>
              <Row label="Frame rate" hint="Higher is smoother but produces larger files.">
                <DesignSlider
                  value={config.video.fps}
                  onChange={v => patchVideo("fps", v)}
                  min={30} max={240} step={1}
                  format={v => `${v} fps`}
                />
              </Row>
              <Row label="Bitrate" hint="The visual quality budget. 25 Mbps is a sane default for 1080p60.">
                <DesignSlider
                  value={config.video.bitrate_bps}
                  onChange={v => patchVideo("bitrate_bps", v)}
                  min={5_000_000} max={80_000_000} step={500_000}
                  format={v => `${(v / 1_000_000).toFixed(1)} Mbps`}
                />
              </Row>
              <Row label="Include cursor" hint="Draws the mouse cursor into the captured frame.">
                <DesignToggle value={config.video.include_cursor} onChange={v => patchVideo("include_cursor", v)} />
              </Row>
              <Row label="Keyframe interval" hint="How often the encoder writes a full frame. Lower is more seek-friendly but heavier.">
                <DesignSlider
                  value={config.video.gop_seconds}
                  onChange={v => patchVideo("gop_seconds", v)}
                  min={0.5} max={5} step={0.1}
                  format={v => `${v.toFixed(1)} s`}
                />
              </Row>
            </SectionBody>
          </SectionShell>

          {/* Audio */}
          <SectionShell id="audio">
            <SectionHeader num={3} title="Audio" subtitle="Mix any number of audio sources into the clip. Sources are recorded simultaneously and combined." />
            <SectionBody>
              <Row label="Sources" hint="Add as many as you like. Each source can pin to a specific device, or follow the system default." vertical>
                <AudioSourcesList
                  sources={config.audio.sources}
                  setSources={srcs => patch("audio", { sources: srcs })}
                />
              </Row>
            </SectionBody>
          </SectionShell>

          {/* Output */}
          <SectionShell id="output">
            <SectionHeader num={4} title="Output" subtitle="Where finished clips land and how they're named." />
            <SectionBody>
              <Row label="Clips folder" hint="Where finished .mp4 files are written.">
                <DesignTextInput
                  value={config.output.directory}
                  onChange={v => patchOutput("directory", v)}
                  mono width={300}
                  trailing={
                    <button
                      onClick={() => invoke("open_clips_folder")}
                      style={{
                        height: 22, padding: "0 8px",
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
              <Row label="Filename prefix" hint="Numbered suffix is appended automatically — e.g. clipdip_0007.mp4.">
                <DesignTextInput value={config.output.filename_stem} onChange={v => patchOutput("filename_stem", v)} mono width={220} />
              </Row>
              <Row label="Audio bitrate" hint="Quality of the embedded AAC audio track.">
                <DesignSlider
                  value={config.output.audio_bitrate_bps}
                  onChange={v => patchOutput("audio_bitrate_bps", v)}
                  min={64_000} max={320_000} step={32_000}
                  format={v => `${(v / 1000).toFixed(0)} kbps`}
                />
              </Row>
              <Row label="Keep raw files" hint="Preserve the unmuxed sidecar files next to each clip.">
                <DesignToggle value={config.output.keep_sidecars} onChange={v => patchOutput("keep_sidecars", v)} />
              </Row>
              <Row label="FFmpeg path" hint="Leave blank to let ClipDip find a bundled or PATH-installed ffmpeg.">
                <DesignTextInput
                  value={config.output.ffmpeg_path || ""}
                  onChange={v => patchOutput("ffmpeg_path", v || null)}
                  placeholder="Auto-detect"
                  mono width={300}
                />
              </Row>
            </SectionBody>
          </SectionShell>

          {/* Hotkeys */}
          <SectionShell id="hotkeys">
            <SectionHeader num={5} title="Hotkeys" subtitle="Global shortcuts. Click any field and press the keys you want." />
            <SectionBody>
              <Row label="Save clip" hint="Captures the replay buffer into a new clip.">
                <HotkeyCapture value={config.hotkey.save_clip} onChange={v => patchHotkey("save_clip", v)} />
              </Row>
              <Row label="Rename last clip" hint="Focuses the rename field in the fly-in notification.">
                <HotkeyCapture value={config.hotkey.rename_clip} onChange={v => patchHotkey("rename_clip", v)} />
              </Row>
            </SectionBody>
          </SectionShell>

          {/* Notifications */}
          <SectionShell id="notifications">
            <SectionHeader num={6} title="Notifications" subtitle="The fly-in toast that appears whenever a clip is saved." />
            <SectionBody>
              <Row label="Show notification" hint="The clip-saved toast with rename input.">
                <DesignToggle value={config.notifications.enabled} onChange={v => patchNotif("enabled", v)} />
              </Row>
              <Row label="Play sound" hint="A short audible chirp when a clip lands.">
                <DesignToggle value={config.notifications.sound} onChange={v => patchNotif("sound", v)} disabled={!config.notifications.enabled} />
              </Row>
              <Row label="Position" hint="Where the notification appears on the active display.">
                <CornerPicker value={config.notifications.corner} onChange={v => patchNotif("corner", v)} />
              </Row>
              <Row label="Auto-dismiss" hint="How long the toast stays before sliding out. Set to 0 to keep it open.">
                <DesignSlider
                  value={config.notifications.auto_dismiss_secs}
                  onChange={v => patchNotif("auto_dismiss_secs", v)}
                  min={0} max={30} step={1}
                  format={v => v === 0 ? "Never" : `${v} s`}
                />
              </Row>
            </SectionBody>
          </SectionShell>

          <div style={{ height: 80 }} />
        </main>
      </div>
    </div>
  );
}
