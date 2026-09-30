import { useEffect, useRef, useState } from "react";
import { Captions, Check, ChevronLeft, Plus, Redo2, SlidersHorizontal, Undo2 } from "lucide-react";
import type { LayerKind, TextLayer } from "../../../types/clips";
import type { TrackView } from "../Waveform";
import { getAllKeybindings } from "../keybindings";
import { AnimGrid, FillSlider, Flyout, Row, SizeSlider, StyleTiles, Swatches, TextDetailRows } from "./controls";
import { KIND_HINT, KindIcon, shortName } from "./meta";
import { HIDE_ANIMS, SHOW_TEXT } from "./model";
import { add, getLayers, mapItems, redo, replaceSubtitles, setMenu, undo, useLayers } from "./store";
import { buildSubtitles, colorFor, colorKey, isSub, loadSubStyle, restyle, saveSubStyle, styleOf, type SubStyle } from "./subtitles";

const KINDS: Array<[LayerKind, string, string]> = [
  ["volume", "Volume", "addVolumeLayer"],
  ["text", "Text", "addTextLayer"],
  ["gif", "GIF", "addGifLayer"],
  ["image", "Image", "addImageLayer"],
  ["zoom", "Zoom", "addZoomLayer"],
  ["speed", "Speed", "addSpeedLayer"],
  ["blur", "Blur", "addBlurLayer"],
  ["sound", "Sound", "addSoundLayer"],
];

type Busy = { step: "engine" | "unpack" | "model" | "audio" | "transcribe"; progress: number; of?: string; got?: number; total?: number };
const STEP_TEXT = {
  engine: "Downloading the speech engine",
  unpack: "Unpacking the speech engine",
  model: "Downloading the speech model",
  audio: "Reading the audio",
  transcribe: "Listening",
};
const mb = (bytes: number) => Math.round(bytes / 1e6);
const cleanError = (err: unknown, fallback: string) =>
  (err as Error)?.message?.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || fallback;

function Progress({ busy }: { busy: Busy }) {
  return (
    <div className="pl-subs-progress">
      <span>
        {STEP_TEXT[busy.step]}
        {busy.of ? `: ${busy.of}` : ""}
        {busy.total ? `, ${mb(busy.got ?? 0)} of ${mb(busy.total)} MB` : ""}
      </span>
      <i style={{ width: `${Math.round((busy.progress || 0) * 100)}%` }} />
    </div>
  );
}

/** ffprobe stream index behind a mixer track; single-track clips have none and use the default */
function streamOf(ordinal: number): number[] {
  const mgr = window.legacyPlayer?.getActiveAudioTracksManager?.() as { tracks?: Array<{ ordinal: number; streamIndex: number }> } | null | undefined;
  const t = mgr?.tracks?.find((x) => x.ordinal === ordinal);
  return t ? [t.streamIndex] : [];
}

/** before the model is there: why it's needed and the one button that gets it */
function DownloadView({ busy, error, onDownload }: { busy: Busy | null; error: string | null; onDownload: () => void }) {
  return (
    <>
      <p className="pl-subs-why">Subtitles are made by a speech model that runs on this PC.</p>
      <p className="pl-subs-why">The model is downloaded once, about 1.75 GB. After that, subtitles take a few seconds per clip.</p>
      {busy ? (
        <Progress busy={busy} />
      ) : (
        <button type="button" className="pl-subs-go" onClick={onDownload}>
          Download speech model
        </button>
      )}
      {error ? <p className="pl-lp-error">{error}</p> : null}
    </>
  );
}

/** speech to text layers for the whole clip, and the one place to style all of them later. each
 * picked track is heard on its own and its lines keep that track's color */
