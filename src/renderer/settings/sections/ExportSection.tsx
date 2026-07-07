import { useEffect, useRef, useState } from "react";
import { Clapperboard, Gauge, HardDriveDownload, Ruler, Sparkles } from "lucide-react";
import { GroupReset, SetGroup, SetRow, StatusLine } from "../rows";
import Select from "../../ui/Select";
import { useSettings } from "../SettingsContext";
import { useToast } from "../../ui/Toast";
import {
  EXPORT_PRESET_CONFIG,
  EXPORT_PRESET_META,
  EXPORT_PRESET_OPTIONS,
  EXPORT_QUALITY_BIAS_OPTIONS,
  EXPORT_QUALITY_OPTIONS,
  EXPORT_SETTING_DEFAULTS,
  EXPORT_SIZE_GOAL_OPTIONS,
  EXPORT_SPEED_BIAS_OPTIONS,
  type ExportTuning,
} from "../exportPresets";

type TuningKey = keyof ExportTuning;

const TUNING_ROWS: {
  key: TuningKey;
  title: string;
  description: string;
  options: { value: string; label: string }[];
}[] = [
  {
    key: "exportQuality",
    title: "Encoding mode",
    description: "Base encoder strategy",
    options: EXPORT_QUALITY_OPTIONS,
  },
  {
    key: "exportSizeGoal",
    title: "File size goal",
    description: "Caps output size — never inflates smaller clips",
    options: EXPORT_SIZE_GOAL_OPTIONS,
  },
  {
    key: "exportQualityBias",
    title: "Quality bias",
    description: "Favor encoding performance or visual quality",
    options: EXPORT_QUALITY_BIAS_OPTIONS,
  },
  {
    key: "exportSpeedBias",
    title: "Encoding speed",
    description: "Encode speed vs compression efficiency",
    options: EXPORT_SPEED_BIAS_OPTIONS,
  },
];

/** Resolve an option value to its display label. */
function optLabel(options: { value: string; label: string }[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

export default function ExportSection() {
  const { settings, patch } = useSettings();
  const toast = useToast();

  const preset = settings.exportPreset || EXPORT_SETTING_DEFAULTS.exportPreset;
  const managed = preset !== "custom";

  const applyPreset = (key: string) => {
    if (key === "custom") {
      void patch({ exportPreset: "custom" });
      return;
    }
    void patch({ exportPreset: key, ...EXPORT_PRESET_CONFIG[key] });
  };

  const changeTuning = (key: TuningKey, value: string) => {
    // Touching any tuning knob takes the preset to Custom (legacy behavior).
    void patch({ [key]: value, exportPreset: "custom" });
  };

  // --- SteelSeries import ---
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<{ tone: "info" | "progress" | "success" | "error"; text: string } | null>(null);
  const importingRef = useRef(false);

  useEffect(() => {
    const off = window.clips.onSteelseriesProgress(({ current, total }: { current: number; total: number }) => {
      if (!importingRef.current) return;
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      setImportStatus({ tone: "progress", text: `Importing clips… ${pct}%` });
    });
    return off;
  }, []);

  const runImport = async () => {
    if (importingRef.current) return;
    try {
      const sourcePath = await window.clips.openFolderDialogSteelseries();
      if (!sourcePath) return;
      importingRef.current = true;
      setImporting(true);
      setImportStatus({ tone: "progress", text: "Importing clips…" });
      const result = await window.clips.importSteelseriesClips(sourcePath);
      if (result?.success) {
        setImportStatus({ tone: "success", text: "Import complete — reloading library…" });
        toast.show("SteelSeries import complete", "success");
        // Imported files land on disk outside the live list; reload picks
        // them all up (and their thumbnails) in one pass.
        window.setTimeout(() => window.location.reload(), 900);
      } else {
        setImportStatus({ tone: "error", text: `Import failed: ${result?.error ?? "unknown error"}` });
      }
    } catch (err) {
      setImportStatus({ tone: "error", text: `Import failed: ${(err as Error).message}` });
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  };

  const strategy = [
    { icon: Clapperboard, label: "Mode", value: optLabel(EXPORT_QUALITY_OPTIONS, settings.exportQuality || EXPORT_SETTING_DEFAULTS.exportQuality) },
    { icon: Ruler, label: "Size cap", value: optLabel(EXPORT_SIZE_GOAL_OPTIONS, settings.exportSizeGoal || EXPORT_SETTING_DEFAULTS.exportSizeGoal) },
    { icon: Sparkles, label: "Quality", value: optLabel(EXPORT_QUALITY_BIAS_OPTIONS, settings.exportQualityBias || EXPORT_SETTING_DEFAULTS.exportQualityBias) },
    { icon: Gauge, label: "Speed", value: optLabel(EXPORT_SPEED_BIAS_OPTIONS, settings.exportSpeedBias || EXPORT_SETTING_DEFAULTS.exportSpeedBias) },
  ];

  return (
    <>
      <SetGroup
        title="Export"
        span2
        aside={<GroupReset label="Reset to Balanced preset" onClick={() => applyPreset(EXPORT_SETTING_DEFAULTS.exportPreset)} />}
      >
        <SetRow
          title="Master export preset"
          description={EXPORT_PRESET_META[preset] ?? EXPORT_PRESET_META.custom}
        >
          <Select
            value={preset}
            width={250}
            options={EXPORT_PRESET_OPTIONS}
            onChange={applyPreset}
            aria-label="Export preset"
          />
        </SetRow>

        <div className={`export-tuning${managed ? " is-managed" : ""}`}>
          {TUNING_ROWS.map((row) => (
            <SetRow key={row.key} title={row.title} description={row.description} managed={managed}>
              <Select
                value={settings[row.key] || EXPORT_SETTING_DEFAULTS[row.key]}
                width={230}
                options={row.options}
                onChange={(v) => changeTuning(row.key, v)}
                aria-label={row.title}
              />
            </SetRow>
          ))}
        </div>
      </SetGroup>

      <SetGroup title="Current strategy">
        <p className="set-group-blurb">
          What an export will do right now ({optLabel(EXPORT_PRESET_OPTIONS, preset)}).
        </p>
        <div className="strategy-grid">
          {strategy.map(({ icon: Icon, label, value }) => (
            <div className="strategy-chip" key={label}>
              <Icon size={14} />
              <div className="strategy-chip-text">
                <span className="strategy-chip-label">{label}</span>
                <span className="strategy-chip-value">{value}</span>
              </div>
            </div>
          ))}
        </div>
      </SetGroup>

      <SetGroup title="Import">
        <SetRow
          title="Import from SteelSeries"
          description="Copy clips out of your SteelSeries Moments folder"
          status={importStatus ? <StatusLine tone={importStatus.tone}>{importStatus.text}</StatusLine> : undefined}
        >
          <button type="button" className="btn" disabled={importing} onClick={() => void runImport()}>
            <HardDriveDownload size={14} /> {importing ? "Importing…" : "Import clips"}
          </button>
        </SetRow>
      </SetGroup>
    </>
  );
}
