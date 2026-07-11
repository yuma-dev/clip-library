import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  Cpu,
  Gauge,
  Mic,
  Plus,
  Scissors,
  Trash2,
  Users,
  Volume2,
} from "lucide-react";
import Toggle from "../ui/Toggle";
import Select from "../ui/Select";
import Slider from "../ui/Slider";
import { useSettings } from "../settings/SettingsContext";
import {
  ClipdipProvider,
  clipdipBridge,
  useClipdip,
  type AudioDeviceInfo,
} from "../settings/sections/clipdip/ClipdipContext";
import { HotkeyCapture } from "../settings/sections/clipdip/controls";
import bannerUrl from "../../../assets/onboarding/banner.png";
import overlayUrl from "../../../assets/onboarding/clipdip-overlay.webp";
import mixerUrl from "../../../assets/onboarding/mixer-showcase.png";
import pillsUrl from "../../../assets/onboarding/user-pills-showcase.png";

/**
 * One-time 3.0 introduction + ClipDip setup wizard. Shows once per
 * ONBOARDING_VERSION (persisted as settings.onboardingVersion), and can be
 * re-opened from the devtools console at any time:
 *
 *   __showOnboarding()   — open the wizard now
 *   __resetOnboarding()  — clear the seen-flag (shows again on next launch)
 */
export const ONBOARDING_VERSION = 3;

type StepId = "welcome" | "clipdip" | "audio" | "hotkeys" | "discord" | "done";

// ---------------------------------------------------------------------------
// Host: gating + console hooks. The heavy wizard body (and the clipdip
// status/config polling of ClipdipProvider) only mounts while open.
// ---------------------------------------------------------------------------

let externalShow: (() => void) | null = null;

