# Startup performance

What was measured, what was found, and how to keep it that way. Written after
the September 2026 cold-start work; numbers are from the reference machine
(RTX 4070 SUPER, NVMe, 2,800 clips, Windows 11) with a warm profile.

## Result

| | 3.3.0 | now |
|---|---|---|
| Window on screen (grid, thumbnails, no white frame) | 10.6 s | 1.5 s |
| Library grid committed in the renderer | 10.2 s | 0.83 s |
| Fresh folder scan reconciled | 10.8 s | 1.4 s |
| Tags loaded, cold cache (first launch after install) | 8 s | 2.4 s |
| asar | 160 MB | 75 MB |
| Visual feedback after the click (native launcher splash) | 10.6 s | ~0.05 s |
| Cold open of a 5-track clip, click to playable | 3.55 s | 0.27 s after hover warm |
| CPU at rest with the cursor on a tag | 127% core + 45% GPU | 14% + 19% |
| Worst frame when clearing the search | 315 ms | 43 ms |

## Where the time went, in the order it was found

1. **chokidar (7 s).** It registered one `fs.watch` per clip. On Windows each
   is synchronous native work on the main thread; with 2,800 clips the
   browser thread was blocked for about 7 s and could bring up neither the
   GPU process nor the renderer. `main/file-watcher.js` now uses one native
   `fs.watch(dir, { recursive: true })` with size-stability polling.
2. **Side work during window creation.** ffmpeg `-version` plus the NVENC
   probe (two spawns), a PowerShell CIM query for telemetry, clipdip's
   `tasklist`, and taskbar pin repair (a synchronous COM loop, 300 ms) all
   ran before or during the first paint and competed with the renderer and
   GPU process. They run from `runDeferredServices()` 5 s after the reveal, past the intro.
3. **The splash window.** A second renderer process plus a fixed 300 ms
   dismiss timer. Removed.
4. **Module load and the asar.** `electron-squirrel-startup` (dead for an NSIS
   install, 25 ms at line 1), the updater (axios, semver) and Discord RPC on
   did-finish-load while the renderer was still booting, eager requires of
   modules nothing needs before the window. `lazyModule` now covers ffmpeg,
   thumbnails, clips, metadata, dialogs, clipdip, log uploader and the
   SteelSeries importer. Renderer-only packages moved to devDependencies,
   dead ones dropped, `assets/` (build-time input Vite already copies) left
   the asar.
5. **Window before settings, work-area sized.** The BrowserWindow needs
   nothing from settings; its renderer comes up while settings load.
   Constructed at work-area size so `maximize()` is not a second full layout.
   First streamed commit is 2 groups of 12 cards.

## Why the window appears at 1.5 s and not at 0.8 s

Timeline marks lie about pixels. `ready-to-show` fires when the renderer
submits its first frame, but the GPU process still needs about 600 ms to
compile shaders and raster the grid before that frame can be presented (the
Skia/ANGLE shader work repeats every launch; the shader disk cache does not
cover it). Revealing at first paint meant a **white window for ~500 ms**,
verified with a screen pixel probe and screenshots. Two things fixed it:

- The renderer reports ready once the visible thumbnails are loaded.
  `main.js` watches a tiny DevTools `Page.startScreencast` of the hidden
  window, which reports every frame the compositor produces, and reveals
  after the second frame past that point.
- Windows presents one white frame for a window it has never shown (a
  minimal Electron app reproduces it). The window is shown at opacity 0 and
  made opaque one compositor frame later.

A brand screen with a hand-over animation was tried and rejected: the
animation was choppy and it added nothing to responsiveness.

## The native launcher

`ClipLib Launcher.exe` at the install root is a 470 KB Rust program
(`clipdip/crates/launcher`), not Electron. It draws the splash (logo and sweep
bar, per-pixel alpha, no frame) within a few tens of milliseconds of the
click, starts `ClipLib.exe` (the Electron binary) with the same arguments, and
fades out once the app's window is visible and opaque (it polls the app's
top-level windows: visible, not cloaked, layered alpha at full). If the app is
already running, the spawned instance hands over to it and exits, so the
splash disappears again at once. Shortcuts are retargeted to the launcher by
`build/installer.nsh`; taskbar pins are retargeted by the app on launch
(`repairTaskbarPins`). The Electron binary keeps its name on purpose: the
installer only preserves shortcuts and taskbar pins across an update when the
app executable it expects already exists in the old install (renaming it to
"ClipLib App.exe" in an earlier attempt removed the pins). Deep links
(`cliplib://`) are registered by Electron and open the app directly, without
the splash.
`node benchmark/verify-update-shortcuts.js --old <3.3.0 installer> --new <new installer>`
replays the update on this machine and checks that the pin and both
shortcuts survive and end up on the launcher (it touches the real install).
The harness launches through the launcher, the way a user does, and the
Electron first line still lands at ~165 ms after the click.

