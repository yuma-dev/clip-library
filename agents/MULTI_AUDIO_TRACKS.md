# Multi-Audio-Track Playback

How clips with several audio streams (OBS-style: mic, desktop, game, voice chat, pre-mix) are played back, mixed, and persisted. Export is **not** implemented yet — playback + UI only.

---

## Problem

HTML5 `<video>` only plays the *default* audio track. Every other AAC stream in the mp4 is silently dropped. We need them all audible simultaneously, with per-track gain, while staying perfectly in sync with the video.

## Strategy

`<video>` remains the **video clock and video output**, but is **muted**. Each audio track is pre-extracted to a standalone `.m4a` (stream-copy, no re-encode) and played from its own hidden `<audio>` element. Each `<audio>` is routed through Web Audio (`MediaElementSource → trackGain → masterGain → destination`) so we get independent gain per track. A single rAF "mirror loop" continuously enforces that every `<audio>` matches the video's `paused` / `playbackRate` / `currentTime`.

This was chosen over WebCodecs/mp4box.js demuxing or full PCM decode because it (a) reuses the existing ffmpeg pipeline + HTML media + WebAudio plumbing, (b) lets the browser handle AAC decoding and seek scheduling natively, (c) keeps memory bounded regardless of clip length.

---

## Pipeline

### 1. Probe (`main/ffmpeg.js → getClipInfo`)

- `get-clip-info` IPC always runs `ffprobe` directly (`execFile` + JSON parse). fluent-ffmpeg's ffprobe sometimes drops stream tags, so we don't rely on it for audio tracks.
- Builds `audioTracks: [{ streamIndex, ordinal, codec, channels, sampleRate, language, name, isDefault }]`.
- **Name resolution**: `tags.title` → `tags.handler_name` (only if it's not the generic `"SoundHandler"`) → `Track N`.
- Cached in the thumbnail metadata file alongside duration. Cache invalidates on `AUDIO_TRACKS_CACHE_VERSION` bump.

### 2. Extract (`extract-audio-tracks` IPC)

Per-track ffmpeg invocations run **in parallel** (`Promise.all` over `execFileAsync`), one process per stream. Per-process arg shape depends on the track's `needsReencode` flag computed at probe time:

- **`needsReencode === false`** (the common case): `ffmpeg -map 0:<streamIndex> -c:a copy -vn <out>.m4a`. Stream-copy — near-zero CPU, output ready in tens of ms.
- **`needsReencode === true`** (the track has an edit-list offset): `ffmpeg -map 0:<streamIndex> -c:a aac -b:a 192k -af aresample=async=1:first_pts=0 -vn <out>.m4a`. Re-encode applies the edit list during demux and emits a clean stream starting at PTS 0 with silence padding for the leading gap. 192k AAC is transparent for voice/desktop audio.

**Why per-track branching matters.** Source mp4s (especially OBS-style multitrack recordings) sometimes carry an edit-list (`elst`) atom on one stream — typically the pre-mix — that maps the first ~0.6 s of presentation time to nothing. Stream-copy preserves the elst, after which Chrome's `<audio>` element clamps `currentTime` *upwards* to the first playable offset. That track then plays the wrong clip-time (the source's 0.598 s) while the others play from 0, audible as a duplicated syllable at clip start. The previous "always re-encode" version fixed correctness but added ~1.5–2 s of encode work to every first-open. Branching on `needsReencode` means typically only 0–1 of N tracks pays the encode cost.

**Why parallel processes instead of one multi-output ffmpeg?** Multi-output shares a single decode pass but serializes the encoders; per-process parallelism scales the *encode* phase across cores, which is the bottleneck when any track needs re-encoding.

**Cache.** Output goes to `<clipLocation>/.clip_metadata/audio_tracks_v3/<safe-clipname>/track_<ordinal>.m4a`. Reused if newer than the source. The `_vN` suffix invalidates older extractions when the extractor logic changes: v1 always stream-copied (broke offset tracks), v2 always re-encoded (slow first-open), v3 branches per-track.

Skipped entirely for clips with `< 2` audio streams.

### 2a. elst detection (`probeAudioTracksDirect`)

ffprobe `-show_streams` already gives us `start_time` per stream. A non-zero `start_time` (we use `Math.abs(startTime) > 0.0005` to allow for float noise) means the source has an `elst` that shifts the stream's first packet — exactly the case where stream-copy would carry the offset through and break seeking. The probe writes `needsReencode: true|false` (plus the raw `startTime`) onto each entry of `audioTracks`. `AUDIO_TRACKS_CACHE_VERSION` was bumped to 3 so cached metadata gets re-probed.

### 3. Init (`renderer/audio-tracks-manager.js`)

Only runs when `audioTracks.length > 1`. `openClip` **awaits** this before `videoPlayer.play()` — the user explicitly preferred a brief load delay over hearing the wrong audio (native default-track) for the first second or two and then having it swap. Most of the perceived cost is the ffmpeg extraction; per-track branching (see §2 above) keeps that to tens of ms for clips with no offset tracks.

Steps inside `openClip` after `videoLoadPromise` resolves:

