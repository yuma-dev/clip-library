# Privacy Policy — ClipLib

**Last updated: 29 July 2026**

## 1. Who is responsible (Controller)

ClipLib is developed and operated by an individual developer based in Germany:

> Fabian Silbermann
> Germany
> Email: **fabiansilbermann1@gmail.com**

For any privacy question or to exercise your rights (see section 10), email the address above.

---

## 2. Data processed only on your device (never transmitted)

Most of what ClipLib does happens entirely locally and never reaches us or any third party:

- **Your video clips** and any exported/trimmed copies.
- **Per-clip metadata sidecars** (stored next to your clips in a `.clip_metadata` folder):
  custom name, trim points, playback speed, volume, track state, tags, and a `.gameinfo`
  file containing the recorded window/game title and, if applicable, the Discord voice
  roster (see section 5).
- **App settings** (`settings.json`): your clip folder location, feature toggles, and
  keybindings/controller mappings.
- **A local activity log** (`activity_logs/…`): a record of actions you take in the app
  (renames, trims, speed/volume changes, tag edits, and when you shared a clip). This log
  stays on your machine and is **never uploaded automatically**. It may contain clip names
  and your sharing history.
- **Minor UI state** (e.g. whether the sidebar is pinned).

You can delete any of this at any time by deleting the corresponding files or your clips.

---

## 3. ClipLib Sharing — `friends.cliplib.app` (opt-in)

ClipLib includes an **optional** sharing service. Nothing is uploaded until you sign in
and choose to share.

**Signing in.** Accounts use **Discord login**. When you authenticate, the sharing service
receives and stores your basic Discord identity: display name, username, Discord user ID,
and avatar. Your access token is stored **encrypted** on your device using your operating
system's secure storage (Windows DPAPI / OS keychain via Electron `safeStorage`).

**When you share a clip,** we upload and store:

- the **video file** itself (trimmed export, up to 500 MB per clip);
- the **title** and **tags** you gave it;
- the **Discord user IDs of anyone you @mention** on the clip.

**Profile & social features.** You may upload a **profile banner image**, and the service
supports a social feed (listing clips, reactions, comments) and a directory used for
@mention autocomplete (which exposes users' id, username, display name, avatar, and Discord ID
to other signed-in users).

**Legal basis (GDPR Art. 6):** your **consent** and the **performance of the service you
requested** — Art. 6(1)(a) and 6(1)(b). You can stop at any time by not sharing, or by
deleting your shared clips/account (contact us if you need help removing content).

---

## 4. Updates — GitHub (automatic check)

To keep the app current, ClipLib checks GitHub
(`api.github.com` / `github.com/yuma-dev/clip-library`) for the latest release and, if you
choose to update, downloads the installer from there. These requests send only a generic
`User-Agent` header — **no account, no identifiers**. GitHub, as the host, may log the
request under [GitHub's Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

---

## 5. Discord voice-channel data (recorded locally)

ClipLib's recorder (**clipdip**) can, **if you connect it to Discord**, read **who is in
your Discord voice channel at the moment a clip is recorded** — participants' Discord IDs,
usernames, display names, and avatars — and store that roster **locally** in the clip's
`.gameinfo` sidecar. This powers @mention autocomplete and the sharing "mentions" feature.

Important points:

- This is **third-party personal data** (other people in your call). It stays on **your
  device** and only leaves it if you **share a clip and @mention those people** (see
  section 3).
- Connecting to Discord uses Discord's OAuth. A refresh token is stored locally
  (`%APPDATA%\clipdip\…`) so the connection can be renewed. Token exchange happens with
  `discord.com`.
- **Please respect others' privacy**: only share clips identifying other people with their
  awareness/consent, as also required by ClipLib's Terms.

The main app's **Discord Rich Presence** feature (which can show "Browsing clips" on your
Discord profile) is **off by default** and talks only to your **local** Discord client — no
clip data is transmitted.

---

## 6. Diagnostics & crash telemetry — `logs.yuma-homeserver.online`

To find and fix bugs, **both** parts of ClipLib can send **anonymous** diagnostics to a
developer-operated server:

