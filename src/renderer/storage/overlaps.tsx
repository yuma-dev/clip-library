import { useSyncExternalStore } from "react";
import type { OverlapPair, OverlapState } from "../../types/clips";
import type { useConfirm } from "../ui/ConfirmDialog";
import type { useToast } from "../ui/Toast";
import { formatBytes, formatDuration, jobText, runStorageJob, useStorageJob } from "./jobs";
import "./overlaps.css";

// overlapping saves found by main (main/overlaps.js); cards, the context menu and settings read it
let state: OverlapState = { pairs: [], scanning: false, scanned: false };
let byName = new Map<string, OverlapPair[]>();
const listeners = new Set<() => void>();
let wired = false;

function apply(next: OverlapState) {
  state = next;
  byName = new Map();
  for (const p of next.pairs) {
    for (const n of [p.earlier, p.later]) {
      const list = byName.get(n);
      if (list) list.push(p);
      else byName.set(n, [p]);
    }
  }
  for (const l of listeners) l();
}

function wire() {
  if (wired || !window.clips?.onOverlapsChanged) return;
  wired = true;
  window.clips.onOverlapsChanged(apply);
  // listen only: the startup scan is main's call, this just picks up an existing result
  void window.clips.getOverlaps(false).then(apply).catch(() => undefined);
}

function subscribe(cb: () => void) {
  wire();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useOverlapState(): OverlapState {
  return useSyncExternalStore(subscribe, () => state);
}

/** boolean snapshot, so a card only re-renders when its own flag flips */
export function useHasOverlap(name: string): boolean {
  return useSyncExternalStore(subscribe, () => byName.has(name));
}

/** biggest shared stretch first */
export function pairsFor(name: string): OverlapPair[] {
  return [...(byName.get(name) ?? [])].sort((a, b) => b.overlap - a.overlap);
}

export function refreshOverlaps(startIfIdle = true) {
  wire();
  return window.clips.getOverlaps(startIfIdle).then(apply);
}

export function rescanOverlaps() {
  wire();
  return window.clips.rescanOverlaps().then(apply);
}

type Confirm = ReturnType<typeof useConfirm>["confirm"];
type Toast = ReturnType<typeof useToast>;

export interface OverlapActionCtx {
  confirm: Confirm;
  toast: Toast;
  removeClips: (names: string[]) => void;
  displayName: (name: string) => string;
}

function JobToast({ fallback }: { fallback: string }) {
  const job = useStorageJob();
  return <>{job ? jobText(job) : fallback}</>;
}

const quote = (s: string) => `"${s}"`;

export async function mergePair(pair: OverlapPair, ctx: OverlapActionCtx): Promise<boolean> {
  const a = ctx.displayName(pair.earlier);
  const b = ctx.displayName(pair.later);
  const ok = await ctx.confirm({
    title: "Merge overlapping saves",
    message: (
      <>
        {quote(a)} and {quote(b)} share {formatDuration(pair.overlap)} of footage. The merged clip runs{" "}
        {formatDuration(pair.mergedDuration)}, keeps the first name, tags and layers from both, and drops the trims. Both
        originals go to the Recycle Bin.
        {pair.method === "timestamp" ? (
          <>
            <br />
            <br />
            The audio gave no clear match, so they are lined up by save time and the join can be off by a moment.
          </>
        ) : null}
      </>
    ),
    confirmLabel: "Merge",
  });
  if (!ok) return false;
  const tid = ctx.toast.show(<JobToast fallback="Merging clips…" />, "info", 0);
  try {
    const res = await runStorageJob({ kind: "merge", key: pair.key });
    ctx.toast.dismiss(tid);
    ctx.removeClips((res.removed ?? []).filter((n) => n !== res.merged));
    if (res.kept) ctx.toast.show("One save already held the other, kept the longer one", "success");
    else ctx.toast.show(res.failed?.length ? "Merged, but an original could not be moved to the Recycle Bin" : "Merged", res.failed?.length ? "error" : "success");
    return true;
  } catch (err) {
    ctx.toast.dismiss(tid);
    ctx.toast.show(`Merge failed: ${(err as Error).message}`, "error", 6000);
    return false;
  }
}

export async function keepLongerPair(pair: OverlapPair, ctx: OverlapActionCtx): Promise<boolean> {
  const keepEarlier = pair.earlierDuration > pair.laterDuration + 0.05;
  const drop = keepEarlier ? pair.later : pair.earlier;
  const dropSize = keepEarlier ? pair.laterSize : pair.earlierSize;
  const ok = await ctx.confirm({
    title: "Keep the longer save",
    message: `Move ${quote(ctx.displayName(drop))} (${formatBytes(dropSize)}) to the Recycle Bin? Its tags move to the one you keep, its trim and layers do not.`,
    confirmLabel: "Move to Recycle Bin",
    danger: true,
  });
  if (!ok) return false;
  try {
    const res = await runStorageJob({ kind: "keep-longer", key: pair.key });
    ctx.removeClips(res.removed ?? []);
    ctx.toast.show(`Moved to the Recycle Bin, ${formatBytes(res.bytesFreed)}`, "success");
    return true;
  } catch (err) {
    ctx.toast.show(`Could not remove it: ${(err as Error).message}`, "error", 6000);
    return false;
  }
}

export async function dismissPair(pair: OverlapPair) {
  apply(await window.clips.dismissOverlap(pair.key));
}
