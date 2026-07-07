import { useState } from "react";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { GroupReset, SetGroup, SetRow } from "../rows";
import Toggle from "../../ui/Toggle";
import Slider from "../../ui/Slider";
import Select from "../../ui/Select";
import GlowPreview from "../GlowPreview";
import CardGlowPreview from "../CardGlowPreview";
import {
  AMBIENT_GLOW_DEFAULTS,
  CARD_GLOW_DEFAULTS,
  useSettings,
  type AmbientGlowSettings,
  type CardGlowSettings,
} from "../SettingsContext";

const FPS_OPTIONS = [
  { value: "15", label: "15 fps" },
  { value: "24", label: "24 fps" },
  { value: "30", label: "30 fps" },
  { value: "60", label: "60 fps" },
];

export default function PlayerSection({ sampleThumb }: { sampleThumb: string | null }) {
  const { settings, set } = useSettings();
  // Drag-in-progress overrides so the previews react live before commit.
  const [glowDraft, setGlowDraft] = useState<Partial<AmbientGlowSettings>>({});
  const [cardDraft, setCardDraft] = useState<Partial<CardGlowSettings>>({});
  const glow: AmbientGlowSettings = { ...settings.ambientGlow, ...glowDraft };
  const card: CardGlowSettings = { ...settings.cardGlow, ...cardDraft };
  const volume = settings.previewVolume ?? 0.1;

  // Provider side effects push committed values into the player / grid glow.
  const commitGlow = (key: keyof AmbientGlowSettings, value: number | boolean) => {
    setGlowDraft((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
    void set(`ambientGlow.${key}`, value);
  };

  const commitCard = (key: keyof CardGlowSettings, value: number | boolean) => {
    setCardDraft((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
    void set(`cardGlow.${key}`, value);
  };

  const VolumeIcon = volume === 0 ? VolumeX : volume < 0.4 ? Volume1 : Volume2;

  return (
    <>
      <SetGroup
        title="Playback"
        span2
        aside={<GroupReset onClick={() => void set("previewVolume", 0.1)} />}
      >
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
        title="Ambient glow — player"
        span2
        aside={
          <>
            <GroupReset onClick={() => void set("ambientGlow", { ...AMBIENT_GLOW_DEFAULTS })} />
            <Toggle checked={glow.enabled} onChange={(v) => commitGlow("enabled", v)} aria-label="Enable ambient glow" />
          </>
        }
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
                onInput={(v) => setGlowDraft((d) => ({ ...d, smoothing: v }))}
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
                onInput={(v) => setGlowDraft((d) => ({ ...d, blur: v }))}
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
                onInput={(v) => setGlowDraft((d) => ({ ...d, opacity: v }))}
                onCommit={(v) => commitGlow("opacity", v)}
                aria-label="Glow opacity"
              />
            </SetRow>
          </div>
          <div className="glow-preview-col">
            <GlowPreview glow={glow} thumb={sampleThumb} />
            <span className="glow-preview-caption">Live preview</span>
          </div>
        </div>
      </SetGroup>

      <SetGroup
        title="Card hover glow — library"
        span2
        aside={
          <>
            <GroupReset onClick={() => void set("cardGlow", { ...CARD_GLOW_DEFAULTS })} />
            <Toggle checked={card.enabled} onChange={(v) => commitCard("enabled", v)} aria-label="Enable card hover glow" />
          </>
        }
      >
        <div className="glow-layout">
          <div className={`glow-controls${card.enabled ? "" : " disabled"}`}>
            <SetRow title="Opacity" description="How strong the glow behind a hovered card is">
              <Slider
                value={card.opacity}
                min={0.1}
                max={1}
                step={0.05}
                format={(v) => `${Math.round(v * 100)}%`}
                disabled={!card.enabled}
                onInput={(v) => setCardDraft((d) => ({ ...d, opacity: v }))}
                onCommit={(v) => commitCard("opacity", v)}
                aria-label="Card glow opacity"
              />
            </SetRow>
            <SetRow title="Blur" description="How soft the color bleed around the card is">
              <Slider
                value={card.blur}
                min={10}
                max={100}
                step={5}
                format={(v) => `${v}px`}
                disabled={!card.enabled}
                onInput={(v) => setCardDraft((d) => ({ ...d, blur: v }))}
                onCommit={(v) => commitCard("blur", v)}
                aria-label="Card glow blur"
              />
            </SetRow>
            <SetRow title="Saturation" description="Color intensity of the glow">
              <Slider
                value={card.saturate}
                min={1}
                max={2.5}
                step={0.1}
                format={(v) => `${v.toFixed(1)}×`}
                disabled={!card.enabled}
                onInput={(v) => setCardDraft((d) => ({ ...d, saturate: v }))}
                onCommit={(v) => commitCard("saturate", v)}
                aria-label="Card glow saturation"
              />
            </SetRow>
            <SetRow title="Brightness" description="Overall brightness of the glow">
              <Slider
                value={card.brightness}
                min={0.5}
                max={1.6}
                step={0.05}
                format={(v) => `${v.toFixed(2)}×`}
                disabled={!card.enabled}
                onInput={(v) => setCardDraft((d) => ({ ...d, brightness: v }))}
                onCommit={(v) => commitCard("brightness", v)}
                aria-label="Card glow brightness"
              />
            </SetRow>
          </div>
          <div className="glow-preview-col">
            <CardGlowPreview glow={card} thumb={sampleThumb} />
            <span className="glow-preview-caption">Live preview</span>
          </div>
        </div>
      </SetGroup>
    </>
  );
}
