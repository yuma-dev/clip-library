const layer = name => `[data-layer="${name}"]`;
const keys = (...pairs) => pairs.map(([time, value, easing]) => ({ time, value, ...(easing ? { easing } : {}) }));
export const presets = ['player-trim', 'clip-tag', 'audio-mixer'];

export function preset(name, thumbnail) {
  const fixture = { clip: { originalName: 'demo.mp4', customName: 'The perfect moment', createdAt: Date.UTC(2026, 0, 1), thumbnailPath: thumbnail, isTrimmed: false, tags: [] } };
  const base = { version: 1, background: '#111114', fixtures: [fixture], viewport: { width: 1280, height: 900 } };
  if (name === 'player-trim') return { ...base, viewport:{width:2400,height:1640}, captureScale:1.5, scene: 'videoPlayer', props: { thumbnail, title: 'The perfect moment', width: 1728, pad: 300, durationSeconds: 30, currentSeconds: 12 },
    layers: { composite: null, background: layer('background'), glow:layer('glow'), shadow: layer('shadow'), surface: { selector: layer('card'), exclude: ['#video-container'] }, footage: layer('thumbnail'), controls: { selector: layer('controls'), exclude: ['#top-controls', '#bottom-controls'] }, title: layer('title'), actions: layer('actions'), playback: '.playback-row', trim: layer('progress'), times: layer('times'), cursor: layer('cursor') },
    timeline: { duration: 5, fps: 30, tracks: [
      { path: 'props.trimStart', keys: keys([0, 0], [1, 0], [2.3, 6], [5, 6]) },
      { path: 'props.trimEnd', keys: keys([0, 30], [3, 30], [4.3, 22], [5, 22]) },
    ], cursor: [
      { time: 0, x: 300, y: 320 }, { time: 0.8, target: '#trim-start' },
      { time: 1, target: '#trim-start', pressed: true }, { time: 2.3, target: '#trim-start', pressed: true },
      { time: 2.5, target: '#trim-start' }, { time: 2.9, target: '#trim-end' },
      { time: 3, target: '#trim-end', pressed: true }, { time: 4.3, target: '#trim-end', pressed: true },
      { time: 4.5, target: '#trim-end' }, { time: 5, x: 1030, y: 670 },
    ] } };
  if (name === 'clip-tag') return { ...base, scene: 'clipTag', props: { menu: 'closed', hover:1, globalTags: ['Highlight', 'Favorite', 'Share'] },
    layers: { composite: null, background: layer('background'), glow:{selector:layer('glow'),blend:'screen'}, card: layer('clip'), menu: layer('menu'), cursor: layer('cursor') },
    timeline: { duration: 5, fps: 30, tracks: [
      { path: 'props.menu', keys: keys([0, 'closed'], [1, 'root'], [2, 'tags'], [3.8, 'closed']) },
      { path: 'fixtures.0.clip.tags', keys: keys([0, []], [3, ['Highlight']]) },
    ], cursor: [
      { time: 0, x: 90, y: 520 }, { time: 0.8, x: 460, y: 330 },
      { time: 1, x: 460, y: 330, pressed: true, button: 'right' }, { time: 1.2, x: 460, y: 330 },
      { time: 1.8, x: 550, y: 390 }, { time: 2, x: 550, y: 390, pressed: true },
      { time: 2.2, x: 550, y: 390 }, { time: 2.8, x: 550, y: 423 },
      { time: 3, x: 550, y: 423, pressed: true }, { time: 3.2, x: 550, y: 423 },
      { time: 3.7, x: 840, y: 500 }, { time: 3.8, x: 840, y: 500, pressed: true }, { time: 4, x: 840, y: 500 },
    ] } };
  if (name === 'audio-mixer') return { ...base, scene: 'audioMixer', props: { tracks: [{ ordinal: 0, name: 'Game', volume: 0.8, color: '#a78bfa' }, { ordinal: 1, name: 'Microphone', volume: 1, color: '#60a5fa' }] }, layers: { composite: null, background: layer('background'), panel: { selector: layer('panel'), exclude: [layer('row-0'), layer('row-1')] }, game: layer('row-0'), microphone: layer('row-1') }, timeline: { duration: 3, fps: 30, tracks: [{ path: 'props.tracks.0.volume', keys: keys([0, 0.8], [1, 0.8], [2, 1.4], [3, 1.4]) }] } };
  throw Error(`unknown preset: ${name}`);
}
