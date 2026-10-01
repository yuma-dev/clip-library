import { useEffect, useState, useSyncExternalStore } from "react";
import { FolderOpen, FolderSearch, Import, Videotape } from "lucide-react";
import { useSettings } from "../settings/SettingsContext";
import { useAppNav } from "../shell/appNav";
import { useToast } from "../ui/Toast";

// dev: __emptyLibrary() shows this over a full library, __emptyLibrary(false) puts the grid back
let forced = false;
const listeners = new Set<() => void>();
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__emptyLibrary = (on = true) => {
    forced = Boolean(on);
    listeners.forEach((l) => l());
  };
}
export function useForcedEmpty(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => forced,
  );
}

interface Recorder {
  supported: boolean;
  hotkey: string;
  seconds: number;
}

/** first run, or a folder with nothing in it yet. not the "no clips match" of a filter */
export default function EmptyLibrary({ clipLocation }: { clipLocation: string }) {
  const { settings } = useSettings();
  const nav = useAppNav();
  const toast = useToast();
  const enabled = Boolean(settings.clipdip?.enabled);
  const [rec, setRec] = useState<Recorder | null>(null);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.clips.clipdip.getStatus().catch(() => null),
      window.clips.clipdip.getConfig().catch(() => null),
    ]).then(([status, cfg]) => {
      if (cancelled) return;
      setRec({
        supported: status?.supported !== false,
        hotkey: cfg?.config?.hotkey?.save_clip || "Ctrl+Alt+F10",
        seconds: Number(cfg?.config?.replay_seconds) || 60,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const changeFolder = async () => {
    setChanging(true);
    try {
      const next = await window.clips.openFolderDialog();
      if (!next) return;
      await window.clips.setClipLocation(next);
      // same as settings: clips, thumbnails and the watcher all key off the location
      window.location.reload();
    } catch (err) {
      toast.show(`Could not change the clip folder: ${(err as Error).message}`, "error");
    } finally {
      setChanging(false);
    }
  };

  const openFolder = async () => {
    const res = await window.clips.openClipFolder().catch((e: Error) => ({ success: false, error: e.message }));
    if (!res.success) toast.show(`Could not open the folder: ${res.error}`, "error");
  };

  const recording = rec?.supported && enabled;

  return (
    <div className="library-empty">
      <span className="clip-empty-mark dia" aria-hidden="true">
        ◇
      </span>
      <p className="library-empty-title">No clips yet</p>
      {!rec ? null : recording ? (
        <p className="library-empty-sub">
          Press <kbd className="library-empty-key">{rec.hotkey}</kbd> in a game to save the last {rec.seconds} seconds.
          New clips show up here on their own.
        </p>
      ) : rec.supported ? (
        <p className="library-empty-sub">
          Turn on ClipDip to save clips with a hotkey, or pick the folder your recorder already saves to.
        </p>
      ) : (
        <p className="library-empty-sub">
          Pick the folder your recorder saves to, like OBS or ShadowPlay. New clips show up here on their own.
        </p>
      )}

      <div className="library-empty-folder">
        <span className="library-empty-path" title={clipLocation}>
          {clipLocation || "No folder picked"}
        </span>
        <button type="button" className="btn" onClick={() => void changeFolder()} disabled={changing}>
          <FolderSearch size={14} /> {changing ? "Choosing…" : "Change folder"}
        </button>
        {clipLocation ? (
          <button type="button" className="btn btn-ghost" onClick={() => void openFolder()}>
            <FolderOpen size={14} /> Open
          </button>
        ) : null}
      </div>

      <div className="library-empty-actions">
        {rec?.supported && !enabled ? (
          <button type="button" className="btn btn-primary" onClick={() => nav.openSettings("clipdip-general")}>
            <Videotape size={14} /> Set up ClipDip
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={() => nav.openSettings("export")}>
          <Import size={14} /> Import from SteelSeries
        </button>
      </div>
    </div>
  );
}
