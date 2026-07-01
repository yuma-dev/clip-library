# Clip Library — Renderer Rewrite Scoping Document

> **Status:** scoping only. Written 2026-07-01.
> **Nature of the work:** this is a **renderer-only** rewrite. The Electron **main process is kept untouched** (ffmpeg, IPC handlers, file watching, export, tag storage, settings, updates, diagnostics, ClipLib auth). We are replacing the *renderer* — the vanilla `index.html` + `styles.css` + `renderer.js` + `renderer/*` + `templates/*` layer — with a modern React app.
>
> This document does **not** prescribe *how* to build things. It captures: the problem, the references we're building toward, the intended approach, a **first-pass** catalogue of everything the new renderer must cover (to be verified by the implementing agent), a map of where to look, and the decisions left open.

---

## 1. Why we're doing this

The renderer is vanilla HTML/CSS/JS built up over ~2 years. It works and has genuinely good custom pieces (the video player especially), but the UI is expensive to improve and the codebase makes polish a fight:

- **No shared component/primitive layer.** Every dropdown, modal, menu, tooltip, and focus state is hand-rolled, so each one handles edge cases (positioning near screen edges, dismiss-on-outside-click, focus trapping, keyboard nav) differently or not at all. Real UI libraries give this for free; here it's re-solved per component.
- **No design system.** `styles.css` is ~4,700 lines with ~40 near-duplicate hardcoded colors and only a handful of CSS variables. Nothing is systematic, so components drift and the whole thing reads as "unpolished / dated" even when no single piece is wrong.
- **Imperative DOM everywhere.** State lives in a shared `state.js` and is pushed into the DOM by hand across ~18 manager modules. Adding a view or reworking layout means touching many files.
- **We already proved the better path twice.** Two sibling apps (below) are React, are polished, and make good UI cheap. Clip Library is the outlier.

The goal is to fix the *root cause* (the stack), not keep hand-polishing symptoms.

---

## 2. What we're building toward (references)

Both live on this machine and should be studied directly. Neither should be copied wholesale — mine them for patterns and, where noted, lift components.

### 2a. Hynite — Game Launcher  → the **shell / chrome** we look up to
`G:\Dev\projects\Game Launcher`

- Stack: Electron + `electron-vite` + **React 18** + TypeScript, **plain CSS with `:root` design tokens** (no Tailwind), hand-rolled routing, `lucide-react` icons, `framer-motion`, `@floating-ui` not used (positioning is hand-rolled), `hls.js`, `@dnd-kit`.
- Renderer lives at `apps/desktop/src/renderer/`.
- **Caveat:** the UI is a single ~11k-line `App.tsx` (`apps/desktop/src/renderer/App.tsx`). **Do not copy it wholesale.** Extract the *patterns* into clean, split files.
- Where to look for each pattern (line numbers approximate, verify):
  - Design tokens: `apps/desktop/src/renderer/styles.css` (`:root` — `--bg-1`, `--bg-2`, `--line`, `--text`, `--text-2/3`, Inter font, feature settings).
  - Sidebar / nav rail: `App.tsx` `<aside className="rail">` (~10833–10923) — brand, nav items from a `routes` array, count pills, groups, recent list, updater pill.
  - Top bar / search / filter: Library screen (~3385–3423) — `.search-box` with a lucide `Search`, `.filter-trigger`, custom sort dropdown.
  - Card + grid: `GameCover` (~1356–1617) and `.library-grid` (dynamic `grid-template-columns`, IntersectionObserver batches of 50).
  - Menus / popovers: `GameContextMenu`, `LibrarySortMenu`, `MenuSubmenu` (~8823–9070) — viewport-aware positioning, keyboard support.
  - Modals: several (`NameDialog`, `SteamSwitchModal`, etc.) via `AnimatePresence`.
  - Settings: `SettingsScreen` (~6188–7615) — tabbed, toggles/sliders/inputs.
  - **IPC pattern to emulate:** `apps/desktop/src/preload/index.ts` exposes a typed `window.hynite.*` namespace via `contextBridge` (promise-based `invoke`, plus event subscriptions like `games.onUpdated(cb)`).
  - Icons: `lucide-react`, sized 16–18px via `size` prop. Animation: `framer-motion` route transitions + CSS keyframes.