1. `setupAudioContext()` (idempotent — only creates the context once per video element).
2. In parallel: `extract-audio-tracks`, `get-track-state` (per-clip volumes), `get-track-preferences` (global colors + hidden state).
3. Build hidden `<audio>` elements, one per extracted track. Wait for each to reach `readyState >= 2` (or 2 s safety timeout).
4. Mute the `<video>` element. The video element's `MediaElementSource` is still connected to `masterGain` but emits silence (per spec: a muted `HTMLMediaElement` produces silence into Web Audio).
5. Render the mixer panel; start the mirror loop. Force-snap each `audio.currentTime = video.currentTime` so the per-track audio is at the right place when `videoPlayer.play()` is finally called.

`closePlayer` also increments `clipOpenGeneration`, so any in-flight async init that finishes after the user closed the player checks the generation token and discards itself instead of attaching to a closed video element.

### 4. Teardown

Triggered at the start of every `openClip` and inside `closePlayer`. Cancels the rAF loop, disconnects every gain/source node, pauses & removes every `<audio>`, removes document-level palette listeners, **unmutes the video** so single-track clips revert to normal behavior.

---

## Sync model — the mirror loop

A single `requestAnimationFrame` tick (~16 ms, gated to ~90 ms cadence) inside `_enforceVideoState` repeatedly enforces, for every `<audio>`:

```
audioEl.playbackRate === videoEl.playbackRate
videoShouldPlay   ? audioEl.play()  : audioEl.pause()
|audioEl.currentTime - videoEl.currentTime| < 0.08s
```

**This replaced an earlier listener-based design** that subscribed to `play` / `pause` / `seeking` / `seeked` / `ratechange` events. Reasons:

- Anything that mutates `video.currentTime` directly (frame stepping, trim auto-loop at end, navigation, scrub bar drag, space-hold speed boost) sometimes failed to fire the events we expected, breaking sync.
- The mirror model is "the video is the only clock; audio elements are slaves." No per-feature wiring needed — any caller that moves the video is automatically followed by audio.

### Scrub gating (critical fix)

Writing `audio.currentTime = X` enqueues an **audio decoder seek**. Doing that 10×/s while the user drags the scrub bar starved the decoders and produced audible glitches plus a sluggish scrub feel.

The mirror loop now treats `video.seeking === true` as a hard freeze:

- `seekInFlight = video.seeking || (now - lastVideoSeekingTs) < SEEK_SETTLE_DELAY_MS` (25 ms).
- While `seekInFlight`: pause every `<audio>`, do **not** write `currentTime`.
- When the seek settles (transition `true → false` past the settle delay): snap once, then resume mirroring.

To keep one-shot seeks (click on scrub bar, arrow-key skip, frame step) feeling near-instant on multi-track clips — close to native single-track latency — a dedicated **`seeked` event listener** on the `<video>` fast-paths the snap: it writes `audio.currentTime = video.currentTime` ~20 ms after the last `seeked` (debounced to coalesce mid-drag bursts), rather than waiting for the next ~90 ms mirror tick. The mirror loop's `seekInFlight` gate still keeps audio silent during the drag itself.

### Video-stall guard (start-of-clip stutter fix)

Right after `video.play()` (and after any seek) the video element's `currentTime` doesn't advance for a moment while its decoder warms up — but `video.paused` is already `false`. Audio `<audio>` decoders warm up *faster*, so without a guard they race ahead, the mirror loop sees `|drift| > 0.08 s`, and snaps `audio.currentTime` back to `videoTime`. Each snap restarts the AAC decoder mid-syllable, producing audible "h-h-h-h-hallo" stutter at clip open.

Guard: every tick checks whether `video.currentTime` has actually advanced since the last tick. If it hasn't for more than one mirror interval while `videoShouldPlay`, we treat the video as **stalled** — pause every `<audio>` instead of snapping or playing, and skip drift correction. Audio re-engages on the first tick that observes real video advancement. As a belt-and-braces follow-up, drift correction during steady playback also prefers `audio.pause()` over a destructive snap when audio is ahead of video.

### Drift threshold

Steady-state drift correction kicks in at `> 0.08 s`. Smaller threshold = more frequent seeks = decoder churn. Larger = audible lip-sync drift. 80 ms is the sweet spot in practice.

---

## Race condition fix — generation tokens

Clicking the next/prev arrows rapidly used to **leave a stale manager active** for the wrong clip. Each `openClip` call awaits IPC and async manager init; a later `openClip` could finish disposing the old manager before the *earlier* one finished its init, which then installed itself over the newer one. Result: clip B's video with clip A's audio.

Fix: a monotonically incremented `clipOpenGeneration` token in `video-player.js`. Every `openClip` captures `openGen = ++clipOpenGeneration`. After every `await` in the multi-track init path, we check `openGen === clipOpenGeneration` — if not, dispose the half-built manager and bail. Latest open always wins.

---

## Persistence

Two separate stores. The split matters: volume is creative per-clip ("this clip needs the mic louder"), but color and hidden-state are device identity ("Mic In is always blue and never in the mix").

