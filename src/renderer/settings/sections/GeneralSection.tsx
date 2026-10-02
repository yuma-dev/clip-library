import { useState } from "react";
import { FolderOpen, Gamepad2, Tags } from "lucide-react";
import { SetGroup, SetRow } from "../rows";
import Toggle from "../../ui/Toggle";
import TagManagerModal from "../TagManagerModal";
import { useToast } from "../../ui/Toast";
import type { UseClips } from "../../library/useClips";
import type { UseLibraryFilter } from "../../library/useLibraryFilter";
import { getBootPrefs, setBootPrefs, type BootPrefs } from "../../boot/bootPrefs";
import { getGameOfClip, useGamesVersion } from "../../library/games";

export default function GeneralSection({ lib, filter }: { lib: UseClips; filter: UseLibraryFilter }) {
  const toast = useToast();
  const [changingLocation, setChangingLocation] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  // startup sound switches live with the intro's other preferences (localStorage, read at launch),
  // not settings.json
  const [boot, setBootState] = useState<BootPrefs>(() => getBootPrefs());
  const setBoot = (patch: Partial<BootPrefs>) => setBootState(setBootPrefs(patch));

  const changeLocation = async () => {
    setChangingLocation(true);
    try {
      const newLocation = await window.clips.openFolderDialog();
      if (!newLocation) return;
      await window.clips.setClipLocation(newLocation);
      // whole library (clips, thumbnails, watchers) keys off the location; a clean reload swings
      // everything over
      window.location.reload();
    } catch (err) {
      toast.show(`Failed to change clip location: ${(err as Error).message}`, "error");
    } finally {
      setChangingLocation(false);
    }
  };

  useGamesVersion();
  const tagged = lib.clips.reduce((n, c) => n + (getGameOfClip().has(c.originalName) ? 1 : 0), 0);
  const [scanning, setScanning] = useState(false);
  const findGames = async () => {
    setScanning(true);
    try {
      const r = await window.clips.runGameBackfill();
      if (!r) toast.show("Already looking, try again in a moment");
      else if ("error" in r) toast.show(`Couldn't look up games: ${r.error}`, "error");
      else toast.show(r.tagged > 0 ? `Found the game for ${r.tagged} more clips` : "No new games found", "success");
    } finally {
      setScanning(false);
    }
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

      {/* sound group is tall; left column groups stack on their own so its height can't push them down */}
      <div className="set-col">
        <SetGroup title="Games">
          <SetRow
            title="Find games for older clips"
            description={`${tagged} of ${lib.clips.length} clips have a game. Right click a clip to set one by hand.`}
          >
            <button type="button" className="btn" onClick={() => void findGames()} disabled={scanning}>
              <Gamepad2 size={14} /> {scanning ? "Looking…" : "Look again"}
            </button>
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
      </div>

      <SetGroup title="Startup sound">
        <SetRow title="Play a sound at startup" description="The layers below play with the intro. Applies at the next launch.">
          <Toggle checked={boot.sound} onChange={(v) => setBoot({ sound: v })} aria-label="Startup sound" />
        </SetRow>
        <SetRow title="Woosh" description="As the logo flies through">
          <Toggle checked={boot.woosh} onChange={(v) => setBoot({ woosh: v })} disabled={!boot.sound} aria-label="Woosh" />
        </SetRow>
        <SetRow title="Chimes" description="As the library settles">
          <Toggle checked={boot.chimes} onChange={(v) => setBoot({ chimes: v })} disabled={!boot.sound} aria-label="Chimes" />
        </SetRow>
        <SetRow title="Motes" description="Under the drifting lights">
          <Toggle checked={boot.motesSound} onChange={(v) => setBoot({ motesSound: v })} disabled={!boot.sound} aria-label="Motes sound" />
        </SetRow>
        <SetRow title="Wind" description="Grass and birds far under the tail, fading out with the chimes">
          <Toggle checked={boot.wind} onChange={(v) => setBoot({ wind: v })} disabled={!boot.sound} aria-label="Wind" />
        </SetRow>
      </SetGroup>


      <TagManagerModal open={tagsOpen} onClose={() => setTagsOpen(false)} lib={lib} filter={filter} />
    </>
  );
}
