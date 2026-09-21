use clipdip_muxer::{
    ffmpeg_major, mux_with_options, AacEncoder, AudioTrack, MuxOptions, MuxStrategy, VideoBitstream,
};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

fn resolve_ffmpeg() -> Option<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = if let Some(path) = std::env::var_os("CLIPLIB_FFMPEG") {
        vec![PathBuf::from(path)]
    } else {
        vec![
            manifest.join("../../../vendor/ffmpeg/ffmpeg.exe"),
            manifest.join("../../ffmpeg-cache/ffmpeg.exe"),
        ]
    };
    if let Some(path) = candidates.iter().find(|path| path.is_file()) {
        return Some(path.clone());
    }
    eprintln!("SKIP mux_ffmpeg: no FFmpeg binary found at {candidates:?}; set CLIPLIB_FFMPEG to run these tests");
    None
}

fn command(path: &Path) -> Command {
    let mut cmd = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "clipdip-mux-test-{}-{stamp}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            eprintln!("failed to remove {}: {error}", self.0.display());
        }
    }
}

struct Fixture {
    dir: TempDir,
    ffmpeg: PathBuf,
    video: PathBuf,
    tracks: Vec<AudioTrack>,
}

impl Fixture {
    fn new(ffmpeg: PathBuf) -> Self {
        Self::with_duration_and_tracks(ffmpeg, "4", 3)
    }

    fn with_duration_and_tracks(ffmpeg: PathBuf, duration: &str, track_count: usize) -> Self {
        let dir = TempDir::new();
        let mut fixture = Self {
            video: dir.0.join("video.h264"),
            dir,
            ffmpeg,
            tracks: Vec::new(),
        };
        fixture.run_ffmpeg(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1280x720:rate=60",
            "-t",
            duration,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "60",
            "-f",
            "h264",
            fixture.video.to_str().unwrap(),
        ]);
        for (index, source) in [
            "sine=frequency=440:sample_rate=48000",
            "sine=frequency=660:sample_rate=48000",
            "anullsrc=sample_rate=48000:channel_layout=stereo",
            "sine=frequency=880:sample_rate=48000",
        ]
        .iter()
        .take(track_count)
        .enumerate()
        {
            let path = fixture.dir.0.join(format!("a{index}.wav"));
            fixture.run_ffmpeg(&[
                "-f",
                "lavfi",
                "-i",
                source,
                "-t",
                duration,
                "-c:a",
                "pcm_f32le",
                "-ac",
                "2",
                path.to_str().unwrap(),
            ]);
            fixture.tracks.push(AudioTrack {
                path,
                title: ["System", "Microphone", "Silent", "Voice chat"][index].into(),
                bitrate_bps: 192_000,
                // nonzero offsets expose timeline shifts hidden by aligned inputs.
                offset_secs: [0.0, 0.008, 0.017, 0.012][index],
            });
        }
        fixture
    }

    fn run_ffmpeg(&self, args: &[&str]) -> Output {
        let output = command(&self.ffmpeg)
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(args)
            .output()
            .expect("spawn ffmpeg");
        assert!(
            output.status.success(),
            "ffmpeg {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    fn mux(&self, name: &str, tracks: &[AudioTrack], mix: bool, options: MuxOptions) -> PathBuf {
        let output = self.dir.0.join(name);
        mux_with_options(
            &self.ffmpeg,
            &self.video,
            VideoBitstream::H264,
            60.0,
            tracks,
            mix,
            &output,
            options,
        )
        .unwrap_or_else(|error| panic!("mux {name}: {error:#}"));
        assert!(std::fs::metadata(&output).unwrap().len() > 0);
        output
    }

    fn probe(&self, path: &Path) -> String {
        // input-only probing exits nonzero even for a valid stream table.
        let output = command(&self.ffmpeg)
            .args(["-hide_banner", "-i"])
            .arg(path)
            .output()
            .expect("probe output");
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        assert!(stderr.contains("Input #0"), "{stderr}");
        stderr
    }

    fn frames(&self, path: &Path) -> u64 {
        let output = self.run_ffmpeg(&[
            "-i",
            path.to_str().unwrap(),
            "-map",
            "0:v:0",
            "-c",
            "copy",
            "-progress",
            "pipe:1",
            "-nostats",
            "-f",
            "null",
            "-",
        ]);
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.strip_prefix("frame="))
            .last()
            .expect("video frame count")
            .trim()
            .parse()
            .unwrap()
    }
}

