import { useState } from "react";
import { FolderOpen, Tags } from "lucide-react";
import { SetGroup, SetRow } from "../rows";
import Toggle from "../../ui/Toggle";
import TagManagerModal from "../TagManagerModal";
import { useSettings } from "../SettingsContext";
import { useToast } from "../../ui/Toast";
import { setDiscordPresenceEnabled } from "../../player/discordPresence";
import type { UseClips } from "../../library/useClips";
import type { UseLibraryFilter } from "../../library/useLibraryFilter";
import { getBootPrefs, setBootPrefs, type BootPrefs, type WooshVariant } from "../../boot/bootPrefs";
import Select from "../../ui/Select";

const WOOSH_OPTIONS: { value: WooshVariant; label: string }[] = [
  { value: "classic", label: "Classic" },
  { value: "flight", label: "Take flight" },
  { value: "creature", label: "Creature" },
  { value: "pointer", label: "Pointer" },
  { value: "gust", label: "Gust" },
];

export default function GeneralSection({ lib, filter }: { lib: UseClips; filter: UseLibraryFilter }) {
  const { settings, set } = useSettings();
  const toast = useToast();
  const [changingLocation, setChangingLocation] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  // Startup sound switches live with the intro's other preferences
  // (localStorage, read at launch), not in settings.json.
  const [boot, setBootState] = useState<BootPrefs>(() => getBootPrefs());
  const setBoot = (patch: Partial<BootPrefs>) => setBootState(setBootPrefs(patch));

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
    // Flip the renderer-side gate + re-assert presence when re-enabled.
    setDiscordPresenceEnabled(enabled);
    if (!ok) toast.show("Failed to save setting", "error");
  };

  return (
    <>
      <SetGroup title="Clip library location" span2>
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

      <SetGroup title="Startup sound">
        <SetRow title="Play a sound at startup" description="The layers below play with the intro. Applies at the next launch.">
          <Toggle checked={boot.sound} onChange={(v) => setBoot({ sound: v })} aria-label="Startup sound" />
        </SetRow>
        <SetRow title="Woosh" description="As the logo flies through">
          <Toggle checked={boot.woosh} onChange={(v) => setBoot({ woosh: v })} disabled={!boot.sound} aria-label="Woosh" />
        </SetRow>
        <SetRow title="Woosh sound" description="Which whoosh plays">
          <Select
            value={boot.wooshVariant}
            width={180}
            options={WOOSH_OPTIONS}
            onChange={(v) => setBoot({ wooshVariant: v as WooshVariant })}
            disabled={!boot.sound || !boot.woosh}
            aria-label="Woosh sound"
          />
        </SetRow>
        <SetRow title="Chimes" description="As the library settles">
          <Toggle checked={boot.chimes} onChange={(v) => setBoot({ chimes: v })} disabled={!boot.sound} aria-label="Chimes" />
        </SetRow>
        <SetRow title="Motes" description="Under the drifting lights">
          <Toggle checked={boot.motesSound} onChange={(v) => setBoot({ motesSound: v })} disabled={!boot.sound} aria-label="Motes sound" />
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