### 2b. cliplib share — the ClipLib web app  → the **grid + social/feed** we look up to
`G:\Dev\projects\clips\cliplib share`

- Stack: Vite + **React 19** + TypeScript + **Tailwind v4** (`@tailwindcss/vite`), `@floating-ui/react`, `motion` (framer-motion v12), `react-router-dom`, Bun.
- This already renders our clips as a polished feed. Prior assessment: the clip/feed components are **~7.5/10 reusable** — mostly a matter of swapping the `/api` HTTP layer for a local source and dropping router `navigate()` calls.
- Where to look / candidates to lift:
  - Theme tokens: `src/index.css` (`@theme { --color-bg-primary: #1e1e1e; --color-accent: #8e329b; ... }`) — **near-identical dark+purple palette to Clip Library already.**
  - Clip card: `src/components/ClipCard.tsx` (props: `clip`, `index`, reaction/favorite callbacks).
  - Feed grid + filters: `src/pages/FeedPage.tsx` (responsive CSS grid, user/game/sort filters, sessionStorage persistence, infinite scroll).
  - Clip data shape: `src/hooks/useClips.ts` (`interface Clip`) — **web-oriented** (userId, reactionCounts, thumbnailUrl, isFavorited). This is *shared/published* clips, distinct from local library clips (see §5).
  - Primitives worth reusing: `src/components/InfiniteScroll.tsx` (IntersectionObserver), `src/components/UserPopover.tsx` (`@floating-ui/react`), `src/components/ReactionBar.tsx`, `src/components/ClipPlayer.tsx`.
  - API layer: `src/api/client.ts` (`/api` fetch wrapper), `src/context/AuthContext.tsx` (has `getAvatarUrl()`).

