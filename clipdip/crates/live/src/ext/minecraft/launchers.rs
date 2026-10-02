//! Which launcher started the game and what it says about the instance:
//! pack name, Modrinth project, Minecraft version, mod loader.
//! The per-launcher pack files follow CraftPresence's pack integrations
//! (core/integrations/pack/{atlauncher,curse,mcupdater,modrinth,multimc,technic}).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::util::process::arg_value;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Launcher {
    Modrinth,
    Prism,
    MultiMc,
    CurseForge,
    Official,
    #[default]
    Other,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Instance {
    pub launcher: Launcher,
    pub game_dir: Option<PathBuf>,
    /// name of a published pack (Modrinth, CurseForge, Technic...)
    pub pack: Option<String>,
    /// instance or profile name the user typed, off by default on the card
    pub name: Option<String>,
    /// https art for the pack (CurseForge thumbnail)
    pub pack_icon: Option<String>,
    /// Modrinth project to fetch title and icon for
    pub modrinth_project: Option<String>,
    pub version: Option<String>,
    pub loader: Option<String>,
}

/// `-Dkey=value` from the java command line.
pub fn sysprop<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.iter()
        .find_map(|a| a.strip_prefix("-D")?.strip_prefix(key)?.strip_prefix('='))
        .filter(|v| !v.is_empty())
}

fn has(args: &[String], s: &str) -> bool {
    args.iter().any(|a| a == s)
}

pub fn launcher_of(args: &[String]) -> Launcher {
    if has(args, "com.modrinth.theseus.MinecraftLaunch") {
        Launcher::Modrinth
    } else if has(args, "org.prismlauncher.EntryPoint")
        || sysprop(args, "org.prismlauncher.instance.name").is_some()
    {
        Launcher::Prism
    } else if has(args, "org.multimc.EntryPoint")
        || sysprop(args, "multimc.instance.title").is_some()
    {
        Launcher::MultiMc
    } else if sysprop(args, "minecraft.launcher.brand") == Some("minecraft-launcher") {
        Launcher::Official
    } else {
        Launcher::Other
    }
}

/// Everything readable from the command line alone.
pub fn from_args(args: &[String]) -> Instance {
    let mut inst = Instance {
        launcher: launcher_of(args),
        game_dir: arg_value(args, "--gameDir")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from),
        ..Default::default()
    };
    // CraftPresence reads these as system properties, MultiMC and Prism pass them as -D
    inst.name = sysprop(args, "org.prismlauncher.instance.name")
        .or_else(|| sysprop(args, "multimc.instance.title"))
        .or_else(|| sysprop(args, "modrinth.profile.name"))
        .map(str::to_string);

    if arg_value(args, "--fml.neoForgeVersion").is_some() {
        inst.loader = Some("NeoForge".into());
    } else if arg_value(args, "--fml.forgeVersion").is_some()
        || arg_value(args, "--tweakClass").is_some_and(|t| t.contains("FMLTweaker"))
    {
        inst.loader = Some("Forge".into());
    } else if args
        .iter()
        .any(|a| a.starts_with("net.fabricmc.loader.") && a.ends_with("KnotClient"))
    {
        inst.loader = Some("Fabric".into());
    } else if args
        .iter()
        .any(|a| a.starts_with("org.quiltmc.loader.") && a.ends_with("KnotClient"))
    {
        inst.loader = Some("Quilt".into());
    }
    inst.version = arg_value(args, "--fml.mcVersion")
        .filter(|v| is_mc_version(v))
        .map(str::to_string);

    if let Some(id) = arg_value(args, "--version") {
        let (v, l) = parse_version_id(id);
        inst.version = inst.version.take().or(v);
        inst.loader = inst.loader.take().or(l);
    }
    inst
}

/// `1.21.4`, `24w14a`, and old alpha/beta ids like `b1.7.3`
fn is_mc_version(v: &str) -> bool {
    let digits = v.strip_prefix(['a', 'b']).unwrap_or(v);
    v.len() <= 32
        && digits.starts_with(|c: char| c.is_ascii_digit())
        && !v.contains(char::is_whitespace)
}

