import { SetGroup, SetRow, StatusLine } from "../../rows";
import { useClipdip } from "./ClipdipContext";
import { HotkeyCapture } from "./controls";

const HOTKEYS = [
  ["save_clip", "Save clip", "Saves the replay buffer as a clip", "Ctrl+Alt+F10"],
  ["rename_clip", "Rename last clip", "Rename from the save notification", "Ctrl+F10"],
  ["toggle_recording", "Start/stop recording", "Manual recording, separate from the replay buffer", "Ctrl+Alt+F9"],
] as const;

export default function ClipdipHotkeysSection() {
  const { config, patch } = useClipdip();
  const loading = !config;

  return (
    <SetGroup title="Hotkeys" span2>
      {HOTKEYS.map(([key, title, description, fallback]) => (
        <SetRow key={key} title={title} description={description}>
          <HotkeyCapture
            value={String(config?.hotkey?.[key] ?? fallback)}
            disabled={loading}
            onChange={(v) => patch({ hotkey: { [key]: v } })}
          />
        </SetRow>
      ))}
      <StatusLine tone="info">Some games grab keys before Clipdip sees them; pick uncommon combos.</StatusLine>
    </SetGroup>
  );
}
