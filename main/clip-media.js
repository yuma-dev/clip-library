'use strict';
/** ffmpeg side of the storage tools: probing, audio alignment of two saves, the merge encode and
 * the lossless cut behind "shrink to trim". no electron in here so it runs under plain node */
const { execFile, spawn } = require('child_process');
const os = require('os');
const { Worker } = require('worker_threads');
const { ffmpegPath, ffprobePath } = require('./ffmpeg-binaries');

// alignment pcm: plenty for broadband game audio, a 23 s window is ~740 KB of f32
const ALIGN_RATE = 8000;
// how far the timestamp estimate may be off, each way
const ALIGN_MARGIN_S = 4;
// correlation window taken from the middle of the shared part
const ALIGN_WINDOW_S = 15;
const MIN_OVERLAP_S = 1.5;
// below about -70 dBFS rms there is nothing to line up
const SILENT_RMS = 3e-4;
// peak ncc and its lead over the best peak further than 50 ms away; tuned on real replay pairs
const MIN_NCC = 0.45;
const MIN_PEAK_LEAD = 0.1;
// both sides audible and this little in common: not the same footage. unrelated clips land near 0.05
const NO_MATCH_NCC = 0.2;

function lowPriority(child) {
  try {
    if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
  } catch (_) { /* priority is a nicety */ }
}

function run(file, args, { background = false, buffer = false, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, maxBuffer, encoding: buffer ? 'buffer' : 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const tail = String(stderr || '').trim().split(/\r?\n/).slice(-3).join(' ');
        reject(Object.assign(new Error(`${error.message.split('\n')[0]}${tail ? `: ${tail}` : ''}`.slice(0, 600)), { stderr: String(stderr || '') }));
      } else {
        resolve(stdout);
      }
    });
    if (background) lowPriority(child);
  });
}

function fpsOf(stream) {
  for (const raw of [stream?.avg_frame_rate, stream?.r_frame_rate]) {
    const [n, d] = String(raw || '').split('/').map(Number);
    if (n > 0 && d > 0) return n / d;
  }
  return 0;
}

const numOr = (v, fallback = null) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : fallback);

/** the fields the storage tools compare and rebuild from, one ffprobe spawn */
async function probeMedia(file, { background = false } = {}) {
  const out = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { background });
  const parsed = JSON.parse(out || '{}');
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.filter((s) => s.codec_type === 'audio').map((s) => ({
    index: s.index,
    codec: s.codec_name || null,
    sampleRate: numOr(s.sample_rate),
    channels: numOr(s.channels),
    layout: s.channel_layout || null,
    bitRate: numOr(s.bit_rate),
    startTime: numOr(s.start_time, 0),
    title: s.tags?.title || null,
    handler: s.tags?.handler_name || null,
    language: s.tags?.language || null,
    isDefault: Boolean(s.disposition?.default),
  }));
  const duration = numOr(parsed.format?.duration, 0);
  return {
    duration,
    size: numOr(parsed.format?.size, 0),
    streams: streams.length,
    video: v
      ? {
          codec: v.codec_name || null,
          width: numOr(v.width, 0),
          height: numOr(v.height, 0),
          fps: fpsOf(v),
          pixFmt: v.pix_fmt || null,
          bitRate: numOr(v.bit_rate),
          startTime: numOr(v.start_time, 0),
          duration: numOr(v.duration, duration),
        }
      : null,
    audio,
  };
}

/** mono f32 pcm of [start, start+dur) with every audio track summed, so a muted mic track can't blank it */
async function extractPcm(file, start, dur, audioCount, { background = false } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(4), '-t', dur.toFixed(4), '-i', file, '-vn'];
  if (audioCount > 1) {
    const inputs = Array.from({ length: audioCount }, (_, i) => `[0:a:${i}]`).join('');
    args.push('-filter_complex', `${inputs}amix=inputs=${audioCount}:normalize=0,aformat=channel_layouts=mono,aresample=${ALIGN_RATE}[o]`, '-map', '[o]');
  } else {
    args.push('-map', '0:a:0', '-ac', '1', '-ar', String(ALIGN_RATE));
  }
  args.push('-f', 'f32le', '-');
  const buf = await run(ffmpegPath, args, { background, buffer: true, maxBuffer: 64 * 1024 * 1024 });
  const copy = new Float32Array(Math.floor(buf.length / 4));
  new Uint8Array(copy.buffer).set(buf.subarray(0, copy.length * 4));
  return copy;
}

