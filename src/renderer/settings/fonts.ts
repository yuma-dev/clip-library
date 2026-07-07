// UI font catalogue — same keys as the legacy renderer (settings.uiFont values
// persist across the rewrite). Stacks match legacy UI_FONT_STACKS, except the
// default "modern_ui" now leads with the bundled Inter Variable so existing
// installs keep the new renderer's design font unless they explicitly picked
// something else. Webfonts load from Google Fonts (index.html), falling back
// down each stack when offline.

export const UI_FONT_DEFAULT = "modern_ui";

export interface UiFontOption {
  key: string;
  label: string;
  stack: string;
}

export const UI_FONTS: UiFontOption[] = [
  {
    key: "modern_ui",
    label: "Modern UI (default)",
    stack:
      '"Inter Variable", Inter, "Segoe UI", "DM Sans", "Public Sans", "Plus Jakarta Sans", Manrope, "Work Sans", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  { key: "segoe_ui", label: "Segoe UI", stack: '"Segoe UI", "Segoe UI Variable", "Helvetica Neue", Arial, sans-serif' },
  { key: "inter", label: "Inter", stack: '"Inter Variable", Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "dm_sans", label: "DM Sans", stack: '"DM Sans", Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "satoshi", label: "Satoshi", stack: 'Satoshi, Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "mona_sans", label: "Mona Sans", stack: '"Mona Sans", Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "hubot_sans", label: "Hubot Sans", stack: '"Hubot Sans", Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "public_sans", label: "Public Sans", stack: '"Public Sans", Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "switzer", label: "Switzer", stack: 'Switzer, Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "geist", label: "Geist", stack: 'Geist, Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "space_grotesk", label: "Space Grotesk", stack: '"Space Grotesk", Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "figtree", label: "Figtree", stack: 'Figtree, Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "plus_jakarta_sans", label: "Plus Jakarta Sans", stack: '"Plus Jakarta Sans", Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "manrope", label: "Manrope", stack: 'Manrope, Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "outfit", label: "Outfit", stack: 'Outfit, Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "work_sans", label: "Work Sans", stack: '"Work Sans", Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { key: "roboto", label: "Roboto", stack: 'Roboto, "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
];

export function fontStack(key: string | undefined): string {
  return (UI_FONTS.find((f) => f.key === key) ?? UI_FONTS[0]).stack;
}

/** Apply the selected font app-wide (legacy applyUiFontSetting equivalent). */
export function applyUiFont(key: string | undefined): string {
  const normalized = UI_FONTS.some((f) => f.key === key) ? (key as string) : UI_FONT_DEFAULT;
  document.documentElement.style.setProperty("--app-font-family", fontStack(normalized));
  return normalized;
}
