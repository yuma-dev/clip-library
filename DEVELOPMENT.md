# Development command reference

This is the source of truth for root `npm run` commands. `AGENT.md` links here
instead of duplicating command behavior.

## Run and validate

| Command | Purpose |
| --- | --- |
| `npm start` | Start the complete Vite + Electron development app. Alias of `npm run dev`. |
| `npm run dev` | Run Vite and Electron together with coordinated shutdown. |
| `npm run dev:full` | Build Clipdip first, then run the development app. |
| `npm run dev:trace` | Run the development app with the startup performance profiler. |
| `npm run dev:renderer` | Run only the Vite renderer server on `127.0.0.1:5173`. |
| `npm run dev:electron` | Run only Electron after waiting for the Vite server. |
| `npm run dev:electron:trace` | Electron half of `dev:trace`; waits for Vite. |
| `npm run typecheck` | Type-check the React/TypeScript renderer without emitting files. |
| `npm run build:renderer` | Build the React renderer into ignored `renderer-dist/`. |

Unpackaged Electron normally uses Vite. The source benchmark runner sets
`CLIPLIB_RENDERER_MODE=built`, which makes it use `renderer-dist/index.html`
instead. This explicit mode prevents a benchmark from attaching to a stray
development server.

## Benchmarks

Two benchmark families intentionally coexist:

- `npm run benchmark` measures source-level operations in the current React
  renderer: library scanning/rendering, player open/seek/close, search, grid,
  thumbnails, and multi-track comparisons. It builds the renderer, launches
  Electron with an isolated temporary profile, requires one result per
  requested scenario, and exits non-zero for missing or failed results.
- `npm run bench:startup` measures the packaged user startup path, including
  the native launcher and reveal animation. See `benchmark/STARTUP.md`.

| Command | Purpose |
| --- | --- |
| `npm run benchmark` | Build the renderer and run the standard React scenario suite. |
| `npm run benchmark:verbose` | Standard suite with Electron/harness logging. |
| `npm run benchmark:json` | Standard suite and write a timestamped JSON report. |
| `npm run benchmark:openclip` | Detailed repeated clip-open profiling. |
| `npm run benchmark:prepare` | Internal/shared renderer build step for source benchmarks. |
| `npm run bench:build` | Build `dist/win-unpacked` without producing an installer. Requires existing vendored Clipdip and launcher binaries. |
| `npm run bench:startup` | Build the unpacked app, run five packaged starts, and enforce startup thresholds. |

Pass runner flags after `--`, for example:

```powershell
npm run benchmark -- --suite quick
npm run benchmark -- --scenario load_clips --no-warmup
npm run benchmark:verbose -- --suite multitrack
```

## Build and release

| Command | Purpose |
| --- | --- |
| `npm run build` | Build renderer, Clipdip, launcher, vendored binaries, ingest-key file, and Windows installer. |
| `npm run build:clipdip` | Sync the Clipdip version, install its JS dependencies, and build its UI and Rust binary. |
| `npm run vendor:clipdip` | Copy an already-built Clipdip binary into ignored `vendor/clipdip/`. |
| `npm run build:launcher` | Build the native Rust splash launcher. |
| `npm run vendor:launcher` | Copy an already-built launcher into ignored `vendor/launcher/`. |
| `npm run release:preview` | Generate `RELEASE_DRAFT.md` without publishing. |
| `npm run release` | Build, tag, push, and create/update the GitHub release. This changes external state. |

## Design exports

For staged animations, cursors, transparent video and reusable AI recipes, see
[ASSET-PIPELINE.md](ASSET-PIPELINE.md). `npm run assets -- list` lists presets;
`npm run assets:test` checks the recipe/timeline contract. Generated files stay
in ignored `export-out/`.

