//! The local player's entry in /chat/v4/presences. Riot is moving the private
//! blob from a flat shape to one nested under match/party/player containers,
//! so every field is looked up in the containers first, then the top level.

use base64::Engine;
use serde_json::{Map, Value};

pub const PRODUCT: &str = "valorant";

/// premierPresenceData is left out on purpose, its keys are its own
const NESTED: [&str; 3] = [
    "matchPresenceData",
    "partyPresenceData",
    "playerPresenceData",
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Presence {
    pub session_loop_state: String,
    pub party_state: String,
    pub match_map: String,
    pub queue_id: String,
    pub provisioning_flow: String,
    pub score_ally: i64,
    pub score_enemy: i64,
    /// "Rounds", or "Points" in deathmatch modes
    pub game_score_type: String,
    pub party_size: i64,
    pub max_party_size: i64,
    pub competitive_tier: i64,
    pub is_idle: bool,
    /// unix ms; None for the year-one value an idle party sends
    pub queue_entry_ms: Option<i64>,
}

/// Our valorant entry out of a presences payload. The list holds every
/// friend, so None (nothing of ours yet) is the routine answer.
pub fn decode(payload: &[u8], puuid: &str) -> Option<Presence> {
    if payload.is_empty() || puuid.is_empty() {
        return None;
    }
    let envelope: Value = serde_json::from_slice(payload).ok()?;
    let entries = envelope.get("presences")?.as_array()?;
    for entry in entries {
        let str_of = |k: &str| entry.get(k).and_then(Value::as_str).unwrap_or("");
        if str_of("puuid") != puuid || !str_of("product").eq_ignore_ascii_case(PRODUCT) {
            continue;
        }
        // riot publishes our entry without a private blob on login and on going away
        let private = str_of("private");
        if private.is_empty() {
            continue;
        }
        // a malformed entry must not hide a good duplicate
        let Some(blob) = decode_base64(private) else {
            continue;
        };
        if let Some(p) = decode_private(&blob) {
            return Some(p);
        }
    }
    None
}

/// Riot pads the blob, an unpadded one is accepted too.
fn decode_base64(s: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
    STANDARD
        .decode(s)
        .or_else(|_| STANDARD_NO_PAD.decode(s))
        .ok()
}

pub fn decode_private(blob: &[u8]) -> Option<Presence> {
    let top: Map<String, Value> = serde_json::from_slice(blob).ok()?;
    let mut scopes: Vec<&Map<String, Value>> = NESTED
        .iter()
        .filter_map(|k| top.get(*k)?.as_object())
        .collect();
    scopes.push(&top);
    let f = Fields(scopes);
    Some(Presence {
        session_loop_state: f.str("sessionLoopState"),
        party_state: f.str("partyState"),
        match_map: f.str("matchMap"),
        queue_id: f.str("queueId"),
        provisioning_flow: f.str("provisioningFlow"),
        score_ally: f.num("partyOwnerMatchScoreAllyTeam"),
        score_enemy: f.num("partyOwnerMatchScoreEnemyTeam"),
        game_score_type: f.str("gameScoreType"),
        party_size: f.num("partySize"),
        max_party_size: f.num("maxPartySize"),
        competitive_tier: f.num("competitiveTier"),
        is_idle: f.raw("isIdle").and_then(Value::as_bool).unwrap_or(false),
        queue_entry_ms: parse_queue_time(&f.str("queueEntryTime")),
    })
}

/// The first scope carrying a key wins, even when its value has the wrong
/// type: a retyped field degrades to zero instead of failing the presence.
struct Fields<'a>(Vec<&'a Map<String, Value>>);