fn audio_streams(probe: &str) -> Vec<&str> {
    probe
        .lines()
        .filter(|line| line.trim().starts_with("Stream #") && line.contains("Audio:"))
        .collect()
}

#[test]
fn default_strategy_is_not_slower_than_legacy_single_pass() {
    let Some(ffmpeg) = resolve_ffmpeg() else {
        return;
    };
    let mut fixture = Fixture::with_duration_and_tracks(ffmpeg, "30", 4);
    let version_line = |fixture: &Fixture| {
        let output = fixture.run_ffmpeg(&["-version"]);
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .expect("ffmpeg version line")
            .to_owned()
    };
    let version = version_line(&fixture);
    let legacy = MuxOptions {
        strategy: MuxStrategy::SinglePass,
        encoder: AacEncoder::Native,
    };
    let timed_mux = |fixture: &Fixture, name: &str, options: MuxOptions| {
        let started = Instant::now();
        let output = fixture.mux(name, &fixture.tracks, true, options);
        let elapsed = started.elapsed();
        std::fs::remove_file(output).unwrap();
        elapsed
    };
    let median = |mut samples: [Duration; 3]| {
        samples.sort_unstable();
        samples[1].as_secs_f64()
    };
    let mut legacy_samples = [Duration::ZERO; 3];
    let mut default_samples = [Duration::ZERO; 3];
    for run in 0..3 {
        // alternating order reduces cache and background-load bias.
        let order = if run % 2 == 0 { [0, 1] } else { [1, 0] };
        for strategy in order {
            if strategy == 0 {
                legacy_samples[run] = timed_mux(&fixture, "legacy.mp4", legacy);
            } else {
                default_samples[run] = timed_mux(&fixture, "default.mp4", MuxOptions::default());
            }
        }
    }
    let legacy_median = median(legacy_samples);
    let default_median = median(default_samples);
    let mut baseline_column = String::new();
    if let Some(baseline) = std::env::var_os("CLIPLIB_FFMPEG_BASELINE") {
        fixture.ffmpeg = PathBuf::from(baseline);
        let baseline_version = version_line(&fixture);
        let samples = std::array::from_fn(|_| timed_mux(&fixture, "baseline.mp4", legacy));
        baseline_column = format!(
            " | legacy on baseline binary: {:.0} ms ({baseline_version})",
            median(samples) * 1000.0,
        );
    }
    println!(
        "{version} | legacy: {:.0} ms | default: {:.0} ms | speedup: {:.2}x{baseline_column}",
        legacy_median * 1000.0,
        default_median * 1000.0,
        legacy_median / default_median,
    );
    // ten percent tolerance absorbs timing noise on busy machines.
    assert!(
        default_median <= legacy_median * 1.10,
        "default ({default_median:.3}s) exceeded legacy ({legacy_median:.3}s) by more than 10%",
    );
}

#[test]
fn default_mux_preserves_layout_titles_and_cleans_intermediates() {
    let Some(ffmpeg) = resolve_ffmpeg() else {
        return;
    };
    let fixture = Fixture::new(ffmpeg);
    let output = fixture.mux("layout.mp4", &fixture.tracks, true, MuxOptions::default());
    let probe = fixture.probe(&output);
    assert_eq!(
        probe
            .lines()
            .filter(|line| line.trim().starts_with("Stream #") && line.contains("Video:"))
            .count(),
        1,
        "{probe}"
    );
    let audio = audio_streams(&probe);
    assert_eq!(audio.len(), 4, "{probe}");
    for (index, line) in audio.iter().enumerate() {
        assert_eq!(line.contains("(default)"), index == 0, "{probe}");
    }
    let mut in_audio = false;
    let mut titles = Vec::new();
    for line in probe.lines().map(str::trim) {
        if line.starts_with("Stream #") {
            in_audio = line.contains("Audio:");
        }
        if in_audio && line.starts_with("handler_name") {
            titles.push(line.split_once(':').unwrap().1.trim());
        }
    }
    assert_eq!(titles, ["Mix", "System", "Microphone", "Silent"]);
    for entry in std::fs::read_dir(&fixture.dir.0).unwrap() {
        assert_ne!(
            entry.unwrap().path().extension().and_then(|s| s.to_str()),
            Some("m4a")
        );
    }
}