/// Launcher version ids: `1.21.4`, `fabric-loader-0.16.9-1.21.4`,
/// `quilt-loader-0.26.0-1.21.1`, `1.20.1-forge-47.2.0`, `neoforge-21.1.77`,
/// `1.21.4-OptiFine_HD_U_J2`.
pub fn parse_version_id(id: &str) -> (Option<String>, Option<String>) {
    let lower = id.to_ascii_lowercase();
    for (prefix, name) in [("fabric-loader-", "Fabric"), ("quilt-loader-", "Quilt")] {
        if lower.starts_with(prefix) {
            // loader version has no dash, the game version is what follows it
            let v = id
                .get(prefix.len()..)
                .and_then(|r| r.split_once('-'))
                .map(|(_, v)| v);
            return (
                v.filter(|v| is_mc_version(v)).map(str::to_string),
                Some(name.into()),
            );
        }
    }
    if lower.starts_with("neoforge-") {
        return (None, Some("NeoForge".into()));
    }
    let first = id.split('-').next().unwrap_or_default();
    let version = Some(first)
        .filter(|v| is_mc_version(v) && v.contains('.'))
        .map(str::to_string);
    let loader = if lower.contains("neoforge") {
        Some("NeoForge".into())
    } else if lower.contains("forge") {
        Some("Forge".into())
    } else if lower.contains("fabric") {
        Some("Fabric".into())
    } else if lower.contains("quilt") {
        Some("Quilt".into())
    } else {
        None
    };
    (version, loader)
}

/// Loader names as Modrinth and Prism store them.
pub fn loader_name(raw: &str) -> Option<String> {
    let l = raw.to_ascii_lowercase();
    let name = match l.as_str() {
        "" | "vanilla" | "net.minecraft" => return None,
        "fabric" | "net.fabricmc.fabric-loader" => "Fabric",
        "quilt" | "org.quiltmc.quilt-loader" => "Quilt",
        "forge" | "net.minecraftforge" => "Forge",
        "neoforge" | "net.neoforged" => "NeoForge",
        "liteloader" | "com.mumfrey.liteloader" => "LiteLoader",
        _ => return None,
    };
    Some(name.into())
}

/// Qt INI as written by MultiMC and Prism. Sections are ignored, values may
/// be quoted, Qt 5 writes non-ASCII as `\xNNNN`.
pub fn parse_ini(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        out.insert(k.trim().to_string(), unquote_ini(v.trim()));
    }
    out
}

fn unquote_ini(v: &str) -> String {
    let v = v
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(v);
    let mut out = String::with_capacity(v.len());
    let mut it = v.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('x') => {
                let mut code = 0u32;
                let mut n = 0;
                while n < 4 {
                    let Some(d) = it.peek().and_then(|c| c.to_digit(16)) else {
                        break;
                    };
                    code = code * 16 + d;
                    it.next();
                    n += 1;
                }
                out.extend(char::from_u32(code));
            }
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some(o) => out.push(o),
            None => {}
        }
    }
    out
}

/// mmc-pack.json components: version from net.minecraft, loader from the first known uid.
pub fn parse_mmc_pack(v: &Value) -> (Option<String>, Option<String>) {
    let mut version = None;
    let mut loader = None;
    for c in v
        .get("components")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let uid = c.get("uid").and_then(Value::as_str).unwrap_or_default();
        if uid == "net.minecraft" {
            version = c
                .get("version")
                .and_then(Value::as_str)
                .filter(|v| is_mc_version(v))
                .map(str::to_string);
        } else if loader.is_none() {
            loader = loader_name(uid);
        }
    }
    (version, loader)
}

/// The instance root holds instance.cfg; natives sit right under it.
/// java.library.path can be an 8.3 short path, which reads fine.
fn prism_root(args: &[String], game_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(lib) = sysprop(args, "java.library.path") {
        let first = lib.split(';').next().unwrap_or_default();
        if let Some(root) = Path::new(first).parent() {
            if root.join("instance.cfg").is_file() {
                return Some(root.to_path_buf());
            }
        }
    }
    // CraftPresence: parent of the working dir (the game dir)
    let root = game_dir?.parent()?;
    root.join("instance.cfg")
        .is_file()
        .then(|| root.to_path_buf())
}

fn read_json(p: &Path) -> Option<Value> {
    let meta = std::fs::metadata(p).ok()?;
    // instance files are small, a huge one is not what we think it is
    if meta.len() > 8 << 20 {
        return None;
    }
    let bytes = std::fs::read(p).ok()?;
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    serde_json::from_slice(bytes).ok()
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for k in path {
        cur = cur.get(*k)?;
    }
    cur.as_str().map(str::trim).filter(|s| !s.is_empty())
}

pub fn prism(inst: &mut Instance, args: &[String]) {
    let Some(root) = prism_root(args, inst.game_dir.as_deref()) else {
        return;
    };
    if inst.game_dir.is_none() {
        inst.game_dir = ["minecraft", ".minecraft"]
            .iter()
            .map(|d| root.join(d))
            .find(|d| d.is_dir());
    }
    if let Ok(text) = std::fs::read_to_string(root.join("instance.cfg")) {
        apply_instance_cfg(inst, &parse_ini(&text));
    }
    if let Some(pack) = read_json(&root.join("mmc-pack.json")) {
        let (v, l) = parse_mmc_pack(&pack);
        inst.version = v.or(inst.version.take());
        inst.loader = l.or(inst.loader.take());
    }
}

