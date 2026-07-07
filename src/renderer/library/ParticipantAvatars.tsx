// Stacked Discord-call participant avatars in the top-left corner of a clip
// thumbnail — port of the ClipLib website's mention stack (ClipCard.tsx).
// Shows up to 4 humans (bots filtered out) plus a "+X" bubble, each with a
// hover profile popover. Identities render through the latest-known snapshot
// registry (discord.ts) so old clips pick up renamed users / new avatars.

import { memo, useEffect } from "react";
import UserPopover, { discordAvatarUrl } from "../ui/UserPopover";
import {
  participantDisplayName,
  registerParticipants,
  resolveLatest,
  useIdentityVersion,
  type ClipDiscordInfo,
} from "./discord";

const MAX_AVATARS = 4;

interface ParticipantAvatarsProps {
  discord: ClipDiscordInfo;
  /** Clip timestamp (ms) — decides which snapshot is "latest" per user. */
  clipCreatedAt: number;
}

function ParticipantAvatars({ discord, clipCreatedAt }: ParticipantAvatarsProps) {
  // Re-render when any clip contributes a fresher identity snapshot.
  useIdentityVersion();

  useEffect(() => {
    registerParticipants(discord, clipCreatedAt);
  }, [discord, clipCreatedAt]);

  const humans = discord.participants.filter((p) => !p.bot);
  if (humans.length === 0) return null;

  const shown = humans.slice(0, MAX_AVATARS);
  const extra = humans.length - shown.length;

  return (
    <div className="clip-participants" onClick={(e) => e.stopPropagation()}>
      {shown.map((p, i) => {
        const latest = resolveLatest(p);
        const name = participantDisplayName(latest);
        return (
          <UserPopover key={p.id} participant={latest}>
            <span className="clip-participant" style={{ zIndex: MAX_AVATARS - i }}>
              <img src={discordAvatarUrl(latest)} alt={name} draggable={false} loading="lazy" />
            </span>
          </UserPopover>
        );
      })}
      {extra > 0 ? <span className="clip-participants-more">+{extra}</span> : null}
    </div>
  );
}

export default memo(ParticipantAvatars);
