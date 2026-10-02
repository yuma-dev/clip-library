//! Modpack, version and loader, and where the player is (singleplayer, LAN,
//! Realms, a server with its icon and player count). Ported from CraftPresence
//! by CDAGaming (MIT), https://gitlab.com/CDAGaming/CraftPresence:
//! core/integrations/pack/*/*Utils.java for the pack lookups, core/config
//! defaults for what the card says; and craftping by kiwiyou (MIT),
//! https://github.com/kiwiyou/craftping: src/lib.rs + src/sync.rs for the ping.

mod launchers;
mod log;
mod modrinth;
mod ping;

use std::net::IpAddr;
use std::path::Path;
use std::time::{Duration, Instant};

use crate::util::{self, process};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

use launchers::{Instance, Launcher};
use log::{Event, Mode};

const MINECRAFT: &str = "1402418491272986635";
const TICK: Duration = Duration::from_secs(5);
const IDLE_TICK: Duration = Duration::from_secs(15);
/// CraftPresence pings every 5 min; player counts move faster than that
const PING_EVERY: Duration = Duration::from_secs(120);
/// the Modrinth app writes its processes row right after spawning java
const DB_RETRY: Duration = Duration::from_secs(30);
const DB_TRIES: u32 = 6;
const DEFAULT_PORT: u16 = 25565;

