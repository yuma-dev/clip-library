fn main() {
    // The launcher is what shortcuts and taskbar pins point at, so it carries
    // the app icon. The .ico lives at the repository root.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../../../icon.ico");
        res.set("ProductName", "ClipLib");
        res.set("FileDescription", "ClipLib");
        if let Err(error) = res.compile() {
            println!("cargo:warning=launcher icon resource not compiled: {error}");
        }
    }
    println!("cargo:rerun-if-changed=../../../icon.ico");
    println!("cargo:rerun-if-changed=../../../assets/title.png");
}
