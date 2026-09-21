import path from 'node:path';

export const formats = ['png', 'jpg', 'webp', 'frames', 'mp4', 'mov', 'webm'];
export const sceneIds = ['clipCard', 'videoPlayer', 'audioMixer', 'clipTag', 'clipWorkflow', 'mentions', 'mixerPlayer', 'settings', 'librarySearch', 'hero', 'pillPlayer'];
export function validate(spec) {
  if (!spec || !sceneIds.includes(spec.scene)) throw Error('unknown scene');
  if (spec.version !== undefined && spec.version !== 1) throw Error('unsupported recipe version');
  if (spec.captureScale !== undefined && (!Number.isFinite(spec.captureScale) || spec.captureScale <= 0 || spec.captureScale > 4)) throw Error('captureScale must be greater than 0 and at most 4');
  if (!Array.isArray(spec.fixtures)) throw Error('fixtures must be an array');
  if (spec.viewport && (!Number.isInteger(spec.viewport.width) || !Number.isInteger(spec.viewport.height) || spec.viewport.width < 1 || spec.viewport.height < 1)) throw Error('viewport needs positive integer dimensions');
  if (['clipCard', 'clipTag', 'clipWorkflow', 'mentions'].includes(spec.scene) && !spec.fixtures.length) throw Error('scene needs a clip fixture');
  if (spec.media && (spec.media.kind === 'color' ? !/^#[0-9a-f]{6}$/i.test(spec.media.color ?? '') : spec.media.kind !== 'clip' || !spec.media.path)) throw Error('invalid media source');
  for (const [name, layer] of Object.entries(spec.layers ?? {})) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw Error(`unsafe layer name: ${name}`);
    if (layer !== null && typeof layer !== 'string' && !(layer && typeof layer.selector === 'string' && (!layer.exclude || Array.isArray(layer.exclude) && layer.exclude.every(x => typeof x === 'string')))) throw Error(`invalid layer: ${name}`);
  }
  const timeline = spec.timeline;
  if (!timeline) return;
  if (!Number.isFinite(timeline.duration) || timeline.duration <= 0) throw Error('duration must be positive');
  if (timeline.fps !== undefined && (!Number.isInteger(timeline.fps) || timeline.fps < 1 || timeline.fps > 120)) throw Error('fps must be 1..120');
  const checkKeys = keys => {
    if (!Array.isArray(keys) || !keys.length) throw Error('empty keyframes');
    let previous = -1;
    for (const key of keys) {
      if (!Number.isFinite(key.time) || key.time < 0 || key.time <= previous || key.time > timeline.duration) throw Error('keyframe times must increase within duration');
      previous = key.time;
    }
  };
  for (const track of timeline.tracks ?? []) {
    if (track.step !== undefined && (!Number.isFinite(track.step) || track.step <= 0)) throw Error('track step must be positive');
    if (!/^(props|fixtures|background|card)(\.[a-zA-Z0-9_]+)*$/.test(track.path) || track.path.split('.').some(x => ['__proto__', 'constructor', 'prototype'].includes(x))) throw Error(`unsafe track path: ${track.path}`);
    checkKeys(track.keys);
    for (const key of track.keys) {
      if (!Object.hasOwn(key, 'value')) throw Error('keyframe needs a value');
      if (key.easing && !['linear', 'smooth', 'hold'].includes(key.easing)) throw Error('unknown easing');
    }
  }
  if (timeline.cursor) {
    checkKeys(timeline.cursor);
    for (const key of timeline.cursor) {
      if (!key.target && (!Number.isFinite(key.x) || !Number.isFinite(key.y))) throw Error('cursor needs target or x/y');
    }
  }
}

export function localOutput(root, candidate) {
  const base = path.resolve(root, 'export-out');
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('output must be a subdirectory of export-out');
  return target;
}