impl Fields<'_> {
    fn raw(&self, key: &str) -> Option<&Value> {
        self.0.iter().find_map(|s| s.get(key))
    }

    fn str(&self, key: &str) -> String {
        self.raw(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    /// integers today, but a 5.0 shouldn't wipe the field
    fn num(&self, key: &str) -> i64 {
        match self.raw(key) {
            Some(v) => v
                .as_i64()
                .or_else(|| v.as_f64().map(|f| f as i64))
                .unwrap_or(0),
            None => 0,
        }
    }
}

/// Riot's `2006.01.02-15.04.05`, always UTC.
pub fn parse_queue_time(s: &str) -> Option<i64> {
    let (date, time) = s.trim().split_once('-')?;
    let mut d = date.split('.').map(|p| p.parse::<i64>().ok());
    let (y, mo, da) = (d.next()??, d.next()??, d.next()??);
    let mut t = time.split('.').map(|p| p.parse::<i64>().ok());
    let (h, mi, se) = (t.next()??, t.next()??, t.next()??);
    if d.next().is_some() || t.next().is_some() {
        return None;
    }
    // idle players send 0001.01.01-00.00.00
    if y < 2000
        || !(1..=12).contains(&mo)
        || !(1..=31).contains(&da)
        || h > 23
        || mi > 59
        || se > 60
    {
        return None;
    }
    Some(((days_from_civil(y, mo, da) * 24 + h) * 60 + mi) * 60_000 + se * 1000)
}

/// days since 1970-01-01, Howard Hinnant's civil algorithm
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const FLAT: &str = include_str!("testdata/private_flat.json");
    const NESTED_BLOB: &str = include_str!("testdata/private_nested.json");
    const LEAGUE: &str = include_str!("testdata/private_league.json");

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    fn payload(entries: &[(&str, &str, &str)]) -> Vec<u8> {
        let list: Vec<_> = entries
            .iter()
            .map(|(puuid, product, private)| {
                serde_json::json!({ "puuid": puuid, "product": product, "game_name": "x", "private": private })
            })
            .collect();
        serde_json::to_vec(&serde_json::json!({ "presences": list })).unwrap()
    }

    fn want() -> Presence {
        Presence {
            session_loop_state: "INGAME".into(),
            party_state: "DEFAULT".into(),
            match_map: "/Game/Maps/Ascent/Ascent".into(),
            queue_id: "competitive".into(),
            provisioning_flow: "Matchmaking".into(),
            score_ally: 9,
            score_enemy: 4,
            game_score_type: "Rounds".into(),
            party_size: 2,
            max_party_size: 5,
            competitive_tier: 21,
            is_idle: false,
            queue_entry_ms: Some(1_789_828_327_000),
        }
    }

    #[test]
    fn both_shapes_decode_the_same() {
        for blob in [FLAT, NESTED_BLOB] {
            let p = decode(&payload(&[(ME, "valorant", &b64(blob))]), ME).unwrap();
            assert_eq!(p, want());
        }
    }

    #[test]
    fn skips_friends_other_products_and_empty_blobs() {
        let other = "11111111-2222-3333-4444-555555555555";
        let body = payload(&[
            (other, "valorant", &b64(FLAT)),
            (ME, "league_of_legends", &b64(LEAGUE)),
            (ME, "VALORANT", ""),
        ]);
        assert_eq!(decode(&body, ME), None);
        let body = payload(&[
            (other, "valorant", &b64(FLAT)),
            (ME, "Valorant", &b64(NESTED_BLOB)),
        ]);
        assert_eq!(decode(&body, ME), Some(want()));
    }

    #[test]
    fn keeps_looking_past_a_malformed_entry() {
        let body = payload(&[
            (ME, "valorant", "!!!"),
            (ME, "valorant", &b64("{\"oops")),
            (ME, "valorant", &b64(FLAT)),
        ]);
        assert_eq!(decode(&body, ME), Some(want()));
        assert_eq!(decode(b"not json", ME), None);
        assert_eq!(decode(b"{\"presences\":[]}", ME), None);
        assert_eq!(decode(b"", ME), None);
    }

    #[test]
    fn unpadded_base64_decodes() {
        let blob = r#"{"sessionLoopState":"MENUS"}"#;
        let raw = base64::engine::general_purpose::STANDARD_NO_PAD.encode(blob);
        let p = decode(&payload(&[(ME, "valorant", &raw)]), ME).unwrap();
        assert_eq!(p.session_loop_state, "MENUS");
    }

    #[test]
    fn mistyped_fields_degrade_to_zero() {
        let p = decode_private(br#"{"sessionLoopState":"MENUS","partySize":"two","queueEntryTime":"whenever","maxPartySize":5.0}"#)
            .unwrap();
        assert_eq!(p.session_loop_state, "MENUS");
        assert_eq!(p.party_size, 0);
        assert_eq!(p.max_party_size, 5);
        assert_eq!(p.queue_entry_ms, None);
    }

    #[test]
    fn nested_container_wins_over_top_level() {
        let p = decode_private(br#"{"partySize":1,"partyPresenceData":{"partySize":3}}"#).unwrap();
        assert_eq!(p.party_size, 3);
    }

    #[test]
    fn queue_time() {
        assert_eq!(
            parse_queue_time("2026.09.19-14.32.07"),
            Some(1_789_828_327_000)
        );
        assert_eq!(parse_queue_time("1970.01.01-00.00.00"), None);
        assert_eq!(parse_queue_time("0001.01.01-00.00.00"), None);
        assert_eq!(parse_queue_time(""), None);
        assert_eq!(parse_queue_time("2026.02.30"), None);
    }
}
