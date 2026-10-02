import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import logoUrl from "../../../../../assets/logo.png";
import type { DiscordActivity } from "../../../../types/clips";
import { useProfile } from "../../../shell/useProfile";

// asset keys (logo, art_*, badge_*) resolve through the app's public asset list, fetched once by main;
// the bundled logo covers the moment before it arrives
let assetUrls: Record<string, string> | null = null;
let assetLoad: Promise<void> | null = null;

function useAssets(): Record<string, string> | null {
  const [urls, setUrls] = useState(assetUrls);
  useEffect(() => {
    if (assetUrls) return;
    assetLoad ??= window.clips
      .getDiscordAssets()
      .then((m) => {
        assetUrls = m;
      })
      .catch(() => {});
    void assetLoad.then(() => setUrls(assetUrls));
  }, []);
  return urls;
}

const resolve = (key: string | undefined, urls: Record<string, string> | null): string | null =>
  key ? (/^https?:/.test(key) ? key : (urls?.[key] ?? logoUrl)) : null;

/** one moment of a preview rotation; `steps` > 1 changes something inside it (rotating facts) */
export interface Moment {
  key: string;
  label: string;
  steps: number;
}

/** a moment that changes nothing inside lasts this long */
export const MOMENT_MS = 4500;
/** each step of a moment that does, like a library fact */
export const STEP_MS = 1800;

const momentMs = (m: Moment | undefined, base = MOMENT_MS) => (m && m.steps > 1 ? m.steps * STEP_MS : base);

/** Walks the moments and the steps inside each. A pinned moment keeps stepping inside itself; hover
 * (`paused`) stops everything so tooltips can be read. */
export function useRotation(moments: Moment[], paused: boolean, base = MOMENT_MS) {
  const [pinned, setPinned] = useState<number | null>(null);
  const [at, setAt] = useState({ i: 0, step: 0 });
  const n = moments.length;
  const i = pinned !== null ? Math.min(pinned, Math.max(0, n - 1)) : n ? at.i % n : 0;
  const steps = moments[i]?.steps ?? 1;
  const stepping = steps > 1;

  useEffect(() => {
    if (paused || n === 0) return;
    if (pinned !== null && !stepping) return;
    if (pinned === null && n < 2 && !stepping) return;
    const t = setTimeout(
      () =>
        setAt((cur) => {
          const curI = pinned ?? cur.i % n;
          const next = cur.step + 1;
          if (next < steps) return { i: curI, step: next };
          return { i: pinned !== null ? curI : (curI + 1) % n, step: 0 };
        }),
      stepping ? STEP_MS : base,
    );
    return () => clearTimeout(t);
  }, [paused, pinned, n, steps, stepping, at, base]);

  const pick = (j: number) => {
    setPinned(j);
    setAt({ i: j, step: 0 });
  };
  const go = (d: number) => pick((((pinned ?? i) + d) % n + n) % n);
  return { index: i, step: at.step % steps, pinned, pick, go, unpin: () => setPinned(null) };
}

