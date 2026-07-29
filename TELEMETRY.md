# ClipLib telemetry

ClipLib sends anonymous crash and error reports to a self-hosted server
(`logs.yuma-homeserver.online`, operated by the ClipLib developer) so that
failures on machines we do not own become visible and fixable. This document is
the complete, auditable description of what is sent. The client code lives in
[`main/telemetry`](main/telemetry/) and [`src/renderer/telemetry`](src/renderer/telemetry/),
and every sending call site is greppable via `telemetry.event(` in the main
process and `reportEvent(` in the renderer.

This exists because the library app was close to blind. Most failures were
turned into plausible-looking empty values: a broken library rendered as "no
clips", a failed thumbnail rendered as a shimmer that never resolves, a silently
failed update looked exactly like being up to date. None of that produced any
signal anyone could act on.

Telemetry can be turned off with one toggle in Settings, About. Off means off:
no heartbeats, no events, no metrics, nothing.

ClipLib and Clipdip have **separate** switches, shown next to each other in
Settings, About. Turning one off does not turn the other off. Clipdip's own
document is [`clipdip/TELEMETRY.md`](clipdip/TELEMETRY.md).

## Identity

Three random identifiers, none derived from your hardware:

| id | what | where it lives |
|---|---|---|
| `install_id` | random UUID per install | Clipdip's `%LOCALAPPDATA%\clipdip\data\install_id` when that file exists, otherwise `<userData>\install_id` |
| `machine_key` | random UUID that survives an app reinstall, so a reinstall is not miscounted as a new user | registry value `HKCU\Software\ClipLib\telemetry_machine_key` |
| `session_id` | random UUID per app run | memory only |

**The install id is shared with Clipdip on purpose.** When Clipdip has already
minted one on this machine, ClipLib adopts it rather than generating a second.
That is what lets one report read "this machine's capture failed, and forty
seconds later its export failed" instead of being two unrelated rows. The
heartbeat also carries `install_id_source` (`clipdip`, `local` or `ephemeral`)
so an install whose id file cannot be written is visible as such rather than
looking like a new user on every launch.

The `machine_key` works the same way: if `HKCU\Software\Clipdip` already holds
one, ClipLib adopts that value; otherwise it generates a fresh UUID and writes
it under `HKCU\Software\ClipLib`.

The `machine_key` is explicitly NOT derived from your Windows MachineGuid,
hardware serials, MAC addresses, your username, or anything else about your
machine. It is a coin flip stored in your own registry. Deleting that registry
value makes you a brand-new machine to us.

## What is sent

**Heartbeat**, every 15 minutes while running: the ids above, app version,
uptime, when the session started, and two blocks.

- `machine`, sent once per session: OS and build number, CPU model, core count,
  RAM, GPU vendor, model and driver version, monitor count and resolutions,
  the primary display's DPI scale and refresh rate, Windows locale, time zone
  name, and the Electron, Chrome and Node versions the build runs on. It also
  describes the drive your clips are on as a **category** (`system`, `other`,
  `removable` or `network`) plus how many GB are free on it. The category is
  there because a clips folder on a network share is the single best predictor
  of the "new clips never appear" bug. The path itself is never sent.
- `app`, sent only when a value changed since the last beat. From your settings:
  export preset, export quality, export size goal, UI font, whether Discord Rich
  Presence is on, whether the controller is on, whether the ambient glow is on,
  whether Clipdip is enabled, which onboarding version you completed, and a count
  of how many keybindings you changed from the defaults. Plus a few measurements
  of the app's current state: the size of your library **as a bucket** rather
  than an exact number (for example `1k_5k`), its total size in GB, how many tags
  you have, whether hardware encoding is available, and whether the recorder, the
  file watcher and a ClipLib sign-in are currently active. It never carries your
  clip folder, the Clipdip binary path, your API token, the sharing server URL,
  any tag name, or any clip name.

**Events**, when something notable happens. Around 95 distinct codes across startup,
the clip library, settings, metadata sidecars, thumbnails, ffmpeg and export,
the file watcher, the updater, sharing and auth, the Clipdip bridge, the
SteelSeries import, and the IPC layer. Every event carries a stable code, a
kind, a severity, the surface it came from, a grouping fingerprint, and a small
`context` object of numbers, booleans and short enum strings.

