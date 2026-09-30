/** automatic subtitles: whisper.cpp with the large-v3 model, fully local. engine, model and a
 * silero vad model are fetched into userData/whisper on first use (~674 MB zip, 1.08 GB, 1 MB),
 * then a track's audio is cut to 16 kHz mono and transcribed into short timed lines the player
 * turns into text layers */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn, execFile } = require('child_process');
const { app } = require('electron');
const logger = require('../utils/logger');

// pinned so a new upstream layout can't break installs; bump together after checking the zip.
// the 11.8 build ships ggml-cuda.dll without cublas, so it silently ran on the cpu
const BIN_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-12.4.0-bin-x64.zip';
const CUDA_DLL = 'cublas64_12.dll';
// full large-v3 over turbo: slower, and better on slang and anything not english
const MODEL_FILE = 'ggml-large-v3-q5_0.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;
const MODEL_BYTES = 1081140203;
// earlier installs, dropped when the current model lands
const OLD_MODELS = ['ggml-large-v3-turbo-q5_0.bin'];
// only speech goes to whisper; silence and game noise are where it makes up lines
const VAD_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin';
const VAD_BYTES = 885098;
// longest caption line in characters
const MAX_LINE = 42;

const root = () => path.join(app.getPath('userData'), 'whisper');
const modelPath = () => path.join(root(), MODEL_FILE);
const vadPath = () => path.join(root(), 'ggml-silero-v6.2.0.bin');

const sizeIs = async (file, bytes) => {
  try {
    return (await fsp.stat(file)).size === bytes;
  } catch {
    return false;
  }
};

async function findCli(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === 'whisper-cli.exe') return p;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = await findCli(path.join(dir, e.name));
    if (found) return found;
  }
  return null;
}

/** the engine counts only with its cuda libraries and the vad tool next to it */
async function engine() {
  const cli = await findCli(path.join(root(), 'bin'));
  if (!cli) return null;
  try {
    await fsp.access(path.join(path.dirname(cli), CUDA_DLL));
    await fsp.access(path.join(path.dirname(cli), 'whisper-vad-speech-segments.exe'));
    return cli;
  } catch {
    return null;
  }
}

/** everything back to a fresh install, the dev panel uses it to see the first run again */
async function uninstall() {
  if (installing) throw new Error('Still installing');
  await fsp.rm(root(), { recursive: true, force: true });
  return status();
}

async function status() {
  const cli = Boolean(await engine());
  const model = (await sizeIs(modelPath(), MODEL_BYTES)) && (await sizeIs(vadPath(), VAD_BYTES));
  return { installed: cli && model, cli, model };
}

/** streams url into file, reporting (got, total) bytes; writes to .part first so a cut download
 * never counts */
async function download(url, file, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const part = `${file}.part`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(part);
  let got = 0;
  let last = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (total && now - last > 150) {
        last = now;
        onProgress(got, total);
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (error) {
    out.destroy();
    await fsp.rm(part, { force: true });
    throw error;
  }
  await fsp.rename(part, file);
}

let installing = null;
/** fetches what's missing; onProgress({ step, progress }) with step 'engine' or 'model' */
function install(onProgress) {
  if (installing) return installing;
  installing = (async () => {
    const s = await status();
    if (!s.cli) {
      const zip = path.join(root(), 'whisper-bin.zip');
      await download(BIN_URL, zip, (got, total) => onProgress({ step: 'engine', progress: got / total, got, total }));
      const bin = path.join(root(), 'bin');
      onProgress({ step: 'unpack', progress: 1 });
      await fsp.rm(bin, { recursive: true, force: true });
      await fsp.mkdir(bin, { recursive: true });
      // windows' own bsdtar reads zip, no unzip library in the app
      await new Promise((resolve, reject) =>
        execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', bin], { windowsHide: true }, (err) =>
          err ? reject(err) : resolve()));
      await fsp.rm(zip, { force: true });
      const cli = await engine();
      if (!cli) throw new Error('The speech engine download is incomplete');
      // the zip carries demos and tests next to the tools; only these and the dlls are used
      const keep = new Set(['whisper-cli.exe', 'whisper-vad-speech-segments.exe']);
      for (const name of await fsp.readdir(path.dirname(cli))) {
        if (/\.exe$/i.test(name) && !keep.has(name.toLowerCase())) await fsp.rm(path.join(path.dirname(cli), name), { force: true });
      }
    }
    if (!(await sizeIs(modelPath(), MODEL_BYTES))) {
      await download(MODEL_URL, modelPath(), (got, total) => onProgress({ step: 'model', progress: got / total, got, total }));
    }
    for (const old of OLD_MODELS) await fsp.rm(path.join(root(), old), { force: true });
    if (!(await sizeIs(vadPath(), VAD_BYTES))) await download(VAD_URL, vadPath(), () => {});
    const done = await status();
    if (!done.installed) throw new Error('Speech model did not install completely');
    return done;
  })().finally(() => {
    installing = null;
  });
  return installing;
}