/* runs inside a worker (stringified), so it may only use its own arguments. normalized cross
 * correlation of y against x at every lag k (y[n] lines up with x[n + k]) that overlaps by at least
 * minOverlap samples, negative k included, via one packed complex fft */
function xcorrKernel(x, y, rate, minOverlap) {
  const preEmph = (a) => {
    // drop dc and tilt toward the highs: bass hum makes broad, ambiguous peaks
    let mean = 0;
    for (let i = 0; i < a.length; i++) mean += a[i];
    mean /= a.length || 1;
    const out = new Float64Array(a.length);
    let prev = 0;
    for (let i = 0; i < a.length; i++) {
      const s = a[i] - mean;
      out[i] = s - 0.97 * prev;
      prev = s;
    }
    return out;
  };
  const rms = (a) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / (a.length || 1));
  };
  const rmsX = rms(x);
  const rmsY = rms(y);
  const minOv = Math.max(1, Math.min(minOverlap || rate, x.length, y.length));
  const empty = { lag: 0, ncc: 0, second: 0, minLag: 0, maxLag: 0, rmsX, rmsY };
  if (x.length === 0 || y.length === 0) return empty;
  const xs = preEmph(x);
  const ys = preEmph(y);
  // no wraparound for any lag in range
  let n = 1;
  while (n < xs.length + ys.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(xs);
  im.set(ys);
  const cosT = new Float64Array(n >> 1);
  const sinT = new Float64Array(n >> 1);
  for (let i = 0; i < n >> 1; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / n);
    sinT[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const fft = (r, m, inverse) => {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = r[i]; r[i] = r[j]; r[j] = t;
        t = m[i]; m[i] = m[j]; m[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = cosT[k * step];
          const wi = inverse ? sinT[k * step] : -sinT[k * step];
          const a = i + k;
          const b = a + half;
          const br = r[b] * wr - m[b] * wi;
          const bi = r[b] * wi + m[b] * wr;
          r[b] = r[a] - br;
          m[b] = m[a] - bi;
          r[a] += br;
          m[a] += bi;
        }
      }
    }
  };
  fft(re, im, false);
  // unpack X and Y from Z = X + iY, then X * conj(Y)
  const pr = new Float64Array(n);
  const pi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const j = (n - k) % n;
    const a = re[k], b = im[k], c = re[j], d = im[j];
    const xr = (a + c) / 2, xi = (b - d) / 2;
    const yr = (b + d) / 2, yi = (c - a) / 2;
    pr[k] = xr * yr + xi * yi;
    pi[k] = xi * yr - xr * yi;
  }
  fft(pr, pi, true);
  const px = new Float64Array(xs.length + 1);
  for (let i = 0; i < xs.length; i++) px[i + 1] = px[i] + xs[i] * xs[i];
  const py = new Float64Array(ys.length + 1);
  for (let i = 0; i < ys.length; i++) py[i + 1] = py[i] + ys[i] * ys[i];
  const minLag = -(ys.length - minOv);
  const maxLag = xs.length - minOv;
  const count = maxLag - minLag + 1;
  if (count <= 0) return empty;
  const ncc = new Float64Array(count);
  let best = 0;
  for (let i = 0; i < count; i++) {
    const k = minLag + i;
    const n0 = Math.max(0, -k);
    const n1 = Math.min(ys.length, xs.length - k);
    const ex = px[n1 + k] - px[n0 + k];
    const ey = py[n1] - py[n0];
    const den = Math.sqrt(ex * ey);
    ncc[i] = den > 0 ? pr[k >= 0 ? k : n + k] / n / den : 0;
    if (ncc[i] > ncc[best]) best = i;
  }
  const guard = Math.round(rate * 0.05);
  let second = 0;
  for (let i = 0; i < count; i++) if (Math.abs(i - best) > guard && ncc[i] > second) second = ncc[i];
  let frac = 0;
  if (best > 0 && best < count - 1) {
    const l = ncc[best - 1], c = ncc[best], r = ncc[best + 1];
    const den = l - 2 * c + r;
    if (den < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den));
  }
  return { lag: minLag + best + frac, ncc: ncc[best], second, minLag, maxLag, rmsX, rmsY };
}

