fn main() {
    // launcher is what shortcuts/taskbar pins point at, carries the app icon
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../../../icon.ico");
        res.set("ProductName", "ClipLib");
        res.set("FileDescription", "ClipLib");
        // fail loudly: shortcuts/pins take their icon from this exe
        if let Err(error) = res.compile() {
            panic!("launcher icon resource not compiled (rc.exe from the Windows SDK is required): {error}");
        }
    }
    println!("cargo:rerun-if-changed=../../../icon.ico");
    println!("cargo:rerun-if-changed=../../../assets/title.png");
}