/** 16 kHz mono wav of the chosen streams (mixed when several) over start..end */
function extractAudio(ffmpegPath, input, streams, start, end, wav) {
  const args = ['-y', '-v', 'error', '-ss', String(start), '-t', String(Math.max(0.1, end - start)), '-i', input];
  if (streams.length > 1) {
    const ins = streams.map((s) => `[0:${s}]`).join('');
    args.push('-filter_complex', `${ins}amix=inputs=${streams.length}:normalize=0:duration=longest[a]`, '-map', '[a]');
  } else if (streams.length === 1) {
    args.push('-map', `0:${streams[0]}`);
  } else {
    args.push('-map', '0:a:0');
  }
  args.push('-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav);
  return new Promise((resolve, reject) =>
    execFile(ffmpegPath, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _o, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim().split(/\r?\n/).pop())) : resolve()));
}

// whisper's stock output for silence and noise, never real speech in a game clip
const NOISE = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|\u266a+)\s*$/;
const RATE = 16000;

/** the pcm samples of a 16 bit mono wav; ffmpeg can put a LIST chunk before data */
function pcmOf(wavBuf) {
  let p = 12;
  while (p + 8 <= wavBuf.length) {
    const id = wavBuf.toString('ascii', p, p + 4);
    const size = wavBuf.readUInt32LE(p + 4);
    if (id === 'data') return wavBuf.subarray(p + 8, Math.min(wavBuf.length, p + 8 + size));
    p += 8 + size + (size % 2);
  }
  throw new Error('No audio data in the extracted wav');
}

async function writeWav(file, pcm) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(pcm.length, 40);
  await fsp.writeFile(file, Buffer.concat([head, pcm]));
}

/** runs one of the whisper tools, lines of its output go to onLine as they come */
function runTool(exe, args, onLine = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true });
    let out = '';
    let tail = '';
    let partial = '';
    const onData = (buf) => {
      const text = buf.toString();
      out += text;
      tail = (tail + text).slice(-3000);
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop();
      lines.forEach(onLine);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else {
        logger.error(`[subtitles] ${path.basename(exe)} exited ${code}: ${tail}`);
        reject(new Error(`Transcription failed (exit ${code})`));
      }
    });
  });
}

/** where someone is actually talking, in seconds of the wav. silero hears speech and not the game,
 * which the loudness of the track alone could not tell apart */
async function speech(tools, wav) {
  const out = await runTool(path.join(tools, 'whisper-vad-speech-segments.exe'), [
    '-f', wav,
    '-vm', vadPath(),
    // cpu on purpose: -ug trips a ggml assert in this build, and silero is tiny anyway
    // pauses under 300 ms stay inside one stretch, 80 ms around each so word edges survive
    '-vsd', '300',
    '-vp', '80',
    '-np',
  ]);
  const segs = [];
  for (const m of out.matchAll(/start\s*=\s*([\d.]+),\s*end\s*=\s*([\d.]+)/g)) {
    // the tool prints centiseconds
    segs.push({ start: Number(m[1]) / 100, end: Number(m[2]) / 100 });
  }
  return segs;
}

/** stretches close together share a chunk, so whisper hears whole phrases; long talk is cut so
 * no chunk passes 25 s */
function chunksOf(segs, total) {
  const chunks = [];
  for (const s of segs) {
    const last = chunks[chunks.length - 1];
    if (last && s.start - last.end < 0.6 && s.end - last.start < 25) {
      last.end = s.end;
      last.speech.push(s);
    } else chunks.push({ start: s.start, end: s.end, speech: [s] });
  }
  // a little air on both sides, whisper clips the first and last syllable without it
  return chunks.map((c) => ({ ...c, from: Math.max(0, c.start - 0.2), to: Math.min(total, c.end + 0.2) }));
}

// a line in each language that sounds like people talk, hesitations and all. no "...": whisper
// copies it and then trails every other line off
const FILLERS = {
  de: 'Ähm, äh, also, ja, ne? Hä?',
  en: 'Um, uh, like, yeah, you know? Huh?',
  fr: 'Euh, bah, genre, ouais, tu vois ?',
  es: 'Eh, pues, o sea, sí, ¿sabes?',
  it: 'Ehm, cioè, tipo, sì, capito?',
  pt: 'Hã, tipo, né, sim, sabe?',
  nl: 'Eh, uhm, dus, ja, weet je?',
  pl: 'Yyy, no, znaczy, tak, wiesz?',
};