// the fft pass is ~100 ms of pure math, kept off the main process event loop
function xcorr(x, y, rate, minOverlap) {
  return new Promise((resolve, reject) => {
    const code = `const { parentPort, workerData } = require('worker_threads');
const kernel = ${xcorrKernel.toString()};
parentPort.postMessage(kernel(workerData.x, workerData.y, workerData.rate, workerData.minOverlap));`;
    const worker = new Worker(code, { eval: true, workerData: { x, y, rate, minOverlap } });
    worker.once('message', (m) => {
      resolve(m);
      worker.terminate();
    });
    worker.once('error', reject);
  });
}

/** offset of b's start inside a's timeline (b(t) = a(t + offset)). estimate comes from file times;
 * audio refines it. a clear mismatch means the saves don't share footage at all (bulk copied
 * files get clustered mtimes); silence or a so-so match keeps the estimate */
async function alignPair(a, b, estimate, { background = false } = {}) {
  const fallback = (reason, extra = {}) => ({ offset: estimate, method: 'timestamp', confidence: null, reason, ...extra });
  if (!a.info.audio.length || !b.info.audio.length) return fallback('no_audio');
  const aDur = a.info.duration;
  const bDur = b.info.duration;
  // b from where the shared part starts; lags that only partly overlap still count, so a short
  // overlap with an estimate a few seconds off is found too
  const bStart = Math.min(bDur, Math.max(0, -estimate));
  const win = Math.min(ALIGN_WINDOW_S, bDur - bStart, Math.max(0, Math.min(aDur, estimate + bDur) - Math.max(0, estimate)) + ALIGN_MARGIN_S);
  const aFrom = Math.max(0, estimate + bStart - ALIGN_MARGIN_S);
  const aTo = Math.min(aDur, estimate + bStart + win + ALIGN_MARGIN_S);
  if (win < MIN_OVERLAP_S || aTo - aFrom < MIN_OVERLAP_S) return fallback('short_overlap');
  const [x, y] = await Promise.all([
    extractPcm(a.path, aFrom, aTo - aFrom, a.info.audio.length, { background }),
    extractPcm(b.path, bStart, win, b.info.audio.length, { background }),
  ]);
  const minOverlap = Math.round(MIN_OVERLAP_S * ALIGN_RATE);
  if (y.length < minOverlap || x.length < minOverlap) return fallback('short_pcm');
  const r = await xcorr(x, y, ALIGN_RATE, minOverlap);
  if (r.rmsX < SILENT_RMS || r.rmsY < SILENT_RMS) return fallback('silent', { ncc: r.ncc });
  const offset = aFrom - bStart + r.lag / ALIGN_RATE;
  const edge = r.lag < r.minLag + 2 || r.lag > r.maxLag - 2;
  if (r.ncc < NO_MATCH_NCC) return { offset: estimate, method: 'none', confidence: null, reason: 'no_match', ncc: r.ncc };
  const strong = r.ncc >= MIN_NCC && r.ncc - r.second >= MIN_PEAK_LEAD && !edge;
  if (!strong) return fallback('weak', { ncc: r.ncc, audioOffset: offset });
  return { offset, method: 'audio', confidence: Math.max(0, Math.min(1, r.ncc)), ncc: r.ncc, second: r.second, drift: offset - estimate };
}

let encoderList = null;
function encoders() {
  if (!encoderList) encoderList = run(ffmpegPath, ['-hide_banner', '-encoders']).catch(() => '');
  return encoderList;
}

/** nvenc in the source codec when there is one, then h264_nvenc, libx264 always last. an
 * encoder the gpu can't open (av1 on older cards) fails in well under a second */
async function videoEncoderChain(sourceCodec, nvencAvailable) {
  const list = await encoders();
  const chain = [];
  if (nvencAvailable) {
    if (sourceCodec === 'av1' && /av1_nvenc/.test(list)) chain.push('av1_nvenc');
    if (sourceCodec === 'hevc' && /hevc_nvenc/.test(list)) chain.push('hevc_nvenc');
    chain.push('h264_nvenc');
  }
  chain.push('libx264');
  return chain;
}

