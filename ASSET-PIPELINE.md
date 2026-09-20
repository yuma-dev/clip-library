# Marketing asset pipeline

Start here when an agent needs a UI image, a staged interaction, or separate
editing layers. Code and this guide are tracked. Recipes, source media, frames,
renders and manifests belong in `export-out/`, which is ignored by Git.
Do not force-add that directory. The render command refuses output elsewhere,
tracked output paths, existing output folders and junctions leaving the output tree.

## Commands

```powershell
npm run assets -- list
npm run assets -- init player-trim --out export-out/my-trim
npm run build:renderer
npm run assets -- validate export-out/my-trim/spec.json
npm run assets -- render export-out/my-trim/spec.json --formats png --time 2.3
npm run assets -- render export-out/my-trim/spec.json --formats frames,mov,webm,mp4 --layers composite,trim,cursor --background transparent
```

`init` writes a local synthetic landscape and a JSON recipe. Other starters:
`clip-tag` (right click, manage tags, select Highlight, dismiss) and `audio-mixer`
(change the game track's volume). No personal library, account or Electron IPC
is needed. Replace the placeholder with your own local media before an ad.
Existing extractors documented in `docs/component-mockups.md` still work.

## Choose footage, a flat color, and a cursor

```powershell
npm run assets -- init player-trim --clip "C:\Videos\example.mp4" --offset 12 --cursor-theme "C:\Downloads\Moga-White" --out export-out/my-player
npm run assets -- render export-out/my-player/spec.json --color "#00ff00" --formats png,webm,mp4
```

Both `init` and `render` accept `--clip`, `--color`, `--thumbnail`, `--offset`,
and `--cursor-theme`. Clip and color are mutually exclusive. The color replaces
the media surface, not the canvas background (`--background` controls that).
An explicit thumbnail preserves the selected image while a hover preview uses
the video. Without one, ffmpeg extracts the frame at the source offset. ffprobe
supplies the source duration and real audio track names/channel counts.

The effective recipe stores `media: {kind:"clip", path, thumbnail, duration,
offset}` or `{kind:"color", color, thumbnail}`. `props.mediaTime` can keyframe
an absolute source timestamp, including backwards while dragging a trim handle.
Changing a source does not retime authored trim/mediaTime tracks; adjust those
if the replacement has a different duration. A local H.264 all-intra proxy can
speed random seeking; retain the original source path in `media.originalPath`.
No source video or app metadata is modified.

Xcursor themes are decoded locally, including alpha edges and hotspots. The
imported PNGs live beside the recipe. Moga's arrow, pointing hand, text, grab,
grabbing, and horizontal resize shapes are supported. Cursor keys accept
`shape`, `pressed`, `drag`, and `button`. Presses compress and tilt the cursor;
release springs back. A drag holds the compressed pose. There are no click rings.

Local defaults live in ignored `export-out/preferences.json`, for example:

```json
{"cursorTheme":"C:/Downloads/Moga-White"}
```

An explicit theme overrides the default. Recipes containing an imported theme
keep their existing cursor assets when re-rendered.

`render` defaults to all layers, PNG, recipe `captureScale` (otherwise 2), and timestamp 0. Use `--layers`
for a comma-separated subset, `--time` for a still, `--scale 2` for twice the
resolution, and `--fps 60` for smoother motion. Times are seconds. Outputs get
a new timestamped folder beside the recipe. An explicit `--out` must be a new
subdirectory of `export-out/`. Build again after changing scenes or the harness.

Raster density and UI proportions are independent. Use `--scale 1` only for
drafts; raising it sharpens edges without changing the controls' relative size.
For a player matching a 1920px app window, use logical width 1728 (the app's
90% width) with unscaled production controls. The player starter uses this width,
300px glow padding, and captureScale 1.5: a 3492x2358 editing canvas. Keep source
proxies at their original resolution; a 960px proxy cannot provide 1080p detail.
The full glow canvas is larger than the player itself; review it at a large
size rather than judging it from a small gallery tile.
The capture path verifies every PNG's physical dimensions against the manifest.
It uses Chromium's faster lossless PNG encoding; larger frame files do not mean
lower image quality.

Layer isolation preserves computed visibility and restores inline styles between
captures. A selector containing `#export-root` must never reveal a menu or popup
hidden by the timeline (fixed in 3.5.23).

Preview alpha-enabled WebM in an alpha-capable decoder. The installed mpv 0.36
default decoder was verified to output yuv420p (no alpha); explicitly selecting
libvpx-vp9 outputs yuva420p. Ignoring alpha exposes bright unassociated RGB at
faint glow edges. This is separate from the hidden-overlay capture bug.

For that mpv version: `mpv --no-config --hwdec=no --vd=libvpx-vp9 --alpha=blend-tiles file.webm`.
Newer mpv versions use `--background=tiles` instead of `--alpha=blend-tiles`;
check the installed version's options and the [mpv manual](https://mpv.io/manual/stable/).
Do not modify global player settings.
The generated browser review offers checkerboard/dark/light/blue backgrounds.
Check decoded soft edges over a background, not RGB alone. PNG sequences and
ProRes 4444 MOV are the editing alternatives when an importer drops WebM alpha.
The codec regression test checks an entire soft-alpha ramp through the actual
WebM encoder and an alpha-capable decoder. Re-render affected captures after an
isolation fix: updating code alone does not repair existing video files.

The local Playwright Chromium installation and bundled ffmpeg are required.
If Chromium is missing, run `npx playwright install chromium`.

## Formats and delivery

| Format | Use | Transparency |
| --- | --- | --- |
| PNG | lossless still | yes |
| JPG | small still | flattened |
| WebP | lossless still | yes |
| frames | numbered lossless PNG sequence | yes |
| MOV | ProRes 4444 editing master | yes |
| WebM | lossless VP9 preview/overlay | yes; decoder support varies |
| MP4 | H.264 preview | flattened |

`--background transparent` removes the scene backdrop from the composite.
Separate layers are transparent regardless of the composite background.
MP4/JPG flatten over a six-digit recipe background, or black for transparency.
MP4 pads odd dimensions to even dimensions at the right/bottom. PNG sequences
are retained with every animation export; they are the portable alpha fallback.
Audio is not exported. GIF and animated WebP are not currently output formats.

Every folder contains the effective `spec.json` and `manifest.json`: app version,
recipe hash, logical duration, frame count, fps, canvas dimensions, layer selectors,
and output paths. `status: complete` means every requested encoding succeeded.
A failed run leaves its partial files for diagnosis and never reports completion.
Keep the manifest with the media when moving it into your editor.
Open the generated `preview.html` for a checkerboard review of each layer and
links to its files. MOV is an editing format; use the WebM/MP4 or PNG preview.

Import all layers with the same start time, frame rate and canvas position.
Do not auto-crop individual layers. The player preset separates background,
shadow, surface, footage, control gradient, title, actions, playback buttons,
trim bar, times and cursor. Use the composite as a reference. Layer masks exclude
children from parent plates so the trim bar is not baked into the control plate.
Screen-blended glow/backdrop effects are not always reconstructible by ordinary
alpha-over; preserve the intended editor blend mode and check against composite.

## Recipe contract

`version: 1`, `scene`, `fixtures`, `props`, `background`, `viewport`, `layers`,
and optional `timeline`. `npm run assets -- list` gives machine-readable choices.
`validate` checks names, timings, track paths and required fixtures. Rendering
also checks viewport bounds, page errors and selectors. CSS selectors must match
even when the element is hidden; hidden menu plates yield transparent frames.

```json
{
  "timeline": {
    "duration": 5,
    "fps": 30,
    "tracks": [
      {"path":"props.trimStart", "keys":[
        {"time":0,"value":0},
        {"time":1,"value":0},
        {"time":2.3,"value":6,"easing":"smooth"}
      ]}
    ],
    "cursor": [
      {"time":0,"x":300,"y":320},
      {"time":1,"target":"#trim-start","pressed":true},
      {"time":2.3,"target":"#trim-start","pressed":true},
      {"time":2.5,"target":"#trim-start"}
    ]
  }
}
```

Numeric values interpolate; strings, arrays, booleans and objects switch at
the key timestamp. Easing on the destination key is `smooth` (default), `linear`
or `hold`. Use `hold` for numeric indices such as the hovered participant.
An optional track `step` quantizes interpolated values (e.g. `step: 10` for the
real glow blur slider). Tracks may change `props`, `fixtures`, `card`, or `background`, using
dot paths and array indices. Before the first key and after the last key, values
hold. Frames sample `n / fps`, excluding the duration endpoint. Stills can sample
the exact endpoint. Prefer holds at both ends so edits have handles.

Cursor points use canvas pixels or a live CSS target with optional normalized
`anchor: [0.5, 0.5]`. The target must exist for both ends of a movement segment.
Anchoring to a trim handle follows its animated location. Movement uses smooth
easing and press/drag transforms around the imported cursor's hotspot.
Cursor motion illustrates the recipe's state changes; it does not dispatch clicks.

Layers map names to `null` (composite), a selector, or
`{"selector":"...","exclude":["..."],"blend":"normal"}`.
Names allow letters, numbers, underscore and dash. Isolation preserves layout,
ancestor clipping, and the scene's hidden state. Register bounded scene roots;
portals outside `#export-root` will not export. Give shadows enough padding.

## Real media and reproducibility

Player props accept `thumbnail` (local absolute path) or `video` plus
`videoOffset` (seconds). Video is muted, paused and sought for every frame.
Do not use a playing video element as the timeline clock. Fonts load locally;
external HTTP assets are blocked. Download/freeze licensed assets yourself and
point fixtures at local paths. Missing images should be fixed before delivery.
The recipe's optional ISO `clock` fixes age labels and joined dates (default
2026-01-02). Settings canvas previews also use the deterministic render clock.
CSS animations/transitions are disabled; animate via recipe tracks instead.

