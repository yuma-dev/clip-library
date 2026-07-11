import { useEffect } from "react";
import { Gauge } from "lucide-react";
import { SetGroup, SetRow } from "../../rows";
import Toggle from "../../../ui/Toggle";
import Slider from "../../../ui/Slider";
import Select from "../../../ui/Select";
import { useClipdip } from "./ClipdipContext";
import { Disclosure, PresetSlider } from "./controls";

type RateControl = { mode: "constant_qp"; qp: number } | { mode: "vbr"; avg_bps: number };
type RecordingQuality = { mode: "match_clips" } | { mode: "constant_qp"; qp: number };

// Named quality presets over the encoder's QP (+6 QP roughly halves size).
const QUALITY_PRESETS = [
  { qp: 32, label: "Space saver", desc: "Visibly compressed, about a quarter of High quality's size" },
  { qp: 26, label: "Balanced", desc: "Looks great in motion at about half of High quality's size" },
  { qp: 20, label: "High quality", desc: "Crisp, clean picture. The default" },
  { qp: 16, label: "Maximum", desc: "Near-perfect picture, large files" },
];

// Quality while a manual recording runs. qp null = match clips (no boost).
const RECORDING_PRESETS: { qp: number | null; label: string; desc: string }[] = [
  { qp: null, label: "Match clips", desc: "Recordings use the same quality as replay clips" },
  { qp: 16, label: "High", desc: "Noticeably crisper than clips with a modest size bump" },
  { qp: 14, label: "Studio", desc: "About twice the clip bitrate, clean enough for YouTube masters. The default" },
  { qp: 12, label: "Near-lossless", desc: "Practically indistinguishable from the source, very large files" },
];