// bitrate relative to the source to land at about the same quality; h264 needs more than av1/hevc.
// cq 19 alone doubled the size of an av1 pair (217 MB for 85 s against 107 MB of sources)
const CODEC_EFFICIENCY = { av1: 1.5, hevc: 1.25, h264: 1, vp9: 1.3 };

function videoArgs(encoder, srcKbps, srcCodec) {
  const outCodec = encoder === 'libx264' ? 'h264' : encoder.split('_')[0];
  const ratio = (CODEC_EFFICIENCY[srcCodec] || 1.3) / (CODEC_EFFICIENCY[outCodec] || 1);
  // quality mode with the source rate as a ceiling; unknown source rate gets a generous 1080p60 cap
  const cap = Math.round(srcKbps > 0 ? Math.max(4000, srcKbps * ratio) : 30000);
  if (encoder === 'libx264') {
    return ['-c:v', 'libx264', '-preset', 'faster', '-crf', '18', '-maxrate', `${cap}k`, '-bufsize', `${cap * 2}k`, '-pix_fmt', 'yuv420p'];
  }
  const common = ['-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '19', '-b:v', `${cap}k`, '-maxrate', `${cap}k`, '-bufsize', `${cap * 2}k`];
  if (encoder === 'av1_nvenc') return ['-c:v', 'av1_nvenc', ...common];
  if (encoder === 'hevc_nvenc') return ['-c:v', 'hevc_nvenc', ...common, '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'];
  return ['-c:v', 'h264_nvenc', ...common, '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
}

// aac_mf only takes these; the next one up from the source keeps a near-silent mic track small
const AAC_RATES = [96, 128, 160, 192];
const audioKbps = (bps) => (bps > 0 ? AAC_RATES.find((r) => r * 1000 >= bps * 0.95) || 192 : 160);

const snapDown = (t, origin, fps) => (fps > 0 ? origin + Math.floor((t - origin) * fps + 1e-6) / fps : t);
const snapUp = (t, origin, fps) => (fps > 0 ? origin + Math.ceil((t - origin) * fps - 1e-6) / fps : t);

/** first plays from its start to `cut`, second from `from` to its end; times on each file's own
 * timeline. re-encodes: a stream-copy join only lands on keyframes */
function buildMergeArgs({ first, second, cut, from, videoEncoder, audioEncoder, output }) {
  const fi = first.info;
  const si = second.info;
  const tracks = fi.audio.length;
  const fps = fi.video.fps;
  const f = [];
  const t0 = fi.video.startTime || 0;
  f.push(`[0:v:0]trim=start=${t0.toFixed(6)}:end=${cut.toFixed(6)},setpts=PTS-STARTPTS[v0]`);
  f.push(`[1:v:0]trim=start=${from.toFixed(6)},setpts=PTS-STARTPTS[v1]`);
  const concatIn = ['[v0]'];
  const concatIn2 = ['[v1]'];
  for (let i = 0; i < tracks; i++) {
    const t = fi.audio[i];
    const fmt = `aformat=sample_rates=${t.sampleRate || 48000}${t.layout && t.layout !== 'unknown' ? `:channel_layouts=${t.layout}` : ''}`;
    // first_pts=0 pads a late-starting track so it keeps its place against the video
    f.push(`[0:a:${i}]aresample=async=1:first_pts=0,atrim=start=${t0.toFixed(6)}:end=${cut.toFixed(6)},asetpts=PTS-STARTPTS,apad=whole_dur=${(cut - t0).toFixed(6)},${fmt}[a0_${i}]`);
    f.push(`[1:a:${i}]aresample=async=1:first_pts=0,atrim=start=${from.toFixed(6)},asetpts=PTS-STARTPTS,${fmt}[a1_${i}]`);
    concatIn.push(`[a0_${i}]`);
    concatIn2.push(`[a1_${i}]`);
  }
  const outs = ['[v]', ...Array.from({ length: tracks }, (_, i) => `[oa${i}]`)];
  f.push(`${concatIn.join('')}${concatIn2.join('')}concat=n=2:v=1:a=${tracks}${outs.join('')}`);
  const srcKbps = Math.max(fi.video.bitRate || 0, si.video.bitRate || 0) / 1000;
  const args = [
    '-hide_banner', '-nostats', '-loglevel', 'error', '-y',
    '-i', first.path, '-i', second.path,
    '-filter_complex', f.join(';'),
    '-map', '[v]',
    ...videoArgs(videoEncoder, srcKbps, fi.video.codec),
  ];
  if (fps > 0) args.push('-fps_mode', 'cfr', '-r', String(Math.round(fps * 1000) / 1000));
  for (let i = 0; i < tracks; i++) {
    const t = fi.audio[i];
    args.push('-map', `[oa${i}]`);
    args.push(`-c:a:${i}`, audioEncoder, `-b:a:${i}`, `${audioKbps(t.bitRate)}k`);
    if (t.title) args.push(`-metadata:s:a:${i}`, `title=${t.title}`);
    if (t.handler) args.push(`-metadata:s:a:${i}`, `handler_name=${t.handler}`);
    if (t.language) args.push(`-metadata:s:a:${i}`, `language=${t.language}`);
    args.push(`-disposition:a:${i}`, t.isDefault ? 'default' : '0');
  }
  args.push('-map_metadata', '0', '-movflags', '+faststart', '-progress', 'pipe:1', '-f', 'mp4', output);
  return args;
}

function runWithProgress(args, totalSeconds, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line) || /^out_time_ms=(\d+)/.exec(line);
        if (m && totalSeconds > 0 && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / totalSeconds));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split(/\r?\n/).slice(-2).join(' ')}`.slice(0, 600)), { stderr }));
    });
  });
}

/** cut points snapped to frame boundaries; `offset` is where second starts inside first */
function mergePlan(first, second, offset) {
  const fv = first.info.video;
  const sv = second.info.video;
  const cutRaw = Math.min(first.info.duration, fv.duration || first.info.duration);
  const cut = snapDown(cutRaw, fv.startTime || 0, fv.fps);
  const from = snapUp(Math.max(0, cut - offset), sv.startTime || 0, sv.fps);
  const secondEnd = Math.min(second.info.duration, (sv.startTime || 0) + (sv.duration || second.info.duration));
  const expected = cut - (fv.startTime || 0) + Math.max(0, secondEnd - from);
  return { cut, from, expected, secondTail: secondEnd - from };
}

async function encodeMerge({ first, second, offset, output, nvencAvailable, audioEncoder, onProgress }) {
  const plan = mergePlan(first, second, offset);
  const chain = await videoEncoderChain(first.info.video.codec, nvencAvailable);
  let lastError = null;
  for (const videoEncoder of chain) {
    try {
      const args = buildMergeArgs({ first, second, cut: plan.cut, from: plan.from, videoEncoder, audioEncoder, output });
      await runWithProgress(args, plan.expected, onProgress);
      return { ...plan, videoEncoder };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Merge encode failed');
}

/** latest keyframe at or before t, decoding keyframes only over a short span first */
async function keyframeAtOrBefore(file, t) {
  const read = async (from) => {
    const out = await run(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
      '-show_entries', 'frame=pts_time,best_effort_timestamp_time',
      '-read_intervals', `${from.toFixed(3)}%${(t + 0.05).toFixed(3)}`,
      '-of', 'json', file,
    ]);
    const frames = JSON.parse(out || '{}').frames || [];
    let best = null;
    for (const fr of frames) {
      const ts = numOr(fr.pts_time, numOr(fr.best_effort_timestamp_time));
      if (ts != null && ts <= t + 1e-3 && (best == null || ts > best)) best = ts;
    }
    return best;
  };
  if (t <= 0) return 0;
  let kf = await read(Math.max(0, t - 15));
  if (kf == null && t > 15) kf = await read(0);
  return kf == null ? 0 : Math.max(0, kf);
}

/** lossless cut starting on keyframe kf; the epsilon keeps a rounded-down pts from seeking one gop back */
async function streamCopyCut(file, kf, end, output) {
  await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', (kf + 0.0005).toFixed(6), '-i', file,
    '-t', Math.max(0.1, end - kf).toFixed(6),
    '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
    '-f', 'mp4', output,
  ]);
}

module.exports = {
  probeMedia,
  extractPcm,
  xcorr,
  xcorrKernel,
  alignPair,
  encodeMerge,
  mergePlan,
  buildMergeArgs,
  keyframeAtOrBefore,
  streamCopyCut,
  ALIGN_RATE,
};
