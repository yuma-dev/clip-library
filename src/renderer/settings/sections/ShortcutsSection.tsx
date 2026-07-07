import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  ClipboardCopy,
  FastForward,
  FileAudio,
  FileVideo,
  Maximize,
  Pencil,
  Play,
  Rewind,
  RotateCcw,
  SkipBack,
  SkipForward,
  Trash2,
  Volume1,
  Volume2,
  X,
  type LucideIcon,
} from "lucide-react";
import { SetGroup } from "../rows";
import { useSettings } from "../SettingsContext";
import { useConfirm } from "../../ui/ConfirmDialog";
import { useToast } from "../../ui/Toast";
import { DEFAULT_KEYBINDINGS } from "../../player/keybindings";

const ACTIONS: { id: string; title: string; description: string; icon: LucideIcon }[] = [
  { id: "playPause", title: "Play / Pause", description: "Toggle video playback", icon: Play },
  { id: "frameBackward", title: "Frame backward", description: "Step one frame back", icon: ChevronLeft },
  { id: "frameForward", title: "Frame forward", description: "Step one frame forward", icon: ChevronRight },
  { id: "skipBackward", title: "Skip backward", description: "Jump back 3% of duration", icon: Rewind },
  { id: "skipForward", title: "Skip forward", description: "Jump forward 3% of duration", icon: FastForward },
  { id: "navigatePrev", title: "Previous clip", description: "Open previous clip in list", icon: SkipBack },
  { id: "navigateNext", title: "Next clip", description: "Open next clip in list", icon: SkipForward },
  { id: "volumeUp", title: "Volume up", description: "Increase playback volume", icon: Volume2 },
  { id: "volumeDown", title: "Volume down", description: "Decrease playback volume", icon: Volume1 },
  { id: "exportDefault", title: "Export trimmed video", description: "Export current trim to clipboard", icon: Clapperboard },
  { id: "exportVideo", title: "Export video (file)", description: "Export full video to file", icon: FileVideo },
  { id: "exportAudioFile", title: "Export audio (file)", description: "Export audio to file", icon: FileAudio },
  { id: "exportAudioClipboard", title: "Export audio (clipboard)", description: "Copy audio to clipboard", icon: ClipboardCopy },
  { id: "fullscreen", title: "Toggle fullscreen", description: "Enter or exit fullscreen player", icon: Maximize },
  { id: "deleteClip", title: "Delete clip", description: "Delete the current clip", icon: Trash2 },
  { id: "setTrimStart", title: "Set trim start", description: "Mark trim start at the playhead", icon: ChevronLeft },
  { id: "setTrimEnd", title: "Set trim end", description: "Mark trim end at the playhead", icon: ChevronRight },
  { id: "focusTitle", title: "Edit title", description: "Begin editing the clip title", icon: Pencil },
  { id: "closePlayer", title: "Close player", description: "Close the player", icon: X },
];

/** "ctrl+shift+e" -> "Ctrl+Shift+E" for display. */
function prettyCombo(combo: string | undefined): string {
  if (!combo) return "";
  return combo
    .split("+")
    .map((p) => (p.length === 1 ? p.toUpperCase() : p))
    .join(" + ");
}

function normalise(combo: string): string {
  return combo
    .split("+")
    .map((p) => (p.length === 1 ? p.toLowerCase() : p))
    .join("+");
}

