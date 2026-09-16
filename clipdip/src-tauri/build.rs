fn main() {
    // tauri-build doesn't watch the icon path; without this an updated icon.ico
    // stays cached until a clean rebuild.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons");

    tauri_build::build()
}
