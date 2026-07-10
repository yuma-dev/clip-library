import { useEffect, useRef, useState } from "react";
import { Archive, ExternalLink, RefreshCw, UploadCloud } from "lucide-react";
import { SetGroup, SetRow, StatusLine } from "../rows";
import { useToast } from "../../ui/Toast";
import { reportUpdateAvailable } from "../../shell/useUpdater";
import logoUrl from "../../../../assets/logo.png";

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
  complete: "Complete",
};

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
      const response = await window.clips.generateDiagnosticsZip(targetPath);
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
    setUploadStatus({ tone: "progress", text: "Uploading logs…" });
    try {
      const response = await window.clips.uploadSessionLogs({ rendererConsoleLogs: "" });
      if (!response?.success) throw new Error(response?.error ?? "Unknown error");
      if (response.url) {
        setUploadStatus({ tone: "success", link: response.url });
        try {
          await navigator.clipboard.writeText(response.url);
          toast.show("Share link copied to clipboard", "success");
        } catch {
          /* clipboard denied — link is still shown */
        }
      } else {
        setUploadStatus({ tone: "success", text: "Uploaded. Share link not provided." });
      }
    } catch (err) {
      setUploadStatus({ tone: "error", text: `Upload failed: ${(err as Error).message}` });
    } finally {
      setUploading(false);
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

      <SetGroup title="Diagnostics">
        <SetRow
          title="Generate diagnostics zip"
          description="Bundle logs, settings, and system info to share for troubleshooting"
          status={diagStatus?.text ? <StatusLine tone={diagStatus.tone}>{diagStatus.text}</StatusLine> : undefined}
        >
          <button type="button" className="btn" disabled={generating} onClick={() => void generateDiagnostics()}>
            <Archive size={14} /> {generating ? "Generating…" : "Generate zip"}
          </button>
        </SetRow>
        <SetRow
          title="Upload session logs"
          description="Upload the current run's logs and get a shareable link"
          status={
            uploadStatus ? (
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
            ) : undefined
          }
        >
          <button type="button" className="btn" disabled={uploading} onClick={() => void uploadLogs()}>
            <UploadCloud size={14} /> {uploading ? "Uploading…" : "Upload logs"}
          </button>
        </SetRow>
      </SetGroup>
    </>
  );
}
