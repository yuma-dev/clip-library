# Component mockups → high-res, layered PNGs

Render any real app component to crisp PNG assets (for the store page, ads,
social, docs) — scaled up, on transparency, and **split into layers** (glow,
thumbnail, avatars, foot, game icon, …) so you can recompose them in
Photoshop/Figma. Fidelity is pixel-perfect because it's the same Chromium that
draws the app; nothing is re-created by hand.

The pipeline is **component-agnostic**: a small permanent harness renders
whatever a *scene* mounts, replaying a captured `window.clips` fixture so
components that read real data (game icon, Discord participants, tags) behave
exactly as in the live app. Per-render inputs (the fixture, the hi-res
thumbnail, the output PNGs) are disposable and live under `export-out/`
(gitignored).

## Parts

| Path | Role | Keep? |
| --- | --- | --- |
| `src/renderer/export/main-export.tsx` | Harness: reads a spec, stubs `window.clips`, mounts the scene, signals ready | permanent |
| `src/renderer/export/mockClips.ts` | Replays a fixture as `window.clips` (the "render anything" seam) | permanent |
| `src/renderer/export/scenes.tsx` | Scene registry — one entry per exportable component (`clipCard` is the reference) | permanent |
| `src/renderer/export/types.ts` | `ExportSpec` / `ClipFixture` contract | permanent |
| `src/renderer/export.html` | Second Vite HTML entry for the exporter | permanent |
| `scripts/export-extract-clip.mjs` | Pulls a real clip → spec.json + hi-res thumbnail | permanent |
| `scripts/export-capture.mjs` | Headless Chromium → layered PNGs | permanent |
| `export-out/<clip>/` | spec.json, thumb.png, `png@Nx/*.png` | disposable (gitignored) |

## Quick start (a real clip card)

```bash
# 1. Extract a real clip into a spec + a HI-RES thumbnail (native video res,
#    not the app's 640x360 cache). Name = the clip's filename.
npm run export:extract -- "VALORANT-Win64-Shipping 20.37.20 09.07.2026.mp4"

# 2. Build the renderer once (emits export.html into renderer-dist/).
npm run build:renderer

# 3. Capture layered PNGs at 3x.
npm run export:capture -- "export-out/VALORANT-Win64-Shipping 20.37.20 09.07.2026.mp4/spec.json" --scale 3
```

Output: `export-out/<clip>/png@3x/` with `composite.png` plus one PNG per layer
(`background`, `glow`, `card`, `thumbnail`, `avatars`, `foot`, `gameicon`), all
the **same dimensions and registration** so they stack directly.

- The **composite** is painted over the spec's `background`, so the glow (which
  uses `mix-blend-mode: screen`) reads correctly.
- Every other layer is on **transparency**. The isolated `glow` layer is the raw
  screen-blend colours — drop it onto a **Screen** blend mode in your editor to
  match the app.

### Knobs

`export:extract` options: `--time <sec>` (frame timestamp; default is the app's
heuristic — `duration/2` if >40s else 0), `--width <px>` (card width baked into
the spec, default 340), `--clip-location <dir>`, `--user-data <dir>`, `--out <dir>`.

`export:capture` options: `--scale <n>` (supersample, default 3 → e.g. 4 for
print), `--only <a,b,c>` (capture just those layers), `--out <dir>`.

You can also hand-edit `spec.json` before capturing — e.g. curate `customName`,
add `tags`, change `background`, swap `thumbnailPath` for a different hi-res
image, or drop a participant. It's a plain, disposable file.

## How it works

1. **Extract** reads the same on-disk files the app reads —
   `%APPDATA%/clips/settings.json` → `clipLocation`, then
   `.clip_metadata/<clip>.customname|.tags|.gameinfo` and `icons/` — and grabs a
   **full-resolution** frame from the actual video with the bundled ffmpeg. It
   writes `spec.json` (a `ClipFixture` + layer selectors) and `thumb.png`.
2. **Capture** opens the built `renderer-dist/export.html` over a `file://`
   origin in headless Chromium (needed so `ClipCard`'s `file://<abs path>` image
   sources — thumbnail, game icon — resolve; Discord avatars load over https).
   It injects the spec, waits for `data-export-ready`, then screenshots
   `#export-root` once per layer. For each layer it hides every sibling via
   `visibility` (layout preserved → layers stay aligned) and screenshots with
   `omitBackground` for transparency. `deviceScaleFactor` gives the supersample.