function SubtitlesPanel({ tracks, onBack }: { tracks: TrackView[] | null; onBack: () => void }) {
  const { items, clip } = useLayers();
  const visible = (tracks ?? []).filter((t) => !t.hidden);
  const multi = (tracks?.length ?? 0) > 1;
  // voices, not the game: mic and voice chat when the recorder named them so
  const [picked, setPicked] = useState<number[]>(() => {
    const voices = visible.filter((t) => /mic|voice|chat|discord|party/i.test(t.name)).map((t) => t.ordinal);
    return voices.length ? voices : visible.slice(0, 1).map((t) => t.ordinal);
  });
  const [style, setStyle] = useState<SubStyle>(() => styleOf(getLayers().items, tracks) ?? loadSubStyle());
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [painting, setPainting] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const ofRef = useRef<string | undefined>(undefined);
  const existing = items.filter(isSub).length;

  useEffect(() => {
    void window.clips.subtitlesStatus().then((s) => setInstalled(s.installed)).catch(() => setInstalled(false));
    return window.clips.onSubtitlesProgress((p) => setBusy({ step: p.step, progress: p.progress, of: ofRef.current, got: p.got, total: p.total }));
  }, []);

  // every change lands on the lines that exist, and is remembered for the next clip
  const change = (patch: Partial<SubStyle>) => {
    const next = { ...style, ...patch };
    setStyle(next);
    saveSubStyle(next);
    const edits = restyle(getLayers().items, next, tracks);
    if (edits.size) mapItems((l) => (edits.has(l.id) ? ({ ...l, ...edits.get(l.id) } as TextLayer) : l));
  };
  const paint = (speaker: number | undefined, color: string) => change({ colors: { ...style.colors, [colorKey(speaker, tracks)]: color } });

  const download = async () => {
    setError(null);
    setBusy({ step: "engine", progress: 0 });
    try {
      await window.clips.installSubtitles();
      setInstalled(true);
    } catch (err) {
      setError(cleanError(err, "The download failed. Check your connection and try again."));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const v = document.getElementById("video-player") as HTMLVideoElement | null;
    if (!clip || !v) return;
    setError(null);
    try {
      const jobs = multi ? visible.filter((t) => picked.includes(t.ordinal)) : [null];
      const lines: Array<{ start: number; end: number; text: string; speaker?: number }> = [];
      for (const [i, t] of jobs.entries()) {
        ofRef.current = t && jobs.length > 1 ? `${shortName(t.name)} (${i + 1} of ${jobs.length})` : undefined;
        setBusy({ step: "audio", progress: 0, of: ofRef.current });
        const res = await window.clips.transcribeSubtitles({ clipName: clip, streams: t ? streamOf(t.ordinal) : [], start: 0, end: v.duration });
        lines.push(...res.lines.map((l) => (t ? { ...l, speaker: t.ordinal } : l)));
      }
      if (lines.length === 0) setError(jobs.length > 1 ? "No speech found on those tracks." : "No speech found on that track.");
      else replaceSubtitles(buildSubtitles(lines, style, tracks));
    } catch (err) {
      setError(cleanError(err, "Subtitles failed."));
    } finally {
      ofRef.current = undefined;
      setBusy(null);
    }
  };

  const ready = installed === true;
  return (
    <>
      <div className="pl-subs">
        <div className="pl-subs-head">
          <button type="button" className="pl-lp-icon" aria-label="Back" onClick={onBack} disabled={Boolean(busy)}>
            <ChevronLeft size={14} />
          </button>
          <b>Subtitles</b>
          {ready ? (
            <button type="button" className={`pl-lp-icon${more ? " is-on" : ""}`} title="Details" aria-pressed={more} onClick={() => setMore(!more)}>
              <SlidersHorizontal size={13} />
            </button>
          ) : null}
        </div>
        {installed === false ? <DownloadView busy={busy} error={error} onDownload={() => void download()} /> : null}
        {ready ? (
          <>
            {multi ? (
              <Row label="Listen to">
                <div className="pl-lp-tracks">
                  {visible.map((t) => {
                    const on = picked.includes(t.ordinal);
                    const color = colorFor(style, t.ordinal, tracks);
                    return (
                      <div key={t.ordinal} className="pl-subs-track">
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          className={on ? "is-on" : undefined}
                          title={t.name}
                          disabled={Boolean(busy)}
                          onClick={() => setPicked((p) => (p.includes(t.ordinal) ? p.filter((o) => o !== t.ordinal) : [...p, t.ordinal]))}
                        >
                          <i className="pl-lp-dot" style={{ background: t.color }} />
                          <span>{shortName(t.name || `Track ${t.ordinal + 1}`)}</span>
                          {on ? <Check size={12} className="pl-subs-check" /> : null}
                        </button>
                        <button
                          type="button"
                          className={`pl-subs-paint${painting === t.ordinal ? " is-on" : ""}`}
                          style={{ background: color }}
                          title="Subtitle color for this track"
                          aria-label={`Subtitle color for ${shortName(t.name)}`}
                          onClick={() => setPainting(painting === t.ordinal ? null : t.ordinal)}
                        />
                        {painting === t.ordinal ? (
                          <div className="pl-subs-palette">
                            <Swatches value={color} onPick={(c) => paint(t.ordinal, c)} />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </Row>
            ) : (
              <Row label="Color">
                <Swatches value={colorFor(style, undefined, tracks)} onPick={(c) => paint(undefined, c)} />
              </Row>
            )}
            <Row label="Style">
              <StyleTiles value={style.style} color="#ffffff" onPick={(s) => change({ style: s })} />
            </Row>
            <Row label="Size">
              <SizeSlider value={style.size} onChange={(size) => change({ size })} />
            </Row>
            <Row label="Position">
              <FillSlider label="Position" value={style.y} min={50} max={97} reset={90} step={0.5} color="#f4f4f6" name="Higher" text="Lower" onChange={(y) => change({ y })} />
            </Row>
            <Row label="Show with">
              <AnimGrid list={SHOW_TEXT} value={style.ain} onPick={(ain) => change({ ain })} />
            </Row>
            <Row label="Hide with">
              <AnimGrid list={HIDE_ANIMS} value={style.aout} out onPick={(aout) => change({ aout })} />
            </Row>
            {busy ? (
              <Progress busy={busy} />
            ) : (
              <button type="button" className="pl-subs-go" disabled={multi && picked.length === 0} onClick={() => void create()}>
                {existing ? "Create again" : "Create subtitles"}
              </button>
            )}
            {error ? <p className="pl-lp-error">{error}</p> : null}
            {!busy && existing ? (
              <button type="button" className="pl-subs-remove" onClick={() => replaceSubtitles([])}>
                Remove {existing} subtitle {existing === 1 ? "line" : "lines"}
              </button>
            ) : null}
            {/* dev builds only: back to the first run, to see the download as a new user does */}
            {import.meta.env.DEV && !busy ? (
              <button
                type="button"
                className="pl-subs-remove is-dev"
                onClick={() => void window.clips.uninstallSubtitles().then((s) => setInstalled(s.installed)).catch(() => undefined)}
              >
                Delete speech model (dev)
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      {ready && more ? (
        <Flyout title="Details" onClose={() => setMore(false)} style={{ right: "calc(100% + 8px)", bottom: 0, maxHeight: "100%" }}>
          <TextDetailRows l={style} onChange={(patch) => change(patch)} />
        </Flyout>
      ) : null}
    </>
  );
}

/** the Add button in the player bar and its menu; everything lands at the playhead */
export default function AddLayer({ tracks }: { tracks: TrackView[] | null }) {
  const { menu, hist } = useLayers();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [menu]);

  const keys = menu ? getAllKeybindings() : {};
  return (
    <div className="pl-add" ref={ref}>
      {hist.undo || hist.redo ? (
        <>
          <button type="button" className="pl-add-hist" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!hist.undo} onClick={() => undo()}>
            <Undo2 size={13} strokeWidth={2.2} />
          </button>
          <button type="button" className="pl-add-hist" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!hist.redo} onClick={() => redo()}>
            <Redo2 size={13} strokeWidth={2.2} />
          </button>
        </>
      ) : null}
      <button
        type="button"
        className={`pl-add-btn${menu ? " is-on" : ""}`}
        title="Add text, media, a zoom, a speed change, a blur, a sound or subtitles"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={(e) => {
          e.stopPropagation();
          setMenu(menu ? false : "add");
        }}
      >
        <Plus size={13} strokeWidth={2.2} />
        Add
      </button>
      {menu === "subs" ? (
        <div className="pl-add-menu is-subs" role="dialog" aria-label="Subtitles" onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
          <SubtitlesPanel tracks={tracks} onBack={() => setMenu("add")} />
        </div>
      ) : menu === "add" ? (
        <div className="pl-add-menu" role="menu">
          {KINDS.map(([kind, name, action]) => (
            <button key={kind} type="button" role="menuitem" onClick={() => add(kind)}>
              <KindIcon kind={kind} size={15} className={`pl-add-icon is-${kind}`} />
              <span>
                <b>{name}</b>
                <span>{KIND_HINT[kind]}</span>
              </span>
              {keys[action] ? <kbd>{keys[action].toUpperCase()}</kbd> : null}
            </button>
          ))}
          <button type="button" role="menuitem" className="is-wide" onClick={() => setMenu("subs")}>
            <Captions size={15} className="pl-add-icon is-subs" />
            <span>
              <b>Subtitles</b>
              <span>Speech to text, any language</span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