| Command | Purpose |
| --- | --- |
| `npm run export:extract -- "<clip>"` | Extract a real clip into a component-mockup spec. |
| `npm run export:capture -- "<spec.json>"` | Capture a built component-mockup spec into layered PNG files. Run `build:renderer` first. |
| `npm run export:overlay` | Render the Clipdip notification overlay to still and animated assets. |

See `docs/component-mockups.md` for the export workflow and arguments.

Animated WebP delivery from existing asset frames: `node scripts/asset-webp.mjs <render-directory> <new-output-directory> [max-bytes] [max-edge] [background] [full|crop|x,y,width,height] [standard|smooth|markdown|presentation]`. See `ASSET-PIPELINE.md` for the size and quality policy.

## Watched clip history

`main/clips.js` stores opened clip names in the profile's `watched-clips.json`.
Library scans must never prune that history: a missing name can mean a folder
switch, an offline drive or an incomplete scan. Returning clips keep their
watched status; genuinely unseen names remain new until opened. History retains
the existing relative-name identity (identical names in different folders share
status) and can include files that no longer exist.

Run `node --test benchmark/watched-history-regression.cjs` for isolated folder
switch, partial/empty/unreadable scan, restart and newly watched regressions.
For recovery after older versions erased history, back up `watched-clips.json`
and `last-clips.json` with the app closed, then merge matching snapshot names
into watched history. The snapshot records presence, not exact watched status.

## Library shuffle search

`src/renderer/library/shuffle.ts` owns the recommended `?` choices, calendar-month
cutoffs and seeded per-file ordering. `RailSearch` inserts the selected command;
`filter.ts` applies its age cutoff using `LocalClip.createdAt`, alongside existing
search and collection rules. Bare or incomplete `?` commands preview shuffle.
The last recognized shuffle choice wins; picking a suggestion replaces previous
shuffle commands without removing other search terms.

`useLibraryFilter` holds a seed and reference time for each shuffle session.
Filtering and metadata updates preserve relative order; entering shuffle again or
using **Shuffle again** renews the seed and reference time. Date exclusions are
strictly older than the cutoff, with month-end clamping. `ClipGrid` displays a
single mixed group during shuffle, and the player receives that same order.

Manual verification: type `?`, choose **Exclude the last 2 months** by mouse and
by arrow keys + Enter/Tab, combine with a tag/person/name, reshuffle, then remove
the command to restore time groups. Check an empty result and month-end dates.
The legacy `validate-renderer-modularization.js` referenced in ignored agent notes
is no longer present; use `npm run typecheck` and `npm run build:renderer` for the
current renderer's static validation.

Shuffle performance: `useLibraryFilter` memoizes the full seeded order separately
from query filtering. Weak caches reuse normalized names/tags and tag-selection
matches for immutable clip/selection objects; equivalent results keep their array
identity. Metadata/selection updates must replace objects rather than mutate them.
Only `#tag` terms bypass the saved/focus tag selections. `?`, plain text and `@user`
respect them, and saved empty/Unnamed-disabled selections survive reload.
Participant metadata is requested only for `@` autocomplete/search.

Groups over 80 clips use `VirtualClipCards`: measured CSS grid rows, three-row
overscan, full-height padding and frame-coalesced scroll/resize updates. Smaller
groups retain streamed mounting. This bounds mounted cards during reshuffling,
filter changes and browsing; selection remains data-based and is restored when a
card remounts. Keyboard/gamepad navigation tracks clip identity across row-window
changes. The player still receives the complete filtered list.

Regression checks:
- `node benchmark/shuffle-regression.cjs`: search/tag/age/order checks and a
  10,000-clip cached-order comparison.
- `node benchmark/shuffle-grid-bench.cjs` after `npm run build:renderer`: isolated
  Chromium fixture using production React components and built CSS, comparing
  old mounting against windowed rows, then checking scrolling, resize, selection,
  suggestions, exclusions and collapse. Requires Playwright's Chromium installed.
  Timings are synthetic development-React measurements, not Electron user-library
  input-to-paint numbers; no real library or preferences are accessed.
