//! Headless smoke test for the WGC backend: create a capturer on output 0,
//! poll for ~2 seconds at 60 Hz, and report how many real vs repeat frames
//! arrived. Run with `cargo run -p clipdip-capture --example wgc_smoke`.

use clipdip_capture::{CaptureBackend, Capturer};

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let (mut cap, _device, _ctx) = Capturer::create(CaptureBackend::Wgc, 0, true)?;
    println!(
        "backend={} size={}x{}",
        cap.backend_name(),
        cap.width(),
        cap.height()
    );

    let mut real = 0u32;
    let mut repeat = 0u32;
    let mut none = 0u32;
    for _ in 0..120 {
        match cap.acquire_frame(0)? {
            Some(f) if f.was_repeat => repeat += 1,
            Some(_) => real += 1,
            None => none += 1,
        }
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
    println!("real={real} repeat={repeat} none={none}");
    anyhow::ensure!(real > 0, "WGC delivered no real frames");
    println!("WGC smoke test OK");
    Ok(())
}
