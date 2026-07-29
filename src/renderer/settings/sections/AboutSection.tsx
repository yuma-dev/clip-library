import { useEffect, useRef, useState } from "react";
import { Archive, ExternalLink, RefreshCw, UploadCloud } from "lucide-react";
import { SetGroup, SetRow, StatusLine } from "../rows";
import Toggle from "../../ui/Toggle";
import { useSettings } from "../SettingsContext";
import { clipdipBridge } from "./clipdip/ClipdipContext";
import { useToast } from "../../ui/Toast";
import { reportUpdateAvailable } from "../../shell/useUpdater";
import logoUrl from "../../../../assets/logo.png";

/** Both telemetry documents live at the repo root on the default branch. */
const TELEMETRY_DOC_URL = "https://github.com/yuma-dev/clip-library/blob/main/TELEMETRY.md";

type Tone = "info" | "progress" | "success" | "error";
interface Status {
  tone: Tone;
  text?: string;
  link?: string;
}

const DIAGNOSTICS_STAGE_LABELS: Record<string, string> = {
  initializing: "Preparing workspace",
  "system-info": "Collecting system info",
  logs: "Gathering logs",
  "settings-files": "Gathering settings files",
  "settings-snapshot": "Capturing settings snapshot",
  "activity-logs": "Bundling activity history",
  "console-buffers": "Capturing console output",
  clipdip: "Gathering clipdip logs and state",
  "crash-dumps": "Checking for crash dumps",
  complete: "Complete",
};

// Cycled through the note textarea's placeholder by the typing animation
// below. Written like real user reports on purpose (typos and all) so the
// field reads as "type something like this", not as UI copy.
const NOTE_EXAMPLES = [
  "my clips from last night arent showing up",
  "pressed the clip button and nothing got saved",
  "exported a clip and it has no sound",
  "thumbnails are just black squares for some clips",
  "clipdip keeps saying recording stopped every few minutes",
  "got a save failed notification, the file is 0 bytes",
  "app takes like 30 seconds to open since the update",
  "cant share clips, upload always fails at the end",
  "video stutters when i scrub through the timeline",
  "my valorant clips show the wrong game name",
  "app crashed when i deleted a bunch of clips at once",
  "replay buffer only goes back 20 seconds instead of 60",
  "clips save to the wrong folder since the last update",
  "trimmed a clip but the export is still full length",
  "search doesnt find clips i tagged yesterday",
  "ram usage climbs to 8gb after a few hours, see issue #42",
  "clip saved but its a black screen with audio",
  "the volume slider resets itself every time",
  "hotkey stopped working after i tabbed out of my game",
  "audio is out of sync on longer clips",
];

/**
 * Types example reports into the placeholder character by character, holds,
 * deletes fast, moves on to the next. Paused while the user has text (the
 * placeholder is invisible then anyway).
 */
function useTypedPlaceholder(active: boolean): string {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!active) return;
    let phraseIndex = Math.floor(Math.random() * NOTE_EXAMPLES.length);
    let pos = 0;
    let deleting = false;
    let timer: number;
    const tick = () => {
      const phrase = NOTE_EXAMPLES[phraseIndex];
      if (!deleting) {
        pos += 1;
        setText(phrase.slice(0, pos));
        if (pos >= phrase.length) {
          deleting = true;
          timer = window.setTimeout(tick, 2400);
        } else {
          timer = window.setTimeout(tick, 12 + Math.random() * 20);
        }
      } else {
        pos = Math.max(0, pos - 3);
        setText(phrase.slice(0, pos));
        if (pos === 0) {
          deleting = false;
          phraseIndex = (phraseIndex + 1) % NOTE_EXAMPLES.length;
          timer = window.setTimeout(tick, 600);
        } else {
          timer = window.setTimeout(tick, 14);
        }
      }
    };
    timer = window.setTimeout(tick, 400);
    return () => window.clearTimeout(timer);
  }, [active]);
  return text;
}

