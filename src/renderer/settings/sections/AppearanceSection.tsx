import { GroupReset, SetGroup, SetRow } from "../rows";
import Toggle from "../../ui/Toggle";
import Select from "../../ui/Select";
import { useSettings } from "../SettingsContext";
import { UI_FONTS, UI_FONT_DEFAULT, fontStack } from "../fonts";

// Mock game-icon tiles for the greyscale preview (real icons live in cards).
const ICON_TILES = [
  { bg: "linear-gradient(135deg, #f59e0b, #ef4444)", label: "Valorant" },
  { bg: "linear-gradient(135deg, #22d3ee, #6366f1)", label: "Overwatch 2" },
  { bg: "linear-gradient(135deg, #4ade80, #16a34a)", label: "CS2" },
];

/** Mini clip card used by both library previews. */
function MockCard({ isNew, showDot, icon, grey }: { isNew?: boolean; showDot?: boolean; icon?: string; grey?: boolean }) {
  return (
    <div className={`mock-card${isNew ? " is-new" : ""}`} aria-hidden="true">
      <div className="mock-card-thumb" />
      <div className="mock-card-foot">
        <div className="mock-card-text">
          <div className="mock-card-name">
            {showDot ? <span className="clip-new-dot" /> : null}
            {isNew ? "Clutch ace" : "Ranked warmup"}
          </div>
          <div className="mock-card-meta">
            <span>{isNew ? "12m ago" : "2d ago"}</span>
            <span className="tag">{isNew ? "Highlight" : "Practice"}</span>
          </div>
        </div>
        {icon ? (
          <span
            className="mock-card-icon"
            style={{ background: icon, filter: grey ? "grayscale(1) contrast(1.02)" : "none", opacity: grey ? 0.9 : 1 }}
          />
        ) : null}
      </div>
    </div>
  );
}

export default function AppearanceSection() {
  const { settings, set } = useSettings();
  const grey = Boolean(settings.iconGreyscale);
  const indicators = settings.showNewClipsIndicators !== false;

  return (
    <>
      <SetGroup
        title="App font"
        span2
        aside={<GroupReset onClick={() => void set("uiFont", UI_FONT_DEFAULT)} />}
      >
        <div className="font-flex">
          <div className="font-pick">
            <SetRow title="Interface font" description="Used across the whole app" stacked>
              <Select
                value={settings.uiFont || UI_FONT_DEFAULT}
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
          </div>
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
        </div>
      </SetGroup>

      <SetGroup
        title="New clip indicators"
        aside={<Toggle checked={indicators} onChange={(v) => void set("showNewClipsIndicators", v)} aria-label="New clip indicators" />}
      >
        <p className="set-group-blurb">Highlight clips recorded since your last session.</p>
        <div className="mock-card-row">
          <MockCard isNew={indicators} showDot={indicators} />
          <MockCard />
        </div>
      </SetGroup>

      <SetGroup
        title="Greyscale game icons"
        aside={<Toggle checked={grey} onChange={(v) => void set("iconGreyscale", v)} aria-label="Greyscale game icons" />}
      >
        <p className="set-group-blurb">Mute the game icons on clip cards so thumbnails stand out.</p>
        <div className="mock-card-row single">
          <MockCard icon={ICON_TILES[0].bg} grey={grey} />
        </div>
        <div className="icon-preview">
          {ICON_TILES.map(({ bg, label }) => (
            <span
              key={label}
              className="icon-preview-tile"
              title={label}
              style={{ background: bg, filter: grey ? "grayscale(1) contrast(1.02)" : "none", opacity: grey ? 0.9 : 1 }}
            />
          ))}
        </div>
      </SetGroup>
    </>
  );
}
