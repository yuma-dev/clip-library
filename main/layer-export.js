/** turns a clip's layers into ffmpeg filters for export: volume layers become volume filters on
 * the right audio chain, text/gif/image layers become overlay inputs burned onto the video */
const fs = require('fs').promises;
const logger = require('../utils/logger');

/** the clip's layers for an export, minus visuals whose file is gone. a bad layers file
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
    if (l.kind !== 'volume') {
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

// show/hide animation length in clip seconds, the player uses the same
const ANIM_S = 0.35;
// these fade while they move or scale; wipe and type reveal instead
const FADES = ['fade', 'pop', 'zoom', 'slide', 'drop', 'side'];
// travel in fractions of the frame width, same as model.ts in the player
const RISE = 0.03;
const SIDE = 0.04;

/** extra inputs and filter chains that burn the visual layers onto [vbase], ending in [vout].
 * times are output seconds (after speed), sizes follow the output frame. null when nothing shows */
function buildOverlayGraph({ layers, start, duration, speed, outW, outH, fps }) {
  const outDur = duration / speed;
  const inputs = [];
  const chains = [];
  let base = 'vbase';
  const visible = (layers || []).filter((l) => {
    if (l.kind === 'volume') return false;
    const s = (l.start - start) / speed;
    const e = (l.end - start) / speed;
    return e > 0.02 && s < outDur - 0.02;
  });
  visible.forEach((l, k) => {
    const sr = (l.start - start) / speed;
    const er = (l.end - start) / speed;
    const s = Math.max(0, sr);
    const e = Math.min(outDur, er);
    const dIn = Math.max(0.01, Math.min((l.din ?? ANIM_S) / speed, (er - sr) / 2));
    const dOut = Math.max(0.01, Math.min((l.dout ?? ANIM_S) / speed, (er - sr) / 2));
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
      const td = (Math.max(0.5, n * 0.05) / speed).toFixed(4);
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

module.exports = { loadExportLayers, volumeLayerFilters, buildOverlayGraph, ANIM_S };