- the **library app** (ClipLib itself), and
- the **recorder** (**clipdip**), which runs as its own background app.

They report **separately** and have **separate opt-out switches**, both shown together in
**Settings → About → Anonymous diagnostics**. Turning one off does not turn the other off.
This is designed to contain **no accounts and no personal identifiers**.

**Identifiers used.** Random UUIDs only: a per-install ID, a per-session ID, and a
per-machine key stored in your own Windows registry (`HKCU\Software\ClipLib` /
`HKCU\Software\Clipdip`). The machine key is **not** derived from your hardware, your
Windows MachineGuid, or your username; deleting the registry value makes you a new machine
to us. The library app deliberately **reuses the recorder's install ID** when one exists, so
the two products' reports about the same machine can be matched.

- **What the library app sends automatically (if not disabled):**
  - a **heartbeat** roughly every 15 minutes: the random IDs, app version, uptime, a
    one-time hardware profile (OS build, CPU, RAM, GPU and driver, monitor resolutions,
    locale, time zone, and the **category** of the drive your clips are on — system, other,
    removable or network — with its free space in GB), and a small set of your **feature
    settings** (e.g. export preset, whether Discord Rich Presence is on) alongside a few
    coarse measurements of the app's state (library size as a **bucket** rather than an
    exact count, total library size in GB, number of tags, and whether hardware encoding,
    the recorder, the file watcher and a sign-in are active). It never contains your clip
    folder, the recorder's binary path, your API token, the sharing server URL, any tag
    name, or any clip name.
  - **error, crash and failure events**: a stable error code, a category, a severity, a
    timestamp, and a small object of **numbers and fixed keywords**. Error text from the
    main process is included after path-scrubbing; errors from the app window send no
    message text at all, only the error type and top stack frames.
  - **aggregated performance metrics**: counts and bucketed timing histograms (e.g. how long
    startup or an export took). No per-clip records and no timestamps of what you did.
  - a **daily usage rollup**: one set of counts per completed day, covering how many clips
    you watched and for how long in total, and how many renames, trims, deletes, tag
    changes, exports (by format and destination), shares and imports you made. It is
    derived from the activity log ClipLib already keeps locally for the year-end recap.
    **That log itself is never uploaded**, and the rollup carries no clip names, custom
    names, tag text, folder paths or share ids.
  - a **session end** notice when the app closes.
- **What the recorder sends automatically (if not disabled):** heartbeats, hardware and
  capture configuration, and capture/encoder/save failures. See `clipdip/TELEMETRY.md`.
- **Note on log contents:** crash reports attach a **short compressed tail of the app log**.
  The library app removes Windows user paths from that tail before sending, but it can still
  **incidentally** contain clip file names, which in turn can reveal a game name and a
  date/time. We do not use these to identify you, but you should be aware they can appear.
  Log tails are attached only to **fatal** errors and to specific error codes while a
  particular bug is being investigated, never to routine events.
- **Opt-out:** Settings → About → Anonymous diagnostics, one switch per product. Turning the
  library app's switch off takes effect immediately: no heartbeat, no events, no metrics,
  no daily usage rollup, and anything queued locally but not yet sent is **deleted**.

The full, itemised description for each product lives in `TELEMETRY.md` (library app) and
`clipdip/TELEMETRY.md` (recorder), including the complete list of what is never sent.

**Manual, user-initiated uploads.** One bundle covers **both** products: recent logs,
settings files, your local activity log, captured console output, the recorder's logs and
status, a crash-dump listing, system info, and the note you typed. It is far more detailed
than the automatic telemetry above, which is why it is never sent on its own. (Discord tokens
are deliberately excluded.) In Settings → About:

- **"Save zip"** writes that bundle to a folder you choose. Nothing is transmitted.
- **"Export and upload"** sends it to the diagnostics server. It requires you to describe
  the problem first, so you always know an upload is happening.

**Legal basis:** **legitimate interest** in keeping the software stable and secure —
Art. 6(1)(f) — balanced by the data being anonymous and the opt-out above. Manual uploads
rely on your **consent** (Art. 6(1)(a)).

