//! Times the clip mux on real data. Pulls the video bitstream and the per-source
//! WAVs back out of a clipdip mp4 (the Mix stream is skipped), then runs every
//! strategy x encoder combo through `mux_with_options` and prints min/median/max.
//!
//!   cargo run --release -p clipdip-muxer --example bench_mux -- --clip <mp4> [--ffmpeg <exe>] [--runs 3] [--no-mix] [--verbose]
//!
//! --verbose prints every ffmpeg spawn with a timestamp, which is the per-stage breakdown
//!
//! sidecars are cached under %TEMP%\clipdip-bench-mux\<clip stem>, delete to re-extract

use anyhow::{anyhow, bail, Context, Result};
use clipdip_muxer::{
    mux_with_options, resolve_ffmpeg_path, AacEncoder, AudioTrack, MuxOptions, MuxStrategy,
    VideoBitstream,
};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

struct Args {
    clip: PathBuf,
    ffmpeg: PathBuf,
    runs: usize,
    mix: bool,
    verbose: bool,
}

fn parse_args() -> Result<Args> {
    let mut clip = None;
    let mut ffmpeg = None;
    let mut runs = 3;
    let mut mix = true;
    let mut verbose = false;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--clip" => clip = it.next().map(PathBuf::from),
            "--ffmpeg" => ffmpeg = it.next().map(PathBuf::from),
            "--runs" => runs = it.next().and_then(|s| s.parse().ok()).unwrap_or(3),
            "--no-mix" => mix = false,
            "--verbose" => verbose = true,
            other => bail!("unknown arg {other}"),
        }
    }
    Ok(Args {
        clip: clip.ok_or_else(|| anyhow!("--clip <mp4> is required"))?,
        ffmpeg: ffmpeg.unwrap_or_else(|| resolve_ffmpeg_path(None)),
        runs: runs.max(1),
        mix,
        verbose,
    })
}

struct Sidecars {
    video: PathBuf,
    bitstream: VideoBitstream,
    fps: f64,
    wavs: Vec<PathBuf>,
}

fn probe(ffmpeg: &Path, clip: &Path) -> Result<String> {
    // ffmpeg -i with no output exits 1 but still prints the stream table
    let out = Command::new(ffmpeg)
        .arg("-hide_banner")
        .arg("-i")
        .arg(clip)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .context("spawn ffmpeg for probe")?;
    Ok(String::from_utf8_lossy(&out.stderr).into_owned())
}

fn run_ffmpeg(ffmpeg: &Path, args: &[&str], what: &str) -> Result<()> {
    let status = Command::new(ffmpeg)
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .args(args)
        .status()
        .with_context(|| format!("spawn ffmpeg for {what}"))?;
    if !status.success() {
        bail!("ffmpeg {what} failed: {status}");
    }
    Ok(())
}

/// video codec, fps and which audio streams are real sources (not the Mix track)
fn extract(ffmpeg: &Path, clip: &Path, work: &Path) -> Result<Sidecars> {
    let info = probe(ffmpeg, clip)?;
    let mut bitstream = None;
    let mut fps = 60.0;
    let mut audio: Vec<(usize, bool)> = Vec::new(); // (a:index, is_mix)
    for line in info.lines() {
        let t = line.trim();
        if t.starts_with("Stream #") && t.contains("Video:") {
            bitstream = Some(if t.contains("Video: av1") {
                VideoBitstream::Av1
            } else if t.contains("Video: h264") {
                VideoBitstream::H264
            } else {
                bail!("unsupported video codec: {t}");
            });
            let toks: Vec<&str> = t.split(|c| c == ' ' || c == ',').collect();
            if let Some(i) = toks.iter().position(|s| *s == "fps") {
                if let Some(v) = toks[..i].iter().rev().find_map(|s| s.parse::<f64>().ok()) {
                    fps = v;
                }
            }
        } else if t.starts_with("Stream #") && t.contains("Audio:") {
            audio.push((audio.len(), false));
        } else if (t.starts_with("handler_name") || t.starts_with("title")) && t.ends_with(": Mix") {
            if let Some(last) = audio.last_mut() {
                last.1 = true;
            }
        }
    }
    let bitstream = bitstream.ok_or_else(|| anyhow!("no video stream in {}", clip.display()))?;
    let sources: Vec<usize> = audio.iter().filter(|(_, m)| !m).map(|(i, _)| *i).collect();
    if sources.is_empty() {
        bail!("no audio sources in {}", clip.display());
    }

    std::fs::create_dir_all(work)?;
    let (ext, fmt, bsf): (&str, &str, Option<&str>) = match bitstream {
        VideoBitstream::Av1 => ("av1", "obu", None),
        VideoBitstream::H264 => ("h264", "h264", Some("h264_mp4toannexb")),
    };
    let video = work.join(format!("video.{ext}"));
    let wavs: Vec<PathBuf> = sources
        .iter()
        .map(|i| work.join(format!("track{i}.wav")))
        .collect();
    let cached = video.is_file() && wavs.iter().all(|w| w.is_file());
    if cached {
        println!("sidecars cached in {}", work.display());
    } else {
        println!("extracting sidecars to {}", work.display());
        let clip_s = clip.to_string_lossy().into_owned();
        let video_s = video.to_string_lossy().into_owned();
        let mut args: Vec<String> = vec!["-i".into(), clip_s, "-map".into(), "0:v:0".into()];
        args.extend(["-c:v".into(), "copy".into()]);
        if let Some(b) = bsf {
            args.extend(["-bsf:v".into(), b.into()]);
        }
        args.extend(["-f".into(), fmt.into(), video_s]);
        for (k, i) in sources.iter().enumerate() {
            args.extend([
                "-map".into(),
                format!("0:a:{i}"),
                "-c:a".into(),
                "pcm_f32le".into(),
                "-f".into(),
                "wav".into(),
                wavs[k].to_string_lossy().into_owned(),
            ]);
        }
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_ffmpeg(ffmpeg, &refs, "extract")?;
    }
    Ok(Sidecars {
        video,
        bitstream,
        fps,
        wavs,
    })
}

