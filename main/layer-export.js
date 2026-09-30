/** turns a clip's layers into ffmpeg filters for export: volume layers become volume filters on
 * the right audio chain, text/gif/image layers become overlay inputs burned onto the video. blur and
 * zoom change the frame before the retime, speed layers retime video and audio, sound layers are
 * mixed in after the retime so they play at normal speed.
 *
 *   [0:v] blur boxes, zoom (source time)  setpts retime  scale  overlays (output time)
 *   [0:a] track volumes + volume layers (source time)  atrim/atempo per piece  + sounds */
const fs = require('fs').promises;
const logger = require('../utils/logger');

const OVERLAY_KINDS = new Set(['text', 'gif', 'image']);
const FILE_KINDS = new Set(['gif', 'image', 'sound']);

/** the clip's layers for an export, minus layers whose file is gone. a bad layers file
 * costs the layers, never the export */
async function loadExportLayers(clipName, getSettings) {
  let items;
  try {
    items = (await require('./layers').getLayers(clipName, getSettings)).items || [];
  } catch (error) {
    logger.error('Error reading layers:', error);
    return [];
  }
  const out = [];
  for (const l of items) {
    if (l.kind === 'text' || FILE_KINDS.has(l.kind)) {
      const file = l.kind === 'text' ? l.raster?.file : l.file;
      if (!file) continue;
      try {
        await fs.access(file);
      } catch {
        continue;
      }
    }
    out.push(l);
  }
  return out;
}

// expressions take offsets relative to the export start, which can be negative
const fx = (n) => `(${Number(n).toFixed(4)})`;

/** source seconds (relative to the export start) to output seconds, with the clip's speed and its
 * speed layers. speed layers multiply where they overlap, same as rateAt in the player's model.ts.
 * outside the export the edge rates carry on, so layers hanging over an edge still map */
function buildTimeMap(layers, start, duration, speed) {
  const sp = Number(speed) > 0 ? Number(speed) : 1;
  const segs = (layers || []).filter(
    (l) => l.kind === 'speed' && l.end - start > 0 && l.start - start < duration && Math.abs(l.rate - 1) > 0.001
  );
  const cuts = new Set([0, duration]);
  for (const l of segs) {
    for (const x of [l.start - start, l.end - start]) if (x > 0 && x < duration) cuts.add(x);
  }
  const xs = [...cuts].sort((a, b) => a - b);
  const factorAt = (x) => segs.reduce((r, l) => (x >= l.start - start && x < l.end - start ? r * l.rate : r), 1);
  const pieces = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i];
    const b = xs[i + 1];
    if (b - a < 0.0001) continue;
    const rate = sp * factorAt((a + b) / 2);
    const last = pieces[pieces.length - 1];
    if (last && Math.abs(last.rate - rate) < 1e-6) last.b = b;
    else pieces.push({ a, b, rate, c: 0 });
  }
  if (!pieces.length) pieces.push({ a: 0, b: duration, rate: sp, c: 0 });
  let acc = 0;
  for (const p of pieces) {
    p.c = acc;
    acc += (p.b - p.a) / p.rate;
  }
  const outDur = acc;
  const pieceAt = (x) => pieces.find((p) => x < p.b) || pieces[pieces.length - 1];
  const out = (x) => {
    if (x <= 0) return x / pieces[0].rate;
    const p = pieceAt(x);
    return p.c + (x - p.a) / p.rate;
  };
  const rateAt = (x) => (x <= 0 ? pieces[0] : pieceAt(x)).rate;
  // one piecewise-linear setpts; T is the frame's time after the input seek, starting at 0
  let expr = `(T-${fx(pieces[pieces.length - 1].a)})/${pieces[pieces.length - 1].rate.toFixed(6)}+${fx(pieces[pieces.length - 1].c)}`;
  for (let i = pieces.length - 2; i >= 0; i--) {
    const p = pieces[i];
    expr = `if(lt(T,${fx(p.b)}),(T-${fx(p.a)})/${p.rate.toFixed(6)}+${fx(p.c)},${expr})`;
  }
  return { segmented: segs.length > 0, pieces, outDur, out, rateAt, setpts: `setpts='(${expr})/TB'` };
}

