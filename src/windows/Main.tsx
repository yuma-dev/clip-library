import { useEffect, useState, useCallback } from "react";
import { invoke, listen } from "@/lib/tauri";
import {
  Video,
  Monitor,
  Mic,
  Keyboard,
  Bell,
  FolderOpen,
  Zap,
  CheckCircle,
  AlertCircle,
  ChevronRight,
  Plus,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { SettingRow, SettingSection } from "@/components/settings/SettingRow";
import { formatBitrate } from "@/lib/utils";

// ---------- types -----------------------------------------------------------

interface AudioSource {
  kind: "system_loopback" | "microphone" | "process_loopback";
  device_id?: string;
  process_name?: string;
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

// ---------- nav items -------------------------------------------------------

const NAV = [
  { id: "recording",     label: "Recording",     icon: Video    },
  { id: "video",         label: "Video",          icon: Monitor  },
  { id: "audio",         label: "Audio",          icon: Mic      },
  { id: "hotkeys",       label: "Hotkeys",        icon: Keyboard },
  { id: "notifications", label: "Notifications",  icon: Bell     },
  { id: "output",        label: "Output",         icon: FolderOpen },
] as const;

type NavId = (typeof NAV)[number]["id"];

// ---------- hotkey recorder -------------------------------------------------

function HotkeyRecorder({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);

  const start = () => { setRecording(true); setHeld([]); };

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();

      const mods: string[] = [];
      if (e.ctrlKey)  mods.push("Ctrl");
      if (e.altKey)   mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      if (e.metaKey)  mods.push("Win");

      const key = e.code;
      const friendly =
        key.startsWith("F") && !isNaN(Number(key.slice(1))) ? key :
        key.startsWith("Key") ? key.slice(3) :
        key.startsWith("Digit") ? key.slice(5) :
        key;

      if (["ControlLeft","ControlRight","AltLeft","AltRight","ShiftLeft","ShiftRight","MetaLeft","MetaRight"].includes(key)) {
        setHeld(mods);
        return;
      }

      const combo = [...mods, friendly].join("+");
      onChange(combo);
      setRecording(false);
      setHeld([]);
    },
    [recording, onChange]
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  return (
    <div className="flex items-center gap-2">
      <div
        className={`min-w-[180px] rounded-lg border px-3 py-2 text-sm font-mono text-center cursor-pointer select-none transition-colors ${
          recording
            ? "border-accent bg-accent/10 text-accent animate-pulse"
            : "border-bg-border bg-bg-surface text-text hover:border-accent/50"
        }`}
        onClick={start}
        title="Click then press your desired hotkey"
      >
        {recording
          ? held.length ? held.join("+") + "+…" : "Press keys…"
          : value || "Not set"}
      </div>
      {recording && (
        <Button size="sm" variant="ghost" onClick={() => { setRecording(false); setHeld([]); }}>
          Cancel
        </Button>
      )}
    </div>
  );
}

// ---------- main component --------------------------------------------------

export default function MainWindow() {
  const [config, setConfig] = useState<Config | null>(null);
  const [activeNav, setActiveNav] = useState<NavId>("recording");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);

  // Load config
  useEffect(() => {
    invoke<Config>("get_config")
      .then(setConfig)
      .catch(() => {
        // Outside Tauri (browser preview) — use defaults
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
    const unlisten1 = listen<string>("pipeline-error", (e) => setPipelineError(e.payload));
    const unlisten2 = listen<{ running: boolean }>("pipeline-status", (e) =>
      setPipelineRunning(e.payload.running)
    );
    return () => { unlisten1.then(f => f()); unlisten2.then(f => f()); };
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
      <div className="flex h-full items-center justify-center bg-bg-base">
        <div className="text-text-muted text-sm">Loading configuration…</div>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-bg-base select-none overflow-hidden">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="flex w-[200px] flex-shrink-0 flex-col border-r border-bg-border bg-bg-surface">
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent shadow-glow-sm">
            <Zap className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-bold tracking-tight text-text">Clipdip</div>
            <div className="text-[10px] text-text-muted">v0.1.0</div>
          </div>
        </div>

        <Separator />

        {/* Status badge */}
        <div className="px-4 py-3">
          <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
            pipelineError
              ? "bg-danger/10 text-danger border border-danger/20"
              : pipelineRunning
              ? "bg-success/10 text-success border border-success/20"
              : "bg-bg-raised text-text-muted border border-bg-border"
          }`}>
            <div className={`h-1.5 w-1.5 rounded-full ${
              pipelineError ? "bg-danger" : pipelineRunning ? "bg-success animate-pulse" : "bg-text-faint"
            }`} />
            {pipelineError ? "Error" : pipelineRunning ? "Recording" : "Starting…"}
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-1">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveNav(id)}
              className={`mb-0.5 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all ${
                activeNav === id
                  ? "bg-accent/15 text-accent font-medium"
                  : "text-text-muted hover:bg-bg-raised hover:text-text"
              }`}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {label}
              {activeNav === id && <ChevronRight className="ml-auto h-3 w-3" />}
            </button>
          ))}
        </nav>

        {/* Open folder */}
        <div className="border-t border-bg-border p-3">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-text-muted"
            onClick={() => invoke("open_clips_folder")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open Clips Folder
          </Button>
        </div>
      </aside>

      {/* ── Main Content ─────────────────────────────────────────────────── */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-bg-border px-7 py-4">
          <div>
            <h2 className="text-base font-semibold text-text">
              {NAV.find(n => n.id === activeNav)?.label}
            </h2>
            {pipelineError && (
              <p className="mt-0.5 text-xs text-danger flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {pipelineError}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {saveStatus === "saved" && (
              <span className="flex items-center gap-1 text-xs text-success">
                <CheckCircle className="h-3.5 w-3.5" /> Saved
              </span>
            )}
            {saveStatus === "error" && (
              <span className="flex items-center gap-1 text-xs text-danger">
                <AlertCircle className="h-3.5 w-3.5" /> Save failed
              </span>
            )}
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-7 py-6 space-y-5">
          {/* ── Recording ─────────────────────────────────────── */}
          {activeNav === "recording" && (
            <>
              <SettingSection title="Replay Buffer">
                <SettingRow
                  label="Replay duration"
                  description="How many seconds of footage are kept in the buffer. Longer = more RAM."
                >
                  <div className="flex items-center gap-4">
                    <Slider
                      min={10} max={300} step={10}
                      value={[config.replay_seconds]}
                      onValueChange={([v]) => patch("replay_seconds", v)}
                      className="w-40"
                    />
                    <span className="w-14 text-right text-sm font-mono text-accent">
                      {config.replay_seconds}s
                    </span>
                  </div>
                </SettingRow>
              </SettingSection>

              <div className="rounded-xl border border-bg-border bg-gradient-to-br from-accent/5 to-transparent p-5">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent/20">
                    <Zap className="h-4 w-4 text-accent" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-text">How it works</div>
                    <p className="mt-1 text-xs text-text-muted leading-relaxed">
                      Clipdip continuously records your screen and audio in a ring buffer.
                      Press your save hotkey at any moment to save the last{" "}
                      <span className="text-accent font-medium">{config.replay_seconds}s</span> as
                      an MP4 file. No full recordings, only the moments that matter.
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ── Video ─────────────────────────────────────────── */}
          {activeNav === "video" && (
            <SettingSection title="Video Capture">
              <SettingRow label="Frame rate" description="Capture and encode FPS. 60 recommended for smooth clips.">
                <div className="flex items-center gap-3">
                  <Slider min={15} max={120} step={15} value={[config.video.fps]}
                    onValueChange={([v]) => patchVideo("fps", v)} className="w-36" />
                  <span className="w-16 text-right text-sm font-mono text-accent">{config.video.fps} fps</span>
                </div>
              </SettingRow>

              <SettingRow label="Bitrate" description="Higher = better quality, more storage. 25 Mbps is a good default for 1080p60.">
                <div className="flex items-center gap-3">
                  <Slider min={5_000_000} max={100_000_000} step={5_000_000}
                    value={[config.video.bitrate_bps]}
                    onValueChange={([v]) => patchVideo("bitrate_bps", v)} className="w-36" />
                  <span className="w-20 text-right text-sm font-mono text-accent">
                    {formatBitrate(config.video.bitrate_bps)}
                  </span>
                </div>
              </SettingRow>

              <SettingRow label="Monitor" description="Which display to capture (0 = primary).">
                <Select
                  value={String(config.video.output_index)}
                  onValueChange={v => patchVideo("output_index", Number(v))}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[0, 1, 2, 3].map(i => (
                      <SelectItem key={i} value={String(i)}>Monitor {i}{i === 0 ? " (primary)" : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>

              <SettingRow label="Include cursor" description="Composite the mouse cursor onto each captured frame.">
                <Switch
                  checked={config.video.include_cursor}
                  onCheckedChange={v => patchVideo("include_cursor", v)}
                />
              </SettingRow>

              <SettingRow label="Keyframe interval" description="How often a full keyframe (IDR) is inserted. Affects seek accuracy.">
                <div className="flex items-center gap-3">
                  <Slider min={0.5} max={4} step={0.5}
                    value={[config.video.gop_seconds]}
                    onValueChange={([v]) => patchVideo("gop_seconds", v)} className="w-32" />
                  <span className="w-14 text-right text-sm font-mono text-accent">
                    {config.video.gop_seconds}s
                  </span>
                </div>
              </SettingRow>
            </SettingSection>
          )}

          {/* ── Audio ─────────────────────────────────────────── */}
          {activeNav === "audio" && (
            <>
              <SettingSection title="Audio Sources">
                {config.audio.sources.length === 0 && (
                  <div className="py-6 text-center text-sm text-text-muted">
                    No audio sources configured. Add one below.
                  </div>
                )}
                {config.audio.sources.map((src, i) => (
                  <SettingRow
                    key={i}
                    label={src.kind === "system_loopback" ? "System Audio" : "Microphone"}
                    description={src.device_id ? `Device: ${src.device_id.slice(-20)}` : "Default device"}
                  >
                    <div className="flex items-center gap-2">
                      <Select
                        value={src.kind}
                        onValueChange={v => {
                          const next = [...config.audio.sources];
                          next[i] = { kind: v as AudioSource["kind"] };
                          setConfig(p => p ? { ...p, audio: { sources: next } } : p);
                        }}
                      >
                        <SelectTrigger className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="system_loopback">System Audio</SelectItem>
                          <SelectItem value="microphone">Microphone</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="danger"
                        size="icon"
                        onClick={() => {
                          const next = config.audio.sources.filter((_, j) => j !== i);
                          setConfig(p => p ? { ...p, audio: { sources: next } } : p);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </SettingRow>
                ))}
              </SettingSection>

              {config.audio.sources.length < 4 && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setConfig(p =>
                        p ? { ...p, audio: { sources: [...p.audio.sources, { kind: "system_loopback" }] } } : p
                      )
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add System Audio
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setConfig(p =>
                        p ? { ...p, audio: { sources: [...p.audio.sources, { kind: "microphone" }] } } : p
                      )
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Microphone
                  </Button>
                </div>
              )}
            </>
          )}

          {/* ── Hotkeys ───────────────────────────────────────── */}
          {activeNav === "hotkeys" && (
            <>
              <SettingSection title="Global Hotkeys">
                <SettingRow
                  label="Save clip"
                  description="Press this from anywhere — even inside games — to save the current replay buffer as an MP4."
                >
                  <HotkeyRecorder
                    value={config.hotkey.save_clip}
                    onChange={v => patchHotkey("save_clip", v)}
                  />
                </SettingRow>

                <SettingRow
                  label="Rename clip"
                  description="When a clip notification is on screen, press this to focus the rename input."
                >
                  <HotkeyRecorder
                    value={config.hotkey.rename_clip}
                    onChange={v => patchHotkey("rename_clip", v)}
                  />
                </SettingRow>
              </SettingSection>

              <div className="rounded-xl border border-bg-border bg-bg-surface p-4 text-xs text-text-muted space-y-1.5">
                <p className="font-medium text-text">Tips for choosing hotkeys</p>
                <p>• Use <span className="font-mono bg-bg-raised px-1 rounded">Ctrl+Alt+FN</span> combos — they're almost never claimed by other apps or games.</p>
                <p>• Avoid <span className="font-mono bg-bg-raised px-1 rounded">Ctrl+Shift+S</span> (conflicts with OneDrive / browsers).</p>
                <p>• Clipdip uses Raw Input so hotkeys work in fullscreen-exclusive games.</p>
              </div>
            </>
          )}

          {/* ── Notifications ─────────────────────────────────── */}
          {activeNav === "notifications" && (
            <SettingSection title="Clip Saved Notification">
              <SettingRow label="Enable notifications" description="Show an overlay when a clip is saved.">
                <Switch
                  checked={config.notifications.enabled}
                  onCheckedChange={v => patchNotif("enabled", v)}
                />
              </SettingRow>

              <SettingRow label="Play sound" description="Play a chime sound when a clip is saved.">
                <Switch
                  checked={config.notifications.sound}
                  onCheckedChange={v => patchNotif("sound", v)}
                  disabled={!config.notifications.enabled}
                />
              </SettingRow>

              <SettingRow
                label="Position"
                description="Corner of the screen where the notification appears."
              >
                <Select
                  value={config.notifications.corner}
                  onValueChange={v => patchNotif("corner", v)}
                  disabled={!config.notifications.enabled}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="top_left">Top Left</SelectItem>
                    <SelectItem value="top_right">Top Right</SelectItem>
                    <SelectItem value="bottom_left">Bottom Left</SelectItem>
                    <SelectItem value="bottom_right">Bottom Right</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>

              <SettingRow
                label="Auto-dismiss"
                description="Seconds before the notification fades away automatically. 0 = stay until dismissed."
              >
                <div className="flex items-center gap-3">
                  <Slider
                    min={0} max={30} step={1}
                    value={[config.notifications.auto_dismiss_secs]}
                    onValueChange={([v]) => patchNotif("auto_dismiss_secs", v)}
                    disabled={!config.notifications.enabled}
                    className="w-32"
                  />
                  <span className="w-14 text-right text-sm font-mono text-accent">
                    {config.notifications.auto_dismiss_secs === 0
                      ? "Never"
                      : `${config.notifications.auto_dismiss_secs}s`}
                  </span>
                </div>
              </SettingRow>
            </SettingSection>
          )}

          {/* ── Output ────────────────────────────────────────── */}
          {activeNav === "output" && (
            <>
              <SettingSection title="File Output">
                <SettingRow
                  label="Clips folder"
                  description="Directory where MP4 clips are saved."
                >
                  <div className="flex items-center gap-2">
                    <Input
                      className="w-64 font-mono text-xs"
                      value={config.output.directory}
                      onChange={e => patchOutput("directory", e.target.value)}
                    />
                    <Button
                      variant="subtle"
                      size="icon"
                      onClick={() => invoke("open_clips_folder")}
                      title="Open folder"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </SettingRow>

                <SettingRow
                  label="Filename prefix"
                  description="Saved clips are named {prefix}-{timestamp}.mp4"
                >
                  <Input
                    className="w-48 font-mono text-xs"
                    value={config.output.filename_stem}
                    onChange={e => patchOutput("filename_stem", e.target.value)}
                  />
                </SettingRow>

                <SettingRow
                  label="Audio bitrate"
                  description="AAC bitrate for audio tracks in the output MP4."
                >
                  <div className="flex items-center gap-3">
                    <Slider
                      min={64_000} max={320_000} step={32_000}
                      value={[config.output.audio_bitrate_bps]}
                      onValueChange={([v]) => patchOutput("audio_bitrate_bps", v)}
                      className="w-36"
                    />
                    <span className="w-20 text-right text-sm font-mono text-accent">
                      {formatBitrate(config.output.audio_bitrate_bps)}
                    </span>
                  </div>
                </SettingRow>

                <SettingRow
                  label="Keep raw files"
                  description="Retain the intermediate .h264 and .wav files after muxing. Useful for debugging."
                >
                  <Switch
                    checked={config.output.keep_sidecars}
                    onCheckedChange={v => patchOutput("keep_sidecars", v)}
                  />
                </SettingRow>
              </SettingSection>

              <SettingSection title="FFmpeg">
                <SettingRow
                  label="FFmpeg path"
                  description='Path to ffmpeg binary. Leave empty to use the bundled copy or "ffmpeg" on PATH.'
                >
                  <Input
                    className="w-64 font-mono text-xs"
                    value={config.output.ffmpeg_path ?? ""}
                    placeholder="(auto-detect)"
                    onChange={e => patchOutput("ffmpeg_path", e.target.value || null)}
                  />
                </SettingRow>
              </SettingSection>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