/** names people in the clip go by, so whisper spells them right instead of guessing */
async function nameHints(clipLocation, clipName) {
  try {
    const raw = await fsp.readFile(path.join(clipLocation, '.clip_metadata', `${clipName.replace(/\//g, '--')}.gameinfo`), 'utf8');
    const people = JSON.parse(raw)?.discord?.participants ?? [];
    const names = new Set();
    for (const p of people) {
      if (p?.bot) continue;
      for (const n of [p?.nick, p?.global_name]) if (typeof n === 'string' && n.trim()) names.add(n.trim());
    }
    return [...names].slice(0, 12);
  } catch {
    return [];
  }
}

/** words into captions of up to two rows: a pause starts a new one, so does a finished sentence
 * once the caption has some length, the two-row cap, and 6 s on screen when nothing else broke
 * it (slow talk without punctuation). rows are balanced at the end */
function toLines(words) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    const gap = cur ? w.from - cur.end : Infinity;
    const sentence = cur && /[.?!]$/.test(cur.text) && (gap > 0.25 || cur.text.length >= 20);
    const long = cur && w.to - cur.start > 6 && cur.text.includes(' ');
    if (!cur || w.chunk !== cur.chunk || gap > 0.6 || sentence || long || cur.text.length + 1 + w.text.length > MAX_LINE * 2) {
      if (cur) lines.push(cur);
      cur = { start: w.from, end: w.to, text: w.text, chunk: w.chunk };
    } else {
      cur.text += ` ${w.text}`;
      cur.end = w.to;
    }
  }
  if (cur) lines.push(cur);
  for (const l of lines) {
    delete l.chunk;
    // whisper opens a line that continues the last with "..."; the line break already says so
    l.text = l.text.replace(/^(\.\.\.|\u2026)\s*/, '');
    if (l.text.length <= MAX_LINE) continue;
    const mid = l.text.length / 2;
    let cut = -1;
    for (let i = 0; i < l.text.length; i++) if (l.text[i] === ' ' && (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid))) cut = i;
    if (cut > 0) l.text = `${l.text.slice(0, cut)}\n${l.text.slice(cut + 1)}`;
  }
  return lines;
}

