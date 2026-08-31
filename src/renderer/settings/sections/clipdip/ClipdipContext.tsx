import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useToast } from "../../../ui/Toast";
import type { ClipdipConfig } from "../../../../types/clips";

// ---------------------------------------------------------------------------
// Local shapes for the clipdip bridge (main/clipdip.js control surface). The
// canonical types live in src/types/clips.d.ts; these stay structural so this
// module compiles independently of that file's exact export names.
// ---------------------------------------------------------------------------

export interface AudioDeviceInfo {
  id: string;
  friendly_name: string;
  flow: "Render" | "Capture";
  is_default: boolean;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  is_primary?: boolean;
}

export interface FilenameVariable {
  token: string;
  description: string;
  example?: string;
}

export interface DiscordStatus {
  state:
    | "disabled"
    | "connecting"
    | "discord_not_running"
    | "needs_authorization"
    | "connected"
    | "error";
  user?: string;
  message?: string;
}

export interface BufferStats {
  measuring: boolean;
  mb_per_minute: number;
  clip_mb: number;
  buffered_secs: number;
  /** True while the replay window is truncated by the ring's memory ceiling. */
  memory_limited?: boolean;
  bytes_used_mb?: number;
  budget_mb?: number;
}

export interface NotificationRecord {
  /** Unix epoch milliseconds when the notification was shown. */
  at_ms: number;
  kind: "health" | "clip" | "recording" | "notice" | "error" | string;
  title: string;
  body: string;
}

export interface AudioSourceStatus {
  index: number;
  kind: "system_loopback" | "microphone";
  wanted: string;
  using: string | null;
  on_fallback: boolean;
  missing: boolean;
}

export interface LiveStatus {
  pipeline_running?: boolean;
  pipeline_error?: string | null;
  buffer_stats?: BufferStats;
  discord?: DiscordStatus;
  audio_sources?: AudioSourceStatus[];
  version?: string;
}

export interface ProcessStatus {
  running: boolean;
  binaryFound: boolean;
  configExists: boolean;
  autostart: boolean;
  /** false when the machine can't run clipdip (non-Windows / no NVIDIA GPU). */
  supported?: boolean;
  unsupportedReason?: string | null;
}

type Ok<T = Record<string, never>> = { ok: boolean; error?: string } & Partial<T>;

interface ClipdipBridge {
  getConfig(): Promise<{ exists: boolean; config: ClipdipConfig }>;
  setConfig(patch: Partial<ClipdipConfig>): Promise<{ success: boolean }>;
  getStatus(): Promise<ProcessStatus>;
  start(): Promise<{ success: boolean; error?: string }>;
  stop(): Promise<{ success: boolean }>;
  restart(): Promise<{ success: boolean; error?: string }>;
  setAutostart(enabled: boolean): Promise<{ success: boolean }>;
  setEnabled(enabled: boolean): Promise<{ success: boolean; error?: string }>;
  listAudioDevices(): Promise<Ok<{ devices: AudioDeviceInfo[] }>>;
  listMonitors(): Promise<Ok<{ monitors: MonitorInfo[] }>>;
  getFilenameVariables(): Promise<Ok<{ variables: FilenameVariable[] }>>;
  previewFilename(template: string): Promise<Ok<{ preview: string }>>;
  control(cmd: string, args?: object): Promise<Ok<Record<string, unknown>>>;
  getLiveStatus(): Promise<Ok<LiveStatus>>;
  testOverlay(stage: "flow" | "notice" | "rec_on" | "rec_off"): Promise<Ok>;
  discordConnect(): Promise<Ok>;
  discordDisconnect(): Promise<Ok>;
  getTelemetryStatus(): Promise<Ok<{ enabled: boolean; configured: boolean; install_id: string | null }>>;
  setTelemetryEnabled(enabled: boolean): Promise<Ok>;
  uploadDiagnostics(note: string | null): Promise<Ok<Record<string, unknown>>>;
  openClipsFolder(): Promise<Ok>;
}

export function clipdipBridge(): ClipdipBridge {
  return window.clips.clipdip as unknown as ClipdipBridge;
}

// ---------------------------------------------------------------------------
// Polling helper: runs `fn` every `ms` while `active`, pauses while the
// document is hidden, cleans up on unmount.
// ---------------------------------------------------------------------------

