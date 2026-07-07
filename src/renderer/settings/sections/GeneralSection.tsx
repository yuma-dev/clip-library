import { useState } from "react";
import { FolderOpen, Tags } from "lucide-react";
import { SetGroup, SetRow } from "../rows";
import Toggle from "../../ui/Toggle";
import TagManagerModal from "../TagManagerModal";
import { useSettings } from "../SettingsContext";
import { useToast } from "../../ui/Toast";
import type { UseClips } from "../../library/useClips";
import type { UseLibraryFilter } from "../../library/useLibraryFilter";

export default function GeneralSection({ lib, filter }: { lib: UseClips; filter: UseLibraryFilter }) {
  const { settings, set } = useSettings();
  const toast = useToast();
  const [changingLocation, setChangingLocation] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);

  const changeLocation = async () => {
    setChangingLocation(true);
    try {
      const newLocation = await window.clips.openFolderDialog();
      if (!newLocation) return;
      await window.clips.setClipLocation(newLocation);
      // The whole library (clips, thumbnails, watchers) keys off the location —
      // a clean reload is the reliable way to swing everything over.
      window.location.reload();
    } catch (err) {
      toast.show(`Failed to change clip location: ${(err as Error).message}`, "error");
    } finally {
      setChangingLocation(false);
    }
  };

  const toggleDiscord = async (enabled: boolean) => {
    const ok = await set("enableDiscordRPC", enabled);
    try {
      await window.clips.toggleDiscordRpc(enabled);
    } catch {
      /* RPC connection issues are non-fatal; the saved setting still applies next launch */
    }
    if (!ok) toast.show("Failed to save setting", "error");
  };

  return (
    <>
      <SetGroup title="Clip library location">
        <SetRow
          title="Current location"
          description={<span className="set-mono">{lib.clipLocation || "Not set"}</span>}
        >
          <button type="button" className="btn" onClick={() => void changeLocation()} disabled={changingLocation}>
            <FolderOpen size={14} /> {changingLocation ? "Choosing…" : "Change location"}
          </button>
        </SetRow>
      </SetGroup>

      <SetGroup title="Integration">
        <SetRow title="Discord Rich Presence" description="Show what you're watching in your Discord status">
          <Toggle
            checked={Boolean(settings.enableDiscordRPC)}
            onChange={(v) => void toggleDiscord(v)}
            aria-label="Discord Rich Presence"
          />
        </SetRow>
      </SetGroup>

      <SetGroup title="Tags">
        <SetRow
          title="Manage tags"
          description="Create, rename, and delete tags across your whole library"
        >
          <button type="button" className="btn" onClick={() => setTagsOpen(true)}>
            <Tags size={14} /> Manage tags
          </button>
        </SetRow>
      </SetGroup>

      <TagManagerModal open={tagsOpen} onClose={() => setTagsOpen(false)} lib={lib} filter={filter} />
    </>
  );
}
