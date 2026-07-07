import { SetGroup, SetRow } from "../rows";
import Toggle from "../../ui/Toggle";
import Select from "../../ui/Select";
import { useSettings } from "../SettingsContext";
import { UI_FONTS, fontStack } from "../fonts";

// Mock game-icon tiles for the greyscale preview (real icons live in cards).
const ICON_TILES = [
  "linear-gradient(135deg, #f59e0b, #ef4444)",
  "linear-gradient(135deg, #22d3ee, #6366f1)",
  "linear-gradient(135deg, #4ade80, #16a34a)",
];

export default function AppearanceSection() {
  const { settings, set } = useSettings();
  const grey = Boolean(settings.iconGreyscale);
  const indicators = settings.showNewClipsIndicators !== false;

  return (
    <>
      <SetGroup title="App font">
        <SetRow
          title="Interface font"
          description="Used across the whole app"
        >
          <Select
            value={settings.uiFont || UI_FONTS[0].key}
            width={250}
            options={UI_FONTS.map((f) => ({
              value: f.key,
              label: f.label,
              style: { fontFamily: f.stack },
            }))}
            onChange={(key) => void set("uiFont", key)}
            aria-label="Interface font"
          />
        </SetRow>
        <div className="font-preview" style={{ fontFamily: fontStack(settings.uiFont) }}>
          <div className="font-preview-title">Yesterday · 12 clips</div>
          <div className="font-preview-body">
            The quick brown fox backflips over the lazy teammate. 0123456789
          </div>
          <div className="font-preview-chips">
            <span className="tag">Highlight</span>
            <span className="tag">Ranked</span>
            <span className="font-preview-time">2 hours ago</span>
          </div>
        </div>
      </SetGroup>

      <SetGroup title="Library">
        <SetRow
          title="New clip indicators"
          description="Highlight clips recorded since your last session"
        >
          <div className="set-preview-pair">
            <div className={`newclip-preview${indicators ? " on" : ""}`} aria-hidden="true">
              <div className="newclip-preview-thumb" />
              <div className="newclip-preview-foot">
                {indicators ? <span className="clip-new-dot" /> : null}
                <span className="newclip-preview-name">Clutch ace</span>
              </div>
            </div>
            <Toggle checked={indicators} onChange={(v) => void set("showNewClipsIndicators", v)} aria-label="New clip indicators" />
          </div>
        </SetRow>

        <SetRow
          title="Greyscale game icons"
          description="Mute the game icons on clip cards so thumbnails stand out"
        >
          <div className="set-preview-pair">
            <div className="icon-preview" aria-hidden="true">
              {ICON_TILES.map((bg) => (
                <span
                  key={bg}
                  className="icon-preview-tile"
                  style={{ background: bg, filter: grey ? "grayscale(1) contrast(1.02)" : "none", opacity: grey ? 0.9 : 1 }}
                />
              ))}
            </div>
            <Toggle checked={grey} onChange={(v) => void set("iconGreyscale", v)} aria-label="Greyscale game icons" />
          </div>
        </SetRow>
      </SetGroup>
    </>
  );
}
