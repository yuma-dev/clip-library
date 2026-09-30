import type { TextLayer, TextStyle } from "../../../types/clips";

// in em of the font size; the popover's style tiles imitate these with .pl-lt-* in layers.css
const LINE = 1.05;
const BOX_X = 0.5;
const BOX_Y = 0.22;
const BOX_R = 0.28;

/** a text layer's details with the style's own values where none were set */
export function textLook(l: TextLayer) {
  return {
    outline: l.outline ?? (l.style === "outline" ? 0.2 : l.style === "loud" ? 0.16 : 0),
    shadow: l.shadow ?? (l.style === "clean" ? 1 : 0),
    boxOpacity: l.boxOpacity ?? 0.82,
    spacing: l.spacing ?? (l.style === "loud" ? 0.02 : 0),
  };
}

export function textFont(style: TextStyle, px: number): string {
  if (style === "loud") return `400 ${px}px Impact, "Arial Black", sans-serif`;
  const weight = style === "outline" ? 900 : style === "box" ? 700 : 800;
  return `${weight} ${px}px "Inter Variable", Inter, "Segoe UI", sans-serif`;
}

/** waits for the face a text layer uses; drawing before it loads falls back silently */
export async function loadTextFont(l: TextLayer): Promise<void> {
  await document.fonts.load(textFont(l.style, 32)).catch(() => undefined);
}

/** a text layer drawn for a frame refW px wide. the player shows this same canvas, the export
 * gets it as a png, so both look alike by construction */
export function drawText(l: TextLayer, refW: number): HTMLCanvasElement {
  const fs = (l.size / 100) * refW;
  const font = textFont(l.style, fs);
  const look = textLook(l);
  const lines = (l.style === "loud" ? l.text.toUpperCase() : l.text).split("\n");

  const canvas = document.createElement("canvas");
  let ctx = canvas.getContext("2d")!;
  const setup = () => {
    ctx.font = font;
    ctx.letterSpacing = `${look.spacing * fs}px`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
  };
  setup();
  const maxW = Math.max(1, ...lines.map((s) => ctx.measureText(s).width));
  const bx = l.style === "box" ? BOX_X * fs : 0;
  const by = l.style === "box" ? BOX_Y * fs : 0;
  // room for the shadow and the outside half of the stroke; symmetric so the centre stays put
  const pad = Math.max(0.35, look.outline / 2 + 0.1, look.shadow * 0.36 + 0.1) * fs;
  const w = Math.ceil(maxW + 2 * (bx + pad));
  const h = Math.ceil(lines.length * LINE * fs + 2 * (by + pad));
  canvas.width = w;
  canvas.height = h;
  // resizing the canvas resets its state
  ctx = canvas.getContext("2d")!;
  setup();

  if (l.style === "box") {
    ctx.fillStyle = `rgba(10,10,12,${look.boxOpacity})`;
    ctx.beginPath();
    ctx.roundRect(pad, pad, w - 2 * pad, h - 2 * pad, BOX_R * fs);
    ctx.fill();
  }
  lines.forEach((line, i) => {
    const y = pad + by + (i + 0.5) * LINE * fs;
    if (look.shadow > 0) {
      ctx.shadowColor = `rgba(0,0,0,${Math.min(1, 0.8 * look.shadow)})`;
      ctx.shadowBlur = 0.3 * look.shadow * fs;
      ctx.shadowOffsetY = 0.06 * look.shadow * fs;
    }
    if (look.outline > 0) {
      // css text-stroke is centred on the outline and paint-order puts the fill on top,
      // so half of it shows; same here with the stroke drawn first
      ctx.lineWidth = look.outline * fs;
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#000";
      ctx.strokeText(line, w / 2, y);
      // the stroke carries the shadow already, a second one on the fill would double it
      ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = l.color;
    ctx.fillText(line, w / 2, y);
    ctx.shadowColor = "transparent";
  });
  return canvas;
}

/** png of a text layer at a frame refW px wide, what the export overlays */
export async function rasterizeText(l: TextLayer, refW: number): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  await loadTextFont(l);
  const canvas = drawText(l, refW);
  const { width: w, height: h } = canvas;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not render text");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
}