export default function ClipdipVideoSection() {
  const { config, patch, monitors, ensureMonitors } = useClipdip();
  useEffect(() => ensureMonitors(), [ensureMonitors]);

  const loading = !config;
  const video = config?.video;
  const rateControl = (video?.rate_control as unknown as RateControl | undefined) ?? { mode: "constant_qp", qp: 20 };
  const recQuality =
    (video?.recording_quality as unknown as RecordingQuality | undefined) ?? { mode: "constant_qp", qp: 14 };

  const presetIdx =
    rateControl.mode === "constant_qp" ? QUALITY_PRESETS.findIndex((p) => p.qp === rateControl.qp) : -1;
  const recPresetIdx =
    recQuality.mode === "match_clips" ? 0 : RECORDING_PRESETS.findIndex((p) => p.qp === recQuality.qp);

  const monitorOptions = monitors.length
    ? monitors.map((m) => ({
        value: String(m.index),
        label: `Display ${m.index + 1}${m.is_primary ? " · primary" : ""}`,
        hint: `${m.width} × ${m.height}`,
      }))
    : [0, 1, 2].map((i) => ({ value: String(i), label: `Display ${i + 1}` }));

  return (
    <>
      <SetGroup title="Replay buffer" span2>
        <SetRow title="Replay length" description="The longest clip you can save. Changing it restarts the buffer.">
          <Slider
            value={Number(config?.replay_seconds ?? 60)}
            min={10}
            max={300}
            step={5}
            disabled={loading}
            onCommit={(v) => patch({ replay_seconds: v })}
            format={(v) => `${v} s`}
            aria-label="Replay length"
          />
        </SetRow>
        <SizeEstimate replaySeconds={Number(config?.replay_seconds ?? 60)} />
      </SetGroup>

      <SetGroup title="Capture">
        <SetRow title="Monitor" description="Multi-monitor setups capture one display at a time">
          <Select
            value={String(video?.output_index ?? 0)}
            disabled={loading}
            onChange={(v) => patch({ video: { output_index: Number(v) } })}
            options={monitorOptions}
            width={220}
            aria-label="Monitor"
          />
        </SetRow>
        <SetRow title="Frame rate">
          <Slider
            value={Number(video?.fps ?? 60)}
            min={30}
            max={240}
            step={1}
            disabled={loading}
            onCommit={(v) => patch({ video: { fps: v } })}
            format={(v) => `${v} fps`}
            aria-label="Frame rate"
          />
        </SetRow>
        <SetRow title="Codec" description="AV1 needs an RTX 40-series GPU or newer">
          <Select
            value={String(video?.codec ?? "prefer_av1")}
            disabled={loading}
            onChange={(v) => patch({ video: { codec: v as "prefer_av1" | "force_h264" | "force_av1" } })}
            options={[
              { value: "prefer_av1", label: "Prefer AV1", hint: "Falls back to H.264 if unsupported" },
              { value: "force_h264", label: "H.264", hint: "Widest compatibility" },
              { value: "force_av1", label: "AV1 only", hint: "Fails on unsupported GPUs" },
            ]}
            width={220}
            aria-label="Codec"
          />
        </SetRow>
        <SetRow title="Include cursor">
          <Toggle
            checked={video?.include_cursor !== false}
            disabled={loading}
            onChange={(v) => patch({ video: { include_cursor: v } })}
            aria-label="Include cursor"
          />
        </SetRow>
      </SetGroup>

      <SetGroup title="Quality">
        <SetRow
          title="Quality and size"
          description={presetIdx === -1 ? "Custom encoder settings are active (see Advanced)" : QUALITY_PRESETS[presetIdx].desc}
        >
          <PresetSlider
            presets={QUALITY_PRESETS}
            activeIndex={presetIdx}
            disabled={loading}
            onPick={(i) => patch({ video: { rate_control: { mode: "constant_qp", qp: QUALITY_PRESETS[i].qp } } })}
            aria-label="Quality and size"
          />
        </SetRow>
        <SetRow
          title="Recording quality"
          description={
            rateControl.mode !== "constant_qp"
              ? "Only applies in Constant quality mode"
              : recPresetIdx === -1
                ? "A custom recording QP is active (see Advanced)"
                : RECORDING_PRESETS[recPresetIdx].desc
          }
        >
          <PresetSlider
            presets={RECORDING_PRESETS}
            activeIndex={recPresetIdx}
            disabled={loading}
            onPick={(i) => {
              const p = RECORDING_PRESETS[i];
              patch({
                video: {
                  recording_quality: p.qp === null ? { mode: "match_clips" } : { mode: "constant_qp", qp: p.qp },
                },
              });
            }}
            aria-label="Recording quality"
          />
        </SetRow>

        <Disclosure>
          <SetRow
            title="Quality mode"
            description="Constant quality lets bitrate float with the scene. Variable bitrate pins an average target."
          >
            <Select
              value={rateControl.mode}
              disabled={loading}
              onChange={(mode) =>
                patch({
                  video: {
                    rate_control:
                      mode === "constant_qp"
                        ? { mode: "constant_qp", qp: 20 }
                        : { mode: "vbr", avg_bps: Number(video?.bitrate_bps ?? 30_000_000) },
                  },
                })
              }
              options={[
                { value: "constant_qp", label: "Constant quality", hint: "Recommended" },
                { value: "vbr", label: "Variable bitrate", hint: "Pin an average data rate" },
              ]}
              width={200}
              aria-label="Quality mode"
            />
          </SetRow>
          {rateControl.mode === "constant_qp" ? (
            <SetRow title="Quality (QP)" description="Lower is better quality and larger files. +6 halves the size.">
              <Slider
                value={rateControl.qp}
                min={1}
                max={51}
                step={1}
                disabled={loading}
                onCommit={(qp) => patch({ video: { rate_control: { mode: "constant_qp", qp } } })}
                format={(v) => `QP ${v}`}
                aria-label="Quality QP"
              />
            </SetRow>
          ) : (
            <SetRow title="Target bitrate" description="25 Mbps is sane for 1080p60">
              <Slider
                value={rateControl.avg_bps}
                min={5_000_000}
                max={80_000_000}
                step={500_000}
                disabled={loading}
                onCommit={(avg_bps) =>
                  patch({ video: { rate_control: { mode: "vbr", avg_bps }, bitrate_bps: avg_bps } })
                }
                format={(v) => `${(v / 1_000_000).toFixed(1)} Mbps`}
                aria-label="Target bitrate"
              />
            </SetRow>
          )}
          {rateControl.mode === "constant_qp" && recQuality.mode === "constant_qp" ? (
            <SetRow
              title="Recording QP"
              description="QP while a manual recording runs. A recording never encodes worse than clips."
            >
              <Slider
                value={recQuality.qp}
                min={1}
                max={51}
                step={1}
                disabled={loading}
                onCommit={(qp) => patch({ video: { recording_quality: { mode: "constant_qp", qp } } })}
                format={(v) => `QP ${v}`}
                aria-label="Recording QP"
              />
            </SetRow>
          ) : null}
          <SetRow title="Keyframe interval" description="Lower is more seek-friendly but heavier">
            <Slider
              value={Number(video?.gop_seconds ?? 1)}
              min={0.5}
              max={5}
              step={0.1}
              disabled={loading}
              onCommit={(v) => patch({ video: { gop_seconds: v } })}
              format={(v) => `${v.toFixed(1)} s`}
              aria-label="Keyframe interval"
            />
          </SetRow>
          <SetRow
            title="Capture method"
            description="Auto is recommended. DXGI is blind to fullscreen games."
          >
            <Select
              value={String(video?.capture_backend ?? "auto")}
              disabled={loading}
              onChange={(v) => patch({ video: { capture_backend: v as "auto" | "wgc" | "dxgi" } })}
              options={[
                { value: "auto", label: "Auto", hint: "WGC, falls back to DXGI" },
                { value: "wgc", label: "Windows Graphics Capture", hint: "Captures fullscreen games reliably" },
                { value: "dxgi", label: "DXGI Desktop Duplication", hint: "Legacy" },
              ]}
              width={230}
              aria-label="Capture method"
            />
          </SetRow>
        </Disclosure>
      </SetGroup>
    </>
  );
}

// Live file-size readout, measured from the actual encoded bytes in the
// replay ring (buffer_stats via the 2 s live-status poll).
function SizeEstimate({ replaySeconds }: { replaySeconds: number }) {
  const { live, running } = useClipdip();
  const stats = live?.buffer_stats;
  const fmt = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));

  return (
    <div className="clipdip-infobox">
      <Gauge size={13} className="clipdip-infobox-icon" />
      {!running ? (
        <span>Size estimate is available while Clipdip is running.</span>
      ) : stats?.measuring ? (
        <span>
          At current screen activity: about <b>{fmt(stats.mb_per_minute)} MB per minute</b>, a {replaySeconds} s clip
          is about <b>{fmt(stats.clip_mb)} MB</b>. Quality changes apply right away.
        </span>
      ) : (
        <span>Measuring clip size from the live buffer</span>
      )}
    </div>
  );
}