## Adding scenarios

1. Add a scene adapter in `src/renderer/export/scenes.tsx`, returning a fixed
   `#export-root` with named parts. Reuse production components when practical.
2. Add its ID to the validator and CLI catalog. Add a preset when useful.
3. Expose state as props/fixtures. Keep layout stable during layer exports.
4. Add a local recipe and test beginning, interaction and ending stills.
5. Render a low-fps smoke animation before full-resolution output.
6. Update this guide and version alongside the change.

The card is the real `ClipCard`. Tag menus use the app's menu primitives/styles
with staged state. The player and mixer are presentational adapters sharing
production CSS, not the live player controller. Changes to production markup
must be reflected here. These exports do not test that production interactions
work. No finite scene list covers every UI state: extend this registry for new
dialogs, feeds, settings screens, grids or overlays as needed.

## Validation

`npm run assets:test`, `npm run typecheck`, `npm run build:renderer`.
Inspect transparent stills at multiple timestamps and test a short encode in
each requested codec. Check `manifest.json`, compare composite/layer alignment,
and confirm `git status --short --untracked-files=all -- export-out` stays empty.

Pipeline version 1 was introduced in app 3.5.20. High-density capture and the
app-sized player starter were corrected in 3.5.22.

## Scene controls added in 3.5.21