### Per-clip state — `.clip_metadata/<clip>.trackstate`

```json
{ "tracks": { "0": { "volume": 1.0 }, "1": { "volume": 0.6 } } }
```

Keyed by **ordinal** (audio-track index within the clip). Holds only `volume`. Debounced 300 ms after the last drag/wheel/dblclick.

### Global preferences — `userData/trackPreferences.json`

```json
{
  "Mic In (Elgato Wave:XLR)": { "color": "#10b981", "hidden": true },
  "Mix":                       { "color": "#3b82f6" }
}
```

Keyed by **track name**. Holds `color` and `hidden`. Written **immediately** (no debounce). Loaded on every clip open and applied to any track whose name matches. A `hidden: null` patch removes the key — empty entries are pruned to keep the file tidy.

On init, when a track has a global pref:
- `color`: applied to the row tint and palette default
- `hidden: true`: track starts in the Hidden tray, gain forced to 0

When two tracks in the same clip share a name (rare, but possible), color/hidden changes propagate to both via `_applyColorByName` / `_applyHiddenByName`.

---

## UI

Lives in `#audio-tracks-panel` inside `#volume-container`. The same volume button at the bottom-left toggles it. Single-track clips show the legacy horizontal slider; multi-track clips show the mixer.

Row interactions:
- **drag** anywhere on the row → set volume (detent snap to 1.0 within ±0.05)
- **double-click** → 1.0
- **mousewheel** → ±0.05
- **color dot** (left) → opens 8-color palette popover, click swatch to pick
- **X button** (right, fades in on hover) → hide track → moves to "Hidden" tray as a chip
- **chip in tray** → click to restore

Display values are `Math.round(volume * 100)%`. Internal scale is 0–2 (Web Audio gain). Detent at 100% gives a tactile snap to unity.

---

## File map

| File | Role |
|---|---|
| `main/ffmpeg.js` | `getClipInfo` (exposes `audioTracks`), `extractAudioTracks`, `probeAudioTracksDirect` |
| `main/metadata.js` | `getTrackState`/`saveTrackState` (per-clip), `getTrackPreferences`/`saveTrackPreferences` (global) |
| `main.js` | IPC handlers: `extract-audio-tracks`, `get/save-track-state`, `get/save-track-preferences` |
| `renderer/audio-tracks-manager.js` | The whole mixer: graph setup, mirror loop, UI rendering, persistence dispatch |
| `renderer/video-player.js` | `openClip` integration, teardown, generation token, volume button wiring |
| `index.html` + `styles.css` | `#audio-tracks-panel` markup + `.mixer__*` styles |

---

## Quirks & gotchas

- **`createMediaElementSource` can only be called once per element.** `setupAudioContext` is guarded with `if (state.audioContext) return;`. The video's MediaElementSource stays connected to `masterGain` for the lifetime of the page; we mute the video element to silence its native audio.
- **AudioContext starts suspended** in modern browsers; the manager calls `audioContext.resume()` on init for safety. Normal clip opening is preceded by a user gesture so this is usually unnecessary.
- **`<audio>` `play()` rejections** with `AbortError` are benign — they happen when the mirror loop flips state again immediately. We filter those out of the logs.
- **AV1 video + AAC audio** in the test files: Chromium plays AV1 natively in `<video>`, AAC plays natively in `<audio>`. No re-encode needed at any point.
- **fluent-ffmpeg's ffprobe drops `handler_name` tags sometimes** — that's why `getClipInfo` re-probes with direct `execFile` for audio-track names. Don't switch back to the fluent path.
- **Cache version bumps** are required when changing the shape of cached `audioTracks` entries (`AUDIO_TRACKS_CACHE_VERSION`). Otherwise old clips load stale data.
- **Per-clip state was previously storing `color` and `muted` too** — that data is now ignored on read. Old `.trackstate` files don't need to be migrated; the global store takes precedence and per-clip color/muted writes have been removed.
- **Tracks named generically as `Track 1`/`Track 2`** (e.g. older mp4s where `handler_name === "SoundHandler"`) will share global prefs across *every* clip with that fallback name. This is intentional but worth noting if it ever surprises a user.

---

## Verification checklist

1. Open `MultiTrackTest2.mp4` (real handler names): 5 rows labeled "Mix", "Stream Mix (Elgato Virtual Audio)", "Music …", "System …", "Mic In (Elgato Wave:XLR)". All play together, in sync with the video.
2. Open `MultiTrackTest.mp4` (generic): rows labeled "Track 1" … "Track 5". Same sync behavior.
3. Drag a row to 60% in clip A, switch to clip B (same track name): volume on B is **independent** (back to its own value). Color and hidden state on B match A.
4. Pick a color → close player → reopen any clip with that track name → color persists.
5. Hide a track → reopen → still hidden. Restore via chip → reopen → still restored.
6. Scrub the scrub bar around: scrub feels native, no audible glitching, audio lands on the final position.
7. Click prev/next arrows rapidly: audio always matches the clip currently on screen, no leak from previous clips.
8. Open a single-track clip: panel hides, legacy horizontal volume slider works as before.
