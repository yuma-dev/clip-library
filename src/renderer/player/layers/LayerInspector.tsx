import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, Search, SlidersHorizontal, Trash2, Upload, X } from "lucide-react";
import type { GifLayer, ImageLayer, KlipyGif, Layer, LayerAnim, TextLayer, VolumeLayer } from "../../../types/clips";
import type { TrackView } from "../Waveform";
import { AnimGrid, AnimLengthRows, Detail, FillSlider, Flyout, Row, Seg, SizeSlider, StyleTiles, Swatches, TextDetailRows } from "./controls";
import { KIND_NAME, fileUrl, layerColor, shortName, trackInfo } from "./meta";
import { HIDE_ANIMS, SHOW_MEDIA, SHOW_TEXT, clamp, pct } from "./model";
import { remove, select, setMenu, update, useLayers } from "./store";

const video = () => document.getElementById("video-player") as HTMLVideoElement | null;

function VolumeBody({ l, tracks }: { l: VolumeLayer; tracks: TrackView[] | null }) {
  const multi = (tracks?.length ?? 0) > 1;
  const name = l.track === "all" ? (multi ? "All tracks" : "Clip audio") : trackInfo(tracks, l.track).name;
  return (
    <>
      {multi ? (
        <Row label="Applies to">
          <div className="pl-lp-tracks" role="radiogroup">
            {[{ ordinal: "all" as const, name: "All tracks", color: layerColor({ ...l, track: "all" }, tracks) }, ...(tracks ?? []).filter((t) => !t.hidden)].map((t) => {
              const full = t.name || `Track ${Number(t.ordinal) + 1}`;
              return (
                <button
                  key={String(t.ordinal)}
                  type="button"
                  role="radio"
                  aria-checked={l.track === t.ordinal}
                  className={l.track === t.ordinal ? "is-on" : undefined}
                  title={full}
                  onClick={() => update(l.id, { track: t.ordinal })}
                >
                  <i className="pl-lp-dot" style={{ background: t.color }} />
                  <span>{shortName(full)}</span>
                </button>
              );
            })}
          </div>
        </Row>
      ) : null}
      <Row label="Level">
        <FillSlider
          label="Level"
          value={l.level}
          min={0}
          max={2}
          reset={1}
          step={0.01}
          color={layerColor(l, tracks)}
          name={name}
          text={pct(l.level)}
          onChange={(level) => update(l.id, { level })}
        />
      </Row>
      <Row label="Ease in and out">
        <Seg<number> value={l.fade} onPick={(fade) => update(l.id, { fade })} options={[[0, "Off"], [0.3, "Short"], [1, "Long"]]} />
      </Row>
    </>
  );
}

let previewStop = 0;
/** plays from..to once, then pauses; shows an animation right after it was picked */
function preview(from: number, to: number) {
  const v = video();
  if (!v) return;
  cancelAnimationFrame(previewStop);
  v.currentTime = Math.max(0, from);
  void v.play();
  const watch = () => {
    if (v.paused) return;
    if (v.currentTime >= to) {
      v.pause();
      return;
    }
    previewStop = requestAnimationFrame(watch);
  };
  previewStop = requestAnimationFrame(watch);
}

function AnimRows({ l }: { l: Exclude<Layer, VolumeLayer> }) {
  // picking one replays that edge so it shows at once
  const pick = (key: "ain" | "aout", v: LayerAnim) => {
    update(l.id, { [key]: v } as Partial<Layer>);
    if (v === "none") return;
    if (key === "ain") preview(l.start, Math.min(l.end, l.start + 1.2));
    else preview(Math.max(l.start, l.end - 1), l.end + 0.3);
  };
  return (
    <>
      <Row label="Show with">
        <AnimGrid list={l.kind === "text" ? SHOW_TEXT : SHOW_MEDIA} value={l.ain} onPick={(v) => pick("ain", v)} />
      </Row>
      <Row label="Hide with">
        <AnimGrid list={HIDE_ANIMS} value={l.aout} out onPick={(v) => pick("aout", v)} />
      </Row>
    </>
  );
}