---

## 7. Who receives data (recipients overview)

| Recipient | Purpose | What is sent | When |
|---|---|---|---|
| `friends.cliplib.app` (ClipLib Sharing, operated by us) | Accounts, clip sharing, social feed | Discord identity, uploaded video + title + tags + @mentions, banner, reactions/comments | Only after you sign in / share |
| `logs.yuma-homeserver.online` (Diagnostics, operated by us) | Crash/bug diagnostics for the **library app** | Random install/machine/session IDs, app version, hardware profile, feature settings, error events, aggregated timing metrics, log tails on fatal errors | Auto (opt-out) |
| `logs.yuma-homeserver.online` (Diagnostics, operated by us) | Crash/bug diagnostics for the **recorder (clipdip)** | Random install/machine/session IDs, app version, hardware and capture configuration, capture/encoder failures, log tails | Auto (separate opt-out) |
| `logs.yuma-homeserver.online` (Diagnostics, operated by us) | Manual problem reports | One bundle: logs, settings files, activity log, console output, recorder logs and status, crash-dump listing, system info, your note | Only when you press "Export and upload" |
| GitHub (`github.com`) | Update check & download | Generic User-Agent only | On update check/download |
| Discord (`discord.com`) | Login & voice-roster read | OAuth login; reads your live voice-channel membership | Only if you connect Discord |

Recording and video processing (ffmpeg/ffprobe) run **entirely on your device**.

---

## 8. Retention

- **Local data** stays until **you** delete it (your clips, sidecars, settings, logs).
- **Shared clips and account data** are kept while your account/shared clips exist. You can
  delete shared clips or ask us to delete your account and content — email us.
- **Diagnostics** are kept only as long as needed to investigate stability issues: error
  events and their log tails **90 days**, manual bundles **30 days**, raw heartbeats
  **7 days**. Kept **indefinitely**: the daily usage rollup, and one row per install and
  per machine. These are pseudonymous rather than aggregate — each daily rollup is stored
  against the random install ID and machine key described in section 6, alongside the
  feature-settings snapshot, so a single install's day-by-day counts remain queryable.
  They contain no name, account, path or file name, and the random IDs are the only thing
  linking them to a machine; deleting the registry key in section 6 breaks that link going
  forward. IP addresses are truncated to the first two octets before storage and are never
  stored in full.

---

## 9. Where data is processed (international transfers)

The ClipLib sharing and diagnostics servers are operated by the developer. Depending on the
hosting provider, data may be processed on servers **[in/outside the EU — to be confirmed by
the operator]**. Where processing occurs outside the EU/EEA, we rely on appropriate
safeguards under GDPR (e.g. Standard Contractual Clauses). Contact us for details.

---

## 10. Your rights (GDPR)

Under the GDPR you have the right to:

- **access** your personal data,
- **rectify** inaccurate data,
- **erase** your data ("right to be forgotten"),
- **restrict** or **object** to processing,
- **data portability**,
- **withdraw consent** at any time (without affecting prior processing), and
- **lodge a complaint** with a supervisory authority (in Germany, your state Data Protection
  Authority).

To exercise any of these, email **fabiansilbermann1@gmail.com**. Note that most local data is
under your direct control and can be deleted by you at any time.

---

## 11. Security

- Your sharing access token is stored **encrypted** using your OS's secure storage (Windows
  DPAPI / keychain via Electron `safeStorage`).
- All network communication with our servers, GitHub, and Discord uses **encrypted HTTPS/TLS**.
- No method is perfectly secure, but we aim to minimise the data collected in the first place.

---

## 12. Children

ClipLib is not directed at children. You must be at least **16 years old** (the digital-consent
age under German GDPR) to use the sharing service. We do not knowingly collect data from
children below this age.

---

## 13. Changes to this policy

We may update this policy as the app evolves. Material changes will be reflected here with a
new "Last updated" date. Continued use after an update means you accept the revised policy.

---

## 14. Contact

Questions about this policy or your data:

**Email: fabiansilbermann1@gmail.com**

See also the [Terms of Service](TERMS.md).