| Scene | State controlled through `props` |
| --- | --- |
| `clipWorkflow` / `clipTag` | `hover` (0..1 glow reveal), `preview`, `mediaTime`, `renaming`, `renameDraft`, `selectName`, `menu` (closed/root/tags), `globalTags` |
| `videoPlayer` | `trimStart`, `trimEnd`, `currentSeconds`, `mediaTime`, `durationSeconds`, `title`, `width`, `pad`, `glow` |
| `mixerPlayer` | player controls plus `showMixer`, `mixerOpen` (0..1), `tracks` with ordinal/name/color/volume/muted |
| `mentions` | card controls plus `person` (-1 hides), `profiles` keyed by Discord ID; participant identities/avatars come from fixture gameIcon.discord |
| `settings` | `section` (appearance/player/export/shortcuts), `settings` overrides, `scroll` |

The card supplies the real inline name editor markup and media slot. Profile
popover content is shared with production. Settings render the actual sections
inside a read-only snapshot context: no preferences are saved. The sidebar
uses the app's navigation definitions. The rest remains a staged presentation;
it does not drive the running app or change real clip names, tags, or volumes.

Glows sample the same 16x9 canvas with blur(1px) downsampling as the app.
Card glow uses the app's screen blend, mask, 55px overflow and 300ms reveal;
player glow uses 100px horizontal overflow and the real blur/saturation/opacity
defaults. Every source seek redraws the glow at full strength, matching the
player's seek behavior. Continuous playback's temporal smoothing history is
not replayed. Author hover timing explicitly (card preview 100ms, popover 120ms).
Allow about 300px padding around a full player glow to preserve its soft edges.

Capture evaluates time once per frame, then exports all requested layers from
that exact state via Chromium screenshots. This keeps video, glow and cursor
aligned without replaying video separately for each layer. `transparent` can
use selector `#export-root > :not([data-layer="background"])` for a background-free
composite alongside the solid one. Backdrop-filter effects still depend on the
underlying plate; keep the reference composite when compositing isolated panels.

## Size-limited animated WebP (3.5.25)

Convert a completed render's transparent PNG sequence without recapturing:

```powershell
node scripts/asset-webp.mjs export-out/my-render export-out/my-webp 10000000
```

