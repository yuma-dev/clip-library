import { ExternalLink, Info, Wrench } from "lucide-react";
import Toggle from "../../../ui/Toggle";
import Select from "../../../ui/Select";
import type { LiveExtension } from "../../../../types/clips";
import type { PlayingNow } from "./useDiscordSettings";

function openExternal(url: string): void {
  try {
    const req = (window as unknown as { require?: (m: string) => { shell: { openExternal(u: string): void } } }).require;
    req?.("electron").shell.openExternal(url);
  } catch {
    /* ignore */
  }
}

type Choice = { value: string; label: string };
// a few short choices read better side by side than in a dropdown
const segmentable = (choices: Choice[]) => choices.length <= 4 && choices.every((c) => c.label.length <= 14);

function Segmented({ value, choices, onChange, disabled, label }: {
  value: string;
  choices: Choice[];
  onChange: (v: string) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="dl-seg" role="radiogroup" aria-label={label}>
      {choices.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={c.value === value}
          className={c.value === value ? "on" : ""}
          disabled={disabled}
          onClick={() => onChange(c.value)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

interface ExtensionConfigProps {
  ext: LiveExtension;
  settings: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  playing: PlayingNow | null;
  /** the whole game presence; live details need it */
  gamePresence: boolean;
  /** the scenario the preview holds, set by clicking one */
  picked: string | null;
  onPick: (scenario: string) => void;
}

/** one game's settings, opened in place in the games list; its preview is the page's left rail */
export default function ExtensionConfig({ ext, settings, onChange, playing, gamePresence, picked, onPick }: ExtensionConfigProps) {
  const on = settings.enabled !== false;
  const set = (key: string, value: unknown) => onChange({ ...settings, [key]: value });
  const value = (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback);
  const live = playing && ext.game_ids.includes(playing.id);

  return (
    <div className="dl-config">
      {!gamePresence ? (
        <div className="dl-note">
          <Info size={14} /> "Show the game you're in" is off, nothing from here reaches Discord until it's back on.
        </div>
      ) : !on ? (
        <div className="dl-note">
          <Info size={14} /> Off. Friends see the plain card for this game, with your clips and the ClipLib badge.
        </div>
      ) : live ? (
        <div className="dl-note live">
          <i /> You're playing {playing?.name}. Changes reach your card right away.
        </div>
      ) : null}

      {/* before the options, its text points at them as "below" */}
      {ext.setup ? (
        <div className="dl-setup">
          <Wrench size={14} />
          <div>
            <b>One time setup</b>
            <p>{ext.setup}</p>
          </div>
        </div>
      ) : null}

      <div className={`dl-opts${on ? "" : " off"}`}>
        {ext.options.length === 0 ? (
          <div className="dl-opt empty">
            <b>Nothing to set</b>
            <span>It shows everything the game reports.</span>
          </div>
        ) : (
          ext.options.map((o) => {
            if (o.type === "toggle") {
              return (
                <label key={o.key} className="dl-opt">
                  <div className="dl-opt-text">
                    <b>{o.label}</b>
                    {o.description ? <span>{o.description}</span> : null}
                  </div>
                  <Toggle
                    checked={Boolean(value(o.key, o.default))}
                    disabled={!on}
                    onChange={(v) => set(o.key, v)}
                    aria-label={o.label}
                  />
                </label>
              );
            }
            const choices = o.choices.map((c) => ({ value: c.value, label: c.label }));
            const current = String(value(o.key, o.default));
            return (
              <div key={o.key} className="dl-opt stacked">
                <div className="dl-opt-text">
                  <b>{o.label}</b>
                  {o.description ? <span>{o.description}</span> : null}
                </div>
                {segmentable(choices) ? (
                  <Segmented value={current} choices={choices} onChange={(v) => set(o.key, v)} disabled={!on} label={o.label} />
                ) : (
                  <Select value={current} options={choices} onChange={(v) => set(o.key, v)} disabled={!on} width="fill" aria-label={o.label} />
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="dl-foot">
        <div className="dl-scen-block">
          <div className="dl-foot-title">What friends can see</div>
          <div className="dl-scen">
            {ext.scenarios.map((sc) => (
              <button
                key={sc.key}
                type="button"
                className={picked === sc.key ? "on" : ""}
                onClick={() => onPick(sc.key)}
                title="Show this in the preview"
              >
                {sc.label}
              </button>
            ))}
          </div>
        </div>

        {ext.credits.length ? (
          <div className="dl-credits">
            <span>Built on</span>
            {ext.credits.map((c) => (
              <button type="button" key={c.url} onClick={() => openExternal(c.url)} title={`${c.author}, ${c.license}`}>
                {c.project}
                <ExternalLink size={10} />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
