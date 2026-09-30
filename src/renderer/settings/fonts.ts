// same keys as legacy renderer (settings.uiFont values persist); stacks match legacy UI_FONT_STACKS
// except modern_ui now leads with bundled Inter Variable, so old installs keep the new design font
// unless they picked something else. webfonts load from Google Fonts and Fontshare on demand (ensureWebfonts)

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

// fonts whose first choice is bundled or a system font; every other key leads with a webfont family
const LOCAL_FONT_KEYS = new Set(["modern_ui", "segoe_ui", "inter"]);
// satoshi and switzer are fontshare only. fontshare answers a multi-family request with just the
// first family, so one link each. satoshi has no 600
const WEBFONTS_HREFS = [
  "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Figtree:wght@400;500;600&family=Geist:wght@400;500;600&family=Hubot+Sans:wght@400;500;600&family=Manrope:wght@400;500;600&family=Mona+Sans:wght@400;500;600&family=Outfit:wght@400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600&family=Public+Sans:wght@400;500;600&family=Roboto:wght@400;500&family=Space+Grotesk:wght@400;500;600&family=Work+Sans:wght@400;500;600&display=swap",
  "https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap",
  "https://api.fontshare.com/v2/css?f[]=switzer@400,500,600&display=swap",
];
let webfontsRequested = false;

/** loads the optional webfont families once, the first time one is selected */
export function ensureWebfonts(): void {
  if (webfontsRequested) return;
  webfontsRequested = true;
  for (const href of WEBFONTS_HREFS) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }
}

/** applies the selected font app-wide, legacy applyUiFontSetting equivalent */
export function applyUiFont(key: string | undefined): string {
  const normalized = UI_FONTS.some((f) => f.key === key) ? (key as string) : UI_FONT_DEFAULT;
  if (!LOCAL_FONT_KEYS.has(normalized)) ensureWebfonts();
  document.documentElement.style.setProperty("--app-font-family", fontStack(normalized));
  return normalized;
}
