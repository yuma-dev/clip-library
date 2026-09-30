import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Merge, RefreshCw, Scissors, Trash2, X } from "lucide-react";
import { SetGroup, StatusLine } from "../rows";
import Select from "../../ui/Select";
import { useConfirm } from "../../ui/ConfirmDialog";
import { useToast } from "../../ui/Toast";
import { useSettings } from "../SettingsContext";
import { absoluteTime, relativeTime } from "../../library/time";
import { getCachedGameIcon, loadGameIcon, type GameIcon } from "../../library/gameIcon";
import type { UseClips } from "../../library/useClips";
import type { LocalClip } from "../../library/types";
import type { OverlapPair, StorageRow, StorageSummary } from "../../../types/clips";
import { formatBytes, formatDuration, jobText, runStorageJob, useStorageJob } from "../../storage/jobs";
import {
  dismissPair,
  keepLongerPair,
  mergePair,
  refreshOverlaps,
  rescanOverlaps,
  useOverlapState,
  type OverlapActionCtx,
} from "../../storage/overlaps";
import "./storage.css";

type Tab = "biggest" | "unopened" | "untagged" | "trimmed" | "overlaps";

const TABS: { id: Tab; label: string }[] = [
  { id: "biggest", label: "Biggest" },
  { id: "unopened", label: "Never opened" },
  { id: "untagged", label: "Untagged" },
  { id: "trimmed", label: "Trimmed" },
  { id: "overlaps", label: "Overlapping saves" },
];

const AGE_OPTIONS = [
  { value: "1", label: "Older than 1 month" },
  { value: "3", label: "Older than 3 months" },
  { value: "6", label: "Older than 6 months" },
  { value: "12", label: "Older than a year" },
];

const PAGE = 100;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

interface Row extends StorageRow {
  clip: LocalClip;
  /** bytes a shrink to the trim would roughly give back */
  savable: number | null;
}

function openInPlayer(clip: LocalClip) {
  void window.legacyPlayer?.openClip(clip.originalName, clip.customName);
}

function RowIcon({ name, grey }: { name: string; grey: boolean }) {
  const [icon, setIcon] = useState<GameIcon | null>(() => getCachedGameIcon(name) ?? null);
  useEffect(() => {
    if (icon) return;
    let alive = true;
    void loadGameIcon(name).then((res) => {
      if (alive && res.path) setIcon(res);
    });
    return () => {
      alive = false;
    };
  }, [name, icon]);
  if (!icon?.path) return <span className="stg-icon" />;
  return (
    <span className="stg-icon" title={icon.title ?? undefined}>
      <img className={grey ? "grayscale" : undefined} src={`file://${icon.path}`} alt="" draggable={false} />
    </span>
  );
}

function Thumb({ path }: { path: string | null | undefined }) {
  return <span className="stg-thumb">{path ? <img src={`file://${path}`} alt="" draggable={false} loading="lazy" /> : null}</span>;
}