## Second example: the audio mixer

The `audioMixer` scene renders the multi audio-track panel
(`player-legacy/audio-tracks-manager.js`) statically from track data:

```bash
# Track names/order/channels are read from the clip's real audio streams;
# --volumes sets each track's level (1 = 100%, >1 shows the boosted colour).
node scripts/export-extract-audio-tracks.mjs "VALORANT-Win64-Shipping 20.37.20 09.07.2026.mp4" --volumes 0.9,0.65,1.2,0.4
npm run build:renderer
node scripts/export-capture.mjs "export-out/VALORANT-Win64-Shipping 20.37.20 09.07.2026.mp4/mixer/spec.json" --scale 3
```

Layers: `composite`, `background` (blurred clip frame), `panel`, and one
`row-<ordinal>` per track. Options: `--volumes a,b,c`, `--muted i,j` (soft-muted
rows), `--time <sec>` (backdrop frame). Edit `spec.json > props.tracks` to tweak
names, colours, or levels by hand.

## Third example: the video player

The `videoPlayer` scene renders the clip player overlay (`player/VideoPlayer.tsx`)
as a still — the `<video>` swapped for a hi-res frame, controls forced visible,
playhead at the given time, no trim:

```bash
# --time defaults to the middle (duration/2); --no-share hides the publish button.
node scripts/export-extract-player.mjs "VALORANT-Win64-Shipping 20.37.20 09.07.2026.mp4"
npm run build:renderer
node scripts/export-capture.mjs "export-out/VALORANT-Win64-Shipping 20.37.20 09.07.2026.mp4/player/spec.json" --scale 2
```

Layers: `composite`, `background`, `card`, `thumbnail`, `controls`, `title`,
`actions`, `progress`, `times`. Use `--width 960` with `--scale 2` for a 1920px
video area that matches a 1080p source frame 1:1 (avoids upscaling). Options:
`--time <sec>`, `--width <px>`, `--no-share`.

## The ClipDip overlay (separate, standalone)

The clip-saved notification lives in the ClipDip subapp (`clipdip/overlay.html`),
a self-contained Tauri overlay — not a clip-library component, so it has its own
exporter (`scripts/export-overlay.mjs`, not the scene harness):

```bash
node scripts/export-overlay.mjs           # -> export-out/overlay/{frozen.png, overlay.webp}
#   --scale <n>    frozen still supersample (default 3)
#   --anim-scale <n>  animation pass scale (default 2; lower = higher fps)
#   --seconds <s>  animation length (default 2.8)
#   --lossy        smaller WebP instead of lossless alpha
```

It serves the **real** `overlay.html` + logo and stubs `window.__TAURI_INTERNALS__`
so the overlay runs its genuine saving→saved flow (slide-in, comet border, flash,
sheen, sparkles) with no changes to the production file. Outputs a transparent
frozen PNG and a transparent animated WebP. Note: the animated WebP is captured
via real-time transparent screenshots (alpha rules out the GPU screencast path),
so it lands around ~18fps — fine for a UI toast; raise `--seconds` or lower
`--anim-scale` to trade smoothness/size. (The old `overlay-playground.html`
design sandbox was removed; the exporter uses the production overlay.)

## Exporting a different component

The harness never changes — add a **scene**:

1. In `src/renderer/export/scenes.tsx`, add a function that mounts your component
   inside `<div id="export-root">`, tagging sub-parts with `data-layer="…"` (or
   rely on existing class selectors). Register it under a new key in `scenes`.
2. Provide a spec: either extend `export-extract-clip.mjs` (or write a sibling
   extractor) to emit `{ scene: "yourScene", fixtures: [...], layers: {...} }`,
   or hand-write a `spec.json`.
3. If your component reads other `window.clips` methods, add them to
   `mockClips.ts` (unknown methods already resolve empty, so most Just Work).
4. `npm run build:renderer` then `export:capture` as above.

Because data flows through the stubbed `window.clips` + a plain spec, the same
two scripts render **any** registered component — the component-specific bits are
just the scene and the fixture.