The destination must be new and inside ignored export-out. This creates
an infinitely looping animation.webp and a manifest with actual bytes, quality,
frame rate, dimensions and encoding attempts. An optional fourth argument sets the maximum canvas edge (default 1280 pixels, no upscaling). The strict limit defaults to
10,000,000 bytes. The capped resolution and source frame rate are tried first at
qualities 80, 65, 50 and 35; then lower frame rates and finally smaller canvases
are tried. Alpha is retained; RGB uses lossy WebP compression. Existing static
WebP exports keep their existing behavior. Source frames and other formats
are never replaced. No final animation is published if no attempt fits.


As of 3.5.26, animated WebP export explicitly clears the ANIM background to transparent BGRA (00000000). The encoder otherwise writes opaque white independently of frame alpha. This metadata-only correction preserves compressed frames, timing, loop count and file size; viewers can differ in whether they honor the animation background.

## Cropped opaque sharing copies (3.5.27)

`node scripts/asset-webp.mjs export-out/my-render export-out/my-cropped-webp 10000000 1280 "#050608" crop`

The optional fifth argument is a solid #RRGGBB background (default transparent);
the sixth is crop or full (default full). Crop scans every source PNG alpha
channel and uses the union of all nonzero-alpha pixels, with 8 source pixels
of edge padding where available. Menus, moving cursors, shadows and glow remain
inside one stable canvas. Resize happens after cropping. Solid backgrounds are
composited into the pixels, and the WebP ANIM background matches. ClipLib's
base color is #050608, from renderer index.html and the primary surface token.
The manifest records crop bounds and background.

## Smooth gradients and detail crops (3.5.28)

The framing argument also accepts x,y,width,height in source PNG pixels.
Bounds are validated against the source canvas. The optional last argument
is standard (the existing lossy policy) or smooth. Smooth uses lossless WebP
after resizing and compositing: it reduces dimensions and frame rate instead
of introducing compression blocks in dark gradients. It tries 20 fps at
100%, 83.3%, and 66.7% of max-edge, then 15 fps at 66.7%, 53.3%, and 40%.
The full animation duration is retained; intentional detail crops may omit
parts of the player and cursor travel outside the selected region.

Example: `node scripts/asset-webp.mjs export-out/my-render export-out/my-detail 10000000 960 "#050608" "240,1110,1740,1050" smooth`.

## Markdown delivery and revised staging (3.5.29)

The animated WebP encoder profile markdown keeps its requested maximum edge
fixed and uses lossless encoding, trying 15/12/10/8 fps until under the byte
limit. It fails rather than silently shrinking one item to a different width.
This lets a collection of landscape mockups share a natural Markdown width.
Final explicitly requested delivery copies can be placed outside export-out;
keep frames, recipes and verification reports in the ignored workspace.

Card scenes accept frameWidth/frameHeight, cardLeft/cardTop, menuLeft/menuTop.
Player scenes accept a fixed frameWidth/frameHeight and timeline cameraX,
cameraY and cameraScale. Camera coordinates are logical source pixels. Cursor
targets are resolved after the camera transform, so handles stay aligned.
A constant mediaTime holds the source frame; changing it only during trim
drags stages paused scrubbing. Keep preview true with constant mediaTime to
hold a card video without reverting to its thumbnail. For audio dragging,
anchor the cursor to the live .mixer__fill right edge to avoid easing drift.

The librarySearch scene shares production RailSearch, ClipCard and filterClips.
Its layout is an isolated staged excerpt, not a full app capture; typing and
results are recipe-controlled and no real library changes are made. The
restore-trim demo stages dragging handles outward, not a file edit or undo IPC.

## Playback feedback and README hero (3.5.30)

Use `preview: false` when a card loses preview hover: the production card
then displays its original thumbnail. Keep `preview: true` during inline
renaming; close context menus before restarting the preview from its offset.
For a menu that changes its own DOM between states, use stable cursor
coordinates at the transition instead of targeting an element that moves or
is replaced. Player `controlsShade` (0–1) adds a bottom gradient in the export
adapter for legibility on bright footage; it does not change the live player.

The WebP `presentation` profile keeps the requested dimensions and up to
30 source fps, trying quality 95/90/85. It fails if none fits the byte budget
instead of dropping motion frames. Prefer it for continuous gameplay and
slider demonstrations. The `markdown` profile remains lossless but can lower
frame rate; do not use it when motion smoothness is the priority.