pub fn apply_instance_cfg(inst: &mut Instance, cfg: &HashMap<String, String>) {
    let get = |k: &str| cfg.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
    let managed = get("ManagedPack")
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if managed {
        if let Some(name) = get("ManagedPackName") {
            inst.pack = Some(name.to_string());
        }
        if get("ManagedPackType") == Some("modrinth") {
            inst.modrinth_project = get("ManagedPackID").map(str::to_string);
        }
    }
    if let Some(name) = get("name") {
        inst.name = Some(name.to_string());
    }
}

/// minecraftinstance.json, written by the CurseForge app into every instance.
pub fn apply_curse_instance(inst: &mut Instance, v: &Value) {
    // top level name is the profile name, renamable; installedModpack only exists for real packs
    if let Some(name) = str_at(v, &["installedModpack", "name"]) {
        inst.pack = Some(name.to_string());
    }
    if let Some(name) = str_at(v, &["name"]) {
        inst.name = Some(name.to_string());
    }
    if let Some(ver) = str_at(v, &["gameVersion"]).filter(|v| is_mc_version(v)) {
        inst.version = Some(ver.to_string());
    }
    // "forge-47.2.0", "neoforge-21.1.77", "fabric-0.16.9-1.21.4"
    if let Some(l) = str_at(v, &["baseModLoader", "name"]) {
        let kind = l.split('-').next().unwrap_or_default();
        if let Some(name) = loader_name(kind) {
            inst.loader = Some(name);
        }
    }
    if let Some(url) =
        str_at(v, &["installedModpack", "thumbnailUrl"]).filter(|u| u.starts_with("https://"))
    {
        inst.pack_icon = Some(url.to_string());
    }
}

/// CraftPresence's file based pack lookups, in its order: atlauncher, curse,
/// mcupdater, modrinth (old app profile.json), multimc, technic. Only fills
/// what is still missing, published pack names and user instance names apart.
pub fn pack_files(inst: &mut Instance) {
    let Some(dir) = inst.game_dir.clone() else {
        return;
    };

    let instance_json = read_json(&dir.join("instance.json"));
    let manifest_name = read_json(&dir.join("manifest.json"))
        .and_then(|v| str_at(&v, &["name"]).map(str::to_string));
    let curse = read_json(&dir.join("minecraftinstance.json"));
    if let Some(c) = &curse {
        inst.launcher = Launcher::CurseForge;
        let mut ci = Instance::default();
        apply_curse_instance(&mut ci, c);
        inst.version = inst.version.take().or(ci.version);
        inst.loader = inst.loader.take().or(ci.loader);
        inst.pack_icon = inst.pack_icon.take().or(ci.pack_icon);
        inst.pack = inst.pack.take().or(ci.pack);
        inst.name = inst.name.take().or(ci.name);
    }
    let atl = |key: &str| {
        instance_json
            .as_ref()
            .and_then(|v| str_at(v, &["launcher", key]))
            .map(str::to_string)
    };
    if inst.name.is_none() {
        inst.name = atl("name")
            .or_else(|| {
                read_json(&dir.join("profile.json"))
                    .and_then(|v| str_at(&v, &["metadata", "name"]).map(str::to_string))
            })
            .or_else(|| {
                let cfg = std::fs::read_to_string(dir.parent()?.join("instance.cfg")).ok()?;
                parse_ini(&cfg)
                    .get("name")
                    .filter(|n| !n.is_empty())
                    .cloned()
            });
    }
    if inst.pack.is_some() {
        return;
    }
    // ATLauncher launcher.pack, a GDLauncher export manifest, MCUpdater packName
    // and Technic's slug name the published pack, not the instance
    inst.pack = atl("pack")
        .or(manifest_name.filter(|_| curse.is_none()))
        .or_else(|| {
            instance_json
                .as_ref()
                .and_then(|v| str_at(v, &["packName"]))
                .map(str::to_string)
        })
        .or_else(|| technic(&dir));
}

/// Technic: <root>/installedPacks names the selected pack, which only counts
/// when the game dir is that pack's folder.
fn technic(dir: &Path) -> Option<String> {
    let v = read_json(&dir.parent()?.parent()?.join("installedPacks"))?;
    let selected = str_at(&v, &["selected"])?;
    dir.to_string_lossy()
        .contains(selected)
        .then(|| selected.to_string())
}

