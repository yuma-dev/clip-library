import type { LiveExtension } from "../../../../types/clips";
import type { PreviewMoment } from "./RotatingPreview";

export type GameIcons = Map<string, { name: string; icon: string | null }>;

/** an extension's scenarios as preview moments; off, the plain card friends would see then */
export function extMoments(
  ext: LiveExtension,
  settings: Record<string, unknown>,
  icons: GameIcons,
  playtime: Record<string, unknown> | undefined,
  competing: boolean,
): PreviewMoment[] {
  const games = ext.game_ids.map((id) => icons.get(id)).filter((g): g is { name: string; icon: string | null } => Boolean(g));
  const icon = games.find((g) => g.icon)?.icon ?? null;
  if (settings.enabled === false) {
    return [{ key: "plain", label: "Plain card", reqs: [{ game: games[0]?.name ?? ext.name, icon: games[0]?.icon ?? null, playtime }] }];
  }
  return ext.scenarios.map((sc) => ({
    key: sc.key,
    label: sc.label,
    reqs: [{ id: ext.id, settings, icon, scenario: sc.key, playtime, competing }],
  }));
}