pub static MANIFEST: Manifest = Manifest {
    id: "minecraft",
    name: "Minecraft",
    blurb: "Shows your modpack, version and loader, and the server you're on with its player count.",
    setup: None,
    credits: &[
        Credit {
            project: "CraftPresence",
            author: "CDAGaming",
            url: "https://gitlab.com/CDAGaming/CraftPresence",
            license: "MIT",
        },
        Credit {
            project: "craftping",
            author: "kiwiyou",
            url: "https://github.com/kiwiyou/craftping",
            license: "MIT",
        },
    ],
    options: &[
        Opt::toggle("show_pack", "Show modpack", "Published packs from Modrinth, CurseForge, Technic and others.", true),
        Opt::toggle("show_instance_name", "Show your own instance names", "Names you gave an instance yourself.", false),
        Opt::toggle("show_version", "Show version and loader", "Like \"1.21.4 Fabric\".", true),
        Opt::toggle(
            "show_server",
            "Show server address",
            "Public servers only. LAN, local and IP addresses are never shown.",
            true,
        ),
        Opt::toggle("show_players", "Show player count", "Asks the server every 2 minutes.", true),
        Opt::choice(
            "image",
            "Big picture",
            "What replaces the Minecraft art.",
            "auto",
            &[
                ("auto", "Server icon on a server, else modpack icon"),
                ("pack", "Modpack icon"),
                ("game", "Keep the Minecraft art"),
            ],
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &[MINECRAFT],
    // Microsoft Store key art of Minecraft: Java & Bedrock Edition for PC (9NXP44L49SHJ)
    art: Some("https://store-images.s-microsoft.com/image/apps.58378.14492077886571533.338a563a-86e7-47b1-b9dc-41cf411f5dcd.dc840f22-6e8f-4a59-b7bc-57958a0740fd?w=1280"),
    preview,
    scenarios: &[
        ("menu", "Main menu"),
        ("single", "Singleplayer"),
        ("own", "Own instance"),
        ("lan", "LAN world"),
        ("server", "Modpack on a server"),
        ("vanilla", "Vanilla server"),
        ("private", "Private server"),
        ("realms", "Realms"),
    ],
    steam_game: false,
    listed: true,
};

/// Discord's own icon for the Minecraft app
const ICON: &str = "https://cdn.discordapp.com/app-icons/1402418491272986635/166fbad351ecdd02d11a3b464748f66b.png?size=256";

/// Sample sessions through the same `build` as the live card. Pack art and
/// server icons are real (Modrinth, CurseForge, mcsrvstat.us).
fn preview(s: &Settings, scenario: &str) -> Preview {
    let pack = |name: &str, icon: &str, version: &str, loader: &str| Pack {
        name: Some(name.into()),
        icon: Some(icon.into()),
        version: Some(version.into()),
        loader: Some(loader.into()),
        ..Default::default()
    };
    let vanilla = Pack {
        version: Some("1.21.4".into()),
        ..Default::default()
    };
    let fo = Pack {
        own: Some("My survival".into()),
        ..pack(
            "Fabulously Optimized",
            "https://cdn.modrinth.com/data/1KVo5zza/d8152911f8fd5d7e9a8c499fe89045af81fe816e_96.webp",
            "1.21.4",
            "Fabric",
        )
    };
    let server = |h: &str| Where::Server(h.into(), DEFAULT_PORT);
    let (pack, place, players) = match scenario {
        "single" => (vanilla, Where::Single, None),
        "own" => (
            Pack {
                own: Some("Bob's Create world".into()),
                version: Some("1.20.1".into()),
                loader: Some("Forge".into()),
                ..Default::default()
            },
            Where::Single,
            None,
        ),
        "lan" => (
            pack(
                "Cobblemon Official Modpack [Fabric]",
                "https://cdn.modrinth.com/data/5FFgwNNP/e7f9ee2e9d361623847853fe2ddce42f519ee64f.png",
                "1.21.1",
                "Fabric",
            ),
            Where::Lan,
            None,
        ),
        "server" => (fo, server("hypixel.net"), Some([31245, 200000])),
        "vanilla" => (vanilla, server("play.cubecraft.net"), Some([1117, 5000])),
        "private" => (
            pack(
                "All the Mods 10: To the Sky",
                "https://media.forgecdn.net/avatars/thumbnails/1389/739/256/256/638901033593272382.png",
                "1.21.1",
                "NeoForge",
            ),
            server("192.168.1.20"),
            Some([4, 20]),
        ),
        "realms" => (vanilla, Where::Realms, None),
        _ => (fo, Where::Menu, None),
    };
    let live = build(&pack, Some(&place), players, &Opts::from(s)).unwrap_or_default();
    Preview {
        game: "Minecraft",
        icon: Some(ICON),
        live,
    }
}

fn matches(t: &Target) -> bool {
    t.game_id == MINECRAFT
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Pack {
    /// published pack
    name: Option<String>,
    /// instance or profile name the user typed
    own: Option<String>,
    icon: Option<String>,
    version: Option<String>,
    loader: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
enum Where {
    Menu,
    Single,
    Lan,
    Realms,
    Server(String, u16),
    /// in a world, but which kind is unknown
    World,
}

struct Opts {
    pack: bool,
    own: bool,
    version: bool,
    server: bool,
    players: bool,
    image: String,
}

impl From<&Settings> for Opts {
    fn from(s: &Settings) -> Self {
        Opts {
            pack: s.flag("show_pack"),
            own: s.flag("show_instance_name"),
            version: s.flag("show_version"),
            server: s.flag("show_server"),
            players: s.flag("show_players"),
            image: s.choice("image"),
        }
    }
}

fn run(ctx: &Ctx) {
    let target = ctx.target().clone();
    let args = process::command_line(target.pid)
        .map(|c| process::split_args(&c))
        .unwrap_or_default();
    let mut inst = detect(&args, target.pid);
    let mut db_tries = 0;
    let mut db_next = Instant::now() + DB_RETRY;
    let mut pack = resolve_pack(&inst, ctx.cache_dir().as_deref());

    let mut tail = inst
        .game_dir
        .as_ref()
        .map(|d| log::Tail::new(d.join("logs").join("latest.log")));
    let mut from_log: Option<Where> = None;
    let mut seen_mode = false;
    let mut ping_for: Option<(String, u16)> = None;
    let mut ping_at = Instant::now();
    let mut players: Option<[u32; 2]> = None;

    loop {
        // the Modrinth row can land a moment after the game starts
        if inst.launcher == Launcher::Modrinth
            && pack.name.is_none()
            && pack.own.is_none()
            && db_tries < DB_TRIES
            && Instant::now() >= db_next
        {
            db_tries += 1;
            db_next = Instant::now() + DB_RETRY;
            modrinth_db(&mut inst, target.pid);
            pack = resolve_pack(&inst, ctx.cache_dir().as_deref());
        }

        if let Some(t) = tail.as_mut() {
            t.poll(|e| {
                from_log = Some(match e {
                    Event::Server(h, p) => Where::Server(h, p),
                    Event::Single => Where::Single,
                    Event::Lan => Where::Lan,
                    Event::Left => Where::Menu,
                })
            });
        }
        let title = log::window_title(target.pid).and_then(|t| log::parse_title(&t));
        if title.as_ref().is_some_and(|t| t.mode.is_some()) {
            seen_mode = true;
        }
        let place = place(title.as_ref(), seen_mode, from_log.as_ref());

        let mut shown = pack.clone();
        if shown.version.is_none() {
            shown.version = title.as_ref().and_then(|t| t.version.clone());
        }

        let opts = Opts::from(ctx.settings());

        if let (Some(Where::Server(h, p)), true) = (&place, opts.players) {
            let key = (h.clone(), *p);
            if ping_for.as_ref() != Some(&key) || ping_at.elapsed() >= PING_EVERY {
                players = ping::players(h, *p);
                ping_for = Some(key);
                ping_at = Instant::now();
            }
        } else {
            ping_for = None;
            players = None;
        }

        let live = build(&shown, place.as_ref(), players, &opts);
        let idle = live.is_none();
        ctx.emit(live);
        if !ctx.sleep(if idle { IDLE_TICK } else { TICK }) {
            return;
        }
    }
}

/// Command line, then launcher files, once per session.
fn detect(args: &[String], pid: u32) -> Instance {
    let mut inst = launchers::from_args(args);
    match inst.launcher {
        Launcher::Prism | Launcher::MultiMc => launchers::prism(&mut inst, args),
        Launcher::Modrinth => modrinth_db(&mut inst, pid),
        _ => {}
    }
    launchers::pack_files(&mut inst);
    if inst.pack.is_none()
        && inst.name.is_none()
        && matches!(inst.launcher, Launcher::Official | Launcher::Other)
    {
        launchers::official(&mut inst, args);
    }
    inst
}

fn modrinth_db(inst: &mut Instance, pid: u32) {
    let dir_name = inst
        .game_dir
        .as_deref()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned());
    let found = modrinth::db_paths(inst.game_dir.as_deref())
        .iter()
        .find_map(|db| modrinth::lookup(db, pid, dir_name.as_deref()));
    let Some(f) = found else { return };
    inst.name = Some(f.name)
        .filter(|n| !n.trim().is_empty())
        .or(inst.name.take());
    inst.modrinth_project = f.project.or(inst.modrinth_project.take());
    if let Some(v) = f.version {
        inst.version = Some(v);
    }
    if let Some(l) = f.loader.as_deref().and_then(launchers::loader_name) {
        inst.loader = Some(l);
    }
}

/// A linked Modrinth project's title and icon win over the local instance name.
fn resolve_pack(inst: &Instance, cache: Option<&Path>) -> Pack {
    let mut pack = Pack {
        name: inst.pack.clone(),
        own: inst.name.clone(),
        icon: inst.pack_icon.clone(),
        version: inst.version.clone(),
        loader: inst.loader.clone(),
    };
    if let Some(p) = inst
        .modrinth_project
        .as_deref()
        .and_then(|id| modrinth::project(id, cache))
    {
        pack.name = Some(p.title);
        pack.icon = p.icon_url.or(pack.icon);
    }
    pack
}

/// Title says in-world or not (and which kind, in English); the log says
/// which server. Without a usable title the log alone decides.
fn place(title: Option<&log::Title>, seen_mode: bool, from_log: Option<&Where>) -> Option<Where> {
    let Some(t) = title else {
        return from_log.cloned();
    };
    match t.mode {
        Some(Mode::Single) => Some(Where::Single),
        Some(Mode::Lan) => Some(Where::Lan),
        Some(Mode::Realms) => Some(Where::Realms),
        Some(Mode::Server) => match from_log {
            Some(w @ Where::Server(..)) => Some(w.clone()),
            _ => Some(Where::World),
        },
        Some(Mode::World) => match from_log {
            Some(Where::Menu) | None => Some(Where::World),
            Some(w) => Some(w.clone()),
        },
        // pre-1.16 titles never have a suffix, so only trust it once one showed up
        None if seen_mode => Some(Where::Menu),
        None => from_log.cloned(),
    }
}

fn build(pack: &Pack, place: Option<&Where>, players: Option<[u32; 2]>, o: &Opts) -> Option<Live> {
    let version = pack.version.as_deref().filter(|_| o.version);
    let name = pack
        .name
        .as_deref()
        .filter(|_| o.pack)
        .or(pack.own.as_deref().filter(|_| o.own));
    let details = match (name, version) {
        (Some(n), Some(v)) if n.contains(v) => Some(n.to_string()),
        (Some(n), Some(v)) => Some(format!("{n} {v}")),
        (Some(n), None) => Some(n.to_string()),
        (None, Some(v)) => Some(match pack.loader.as_deref() {
            Some(l) => format!("Minecraft {v} {l}"),
            None => format!("Minecraft {v}"),
        }),
        (None, None) => None,
    };

    let public = |h: &str| o.server && !is_private_host(h) && h.parse::<IpAddr>().is_err();
    let state = place.map(|p| match p {
        Where::Menu => "Main menu".to_string(),
        Where::Single => "Singleplayer".to_string(),
        Where::Lan => "LAN world".to_string(),
        Where::Realms => "Realms".to_string(),
        Where::World => "In a world".to_string(),
        Where::Server(h, port) => {
            let at = if public(h) {
                format!("On {}", address(h, *port))
            } else if is_private_host(h) {
                "On a private server".to_string()
            } else {
                "On a server".to_string()
            };
            match players.filter(|_| o.players) {
                Some([online, _]) => format!("{at}, {online} online"),
                None => at,
            }
        }
    });

    let server_icon = match place {
        Some(Where::Server(h, port)) if public(h) => {
            icon_url(h, *port).map(|u| (u, address(h, *port)))
        }
        _ => None,
    };
    let pack_icon = pack
        .icon
        .clone()
        .filter(|_| o.pack && pack.name.is_some())
        .map(|u| (u, pack.name.clone().unwrap_or_default()));
    let (large_image, large_text) = match o.image.as_str() {
        "auto" => server_icon.or(pack_icon),
        "pack" => pack_icon,
        _ => None,
    }
    .map(|(u, t)| (Some(u), util::clamp(t)))
    .unwrap_or((None, None));

    let live = Live {
        details: details.and_then(util::clamp),
        state: state.and_then(util::clamp),
        large_image,
        large_text,
        ..Default::default()
    };
    (!live.is_empty()).then_some(live)
}

fn address(host: &str, port: u16) -> String {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if port == DEFAULT_PORT {
        host
    } else {
        format!("{host}:{port}")
    }
}

/// 64x64 PNG from mcsrvstat.us, which pings the server itself.
fn icon_url(host: &str, port: u16) -> Option<String> {
    let ok = !host.is_empty()
        && host.len() < 254
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    ok.then(|| format!("https://api.mcsrvstat.us/icon/{}", address(host, port)))
}

/// LAN, loopback, CGNAT (Tailscale, ZeroTier ranges) and single label names.
fn is_private_host(host: &str) -> bool {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let h = h.trim_start_matches('[').trim_end_matches(']');
    if h.is_empty() {
        return true;
    }
    if let Ok(ip) = h.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => private_v4(v4),
            IpAddr::V6(v6) => {
                let s = v6.segments()[0];
                v6.is_loopback()
                    || v6.is_unspecified()
                    || (s & 0xfe00) == 0xfc00
                    || (s & 0xffc0) == 0xfe80
                    || v6.to_ipv4_mapped().is_some_and(private_v4)
            }
        };
    }
    if !h.contains('.') {
        return true;
    }
    [
        ".local",
        ".lan",
        ".home",
        ".internal",
        ".localdomain",
        ".localhost",
        ".home.arpa",
        ".intranet",
        ".corp",
    ]
    .iter()
    .any(|s| h.ends_with(s))
}

fn private_v4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || (o[0] == 100 && (o[1] & 0xc0) == 64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> Opts {
        Opts {
            pack: true,
            own: false,
            version: true,
            server: true,
            players: true,
            image: "auto".into(),
        }
    }

    fn fo() -> Pack {
        Pack {
            name: Some("Fabulously Optimized".into()),
            icon: Some("https://cdn.modrinth.com/data/1KVo5zza/icon.png".into()),
            version: Some("1.21.4".into()),
            loader: Some("Fabric".into()),
            own: Some("FO main".into()),
        }
    }

    #[test]
    fn matches_minecraft_only() {
        let t = Target {
            game_id: MINECRAFT.into(),
            ..Default::default()
        };
        assert!(matches(&t));
        let t = Target {
            game_id: "123".into(),
            exe: Some("C:/x/javaw.exe".into()),
            ..Default::default()
        };
        assert!(!matches(&t));
    }

    #[test]
    fn card_on_public_server() {
        let l = build(
            &fo(),
            Some(&Where::Server("Play.Example.net".into(), 25565)),
            Some([312, 1000]),
            &opts(),
        )
        .unwrap();
        assert_eq!(l.details.as_deref(), Some("Fabulously Optimized 1.21.4"));
        assert_eq!(l.state.as_deref(), Some("On play.example.net, 312 online"));
        assert_eq!(
            l.large_image.as_deref(),
            Some("https://api.mcsrvstat.us/icon/play.example.net")
        );
        assert_eq!(l.large_text.as_deref(), Some("play.example.net"));

        let l = build(
            &fo(),
            Some(&Where::Server("mc.example.org".into(), 25570)),
            None,
            &opts(),
        )
        .unwrap();
        assert_eq!(l.state.as_deref(), Some("On mc.example.org:25570"));
        assert_eq!(
            l.large_image.as_deref(),
            Some("https://api.mcsrvstat.us/icon/mc.example.org:25570")
        );
    }

    #[test]
    fn hides_private_and_ip_servers() {
        for (h, want) in [
            ("192.168.1.20", "On a private server, 3 online"),
            ("localhost", "On a private server, 3 online"),
            ("100.101.102.103", "On a private server, 3 online"),
            ("box.lan", "On a private server, 3 online"),
            ("[fd00::1]", "On a private server, 3 online"),
            ("203.0.113.9", "On a server, 3 online"),
        ] {
            let l = build(
                &fo(),
                Some(&Where::Server(h.into(), 25565)),
                Some([3, 10]),
                &opts(),
            )
            .unwrap();
            assert_eq!(l.state.as_deref(), Some(want), "{h}");
            // pack icon instead of a server icon that would name the host
            assert_eq!(l.large_image, fo().icon, "{h}");
        }
        let o = Opts {
            server: false,
            ..opts()
        };
        let l = build(
            &fo(),
            Some(&Where::Server("play.example.net".into(), 25565)),
            Some([3, 10]),
            &o,
        )
        .unwrap();
        assert_eq!(l.state.as_deref(), Some("On a server, 3 online"));
        assert_eq!(l.large_image, fo().icon);
    }

    #[test]
    fn card_without_pack() {
        let p = Pack {
            version: Some("1.21.4".into()),
            loader: Some("Fabric".into()),
            ..Default::default()
        };
        let l = build(&p, Some(&Where::Single), None, &opts()).unwrap();
        assert_eq!(l.details.as_deref(), Some("Minecraft 1.21.4 Fabric"));
        assert_eq!(l.state.as_deref(), Some("Singleplayer"));
        assert_eq!(l.large_image, None);
        assert_eq!(build(&Pack::default(), None, None, &opts()), None);
        let o = Opts {
            pack: false,
            version: false,
            ..opts()
        };
        let l = build(&fo(), Some(&Where::Lan), None, &o).unwrap();
        assert_eq!(
            (l.details, l.state.as_deref(), l.large_image),
            (None, Some("LAN world"), None)
        );
    }

    #[test]
    fn pack_name_with_version_inside() {
        let p = Pack {
            own: Some("1.21.4 fabric".into()),
            version: Some("1.21.4".into()),
            ..Default::default()
        };
        let l = build(
            &p,
            Some(&Where::Realms),
            None,
            &Opts {
                image: "game".into(),
                own: true,
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(l.details.as_deref(), Some("1.21.4 fabric"));
        assert_eq!(l.state.as_deref(), Some("Realms"));
    }

    #[test]
    fn own_instance_names_are_opt_in() {
        // unmanaged Prism/Modrinth instance: no published pack, only the user's name
        let p = Pack {
            own: Some("Bob's test world".into()),
            version: Some("1.21.4".into()),
            loader: Some("Fabric".into()),
            ..Default::default()
        };
        let l = build(&p, Some(&Where::Single), None, &opts()).unwrap();
        assert_eq!(l.details.as_deref(), Some("Minecraft 1.21.4 Fabric"));
        let l = build(
            &p,
            Some(&Where::Single),
            None,
            &Opts {
                own: true,
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(l.details.as_deref(), Some("Bob's test world 1.21.4"));

        // a published pack wins over the instance name either way
        let l = build(
            &fo(),
            Some(&Where::Single),
            None,
            &Opts {
                own: true,
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(l.details.as_deref(), Some("Fabulously Optimized 1.21.4"));
        let l = build(
            &fo(),
            Some(&Where::Single),
            None,
            &Opts {
                pack: false,
                own: true,
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(
            (l.details.as_deref(), l.large_image),
            (Some("FO main 1.21.4"), None)
        );
    }

    #[test]
    fn place_from_title_and_log() {
        let t = |s: &str| log::parse_title(s).unwrap();
        let srv = Where::Server("a.example".into(), 25565);
        assert_eq!(
            place(
                Some(&t("Minecraft* 1.21.4 - Multiplayer (3rd-party Server)")),
                true,
                Some(&srv)
            ),
            Some(srv.clone())
        );
        assert_eq!(
            place(
                Some(&t("Minecraft* 1.21.4 - Singleplayer")),
                true,
                Some(&srv)
            ),
            Some(Where::Single)
        );
        assert_eq!(
            place(Some(&t("Minecraft* 1.21.4")), true, Some(&srv)),
            Some(Where::Menu)
        );
        // old version, never had a suffix: the log decides
        assert_eq!(
            place(Some(&t("Minecraft 1.12.2")), false, Some(&srv)),
            Some(srv.clone())
        );
        // non-English suffix
        assert_eq!(
            place(
                Some(&t("Minecraft* 1.21.4 - Einzelspieler")),
                true,
                Some(&Where::Single)
            ),
            Some(Where::Single)
        );
        assert_eq!(place(None, false, Some(&srv)), Some(srv));
        assert_eq!(place(None, false, None), None);
    }

    #[test]
    fn preview_follows_settings() {
        let p = |v: serde_json::Value| preview(&Settings::new(&MANIFEST, v), "server").live;
        let d = p(serde_json::json!({}));
        assert_eq!(d.details.as_deref(), Some("Fabulously Optimized 1.21.4"));
        assert_eq!(d.state.as_deref(), Some("On hypixel.net, 31245 online"));
        assert_eq!(
            d.large_image.as_deref(),
            Some("https://api.mcsrvstat.us/icon/hypixel.net")
        );

        let l = p(serde_json::json!({ "show_server": false }));
        assert_eq!(l.state.as_deref(), Some("On a server, 31245 online"));
        assert!(l
            .large_image
            .unwrap()
            .starts_with("https://cdn.modrinth.com/"));
        assert_eq!(
            p(serde_json::json!({ "show_players": false }))
                .state
                .as_deref(),
            Some("On hypixel.net")
        );
        let l = p(serde_json::json!({ "show_pack": false }));
        assert_eq!(l.details.as_deref(), Some("Minecraft 1.21.4 Fabric"));
        let l = p(serde_json::json!({ "show_pack": false, "show_instance_name": true }));
        assert_eq!(l.details.as_deref(), Some("My survival 1.21.4"));
        assert_eq!(p(serde_json::json!({ "image": "game" })).large_image, None);
        assert_ne!(p(serde_json::json!({ "show_version": false })), d);
    }

    #[test]
    fn every_scenario_has_a_card() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&s, key).live.is_empty(), "{key}");
        }
        assert_eq!(
            preview(&s, "nope").live,
            preview(&s, MANIFEST.scenarios[0].0).live
        );
        assert_eq!(preview(&s, "").live.state.as_deref(), Some("Main menu"));
        assert_eq!(
            preview(&s, "private").live.state.as_deref(),
            Some("On a private server, 4 online")
        );
        assert_eq!(
            preview(&s, "own").live.details.as_deref(),
            Some("Minecraft 1.20.1 Forge")
        );
        let own = Settings::new(&MANIFEST, serde_json::json!({ "show_instance_name": true }));
        assert_eq!(
            preview(&own, "own").live.details.as_deref(),
            Some("Bob's Create world 1.20.1")
        );
        let v = preview(&s, "vanilla").live;
        assert_eq!(
            v.state.as_deref(),
            Some("On play.cubecraft.net, 1117 online")
        );
        assert_eq!(v.details.as_deref(), Some("Minecraft 1.21.4"));
    }

    #[test]
    fn manifest_describes() {
        let d = MANIFEST.describe();
        assert_eq!(d["id"], "minecraft");
        assert_eq!(d["options"].as_array().unwrap().len(), 6);
    }
}
