import { useEffect, useState } from "react";
import { FolderOpen, Gamepad2, Play, Tags } from "lucide-react";
import { SetGroup, SetRow } from "../rows";
import Toggle from "../../ui/Toggle";
import Slider from "../../ui/Slider";
import TagManagerModal from "../TagManagerModal";
import { useToast } from "../../ui/Toast";
import type { UseClips } from "../../library/useClips";
import type { UseLibraryFilter } from "../../library/useLibraryFilter";
import { bootSoundLevels, getBootPrefs, setBootPrefs, type BootPrefs } from "../../boot/bootPrefs";
import { disposeBootSoundPreview, previewBootSound, type SoundLayer } from "../../boot/bootSound";
import { getGameOfClip, useGamesVersion } from "../../library/games";

export default function GeneralSection({ lib, filter }: { lib: UseClips; filter: UseLibraryFilter }) {
  const toast = useToast();
  const [changingLocation, setChangingLocation] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  // startup sound switches live with the intro's other preferences (localStorage, read at launch),
  // not settings.json
  const [boot, setBootState] = useState<BootPrefs>(() => getBootPrefs());
  const setBoot = (patch: Partial<BootPrefs>) => {
    const next = setBootPrefs(patch);
    setBootState(next);
    return next;
  };
  useEffect(() => disposeBootSoundPreview, []);
  const levels = bootSoundLevels(boot);
  // a layer at 0 is the old per-layer switch turned off, so old prefs still read right
  const layerRow = (layer: SoundLayer, title: string, description: string, on: keyof BootPrefs, vol: keyof BootPrefs) => (
    <SetRow key={layer} title={title} description={description}>
      <Slider
        value={boot[on] ? Math.round(Number(boot[vol]) * 100) : 0}
        min={0}
        max={100}
        step={5}
        disabled={!boot.sound}
        format={(v) => `${v}%`}
        onCommit={(v) => {
          const next = setBoot(v > 0 ? { [on]: true, [vol]: v / 100 } : { [on]: false });
          // solo the layer so its level is easy to judge
          const solo = { woosh: 0, chimes: 0, motes: 0, wind: 0 };
          solo[layer] = bootSoundLevels(next)[layer];
          previewBootSound(solo);
        }}
        aria-label={`${title} volume`}
      />
    </SetRow>
  );

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
        <SetRow title="Volume">
          <Slider
            value={Math.round(boot.volume * 100)}
            min={0}
            max={100}
            step={5}
            disabled={!boot.sound}
            format={(v) => `${v}%`}
            onCommit={(v) => previewBootSound(bootSoundLevels(setBoot({ volume: v / 100 })))}
            aria-label="Startup sound volume"
          />
          <button
            type="button"
            className="btn"
            title="Play"
            disabled={!boot.sound || Object.values(levels).every((l) => l <= 0)}
            onClick={() => previewBootSound(levels)}
          >
            <Play size={14} />
          </button>
        </SetRow>
        {layerRow("woosh", "Woosh", "As the logo flies through", "woosh", "wooshVolume")}
        {layerRow("chimes", "Chimes", "As the library settles", "chimes", "chimesVolume")}
        {layerRow("motes", "Motes", "Under the drifting lights", "motesSound", "motesVolume")}
        {layerRow("wind", "Wind", "Grass and birds far under the tail, fading out with the chimes", "wind", "windVolume")}
      </SetGroup>


      <TagManagerModal open={tagsOpen} onClose={() => setTagsOpen(false)} lib={lib} filter={filter} />
    </>
  );
}