## Opening a clip

A cold open pays an ffprobe (~250 ms) and, for multi-track clips, a one-time
audio track extraction; both are cached on disk. `main/clip-warmer.js` does
that work ahead of the click: the newest 12 clips a few seconds after the
library is on screen, and any hovered card right away, one clip at a time
and paused while a clip is being opened. Measured with
`node benchmark/smoke-packaged.js --card 40 --reset-cache [--hover-wait 3500]`:
a cold open of a 5-track clip took 3.55 s from click to playable; after the
hover warm it takes 0.27 s.

## At rest and under interaction

`node benchmark/idle-profile.js [--cursor X,Y] [--trace]` launches the app,
waits for startup work to settle and prints CPU seconds per process over a
window, plus renderer and main CPU profiles. True idle is ~10% of a core
(most of it the profiler). Two hover states were not: a cursor resting on
a tag pulsed a box-shadow, which repainted the rail on every vsync (127% of
a core plus 45% of the GPU); the pulse is now a transform/opacity ring on a
pseudo-element (14% and 19%). A cursor resting on a card keeps the preview
video and the 30 fps glow running; both now stop when the window loses
focus or is hidden.

`node benchmark/interaction-bench.js` scrolls the library, types in the
search field and collapses a group, reporting frame times and input
latencies from the renderer (rAF deltas, Event Timing, long animation
frames). Baseline on the reference machine: scroll p50 6 ms, p95 12 ms.
Clearing the search was the outlier (315 ms frame): every group streamed
its cards back at 80 per frame at once, so one frame mounted ~2,000 cards.
useStreamedSlice now shares a per-frame budget across all groups.

## Smooth after the reveal (September 2026, second pass)

The target was 100+ fps from the moment the library is on screen, with no
frame drops, scrolling included. Measured with `interaction-bench.js`,
`scroll-experiments.js` (one launch, CSS overrides injected one after the
other, each followed by the same wheel scroll) and `inspect-dom.js`
(what the boot left in the live DOM). On the reference machine (165 Hz)
every scenario now runs at 6.1 ms per frame p50 and 6.2 ms p95, zero
frames over 33 ms, and the six seconds after the reveal have p95 6.2 ms
and no frame over 25 ms. What it took, in the order it was found:

- **A 2 s freeze after the intro** in every launch: `telemetry.collectMachine`
  called `app.getGPUInfo('complete')`, which runs a DirectX diagnostics
  pass that blocks the browser process on Windows despite its async
  signature, and a blocked browser process freezes every window. Bisected
  with `CLIPLIB_SKIP_DEFERRED=machine`. Vendor now comes from `'basic'`, model
  and driver from a hidden PowerShell query. Taskbar pin repair, which
  resolved every pin through synchronous COM, reads the `.lnk` bytes first
  and only resolves candidates.
- **Scrolling at 79 ms a frame with the cursor on the grid** (6 ms with the
  cursor off it). Two causes. Dropped intersection-observer entries: the
  observer reports each card once when first observed, and dropping the
  reports that arrived during the intro hold left a thousand cards never
  culled, so every compositing update ran over the whole library (47 ms).
  The entries are now held back and applied in slices. And hover: each card
  passing under a resting cursor gained and lost `:hover`, whose transform
  transition and pre-rendered shadow each promote a layer. Hover is off on
  the cards during scroll activity and re-entered when it settles.
- **Groups the browser skips.** `.clip-group-content` gets
  `content-visibility: auto` with an intrinsic height computed from the
  measured columns and row height (`ClipGrid` measures, `ClipGroup` sets
  `--group-h`), so paint and compositing scale with what is near the
  viewport. This is what took wheel scrolling from 12 ms (the pre-intro
  baseline, measured on a worktree of 443a3c9) to one vsync. The hover
  shadow needs padding inside the containment box, cancelled by a margin.
  During the intro the near groups are marked live and the rest hidden
  outright, since the push changes every group's viewport intersection.