/// Profile name from the official launcher's launcher_profiles.json, only for
/// custom profiles: the built-in ones are "Latest release" and friends.
pub fn official_profile(
    v: &Value,
    version: &str,
    game_dir: Option<&Path>,
    default_dir: &Path,
) -> Option<String> {
    let profiles = v.get("profiles")?.as_object()?;
    let same = |a: &Path, b: &Path| {
        let n = |p: &Path| {
            p.to_string_lossy()
                .trim_end_matches(['\\', '/'])
                .replace('/', "\\")
                .to_lowercase()
        };
        n(a) == n(b)
    };
    profiles
        .values()
        .filter(|p| str_at(p, &["type"]) == Some("custom"))
        .filter(|p| str_at(p, &["lastVersionId"]) == Some(version))
        .filter(|p| {
            let dir = str_at(p, &["gameDir"]).map(PathBuf::from);
            match (dir, game_dir) {
                (Some(d), Some(g)) => same(&d, g),
                (None, Some(g)) => same(default_dir, g),
                (_, None) => true,
            }
        })
        .filter_map(|p| {
            Some((
                str_at(p, &["lastUsed"]).unwrap_or_default(),
                str_at(p, &["name"])?,
            ))
        })
        .max_by(|a, b| a.0.cmp(b.0))
        .map(|(_, name)| name.to_string())
}