/** atempo per instance only goes down to 0.5, slower rates chain it */
function atempoChain(rate) {
  const out = [];
  let r = rate;
  while (r < 0.5 - 1e-9) {
    out.push('atempo=0.5');
    r /= 0.5;
  }
  if (Math.abs(r - 1) > 0.001) out.push(`atempo=${r.toFixed(6)}`);
  return out;
}

/** [inLabel] retimed by the speed pieces into [aret]; each piece is cut out and stretched on its own */
function retimeAudio(inLabel, tmap) {
  const parts = [];
  const { pieces } = tmap;
  if (pieces.length === 1) {
    const chain = atempoChain(pieces[0].rate);
    parts.push(`[${inLabel}]${chain.length ? chain.join(',') : 'anull'}[aret]`);
    return { parts, out: 'aret' };
  }
  parts.push(`[${inLabel}]asplit=${pieces.length}${pieces.map((_, i) => `[ra${i}]`).join('')}`);
  pieces.forEach((p, i) => {
    const f = [`atrim=start=${p.a.toFixed(4)}:end=${p.b.toFixed(4)}`, 'asetpts=PTS-STARTPTS', ...atempoChain(p.rate)];
    parts.push(`[ra${i}]${f.join(',')}[rb${i}]`);
  });
  parts.push(`${pieces.map((_, i) => `[rb${i}]`).join('')}concat=n=${pieces.length}:v=0:a=1[aret]`);
  return { parts, out: 'aret' };
}

/** sound layers that play inside the export, in output seconds. off is where in the file it starts */
function planSounds(layers, start, duration, tmap) {
  const out = [];
  for (const l of layers || []) {
    if (l.kind !== 'sound' || !l.file) continue;
    const a = l.start - start;
    const b = l.end - start;
    if (b <= 0 || a >= duration) continue;
    const at = tmap.out(Math.max(0, a));
    const off = at - tmap.out(a);
    let len = tmap.out(Math.min(b, duration)) - at;
    if (l.duration > 0) len = Math.min(len, l.duration - off);
    if (len <= 0.02) continue;
    out.push({ path: l.file, at, off, len, level: l.level, fade: l.fade, fadeIn: a >= 0, fadeOut: b <= duration });
  }
  return out;
}

/** mixes planned sounds (inputs from firstInput on) into [inLabel], normal speed, into [asnd] */
function mixSounds(inLabel, sounds, firstInput) {
  const parts = [];
  sounds.forEach((s, k) => {
    const f = [`atrim=start=${s.off.toFixed(4)}:duration=${s.len.toFixed(4)}`, 'asetpts=PTS-STARTPTS', `volume=${Number(s.level).toFixed(4)}`];
    const fd = Math.min(s.fade, s.len / 2);
    if (fd > 0 && s.fadeIn) f.push(`afade=t=in:st=0:d=${fd.toFixed(4)}`);
    if (fd > 0 && s.fadeOut) f.push(`afade=t=out:st=${(s.len - fd).toFixed(4)}:d=${fd.toFixed(4)}`);
    f.push(`adelay=${Math.round(s.at * 1000)}:all=1`);
    parts.push(`[${firstInput + k}:a]${f.join(',')}[snd${k}]`);
  });
  parts.push(`[${inLabel}]${sounds.map((_, k) => `[snd${k}]`).join('')}amix=inputs=${sounds.length + 1}:normalize=0:duration=first[asnd]`);
  return { parts, out: 'asnd' };
}

/** volume filters for the volume layers on one audio chain, in source seconds (before atempo).
 * same envelope as the player: linear ramp of fade seconds at both ends */
function volumeLayerFilters(layers, start, duration, matchTrack) {
  const out = [];
  for (const l of layers || []) {
    if (l.kind !== 'volume' || !matchTrack(l.track)) continue;
    const a = l.start - start;
    const b = l.end - start;
    if (b <= 0 || a >= duration || Math.abs(l.level - 1) < 0.001) continue;
    const level = Number(l.level).toFixed(4);
    if (l.fade > 0) {
      const f = Math.max(0.01, Math.min(l.fade, (b - a) / 2)).toFixed(4);
      out.push(`volume='if(between(t,${fx(a)},${fx(b)}),1+(${level}-1)*min(1,min((t-${fx(a)})/${f},(${fx(b)}-t)/${f})),1)':eval=frame`);
    } else {
      out.push(`volume=${level}:enable='between(t,${fx(a)},${fx(b)})'`);
    }
  }
  return out;
}

