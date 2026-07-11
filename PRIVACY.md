# Privacy Policy — ClipLib

**Last updated: 11 July 2026**

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

To find and fix bugs, ClipLib's recorder can send **anonymous** diagnostics to a
developer-operated server. This is designed to contain **no accounts and no personal
identifiers**.

- **What is sent automatically (if not disabled):**
  - a **heartbeat** roughly every 15 minutes containing a **random per-install ID** and the
    **app version**;
  - **error/crash events** containing that random ID, app version, a timestamp, an error
    code/message, and a **short compressed tail of the app log**.
- **Note on log contents:** log tails may **incidentally** contain things like file paths or
  a Windows username. We do not use these to identify you, but you should be aware they can
  appear in logs.
- **Opt-out:** you can disable diagnostics in the app's settings. If disabled, no heartbeat
  or events are sent.

**Manual, user-initiated uploads.** Two features only send data when **you** click them:

- **"Generate Diagnostics Zip"** (Settings → About) — creates a bundle of recent logs,
  settings, and system info for you to share with the developer. (Discord tokens are
  deliberately excluded.)
- **Session log upload** — sends your current log/console output to the diagnostics server
  when you choose to.

**Legal basis:** **legitimate interest** in keeping the software stable and secure —
Art. 6(1)(f) — balanced by the data being anonymous and the opt-out above. Manual uploads
rely on your **consent** (Art. 6(1)(a)).

---

## 7. Who receives data (recipients overview)

| Recipient | Purpose | What is sent | When |
|---|---|---|---|
| `friends.cliplib.app` (ClipLib Sharing, operated by us) | Accounts, clip sharing, social feed | Discord identity, uploaded video + title + tags + @mentions, banner, reactions/comments | Only after you sign in / share |
| `logs.yuma-homeserver.online` (Diagnostics, operated by us) | Crash/bug diagnostics | Random install ID, app version, error/crash events, log tails; manual bundles | Auto (opt-out) + manual |
| GitHub (`github.com`) | Update check & download | Generic User-Agent only | On update check/download |
| Discord (`discord.com`) | Login & voice-roster read | OAuth login; reads your live voice-channel membership | Only if you connect Discord |

Recording and video processing (ffmpeg/ffprobe) run **entirely on your device**.

---

## 8. Retention

- **Local data** stays until **you** delete it (your clips, sidecars, settings, logs).
- **Shared clips and account data** are kept while your account/shared clips exist. You can
  delete shared clips or ask us to delete your account and content — email us.
- **Diagnostics** are kept only as long as needed to investigate stability issues, then
  discarded.

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
