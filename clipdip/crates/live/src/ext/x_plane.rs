//! Aircraft and flight phase from Laminar Research's Web API (docs),
//! https://developer.x-plane.com/article/x-plane-web-api/: REST datarefs and values

use crate::util::{self, art, clamp};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use base64::Engine;
use serde_json::Value;
use std::time::Duration;

pub static MANIFEST: Manifest = Manifest {
    id: "x_plane",
    name: "X-Plane 12",
    blurb: "Aircraft, flight phase, altitude and ground speed.",
    setup: Some("Use X-Plane 12.4 or newer with the default web server port 8086. Allow incoming traffic in Settings > Network."),
    credits: &[Credit { project: "X-Plane Web API", author: "Laminar Research", url: "https://developer.x-plane.com/article/x-plane-web-api/", license: "docs" }],
    options: &[Opt::toggle("show_telemetry", "Show flight data", "Altitude and ground speed.", true)],
    matches,
    run,
    priority: 10,
    game_ids: &["1440129865465729217"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/2014780/header.jpg"),
    preview,
    scenarios: &[("parked", "Parked"), ("taxi", "Taxiing"), ("flight", "In flight")],
    steam_game: true,
    listed: true,
};

const BASE: &str = "http://127.0.0.1:8086/api/v3";
const REFS: [&str; 4] = [
    "sim/aircraft/view/acf_ui_name",
    "sim/flightmodel/position/elevation",
    "sim/flightmodel/failures/onground_any",
    "sim/flightmodel/position/groundspeed",
];

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || t.game_id == "steam:2014780"
        || util::exe_name(t) == "x-plane.exe"
}

struct Flight {
    aircraft: String,
    altitude_m: f64,
    on_ground: bool,
    speed_mps: f64,
}

fn parse(values: &[Value; 4]) -> Option<Flight> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(values.first()?.get("data")?.as_str()?)
        .ok()?;
    let aircraft = std::str::from_utf8(&bytes).ok()?.split('\0').next()?.trim();
    if aircraft.is_empty() || aircraft.len() > 250 || aircraft.chars().any(char::is_control) {
        return None;
    }
    let altitude_m = values.get(1)?.get("data")?.as_f64()?;
    let ground = values.get(2)?.get("data")?.as_i64()?;
    let speed_mps = values.get(3)?.get("data")?.as_f64()?;
    if !altitude_m.is_finite()
        || !speed_mps.is_finite()
        || !(0.0..=3000.0).contains(&speed_mps)
        || ![0, 1].contains(&ground)
    {
        return None;
    }
    Some(Flight {
        aircraft: aircraft.into(),
        altitude_m,
        on_ground: ground == 1,
        speed_mps,
    })
}

fn build(f: &Flight, s: &Settings) -> Live {
    let phase = if !f.on_ground {
        "In flight"
    } else if f.speed_mps > 1.0 {
        "Taxiing"
    } else {
        "Parked"
    };
    Live {
        details: clamp(format!("{phase} - {}", f.aircraft)),
        state: if s.flag("show_telemetry") {
            clamp(format!(
                "{:.0} ft, {:.0} kt ground speed",
                (f.altitude_m * 3.28084 / 100.0).round() * 100.0,
                f.speed_mps * 1.94384
            ))
        } else {
            None
        },
        large_image: Some(art::steam_header("2014780")),
        large_text: clamp(f.aircraft.clone()),
        ..Live::default()
    }
}

fn resolve(agent: &ureq::Agent) -> Option<[u64; 4]> {
    let mut ids = [0; 4];
    for (slot, name) in ids.iter_mut().zip(REFS) {
        let v: Value = agent
            .get(&format!("{BASE}/datarefs"))
            .query("filter[name]", name)
            .call()
            .ok()?
            .into_json()
            .ok()?;
        *slot = v
            .get("data")?
            .as_array()?
            .iter()
            .find(|v| v.get("name").and_then(Value::as_str) == Some(name))?
            .get("id")?
            .as_u64()?;
    }
    Some(ids)
}

fn poll(agent: &ureq::Agent, ids: &[u64; 4]) -> Option<Flight> {
    let mut values: [Value; 4] = std::array::from_fn(|_| Value::Null);
    for (slot, id) in values.iter_mut().zip(ids) {
        *slot = util::http::get_json(agent, &format!("{BASE}/datarefs/{id}/value"))?;
    }
    parse(&values)
}

fn run(ctx: &Ctx) {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(500))
        .timeout(Duration::from_secs(1))
        .build();
    let mut ids = None;
    loop {
        if ids.is_none() {
            ids = resolve(&agent);
        }
        let f = ids.as_ref().and_then(|ids| poll(&agent, ids));
        let wait = if f.is_some() {
            5
        } else {
            ids = None;
            12
        };
        ctx.emit(f.as_ref().map(|f| build(f, ctx.settings())));
        if !ctx.sleep(Duration::from_secs(wait)) {
            return;
        }
    }
}

fn preview(s: &Settings, key: &str) -> Preview {
    let f = Flight {
        aircraft: "Cessna Skyhawk".into(),
        altitude_m: if key == "flight" { 1524.0 } else { 100.0 },
        on_ground: key != "flight",
        speed_mps: match key {
            "flight" => 60.0,
            "taxi" => 5.0,
            _ => 0.0,
        },
    };
    Preview {
        game: MANIFEST.name,
        icon: None,
        live: build(&f, s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn payloads_and_units() {
        let values = [
            json!({"data":"Q2Vzc25hIFNreWhhd2sA"}),
            json!({"data":1524.0}),
            json!({"data":0}),
            json!({"data":60.0}),
        ];
        let f = parse(&values).unwrap();
        let live = build(&f, &Settings::new(&MANIFEST, json!({})));
        assert_eq!(live.details.as_deref(), Some("In flight - Cessna Skyhawk"));
        assert_eq!(live.state.as_deref(), Some("5000 ft, 117 kt ground speed"));
        let mut bad = values.clone();
        bad[0] = json!({"data":"not base64!"});
        assert!(parse(&bad).is_none());
        bad[0] = values[0].clone();
        bad[2] = json!({"data":7});
        assert!(parse(&bad).is_none());
    }
    #[test]
    fn scenarios_and_option() {
        let s = Settings::new(&MANIFEST, json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&s, key).live.is_empty());
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "parked").live);
        assert_ne!(
            preview(&s, "flight").live,
            preview(
                &Settings::new(&MANIFEST, json!({"show_telemetry":false})),
                "flight"
            )
            .live
        );
    }
}