export default function StorageSection({ lib }: { lib: UseClips }) {
  const { settings } = useSettings();
  const { confirm } = useConfirm();
  const toast = useToast();
  const job = useStorageJob();
  const overlapState = useOverlapState();
  const grey = Boolean(settings.iconGreyscale);

  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [rows, setRows] = useState<StorageRow[] | null>(null);
  const [durations, setDurations] = useState<Map<string, number | null>>(new Map());
  const [tab, setTab] = useState<Tab>("biggest");
  const [age, setAge] = useState("3");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [removingModel, setRemovingModel] = useState(false);
  const requested = useRef(new Set<string>());

  const loadSummary = useCallback((force = false) => {
    window.clips.getStorageSummary(force).then(setSummary).catch(() => undefined);
  }, []);
  const loadRows = useCallback(() => {
    window.clips.getStorageRows().then(setRows).catch(() => setRows([]));
  }, []);

  useEffect(() => {
    loadSummary();
    loadRows();
    void refreshOverlaps(true).catch(() => undefined);
  }, [loadSummary, loadRows]);

  useEffect(() => {
    setSelected(new Set());
    setLimit(PAGE);
  }, [tab, age]);

  const clipByName = useMemo(() => new Map(lib.clips.map((c) => [c.originalName, c])), [lib.clips]);
  const displayName = useCallback(
    (name: string) => clipByName.get(name)?.customName || name.replace(/^.*\//, "").replace(/\.[^.]+$/, ""),
    [clipByName],
  );

  const joined = useMemo<Row[]>(() => {
    if (!rows) return [];
    const out: Row[] = [];
    for (const r of rows) {
      const clip = clipByName.get(r.name);
      if (!clip) continue;
      const duration = r.duration ?? durations.get(r.name) ?? null;
      let savable: number | null = null;
      if (r.trim && duration && duration > 0) {
        savable = Math.max(0, r.size * (1 - Math.min(duration, r.trim.end - r.trim.start) / duration));
      }
      out.push({ ...r, duration, clip, savable });
    }
    return out;
  }, [rows, clipByName, durations]);

  const list = useMemo<Row[]>(() => {
    const cutoff = Date.now() - Number(age) * MONTH_MS;
    switch (tab) {
      case "biggest":
        return [...joined].sort((a, b) => b.size - a.size);
      case "unopened":
        return joined.filter((r) => r.clip.isNewSinceLastSession && r.clip.createdAt < cutoff).sort((a, b) => a.clip.createdAt - b.clip.createdAt);
      case "untagged":
        return joined.filter((r) => r.clip.tags.length === 0 && r.clip.createdAt < cutoff).sort((a, b) => a.clip.createdAt - b.clip.createdAt);
      case "trimmed":
        return joined.filter((r) => r.trim).sort((a, b) => (b.savable ?? -1) - (a.savable ?? -1) || b.size - a.size);
      default:
        return [];
    }
  }, [joined, tab, age]);

  const shown = useMemo(() => list.slice(0, limit), [list, limit]);

  // durations nobody has cached yet, only for what's on screen
  useEffect(() => {
    const missing = shown.filter((r) => r.duration == null && !requested.current.has(r.name)).map((r) => r.name).slice(0, 60);
    if (missing.length === 0) return;
    for (const n of missing) requested.current.add(n);
    void window.clips.getStorageDurations(missing).then((got) => {
      setDurations((prev) => {
        const next = new Map(prev);
        for (const [k, v] of Object.entries(got)) next.set(k, v);
        return next;
      });
    });
  }, [shown]);

  const selectedRows = useMemo(() => list.filter((r) => selected.has(r.name)), [list, selected]);
  const selectedBytes = selectedRows.reduce((a, r) => a + r.size, 0);
  const selectedTrimmed = selectedRows.filter((r) => r.trim);
  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(r.name));
  const busy = job != null;

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const toggleAll = () => setSelected(allShownSelected ? new Set() : new Set(shown.map((r) => r.name)));

  const afterJob = () => {
    setSelected(new Set());
    loadRows();
    loadSummary(true);
  };

  const deleteSelected = async () => {
    const targets = selectedRows;
    if (targets.length === 0) return;
    const bytes = targets.reduce((a, r) => a + r.size, 0);
    const many = targets.length > 1;
    const ok = await confirm({
      title: many ? `Delete ${targets.length} clips` : "Delete clip",
      message: `${many ? "They go" : "It goes"} to the Recycle Bin with ${many ? "their" : "its"} names, tags, trims and layers. That frees ${formatBytes(bytes)} once the Recycle Bin is emptied.`,
      confirmLabel: "Move to Recycle Bin",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await runStorageJob({ kind: "delete", names: targets.map((r) => r.name) });
      lib.removeClips(res.removed ?? []);
      const failed = res.failed?.length ?? 0;
      setResult({
        tone: failed ? "error" : "success",
        text: `Moved ${res.removed?.length ?? 0} to the Recycle Bin, ${formatBytes(res.bytesFreed)}.${failed ? ` ${failed} could not be moved, they may be open somewhere.` : ""}`,
      });
    } catch (err) {
      setResult({ tone: "error", text: `Delete failed: ${(err as Error).message}` });
    }
    afterJob();
  };

  const shrinkSelected = async () => {
    const targets = selectedTrimmed;
    if (targets.length === 0) return;
    const many = targets.length > 1;
    const ok = await confirm({
      title: many ? `Shrink ${targets.length} clips to their trim` : "Shrink to trim",
      message: `Cuts ${many ? "each file" : "the file"} down to the trimmed part without re-encoding. The cut starts on the keyframe just before the trim, so a second or two of lead-in can stay. The original${many ? "s go" : " goes"} to the Recycle Bin first.`,
      confirmLabel: "Shrink",
    });
    if (!ok) return;
    try {
      const res = await runStorageJob({ kind: "shrink", names: targets.map((r) => r.name) });
      const done = res.shrunk ?? [];
      if (done.length) void window.clips.generateThumbnailsProgressively(done.map((s) => s.name)).catch(() => undefined);
      const failed = res.failed?.length ?? 0;
      const skipped = res.skipped?.length ?? 0;
      setResult({
        tone: failed ? "error" : "success",
        text:
          `Shrunk ${done.length} ${done.length === 1 ? "clip" : "clips"}, ${formatBytes(res.bytesFreed)} saved. The originals are in the Recycle Bin.` +
          (skipped ? ` ${skipped} had nothing to cut.` : "") +
          (failed ? ` ${failed} failed, see the log.` : ""),
      });
    } catch (err) {
      setResult({ tone: "error", text: `Shrink failed: ${(err as Error).message}` });
    }
    afterJob();
  };

  const removeModel = async () => {
    const ok = await confirm({
      title: "Remove speech model",
      message: `Frees ${formatBytes(summary?.speechModel.bytes)}. Auto subtitles download it again the next time you use them.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setRemovingModel(true);
    try {
      await window.clips.uninstallSubtitles();
    } catch (err) {
      toast.show(`Could not remove it: ${(err as Error).message}`, "error");
    } finally {
      setRemovingModel(false);
      loadSummary(true);
    }
  };

  const overlapCtx: OverlapActionCtx = {
    confirm,
    toast,
    displayName,
    removeClips: (names) => lib.removeClips(names),
  };
  const onPairAction = async (fn: () => Promise<boolean>) => {
    if (await fn()) afterJob();
  };

  const s = summary;
  const metaBytes = s ? s.metadata.bytes : 0;
  const otherBytes = s ? s.icons + s.otherFiles : 0;
  const segments = s
    ? [
        { key: "clips", bytes: s.clips.bytes },
        { key: "meta", bytes: metaBytes },
        { key: "other", bytes: otherBytes },
      ]
    : [];

  return (
    <>
      <SetGroup
        title="Clip folder"
        span2
        aside={
          <button type="button" className="set-reset" title="Measure again" aria-label="Measure again" onClick={() => loadSummary(true)}>
            <RefreshCw size={13} />
          </button>
        }
      >
        {s ? (
          <div className="stg-usage">
            <div className="stg-total">
              <span className="stg-total-num">{formatBytes(s.total)}</span>
              <span className="stg-total-sub">
                {s.clips.count.toLocaleString()} clips
                {s.disk ? ` · ${formatBytes(s.disk.free)} free on this drive` : ""}
              </span>
            </div>
            <div className="stg-bar" aria-hidden="true">
              {segments.map((seg) => (
                <span key={seg.key} className={`stg-seg ${seg.key}`} style={{ flexGrow: Math.max(seg.bytes, 0) }} />
              ))}
            </div>
            <div className="stg-legend">
              <div className="stg-legend-row">
                <i className="clips" />
                <span className="stg-legend-name">Clips</span>
                <span className="stg-legend-val">{formatBytes(s.clips.bytes)}</span>
              </div>
              <div className="stg-legend-row">
                <i className="meta" />
                <span className="stg-legend-name">
                  Clip metadata and caches
                  <span className="stg-legend-hint">
                    audio analysis {formatBytes(s.metadata.analysis)} · extracted audio {formatBytes(s.metadata.audioTracks)} · layer media{" "}
                    {formatBytes(s.metadata.layersMedia)} · names, tags, trims {formatBytes(s.metadata.other)}
                  </span>
                </span>
                <span className="stg-legend-val">{formatBytes(metaBytes)}</span>
              </div>
              <div className="stg-legend-row">
                <i className="other" />
                <span className="stg-legend-name">Game icons and other files</span>
                <span className="stg-legend-val">{formatBytes(otherBytes)}</span>
              </div>
              <div className="stg-legend-sep">Outside the clip folder</div>
              <div className="stg-legend-row">
                <i className="app" />
                <span className="stg-legend-name">Thumbnails</span>
                <span className="stg-legend-val">{formatBytes(s.thumbnails)}</span>
              </div>
              <div className="stg-legend-row">
                <i className="app" />
                <span className="stg-legend-name">
                  Speech model for subtitles
                  <span className="stg-legend-hint">{s.speechModel.bytes > 0 ? "Used for auto subtitles" : "Not downloaded"}</span>
                </span>
                <span className="stg-legend-val">
                  {s.speechModel.bytes > 0 ? (
                    <button type="button" className="btn btn-ghost stg-mini" disabled={removingModel} onClick={() => void removeModel()}>
                      {removingModel ? "Removing…" : "Remove"}
                    </button>
                  ) : null}
                  {formatBytes(s.speechModel.bytes)}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="stg-empty">Measuring…</div>
        )}
      </SetGroup>

      <SetGroup title="Clean up" span2>
        <div className="stg-toolbar">
          <div className="stg-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? "on" : ""}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === "overlaps" && overlapState.pairs.length > 0 ? <b>{overlapState.pairs.length}</b> : null}
              </button>
            ))}
          </div>
          {tab === "unopened" || tab === "untagged" ? (
            <Select value={age} options={AGE_OPTIONS} onChange={setAge} width={190} aria-label="Age" />
          ) : null}
          {tab === "overlaps" ? (
            <button type="button" className="btn btn-ghost" disabled={overlapState.scanning} onClick={() => void rescanOverlaps()}>
              <RefreshCw size={13} className={overlapState.scanning ? "spin" : undefined} />
              {overlapState.scanning ? "Checking…" : "Check again"}
            </button>
          ) : null}
        </div>

        {job ? <StatusLine tone="progress">{jobText(job)}</StatusLine> : result ? <StatusLine tone={result.tone}>{result.text}</StatusLine> : null}

        {tab === "overlaps" ? (
          <OverlapList
            pairs={overlapState.pairs}
            scanning={overlapState.scanning}
            scanned={overlapState.scanned}
            busy={busy}
            clipByName={clipByName}
            thumbnails={lib.thumbnails}
            displayName={displayName}
            onMerge={(p) => void onPairAction(() => mergePair(p, overlapCtx))}
            onKeepLonger={(p) => void onPairAction(() => keepLongerPair(p, overlapCtx))}
            onDismiss={(p) => void dismissPair(p)}
          />
        ) : (
          <>
            <p className="set-group-blurb">
              {tab === "biggest" && "Your largest clips first."}
              {tab === "unopened" && "Clips you never opened in the player."}
              {tab === "untagged" && "Clips without a single tag."}
              {tab === "trimmed" && "Clips with a trim. Shrinking cuts the file down to it, sorted by what that gives back."}
            </p>
            <div className="stg-bulk">
              <button type="button" className={`stg-check${allShownSelected ? " on" : ""}`} aria-label="Select all shown" onClick={toggleAll} disabled={shown.length === 0}>
                {allShownSelected ? <Check size={11} strokeWidth={3} /> : null}
              </button>
              <span className="stg-bulk-count">
                {selectedRows.length > 0
                  ? `${selectedRows.length} selected · ${formatBytes(selectedBytes)}`
                  : rows == null
                    ? "Loading…"
                    : `${list.length.toLocaleString()} ${list.length === 1 ? "clip" : "clips"}`}
              </span>
              <span className="stg-bulk-actions">
                <button type="button" className="btn" disabled={busy || selectedTrimmed.length === 0} onClick={() => void shrinkSelected()} title="Only clips with a trim">
                  <Scissors size={14} /> Shrink to trim{selectedTrimmed.length > 0 && selectedTrimmed.length !== selectedRows.length ? ` (${selectedTrimmed.length})` : ""}
                </button>
                <button type="button" className="btn btn-danger" disabled={busy || selectedRows.length === 0} onClick={() => void deleteSelected()}>
                  <Trash2 size={14} /> Delete
                </button>
              </span>
            </div>
            <div className="stg-list">
              {shown.map((r) => (
                <div key={r.name} className={`stg-row${selected.has(r.name) ? " selected" : ""}`} onClick={() => openInPlayer(r.clip)} title="Open in the player">
                  <button
                    type="button"
                    className={`stg-check${selected.has(r.name) ? " on" : ""}`}
                    aria-label={`Select ${r.clip.customName}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(r.name);
                    }}
                  >
                    {selected.has(r.name) ? <Check size={11} strokeWidth={3} /> : null}
                  </button>
                  <Thumb path={lib.thumbnails.get(r.name)} />
                  <RowIcon name={r.name} grey={grey} />
                  <span className="stg-name">
                    <span className="stg-title">{r.clip.customName}</span>
                    <span className="stg-sub" title={absoluteTime(r.clip.createdAt)}>
                      {relativeTime(r.clip.createdAt)}
                      {r.trim ? ` · trimmed to ${formatDuration(r.trim.end - r.trim.start)}` : ""}
                    </span>
                  </span>
                  <span className="stg-num">{formatDuration(r.duration)}</span>
                  <span className="stg-num stg-size">
                    {formatBytes(r.size)}
                    {tab === "trimmed" && r.savable != null ? <span className="stg-save">-{formatBytes(r.savable)}</span> : null}
                  </span>
                </div>
              ))}
              {rows != null && list.length === 0 ? <div className="stg-empty">Nothing here.</div> : null}
            </div>
            {list.length > shown.length ? (
              <button type="button" className="btn btn-ghost stg-more" onClick={() => setLimit((l) => l + PAGE)}>
                Show {Math.min(PAGE, list.length - shown.length)} more
              </button>
            ) : null}
          </>
        )}
      </SetGroup>
    </>
  );
}