/** `‹ label · 3 of 8 ›`, the label opens the full list; the bar shows when the next moment comes */
export function MomentStepper({
  moments,
  index,
  pinned,
  paused,
  onPick,
  onGo,
  ms,
}: {
  moments: Moment[];
  index: number;
  pinned: boolean;
  paused: boolean;
  /** one moment's time when it doesn't step inside, MOMENT_MS unless the preview runs faster */
  ms?: number;
  onPick: (i: number) => void;
  onGo: (d: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  if (moments.length < 2) return null;
  const m = moments[index];
  return (
    <div className="dc-step" ref={ref}>
      <button type="button" className="dc-step-arrow" onClick={() => onGo(-1)} aria-label="Previous">
        <ChevronLeft size={14} />
      </button>
      <button type="button" className="dc-step-label" onClick={() => setOpen((v) => !v)}>
        <span>{m?.label}</span>
        <span className="dc-step-count">
          {index + 1} of {moments.length}
        </span>
        <ChevronDown size={12} />
      </button>
      <button type="button" className="dc-step-arrow" onClick={() => onGo(1)} aria-label="Next">
        <ChevronRight size={14} />
      </button>
      {pinned ? null : (
        <div className="dc-step-bar">
          <div
            key={`${index}-${m?.key}`}
            style={{ animationDuration: `${momentMs(m, ms)}ms`, animationPlayState: paused ? "paused" : "running" }}
          />
        </div>
      )}
      {open ? (
        <div className="dc-step-menu">
          {moments.map((mo, i) => (
            <button
              type="button"
              key={mo.key}
              className={i === index ? "on" : ""}
              onClick={() => {
                onPick(i);
                setOpen(false);
              }}
            >
              {mo.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Discord's dark tooltip; `truncated` only shows it when the text is cut off */
function Tip({ text, children, truncated }: { text?: string; children: ReactNode; truncated?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const show = () => {
    const el = ref.current;
    if (!el || !text) return;
    if (truncated && el.scrollWidth <= el.clientWidth) return;
    const r = el.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.top });
  };
  return (
    <div
      ref={ref}
      className={truncated ? "dc-tip-host dc-line" : "dc-tip-host"}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && text ? <TipBubble x={pos.x} y={pos.y} text={text} /> : null}
    </div>
  );
}

function TipBubble({ x, y, text }: { x: number; y: number; text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  // keep the bubble on screen near the window edge
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    if (r.right > window.innerWidth - 8) setShift(window.innerWidth - 8 - r.right);
    else if (r.left < 8) setShift(8 - r.left);
  }, [text]);
  return createPortal(
    <div ref={ref} className="dc-tip" style={{ left: x + shift, top: y }}>
      {text}
      <i style={{ marginLeft: -shift }} />
    </div>,
    document.body,
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const VERB: Record<number, string> = { 0: "Playing", 2: "Listening to", 3: "Watching", 5: "Competing in" };

/** one activity the way Discord draws it on a profile, hover texts included */
export function ActivityCard({ activity, type: fallbackType = 0 }: { activity: DiscordActivity; type?: number }) {
  const type = activity.type ?? fallbackType;
  const start = activity.timestamps?.start;
  const end = activity.timestamps?.end;
  const now = useNow(Boolean(start || end));
  const urls = useAssets();
  const large = resolve(activity.assets?.large_image, urls);
  // a picture that won't load shows as an empty tile, not a broken image
  const [broken, setBroken] = useState<string | null>(null);
  const small = resolve(activity.assets?.small_image, urls);
  const party = activity.party?.size;
  const watching = type === 3 && start && end && end > start;
  // a sample clip starts over instead of sitting at its end
  const watched = watching ? (now - start) % (end - start) : 0;
  const state = activity.state ? `${activity.state}${party ? ` (${party[0]} of ${party[1]})` : ""}` : "";

  return (
    <div className="dc-activity">
      <div className="dc-activity-head">{VERB[type] ?? "Playing"}</div>
      <div className="dc-activity-body">
        {large ? (
          <div className="dc-art">
            <Tip text={activity.assets?.large_text}>
              {broken === large ? (
                <div className="dc-art-large dc-art-missing" />
              ) : (
                <img className="dc-art-large" src={large} alt="" draggable={false} onError={() => setBroken(large)} />
              )}
            </Tip>
            {small ? (
              <div className="dc-art-small">
                <Tip text={activity.assets?.small_text}>
                  <img src={small} alt="" draggable={false} />
                </Tip>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="dc-lines">
          <Tip text={activity.name ?? "ClipLib"} truncated>
            <span className="dc-name">{activity.name ?? "ClipLib"}</span>
          </Tip>
          {activity.details ? (
            <Tip text={activity.details} truncated>
              {activity.details}
            </Tip>
          ) : null}
          {state ? (
            <Tip text={state} truncated>
              {state}
            </Tip>
          ) : null}
          {watching ? null : end && end > now ? (
            <div className="dc-time">{clock(end - now)} left</div>
          ) : start ? (
            <div className="dc-time">
              <span className="dc-time-dot" />
              {clock(now - start)}
            </div>
          ) : null}
        </div>
      </div>
      {watching ? (
        <div className="dc-progress">
          <span>{clock(watched)}</span>
          <div className="dc-progress-bar">
            <div style={{ width: `${(watched / (end - start)) * 100}%` }} />
          </div>
          <span>{clock(end - start)}</span>
        </div>
      ) : null}
      {activity.buttons?.length ? (
        <div className="dc-buttons">
          {activity.buttons.map((b) => (
            <Tip key={b.label} text="Only your friends see this button, Discord hides it on your own profile">
              <div className="dc-button">{b.label}</div>
            </Tip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** a small Discord profile popout around the card: your own avatar and name when ClipLib knows them */
export function ProfilePreview({
  activity,
  type = 0,
  loading,
  live,
}: {
  activity: DiscordActivity | null;
  type?: number;
  loading?: boolean;
  /** the card clipdip is sending right now, not a sample */
  live?: boolean;
}) {
  const profile = useProfile();
  const name = profile.connected && profile.username ? profile.username : "You";
  return (
    <div className={`dc-pop${loading ? " loading" : ""}`}>
      <div className="dc-banner">{live ? <span className="dc-live">Live</span> : null}</div>
      <div className="dc-avatar">
        {profile.avatarUrl ? <img src={profile.avatarUrl} alt="" draggable={false} /> : <span>{name[0]}</span>}
        <i className="dc-status" />
      </div>
      <div className="dc-user">{name}</div>
      <div className="dc-pop-body">
        {activity ? <ActivityCard activity={activity} type={type} /> : <div className="dc-empty">Nothing to show</div>}
      </div>
    </div>
  );
}