Repeats are coalesced client-side: the first occurrence sends immediately, later
ones inside the window (60 seconds by default, longer for noisy sites) only
increment a counter that rides along on the next send. There is a hard cap of
200 events per session in the main process and 100 in the renderer. Hitting
either emits one `telemetry_event_cap_reached` or `telemetry_renderer_cap_reached`
and then stops, so a truncated session is never mistaken for a quiet one.

**Metrics**, aggregated in memory and flushed on the 15 minute beat. These are
bucket histograms, not individual samples and not timestamps: each one is a
name, a unit, a count, a sum, a min, a max, a sparse map of `upper bound ->
count`, and at most three enum-valued dimensions. Currently measured: startup
phases, IPC handler time per channel, clip open time (total and per slot),
library scan time, folder size time, thumbnail generation time, export time and
realtime factor, sharing API round trips, update download time and throughput,
file watcher readiness, renderer long tasks and interaction latency. Nothing in
a metric identifies which clip, folder or file was involved.

**Daily usage rollup**, once per completed day. ClipLib already keeps a local
activity log for the year-end recap, in `activity_logs\`. That file stays on your
machine and is never uploaded. What is sent is a counts-only projection of it,
one object per day: how many distinct clips you watched (a count, derived from
locally hashed names that are themselves never sent) and total watch minutes,
plus counts of renames, trims, speed and volume changes, deletes, tag
operations, exports broken down by format and destination, shares attempted and
succeeded, and imports by source. No clip names, no custom names, no tag text,
no folder paths, no import paths, no share ids, no server URLs.

The rollup covers completed days only, so a day is never sent twice with
different numbers, and it backfills at most 30 days if the app has not run. It
reads forward from a saved position rather than rescanning your history.

**Session end**, when the app exits cleanly, with a reason (`quit`,
`window_all_closed`, `update`, or `shutdown` for an OS session end). A session
that just stops heartbeating is how crashes become measurable. A marker file is
also written at startup and removed on a clean exit, so a marker still present
at the next launch produces an `unclean_shutdown` event.

**Diagnostic bundles**, only when you press the upload button yourself in
Settings, About: a zip of ClipLib's logs, your settings files, the local
activity log, captured renderer console output, Clipdip's logs and status, a
listing of any crash dumps, a system info file, and the note you typed. These
are far more detailed than anything above, which is exactly why they are manual
and require you to describe the problem first.

### Event kinds

The `kind` field is the urgency axis, and it is the one that decides how fast a
bug gets looked at:

| kind | meaning |
|---|---|
| `crash` | a process or the React tree died |
| `error` | an operation failed and you were told about it |
| `silent_failure` | an operation failed and you were **not** told |
| `data_loss` | your data was reset, discarded, or overwritten |
| `degraded` | a fallback to a slower or worse path that still produced a result |
| `custom` | success signals and lifecycle, not a problem |

`silent_failure` is the whole reason this exists. It covers the cases where the
app looked fine and was not: a folder that failed to enumerate and rendered as
an empty library, audio tracks that failed to extract and rendered as a clip
with no audio, a clipboard copy that reported success without writing anything,
an update installer that never launched.

`data_loss` is the one that fires an alert immediately with no threshold. It
covers your custom names, trim points, tags, volume ranges or settings being
reset, discarded, or written over with defaults. If it happens to you, we want
to know within minutes, not from a bug report a week later.

`severity` is `debug`, `info`, `warning`, `error` or `fatal`. Anything at
`error` or above is flushed within a couple of seconds instead of waiting for
the next beat, because the next thing to happen may be the window dying.

## What is never sent

- file names, folder names, or paths, including your clip location
- clip names and custom names
- tag text (a failure while migrating tags reports how many entries it scanned
  and how many it could not write, never what any of them said)
- game names and window titles, even though they are derivable from filenames
- Discord identity: usernames, user ids, server ids, voice rosters, avatars
- your ClipLib account id, username, invite codes, or any token
- search queries
- the contents of any config file, including `settings.json` values that hold
  paths or credentials
- keystrokes, screenshots, thumbnails, clip content

Free-text error messages from the main process are scrubbed before sending.
Every absolute path is reduced to its drive letter: `D:\Games\Clips\Valorant
2026-07-28.mp4` becomes `D:\<path>`, and a network path becomes `<unc>`. So a
failure reads `ENOENT: no such file or directory, open 'D:\<path>'`, which keeps
the part that explains the bug and discards the part that describes you. The
result is then truncated. Renderer errors do not send a message at all, only the
error type and the top three stack frames, because a JavaScript error message
routinely embeds the name of the file that failed.

## The honest caveat: log tails

Fatal events attach the last 128 KB of ClipLib's own log file, compressed. That
log is written for debugging, and unlike everything else described here it is
not a curated list of fields.

ClipLib scrubs the tail before compressing it with the same path rule described
above, so full paths are gone. **That is still not enough to make it
anonymous.** Two things survive:

- **Bare file names**, logged without a directory, for example `Opening clip:
  Replay 2026-07-28 19-49-54.mp4`. A clip file name encodes the game you were
  playing and the date and time you played it.
- **Tag text.** Your own tag names appear in log lines about tagging and Discord
  updates. The "never sent" list above holds for events and metrics; it does not
  hold inside a log tail.

If you can read your own log and learn something about yourself, so can we.

This is a deliberate trade-off: the log tail is what usually makes a one-off
crash fixable without asking you anything. It is also why tails are restricted
rather than attached to everything. A tail is attached only:

- to events at `fatal` severity, which means a crash or a startup failure that
  makes the app unusable. Note this includes `unclean_shutdown`, raised on the
  next launch after any unclean exit, so tails are not as rare as "a crash"
  might suggest, and
- to specific event codes the server explicitly promotes while a particular bug
  is being chased (see below).

Everything at `error` and below travels without one. If that trade is not
acceptable to you, turn telemetry off; nothing is sent at all.

## Remote controls

The heartbeat response can carry three settings, all optional:

- `muted_codes`: stop a specific event code fleet-wide. Used when one bad code
  starts flooding, so the fix does not have to wait for a release.
- `attach_log_codes`: promote specific codes to log-tail attachment while a hard
  bug is being chased. This is scoped to named codes, never a blanket switch.
- `heartbeat_interval_s`: change the beat interval.

None of these can add a category of data that is not described in this
document. `attach_log_codes` can attach a log tail to a non-fatal code, which is
the one control that widens what leaves your machine, and it is the reason the
caveat above is written the way it is.

## Retention (server side)

| data | kept |
|---|---|
| events and their log tails | 90 days |
| diagnostic bundles | 30 days |
| raw heartbeats | 7 days |
| daily aggregate rollups, install/machine/issue rows | indefinitely |

IP addresses are truncated to the first two octets before storage and never
stored in full.

## Opting out

Settings, About, "Anonymous diagnostics", the "ClipLib" switch. Turning it off
takes effect immediately, with no restart:

- no heartbeat
- no events
- no metrics
- no daily usage rollup, and the file tracking how far it has read is never
  written
- the local queue file (`<userData>\telemetry-queue.jsonl`) is deleted, so
  anything collected but not yet sent is discarded rather than sent later

Manual diagnostic bundles are unaffected, because they only happen when you
press the button.

The Clipdip toggle sits directly below it and governs Clipdip only. Turning off
one does not turn off the other.

The registry `machine_key` remains on your machine but is never transmitted
again; delete `HKCU\Software\ClipLib` to remove it entirely.

## Changelog

- 2026-07: initial version. Heartbeat with a hardware profile and a settings
  block, ~95 failure and lifecycle signals across the library, metadata, thumbnails, export,
  updater, sharing and IPC layers, bucketed performance metrics, a counts-only
  daily usage rollup, sessions with
  end reasons and unclean-shutdown detection, and log tails restricted to fatal
  events. Prior to this, the library app sent nothing automatically; only
  Clipdip and the manual diagnostics upload reached the server.