- **Streaming.** Mounting cards after the reveal always shows: each commit
  costs about 15 ms whatever its size (style, paint, compositing, plus the
  hover hit-test Chromium runs after a layout change), so no chunk size
  helps. Streaming now runs at full speed while the window is hidden (cheap,
  with skipped groups) and is done before the reveal; whatever remains is
  paced by frame feedback and pauses for 300 ms after any input. Idle-time
  pacing was tried and rejected: the pauses between wheel steps look idle.
- **Settle and teardown.** Dropping the will-change promotions of the body
  and forty cards at once re-rasterised them in one 120 ms frame; they are
  dropped eight per frame after the motes are gone.

The bench's tail statistics (`after the intro (1.2 to 6 s)`) and the
`interaction-bench.js` table are the guard for all of this.

## Things that were tested and did not matter

Windows Defender, Windhawk, asar size, proxy auto-detection, the GPU
rasterization switches, `CalculateNativeWinOcclusion`, background throttling,
ANGLE backend choice, the renderer bundle size (V8's code cache makes it
cheap), the Google Fonts stylesheet online (removed anyway: it was
render-blocking and needs the network).

Facts worth knowing: in a hidden Electron window `document.hidden` is false
and `requestAnimationFrame` runs, so visibility gating in the renderer does
nothing at launch; `img.decode()` only settles on a rendering opportunity.

## The reveal animation

The launcher's logo is taken over in place and the library arrives behind it
(`src/renderer/boot/bootReveal.ts`, `main.js` `revealMainWindow`): the logo
twin grows past the viewport and fades while the whole library body pushes
in from 1.5x to rest around it and a vignette lifts; about a second. The
launcher passes where it drew the logo (`--splash-logo=x,y,w,h`, physical
pixels), main converts that to content CSS pixels, and the launcher's
fade-out is 120 ms so the twin takes over almost at once.

