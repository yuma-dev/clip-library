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
   GPU process. They run from `runDeferredServices()` 1.5 s after the reveal.
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

 at the install root is a 470 KB Rust program
(), not Electron. It draws the splash (logo and sweep
bar, per-pixel alpha, no frame) within a few tens of milliseconds of the
click, starts  (the Electron binary, )
with the same arguments, and fades out once the app's window is visible and
opaque (it polls the app's top-level windows: visible, not cloaked, layered
alpha at full). If the app is already running, the spawned instance hands
over to it and exits, so the splash disappears again at once. Shortcuts are
retargeted to the launcher by ; taskbar pins from older
installs already point at . Deep links () are
registered by Electron and open the app directly, without the splash.
The harness launches through the launcher, the way a user does, and the
Electron first line still lands at ~165 ms after the click.

## Things that were tested and did not matter

Windows Defender, Windhawk, asar size, proxy auto-detection, the GPU
rasterization switches, `CalculateNativeWinOcclusion`, background throttling,
ANGLE backend choice, the renderer bundle size (V8's code cache makes it
cheap), the Google Fonts stylesheet online (removed anyway: it was
render-blocking and needs the network).

Facts worth knowing: in a hidden Electron window `document.hidden` is false
and `requestAnimationFrame` runs, so visibility gating in the renderer does
nothing at launch; `img.decode()` only settles on a rendering opportunity.

## Tooling

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
  `--profile cold-cache` drops the snapshot and caches.
- `npm run bench:startup` builds, runs 5 launches and checks medians against
  `benchmark/startup-thresholds.json`.
- `node benchmark/smoke-packaged.js` opens a clip, the settings route and
  checks the deferred services on the packaged build.
- Telemetry: `startup.window_visible_ms` (reveal), `startup.total_ms`
  (library painted), `library_scan_ms`.