/** Open a link in the system browser (legacy diagnostics used shell.openExternal). */
function openExternal(url: string): void {
  try {
    const req = (window as unknown as { require?: (m: string) => { shell: { openExternal(u: string): void } } }).require;
    req?.("electron").shell.openExternal(url);
  } catch {
    /* ignore */
  }
}

function formatBytes(value: unknown): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function AboutSection() {
  const toast = useToast();
  const [version, setVersion] = useState("…");
  const [updateStatus, setUpdateStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);
  const manualUrlRef = useRef<string | null>(null);

  const [diagStatus, setDiagStatus] = useState<Status | null>(null);
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);

  const [uploadStatus, setUploadStatus] = useState<Status | null>(null);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState("");
  const typedPlaceholder = useTypedPlaceholder(note.length === 0);

  useEffect(() => {
    window.clips
      .getAppVersion()
      .then(setVersion)
      .catch(() => setVersion("unknown"));
  }, []);

  // Staged diagnostics progress from main while a bundle is being built.
  useEffect(() => {
    return window.clips.onDiagnosticsProgress((progress: { stage: string; completed?: number; total?: number; bytes?: number }) => {
      if (!generatingRef.current || !progress) return;
      const label = DIAGNOSTICS_STAGE_LABELS[progress.stage] ?? progress.stage;
      const total = Number(progress.total) || 0;
      const completed = Number(progress.completed) || 0;
      const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
      setDiagStatus({ tone: "progress", text: pct ? `${label} (${pct}%)` : label });
    });
  }, []);

  const checkUpdates = async () => {
    setChecking(true);
    setUpdateStatus(null);
    try {
      const result = await window.clips.checkForUpdates();
      if (result?.manualUpdateUrl) manualUrlRef.current = result.manualUpdateUrl;
      if (result?.updateAvailable) {
        setUpdateStatus({ tone: "success", text: `Update available: v${result.latestVersion}` });
        // Surface the rail pill too (legacy re-emitted show-update-notification).
        reportUpdateAvailable(result.latestVersion ?? null, result.changelog ?? null);
      } else if (result?.error === "network_unavailable") {
        setUpdateStatus({ tone: "error", text: 'Could not connect. You can still use "Open download page".' });
      } else if (result?.error === "rate_limited") {
        setUpdateStatus({ tone: "error", text: 'GitHub rate limit hit. You can use "Open download page".' });
      } else if (result?.error) {
        setUpdateStatus({ tone: "error", text: `Check failed: ${result.error}` });
      } else {
        setUpdateStatus({ tone: "info", text: `You're up to date! (v${result?.currentVersion ?? version})` });
      }
    } catch {
      setUpdateStatus({ tone: "error", text: "Failed to check for updates" });
    } finally {
      setChecking(false);
    }
  };

  const openDownloadPage = async () => {
    setOpening(true);
    try {
      const result = await window.clips.openUpdatePage(manualUrlRef.current);
      if (result?.url) manualUrlRef.current = result.url;
      if (result?.success) {
        setUpdateStatus({ tone: "info", text: "Opened the release page in your browser." });
      } else {
        setUpdateStatus({ tone: "error", text: result?.error ?? "Failed to open the release page." });
      }
    } catch (err) {
      setUpdateStatus({ tone: "error", text: (err as Error).message || "Failed to open the release page." });
    } finally {
      setOpening(false);
    }
  };

  const generateDiagnostics = async () => {
    if (generatingRef.current) return;
    try {
      const targetPath = await window.clips.showDiagnosticsSaveDialog();
      if (!targetPath) {
        setDiagStatus({ tone: "info", text: "Diagnostics generation cancelled." });
        return;
      }
      generatingRef.current = true;
      setGenerating(true);
      setDiagStatus({ tone: "progress", text: "Preparing diagnostics bundle…" });
      const response = await window.clips.generateDiagnosticsZip(targetPath, { note: note.trim() });
      if (!response?.success) throw new Error(response?.error ?? "Unknown error");
      const sizeText = typeof response.size === "number" ? ` (${formatBytes(response.size)})` : "";
      setDiagStatus({ tone: "success", text: `Saved to ${response.zipPath}${sizeText}` });
    } catch (err) {
      setDiagStatus({ tone: "error", text: `Failed to generate diagnostics: ${(err as Error).message}` });
    } finally {
      generatingRef.current = false;
      setGenerating(false);
    }
  };

  const uploadLogs = async () => {
    if (uploading) return;
    setUploading(true);
    // Reuse the zip stage progress while the bundle is being built.
    generatingRef.current = true;
    setUploadStatus({ tone: "progress", text: "Building and uploading bundle…" });
    try {
      const response = await window.clips.uploadDiagnosticsBundle({ note: note.trim() });
      if (!response?.success) throw new Error(response?.error ?? "Unknown error");
      if (response.bundleId != null) {
        const sizeText = typeof response.size === "number" ? ` (${formatBytes(response.size)})` : "";
        setUploadStatus({ tone: "success", text: `Uploaded bundle #${response.bundleId}${sizeText}` });
        toast.show("Diagnostics uploaded", "success");
      } else if (response.url) {
        // Text-upload fallback (build without an ingest key).
        setUploadStatus({ tone: "success", link: response.url });
        try {
          await navigator.clipboard.writeText(response.url);
          toast.show("Share link copied to clipboard", "success");
        } catch {
          /* clipboard denied — link is still shown */
        }
      } else {
        setUploadStatus({ tone: "success", text: "Uploaded." });
      }
    } catch (err) {
      setUploadStatus({ tone: "error", text: `Upload failed: ${(err as Error).message}` });
    } finally {
      setUploading(false);
      generatingRef.current = false;
      setDiagStatus(null);
    }
  };

  return (
    <>
      <div className="about-card span-2">
        <img className="about-logo" src={logoUrl} alt="" draggable={false} />
        <div className="about-text">
          <div className="about-name">
            ClipLib <span className="about-version">v{version}</span>
          </div>
          <div className="about-tag">A modern, fast, and efficient way to manage your clip collection.</div>
        </div>
      </div>

      <SetGroup title="Updates">
        <SetRow
          title="Check for updates"
          description="See if a newer version is available"
          status={updateStatus?.text ? <StatusLine tone={updateStatus.tone}>{updateStatus.text}</StatusLine> : undefined}
        >
          <div className="set-btn-row">
            <button type="button" className="btn btn-primary" disabled={checking} onClick={() => void checkUpdates()}>
              <RefreshCw size={14} className={checking ? "spin" : undefined} /> {checking ? "Checking…" : "Check now"}
            </button>
            <button type="button" className="btn" disabled={opening} onClick={() => void openDownloadPage()}>
              <ExternalLink size={14} /> Open download page
            </button>
          </div>
        </SetRow>
      </SetGroup>

      <TelemetryGroup />

      <SetGroup title="Report a problem">
        <SetRow
          stacked
          title="Describe the problem"
          description="What happened, when, and with which clip or game. If there's a GitHub issue for it, include the link or number."
        >
          <textarea
            className="cliplib-input"
            style={{ width: "100%", minHeight: 72, resize: "vertical" }}
            rows={3}
            value={note}
            spellCheck={false}
            placeholder={typedPlaceholder}
            onChange={(e) => setNote(e.target.value)}
          />
        </SetRow>
        <SetRow
          title="Send diagnostics"
          description="One bundle with logs, settings, and system info from both ClipLib and clipdip"
          status={
            <>
              {uploadStatus ? (
                <StatusLine tone={uploadStatus.tone}>
                  {uploadStatus.link ? (
                    <>
                      Uploaded. Share link:{" "}
                      <a
                        href={uploadStatus.link}
                        onClick={(e) => {
                          e.preventDefault();
                          if (uploadStatus.link) openExternal(uploadStatus.link);
                        }}
                      >
                        {uploadStatus.link}
                      </a>
                    </>
                  ) : (
                    uploadStatus.text
                  )}
                </StatusLine>
              ) : undefined}
              {diagStatus?.text ? <StatusLine tone={diagStatus.tone}>{diagStatus.text}</StatusLine> : undefined}
            </>
          }
        >
          <div className="set-btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={uploading || !note.trim()}
              title={note.trim() ? undefined : "Describe the problem first"}
              onClick={() => void uploadLogs()}
            >
              <UploadCloud size={14} /> {uploading ? "Uploading…" : "Export and upload"}
            </button>
            <button type="button" className="btn" disabled={generating} onClick={() => void generateDiagnostics()}>
              <Archive size={14} /> {generating ? "Generating…" : "Save zip"}
            </button>
          </div>
        </SetRow>
      </SetGroup>
    </>
  );
}

