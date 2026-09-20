import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Pause, Play, Sparkles } from "lucide-react";
import { SetGroup } from "../rows";
import Toggle from "../../ui/Toggle";
import Slider from "../../ui/Slider";
import { useSettings } from "../SettingsContext";
import type { UseClips } from "../../library/useClips";
import { useAnalysis } from "../../shell/useAnalysis";
import type { LoudnessEntry, LoudnessSummary } from "../../../types/clips";

const TARGET_MIN = -30;
const TARGET_MAX = -8;
const FALLBACK_TARGET = -16;
// histogram spans this range in 1 LU buckets; anything outside lands on the edge bucket
const HIST_MIN = -40;
const HIST_MAX = -6;

/** same math as main/loudness.js gainFromEntry, so the page shows what the player will do */
function gainDbFor(e: LoudnessEntry, target: number, headroom: number, maxGain: number) {
  const wanted = target - e.lufs;
  let db = wanted;
  if (e.peak != null) db = Math.min(db, headroom - e.peak);
  db = Math.max(-maxGain, Math.min(maxGain, db));
  return { db, capped: db < wanted - 0.05 };
}

function fmtDb(db: number) {
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

function fmtLufs(v: number) {
  return `${v.toFixed(1)} LUFS`;
}

function displayName(lib: UseClips, name: string) {
  const clip = lib.clips.find((c) => c.originalName === name);
  const raw = clip?.customName || name;
  return raw.replace(/\.[a-z0-9]+$/i, "");
}

interface Sample {
  key: "quiet" | "typical" | "loud";
  label: string;
  entry: LoudnessEntry;
}

export default function LoudnessSection({ lib }: { lib: UseClips }) {
  const { settings, set } = useSettings();
  const enabled = settings.loudness?.enabled ?? true;
  const analysis = useAnalysis();
  const [summary, setSummary] = useState<LoudnessSummary | null>(null);
  const [draftTarget, setDraftTarget] = useState<number | null>(null);
  const [compareOriginal, setCompareOriginal] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);

  const refresh = useCallback(() => {
    window.clips
      .getLoudnessSummary()
      .then((s) => setSummary(s))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, enabled, settings.loudness?.targetLufs]);

  // entries trickle in while the analysis runs; a periodic refresh keeps the chart growing, and
  // one more once the queue drains
  useEffect(() => {
    if (!analysis.running) {
      refresh();
      return;
    }
    const iv = window.setInterval(refresh, 4000);
    return () => window.clearInterval(iv);
  }, [refresh, analysis.running]);

  const entries = summary?.entries ?? [];
  const headroom = summary?.headroomDbtp ?? -1;
  const maxGain = summary?.maxGainDb ?? 12;
  const explicitTarget = settings.loudness?.targetLufs ?? null;
  const median = summary?.median ?? null;
  const target = draftTarget ?? explicitTarget ?? median ?? FALLBACK_TARGET;
  const isAuto = explicitTarget == null && draftTarget == null;

  const stats = useMemo(() => {
    if (entries.length === 0) return null;
    let capped = 0;
    let onTarget = 0;
    const moves: number[] = [];
    for (const e of entries) {
      const g = gainDbFor(e, target, headroom, maxGain);
      if (g.capped) capped += 1;
      if (Math.abs(g.db) <= 1) onTarget += 1;
      moves.push(Math.abs(g.db));
    }
    moves.sort((a, b) => a - b);
    return { capped, onTarget, typicalMove: moves[Math.floor(moves.length / 2)] };
  }, [entries, target, headroom, maxGain]);

  const histogram = useMemo(() => {
    const buckets = new Array(HIST_MAX - HIST_MIN + 1).fill(0) as number[];
    for (const e of entries) {
      const i = Math.max(0, Math.min(buckets.length - 1, Math.round(e.lufs) - HIST_MIN));
      buckets[i] += 1;
    }
    return { buckets, max: Math.max(1, ...buckets) };
  }, [entries]);

  const samples = useMemo<Sample[]>(() => {
    if (entries.length < 1) return [];
    const sorted = [...entries].sort((a, b) => a.lufs - b.lufs);
    const quiet = sorted[0];
    const loud = sorted[sorted.length - 1];
    const typical = sorted[Math.floor(sorted.length / 2)];
    const out: Sample[] = [{ key: "quiet", label: "Quietest", entry: quiet }];
    if (typical !== quiet) out.push({ key: "typical", label: "Typical", entry: typical });
    if (loud !== quiet && loud !== typical) out.push({ key: "loud", label: "Loudest", entry: loud });
    return out;
  }, [entries]);

  // one hidden <video> through a gain node: previews play exactly the gain the player would apply
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<{ ctx: AudioContext; gain: GainNode } | null>(null);

  const ensureAudio = () => {
    const video = videoRef.current;
    if (!video) return null;
    if (!audioRef.current) {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      ctx.createMediaElementSource(video).connect(gain);
      gain.connect(ctx.destination);
      audioRef.current = { ctx, gain };
    }
    return audioRef.current;
  };

  const gainForName = useCallback(
    (name: string) => {
      const e = entries.find((x) => x.name === name);
      if (!e || compareOriginal) return 1;
      return Math.pow(10, gainDbFor(e, target, headroom, maxGain).db / 20);
    },
    [entries, compareOriginal, target, headroom, maxGain],
  );

  // target drag or A/B flip retunes the running preview without restarting it
  useEffect(() => {
    if (!playing || !audioRef.current) return;
    const { ctx, gain } = audioRef.current;
    gain.gain.setTargetAtTime(gainForName(playing), ctx.currentTime, 0.03);
  }, [playing, gainForName]);

  const stop = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    setPlaying(null);
  }, []);

  const play = async (name: string) => {
    const video = videoRef.current;
    if (!video) return;
    if (playing === name) {
      stop();
      return;
    }
    const audio = ensureAudio();
    if (!audio) return;
    if (audio.ctx.state === "suspended") await audio.ctx.resume().catch(() => undefined);
    audio.gain.gain.setValueAtTime(gainForName(name), audio.ctx.currentTime);
    const start = Number(await window.clips.getPreviewStartTime(name).catch(() => 0)) || 0;
    const location = String(settings.clipLocation ?? "");
    video.src = `file://${location.replace(/\\/g, "/")}/${name}`;
    video.currentTime = start;
    setPlaying(name);
    video.play().catch(() => setPlaying(null));
  };

  useEffect(() => () => stop(), [stop]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onEnded = () => setPlaying(null);
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
  }, []);

  const chartW = 600;
  const chartH = 120;
  const barW = chartW / histogram.buckets.length;
  const targetX = ((target - HIST_MIN + 0.5) / histogram.buckets.length) * chartW;
  const medianX = median != null ? ((median - HIST_MIN + 0.5) / histogram.buckets.length) * chartW : null;

  return (
    <SetGroup
      title="Loudness match"
      span2
      aside={
        <Toggle checked={enabled} onChange={(v) => void set("loudness.enabled", v)} aria-label="Enable loudness match" />
      }
    >
      <p className="set-group-blurb">
        Plays every clip at about the same loudness, so you stop reaching for the volume between clips. Clips where you set a
        volume yourself keep it. Your files are never changed. Turn it off and everything is back to how it was.
      </p>

      <div className={`loud-body${enabled ? "" : " disabled"}`}>
        <div className="loud-chart-card">
          <div className="loud-chart-head">
            <div className="loud-chart-title">
              <AudioLines size={14} />
              <span>Your library</span>
            </div>
            <div className="loud-status">
              <span>{(summary?.measured ?? 0).toLocaleString()} clips measured</span>
            </div>
          </div>

          {entries.length > 0 ? (
            <div className="loud-chart-wrap">
              <svg className="loud-chart" viewBox={`0 0 ${chartW} ${chartH}`} preserveAspectRatio="none" aria-hidden="true">
                <rect x={targetX - barW} y={0} width={barW * 2} height={chartH} className="loud-band" />
                {histogram.buckets.map((count, i) => {
                  if (count === 0) return null;
                  const h = Math.max(2, (count / histogram.max) * (chartH - 8));
                  const lufs = HIST_MIN + i;
                  const near = Math.abs(lufs - target) <= 1;
                  return (
                    <rect
                      key={i}
                      x={i * barW + 1}
                      y={chartH - h}
                      width={Math.max(1, barW - 2)}
                      height={h}
                      rx={1.5}
                      className={`loud-bar${near ? " near" : lufs < target ? " boost" : " cut"}`}
                    />
                  );
                })}
                {medianX != null ? <line x1={medianX} x2={medianX} y1={0} y2={chartH} className="loud-median" /> : null}
                <line x1={targetX} x2={targetX} y1={0} y2={chartH} className="loud-target" />
              </svg>
              <div className="loud-target-label" style={{ left: `${Math.max(7, Math.min(93, (targetX / chartW) * 100))}%` }}>
                Target {fmtLufs(target)}
              </div>
              <div className="loud-axis">
                <span>quiet</span>
                <span className="loud-legend">
                  <i className="boost" /> raised
                  <i className="near" /> on target
                  <i className="cut" /> lowered
                </span>
                <span>loud</span>
              </div>
            </div>
          ) : (
            <div className="loud-empty">
              Levels show up here as the audio analysis above works through your library.
            </div>
          )}

          <div className="loud-target-row">
            <div className="loud-target-info">
              <div className="set-row-title">Target loudness</div>
              <div className="set-row-desc">Where every clip gets pulled to. Auto uses the middle of your library, so most clips barely move.</div>
            </div>
            <div className="loud-target-controls">
              <Slider
                value={Math.max(TARGET_MIN, Math.min(TARGET_MAX, target))}
                min={TARGET_MIN}
                max={TARGET_MAX}
                step={0.5}
                format={(v) => fmtLufs(v)}
                disabled={!enabled}
                onInput={(v) => setDraftTarget(v)}
                onCommit={(v) => {
                  setDraftTarget(null);
                  void set("loudness.targetLufs", v);
                }}
                aria-label="Target loudness"
              />
              <button
                type="button"
                className={`loud-auto${isAuto ? " on" : ""}`}
                disabled={!enabled}
                onClick={() => {
                  setDraftTarget(null);
                  void set("loudness.targetLufs", null);
                }}
                title={median != null ? `Auto: ${fmtLufs(median)}, the middle of your library` : "Auto: the middle of your library"}
              >
                <Sparkles size={12} />
                Auto
              </button>
            </div>
          </div>

          {stats ? (
            <div className="loud-stats">
              <span>
                <b>{fmtDb(stats.typicalMove).replace("+", "")}</b> typical change
              </span>
              <span>
                <b>{Math.round((stats.onTarget / entries.length) * 100)}%</b> already within 1 dB
              </span>
              <span title="Raising these all the way would clip their peaks, so they stop a little short">
                <b>{stats.capped.toLocaleString()}</b> stay a bit quieter
              </span>
            </div>
          ) : null}
        </div>

        {samples.length > 0 ? (
          <div className="loud-preview">
            <div className="loud-preview-head">
              <div>
                <div className="set-row-title">Hear it</div>
                <div className="set-row-desc">The extremes of your library at the current target. Flip to original to compare.</div>
              </div>
              <div className="loud-ab" role="group" aria-label="Preview mode">
                <button type="button" className={compareOriginal ? "" : "on"} onClick={() => setCompareOriginal(false)}>
                  Matched
                </button>
                <button type="button" className={compareOriginal ? "on" : ""} onClick={() => setCompareOriginal(true)}>
                  Original
                </button>
              </div>
            </div>
            <div className="loud-samples">
              {samples.map(({ key, label, entry }) => {
                const g = gainDbFor(entry, target, headroom, maxGain);
                const thumb = lib.thumbnails.get(entry.name);
                const isPlaying = playing === entry.name;
                return (
                  <div key={key} className={`loud-sample${isPlaying ? " playing" : ""}`}>
                    <button type="button" className="loud-sample-media" onClick={() => void play(entry.name)} disabled={!enabled} aria-label={isPlaying ? "Pause" : `Play ${label.toLowerCase()} clip`}>
                      {thumb ? <img src={`file://${thumb}`} alt="" /> : <div className="loud-sample-blank" />}
                      <span className="loud-sample-play">{isPlaying ? <Pause size={18} /> : <Play size={18} />}</span>
                    </button>
                    <div className="loud-sample-info">
                      <div className="loud-sample-kind">{label}</div>
                      <div className="loud-sample-name" title={entry.name}>
                        {displayName(lib, entry.name)}
                      </div>
                      <div className="loud-sample-meta">
                        <span>{fmtLufs(entry.lufs)}</span>
                        <span className={`loud-gain${compareOriginal ? " off" : ""}`}>
                          {compareOriginal ? "original" : fmtDb(g.db)}
                        </span>
                        {g.capped && !compareOriginal ? <span className="loud-capped">peak limited</span> : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <video ref={videoRef} className="loud-preview-video" playsInline preload="metadata" />
          </div>
        ) : null}
      </div>
    </SetGroup>
  );
}