#[test]
fn single_pass_and_parallel_tracks_decode_identically() {
    let Some(ffmpeg) = resolve_ffmpeg() else {
        return;
    };
    let fixture = Fixture::new(ffmpeg);
    let encoders = [
        AacEncoder::Native,
        #[cfg(windows)]
        AacEncoder::MediaFoundation,
    ];
    for encoder in encoders {
        let single = fixture.mux(
            &format!("single-{encoder:?}.mp4"),
            &fixture.tracks,
            true,
            MuxOptions {
                strategy: MuxStrategy::SinglePass,
                encoder,
            },
        );
        let parallel = fixture.mux(
            &format!("parallel-{encoder:?}.mp4"),
            &fixture.tracks,
            true,
            MuxOptions {
                strategy: MuxStrategy::ParallelTracks,
                encoder,
            },
        );
        for path in [&single, &parallel] {
            assert_eq!(audio_streams(&fixture.probe(path)).len(), 4);
        }
        for stream in 0..4 {
            let decode = |path: &Path| {
                fixture
                    .run_ffmpeg(&[
                        "-i",
                        path.to_str().unwrap(),
                        "-map",
                        &format!("0:a:{stream}"),
                        "-c:a",
                        "pcm_s16le",
                        "-f",
                        "s16le",
                        "-",
                    ])
                    .stdout
            };
            let a = decode(&single);
            let b = decode(&parallel);
            assert!(!a.is_empty());
            assert!(
                a == b,
                "{encoder:?} stream {stream}: lengths {} vs {}, first difference {:?}",
                a.len(),
                b.len(),
                a.iter().zip(&b).position(|(a, b)| a != b)
            );
        }
        let single_frames = fixture.frames(&single);
        assert_eq!(single_frames, 240);
        assert_eq!(single_frames, fixture.frames(&parallel));
    }
}

#[test]
fn mix_is_omitted_when_disabled_or_only_one_track_exists() {
    let Some(ffmpeg) = resolve_ffmpeg() else {
        return;
    };
    let fixture = Fixture::new(ffmpeg);
    let no_mix = fixture.mux("no-mix.mp4", &fixture.tracks, false, MuxOptions::default());
    assert_eq!(audio_streams(&fixture.probe(&no_mix)).len(), 3);
    let single = fixture.mux(
        "one-track.mp4",
        &fixture.tracks[..1],
        true,
        MuxOptions::default(),
    );
    assert_eq!(audio_streams(&fixture.probe(&single)).len(), 1);
}

#[cfg(windows)]
#[test]
fn auto_encoder_falls_back_after_media_foundation_failure() {
    const CHILD: &str = "CLIPDIP_MUX_FALLBACK_REAL_FFMPEG";
    if let Some(real) = std::env::var_os(CHILD) {
        let mut fixture = Fixture::new(PathBuf::from(real));
        let real = fixture.ffmpeg.clone();
        fixture.ffmpeg = resolve_ffmpeg().expect("fallback shim");
        let output = fixture.mux("fallback.mp4", &fixture.tracks, true, MuxOptions::default());
        fixture.ffmpeg = real;
        let probe = fixture.probe(&output);
        let audio = audio_streams(&probe);
        assert_eq!(audio.len(), 4, "{probe}");
        assert!(
            audio.iter().all(|line| line.contains("Audio: aac")),
            "{probe}"
        );
        return;
    }
    let Some(real) = resolve_ffmpeg() else { return };
    let dir = TempDir::new();
    let shim = dir.0.join("ffmpeg.cmd");
    let marker = dir.0.join("mf-rejected.txt");
    let forward = |path: &Path| path.to_str().unwrap().replace('\\', "/");
    std::fs::write(&shim, format!(
        "@echo off\r\nfor %%A in (%*) do if \"%%~A\"==\"aac_mf\" goto reject\r\n\"{}\" %*\r\nexit /b %errorlevel%\r\n:reject\r\necho rejected>\"{}\"\r\nexit /b 1\r\n",
        forward(&real), forward(&marker))).unwrap();
    // a fresh process prevents the global native-only fallback flag from masking the retry.
    let output = command(&std::env::current_exe().unwrap())
        .args([
            "--exact",
            "auto_encoder_falls_back_after_media_foundation_failure",
            "--nocapture",
        ])
        .env(CHILD, &real)
        .env("CLIPLIB_FFMPEG", &shim)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child stdout: {}\nchild stderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(marker.is_file(), "shim never rejected aac_mf");
}

#[test]
fn ffmpeg_version_detects_real_binary_and_missing_path() {
    let dir = TempDir::new();
    assert_eq!(ffmpeg_major(&dir.0.join("nonexistent-ffmpeg.exe")), 0);
    let Some(ffmpeg) = resolve_ffmpeg() else {
        return;
    };
    assert!(ffmpeg_major(&ffmpeg) >= 6, "{}", ffmpeg.display());
}
