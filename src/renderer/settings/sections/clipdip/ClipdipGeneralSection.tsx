import { useEffect, useState } from "react";
import { FolderOpen, Play, RotateCcw, Square, Upload } from "lucide-react";
import { SetGroup, SetRow, StatusLine } from "../../rows";
import Toggle from "../../../ui/Toggle";
import { useSettings } from "../../SettingsContext";
import { useToast } from "../../../ui/Toast";
import { clipdipBridge, useClipdip, usePoll } from "./ClipdipContext";
import { ClipdipStatusBadge } from "./controls";

// Clipdip's own settings live in its TOML config; only enabled/binaryPath are
// library settings. Autostart's source of truth is the bridge (registry via
// getStatus().autostart), not settings.json.
export default function ClipdipGeneralSection() {
  const { settings, set } = useSettings();
  const toast = useToast();
  const { status, refreshStatus, running } = useClipdip();

  const enabled = Boolean(settings.clipdip?.enabled);
  const binaryPath = String(settings.clipdip?.binaryPath ?? "");
  const [busy, setBusy] = useState(false);
  const unsupported = status?.supported === false;

  const toggleEnabled = async (on: boolean) => {
    const ok = await set("clipdip.enabled", on);
    if (!ok) {
      toast.show("Failed to save setting", "error");
      return;
    }
    setBusy(true);
    try {
      const result = await clipdipBridge().setEnabled(on);
      if (!result.success) toast.show(result.error || "Clipdip failed to start", "error");
    } finally {
      setBusy(false);
      refreshStatus();
    }
  };

  const toggleAutostart = async (on: boolean) => {
    try {
      const r = await clipdipBridge().setAutostart(on);
      if (!r.success) toast.show("Failed to update autostart", "error");
    } catch {
      toast.show("Failed to update autostart", "error");
    }
    refreshStatus();
  };

  const runAction = async (action: () => Promise<{ success: boolean; error?: string }>) => {
    setBusy(true);
    try {
      const result = await action();
      if (!result.success) toast.show(result.error || "Clipdip action failed", "error");
    } finally {
      setBusy(false);
      refreshStatus();
    }
  };

  const pickBinary = async () => {
    const file = await window.clips.openFolderDialog();
    if (file) {
      const ok = await set("clipdip.binaryPath", file);
      if (!ok) toast.show("Failed to save setting", "error");
      refreshStatus();
    }
  };

  return (
    <>
      <SetGroup title="Clipdip" span2 aside={<ClipdipStatusBadge />}>
        <SetRow
          title="Enable Clipdip"
          description="Background replay-buffer recorder. Runs as its own tray app and keeps recording when the library is closed."
          status={
            unsupported ? (
              <StatusLine tone="error">
                {status?.unsupportedReason ?? "This machine can't run Clipdip."}
              </StatusLine>
            ) : undefined
          }
        >
          <Toggle
            checked={enabled && !unsupported}
            onChange={(v) => void toggleEnabled(v)}
            disabled={busy || unsupported}
            aria-label="Enable Clipdip"
          />
        </SetRow>
        <SetRow title="Start with Windows">
          <Toggle
            checked={Boolean(status?.autostart)}
            onChange={(v) => void toggleAutostart(v)}
            disabled={!status || !status.binaryFound || unsupported}
            aria-label="Start Clipdip with Windows"
          />
        </SetRow>
        <SetRow
          title="Process"
          description={running ? "Clipdip is recording into its replay buffer" : "Clipdip is not running"}
          status={
            status && !status.binaryFound ? (
              <StatusLine tone="error">Clipdip binary not found. Set its location below.</StatusLine>
            ) : undefined
          }
        >
          <div className="set-btn-row">
            {running ? (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void runAction(() => clipdipBridge().restart())}
                >
                  <RotateCcw size={14} /> Restart
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void runAction(() => clipdipBridge().stop())}
                >
                  <Square size={14} /> Stop
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={busy || !status?.binaryFound}
                onClick={() => void runAction(() => clipdipBridge().start())}
              >
                <Play size={14} /> Start
              </button>
            )}
          </div>
        </SetRow>
        <SetRow
          title="Clipdip binary"
          description={<span className="set-mono">{binaryPath || "Bundled (resources/clipdip/clipdip.exe)"}</span>}
        >
          <button type="button" className="btn" onClick={() => void pickBinary()}>
            <FolderOpen size={14} /> Choose folder
          </button>
        </SetRow>
      </SetGroup>

      <TelemetryGroup />
    </>
  );
}

// Anonymous, opt-out diagnostics. Reads/writes its own state via the control
// server (deliberately outside the config round-trip, so toggling never
// restarts the pipeline). Requires a running clipdip.
function TelemetryGroup() {
  const { running } = useClipdip();
  const [telemetry, setTelemetry] = useState<{ enabled: boolean; configured: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<"idle" | "working" | "done" | "error">("idle");
  const [uploadDetail, setUploadDetail] = useState<string | null>(null);

  useEffect(() => {
    if (!running) setTelemetry(null);
  }, [running]);

  usePoll(
    () => {
      clipdipBridge()
        .getTelemetryStatus()
        .then((r) => {
          if (r.ok) setTelemetry({ enabled: Boolean(r.enabled), configured: Boolean(r.configured) });
        })
        .catch(() => {});
    },
    30000,
    running,
  );

  const configured = Boolean(telemetry?.configured);
  const available = running && configured;

  const toggle = async (v: boolean) => {
    setBusy(true);
    setTelemetry((s) => (s ? { ...s, enabled: v } : s));
    try {
      const r = await clipdipBridge().setTelemetryEnabled(v);
      if (!r.ok) setTelemetry((s) => (s ? { ...s, enabled: !v } : s));
    } catch {
      setTelemetry((s) => (s ? { ...s, enabled: !v } : s));
    } finally {
      setBusy(false);
    }
  };

  const doUpload = async () => {
    setUpload("working");
    setUploadDetail(null);
    try {
      const r = await clipdipBridge().uploadDiagnostics(null);
      if (r.ok) {
        setUpload("done");
        const id = (r as Record<string, unknown>).id ?? (r as Record<string, unknown>).result;
        if (id != null && typeof id !== "object") setUploadDetail(String(id));
      } else {
        setUpload("error");
        setUploadDetail(r.error ?? null);
      }
    } catch {
      setUpload("error");
    }
  };

  return (
    <SetGroup title="Diagnostics" span2>
      <SetRow
        title="Send anonymous diagnostics"
        description={
          !running
            ? "Available while Clipdip is running"
            : configured
              ? "Capture failures and crashes with a random install ID. No account, no personal data."
              : "Not available in this build"
        }
      >
        <Toggle
          checked={telemetry?.enabled ?? true}
          onChange={(v) => void toggle(v)}
          disabled={busy || !available}
          aria-label="Send anonymous diagnostics"
        />
      </SetRow>
      <SetRow
        title="Diagnostic bundle"
        description="Zips logs and config and uploads them for debugging"
        status={
          upload === "done" ? (
            <StatusLine tone="success">Uploaded{uploadDetail ? ` (${uploadDetail})` : ""}</StatusLine>
          ) : upload === "error" ? (
            <StatusLine tone="error">Upload failed{uploadDetail ? `: ${uploadDetail}` : ""}</StatusLine>
          ) : undefined
        }
      >
        <button
          type="button"
          className="btn"
          disabled={!available || upload === "working"}
          onClick={() => void doUpload()}
        >
          <Upload size={14} /> {upload === "working" ? "Uploading" : "Export and upload"}
        </button>
      </SetRow>
    </SetGroup>
  );
}