export function usePoll(fn: () => void, ms: number, active: boolean) {
  useEffect(() => {
    if (!active) return;
    let timer: number | null = null;
    const start = () => {
      if (timer != null) return;
      fn();
      timer = window.setInterval(fn, ms);
    };
    const stop = () => {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const onVis = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [fn, ms, active]);
}

// ---------------------------------------------------------------------------
// Shared clipdip state: TOML config (optimistic patch), process status poll,
// live control-server status poll, and lazily fetched device / monitor /
// filename-variable lists.
// ---------------------------------------------------------------------------

interface ClipdipCtx {
  config: ClipdipConfig | null;
  patch: (p: Partial<ClipdipConfig>) => void;
  status: ProcessStatus | null;
  refreshStatus: () => void;
  setStatus: (s: ProcessStatus) => void;
  /** Live control-server status; null when clipdip is not reachable. */
  live: LiveStatus | null;
  running: boolean;
  devices: AudioDeviceInfo[];
  devicesLoading: boolean;
  ensureDevices: () => void;
  refreshDevices: () => void;
  monitors: MonitorInfo[];
  ensureMonitors: () => void;
  filenameVars: FilenameVariable[];
  ensureFilenameVars: () => void;
}

const Ctx = createContext<ClipdipCtx | null>(null);

export function useClipdip(): ClipdipCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useClipdip must be used within <ClipdipProvider>");
  return ctx;
}

export function ClipdipProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const toast = useToast();
  const [config, setConfigState] = useState<ClipdipConfig | null>(null);
  const [status, setStatus] = useState<ProcessStatus | null>(null);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [filenameVars, setFilenameVars] = useState<FilenameVariable[]>([]);

  const loadedConfig = useRef(false);
  const loadedDevices = useRef(false);
  const loadedMonitors = useRef(false);
  const loadedVars = useRef(false);

  // Config: loaded once on first activation.
  useEffect(() => {
    if (!active || loadedConfig.current) return;
    loadedConfig.current = true;
    clipdipBridge()
      .getConfig()
      .then(({ config }) => setConfigState(config ?? {}))
      .catch(() => setConfigState({}));
  }, [active]);

  // Optimistic local update + persisted patch. Tagged-enum tables
  // (rate_control, recording_quality — objects with a `mode` key) are
  // replaced whole, mirroring main's deepMerge guard.
  const patch = useCallback(
    (p: Partial<ClipdipConfig>) => {
      setConfigState((prev) => {
        const next: ClipdipConfig = structuredClone(prev ?? {});
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
      clipdipBridge()
        .setConfig(p)
        .catch(() => toast.show("Failed to save clipdip setting", "error"));
    },
    [toast],
  );

  // Process status: 4 s poll while a clipdip section is visible.
  const pollStatus = useCallback(() => {
    clipdipBridge().getStatus().then(setStatus).catch(() => {});
  }, []);
  usePoll(pollStatus, 4000, active);

  const running = Boolean(status?.running);

  // Live status via the control server: 2 s poll while visible and running.
  const pollLive = useCallback(() => {
    clipdipBridge()
      .getLiveStatus()
      .then((r) => setLive(r.ok ? r : null))
      .catch(() => setLive(null));
  }, []);
  usePoll(pollLive, 2000, active && running);
  useEffect(() => {
    if (!running) setLive(null);
  }, [running]);

  const refreshDevices = useCallback(() => {
    loadedDevices.current = true;
    setDevicesLoading(true);
    clipdipBridge()
      .listAudioDevices()
      .then((r) => {
        if (r.ok && r.devices) setDevices(r.devices);
      })
      .catch(() => {})
      .finally(() => setDevicesLoading(false));
  }, []);

  const ensureDevices = useCallback(() => {
    if (!loadedDevices.current) refreshDevices();
  }, [refreshDevices]);

  const ensureMonitors = useCallback(() => {
    if (loadedMonitors.current) return;
    loadedMonitors.current = true;
    clipdipBridge()
      .listMonitors()
      .then((r) => {
        if (r.ok && r.monitors) setMonitors(r.monitors);
      })
      .catch(() => {});
  }, []);

  const ensureFilenameVars = useCallback(() => {
    if (loadedVars.current) return;
    loadedVars.current = true;
    clipdipBridge()
      .getFilenameVariables()
      .then((r) => {
        if (r.ok && r.variables) setFilenameVars(r.variables);
      })
      .catch(() => {});
  }, []);

  return (
    <Ctx.Provider
      value={{
        config,
        patch,
        status,
        refreshStatus: pollStatus,
        setStatus,
        live,
        running,
        devices,
        devicesLoading,
        ensureDevices,
        refreshDevices,
        monitors,
        ensureMonitors,
        filenameVars,
        ensureFilenameVars,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