function TextBody({ l }: { l: TextLayer }) {
  return (
    <>
      {l.source === "subtitles" ? (
        <button
          type="button"
          className="pl-subs-link"
          onClick={() => {
            select(null);
            setMenu("subs");
          }}
        >
          Subtitle line. Style all of them
        </button>
      ) : null}
      <textarea
        className="pl-lp-textarea"
        rows={2}
        spellCheck={false}
        autoFocus={!l.text}
        placeholder="Type something"
        value={l.text}
        maxLength={200}
        onChange={(e) => update(l.id, { text: e.target.value })}
      />
      <Row label="Style">
        <StyleTiles value={l.style} color={l.color} onPick={(style) => update(l.id, { style })} />
      </Row>
      <Row label="Color">
        <Swatches value={l.color} onPick={(color) => update(l.id, { color })} />
      </Row>
      <Row label="Size">
        <SizeSlider value={l.size} onChange={(size) => update(l.id, { size })} />
      </Row>
      <AnimRows l={l} />
    </>
  );
}

const GIF_ERRORS: Record<string, string> = {
  no_key: "GIF search isn't set up in this build.",
  timeout: "KLIPY took too long to answer. Try again.",
  network: "Couldn't reach KLIPY. Check your connection.",
};

function GifBody({ l, clip }: { l: GifLayer; clip: string }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<KlipyGif[]>([]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const reqRef = useRef(0);

  const load = useCallback((query: string, p: number) => {
    const req = ++reqRef.current;
    setLoading(true);
    window.clips
      .searchGifs({ q: query, page: p })
      .then((res) => {
        if (req !== reqRef.current) return;
        setError(res.error ? GIF_ERRORS[res.error] ?? "GIF search failed. Try again." : null);
        setResults((prev) => (p === 1 ? res.items : [...prev, ...res.items]));
        setHasNext(res.hasNext);
        setPage(p);
      })
      .catch(() => req === reqRef.current && setError(GIF_ERRORS.network))
      .finally(() => req === reqRef.current && setLoading(false));
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => load(q, 1), q ? 300 : 0);
    return () => window.clearTimeout(id);
  }, [q, load]);

  const pick = async (g: KlipyGif) => {
    setFetching(g.id);
    update(l.id, { gif: { id: g.id, title: g.title, url: g.url }, aspect: g.width && g.height ? g.width / g.height : 1, file: null });
    try {
      const { file } = await window.clips.downloadLayerGif(clip, { id: g.id, url: g.url });
      update(l.id, { file });
    } catch {
      setError("That GIF didn't download. Pick it again or try another.");
    } finally {
      setFetching(null);
    }
  };

  return (
    <>
      <label className="pl-lp-search">
        <Search size={13} />
        <input autoFocus={!l.file} value={q} placeholder="Search KLIPY" spellCheck={false} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div
        className="pl-lp-gifs"
        onScroll={(e) => {
          const el = e.currentTarget;
          // the next page loads before the end is reached
          if (hasNext && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - 60) load(q, page + 1);
        }}
      >
        {results.map((g) => (
          <button key={g.id} type="button" title={g.title} className={l.gif.id === g.id ? "is-on" : undefined} onClick={() => void pick(g)}>
            <img src={g.preview} alt={g.title} loading="lazy" />
            {fetching === g.id ? (
              <span className="pl-lp-gif-busy">
                <LoaderCircle size={16} />
              </span>
            ) : null}
          </button>
        ))}
        {!loading && !error && results.length === 0 ? <p className="pl-lp-empty">Nothing for "{q}". Try another word.</p> : null}
      </div>
      {error ? <p className="pl-lp-error">{error}</p> : null}
      <p className="pl-lp-klipy">Powered by KLIPY</p>
      <AnimRows l={l} />
    </>
  );
}

function ImageBody({ l, clip }: { l: ImageLayer; clip: string }) {
  const [error, setError] = useState<string | null>(null);
  const choose = async () => {
    setError(null);
    try {
      const res = await window.clips.pickLayerImage(clip);
      if (!res) return;
      const img = new window.Image();
      img.src = fileUrl(res.file);
      await img.decode().catch(() => undefined);
      update(l.id, { file: res.file, aspect: img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1 });
    } catch (err) {
      setError((err as Error)?.message || "Couldn't add that image.");
    }
  };
  // a fresh image layer opens the file dialog right away
  const asked = useRef(false);
  useEffect(() => {
    if (!l.file && !asked.current) {
      asked.current = true;
      void choose();
    }
  }, []);
  return (
    <>
      <div className="pl-lp-image">
        {l.file ? <img src={fileUrl(l.file)} alt="" /> : <span className="pl-lp-image-empty" />}
        <button type="button" className="pl-lp-btn" onClick={() => void choose()}>
          <Upload size={12} />
          {l.file ? "Replace image" : "Choose image"}
        </button>
      </div>
      {error ? <p className="pl-lp-error">{error}</p> : null}
      <AnimRows l={l} />
    </>
  );
}