pub fn official(inst: &mut Instance, args: &[String]) {
    let Some(version) = arg_value(args, "--version") else {
        return;
    };
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return;
    };
    let default_dir = PathBuf::from(appdata).join(".minecraft");
    let Some(v) = read_json(&default_dir.join("launcher_profiles.json")) else {
        return;
    };
    if let Some(name) = official_profile(&v, version, inst.game_dir.as_deref(), &default_dir) {
        inst.name = Some(name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn version_ids() {
        let f = |s| parse_version_id(s);
        assert_eq!(f("1.21.4"), (Some("1.21.4".into()), None));
        assert_eq!(
            f("fabric-loader-0.16.9-1.21.4"),
            (Some("1.21.4".into()), Some("Fabric".into()))
        );
        assert_eq!(
            f("quilt-loader-0.26.0-1.21.1"),
            (Some("1.21.1".into()), Some("Quilt".into()))
        );
        assert_eq!(
            f("1.20.1-forge-47.2.0"),
            (Some("1.20.1".into()), Some("Forge".into()))
        );
        assert_eq!(
            f("1.7.10-Forge10.13.4.1614-1.7.10"),
            (Some("1.7.10".into()), Some("Forge".into()))
        );
        assert_eq!(f("neoforge-21.1.77"), (None, Some("NeoForge".into())));
        assert_eq!(f("1.21.4-OptiFine_HD_U_J2"), (Some("1.21.4".into()), None));
        assert_eq!(f("My Pack"), (None, None));
        assert_eq!(f("b1.7.3"), (Some("b1.7.3".into()), None));
    }

    #[test]
    fn launcher_and_loader_from_args() {
        let a = args(&[
            "javaw.exe",
            "-Dminecraft.launcher.brand=minecraft-launcher",
            "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "--version",
            "fabric-loader-0.16.9-1.21.4",
            "--gameDir",
            r"C:\mc",
        ]);
        let i = from_args(&a);
        assert_eq!(i.launcher, Launcher::Official);
        assert_eq!(i.loader.as_deref(), Some("Fabric"));
        assert_eq!(i.version.as_deref(), Some("1.21.4"));
        assert_eq!(i.game_dir, Some(PathBuf::from(r"C:\mc")));

        let a = args(&[
            "java",
            "cpw.mods.bootstraplauncher.BootstrapLauncher",
            "--fml.neoForgeVersion",
            "21.1.77",
            "--fml.mcVersion",
            "1.21.1",
        ]);
        let i = from_args(&a);
        assert_eq!(
            (i.loader.as_deref(), i.version.as_deref()),
            (Some("NeoForge"), Some("1.21.1"))
        );

        let a = args(&[
            "java",
            "-Dorg.prismlauncher.instance.name=Better MC",
            "org.prismlauncher.EntryPoint",
        ]);
        let i = from_args(&a);
        assert_eq!(
            (i.launcher, i.name.as_deref(), i.pack),
            (Launcher::Prism, Some("Better MC"), None)
        );
        assert_eq!(
            launcher_of(&args(&["java", "com.modrinth.theseus.MinecraftLaunch"])),
            Launcher::Modrinth
        );
        assert_eq!(
            launcher_of(&args(&["java", "org.multimc.EntryPoint"])),
            Launcher::MultiMc
        );
    }

    #[test]
    fn instance_cfg() {
        let cfg = parse_ini(
            "[General]\nInstanceType=OneSix\nManagedPack=true\nManagedPackID=1KVo5zza\nManagedPackName=Fabulously Optimized\nManagedPackType=modrinth\nname=\"FO 6.4, \\\"main\\\"\"\niconKey=default\n",
        );
        assert_eq!(
            cfg.get("name").map(String::as_str),
            Some("FO 6.4, \"main\"")
        );
        let mut i = Instance::default();
        apply_instance_cfg(&mut i, &cfg);
        assert_eq!(i.pack.as_deref(), Some("Fabulously Optimized"));
        assert_eq!(i.name.as_deref(), Some("FO 6.4, \"main\""));
        assert_eq!(i.modrinth_project.as_deref(), Some("1KVo5zza"));

        let mut i = Instance::default();
        apply_instance_cfg(&mut i, &parse_ini("name=Caf\\xe9 world\n"));
        assert_eq!((i.pack, i.name.as_deref()), (None, Some("Caf\u{e9} world")));
        assert_eq!(i.modrinth_project, None);
    }

    #[test]
    fn mmc_pack() {
        let v = json!({"components": [
            {"uid": "org.lwjgl3", "version": "3.3.3"},
            {"uid": "net.minecraft", "version": "1.21.4"},
            {"uid": "net.fabricmc.intermediary", "version": "1.21.4"},
            {"uid": "net.fabricmc.fabric-loader", "version": "0.16.9"}
        ]});
        assert_eq!(
            parse_mmc_pack(&v),
            (Some("1.21.4".into()), Some("Fabric".into()))
        );
    }

    #[test]
    fn curse_instance() {
        let v = json!({
            "name": "All the Mods 9",
            "gameVersion": "1.20.1",
            "baseModLoader": {"name": "forge-47.2.0", "minecraftVersion": "1.20.1"},
            "installedModpack": {"name": "All the Mods 9 - ATM9", "thumbnailUrl": "https://media.forgecdn.net/avatars/thumbnails/1/2/256/256/x.png"}
        });
        let mut i = Instance::default();
        apply_curse_instance(&mut i, &v);
        assert_eq!(i.pack.as_deref(), Some("All the Mods 9 - ATM9"));
        assert_eq!(i.name.as_deref(), Some("All the Mods 9"));
        assert_eq!(i.version.as_deref(), Some("1.20.1"));
        assert_eq!(i.loader.as_deref(), Some("Forge"));
        assert!(i
            .pack_icon
            .unwrap()
            .starts_with("https://media.forgecdn.net/"));

        let mut i = Instance::default();
        apply_curse_instance(
            &mut i,
            &json!({"name": "my test profile", "installedModpack": null}),
        );
        assert_eq!((i.pack, i.name.as_deref()), (None, Some("my test profile")));
    }

    #[test]
    fn official_profiles() {
        let v = json!({"profiles": {
            "a": {"type": "latest-release", "name": "", "lastVersionId": "latest-release"},
            "b": {"type": "custom", "name": "Old fabric", "lastVersionId": "fabric-loader-0.16.9-1.21.4", "lastUsed": "2026-01-01T00:00:00.000Z"},
            "c": {"type": "custom", "name": "Fabric", "lastVersionId": "fabric-loader-0.16.9-1.21.4", "lastUsed": "2026-09-01T00:00:00.000Z"},
            "d": {"type": "custom", "name": "Elsewhere", "lastVersionId": "fabric-loader-0.16.9-1.21.4", "gameDir": "D:\\mc2", "lastUsed": "2026-09-30T00:00:00.000Z"}
        }});
        let def = Path::new(r"C:\Users\x\AppData\Roaming\.minecraft");
        let id = "fabric-loader-0.16.9-1.21.4";
        assert_eq!(
            official_profile(&v, id, Some(def), def).as_deref(),
            Some("Fabric")
        );
        assert_eq!(
            official_profile(&v, id, Some(Path::new("d:/mc2/")), def).as_deref(),
            Some("Elsewhere")
        );
        assert_eq!(official_profile(&v, "1.21.4", Some(def), def), None);
    }

    #[test]
    fn sysprops() {
        let a = args(&[
            "-Dmodrinth.profile.name=Pack",
            "-Dmodrinth.profile.namex=no",
            "-Dempty=",
        ]);
        assert_eq!(sysprop(&a, "modrinth.profile.name"), Some("Pack"));
        assert_eq!(sysprop(&a, "empty"), None);
    }
}