// blur radius and pixel block in frame widths at full strength, fx.tsx in the player uses the same
const BLUR_SIGMA = 0.02;
const PIXEL_BLOCK = 0.05;
const ZOOM_MIN = 1.1;
const ZOOM_MAX = 4;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

/** one channel of a zoom's keys over export time: the first key plus a smoothstepped step per pair,
 * the same sum zoomView in model.ts adds up. var 1 holds the step's progress so it is written once */
function keyExpr(keys, a, pick) {
  let out = pick(keys[0]).toFixed(5);
  for (let i = 0; i + 1 < keys.length; i++) {
    const d = pick(keys[i + 1]) - pick(keys[i]);
    if (Math.abs(d) < 1e-6) continue;
    const len = Math.max(1e-3, keys[i + 1].t - keys[i].t);
    out += `+(${d.toFixed(5)})*(st(1,clip((t-${fx(a + keys[i].t)})/${len.toFixed(4)},0,1));ld(1)*ld(1)*(3-2*ld(1)))`;
  }
  return `(${out})`;
}

/** blur boxes then the zoom, on [0:v:0] in source pixels and source seconds, ending in [vfx]. null
 * when the clip has neither. mirrors zoomAt in the player's model.ts and BlurBox in fx.tsx */
function buildFxGraph({ layers, start, duration, width, height }) {
  const W = Number(width) || 1920;
  const H = Number(height) || 1080;
  const inside = (l) => l.end - start > 0 && l.start - start < duration;
  const blurs = (layers || []).filter((l) => l.kind === 'blur' && inside(l));
  const zooms = (layers || []).filter((l) => l.kind === 'zoom' && inside(l));
  if (!blurs.length && !zooms.length) return null;
  const chains = [];
  let cur = '0:v:0';

  blurs.forEach((l, i) => {
    const a = l.start - start;
    const b = l.end - start;
    const bw = Math.min(even((l.w / 100) * W), even(W) - 2);
    const bh = Math.min(even((l.h / 100) * H), even(H) - 2);
    const bx = clamp(even(((l.x - l.w / 2) / 100) * W), 0, W - bw);
    const by = clamp(even(((l.y - l.h / 2) / 100) * H), 0, H - bh);
    let fxChain;
    if (l.mode === 'pixelate') {
      const block = Math.max(2, Math.min(1024, Math.round(l.strength * PIXEL_BLOCK * W)));
      fxChain = `crop=${bw}:${bh}:${bx}:${by},pixelize=w=${block}:h=${block}`;
    } else {
      // blur with a margin of two radii around the box and cut it back, so the edges pull in the
      // pixels around the box like the player's canvas does
      const sigma = Math.max(1, Math.min(1024, l.strength * BLUR_SIGMA * W));
      const m = even(sigma * 2);
      const mx = clamp(bx - m, 0, bx);
      const my = clamp(by - m, 0, by);
      const mw = Math.min(W, bx + bw + m) - mx;
      const mh = Math.min(H, by + bh + m) - my;
      fxChain = `crop=${mw}:${mh}:${mx}:${my},gblur=sigma=${sigma.toFixed(2)},crop=${bw}:${bh}:${bx - mx}:${by - my}`;
    }
    const next = `fxb${i}`;
    chains.push(`[${cur}]split=2[fxs${i}][fxc${i}]`);
    chains.push(`[fxc${i}]${fxChain}[fxp${i}]`);
    chains.push(`[fxs${i}][fxp${i}]overlay=x=${bx}:y=${by}:enable='between(t,${fx(a)},${fx(b)})'[${next}]`);
    cur = next;
  });

  if (zooms.length) {
    const zt = [];
    const xt = [];
    const yt = [];
    for (const l of zooms) {
      const a = l.start - start;
      const b = l.end - start;
      const d = Math.min(Number(l.ease) || 0, (b - a) / 2);
      const P = `clip(min((t-${fx(a)})/${d.toFixed(4)},(${fx(b)}-t)/${d.toFixed(4)}),0,1)`;
      // smoothstep, the player eases the same way
      const e = d > 0 ? `(${P}*${P}*(3-2*${P}))` : `between(t,${fx(a)},${fx(b)})`;
      const keys = Array.isArray(l.keys) ? l.keys : [];
      if (keys.length > 1) {
        // the view moves: z, x and y are expressions of t. var 0 holds z, the offset is the
        // centre kept inside the frame times z less half a frame, the anchor math of the static
        // case below with (z-1) cancelled out
        const Z = keyExpr(keys, a, (k) => clamp(k.scale, ZOOM_MIN, ZOOM_MAX));
        const off = (c) => `(st(0,${Z});(clip(${keyExpr(keys, a, (k) => k[c] / 100)},0.5/ld(0),1-0.5/ld(0))*ld(0)-0.5)*${e})`;
        zt.push(`(${Z}-1)*${e}`);
        xt.push(off('x'));
        yt.push(off('y'));
        continue;
      }
      const view = keys[0] || l;
      const z = clamp(view.scale, ZOOM_MIN, ZOOM_MAX);
      const k = z - 1;
      const half = 0.5 / z;
      const px = (clamp(view.x / 100, half, 1 - half) * z - 0.5) / k;
      const py = (clamp(view.y / 100, half, 1 - half) * z - 0.5) / k;
      zt.push(`${k.toFixed(5)}*${e}`);
      xt.push(`${(px * k).toFixed(5)}*${e}`);
      yt.push(`${(py * k).toFixed(5)}*${e}`);
    }
    const Z = `(1+${zt.join('+')})`;
    // scaled up by Z, then cut back to the frame at the anchor's offset
    chains.push(
      `[${cur}]scale=w='2*trunc(${W}*${Z}/2)':h='2*trunc(${H}*${Z}/2)':eval=frame:flags=bicubic,` +
      `crop=${W}:${H}:x='clip(${W}*(${xt.join('+')}),0,iw-ow)':y='clip(${H}*(${yt.join('+')}),0,ih-oh)'[vfx]`
    );
  } else {
    chains.push(`[${cur}]null[vfx]`);
  }
  return { chains, out: 'vfx' };
}