### 2c. Decided
- **Styling base for the new renderer: Tailwind v4** (matches cliplib-share, coexists with plain CSS so Hynite's token-based chrome can be brought over and converted mechanically). Unify Hynite's `--bg-*`/`--text-*` and cliplib's `--color-*` into one `@theme` token set.

---

## 3. The intended approach (as directed)

High-level sequence the future agent should follow. Deliberately not a how-to.

1. **Snapshot the current renderer as read-only reference.** Keep the existing `index.html`, `styles.css`, `renderer.js`, `renderer/`, `templates/` available to copy from (e.g. move under a `legacy/` or `_reference/` folder, or a dedicated branch/tag), but out of the live build. It is a copy-source, not shipped code.
2. **Remove the current renderer + styles from the build path** so the app no longer loads them.
3. **Lid every error that surfaces.** With the renderer gone, boot the app and stub/quiet whatever breaks (main-process code that loads `index.html`, pushes events to a renderer, or `require`s removed files). For each thing you lid, **write it down as a reimplementation TODO** (see §5). Likely culprits to check: `main.js` `BrowserWindow` `loadFile('index.html')` and `webPreferences`; `splash.html`, `update-popup.html` secondary windows; any main→renderer `webContents.send(...)` that now has no listener (harmless but note it); `custom-electron-titlebar` usage if present.
4. **Stand up the new renderer** (electron-vite + React + TS + Tailwind v4) against the *unchanged* main-process IPC.
5. **Build order:** Hynite-inspired **shell first** (window chrome, sidebar, top bar, library grid, the video player), then the **grid + social/feed** components from the sharing app second.
6. **Cut over** and retire the legacy renderer once parity is reached.

---

## 4. The IPC contract (must be preserved exactly)

**This is the load-bearing constraint.** The main process is unchanged, so the new renderer must call these exact channels with the same argument order and consume the same return/event shapes. *(First pass from an automated read of the current renderer — the implementing agent must verify each channel against `main/` handlers before relying on it.)*

**Clips:** `get-clip-location`, `get-clips`, `get-new-clips-info`, `get-new-clip-info`, `get-clip-info`, `delete-clip`, `save-clip-list-immediately`, `get-game-icon`, `restore-missing-global-tags`

**Per-clip data:** `get-trim`/`save-trim`/`delete-trim`, `get-speed`/`save-speed`, `get-volume`/`save-volume`, `get-volume-range`/`save-volume-range`, `get-clip-tags`/`save-clip-tags`

**Audio tracks:** `extract-audio-tracks`, `get-track-state`/`save-track-state`, `get-track-preferences`/`save-track-preferences`

**Global tags:** `load-global-tags`/`save-global-tags`, `remove-tag-from-all-clips`, `update-tag-in-all-clips`, `get-tag-preferences`/`save-tag-preferences`

**Thumbnails:** `get-thumbnail-path`, `get-thumbnail-paths-batch`, `generate-thumbnails-progressively` (+ events `thumbnail-progress`, `thumbnail-generation-complete`)

**Export:** `export-video`, `export-audio`, `export-trimmed-video`

**Settings:** `get-settings`, `save-settings`, `get-default-keybindings`

**Discord RPC:** `update-discord-presence`, `toggle-discord-rpc`, `clear-discord-presence` (+ event `check-activity-state`)

**Share / ClipLib auth:** `start-cliplib-auth`, `disconnect-cliplib-auth`, `test-share-connection`, `share-clip`, `get-share-users` (+ events `cliplib-auth-event`, `share-upload-progress`)

**Updates:** `check-for-updates`, `open-update-page`, `get-app-version`, `start-update` (+ events `show-update-notification`, `download-progress`, `update-download-error`, `update-download-complete`)

**Diagnostics:** `show-diagnostics-save-dialog`, `generate-diagnostics-zip`, `upload-session-logs` (+ event `diagnostics-progress`)

**System:** `quit-app`

> Note: the current renderer uses `const { ipcRenderer } = require('electron')` directly (nodeIntegration on / contextIsolation likely off). Whether the new renderer keeps that or moves to a `contextBridge` preload is an **open decision** (§7).

---

## 5. Everything to reimplement — FIRST PASS (verify against code)

> ⚠️ **This list is a starting checklist, not authoritative.** The implementing agent must re-derive it from the legacy source and expand/correct it. Source of truth is the code under `renderer/` and `templates/`, kept as read-only reference.

Two distinct clip concepts the new UI must keep separate:
- **Local library clips** — local files with `originalName`/`customName`, tags, trim, speed, volume, multi-audio tracks. Powers the **Library** view + the custom video player.
- **Shared/feed clips** — the web `Clip` shape (reactions, favorites, mentions, author). Powers an in-app **Feed** view (reuse cliplib-share components). Same sidebar shell, two data sources.

### Shell / chrome
- [ ] App window chrome (verify: custom titlebar via `custom-electron-titlebar`? window min/max/close).
- [ ] Left sidebar/nav (Library, Feed, tags/folders, settings entry), Hynite-style.
- [ ] Top bar: search input, tag filter entry, counts.
- [ ] Splash/loading screen (hides first-paint flash).
- [ ] `ui-blur` behavior behind modals (currently `window.uiBlur.enable()/disable()`).
- [ ] Export progress toast (visible over fullscreen).
- [ ] Custom confirm/alert modal (replaces `#custom-modal`).

### Library grid
- [ ] Load + render clips grouped by time (Today/Yesterday/…); collapse/expand groups (persist collapse state).
- [ ] Lazy-load expanded groups in batches (perf).
- [ ] **Event-driven visibility observer** (IntersectionObserver, ~600px margin) — *not* `content-visibility`; avoids playhead-induced layout thrash. (Hard-won; §6.)
- [ ] Clip card: thumbnail (shimmer on load), editable custom name, relative time, first-3 tags + "+N" overflow tooltip, game icon (greyscale toggle).
- [ ] Hover video preview + **audio "warm on hover"** (preloads track `<audio>` decoders; reused at open). (Hard-won; §6.)
- [ ] New-clips indicators (per-group line / whole-group highlight); respects setting.
- [ ] Thumbnail batch prefetch + progressive generation with progress events.
- [ ] Selection: click opens; Ctrl/Shift multi-select.
- [ ] Right-click context menu: Export, Manage tags (nested search+checkboxes), Reset trim, Reset cached metadata, Reveal in Explorer, Delete (confirm; revert UI on failure).
- [ ] Keyboard + gamepad grid navigation (ray-cast to nearest neighbor, smooth scroll, auto-hide focus ring on mouse/keyboard).

### Video player (the crown jewel — preserve behavior faithfully)
- [ ] Load/open clip with trim/tags/speed/volume; loading overlay.
- [ ] Play/pause; playhead real-time sync (RAF); **auto-loop within trim bounds** with a manual-seek gate.
- [ ] Trim: dual in/out handles (min gap 0.5s), click-to-seek, `[`/`]` to set, reset via context menu, debounced auto-save.
- [ ] Playback speed 0.5–2× (0.25 steps), UI auto-collapse after 2s, space-hold boost to 2×.
- [ ] Volume 0–2× (master gain), muted/low/normal/high icon states, per-clip save; optional per-clip **volume range** (start/end + level, timeline sliders, unity detent).
- [ ] **Multi-audio tracks:** N-way Web Audio graph (hidden `<audio>` per extracted `.m4a` → GainNode → master), native video muted; per-track UI (name, mute, 0–2 gain w/ unity detent, color dot, hide→tray); global track prefs (color/hidden) + per-clip state; **drift/stall correction** (snap thresholds, seek-settle freeze — fragile, §6).
- [ ] Timeline hover preview (thumbnail + timestamp at cursor).
- [ ] Fullscreen (hides glow + progress bar; controls auto-hide after 3s).
- [ ] Ambient glow (16×9 canvas, 30fps, temporal smoothing, blur+saturate; hidden in fullscreen; respects reduced-motion).
- [ ] Frame stepping (`,` / `.`, ~1/30s, 50ms throttle).
- [ ] Prev/next clip nav (buttons / Ctrl+←→ / gamepad).
- [ ] Inline title editing (save on blur/Enter, Escape cancels).
- [ ] Export actions from player (video/audio × clipboard/save-as via modifier keys); passes trim/volume/speed/mix snapshot.

### Tags
- [ ] Global tag list (implicit `Untagged`/`Unnamed`); add/rename/delete across all clips (disk scan).
- [ ] Per-clip tag toggle.
- [ ] Filter dropdown: "Tags (X/Y)", search, select-all/deselect-all, tag rows with the existing **purple selection + right-edge indicator ("only show this tag")** system. **This purple system is liked — keep it.**
- [ ] Two selection modes: saved (persistent, AND logic) vs temporary Ctrl+click focus (session, OR logic).
- [ ] Tag preferences persisted across sessions.

### Search
- [ ] Text search over customName/originalName (case-insensitive, debounced ~300ms).
- [ ] `@TagName` mention syntax (combinable with text; highlighted in the input).
- [ ] Filter interplay with dropdown selection (untagged/unnamed visibility rules).

### Export
- [ ] Video/audio export, full or trimmed, clipboard or file; shortcuts `e` / Ctrl+E / Shift+E / Ctrl+Shift+E.
- [ ] Export **presets** (8 named + custom) mapping to 4 tuning settings; "managed by preset" vs "custom" visual state; encoder/decoder fallback notices; benchmark data in results.

### Share / social (Feed)
- [ ] ClipLib auth: connect (OAuth), disconnect, test connection; share button hidden until configured.
- [ ] Share modal: title, thumbnail preview, "Featuring" user picker (searchable, cached ~30min), upload progress.
- [ ] In-app **Feed** view (reuse cliplib-share ClipCard/FeedPage/filters/reactions/favorites/comments) — see §7 open decision on data source.

### Settings
- [ ] Sections: clip location, Discord RPC, app font, tag management, appearance (new-clips indicators, greyscale), playback (preview volume), ambient glow (enable + smoothing + fps + blur + opacity), export (preset + tuning), import (SteelSeries), integrations, keyboard shortcuts (click-to-rebind + conflict warning + reset), updates, diagnostics, version, account card.

### Updates / diagnostics / integrations
- [ ] Manual update check + result states; auto update notification with changelog (markdown → sanitize); open release page; download progress.
- [ ] Diagnostics zip (save dialog, staged progress, size); upload session logs (shareable link).
- [ ] Discord RPC on play/pause/seek (suppress if clip tagged "Private").
- [ ] Gamepad: connection indicator, full button map (configurable), quit-confirm modal, grid nav + timeline seek via sticks.
- [ ] Keybindings: full default action set (play/pause, frame ±, skip ±, prev/next, volume ±, export ×4, fullscreen, delete, trim start/end, focus title, close) — loadable/rebindable/persistable.

### Global hooks / external deps to account for
- [ ] `window.uiBlur`, `window.AudioContext`/`webkitAudioContext`, debug `window.loadingScreenTest` (Ctrl+Shift+L), secret easter-egg overlay (F6).
- [ ] CDN scripts today: `marked`, `DOMPurify` (changelog rendering), Google Fonts, Material Symbols. Decide bundle-vs-CDN (§7).

---

## 6. Hard-won details not to lose (verify + preserve)

These are tuned/non-obvious; a naive reimplementation regresses them.

- **Warm-audio-on-hover** (`renderer/clip-grid.js` ~`handleMouseEnter`): preloads per-track `<audio>` decoders on hover so multi-track clips don't stutter at open; ownership transferred to the player.
- **Event-driven visibility observer** (`renderer/clip-grid.js` ~L45–54): replaces `content-visibility: auto`; avoids ~150 layout recomputes/sec while the playhead animates.
- **Audio drift/stall correction** (`renderer/audio-tracks-manager.js` ~L298–380): freeze-on-seek-settle, >80ms drift handling, stall detection — snapping naively restarts the AAC decoder mid-syllable. Thresholds are tuned.
- **Trim auto-loop gate:** playhead resets to trim start when it drifts out of bounds *unless* the user manually sought (a `seekManual` flag). Tolerance ~0.001s.
- **Frame stepping** assumes ~30fps and throttles to 50ms.
- **Debounced persistence (~300ms)** across video-player / tag-manager / audio-tracks to avoid IPC spam during slider drags and toggles.
- **Export presets** are opinionated (names/descriptions users trust) — changing them needs migration logic.
- **Gamepad mappings** are user-configurable — default changes need config migration.

---

## 7. Open decisions (left for the implementing agent)

Each is a genuine fork; where to look is noted. These are **not** pre-decided.

1. **Preload / security model.** Keep `nodeIntegration` + direct `require('electron')` (fastest port), or migrate to a typed `contextBridge` preload (`window.clips.*`) like Hynite? Look: current `main.js` `webPreferences`; `Game Launcher/apps/desktop/src/preload/index.ts`. Trade-off: security/cleanliness vs. touching every IPC call site.
2. **Video player: wrap vs rewrite.** Wrap the existing imperative `renderer/video-player.js` + `audio-tracks-manager.js` inside a React component (refs/effects) to preserve the fragile audio-sync verbatim, or rewrite in React? Look: `renderer/video-player.js`, `renderer/audio-tracks-manager.js`, and the constraints in §6. Hynite uses `hls.js` for video-in-React as prior art.
3. **Routing.** Hand-rolled route enum (Hynite) vs `react-router` (cliplib-share)? Look: `Game Launcher/apps/desktop/src/renderer/App.tsx` route state; `cliplib share/src/App.tsx`.
4. **Feed data source + auth.** Does the in-app Feed hit the ClipLib web API directly (reuse `cliplib share/src/api/client.ts` with a configurable base URL + cookie/token) or proxy through the Electron main process? How does in-app auth relate to the existing `start-cliplib-auth` IPC? Look: `cliplib share/src/api/client.ts`, `src/context/AuthContext.tsx`; `renderer/share-manager.js`, `start-cliplib-auth`/`cliplib-auth-event`.
5. **Shared UI package.** The feed components would live in both cliplib-share (web) and this desktop app. Extract a shared package now (monorepo — Hynite already uses npm workspaces) or copy first and extract later? Look: `Game Launcher/package.json` workspaces.
6. **State management.** Local component state + context (both references lean this way) vs a store. Look: how `cliplib share` uses `context/` + `hooks/`.
7. **Fonts / icons delivery.** Bundle Inter + `lucide-react` (Hynite) and drop the CDN Google Fonts / Material Symbols, or keep CDN? Offline behavior matters for a desktop app. Look: current `index.html` `<head>`; Hynite `styles.css` font stack.
8. **Thumbnail + hover-preview lifecycle in React.** How to express warm-on-hover + reuse-at-open cleanly within React lifecycles without regressing the perf win (§6). Look: `renderer/clip-grid.js` hover handlers, `renderer/video-player.js` open path.
9. **Legacy reference location.** `legacy/` folder in-repo vs a `legacy-renderer` branch/tag. Whichever, it must stay easy to grep and copy from during the build.

---

## 8. Reference map (where to copy / study from)

| Need | Study in current app (read-only) | Study in references |
|---|---|---|
| IPC channels & data shapes | `renderer/*.js` (grep `ipcRenderer.invoke/on`), `main/` handlers | Hynite `apps/desktop/src/preload/index.ts` (namespace pattern) |
| Sidebar / top bar / grid shell | `index.html`, `styles.css` | Hynite `App.tsx` `.rail`, `.search-box`, `GameCover`, `.library-grid` |
| Menus / modals / popovers | `renderer/clip-grid.js` (context menu), `templates/settings-modal.html` | Hynite `GameContextMenu`/`MenuSubmenu`; cliplib `UserPopover.tsx` (`@floating-ui/react`) |
| Library card (local clip) | `renderer/clip-grid.js` | Hynite `GameCover`; cliplib `ClipCard.tsx` (adapt to local shape) |
| Feed / social (shared clip) | `renderer/share-manager.js` | cliplib `pages/FeedPage.tsx`, `components/ClipCard.tsx`, `ReactionBar.tsx`, `InfiniteScroll.tsx`, `hooks/useClips.ts` |
| Video player | `renderer/video-player.js`, `renderer/audio-tracks-manager.js` | cliplib `ClipPlayer.tsx` (simple wrapper only); Hynite `hls.js` usage |
| Settings | `templates/settings-modal.html`, `renderer/settings-manager-ui.js` | Hynite `SettingsScreen` |
| Design tokens | `styles.css` `:root` | cliplib `src/index.css` `@theme`; Hynite `styles.css` `:root` |

---

## 9. Summary of what is fixed vs. open

**Fixed:** renderer-only rewrite; main process untouched; keep the legacy renderer as read-only reference; lid errors + log them as TODOs; build Hynite-shell-first then sharing-grid/social-second; **Tailwind v4** base; preserve the IPC contract and the hard-won behaviors in §6; keep the liked purple tag-selection system.

**Open:** everything in §7. The §5 reimplementation checklist is a **first pass to be verified and expanded** against the code by the agent that does the work.