Getting it to hold its frames took a series of measured fixes, each visible
in `benchmark/analyze-reveal.js` (frame-level view of a `--trace` run:
renderer main-thread tasks and the compositor's PipelineReporter frames):

- The main thread was mounting the rest of the grid at 64 cards a frame
  (80 to 100 ms each) right through the reveal, dropping half the frames and
  delaying the opaque window by 300 ms. `src/renderer/boot/bootHold.ts` holds
  the streaming from just before renderer-ready (once the first viewport is
  full) and the whole-grid commits (fresh list, thumbnail paths, tag batches)
  while the animation plays; any input releases it at once. The IPCs still
  run during the hold, only their commits wait.
- Layers created at the first animated frame were rastered in that frame
  (67 ms). Everything the animation moves now exists before the reveal: the
  body is promoted and the overlay mounted while the window is still at OS
  opacity 0, so the pre-reveal compositor frames raster them.
- `scale()` on the body made the compositor raster it at the animation's
  maximum scale (1.5x of the whole library, every thumbnail decoded again:
  200 to 380 ms stalls). A `perspective()` push has no computable maximum
  scale, so the layer keeps its 1x raster and the GPU upscales it. The
  body's opacity ride is a solid cover fading out, so the body needs no
  offscreen surface.
- The IntersectionObserver that toggles offscreen cards fired every frame as
  the moving body carried cards across the root's edges, repainting tiles
  (111 raster batches in one run). It ignores entries during the hold.
- A hover preview started mid-intro when the cursor sat on the grid (it
  does after a desktop-shortcut launch): a GPU video decoder plus a 422 ms
  encoder-capability probe in the GPU process. Hover is off on the body
  during the intro.
- The 45 MB emoji face was requested by the first emoji glyph and decoded
  (about 80 ms on the main thread) mid-animation; `main.tsx` asks for it at
  script start so that lands in the quiet second before the window shows.
- Step easing on the mockup's own gate animation ended at progress
  0.9999999 and never fired; the real hand-over uses frames and timers.

On top of the push: an afterglow bloom around the logo, a grid glow (every
visible thumbnail drawn blurred into one quarter-resolution canvas behind
the cards before the reveal, blur baked into the pixels so only its opacity
animates; cards without a saved thumbnail glow in the accent colour), depth
parallax (rail, group headers and cards on pre-promoted layers with their
own delays) and thirty seeded motes drifting up from the cards. The glow
and the parallax set are redrawn at the reveal because a fresh clip list can
shift the rows between prepare and reveal (a glow left at an old position
looked like a ghost card).

Sound (`src/renderer/boot/bootSound.ts`, assets in `src/renderer/assets/sfx`):
four layers mixed with Web Audio against the intro's timing. The woosh
(the "gust" take, 1.3 to 4.4 s of the original, minus 8 dB) is trimmed so its
swell peaks about 0.4 s after it starts (it starts as the reveal arms, so the peak sits on the fastest part
of the fly-through); the chimes and the motes clip play together at
+0.6 s under the drifting motes, each with its own natural tail (the motes
clip has an 80 ms fade-in, the chimes only edge fades). Input never cuts the
sound: scrolling lets the whole intro play on (it only lifts the holds and
restores hover), a click or key ends the visuals early and the sound plays
out. Muted when hover previews are muted; nothing plays on the plain reveal.

Every part has a switch, read at launch from localStorage and set from the
dev console (`src/renderer/boot/bootPrefs.ts`): `__bootIntro.get()`,
`__bootIntro.set({ chimes: false, motes: false })`, `__bootIntro.reset()`.
Keys: sound, woosh (the "gust" take, woosh-gust.ogg), chimes, motesSound, wind, afterglow, glow, parallax,
motes. Settings > General > Startup sound shows the sound switches. The wind
sits at 7 percent and fades from the moment it starts over 4.3 s (constants
in bootSound.ts).

Result on the reference machine (165 Hz): presented-frame gaps median one
vsync, p95 12 ms, at most one or two frames over 25 ms, all inside the first
150 ms while the launcher still fades over a solid cover. The bench prints
the renderer and compositor frame notes per run and `--assert` guards them
(`reveal_*_over_25ms` in `benchmark/startup-thresholds.json`). Cost: the
window turns opaque about 300 ms later than the plain reveal (two frames after
show, then the renderer arms the first frame), covered by the launcher, and
the fresh list and tags commit about 1.3 s later than they otherwise would.

## Tooling

This file documents packaged startup tooling. The root `benchmark*` npm
commands are a separate source-level React scenario runner documented in
`DEVELOPMENT.md`.

- `npm run bench:build` builds the renderer and packages `dist/win-unpacked`
  without the installer or the clipdip build.
- `node benchmark/cold-start.js --make-profile` seeds
  `benchmark/profiles/warm-template` from the real profile (settings with
  Discord, clipdip and telemetry off; thumbnail cache; localStorage snapshot;
  shader caches).
- `node benchmark/cold-start.js --label X --runs 7 --reuse` launches the
  packaged app with an isolated profile (`CLIPLIB_PROFILE_DIR`) and boot
  marks (`CLIPLIB_BOOT_TRACE=1`, `main/boot-trace.js`,
  `src/renderer/perf/bootMarks.ts`) and prints medians. `--pixel-probe`
  samples the screen so white or empty frames show up as data; `--trace`
  records a Chromium content trace (`benchmark/analyze-trace.js`); `--cpu` a
  main-process CPU profile (`benchmark/analyze-cpuprofile.js`);
  `--profile cold-cache` drops the snapshot and caches; `--park-cursor` moves
  the mouse to the screen edge before each launch so a card under it never
  starts a hover preview.
- `node benchmark/scroll-experiments.js [--cursor grid|edge] [--exe PATH] [--wait MS]`
  injects CSS overrides one after the other into a running packaged app and
  scrolls after each, to attribute a scroll cost without rebuilding.
- `node benchmark/inspect-dom.js [--exe PATH] [--wait MS]` prints what the
  boot left in the live DOM: classes, promoted layers, culled cards,
  running animations.
- Bisecting the deferred services: `--env CLIPLIB_SKIP_DEFERRED=machine`
  (updater, discord, ffmpeg, machine, clipdip, pins, warm) and
  `--env CLIPLIB_DEFERRED_MS=30000`; their marks and any frame gap over
  90 ms appear in the phase table.
- `node benchmark/analyze-reveal.js <chromium-trace.json>` is the frame-level
  view of the reveal animation from a `--trace` run with
  `CLIPLIB_TRACE_CATEGORIES=benchmark,viz,gpu,cc,devtools.timeline,...`:
  long renderer main-thread tasks, dropped and presented compositor frames,
  `--around MS` for every thread in a stall.
- `npm run bench:startup` builds, runs 5 launches and checks medians against
  `benchmark/startup-thresholds.json`.
- `node benchmark/smoke-packaged.js` opens a clip, the settings route and
  checks the deferred services on the packaged build.
- Telemetry: `startup.window_visible_ms` (reveal), `startup.total_ms`
  (library painted), `library_scan_ms`.