// show/hide animation length in clip seconds, the player uses the same
const ANIM_S = 0.35;
// these fade while they move or scale; wipe and type reveal instead
const FADES = ['fade', 'pop', 'zoom', 'slide', 'drop', 'side'];
// travel in fractions of the frame width, same as model.ts in the player
const RISE = 0.03;
const SIDE = 0.04;

/** extra inputs and filter chains that burn the visual layers onto [vbase], ending in [vout].
 * times are output seconds (after speed and speed layers), sizes follow the output frame. null
 * when nothing shows */
function buildOverlayGraph({ layers, start, duration, speed, outW, outH, fps, tmap = buildTimeMap(layers, start, duration, speed) }) {
  const outDur = tmap.outDur;
  const inputs = [];
  const chains = [];
  let base = 'vbase';
  const visible = (layers || []).filter((l) => {
    if (!OVERLAY_KINDS.has(l.kind)) return false;
    const s = tmap.out(l.start - start);
    const e = tmap.out(l.end - start);
    return e > 0.02 && s < outDur - 0.02;
  });
  visible.forEach((l, k) => {
    const sr = tmap.out(l.start - start);
    const er = tmap.out(l.end - start);
    const s = Math.max(0, sr);
    const e = Math.min(outDur, er);
    // animations keep their clip-second length at the speed their edge plays at, like the player
    const rIn = tmap.rateAt(l.start - start);
    const rOut = tmap.rateAt(l.end - start - 0.001);
    const dIn = Math.max(0.01, Math.min((l.din ?? ANIM_S) / rIn, (er - sr) / 2));
    const dOut = Math.max(0.01, Math.min((l.dout ?? ANIM_S) / rOut, (er - sr) / 2));
    const len = (e - s + 0.2).toFixed(3);
    if (l.kind === 'gif') {
      inputs.push({ path: l.file, options: ['-ignore_loop 0', `-t ${len}`] });
    } else {
      const file = l.kind === 'text' ? l.raster.file : l.file;
      inputs.push({ path: file, options: ['-loop 1', `-framerate ${Math.max(1, Math.round(fps))}`, `-t ${len}`] });
    }

    const w0 = Math.max(2, Math.round(l.kind === 'text' ? l.raster.w * (outW / l.raster.refW) : (l.w / 100) * outW));
    const f = ['format=rgba'];
    if (Number.isFinite(l.opacity) && l.opacity < 1) f.push(`colorchannelmixer=aa=${l.opacity.toFixed(3)}`);
    const P = `clip((t-${fx(sr)})/${dIn.toFixed(4)},0,1)`;
    const Q = `clip((${fx(er)}-t)/${dOut.toFixed(4)},0,1)`;
    // back-out ease from 0.4 to 1, overshoots a little like the player's pop
    const back = (p) => `(0.4+0.6*(1+2.70158*pow(${p}-1,3)+1.70158*pow(${p}-1,2)))`;
    const away = (p) => `pow(1-${p},3)`;
    // an animation only plays when its edge falls inside the export
    const animIn = sr >= 0 ? l.ain : 'none';
    const animOut = er <= outDur ? l.aout : 'none';

    // reveals cut alpha by column. before setpts: geq's T ignores that shift, so it runs on the
    // input's own clock where the layer starts at 0 and ends at e - s
    const cuts = [];
    if (animIn === 'type' && l.kind === 'text') {
      const n = Math.max(1, Array.from(l.text || '').length);
      const td = (Math.max(0.5, n * 0.05) / rIn).toFixed(4);
      cuts.push(`lt(X,W*floor(clip(T/${td},0,1)*${n})/${n})`);
    } else if (animIn === 'wipe') {
      cuts.push(`lt(X,W*clip(T/${dIn.toFixed(4)},0,1))`);
    }
    if (animOut === 'wipe') cuts.push(`gte(X,W*(1-clip((${(er - s).toFixed(4)}-T)/${dOut.toFixed(4)},0,1)))`);
    if (cuts.length) f.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(${cuts.join('*')},alpha(X,Y),0)'`);
    f.push(`setpts=PTS-STARTPTS+${s.toFixed(4)}/TB`);

    const scales = [];
    if (animIn === 'pop') scales.push(back(P));
    if (animOut === 'pop') scales.push(back(Q));
    if (animIn === 'zoom') scales.push(`(1+0.6*${away(P)})`);
    if (animOut === 'zoom') scales.push(`(1+0.6*${away(Q)})`);
    if (scales.length) f.push(`scale=w='max(2,trunc(${w0}*${scales.join('*')}))':h=-1:eval=frame`);
    else f.push(`scale=${w0}:-1`);
    // pop only fades over the first 40% of its length, the scale carries the rest
    const fadeLen = (kind, d) => (kind === 'pop' ? d * 0.4 : d);
    if (FADES.includes(animIn)) f.push(`fade=t=in:st=${sr.toFixed(4)}:d=${fadeLen(animIn, dIn).toFixed(4)}:alpha=1`);
    if (FADES.includes(animOut)) {
      const fl = fadeLen(animOut, dOut);
      f.push(`fade=t=out:st=${Math.max(0, er - fl).toFixed(4)}:d=${fl.toFixed(4)}:alpha=1`);
    }
    chains.push(`[${k + 1}:v]${f.join(',')}[lo${k}]`);

    // moves keep going the same way: rise comes up from below and leaves upwards, drop falls in
    // and falls out, slide goes left to right
    const rise = (RISE * outW).toFixed(2);
    const side = (SIDE * outW).toFixed(2);
    let x = `${((l.x / 100) * outW).toFixed(2)}-w/2`;
    let y = `${((l.y / 100) * outH).toFixed(2)}-h/2`;
    if (animIn === 'slide') y += `+${rise}*${away(P)}`;
    if (animOut === 'slide') y += `-${rise}*${away(Q)}`;
    if (animIn === 'drop') y += `-${rise}*${away(P)}`;
    if (animOut === 'drop') y += `+${rise}*${away(Q)}`;
    if (animIn === 'side') x += `-${side}*${away(P)}`;
    if (animOut === 'side') x += `+${side}*${away(Q)}`;
    const next = k === visible.length - 1 ? 'vout' : `lb${k}`;
    chains.push(`[${base}][lo${k}]overlay=x='${x}':y='${y}':eval=frame:enable='between(t,${s.toFixed(4)},${e.toFixed(4)})':eof_action=pass[${next}]`);
    base = next;
  });
  if (!inputs.length) return null;
  return { inputs, chains };
}

module.exports = {
  loadExportLayers,
  volumeLayerFilters,
  buildOverlayGraph,
  buildFxGraph,
  buildTimeMap,
  atempoChain,
  retimeAudio,
  planSounds,
  mixSounds,
  ANIM_S,
};