function OverlapList({
  pairs,
  scanning,
  scanned,
  busy,
  clipByName,
  thumbnails,
  displayName,
  onMerge,
  onKeepLonger,
  onDismiss,
}: {
  pairs: OverlapPair[];
  scanning: boolean;
  scanned: boolean;
  busy: boolean;
  clipByName: Map<string, LocalClip>;
  thumbnails: Map<string, string | null>;
  displayName: (name: string) => string;
  onMerge: (p: OverlapPair) => void;
  onKeepLonger: (p: OverlapPair) => void;
  onDismiss: (p: OverlapPair) => void;
}) {
  const sorted = useMemo(() => [...pairs].sort((a, b) => (clipByName.get(b.later)?.createdAt ?? 0) - (clipByName.get(a.later)?.createdAt ?? 0)), [pairs, clipByName]);
  const side = (name: string, size: number, duration: number) => {
    const clip = clipByName.get(name);
    return (
      <span
        className="stg-pair-clip"
        title="Open in the player"
        onClick={() => {
          if (clip) openInPlayer(clip);
        }}
      >
        <Thumb path={thumbnails.get(name)} />
        <span className="stg-name">
          <span className="stg-title">{displayName(name)}</span>
          <span className="stg-sub">
            {clip ? `${relativeTime(clip.createdAt)} · ` : ""}
            {formatDuration(duration)} · {formatBytes(size)}
          </span>
        </span>
      </span>
    );
  };
  return (
    <>
      <p className="set-group-blurb">
        Saves pressed within one replay window share footage. Merge them into one clip, or keep the longer one. Found by save time,
        lined up by the audio.
      </p>
      <div className="stg-list">
        {sorted.map((p) => (
          <div key={p.key} className="stg-pair">
            {side(p.earlier, p.earlierSize, p.earlierDuration)}
            {side(p.later, p.laterSize, p.laterDuration)}
            <span className="stg-pair-info">
              <span>
                Shares {formatDuration(p.overlap)}, {p.contained ? "one holds the other" : `merged ${formatDuration(p.mergedDuration)}`}
              </span>
              <span className={`stg-match${p.method === "audio" ? " audio" : ""}`}>
                {p.method === "audio" ? `Audio match ${Math.round((p.confidence ?? 0) * 100)}%` : "Save time only"}
              </span>
            </span>
            <span className="stg-pair-actions">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onMerge(p)}>
                <Merge size={14} /> Merge
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => onKeepLonger(p)}>
                Keep longer
              </button>
              <button type="button" className="stg-x" title="Not a duplicate, hide it" aria-label="Dismiss" onClick={() => onDismiss(p)}>
                <X size={14} />
              </button>
            </span>
          </div>
        ))}
        {sorted.length === 0 ? (
          <div className="stg-empty">{scanning || !scanned ? "Looking for overlapping saves…" : "No overlapping saves."}</div>
        ) : null}
      </div>
    </>
  );
}