/** lines of { start, end, text } in clip seconds; language 'auto' detects it once for the track */
async function transcribe({ clipName, streams = [], start = 0, end, language = 'auto' }, getSettings, onProgress) {
  const st = await status();
  if (!st.installed) throw new Error('Speech model is not installed');
  const settings = await getSettings();
  const input = path.join(settings.clipLocation, clipName);
  const { ffmpegPath } = require('./ffmpeg-binaries');
  const cli = await engine();
  const tools = path.dirname(cli);
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'cliplib-subs-'));
  const wav = path.join(work, 'audio.wav');
  try {
    onProgress({ step: 'audio', progress: 0 });
    await extractAudio(ffmpegPath, input, streams, start, end, wav);
    const pcm = pcmOf(await fsp.readFile(wav));
    const total = pcm.length / 2 / RATE;
    const chunks = chunksOf(await speech(tools, wav), total);
    if (!chunks.length) return { lines: [], language };

    // all the speech back to back with quiet between, one pass: whisper keeps the sentence around
    // a lone word, and every word maps back to where its chunk really sits. whisper times run up
    // to a second late, the 2 s gap keeps a late word on the side of its own chunk
    const GAP = 2;
    const gapPcm = Buffer.alloc(Math.round(GAP * RATE) * 2);
    const parts = [];
    let at = 0;
    for (const c of chunks) {
      const piece = pcm.subarray(Math.floor(c.from * RATE) * 2, Math.floor(c.to * RATE) * 2);
      if (parts.length) at += GAP;
      c.at = at;
      c.len = piece.length / 2 / RATE;
      // nothing after the last one: trailing quiet is where whisper makes lines up
      parts.push(...(parts.length ? [gapPcm, piece] : [piece]));
      at += c.len;
    }
    const joined = path.join(work, 'speech.wav');
    await writeWav(joined, Buffer.concat(parts));

    const hints = await nameHints(settings.clipLocation, clipName);
    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
    // the language first, alone: the prompt below is written in it
    let lang = String(language || 'auto');
    if (lang === 'auto') {
      const out = await runTool(cli, ['-m', modelPath(), '-f', joined, '-l', 'auto', '-dl', '-nfa', '-t', threads]);
      lang = out.match(/auto-detected language:\s*([a-z]{2,3})/)?.[1] ?? 'auto';
    }
    // whisper tidies speech up, it drops "ähm" and a repeated "könntest du". a prompt that
    // already talks like that keeps it verbatim; then the names so it spells them right
    const prompt = [FILLERS[lang] ?? '', hints.length ? `${hints.join(', ')}.` : ''].filter(Boolean).join(' ');
    const outBase = path.join(work, 'out');
    const args = [
      '-m', modelPath(),
      '-f', joined,
      '-l', lang,
      // full json carries each token's dtw time: aligned from the model's attention, close to
      // where the word really is. segment times drift by seconds, they only decide nothing here.
      // dtw needs the attention weights, which flash attention never writes out
      '-ojf',
      '-of', outBase,
      '-dtw', 'large.v3',
      '-nfa',
      '-sns',
      '-bs', '5',
      '-bo', '5',
      '-t', threads,
      '-pp',
    ];
    if (prompt) args.push('--prompt', prompt);
    await runTool(cli, args, (line) => {
      const pct = line.match(/progress\s*=\s*(\d+)%/);
      if (pct) onProgress({ step: 'transcribe', progress: Number(pct[1]) / 100 });
    });
    const json = JSON.parse(await fsp.readFile(`${outBase}.json`, 'utf8'));
    if (lang === 'auto') lang = json.result?.language || lang;

    // tokens into words: a leading space starts one, anything else ("isch", ",", "?") belongs to
    // the word before. a word is where its first token is
    const raw = [];
    for (const seg of json.transcription || []) {
      for (const t of seg.tokens || []) {
        const text = String(t.text || '');
        // specials: [_BEG_], timestamps, end of text
        if (!text || text.startsWith('[_') || text.startsWith('<|') || t.id >= 50257) continue;
        const at = Number.isFinite(t.t_dtw) && t.t_dtw >= 0 ? t.t_dtw / 100 : null;
        if (/^\s/.test(text) || !raw.length) raw.push({ text: text.trim(), at });
        else raw[raw.length - 1].text += text;
      }
    }
    const spoken = raw.filter((w) => w.text && !NOISE.test(w.text));
    // a word dtw gave no time takes the one before it, or after it at the very start
    for (let i = 0; i < spoken.length; i++) if (spoken[i].at === null && i > 0) spoken[i].at = spoken[i - 1].at;
    for (let i = spoken.length - 1; i >= 0; i--) if (spoken[i].at === null) spoken[i].at = spoken[i + 1]?.at ?? 0;

    // joined time to clip time, then onto the speech. dtw runs early at the start of a phrase,
    // while whisper still looks at the quiet before it, so a word that lands in quiet (between
    // chunks, in their padding, between stretches) belongs to the next stretch, never the last
    const stretches = chunks.flatMap((c, i) => c.speech.map((g) => ({ ...g, chunk: i })));
    const toClip = (t) => {
      const c = chunks.find((x) => t < x.at + x.len);
      if (!c) return chunks[chunks.length - 1].to;
      return t < c.at ? c.from : c.from + (t - c.at);
    };
    const timed = [];
    let si = 0;
    for (const w of spoken) {
      const t = toClip(w.at);
      // in order: never back to a stretch before the last word's
      while (si < stretches.length - 1 && t >= stretches[si].end - 0.05) si += 1;
      const g = stretches[si];
      const from = Math.min(Math.max(t, g.start), g.end - 0.1);
      timed.push({ from, to: g.end, text: w.text, chunk: g.chunk });
    }
    // a word ends where the next one in its stretch starts, the last one with the stretch
    for (let i = 0; i + 1 < timed.length; i++) {
      const next = timed[i + 1];
      if (next.chunk === timed[i].chunk && next.from < timed[i].to) timed[i].to = Math.max(timed[i].from + 0.08, next.from);
    }
    const lines = toLines(timed).map((l) => ({ ...l, start: start + l.start, end: start + l.end }));
    // a word said in 0.2 s can't be read in 0.2 s: at least a second, never over the next line.
    // a line never starts before the last one ended
    lines.forEach((l, i) => {
      if (i > 0) l.start = Math.max(l.start, lines[i - 1].end);
      const next = lines[i + 1]?.start ?? end;
      l.end = Math.max(l.start + 0.2, l.end, Math.min(l.start + 1, next - 0.05, end));
    });
    return { lines, language: lang };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { status, install, uninstall, transcribe };
