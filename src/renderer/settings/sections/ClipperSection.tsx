import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Library, Play, RotateCcw, Square } from "lucide-react";
import { SetGroup, SetRow, StatusLine } from "../rows";
import Toggle from "../../ui/Toggle";
import Slider from "../../ui/Slider";
import Select from "../../ui/Select";
import { useSettings } from "../SettingsContext";
import { useToast } from "../../ui/Toast";
import type { ClipperConfig } from "../../../types/clips";

type ClipperStatus = {
  running: boolean;
  binaryFound: boolean;
  configExists: boolean;
  autostart: boolean;
};

// The clipper's own settings live in its TOML config (bridged over IPC by
// main/clipper.js), NOT in the library's settings.json — so this section
// keeps the TOML values in local state and saves via clipper.setConfig
// (which deep-merges and live-reloads the running clipper, debounced).
// Only enabled/autostart/binaryPath are library settings.
export default function ClipperSection() {
  const { settings, set } = useSettings();
  const toast = useToast();

  const enabled = Boolean(settings.clipper?.enabled);
  const autostart = Boolean(settings.clipper?.autostart);
  const binaryPath = String(settings.clipper?.binaryPath ?? "");

  const [status, setStatus] = useState<ClipperStatus | null>(null);
  const [config, setConfig] = useState<ClipperConfig | null>(null);
  const [busy, setBusy] = useState(false);

  // Status poll while the section is visible.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      window.clips.clipper
        .getStatus()
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    window.clips.clipper
      .getConfig()
      .then(({ config }) => setConfig(config))
      .catch(() => setConfig({}));
  }, []);

  // Optimistic local update + persisted patch. `patch` mirrors the TOML
  // structure ({ video: { fps: 30 } }); main debounces the clipper reload.
  const patch = useCallback(
    (p: Partial<ClipperConfig>) => {
      setConfig((prev) => {
        const next: ClipperConfig = structuredClone(prev ?? {});
        const merge = (t: Record<string, unknown>, s: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(s)) {
            if (
              v && typeof v === "object" && !Array.isArray(v) && !("mode" in v) &&
              t[k] && typeof t[k] === "object" && !Array.isArray(t[k])
            ) {
              merge(t[k] as Record<string, unknown>, v as Record<string, unknown>);
            } else {
              t[k] = v;
            }
          }
        };
        merge(next as Record<string, unknown>, p as Record<string, unknown>);
        return next;
      });
      window.clips.clipper.setConfig(p).catch(() => toast.show("Failed to save clipper setting", "error"));
    },
    [toast],
  );

  const toggleEnabled = async (on: boolean) => {
    // Persist first so main's settings cache is current when setEnabled
    // consults clipper.autostart.
    const ok = await set("clipper.enabled", on);
    if (!ok) {
      toast.show("Failed to save setting", "error");
      return;
    }
    setBusy(true);
    try {
      const result = await window.clips.clipper.setEnabled(on);
      if (!result.success) toast.show(result.error || "Clipper failed to start", "error");
    } finally {
      setBusy(false);
      refreshStatus();
    }
  };

  const toggleAutostart = async (on: boolean) => {
    const ok = await set("clipper.autostart", on);
    if (!ok) return void toast.show("Failed to save setting", "error");
    try {
      await window.clips.clipper.setAutostart(on);
    } catch {
      toast.show("Failed to update autostart registry entry", "error");
    }
    refreshStatus();
  };

  const refreshStatus = () => {
    window.clips.clipper.getStatus().then(setStatus).catch(() => {});
  };

  const runAction = async (action: () => Promise<{ success: boolean; error?: string }>) => {
    setBusy(true);
    try {
      const result = await action();
      if (!result.success) toast.show(result.error || "Clipper action failed", "error");
    } finally {
      setBusy(false);
      refreshStatus();
    }
  };

  const pickBinary = async () => {
    const file = await window.clips.openFolderDialog();
    if (file) {
      const ok = await set("clipper.binaryPath", file);
      if (!ok) toast.show("Failed to save setting", "error");
      refreshStatus();
    }
  };

  const pickOutputDir = async () => {
    const dir = await window.clips.openFolderDialog();
    if (dir) patch({ output: { directory: dir } });
  };

  const useLibraryFolder = async () => {
    const location = await window.clips.getClipLocation();
    if (location) {
      patch({ output: { directory: location } });
      toast.show("Clips will be saved straight into your library");
    }
  };

  const controlsDisabled = !enabled || !status?.binaryFound;
  const running = Boolean(status?.running);

  const recordingQualityMode =
    (config?.video?.recording_quality as { mode?: string } | undefined)?.mode ?? "constant_qp";

  return (
    <>
      <SetGroup
        title="Clipper"
        span2
        aside={
          <span className={`set-badge ${running ? "" : ""}`} style={{ opacity: 0.9 }}>
            {status == null
              ? "Checking…"
              : !status.binaryFound
                ? "Binary not found"
                : running
                  ? "● Running"
                  : "○ Stopped"}
          </span>
        }
      >
        <SetRow
          title="Enable clipper"
          description="Background replay-buffer recorder. Runs as its own tray app and keeps recording when the library is closed."
        >
          <Toggle checked={enabled} onChange={(v) => void toggleEnabled(v)} disabled={busy} aria-label="Enable clipper" />
        </SetRow>
        <SetRow
          title="Start with Windows"
          description="Launch the clipper on login — the library doesn't need to be running"
        >
          <Toggle
            checked={autostart}
            onChange={(v) => void toggleAutostart(v)}
            disabled={controlsDisabled}
            aria-label="Start clipper with Windows"
          />
        </SetRow>
        <SetRow
          title="Process"
          description={running ? "The clipper is recording into its replay buffer" : "The clipper is not running"}
          status={
            status && !status.binaryFound ? (
              <StatusLine tone="error">
                Clipper binary not found — set its location below.
              </StatusLine>
            ) : undefined
          }
        >
          <div style={{ display: "flex", gap: 8 }}>
            {running ? (
              <>
                <button type="button" className="btn" disabled={busy} onClick={() => void runAction(window.clips.clipper.restart)}>
                  <RotateCcw size={14} /> Restart
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void runAction(window.clips.clipper.stop)}>
                  <Square size={14} /> Stop
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={busy || !status?.binaryFound}
                onClick={() => void runAction(window.clips.clipper.start)}
              >
                <Play size={14} /> Start
              </button>
            )}
          </div>
        </SetRow>
        <SetRow
          title="Clipper binary"
          description={
            <span className="set-mono">{binaryPath || "Bundled (resources/clipper/clipdip.exe)"}</span>
          }
        >
          <button type="button" className="btn" onClick={() => void pickBinary()}>
            <FolderOpen size={14} /> Choose folder…
          </button>
        </SetRow>
      </SetGroup>

      <SetGroup title="Replay buffer">
        <SetRow title="Replay length" description="How much gameplay the save hotkey captures">
          <Slider
            value={Number(config?.replay_seconds ?? 60)}
            min={30}
            max={300}
            step={15}
            disabled={controlsDisabled || !config}
            onCommit={(v) => patch({ replay_seconds: v })}
            format={(v) => `${v}s`}
            aria-label="Replay length"
          />
        </SetRow>
      </SetGroup>

      <SetGroup title="Video">
        <SetRow title="Codec" description="AV1 needs an RTX 40-series GPU or newer; falls back to H.264">
          <Select
            value={String(config?.video?.codec ?? "prefer_av1")}
            disabled={controlsDisabled || !config}
            onChange={(v) => patch({ video: { codec: v } })}
            options={[
              { value: "prefer_av1", label: "Prefer AV1", hint: "AV1 when the GPU supports it" },
              { value: "force_h264", label: "H.264", hint: "Maximum compatibility" },
              { value: "force_av1", label: "AV1 only", hint: "Fails on unsupported GPUs" },
            ]}
            aria-label="Codec"
          />
        </SetRow>
        <SetRow title="Frame rate">
          <Select
            value={String(config?.video?.fps ?? 60)}
            disabled={controlsDisabled || !config}
            onChange={(v) => patch({ video: { fps: Number(v) } })}
            options={[
              { value: "30", label: "30 fps" },
              { value: "60", label: "60 fps" },
              { value: "120", label: "120 fps" },
            ]}
            width={140}
            aria-label="Frame rate"
          />
        </SetRow>
        <SetRow
          title="Recording quality boost"
          description="Manual recordings (hotkey start/stop) use higher quality than replay clips"
        >
          <Toggle
            checked={recordingQualityMode === "constant_qp"}
            disabled={controlsDisabled || !config}
            onChange={(v) =>
              patch({
                video: {
                  recording_quality: v ? { mode: "constant_qp", qp: 14 } : { mode: "match_clips" },
                },
              })
            }
            aria-label="Recording quality boost"
          />
        </SetRow>
        <SetRow title="Capture mouse cursor">
          <Toggle
            checked={config?.video?.include_cursor !== false}
            disabled={controlsDisabled || !config}
            onChange={(v) => patch({ video: { include_cursor: v } })}
            aria-label="Capture mouse cursor"
          />
        </SetRow>
      </SetGroup>

      <SetGroup title="Audio">
        <SetRow
          title="Tracks"
          description={
            <span className="set-mono">
              {(config?.audio?.sources ?? [])
                .map((s) => String((s as { kind?: string }).kind ?? "?").replace(/_/g, " "))
                .join(" + ") || "system loopback + microphone"}
            </span>
          }
        />
        <SetRow
          title="Combined mix track"
          description="Adds a first track mixing all sources — plays everywhere without track switching"
        >
          <Toggle
            checked={config?.audio?.include_mix !== false}
            disabled={controlsDisabled || !config}
            onChange={(v) => patch({ audio: { include_mix: v } })}
            aria-label="Combined mix track"
          />
        </SetRow>
      </SetGroup>

      <SetGroup title="Hotkeys">
        {(
          [
            ["save_clip", "Save clip", "Saves the replay buffer as a clip"],
            ["toggle_recording", "Toggle recording", "Start / stop a manual recording"],
            ["rename_clip", "Rename clip", "Rename from the save notification"],
          ] as const
        ).map(([key, title, description]) => (
          <SetRow key={key} title={title} description={description}>
            <HotkeyInput
              value={String(config?.hotkey?.[key] ?? "")}
              disabled={controlsDisabled || !config}
              onCommit={(v) => patch({ hotkey: { [key]: v } })}
            />
          </SetRow>
        ))}
      </SetGroup>

      <SetGroup title="Output" span2>
        <SetRow
          title="Save clips to"
          description={<span className="set-mono">{String(config?.output?.directory ?? "…\\Videos\\Clipdip")}</span>}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={controlsDisabled || !config}
              onClick={() => void useLibraryFolder()}
            >
              <Library size={14} /> Use library folder
            </button>
            <button
              type="button"
              className="btn"
              disabled={controlsDisabled || !config}
              onClick={() => void pickOutputDir()}
            >
              <FolderOpen size={14} /> Browse…
            </button>
          </div>
        </SetRow>
        <SetRow
          title="Filename template"
          description="Tokens: [app] [title] [type] [HH] [mm] [ss] [dd] [MM] [yyyy] and more"
        >
          <TextInput
            value={String(config?.output?.filename_stem ?? "")}
            disabled={controlsDisabled || !config}
            onCommit={(v) => patch({ output: { filename_stem: v } })}
            width={280}
          />
        </SetRow>
        <SetRow
          title="Keep raw sidecar files"
          description="Keeps the intermediate .h264/.wav files next to each clip — turn off when saving into your library"
        >
          <Toggle
            checked={config?.output?.keep_sidecars !== false}
            disabled={controlsDisabled || !config}
            onChange={(v) => patch({ output: { keep_sidecars: v } })}
            aria-label="Keep raw sidecar files"
          />
        </SetRow>
        <SetRow title="Audio bitrate" description="AAC bitrate per track in the saved MP4">
          <Select
            value={String(config?.output?.audio_bitrate_bps ?? 192000)}
            disabled={controlsDisabled || !config}
            onChange={(v) => patch({ output: { audio_bitrate_bps: Number(v) } })}
            options={[
              { value: "128000", label: "128 kbps" },
              { value: "192000", label: "192 kbps" },
              { value: "256000", label: "256 kbps" },
              { value: "320000", label: "320 kbps" },
            ]}
            width={140}
            aria-label="Audio bitrate"
          />
        </SetRow>
      </SetGroup>

      <SetGroup title="Notifications">
        <SetRow title="Show save notification">
          <Toggle
            checked={config?.notifications?.enabled !== false}
            disabled={controlsDisabled || !config}
            onChange={(v) => patch({ notifications: { enabled: v } })}
            aria-label="Show save notification"
          />
        </SetRow>
        <SetRow title="Sound">
          <Toggle
            checked={config?.notifications?.sound !== false}
            disabled={controlsDisabled || !config}
            onChange={(v) => patch({ notifications: { sound: v } })}
            aria-label="Notification sound"
          />
        </SetRow>
        <SetRow title="Corner">
          <Select
            value={String(config?.notifications?.corner ?? "top_right")}
            disabled={controlsDisabled || !config}
            onChange={(v) => patch({ notifications: { corner: v } })}
            options={[
              { value: "top_left", label: "Top left" },
              { value: "top_right", label: "Top right" },
              { value: "bottom_left", label: "Bottom left" },
              { value: "bottom_right", label: "Bottom right" },
            ]}
            width={160}
            aria-label="Notification corner"
          />
        </SetRow>
        <SetRow title="Auto-dismiss" description="0 keeps the notification until dismissed">
          <Slider
            value={Number(config?.notifications?.auto_dismiss_secs ?? 10)}
            min={0}
            max={30}
            step={1}
            disabled={controlsDisabled || !config}
            onCommit={(v) => patch({ notifications: { auto_dismiss_secs: v } })}
            format={(v) => (v === 0 ? "Off" : `${v}s`)}
            aria-label="Auto-dismiss"
          />
        </SetRow>
        <SetRow title="Health alerts" description="Warn when capture stalls or the buffer degrades">
          <Toggle
            checked={config?.notifications?.health_alerts !== false}
            disabled={controlsDisabled || !config}
            onChange={(v) => patch({ notifications: { health_alerts: v } })}
            aria-label="Health alerts"
          />
        </SetRow>
      </SetGroup>

      <SetGroup title="Game metadata">
        <SetRow
          title="Capture game info"
          description="Records which game each clip is from — the library uses it for titles and icons"
        >
          <Toggle
            checked={Boolean(config?.metadata?.enabled)}
            disabled={controlsDisabled || !config}
            onChange={(v) => patch({ metadata: { enabled: v } })}
            aria-label="Capture game info"
          />
        </SetRow>
        <SetRow title="Extract game icons">
          <Toggle
            checked={config?.metadata?.capture_icon !== false}
            disabled={controlsDisabled || !config || !config?.metadata?.enabled}
            onChange={(v) => patch({ metadata: { capture_icon: v } })}
            aria-label="Extract game icons"
          />
        </SetRow>
      </SetGroup>
    </>
  );
}

/** Text input that commits on blur/Enter (clipper settings write TOML + reload). */
function TextInput({
  value,
  onCommit,
  disabled,
  width = 200,
}: {
  value: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
  width?: number;
}) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  return (
    <input
      type="text"
      className="cliplib-input"
      style={{ width }}
      value={draft}
      disabled={disabled}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
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

/** Captures a key combo (modifiers + key) on keydown, like Ctrl+Alt+F10. */
function HotkeyInput({
  value,
  onCommit,
  disabled,
}: {
  value: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
}) {
  const [capturing, setCapturing] = useState(false);
  return (
    <input
      type="text"
      className="cliplib-input"
      style={{ width: 180, cursor: "pointer" }}
      value={capturing ? "Press keys…" : value}
      readOnly
      disabled={disabled}
      onFocus={() => setCapturing(true)}
      onBlur={() => setCapturing(false)}
      onKeyDown={(e) => {
        e.preventDefault();
        if (e.key === "Escape") return void (e.target as HTMLInputElement).blur();
        if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
        const parts: string[] = [];
        if (e.ctrlKey) parts.push("Ctrl");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");
        const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
        parts.push(key);
        onCommit(parts.join("+"));
        (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