export default function OnboardingWizard() {
  const { settings, ready, set } = useSettings();
  const [open, setOpen] = useState(false);
  const autoShown = useRef(false);

  // First-run gate: open once when settings arrive and the flag is behind.
  useEffect(() => {
    if (!ready || autoShown.current) return;
    if (Number(settings.onboardingVersion ?? 0) < ONBOARDING_VERSION) {
      autoShown.current = true;
      setOpen(true);
    }
  }, [ready, settings.onboardingVersion]);

  // Console hooks (kept in production on purpose — support/debug tool).
  useEffect(() => {
    externalShow = () => setOpen(true);
    const w = window as unknown as Record<string, unknown>;
    w.__showOnboarding = () => {
      externalShow?.();
      return "onboarding: opened";
    };
    w.__resetOnboarding = () => {
      void set("onboardingVersion", 0);
      return "onboarding: flag cleared, wizard will show on next launch";
    };
    return () => {
      externalShow = null;
    };
  }, [set]);

  const close = useCallback(
    (markSeen: boolean) => {
      setOpen(false);
      if (markSeen) void set("onboardingVersion", ONBOARDING_VERSION);
    },
    [set],
  );

  return createPortal(
    <AnimatePresence>
      {open ? (
        <ClipdipProvider active>
          <WizardShell onClose={close} />
        </ClipdipProvider>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Shell: backdrop, panel, step routing, footer navigation.
// ---------------------------------------------------------------------------

function WizardShell({ onClose }: { onClose: (markSeen: boolean) => void }) {
  const { settings, set } = useSettings();
  const { status, refreshStatus } = useClipdip();
  const unsupported = status?.supported === false;

  const steps = useMemo<StepId[]>(
    () =>
      unsupported
        ? ["welcome", "clipdip", "discord", "done"]
        : ["welcome", "clipdip", "audio", "hotkeys", "discord", "done"],
    [unsupported],
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const step = steps[Math.min(stepIndex, steps.length - 1)];

  // ClipDip is opt-out in 3.0: the wizard's pending toggles default ON and are
  // applied when the user advances past the ClipDip step (never on skip).
  const [pendingEnable, setPendingEnable] = useState(true);
  const [pendingAutostart, setPendingAutostart] = useState(true);
  const [busy, setBusy] = useState(false);

  const applyClipdip = useCallback(async () => {
    if (unsupported) return;
    setBusy(true);
    try {
      if (Boolean(settings.clipdip?.enabled) !== pendingEnable) {
        await set("clipdip.enabled", pendingEnable);
        await clipdipBridge().setEnabled(pendingEnable).catch(() => undefined);
      }
      if (Boolean(status?.autostart) !== pendingAutostart) {
        await clipdipBridge().setAutostart(pendingAutostart).catch(() => undefined);
      }
    } finally {
      setBusy(false);
      refreshStatus();
    }
  }, [unsupported, settings, pendingEnable, pendingAutostart, status, set, refreshStatus]);

  const goNext = useCallback(async () => {
    if (step === "clipdip") await applyClipdip();
    if (stepIndex >= steps.length - 1) {
      onClose(true);
      return;
    }
    setDirection(1);
    setStepIndex((i) => i + 1);
  }, [step, stepIndex, steps.length, applyClipdip, onClose]);

  const goBack = useCallback(() => {
    if (stepIndex === 0) return;
    setDirection(-1);
    setStepIndex((i) => i - 1);
  }, [stepIndex]);

  // Escape skips the tour (still marks it as seen — it shows only once).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const last = stepIndex === steps.length - 1;

  return (
    <motion.div
      className="ob-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <motion.section
        className="ob-panel"
        role="dialog"
        aria-modal="true"
        aria-label="What's new in ClipLib 3.0"
        initial={{ y: 26, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 16, opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <div className="ob-body">
          <AnimatePresence mode="popLayout" custom={direction} initial={false}>
            <motion.div
              key={step}
              className="ob-step"
              custom={direction}
              initial={{ opacity: 0, x: direction * 42 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -42 }}
              transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
            >
              {step === "welcome" ? <WelcomeStep /> : null}
              {step === "clipdip" ? (
                <ClipdipStep
                  unsupported={unsupported}
                  unsupportedReason={status?.unsupportedReason ?? null}
                  enable={pendingEnable}
                  autostart={pendingAutostart}
                  onEnable={setPendingEnable}
                  onAutostart={setPendingAutostart}
                />
              ) : null}
              {step === "audio" ? <AudioStep /> : null}
              {step === "hotkeys" ? <HotkeysStep /> : null}
              {step === "discord" ? <DiscordStep /> : null}
              {step === "done" ? <DoneStep /> : null}
            </motion.div>
          </AnimatePresence>
        </div>

        <footer className="ob-footer">
          {last ? (
            <span />
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => onClose(true)}>
              Skip tour
            </button>
          )}
          <div className="ob-dots" aria-hidden="true">
            {steps.map((id, i) => (
              <span key={id} className={`ob-dot${i === stepIndex ? " active" : ""}`} />
            ))}
          </div>
          <div className="ob-footer-nav">
            {stepIndex > 0 ? (
              <button type="button" className="btn" onClick={goBack} disabled={busy}>
                <ArrowLeft size={14} /> Back
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void goNext()}
              disabled={busy}
            >
              {last ? (
                <>
                  <Check size={14} /> Start clipping
                </>
              ) : (
                <>
                  Next <ArrowRight size={14} />
                </>
              )}
            </button>
          </div>
        </footer>
      </motion.section>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function WelcomeStep() {
  return (
    <div className="ob-welcome">
      <div className="ob-hero">
        <img src={bannerUrl} alt="ClipLib 3.0" draggable={false} />
      </div>
      <div className="ob-welcome-copy">
        <div className="ob-kicker">
          <span className="dia">◇</span> Welcome to 3.0
        </div>
        <h1 className="ob-title">Clips has a new Face</h1>
        <p className="ob-lede">
          With a new logo, new look, new name and a full rebuild under the hood, ClipLib has
          finally arrived in 2026. Here's what's new.
        </p>
        <ul className="ob-features">
          <li>
            <Gauge size={15} />
            <div>
              <strong>Fully new renderer</strong>
              <span>Rebuilt from scratch, everything feels instant now.</span>
            </div>
          </li>
          <li>
            <Scissors size={15} />
            <div>
              <strong>ClipDip clipping engine</strong>
              <span>A standalone, no bloat replacement for ShadowPlay/OBS</span>
            </div>
          </li>
          <li>
            <AudioLines size={15} />
            <div>
              <strong>Multi audio track</strong>
              <span>Game, mic and voice chat on separate tracks.</span>
            </div>
          </li>
          <li>
            <Users size={15} />
            <div>
              <strong>Discord call integration</strong>
              <span>ClipDip saves who was in the call.</span>
            </div>
          </li>
        </ul>
      </div>
    </div>
  );
}

function ClipdipStep({
  unsupported,
  unsupportedReason,
  enable,
  autostart,
  onEnable,
  onAutostart,
}: {
  unsupported: boolean;
  unsupportedReason: string | null;
  enable: boolean;
  autostart: boolean;
  onEnable: (v: boolean) => void;
  onAutostart: (v: boolean) => void;
}) {
  const { config, patch } = useClipdip();
  const replaySeconds = Number(config?.replay_seconds ?? 60);
  return (
    <div className="ob-split">
      <div className="ob-copy">
        <div className="ob-kicker">
          <span className="dia">◇</span> Meet ClipDip
        </div>
        <h1 className="ob-title">ClipLib can Clip now</h1>
        <p className="ob-lede">
          ClipDip sits in your tray and is ready to save the last {replaySeconds} seconds of your
          gameplay. Press the hotkey and the last moments land straight in your library. A long
          needed replacement to Shadowplay/OBS/Steelseries Moments. Currently only NVIDIA Cards
          supported, more to come.
        </p>
        {unsupported ? (
          <div className="ob-note error">
            {unsupportedReason ?? "This machine can't run ClipDip (it needs Windows and an NVIDIA GPU)."}{" "}
            Everything else in 3.0 still works, and clips from other recorders show up like they
            always did.
          </div>
        ) : (
          <div className="ob-rows">
            <div className="ob-row">
              <div className="ob-row-info">
                <div className="ob-row-title">Enable ClipDip</div>
                <div className="ob-row-desc">
                  On by default. Flip it off if you want to stick with your current recorder. You
                  can change your mind anytime in Settings.
                </div>
              </div>
              <Toggle checked={enable} onChange={onEnable} aria-label="Enable ClipDip" />
            </div>
            <div className="ob-row">
              <div className="ob-row-info">
                <div className="ob-row-title">Start with Windows</div>
                <div className="ob-row-desc">
                  Starts the recorder when you log in, so it's always ready.
                </div>
              </div>
              <Toggle
                checked={autostart && enable}
                onChange={onAutostart}
                disabled={!enable}
                aria-label="Start ClipDip with Windows"
              />
            </div>
            <div className="ob-row">
              <div className="ob-row-info">
                <div className="ob-row-title">Replay length</div>
                <div className="ob-row-desc">The longest clip you can save.</div>
              </div>
              <Slider
                value={replaySeconds}
                min={10}
                max={300}
                step={5}
                disabled={!config}
                onCommit={(v) => patch({ replay_seconds: v })}
                format={(v) => `${v} s`}
                aria-label="Replay length"
              />
            </div>
          </div>
        )}
      </div>
      <div className="ob-stage ob-stage-clipdip">
        <img src={overlayUrl} alt="ClipDip save notification" draggable={false} />
      </div>
    </div>
  );
}

// Compact audio-source editor — same config shape and bridge calls as
// Settings → ClipDip → Audio (ClipdipAudioSection), trimmed for the wizard.
type AudioSourceKind = "system_loopback" | "microphone" | "process_loopback";
interface AudioSource {
  kind: AudioSourceKind;
  device_id?: string;
}
const DEFAULT_DEVICE_VALUE = "__default__";
const DEFAULT_SOURCES: AudioSource[] = [{ kind: "system_loopback" }, { kind: "microphone" }];

function kindIcon(k: AudioSourceKind) {
  if (k === "microphone") return Mic;
  if (k === "process_loopback") return Cpu;
  return Volume2;
}

function deviceOptionsFor(kind: AudioSourceKind, devices: AudioDeviceInfo[]) {
  if (kind === "process_loopback") return [];
  const flow = kind === "microphone" ? "Capture" : "Render";
  const filtered = devices.filter((d) => d.flow === flow);
  const def = filtered.find((d) => d.is_default);
  return [
    {
      value: DEFAULT_DEVICE_VALUE,
      label: "System default",
      hint: def ? `Currently: ${def.friendly_name}` : "Follows Windows default",
    },
    ...filtered.map((d) => ({
      value: d.id,
      label: d.friendly_name,
      hint: d.is_default ? "Default" : undefined,
    })),
  ];
}

function AudioStep() {
  const { config, patch, devices, ensureDevices } = useClipdip();
  useEffect(() => ensureDevices(), [ensureDevices]);

  const loading = !config;
  const sources = (config?.audio?.sources as unknown as AudioSource[] | undefined) ?? DEFAULT_SOURCES;
  type ConfigSources = NonNullable<NonNullable<import("../../types/clips").ClipdipConfig["audio"]>["sources"]>;
  const setSources = (next: AudioSource[]) =>
    patch({ audio: { sources: next as unknown as ConfigSources } });

  const update = (idx: number, p: Partial<AudioSource>) =>
    setSources(sources.map((s, i) => (i === idx ? { ...s, ...p } : s)));

  return (
    <div className="ob-split">
      <div className="ob-copy">
        <div className="ob-kicker">
          <span className="dia">◇</span> Multi audio track
        </div>
        <h1 className="ob-title">Fix your audio after the fact</h1>
        <p className="ob-lede">
          Every source records to its own track. Mic too loud? Friend screaming? Pull that track
          down in the player, long after the clip was saved. These are the sources ClipDip will
          record:
        </p>
        <div className="ob-rows">
          {sources.map((src, i) => {
            const KindIcon = kindIcon(src.kind);
            return (
              <div key={i} className="ob-audio-source">
                <span className="ob-audio-icon">
                  <KindIcon size={13} />
                </span>
                <Select
                  value={src.kind}
                  disabled={loading}
                  onChange={(kind) =>
                    update(i, { kind: kind as AudioSourceKind, device_id: undefined })
                  }
                  options={[
                    { value: "system_loopback", label: "System output", hint: "Game audio, music, calls" },
                    { value: "microphone", label: "Microphone", hint: "Your voice" },
                    { value: "process_loopback", label: "Process loopback", hint: "One specific app" },
                  ]}
                  width={168}
                  aria-label={`Source ${i + 1} kind`}
                />
                {src.kind !== "process_loopback" ? (
                  <Select
                    value={src.device_id ?? DEFAULT_DEVICE_VALUE}
                    disabled={loading}
                    onChange={(v) =>
                      update(i, { device_id: v === DEFAULT_DEVICE_VALUE ? undefined : v })
                    }
                    options={deviceOptionsFor(src.kind, devices)}
                    width={212}
                    aria-label={`Source ${i + 1} device`}
                  />
                ) : (
                  <span className="ob-audio-note">Focused game window</span>
                )}
                <button
                  type="button"
                  className="ob-audio-remove"
                  title="Remove source"
                  disabled={loading || sources.length <= 1}
                  onClick={() => setSources(sources.filter((_, idx) => idx !== i))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          <div className="ob-audio-actions">
            <button
              type="button"
              className="btn"
              disabled={loading}
              onClick={() => setSources([...sources, { kind: "system_loopback" }])}
            >
              <Plus size={12} /> <Volume2 size={12} /> System output
            </button>
            <button
              type="button"
              className="btn"
              disabled={loading}
              onClick={() => setSources([...sources, { kind: "microphone" }])}
            >
              <Plus size={12} /> <Mic size={12} /> Microphone
            </button>
          </div>
        </div>
      </div>
      <div className="ob-stage ob-stage-mixer">
        <img src={mixerUrl} alt="The new audio mixer in the player" draggable={false} />
      </div>
    </div>
  );
}

const HOTKEYS = [
  ["save_clip", "Save clip", "Saves the replay buffer as a clip", "Ctrl+Alt+F10"],
  ["rename_clip", "Rename last clip", "Rename from the save notification", "Ctrl+F10"],
  ["toggle_recording", "Start/stop recording", "Manual recording, separate from the buffer", "Ctrl+Alt+F9"],
] as const;

function HotkeysStep() {
  const { config, patch } = useClipdip();
  const loading = !config;
  return (
    <div className="ob-copy ob-single">
      <div className="ob-kicker">
        <span className="dia">◇</span> Hotkeys
      </div>
      <h1 className="ob-title">The keys that save your clips</h1>
      <p className="ob-lede">
        These work globally, in any game. Click one to change it. Some games eat common combos
        before ClipDip gets to see them, so slightly unusual ones work best.
      </p>
      <div className="ob-rows">
        {HOTKEYS.map(([key, title, description, fallback]) => (
          <div key={key} className="ob-row">
            <div className="ob-row-info">
              <div className="ob-row-title">{title}</div>
              <div className="ob-row-desc">{description}</div>
            </div>
            <HotkeyCapture
              value={String(config?.hotkey?.[key] ?? fallback)}
              disabled={loading}
              onChange={(v) => patch({ hotkey: { [key]: v } })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// Live Discord link status via the clipdip control server. Read-only-ish:
// the one action we offer is re-asking Discord for authorization.
function DiscordSetup() {
  const { live, running } = useClipdip();
  const [asking, setAsking] = useState(false);
  const d = live?.discord ?? null;
  const state = !running ? "clipdip_off" : (d?.state ?? "connecting");

  const askAgain = async () => {
    setAsking(true);
    try {
      await clipdipBridge().discordConnect();
    } catch {
      /* status poll reflects the outcome */
    } finally {
      setAsking(false);
    }
  };

  const tone =
    state === "connected" ? "ok" : state === "needs_authorization" || state === "connecting" ? "wait" : "idle";
  const text =
    state === "clipdip_off"
      ? "ClipDip isn't running right now, so there's nothing to set up yet. It links up with Discord on its own once it's recording."
      : state === "connected"
        ? `Connected${d?.user ? ` as ${d.user}` : ""}. You're all set.`
        : state === "discord_not_running"
          ? "Discord doesn't seem to be open. Start it and ClipDip will find it."
          : state === "needs_authorization"
            ? "Discord is asking for permission. Check for a popup over in Discord."
            : state === "connecting"
              ? "Connecting to Discord..."
              : state === "disabled"
                ? "The Discord link is turned off in ClipDip's config."
                : (d?.message ?? "Couldn't talk to Discord. It usually sorts itself out on the next try.");
  const showButton = state === "needs_authorization" || state === "error" || state === "discord_not_running";

  return (
    <div className="ob-row ob-discord-status">
      <div className="ob-row-info">
        <div className="ob-row-title">
          <span className={`ob-status-dot ${tone}`} /> Discord link
        </div>
        <div className="ob-row-desc">{text}</div>
      </div>
      {showButton ? (
        <button type="button" className="btn" disabled={asking} onClick={() => void askAgain()}>
          {asking ? "Asking..." : "Try again"}
        </button>
      ) : null}
    </div>
  );
}

function DiscordStep() {
  return (
    <div className="ob-split">
      <div className="ob-copy">
        <div className="ob-kicker">
          <span className="dia">◇</span> Discord integration
        </div>
        <h1 className="ob-title">Your clips know who was there</h1>
        <p className="ob-lede">
          Save a clip while you're in a voice call and everyone in the channel gets tagged on it.
          Hover the avatars to see names, click one to jump to their shared clips.
        </p>
        <p className="ob-lede">
          Setup is a single popup: Discord asks for permission once, and after that it just works.
        </p>
        <div className="ob-rows">
          <DiscordSetup />
        </div>
      </div>
      <div className="ob-stage ob-stage-pills">
        <img src={pillsUrl} alt="Discord call participants shown on a clip" draggable={false} />
      </div>
    </div>
  );
}

function DoneStep() {
  return (
    <div className="ob-copy ob-single ob-done">
      <div className="ob-kicker">
        <span className="dia">◇</span> One more thing
      </div>
      <h1 className="ob-title">That's not all</h1>
      <p className="ob-lede">A couple more things landed in 3.0 that deserve a mention:</p>
      <div className="ob-cards">
        <div className="ob-card">
          <Users size={17} />
          <strong>Feed and profiles</strong>
          <span>
            Share clips with your friends in the new feed. Profiles, badges, invites, mentions,
            the whole thing.
          </span>
        </div>
        <div className="ob-card">
          <Gauge size={17} />
          <strong>Faster everywhere</strong>
          <span>
            Startup, scrolling, opening clips. The rewrite made all of it quicker, especially on
            big libraries.
          </span>
        </div>
      </div>
      <p className="ob-lede ob-outro">
        That's the tour. Everything you saw lives in Settings if you want to dig deeper. Have fun
        out there. <span className="dia">◇</span>
      </p>
    </div>
  );
}
