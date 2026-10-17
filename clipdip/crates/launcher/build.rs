fn main() {
    // launcher is what shortcuts/taskbar pins point at, carries the app icon
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../../../icon.ico");
        res.set("ProductName", "Setsu");
        res.set("FileDescription", "Setsu");
        // fail loudly: shortcuts/pins take their icon from this exe
        if let Err(error) = res.compile() {
            panic!("launcher icon resource not compiled (rc.exe from the Windows SDK is required): {error}");
        }
    }
    // splash.bin is baked by scripts/bake-splash.mjs and not checked in; without it the launcher
    // just starts the app (plain cargo builds of the workspace still work)
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("splash.bin");
    match std::fs::read("splash.bin") {
        Ok(bytes) => std::fs::write(&out, bytes).unwrap(),
        Err(_) => {
            println!("cargo:warning=splash.bin missing, run `npm run bake:splash` for the splash");
            std::fs::write(&out, []).unwrap();
        }
    }
    println!("cargo:rerun-if-changed=splash.bin");
    println!("cargo:rerun-if-changed=../../../icon.ico");
}
