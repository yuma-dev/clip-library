// Export preset system — ported verbatim from the legacy
// settings-manager-ui.js (presets are opinionated + trusted; plan §6 says
// changing them needs migration logic, so the keys/values must not drift).

export interface ExportTuning {
  exportQuality: string;
  exportSizeGoal: string;
  exportQualityBias: string;
  exportSpeedBias: string;
}

export const EXPORT_PRESET_CONFIG: Record<string, ExportTuning> = {
  discord_fast: {
    exportQuality: "discord",
    exportSizeGoal: "discord_10mb",
    exportQualityBias: "balanced",
    exportSpeedBias: "fast",
  },
  discord_quality: {
    exportQuality: "discord",
    exportSizeGoal: "discord_10mb",
    exportQualityBias: "quality",
    exportSpeedBias: "balanced",
  },
  compact: {
    exportQuality: "high",
    exportSizeGoal: "small_25mb",
    exportQualityBias: "performance",
    exportSpeedBias: "fast",
  },
  balanced: {
    exportQuality: "high",
    exportSizeGoal: "medium_50mb",
    exportQualityBias: "balanced",
    exportSpeedBias: "balanced",
  },
  high_fidelity: {
    exportQuality: "high",
    exportSizeGoal: "medium_50mb",
    exportQualityBias: "quality",
    exportSpeedBias: "balanced",
  },
  quality_first: {
    exportQuality: "high",
    exportSizeGoal: "large_100mb",
    exportQualityBias: "quality",
    exportSpeedBias: "best",
  },
  max_quality: {
    exportQuality: "high",
    exportSizeGoal: "unlimited",
    exportQualityBias: "quality",
    exportSpeedBias: "best",
  },
  archival_lossless: {
    exportQuality: "lossless",
    exportSizeGoal: "unlimited",
    exportQualityBias: "quality",
    exportSpeedBias: "best",
  },
};

export const EXPORT_PRESET_META: Record<string, string> = {
  discord_fast: "Fastest Discord-safe preset: speed-first under 10MB.",
  discord_quality: "Discord-safe under 10MB with better visual quality.",
  compact: "Speed-first 25MB preset for quick shares.",
  balanced: "Recommended default: best overall quality/size/speed balance.",
  high_fidelity: "Higher visual quality at ~50MB with balanced encode speed.",
  quality_first: "Higher visual quality with larger outputs (~100MB target).",
  max_quality: "Highest non-lossless quality with no size cap.",
  archival_lossless: "Lossless archival output, very large files.",
  custom: "Manual mode. The tuning below is yours to change.",
};

export const EXPORT_PRESET_OPTIONS = [
  { value: "balanced", label: "Balanced (Recommended)" },
  { value: "compact", label: "Speed Demon (Fast 25MB)" },
  { value: "high_fidelity", label: "High Fidelity (50MB)" },
  { value: "discord_fast", label: "Discord Fast (<10MB)" },
  { value: "discord_quality", label: "Discord Quality (<10MB)" },
  { value: "quality_first", label: "Quality First (100MB)" },
  { value: "max_quality", label: "Max Quality (Non-Lossless)" },
  { value: "archival_lossless", label: "Archival Lossless" },
  { value: "custom", label: "Custom" },
];

export const EXPORT_QUALITY_OPTIONS = [
  { value: "discord", label: "Discord Mode (<10MB strategy)" },
  { value: "high", label: "High Mode (VBR, larger files)" },
  { value: "lossless", label: "Lossless Mode (archival, huge files)" },
];

export const EXPORT_SIZE_GOAL_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "discord_10mb", label: "Discord (<10MB)" },
  { value: "small_25mb", label: "Small (~25MB)" },
  { value: "medium_50mb", label: "Medium (~50MB)" },
  { value: "large_100mb", label: "Large (~100MB)" },
  { value: "unlimited", label: "No Size Limit" },
];

export const EXPORT_QUALITY_BIAS_OPTIONS = [
  { value: "performance", label: "Performance" },
  { value: "balanced", label: "Balanced" },
  { value: "quality", label: "Quality" },
];

export const EXPORT_SPEED_BIAS_OPTIONS = [
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "best", label: "Best Quality" },
];

export const EXPORT_SETTING_DEFAULTS: ExportTuning & { exportPreset: string } = {
  exportPreset: "balanced",
  exportQuality: "high",
  exportSizeGoal: "medium_50mb",
  exportQualityBias: "balanced",
  exportSpeedBias: "balanced",
};
