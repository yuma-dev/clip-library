// how the games list groups extensions; an id missing here lands in "More games"
export const GENRES: { name: string; ids: string[] }[] = [
  { name: "Shooters", ids: ["valorant", "cs2", "deadlock", "tf2", "fortnite", "battlefield", "tarkov"] },
  { name: "MOBA", ids: ["league", "dota2"] },
  { name: "Cards and roguelikes", ids: ["balatro", "slay_the_spire_2", "hearthstone", "runeterra"] },
  {
    name: "Racing",
    ids: ["forza", "forza_motorsport", "iracing", "assetto_corsa", "le_mans_ultimate", "raceroom", "f1", "ea_wrc"],
  },
  { name: "Flight and space", ids: ["msfs", "x_plane", "war_thunder", "elite_dangerous", "star_citizen"] },
  {
    name: "Survival and co-op",
    ids: ["abiotic_factor", "rv_there_yet", "subnautica_2", "satisfactory", "valheim", "peak", "repo", "phasmophobia"],
  },
  { name: "Sandbox", ids: ["minecraft", "roblox", "hytale"] },
  { name: "Online RPGs", ids: ["path_of_exile", "warframe", "guild_wars_2"] },
  { name: "Sports and party", ids: ["rocket_league", "fall_guys", "golf_it"] },
];

export const OTHER_GENRE = "More games";

export function genreOf(id: string): string {
  return GENRES.find((g) => g.ids.includes(id))?.name ?? OTHER_GENRE;
}