// Both automatic-telemetry switches, in one place on purpose.
//
// ClipLib and clipdip report separately and are stored separately: ClipLib's
// lives in settings.json (main applies it immediately in the save-settings
// handler), clipdip's lives in its own config and is toggled over the control
// server. A user who turns "telemetry" off in the clipdip section would
// reasonably believe they turned all of it off, so the ClipLib switch cannot
// live somewhere else. The clipdip section keeps its copy of the clipdip row.
function TelemetryGroup() {
  const { settings, set } = useSettings();
  const toast = useToast();

  const cliplibEnabled = settings.telemetry?.enabled !== false;
  const [clipdip, setClipdip] = useState<{ enabled: boolean; configured: boolean } | null>(null);
  const [clipdipBusy, setClipdipBusy] = useState(false);

  // One read on mount. clipdip answers only while it is running; the section
  // that polls this lives under Settings → Clipdip and is not open here.
  useEffect(() => {
    let cancelled = false;
    clipdipBridge()
      .getTelemetryStatus()
      .then((r) => {
        if (cancelled || !r.ok) return;
        setClipdip({ enabled: Boolean(r.enabled), configured: Boolean(r.configured) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleCliplib = async (on: boolean) => {
    const ok = await set("telemetry.enabled", on);
    if (!ok) toast.show("Failed to save setting", "error");
  };

  const toggleClipdip = async (on: boolean) => {
    setClipdipBusy(true);
    setClipdip((s) => (s ? { ...s, enabled: on } : s));
    try {
      const r = await clipdipBridge().setTelemetryEnabled(on);
      if (!r.ok) {
        setClipdip((s) => (s ? { ...s, enabled: !on } : s));
        toast.show("Failed to update clipdip diagnostics", "error");
      }
    } catch {
      setClipdip((s) => (s ? { ...s, enabled: !on } : s));
      toast.show("Failed to update clipdip diagnostics", "error");
    } finally {
      setClipdipBusy(false);
    }
  };

  const clipdipAvailable = Boolean(clipdip?.configured);

  return (
    <SetGroup title="Anonymous diagnostics" span2>
      <SetRow
        title="ClipLib"
        description="Crashes, failures the app couldn't show you, and timing numbers, sent with random ids. Crash reports include a tail of ClipLib's log. No file names, no clip names, no tags, no account info."
      >
        <Toggle
          checked={cliplibEnabled}
          onChange={(v) => void toggleCliplib(v)}
          aria-label="Send anonymous ClipLib diagnostics"
        />
      </SetRow>
      <SetRow
        title="Clipdip"
        description={
          clipdipAvailable
            ? "Crashes, capture and encoder failures, and basic hardware info from the recorder, sent with random ids. Error reports include a tail of clipdip's log."
            : "Available while Clipdip is running"
        }
        status={
          <StatusLine tone="info">
            Two separate switches. Turning one off leaves the other one sending.
          </StatusLine>
        }
      >
        <Toggle
          checked={clipdip?.enabled ?? true}
          onChange={(v) => void toggleClipdip(v)}
          disabled={clipdipBusy || !clipdipAvailable}
          aria-label="Send anonymous clipdip diagnostics"
        />
      </SetRow>
      <SetRow
        title="What gets sent"
        description="The full list, what is never sent, and how long any of it is kept."
      >
        <button type="button" className="btn" onClick={() => openExternal(TELEMETRY_DOC_URL)}>
          <ExternalLink size={14} /> Read TELEMETRY.md
        </button>
      </SetRow>
    </SetGroup>
  );
}