/** the fine settings of a layer, shown in the flyout */
function LayerDetails({ l }: { l: Layer }) {
  if (l.kind === "volume") {
    return (
      <Row label="Ease">
        <Detail label="Length" value={l.fade} min={0} max={3} step={0.05} def={0.3} fmt={(v) => (v ? `${v.toFixed(2)} s` : "off")} onChange={(fade) => update(l.id, { fade: fade ?? 0.3 })} />
      </Row>
    );
  }
  if (l.kind === "text") return <TextDetailRows l={l} onChange={(patch) => update(l.id, patch)} />;
  return (
    <>
      <Row label="Look">
        <Detail label="Opacity" value={l.opacity ?? 1} min={0} max={1} step={0.01} def={1} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(opacity) => update(l.id, { opacity })} />
      </Row>
      <AnimLengthRows l={l} onChange={(patch) => update(l.id, patch)} />
    </>
  );
}

const FLY_W = 240;

/** settings for the selected layer, hanging above its tag */
export default function LayerInspector({ tracks, tagsHeight }: { tracks: TrackView[] | null; tagsHeight: number }) {
  const { items, sel, clip } = useLayers();
  const l = items.find((x) => x.id === sel) ?? null;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; maxHeight: number; flyLeft: number } | null>(null);
  const [more, setMore] = useState(false);

  // anchored on the tag's centre, kept inside the frame
  useLayoutEffect(() => {
    const el = ref.current;
    const bar = el?.parentElement;
    const frame = document.getElementById("fullscreen-player");
    const tag = bar?.querySelector<HTMLElement>(".pl-tag.is-sel");
    if (!el || !bar || !frame) return;
    const b = bar.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    const t = tag?.getBoundingClientRect();
    const cx = t ? t.left + t.width / 2 : b.left + b.width / 2;
    const w = el.offsetWidth || 290;
    const left = clamp(cx - w / 2, f.left + 8, f.right - w - 8) - b.left;
    const maxHeight = Math.max(160, b.top - tagsHeight - 12 - (f.top + 52));
    // details open on the side with room, right first
    const right = left + w + 8;
    const flyLeft = right + FLY_W <= f.right - b.left - 8 ? right : left - FLY_W - 8;
    setPos((p) => (p && p.left === left && p.maxHeight === maxHeight && p.flyLeft === flyLeft ? p : { left, maxHeight, flyLeft }));
  });

  if (!l || !clip) return null;
  const bottom = `calc(100% + ${tagsHeight + 10}px)`;
  return (
    <>
    <div
      ref={ref}
      className="pl-lp"
      role="dialog"
      aria-label={KIND_NAME[l.kind]}
      style={{ left: pos?.left ?? 0, bottom, maxHeight: pos?.maxHeight, visibility: pos ? undefined : "hidden" }}
      // player shortcuts must not fire while typing or picking in here
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key !== "Escape") return;
        const t = e.target as HTMLElement;
        if (t.matches("input, textarea")) t.blur();
        else select(null);
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div className="pl-lp-head">
        <span className="pl-lp-title">{KIND_NAME[l.kind]}</span>
        <button type="button" className={`pl-lp-icon${more ? " is-on" : ""}`} title="Details" aria-pressed={more} onClick={() => setMore(!more)}>
          <SlidersHorizontal size={13} />
        </button>
        <button type="button" className="pl-lp-icon is-danger" title="Delete (Del)" onClick={() => remove(l.id)}>
          <Trash2 size={13} />
        </button>
        <button type="button" className="pl-lp-icon" title="Close (Esc)" onClick={() => select(null)}>
          <X size={13} />
        </button>
      </div>
      {l.kind === "volume" ? <VolumeBody l={l} tracks={tracks} /> : null}
      {l.kind === "text" ? <TextBody l={l} /> : null}
      {l.kind === "gif" ? <GifBody key={l.id} l={l} clip={clip} /> : null}
      {l.kind === "image" ? <ImageBody key={l.id} l={l} clip={clip} /> : null}
    </div>
    {more && pos ? (
      <Flyout title="Details" onClose={() => setMore(false)} style={{ left: pos.flyLeft, bottom, maxHeight: pos.maxHeight }}>
        <LayerDetails l={l} />
      </Flyout>
    ) : null}
    </>
  );
}
