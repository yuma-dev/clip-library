fn main() {
    // Re-run this build script (which embeds the Windows .ico as the exe's
    // icon resource) whenever the icon changes. tauri-build does not watch
    // the icon path itself, so without these directives an updated icon.ico
    // leaves the previously compiled icon resource cached — the exe keeps
    // shipping the stale icon until a clean rebuild. See icons/icon.ico.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons");

    tauri_build::build()
}
