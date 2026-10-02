import { useEffect, useState } from "react";
import type { DiscordActivity } from "../../../../types/clips";
import { MomentStepper, ProfilePreview, useRotation } from "./DiscordCard";
import { prefetchPreviews, useCardPreview } from "./useDiscordSettings";

type Req = Parameters<typeof window.clips.clipdip.livePreview>[0];

/** One moment of the preview. Its steps are either clipdip requests (a game card) or ready cards
 * (the library builds its own); `live` is the card being sent right now. */
export interface PreviewMoment {
  key: string;
  label: string;
  reqs?: Req[];
  cards?: DiscordActivity[];
  live?: DiscordActivity;
  /** 3 for Watching */
  type?: number;
}

// a hovered game plays through its scenarios faster than the idle rotation
const FAST_MS = 2200;
// the preview remounts for every game; the last card it showed stays up until the next one is in
let lastShown: DiscordActivity | null = null;

export default function RotatingPreview({
  moments,
  off,
  fast,
  pick,
}: {
  moments: PreviewMoment[];
  off?: boolean;
  fast?: boolean;
  /** jumps to and holds a moment by key, a new nonce jumps again */
  pick?: { key: string; nonce: number } | null;
}) {
  const [hover, setHover] = useState(false);
  const steps = moments.map((m) => ({ key: m.key, label: m.label, steps: m.reqs?.length ?? m.cards?.length ?? 1 }));
  const rot = useRotation(steps, hover, fast ? FAST_MS : undefined);
  const pickIndex = pick ? moments.findIndex((m) => m.key === pick.key) : -1;
  useEffect(() => {
    if (pickIndex >= 0) rot.pick(pickIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick?.nonce, pickIndex]);
  const m = moments[rot.index];
  const req = m?.reqs?.[rot.step] ?? null;
  const fetched = useCardPreview(req);

  const allReqs = JSON.stringify(moments.flatMap((x) => x.reqs ?? []));
  useEffect(() => {
    prefetchPreviews(JSON.parse(allReqs) as Req[]);
  }, [allReqs]);

  const card = m?.live ?? m?.cards?.[rot.step] ?? (req ? fetched.activity : null) ?? lastShown;
  if (card) lastShown = card;
  return (
    <>
      <div
        className={`dset-preview-wrap${off ? " off" : ""}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <ProfilePreview activity={card} type={m?.type ?? 0} loading={Boolean(req) && fetched.loading} live={Boolean(m?.live)} />
        {off ? <div className="dset-off-note">Off, Discord shows nothing from ClipLib here</div> : null}
      </div>
      <MomentStepper
        moments={steps}
        index={rot.index}
        pinned={rot.pinned !== null}
        paused={hover}
        onPick={rot.pick}
        onGo={rot.go}
        ms={fast ? FAST_MS : undefined}
      />
    </>
  );
}
