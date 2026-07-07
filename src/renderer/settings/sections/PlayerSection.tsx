import { useState } from "react";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { SetGroup, SetRow } from "../rows";
import Toggle from "../../ui/Toggle";
import Slider from "../../ui/Slider";
import Select from "../../ui/Select";
import GlowPreview from "../GlowPreview";
import { useSettings, type AmbientGlowSettings } from "../SettingsContext";

const FPS_OPTIONS = [
  { value: "15", label: "15 fps" },
  { value: "24", label: "24 fps" },
  { value: "30", label: "30 fps" },
  { value: "60", label: "60 fps" },
];

export default function PlayerSection() {
  const { settings, set } = useSettings();
  // Drag-in-progress overrides so the glow preview reacts live before commit.
  const [draft, setDraft] = useState<Partial<AmbientGlowSettings>>({});
  const glow: AmbientGlowSettings = { ...settings.ambientGlow, ...draft };
  const volume = settings.previewVolume ?? 0.1;

  const commitGlow = (key: keyof AmbientGlowSettings, value: number | boolean) => {
    setDraft((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
    void set(`ambientGlow.${key}`, value).then(() => {
      // Push into the open legacy player immediately (it applies on next frame).
      window.legacyPlayer?.applyAmbientGlowSettings({ ...glow, [key]: value });
    });
  };

  const VolumeIcon = volume === 0 ? VolumeX : volume < 0.4 ? Volume1 : Volume2;

  return (
    <>
      <SetGroup title="Playback">
        <SetRow title="Preview volume" description="Volume of the hover previews in the library grid">
          <div className="set-preview-pair">
            <VolumeIcon size={16} className="set-dim-icon" />
            <Slider
              value={volume}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onCommit={(v) => void set("previewVolume", v)}
              aria-label="Preview volume"
            />
          </div>
        </SetRow>
      </SetGroup>

      <SetGroup
        title="Ambient glow"
        aside={<Toggle checked={glow.enabled} onChange={(v) => commitGlow("enabled", v)} aria-label="Enable ambient glow" />}
      >
        <div className="glow-layout">
          <div className={`glow-controls${glow.enabled ? "" : " disabled"}`}>
            <SetRow title="Smoothing" description="How quickly the glow follows the video (lower = smoother)">
              <Slider
                value={glow.smoothing}
                min={0.1}
                max={1}
                step={0.1}
                format={(v) => v.toFixed(1)}
                disabled={!glow.enabled}
                onInput={(v) => setDraft((d) => ({ ...d, smoothing: v }))}
                onCommit={(v) => commitGlow("smoothing", v)}
                aria-label="Glow smoothing"
              />
            </SetRow>
            <SetRow title="Update rate" description="Higher is smoother but uses more CPU">
              <Select
                value={String(glow.fps)}
                width={120}
                options={FPS_OPTIONS}
                disabled={!glow.enabled}
                onChange={(v) => commitGlow("fps", parseInt(v, 10))}
                aria-label="Glow update rate"
              />
            </SetRow>
            <SetRow title="Blur" description="How far the glow bleeds out">
              <Slider
                value={glow.blur}
                min={40}
                max={120}
                step={10}
                format={(v) => `${v}px`}
                disabled={!glow.enabled}
                onInput={(v) => setDraft((d) => ({ ...d, blur: v }))}
                onCommit={(v) => commitGlow("blur", v)}
                aria-label="Glow blur"
              />
            </SetRow>
            <SetRow title="Opacity" description="How visible the glow is">
              <Slider
                value={glow.opacity}
                min={0.3}
                max={1}
                step={0.1}
                format={(v) => `${Math.round(v * 100)}%`}
                disabled={!glow.enabled}
                onInput={(v) => setDraft((d) => ({ ...d, opacity: v }))}
                onCommit={(v) => commitGlow("opacity", v)}
                aria-label="Glow opacity"
              />
            </SetRow>
          </div>
          <div className="glow-preview-col">
            <GlowPreview glow={glow} />
            <span className="glow-preview-caption">Live preview</span>
          </div>
        </div>
      </SetGroup>
    </>
  );
}