The `hero` scene is a seekable 1600×900 staged walkthrough. It shares production
Titlebar, Sidebar, ClipCard, player controls, boot CSS, and the recorder's actual
notification HTML/CSS. It adapts the native splash geometry into the export
canvas; the Windows taskbar, window shell and save/rename/export operations are
staged. It does not launch the installed app, record gameplay, rename files,
or write to the clipboard. A local library snapshot supplies card thumbnails;
keep its paths, recipes and renders ignored. The notification iframe must set
`color-scheme: dark` with transparent html/body so Chromium does not paint an
opaque iframe canvas over the app.

Hero recipes use `props.wallpaper` for a local desktop image and a linear
`props.time` timeline track. Fixture 0 is the arriving clip; remaining fixtures
are the initial grid. Source media and cursor theme use the normal contract.
The current 35-second storyboard stages startup, scroll, save notification,
zoom/rename, grid insertion, opening, paused trim scrubbing, clipboard export
feedback, and a branded end card. Timing is currently authored in heroScene.tsx;
media, fixture library, capture resolution and frame rate remain recipe/CLI
options. `__EXPORT_SCENE_SEEK__` pauses and seeks production CSS animations and
the embedded overlay after React/media updates, before cursor capture.

Example with a locally authored recipe:

```powershell
npm run build:renderer
npm run assets -- render export-out/cliplib-hero/spec.json --out export-out/hero-720p --formats frames,png,mp4 --layers composite --fps 30 --scale 0.8 --time 33
```

Use scale 1.2 for 1920×1080, or 0.6 for 960×540. Keep the logical viewport
unchanged so layout/cursor timing match. MP4 is H.264/yuv420p with faststart;
the ordinary render is a high-quality master, not inherently byte limited.
Check the encoded file size before sharing. A poster provides a branded
README image linked to an uploaded video; MP4 playback behavior depends on
GitHub's attachment rendering and should not be described as guaranteed autoplay.

## Faster native-layout hero (3.5.31)

The revised local hero recipe maps 21 output seconds onto the scene's storyboard
clock using the normal `props.time` keyframes. This keeps trim/media timing
seekable while tightening the pacing. Cursor keys remain in output seconds;
the hero cursor is hidden before the grid interaction and during the final fade.
There is no desktop shortcut, taskbar, click-to-launch, scrolling or end card.
The last frame returns to the same wallpaper as the first frame.

The grid now shares `ClipGroup`, including its diamond, count and divider.
The initial local snapshot contains Yesterday (1) and This Week (11), with
fixture-provided Discord mentions. A Today group appears for the staged new
clip. The recorder notification uses its native viewport-relative width and
corner placement without minimum-width overrides; the camera provides the
magnification. Renaming does not move or click the cursor.

The player fills 90% of the hero width, retains ambient glow, and includes
previous/next navigation. Export completion uses the shared `ExportProgress`
component extracted from `VideoPlayer`, preserving the production IDs, markup
and styles used by the imperative export controller. It remains staged in
exports, and performs no actual clipboard operation. Player data/navigation
remain fixture-controlled.

The supplied HEIC wallpaper was converted locally with Pillow/pillow-heif to
an ignored JPEG; source HEIC is untouched. New recipes and renders are under
`export-out/cliplib-hero-v2/`; use the standard scale/fps flags to regenerate.

## Camera paths and breathing room (3.5.32)

The 30-second hero revision uses a shared eased progress value for screen-space
translation and scale. Transform order is translate then scale; do not multiply
an interpolated source-space pan by the changing zoom, which produces a curved
screen path and visibly different horizontal/vertical arrival times. The save
notification camera starts before the toast appears and settles at 3.5×.
After trimming, hold the cursor for one second, then move toward Export while
the camera reaches a 2.6× detail view. Settle the camera before the click; retain
the export-button cursor target through the completion hold. Hero cursor
visibility follows storyboard time, not hard-coded output seconds, so retiming
recipes does not make it appear during rename or disappear during export.

Current ignored recipe: `export-out/cliplib-hero-v3/spec.json` (30 seconds).

## Bézier cameras and player stacking (3.5.33)

Hero camera progress uses CSS-equivalent cubic-bezier(.42, 0, .58, 1), solved
by its x coordinate for deterministic seeking. Translation and zoom still
share one progress value. Navigation buttons now sit inside the transformed
player wrapper, above its glow and below the player surface (z-index 2/3),
so overlapping inner button edges are occluded by the video. The 30-second
recipe and cursor holds remain unchanged. Current local render recipe:
`export-out/cliplib-hero-v4/spec.json`.
