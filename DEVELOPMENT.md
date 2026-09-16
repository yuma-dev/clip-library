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

| Command | Purpose |
| --- | --- |
| `npm run export:extract -- "<clip>"` | Extract a real clip into a component-mockup spec. |
| `npm run export:capture -- "<spec.json>"` | Capture a built component-mockup spec into layered PNG files. Run `build:renderer` first. |
| `npm run export:overlay` | Render the Clipdip notification overlay to still and animated assets. |

See `docs/component-mockups.md` for the export workflow and arguments.
