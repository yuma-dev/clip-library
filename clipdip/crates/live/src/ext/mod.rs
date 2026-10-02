//! One module per game. Each exports `MANIFEST`; order here is the order in
//! ClipLib's settings.

pub mod abiotic_factor;
pub mod assetto_corsa;
pub mod balatro;
pub mod battlefield;
pub mod cs2;
pub mod deadlock;
pub mod dota2;
pub mod ea_wrc;
pub mod elite_dangerous;
pub mod f1;
pub mod fall_guys;
pub mod fortnite;
pub mod forza;
pub mod forza_motorsport;
pub mod golf_it;
pub mod guild_wars_2;
pub mod hearthstone;
pub mod hytale;
pub mod iracing;
pub mod le_mans_ultimate;
pub mod league;
pub mod minecraft;
pub mod msfs;
pub mod path_of_exile;
pub mod peak;
pub mod phasmophobia;
pub mod raceroom;
pub mod repo;
pub mod roblox;
pub mod rocket_league;
pub mod runeterra;
pub mod rv_there_yet;
pub mod satisfactory;
pub mod slay_the_spire_2;
pub mod star_citizen;
pub mod steam;
pub mod subnautica_2;
pub mod tarkov;
pub mod tf2;
pub mod unreal;
pub mod valheim;
pub mod valorant;
pub mod war_thunder;
pub mod warframe;
pub mod x_plane;

use crate::Manifest;

pub static ALL: &[&Manifest] = &[
    &league::MANIFEST,
    &valorant::MANIFEST,
    &cs2::MANIFEST,
    &dota2::MANIFEST,
    &rocket_league::MANIFEST,
    &forza::MANIFEST,
    &minecraft::MANIFEST,
    &steam::MANIFEST,
    &deadlock::MANIFEST,
    &tf2::MANIFEST,
    &balatro::MANIFEST,
    &golf_it::MANIFEST,
    &abiotic_factor::MANIFEST,
    &rv_there_yet::MANIFEST,
    &subnautica_2::MANIFEST,
    &satisfactory::MANIFEST,
    &fortnite::MANIFEST,
    &repo::MANIFEST,
    &peak::MANIFEST,
    &valheim::MANIFEST,
    &slay_the_spire_2::MANIFEST,
    &phasmophobia::MANIFEST,
    &fall_guys::MANIFEST,
    &roblox::MANIFEST,
    &hytale::MANIFEST,
    &path_of_exile::MANIFEST,
    &warframe::MANIFEST,
    &iracing::MANIFEST,
    &assetto_corsa::MANIFEST,
    &le_mans_ultimate::MANIFEST,
    &raceroom::MANIFEST,
    &f1::MANIFEST,
    &forza_motorsport::MANIFEST,
    &ea_wrc::MANIFEST,
    &war_thunder::MANIFEST,
    &x_plane::MANIFEST,
    &msfs::MANIFEST,
    &elite_dangerous::MANIFEST,
    &star_citizen::MANIFEST,
    &battlefield::MANIFEST,
    &tarkov::MANIFEST,
    &hearthstone::MANIFEST,
    &guild_wars_2::MANIFEST,
    &runeterra::MANIFEST,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_banners_use_the_current_tag() {
        let tag = format!("cliplib-rpc-assets@{}/", crate::util::art::TAG);
        for m in ALL {
            if let Some(art) = m.art.filter(|a| a.contains("cliplib-rpc-assets")) {
                assert!(art.contains(&tag), "{}: {art}", m.id);
            }
        }
    }

    #[test]
    fn ids_are_unique_and_options_sane() {
        let mut ids: Vec<_> = ALL.iter().map(|m| m.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), ALL.len());
        for m in ALL {
            assert!(!m.credits.is_empty(), "{} needs a credit", m.id);
            for o in m.options {
                assert_ne!(o.key, "enabled", "{}: `enabled` is reserved", m.id);
                if let crate::OptKind::Choice { default, choices } = &o.kind {
                    assert!(
                        choices.iter().any(|(v, _)| v == default),
                        "{}.{}",
                        m.id,
                        o.key
                    );
                }
            }
        }
    }
}