export default function ShortcutsSection() {
  const { settings, set } = useSettings();
  const confirm = useConfirm();
  const toast = useToast();
  const [capturing, setCapturing] = useState<string | null>(null);
  const [captureText, setCaptureText] = useState("");

  const bindings: Record<string, string> = useMemo(
    () => ({ ...DEFAULT_KEYBINDINGS, ...(settings.keybindings ?? {}) }),
    [settings.keybindings],
  );

  // Two actions on the same combo — flag both rows.
  const conflicts = useMemo(() => {
    const byCombo = new Map<string, string[]>();
    for (const [action, combo] of Object.entries(bindings)) {
      const key = normalise(combo);
      byCombo.set(key, [...(byCombo.get(key) ?? []), action]);
    }
    const flagged = new Map<string, string[]>();
    for (const actions of byCombo.values()) {
      if (actions.length > 1) for (const a of actions) flagged.set(a, actions.filter((x) => x !== a));
    }
    return flagged;
  }, [bindings]);

  // The provider applies the map to the live player on every commit (and on
  // undo/redo), so persisting is all that's needed here.
  const persist = (next: Record<string, string>) => {
    void set("keybindings", next);
  };

  // Key-capture flow (legacy keybinding-ui.js): show held keys live, commit
  // when the last key is released.
  const pressedRef = useRef(new Set<string>());
  const comboRef = useRef("");
  useEffect(() => {
    if (!capturing) return;
    pressedRef.current.clear();
    comboRef.current = "";
    setCaptureText("Press keys…");

    const build = (e: KeyboardEvent) => {
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");
      const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (!["Control", "Shift", "Alt", "Meta"].includes(e.key)) parts.push(key);
      return parts.join("+");
    };

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      pressedRef.current.add(e.code);
      const combo = build(e);
      comboRef.current = combo;
      setCaptureText(combo || "Press keys…");
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      pressedRef.current.delete(e.code);
      if (pressedRef.current.size > 0) return;

      const display = comboRef.current;
      setCapturing(null);
      // Releasing only modifiers (no main key) cancels the capture.
      if (!display || ["Ctrl", "Shift", "Alt"].includes(display.split("+").pop() ?? "")) return;

      const combo = normalise(display);
      const clash = Object.entries(bindings).find(
        ([action, existing]) => action !== capturing && normalise(existing) === combo,
      );
      persist({ ...bindings, [capturing]: combo });
      if (clash) {
        const title = ACTIONS.find((a) => a.id === clash[0])?.title ?? clash[0];
        toast.show(`"${prettyCombo(combo)}" is also bound to ${title}`, "error");
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);

  const resetAll = async () => {
    const ok = await confirm.confirm({
      title: "Reset shortcuts",
      message: "Reset all keyboard shortcuts to their default values?",
      confirmLabel: "Reset",
    });
    if (!ok) return;
    try {
      const defaults = await window.clips.getDefaultKeybindings();
      persist({ ...DEFAULT_KEYBINDINGS, ...(defaults ?? {}) });
      toast.show("Shortcuts reset to defaults", "success");
    } catch {
      persist({ ...DEFAULT_KEYBINDINGS });
      toast.show("Shortcuts reset to defaults", "success");
    }
  };

  return (
    <SetGroup
      title="Player shortcuts"
      span2
      aside={
        <button type="button" className="btn btn-ghost kb-reset" onClick={() => void resetAll()}>
          <RotateCcw size={13} /> Reset to defaults
        </button>
      }
    >
      <p className="kb-hint">Click a shortcut, then press the new key combination.</p>
      <div className="kb-list">
        {ACTIONS.map(({ id, title, description, icon: Icon }) => {
          const isCapturing = capturing === id;
          const conflictWith = conflicts.get(id);
          return (
            <div className="kb-row" key={id}>
              <span className="kb-ico">
                <Icon size={15} />
              </span>
              <div className="kb-info">
                <div className="kb-title">{title}</div>
                <div className="kb-desc">
                  {conflictWith?.length
                    ? `Also bound to ${conflictWith
                        .map((a) => ACTIONS.find((x) => x.id === a)?.title ?? a)
                        .join(", ")}`
                    : description}
                </div>
              </div>
              <button
                type="button"
                className={`kb-box${isCapturing ? " editing" : ""}${conflictWith?.length ? " conflict" : ""}`}
                onClick={() => setCapturing(isCapturing ? null : id)}
              >
                {isCapturing ? captureText : prettyCombo(bindings[id]) || "Unbound"}
              </button>
            </div>
          );
        })}
      </div>
    </SetGroup>
  );
}
