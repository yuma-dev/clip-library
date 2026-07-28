# Clipdip telemetry

Clipdip sends anonymous crash and error reports to a self-hosted server
(`logs.yuma-homeserver.online`, operated by the Clipdip developer in Germany)
so that capture failures on machines we do not own become visible and fixable.
This document is the complete, auditable description of what is sent. The
client code lives in [`crates/diagnostics`](crates/diagnostics/) and every
sending call site is greppable via `clipdip_diagnostics::`.

Telemetry can be turned off with one toggle in the settings. Off means off:
no heartbeats, no events, nothing.

## Identity

Three random identifiers, none derived from your hardware:

| id | what | where it lives |
|---|---|---|
| `install_id` | random UUID per install | `%LOCALAPPDATA%\clipdip\data\install_id` |
| `machine_key` | random UUID that survives an app reinstall, so a reinstall is not miscounted as a new user | registry value `HKCU\Software\Clipdip\telemetry_machine_key` |
| `session_id` | random UUID per app run | memory only |

The `machine_key` is explicitly NOT derived from your Windows MachineGuid,
hardware serials, MAC addresses, or anything else about your machine. It is a
coin flip stored in your own registry. Deleting that registry value makes you
a brand-new machine to us.

## What is sent

**Heartbeat**, every 15 minutes while running: the ids above, app version,
and two blocks:

- `machine` (once per session): OS version and build, CPU model, core count,
  RAM, GPU vendor/model/driver version/VRAM, display resolutions and count,
  Windows locale, free disk space on the clips volume in GB, and the volume
  type as a category (system drive / other drive / removable / network).
- `app`: resolved encoder (e.g. `nvenc_h264`), capture mode (WGC or desktop
  duplication), capture resolution, replay length, fps, lifetime count of
  clips saved, free storage in GB.

**Events**, when something notable happens: crashes, capture and encoder
failures, save failures, disk-full conditions, update outcomes, config
corruption, uncaught UI errors, and one success metric (`clip_saved`, with
purely numeric fields: duration, fps, file size, save latency). Every event
carries a stable code, a severity, and a small context object of numbers and
enum strings. High-frequency conditions are coalesced client-side and carry
an occurrence count instead of firing repeatedly.

**Session end**, when the app exits cleanly, with a reason (quit, update,
OS shutdown, or a deliberate recovery restart). A session that just stops
heartbeating is how crashes become measurable.

**Diagnostic bundles**, only when you press the upload button yourself: a zip
of `clipdip.log`, the rotated previous log, `config.toml`, and a small
system-info text file, plus the note you typed.

## What is never sent

- file names, folder names, or paths (a path is only ever represented as a
  drive-type category and a free-space number)
- window titles, game or program names, process ids
- audio device names or device ids
- Discord usernames, server ids, or anything about who is in a call
- config file contents, command line arguments, deep-link URLs
- keystrokes, screenshots, clip content, thumbnails

Free-text error messages are scrubbed before sending: any
`C:\Users\<name>` fragment is replaced with `C:\Users\<home>`.

## The honest caveat: log tails

Error and crash events attach the last 256 KB of Clipdip's own log file,
compressed. That log is written for debugging and can contain paths from your
clips folder, display names, and audio device names as they appeared in log
lines. It is not scrubbed. This is a deliberate trade-off: the log tail is
what usually makes a one-off crash fixable without asking the user anything.
If that is not acceptable to you, turn telemetry off; nothing is sent at all.

## Remote controls

The heartbeat response can carry a temporary log-level override (debug/trace,
with an expiry) so the developer can debug a hard case on a specific install
without shipping a build. It changes only the local log verbosity, never what
categories of data are uploaded.

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

Settings toggle: "Telemetry" in the Clipdip section. Turning it off stops all
network traffic immediately and deletes the local queue of unsent events. The
registry `machine_key` remains on your machine but is never transmitted
again; delete `HKCU\Software\Clipdip` to remove it entirely.

## Changelog

- 2026-07: v2 — added machine_key (random, registry), hardware profile block,
  sessions with end reasons, event severities, and ~35 new failure signals.
  This document was introduced with v2.
- 2025/2026 v1 — install_id + app version heartbeat, capture failure events,
  manual bundles.
