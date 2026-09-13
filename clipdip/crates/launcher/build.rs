fn main() {
    // The launcher is what shortcuts and taskbar pins point at, so it carries
    // the app icon. The .ico lives at the repository root.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../../../icon.ico");
        res.set("ProductName", "ClipLib");
        res.set("FileDescription", "ClipLib");
        // Shortcuts and pins take their icon from this exe: a build without
        // the resource would ship generic icons everywhere. Fail loudly.
        if let Err(error) = res.compile() {
            panic!("launcher icon resource not compiled (rc.exe from the Windows SDK is required): {error}");
        }
    }
    println!("cargo:rerun-if-changed=../../../icon.ico");
    println!("cargo:rerun-if-changed=../../../assets/title.png");
}
