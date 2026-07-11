import { useEffect, useState } from "react";
import { ExternalLink, FolderOpen, Library } from "lucide-react";
import { SetGroup, SetRow } from "../../rows";
import Toggle from "../../../ui/Toggle";
import Slider from "../../../ui/Slider";
import { useToast } from "../../../ui/Toast";
import { clipdipBridge, useClipdip } from "./ClipdipContext";
import { CommitInput } from "./controls";

export default function ClipdipOutputSection() {
  const { config, patch, live, running, filenameVars, ensureFilenameVars } = useClipdip();
  const toast = useToast();
  useEffect(() => ensureFilenameVars(), [ensureFilenameVars]);

  const loading = !config;
  const output = config?.output;
  const template = String(output?.filename_stem ?? "[app] [HH].[mm].[ss] - [dd].[MM].[yyyy]");

  // Live filename preview, debounced while typing.
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const previewSource = draft ?? template;
  useEffect(() => {
    const t = window.setTimeout(() => {
      clipdipBridge()
        .previewFilename(previewSource)
        .then((r) => {
          if (r.ok && r.preview != null) setPreview(r.preview);
        })
        .catch(() => {});
    }, 150);
    return () => window.clearTimeout(t);
  }, [previewSource]);

  const [varsOpen, setVarsOpen] = useState(false);

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

  const openFolder = async () => {
    try {
      const r = await clipdipBridge().openClipsFolder();
      if (!r.ok) toast.show("Start Clipdip to open its folder", "error");
    } catch {
      toast.show("Failed to open folder", "error");
    }
  };

  const insertToken = (token: string) => {
    const next = `${previewSource}[${token}]`;
    patch({ output: { filename_stem: next } });
    setDraft(null);
  };

  return (
    <>
      <SetGroup title="Files" span2>
        <SetRow title="Clips folder">
          <CommitInput
            value={String(output?.directory ?? "")}
            mono
            width={300}
            disabled={loading}
            onCommit={(v) => patch({ output: { directory: v } })}
          />
          <button type="button" className="btn" disabled={loading} onClick={() => void useLibraryFolder()}>
            <Library size={14} /> Use library folder
          </button>
          <button type="button" className="btn" disabled={loading} onClick={() => void pickOutputDir()}>
            <FolderOpen size={14} /> Browse
          </button>
          <button type="button" className="btn" title="Open folder" onClick={() => void openFolder()}>
            <ExternalLink size={14} />
          </button>
        </SetRow>
        <SetRow
          title="Filename"
          description="A number like (2) is appended only when the name is already taken"
          stacked
        >
          <CommitInput
            value={template}
            mono
            width={340}
            disabled={loading}
            onDraft={setDraft}
            onCommit={(v) => {
              patch({ output: { filename_stem: v } });
              setDraft(null);
            }}
          />
          <div className="clipdip-infobox filename-help">
            <div className="filename-help-head">
              <span className="filename-help-preview">
                Preview: <b className="set-mono">{preview}.mp4</b>
              </span>
              {filenameVars.length ? (
                <button type="button" className="cliplib-link" onClick={() => setVarsOpen(!varsOpen)}>
                  {varsOpen ? "Hide variables" : "Show variables"}
                </button>
              ) : null}
            </div>
            {varsOpen ? (
              <div className="filename-help-vars">
                {filenameVars.map((v) => (
                  <div key={v.token} className="filename-help-var">
                    <button type="button" className="filename-chip" onClick={() => insertToken(v.token)}>
                      [{v.token}]
                    </button>
                    <span className="filename-help-desc">{v.description}</span>
                    {v.example ? <span className="filename-help-example set-mono">{v.example}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </SetRow>
        <SetRow title="Audio bitrate" description="AAC bitrate per track in the saved MP4">
          <Slider
            value={Number(output?.audio_bitrate_bps ?? 192000)}
            min={64000}
            max={320000}
            step={32000}
            disabled={loading}
            onCommit={(v) => patch({ output: { audio_bitrate_bps: v } })}
            format={(v) => `${Math.round(v / 1000)} kbps`}
            aria-label="Audio bitrate"
          />
        </SetRow>
      </SetGroup>

      <SetGroup title="Game metadata">
        <SetRow
          title="Capture game metadata"
          description="Records which game each clip is from. The library uses it for titles and icons."
        >
          <Toggle
            checked={Boolean(config?.metadata?.enabled)}
            disabled={loading}
            onChange={(v) => patch({ metadata: { enabled: v } })}
            aria-label="Capture game metadata"
          />
        </SetRow>
        <SetRow title="Extract game icon">
          <Toggle
            checked={config?.metadata?.capture_icon !== false}
            disabled={loading || !config?.metadata?.enabled}
            onChange={(v) => patch({ metadata: { capture_icon: v } })}
            aria-label="Extract game icon"
          />
        </SetRow>
      </SetGroup>

      <SetGroup title="Discord">
        <SetRow title="Save Discord call info" description="Saves who you were in a call with on clip capture">
          <Toggle
            checked={config?.discord?.enabled !== false}
            disabled={loading}
            onChange={(v) => patch({ discord: { enabled: v } })}
            aria-label="Save Discord call info"
          />
        </SetRow>
        {config?.discord?.enabled !== false ? <DiscordConnection running={running} status={live?.discord} /> : null}
      </SetGroup>

      <SetGroup title="Advanced" span2>
        <SetRow
          title="Keep raw files"
          description="Keeps the intermediate .h264/.wav files next to each clip"
        >
          <Toggle
            checked={output?.keep_sidecars !== false}
            disabled={loading}
            onChange={(v) => patch({ output: { keep_sidecars: v } })}
            aria-label="Keep raw files"
          />
        </SetRow>
        <SetRow
          title="FFmpeg path"
          description="Managed by ClipLib unless overridden. Leave empty for the bundled ffmpeg."
        >
          <CommitInput
            value={String(output?.ffmpeg_path ?? "")}
            mono
            width={300}
            disabled={loading}
            onCommit={(v) => patch({ output: { ffmpeg_path: (v.trim() || null) as unknown as string } })}
          />
        </SetRow>
      </SetGroup>
    </>
  );
}

// Live Discord connection status (from the 2 s live-status poll) with
// Connect/Disconnect via the control server.
function DiscordConnection({
  running,
  status,
}: {
  running: boolean;
  status?: { state: string; user?: string; message?: string };
}) {
  const [busy, setBusy] = useState(false);
  const st = status?.state;
  const connected = st === "connected";
  const featureOff = st === "disabled";

  const text = !running
    ? "Start Clipdip to connect"
    : st === "connected"
      ? `Connected as ${status?.user ?? "?"}`
      : st === "connecting"
        ? "Connecting"
        : st === "discord_not_running"
          ? "Discord not running"
          : st === "needs_authorization"
            ? "Not connected"
            : st === "error"
              ? "Connection error"
              : featureOff
                ? "Unavailable in this build"
                : "Checking";

  const connect = async () => {
    setBusy(true);
    try {
      await clipdipBridge().discordConnect();
    } catch {
      // status poll will surface the state
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    try {
      await clipdipBridge().discordDisconnect();
    } catch {
      // status poll will surface the state
    }
  };

  return (
    <SetRow title="Connection" description={status?.message}>
      <span className={`clipdip-conn${connected ? " connected" : ""}`}>{text}</span>
      {running && !featureOff ? (
        connected ? (
          <button type="button" className="btn" onClick={() => void disconnect()}>
            Disconnect
          </button>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={() => void connect()}>
            {busy ? "Connecting" : "Connect"}
          </button>
        )
      ) : null}
    </SetRow>
  );
}