/// first audio stream decoded to s16 so two outputs can be compared byte for byte
fn decode_first_audio(ffmpeg: &Path, mp4: &Path, stream: usize) -> Result<Vec<u8>> {
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(mp4)
        .arg("-map")
        .arg(format!("0:a:{stream}"))
        .args(["-f", "s16le", "-"])
        .stderr(Stdio::inherit())
        .output()
        .context("decode for compare")?;
    Ok(out.stdout)
}

fn label(s: MuxStrategy, e: AacEncoder) -> String {
    let s = match s {
        MuxStrategy::Auto => "auto (default)",
        MuxStrategy::SinglePass => "single pass",
        MuxStrategy::ParallelTracks => "parallel tracks",
    };
    let e = match e {
        AacEncoder::Native => "aac",
        AacEncoder::MediaFoundation => "aac_mf",
        AacEncoder::Auto => "auto",
    };
    format!("{s:16} {e:7}")
}

fn main() -> Result<()> {
    let args = parse_args()?;
    if args.verbose {
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_target(false)
            .init();
    }
    let stem = args
        .clip
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "clip".into());
    let work = std::env::temp_dir().join("clipdip-bench-mux").join(&stem);
    let sc = extract(&args.ffmpeg, &args.clip, &work)?;

    println!("ffmpeg: {}", args.ffmpeg.display());
    let banner = Command::new(&args.ffmpeg).arg("-version").output()?;
    if let Some(first) = String::from_utf8_lossy(&banner.stdout).lines().next() {
        println!("{first}");
    }
    let video_mb = std::fs::metadata(&sc.video)?.len() / (1024 * 1024);
    println!(
        "clip: {} ({:?}, {:.2} fps, {} MB video, {} audio sources, mix={})",
        args.clip.display(),
        sc.bitstream,
        sc.fps,
        video_mb,
        sc.wavs.len(),
        args.mix
    );

    let tracks: Vec<AudioTrack> = sc
        .wavs
        .iter()
        .enumerate()
        .map(|(i, p)| AudioTrack {
            path: p.clone(),
            title: format!("Track {i}"),
            bitrate_bps: 192_000,
            // real saves land a few ms after the IDR; keeps adelay in the graph
            offset_secs: 0.008,
        })
        .collect();

    let mut combos = vec![
        (MuxStrategy::SinglePass, AacEncoder::Native),
        (MuxStrategy::ParallelTracks, AacEncoder::Native),
    ];
    if cfg!(windows) {
        combos.push((MuxStrategy::SinglePass, AacEncoder::MediaFoundation));
        combos.push((MuxStrategy::ParallelTracks, AacEncoder::MediaFoundation));
    }
    // what a real save does with this binary
    combos.push((MuxStrategy::Auto, AacEncoder::Auto));

    println!("\n{:26} {:>8} {:>8} {:>8}   runs={}", "strategy", "min", "median", "max", args.runs);
    let mut outputs: Vec<((MuxStrategy, AacEncoder), PathBuf)> = Vec::new();
    for (strategy, encoder) in combos {
        let out = work.join(format!("out_{strategy:?}_{encoder:?}.mp4"));
        let mut times = Vec::with_capacity(args.runs);
        for _ in 0..args.runs {
            let t = Instant::now();
            mux_with_options(
                &args.ffmpeg,
                &sc.video,
                sc.bitstream,
                sc.fps,
                &tracks,
                args.mix,
                &out,
                MuxOptions { strategy, encoder },
            )?;
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "{:26} {:7.0}ms {:7.0}ms {:7.0}ms",
            label(strategy, encoder),
            times[0],
            times[times.len() / 2],
            times[times.len() - 1]
        );
        outputs.push(((strategy, encoder), out));
    }

    // same encoder through both strategies must decode to the same samples, else the
    // two-phase path shifted the audio (edit list, priming) and is not a drop-in
    println!();
    let streams = if args.mix { tracks.len() + 1 } else { tracks.len() };
    for enc in [AacEncoder::Native, AacEncoder::MediaFoundation] {
        let single = outputs
            .iter()
            .find(|((s, e), _)| *s == MuxStrategy::SinglePass && *e == enc);
        let parallel = outputs
            .iter()
            .find(|((s, e), _)| *s == MuxStrategy::ParallelTracks && *e == enc);
        let (Some((_, a)), Some((_, b))) = (single, parallel) else {
            continue;
        };
        for st in 0..streams {
            let pa = decode_first_audio(&args.ffmpeg, a, st)?;
            let pb = decode_first_audio(&args.ffmpeg, b, st)?;
            let verdict = if pa == pb {
                "identical".to_string()
            } else {
                let first = pa.iter().zip(&pb).position(|(x, y)| x != y);
                format!(
                    "DIFFERS (len {} vs {}, first diff at byte {:?})",
                    pa.len(),
                    pb.len(),
                    first
                )
            };
            println!(
                "{:7} stream a:{st}: single pass vs parallel decode {verdict}",
                match enc {
                    AacEncoder::Native => "aac",
                    _ => "aac_mf",
                }
            );
        }
    }
    Ok(())
}
