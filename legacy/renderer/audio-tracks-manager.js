/**
 * For multi-audio-track mp4s: one MediaElementSource+GainNode per track, fed by
 * hidden <audio> elements playing pre-extracted .m4a files; mutes <video> and
 * mirrors play/pause/seek/rate, snapping drift > ~60ms. video-player.js owns the
 * master gain node; per-track gains connect into it.
 */

const logger = require('../utils/logger');

const DRIFT_SNAP_THRESHOLD_SEC = 0.08;
const MIRROR_TICK_INTERVAL_MS = 90;
const COLOR_PALETTE = [
  '#3b82f6', '#f43f5e', '#10b981', '#a855f7',
  '#f59e0b', '#06b6d4', '#ec4899', '#84cc16'
];
const BOOSTED_COLOR = '#f59e0b';
const ICON_X = '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// snap to unity (1.0 gain = 100%) within 5%, gives the slider a detent
const detentSnap = (vol) => Math.abs(vol - 1) < 0.05 ? 1 : Math.round(vol * 100) / 100;
// wait this long after seeking last goes false before snapping audio; avoids
// queuing decoder seeks mid-scrub. 'seeked' listener fast-paths the common case
const SEEK_SETTLE_DELAY_MS = 25;
// coalesces the burst of seeks mid-scrub-drag into one snap
const SEEKED_SNAP_DEBOUNCE_MS = 20;
// while video warms up after play()/seek, don't snap audio back (restarts AAC
// decoder mid-syllable, causes stutter); pause it instead until video catches up
const VIDEO_STALL_EPSILON_SEC = 0.0005;

// set true to trace first ~2s of playback per-tick/event to console, for
// chasing start-of-clip stutter bugs. leave false in production
const TRACE_STARTUP = false;
const TRACE_DURATION_MS = 2500;

class AudioTracksManager {
  constructor({ videoEl, audioContext, masterGainNode, panelEl, onPersistClip, onPersistGlobal }) {
    this.videoEl = videoEl;
    this.audioContext = audioContext;
    this.masterGainNode = masterGainNode;
    this.panelEl = panelEl;
    // per-clip persistence (only volume, keyed by ordinal)
    this.onPersistClip = onPersistClip || (() => {});
    // keyed by track name: {color, hidden}; applies to every clip with a same-named track
    this.onPersistGlobal = onPersistGlobal || (() => {});

    this.tracks = [];          // [{ ordinal, name, audioEl, sourceNode, gainNode, muted, volume }]
    this.disposed = false;
    this.lastMirrorTick = 0;
    this.lastVideoSeekingTs = 0;   // ms of the last tick observing video.seeking==true
    this.wasVideoSeeking = false;  // tracks transition seeking==true -> false
    // stall detection: track whether video.currentTime is actually advancing.
    // if not, video is warming up after play/seek; don't let audio race ahead then snap
    this._lastVideoTime = -1;
    this._lastVideoTimeAdvanceTs = 0;
    this._rafId = null;
    this._persistTimer = null;
    this._seekedSnapTimer = null;
    this._onVideoSeeked = null;
    this._traceStartTs = 0;
    this._traceEvtListeners = [];
  }

  _traceActive() {
    return TRACE_STARTUP && this._traceStartTs > 0
      && (performance.now() - this._traceStartTs) < TRACE_DURATION_MS;
  }

  _trace(label, extra) {
    if (!this._traceActive()) return;
    const t = (performance.now() - this._traceStartTs).toFixed(1);
    const v = this.videoEl;
    const base = `[trace +${t}ms] ${label} v.t=${v.currentTime.toFixed(3)} v.paused=${v.paused} v.seeking=${v.seeking} v.muted=${v.muted} v.readyState=${v.readyState}`;
    const audios = this.tracks.map((tr, i) => `a${i}{t=${tr.audioEl.currentTime.toFixed(3)} p=${tr.audioEl.paused} rs=${tr.audioEl.readyState}}`).join(' ');
    // eslint-disable-next-line no-console
    console.log(base + ' ' + audios + (extra ? ' | ' + extra : ''));
  }

  _attachTraceListeners() {
    if (!TRACE_STARTUP) return;
    const v = this.videoEl;
    const wrap = (target, evt) => {
      const h = () => this._trace(`evt ${target === v ? 'video' : 'audio'}:${evt}`);
      target.addEventListener(evt, h);
      this._traceEvtListeners.push({ target, evt, h });
    };
    ['play', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'stalled', 'canplay', 'timeupdate', 'ratechange'].forEach((e) => wrap(v, e));
    this.tracks.forEach((tr) => {
      ['play', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'stalled', 'canplay', 'ended'].forEach((e) => {
        const h = () => this._trace(`evt audio[${tr.ordinal}]:${e}`);
        tr.audioEl.addEventListener(e, h);
        this._traceEvtListeners.push({ target: tr.audioEl, evt: e, h });
      });
    });
  }

  /**
   * @param {Array<{ordinal, streamIndex, path, name, channels}>} trackMetas
   * @param {{tracks: Object}} persistedState - per-clip volume by ordinal
   * @param {Object} globalPrefs - {[trackName]: {color, hidden}}
   * @param {Map<number, HTMLAudioElement>} [preloadedAudioEls] - hover-prewarmed
   *   audio els; faster _waitForReady. caller transfers ownership to dispose()
   */
  async init(trackMetas, persistedState, globalPrefs, preloadedAudioEls) {
    if (!trackMetas || trackMetas.length === 0) return;

    if (this.audioContext.state === 'suspended') {
      try { await this.audioContext.resume(); } catch (_) { /* ignore */ }
    }

    const persisted = (persistedState && persistedState.tracks) || {};
    const prefs = globalPrefs || {};

    for (const meta of trackMetas) {
      // reuse hover-prewarmed <audio> el if present (already past readyState>=2)
      const warm = preloadedAudioEls && preloadedAudioEls.get(meta.ordinal);
      let audioEl;
      if (warm) {
        audioEl = warm;
        delete audioEl.dataset.warmedClip;
        delete audioEl.dataset.warmedOrdinal;
      } else {
        audioEl = document.createElement('audio');
        audioEl.preload = 'auto';
        audioEl.src = `file://${meta.path.replace(/\\/g, '/')}`;
        audioEl.style.display = 'none';
        // keep intrinsic volume at 1, gain comes from GainNode instead
        audioEl.volume = 1;
        document.body.appendChild(audioEl);
      }

      const sourceNode = this.audioContext.createMediaElementSource(audioEl);
      const gainNode = this.audioContext.createGain();
      sourceNode.connect(gainNode);
      gainNode.connect(this.masterGainNode);

      const saved = persisted[meta.ordinal] || {};
      const volume = Number.isFinite(saved.volume) ? saved.volume : 1;
      const muted = !!saved.muted;
      const trackName = meta.name || `Track ${meta.ordinal + 1}`;
      const globalPref = prefs[trackName] || {};
      // hidden = removed from active mix into the floating tray (global pref)
      // muted  = right-click soft mute, per-clip. either silences the track
      const hidden = !!globalPref.hidden;
      const color = typeof globalPref.color === 'string' && /^#[0-9a-f]{6}$/i.test(globalPref.color)
        ? globalPref.color
        : COLOR_PALETTE[meta.ordinal % COLOR_PALETTE.length];

      gainNode.gain.setValueAtTime((hidden || muted) ? 0 : volume, this.audioContext.currentTime);

      this.tracks.push({
        ordinal: meta.ordinal,
        streamIndex: meta.streamIndex,
        name: trackName,
        channels: meta.channels || null,
        audioEl,
        sourceNode,
        gainNode,
        hidden,
        muted,
        volume,
        // unclamped volume for shift-drag memory; `volume` is the clamped [0,2]
        // projection, so a track pushed past the clamp returns right when shifted back
        _trueVolume: volume,
        color
      });
    }

    // wait for readyState>=2 on each track; cuts start-of-clip drift
    await Promise.all(this.tracks.map((t) => this._waitForReady(t.audioEl)));

    // mute the original video, sound now comes from the track graph
    this.videoEl.muted = true;

    this._renderPanel();
    this._startMirrorLoop();
    this._attachPaletteOutsideClose();
    this._attachSeekFastPath();

    if (TRACE_STARTUP) {
      this._traceStartTs = performance.now();
      this._attachTraceListeners();
      this._trace('init complete (before forceSnap)');
    }

    // sync currentTime + playbackRate up front in case the video already moved
    this._enforceVideoState(performance.now(), true);
  }

  /**
   * snaps audio on 'seeked' without waiting for the ~90ms mirror tick; debounced
   * so a mid-scrub seek burst collapses to one snap. mirror loop still gates pause during drag
   */
  _attachSeekFastPath() {
    this._onVideoSeeked = () => {
      if (this.disposed) return;
      if (this._seekedSnapTimer) clearTimeout(this._seekedSnapTimer);
      this._seekedSnapTimer = setTimeout(() => {
        this._seekedSnapTimer = null;
        if (this.disposed || !this.videoEl || this.videoEl.seeking) return;
        const videoTime = this.videoEl.currentTime;
        this._trace(`seeked FAST-PATH snap -> v.t=${videoTime.toFixed(3)}`);
        for (const t of this.tracks) {
          try { t.audioEl.currentTime = videoTime; } catch (_) { /* ignore */ }
        }
        // reset stall detector: fresh seek means video will re-warm at new position
        this._lastVideoTime = videoTime;
        this._lastVideoTimeAdvanceTs = performance.now();
      }, SEEKED_SNAP_DEBOUNCE_MS);
    };
    this.videoEl.addEventListener('seeked', this._onVideoSeeked);
  }

  _waitForReady(audioEl) {
    return new Promise((resolve) => {
      if (audioEl.readyState >= 2) {
        resolve();
        return;
      }
      const done = () => {
        audioEl.removeEventListener('canplay', done);
        audioEl.removeEventListener('loadeddata', done);
        audioEl.removeEventListener('error', done);
        resolve();
      };
      audioEl.addEventListener('canplay', done);
      audioEl.addEventListener('loadeddata', done);
      audioEl.addEventListener('error', done);
      // safety net, never block forever
      setTimeout(done, 2000);
    });
  }

  /**
   * Mirrors track <audio> to <video> every tick (steadier than per-event
   * listeners). During an active seek audio stays paused with no currentTime
   * writes (avoids decoder-seek glitches); settles after SEEK_SETTLE_DELAY_MS
   * then snaps on drift > DRIFT_SNAP_THRESHOLD_SEC.
   * @param {number} now - performance.now() of this tick
   * @param {boolean} forceSnap - bypass gating, snap immediately
   */
  _enforceVideoState(now, forceSnap) {
    const videoEl = this.videoEl;
    if (!videoEl) return;
    const videoTime = videoEl.currentTime;
    const videoRate = videoEl.playbackRate;
    const videoShouldPlay = !videoEl.paused && !videoEl.ended;
    const videoSeeking = !!videoEl.seeking;

    if (videoSeeking) this.lastVideoSeekingTs = now;
    const sinceSeek = now - this.lastVideoSeekingTs;
    // seek in flight: actively seeking, or just settled but still inside the
    // settle-delay window. audio stays paused with no currentTime writes here
    const seekInFlight = videoSeeking || sinceSeek < SEEK_SETTLE_DELAY_MS;
    const seekJustSettled = this.wasVideoSeeking && !videoSeeking && sinceSeek >= SEEK_SETTLE_DELAY_MS;
    this.wasVideoSeeking = seekInFlight;

    // video stalled: warming up after play/seek; pause audio instead of racing ahead
    const videoAdvanced = videoTime > this._lastVideoTime + VIDEO_STALL_EPSILON_SEC;
    if (videoAdvanced) {
      this._lastVideoTime = videoTime;
      this._lastVideoTimeAdvanceTs = now;
    } else if (this._lastVideoTime < 0) {
      this._lastVideoTime = videoTime;
      this._lastVideoTimeAdvanceTs = now;
    }
    const videoStalled = videoShouldPlay && !videoSeeking
      && (now - this._lastVideoTimeAdvanceTs) > MIRROR_TICK_INTERVAL_MS;

    for (const t of this.tracks) {
      const a = t.audioEl;

      if (a.playbackRate !== videoRate) a.playbackRate = videoRate;

      if (forceSnap || seekJustSettled) {
        // snap once after settle (or unconditionally on force)
        this._trace(`mirror SNAP (force=${!!forceSnap} settled=${seekJustSettled}) ord=${t.ordinal} from a.t=${a.currentTime.toFixed(3)} to v.t=${videoTime.toFixed(3)}`);
        try { a.currentTime = videoTime; } catch (_) { /* ignore */ }
      } else if (!seekInFlight && !videoStalled) {
        // steady-state drift correction; skip while stalled to avoid the AAC stutter noted above
        const drift = a.currentTime - videoTime;
        if (drift > DRIFT_SNAP_THRESHOLD_SEC && videoShouldPlay) {
          // audio ahead: pause briefly instead of snapping (avoids decoder restart), same idea as stall path
          this._trace(`mirror PAUSE-AHEAD ord=${t.ordinal} drift=${drift.toFixed(3)}`);
          if (!a.paused) a.pause();
          continue;
        }
        if (Math.abs(drift) > DRIFT_SNAP_THRESHOLD_SEC) {
          this._trace(`mirror DRIFT-SNAP ord=${t.ordinal} drift=${drift.toFixed(3)} → v.t=${videoTime.toFixed(3)}`);
          try { a.currentTime = videoTime; } catch (_) { /* ignore */ }
        }
      }

      // pause during seek-in-flight or warmup; otherwise mirror video state
      const targetPlay = videoShouldPlay && !seekInFlight && !videoStalled;
      if (targetPlay) {
        if (a.paused) {
          this._trace(`mirror PLAY ord=${t.ordinal} (vSP=${videoShouldPlay} sIF=${seekInFlight} stall=${videoStalled})`);
          const p = a.play();
          if (p && typeof p.catch === 'function') {
            p.catch((err) => {
              if (err && err.name !== 'AbortError') {
                logger.warn(`[audio-tracks] play() rejected ordinal=${t.ordinal}: ${err.message}`);
              }
            });
          }
        }
      } else if (!a.paused) {
        this._trace(`mirror PAUSE ord=${t.ordinal} (vSP=${videoShouldPlay} sIF=${seekInFlight} stall=${videoStalled})`);
        a.pause();
      }
    }
  }

  _startMirrorLoop() {
    const tick = (now) => {
      if (this.disposed) return;
      if (now - this.lastMirrorTick >= MIRROR_TICK_INTERVAL_MS) {
        this.lastMirrorTick = now;
        this._enforceVideoState(now, false);
      }
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _renderPanel() {
    if (!this.panelEl) return;
    this.panelEl.innerHTML = '';
    // tray floats above panel (absolute positioned); sliders start at panel top for thumb reachability
    const tray = document.createElement('div');
    tray.className = 'mixer__hidden-tray';
    tray.hidden = true;

    const tracksWrap = document.createElement('div');
    tracksWrap.className = 'mixer__tracks';

    this.panelEl.appendChild(tray);
    this.panelEl.appendChild(tracksWrap);

    this._panelRefs = { tracksWrap, tray };
    this._renderRows();
  }

  _renderRows() {
    const { tracksWrap, tray } = this._panelRefs;
    tracksWrap.innerHTML = '';
    tray.innerHTML = '';

    const visible = this.tracks.filter((t) => !t.hidden);
    const hidden = this.tracks.filter((t) => t.hidden);

    visible.forEach((track) => tracksWrap.appendChild(this._buildRow(track)));
    if (hidden.length > 0) {
      tray.hidden = false;
      hidden.forEach((track) => tray.appendChild(this._buildChip(track)));
    } else {
      tray.hidden = true;
    }
  }

  _repaintTrackRow(track) {
    if (!this.panelEl) return;
    const row = this.panelEl.querySelector(`.mixer__row[data-ordinal="${track.ordinal}"]`);
    if (!row) return;
    const value = row.querySelector('.mixer__value');
    const dot = row.querySelector('.mixer__dot');
    this._paintRow(track, { row, value, dot });
  }

  _paintRow(track, els) {
    const v = track.volume;
    const above = v > 1;
    const pct = clamp(v / 2, 0, 1) * 100;
    els.row.style.setProperty('--fill', `${pct}%`);
    els.row.style.setProperty('--c1', `${track.color}55`);
    els.row.style.setProperty('--c2', above ? `${BOOSTED_COLOR}aa` : `${track.color}88`);
    els.row.style.color = track.color;
    els.value.textContent = `${Math.round(v * 100)}%`;
  }

  _buildRow(track) {
    const wrap = document.createElement('div');
    wrap.className = 'mixer__row-wrap';

    const row = document.createElement('div');
    row.className = 'mixer__row' + (track.muted ? ' mixer__row--muted' : '');
    row.dataset.ordinal = String(track.ordinal);
    row.innerHTML = `
      <div class="mixer__fill"></div>
      <div class="mixer__unity"></div>
      <div class="mixer__overlay">
        <button class="mixer__dot" type="button" aria-label="Change color"></button>
        <div class="mixer__name"></div>
        <div class="mixer__value"></div>
        <button class="mixer__hide" type="button" aria-label="Hide from mix">${ICON_X}</button>
      </div>
    `;
    const dot = row.querySelector('.mixer__dot');
    const nameEl = row.querySelector('.mixer__name');
    const value = row.querySelector('.mixer__value');
    const hideBtn = row.querySelector('.mixer__hide');
    nameEl.textContent = track.name;
    nameEl.title = track.name;

    const els = { row, value, dot };
    this._paintRow(track, els);

    const paletteEl = this._buildPalette(track, els);
    wrap.appendChild(row);
    wrap.appendChild(paletteEl);

    dot.addEventListener('mousedown', (e) => e.stopPropagation());
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = this._openPalette && this._openPalette.el === paletteEl;
      this._closePalette();
      if (!wasOpen) {
        paletteEl.hidden = false;
        this._openPalette = { el: paletteEl, track };
      }
    });

    hideBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._setHidden(track, true);
    });

    // shift-drag snapshot at mousedown locks a baseline so the delta propagates to
    // every track, preserving offsets for tracks clamped at 0 or 2
    let dragShiftSnapshot = null;

    const applyFromClientX = (clientX) => {
      const r = row.getBoundingClientRect();
      const raw = clamp((clientX - r.left) / r.width, 0, 1) * 2;
      const next = detentSnap(raw);

      if (dragShiftSnapshot) {
        const delta = next - dragShiftSnapshot.dragged;
        let anyChanged = false;
        for (const snap of dragShiftSnapshot.all) {
          const t = this.tracks.find((x) => x.ordinal === snap.ord);
          if (!t) continue;
          const newTrue = snap.base + delta;
          const newDisplay = clamp(newTrue, 0, 2);
          if (newTrue === t._trueVolume && newDisplay === t.volume) continue;
          t._trueVolume = newTrue;
          if (newDisplay !== t.volume) {
            t.volume = newDisplay;
            if (!t.hidden && !t.muted) {
              t.gainNode.gain.setValueAtTime(newDisplay, this.audioContext.currentTime);
            }
            if (t === track) this._paintRow(t, els);
            else this._repaintTrackRow(t);
            anyChanged = true;
          }
        }
        if (anyChanged) this._schedulePersistClip();
      } else if (next !== track.volume) {
        track.volume = next;
        track._trueVolume = next;
        this._paintRow(track, els);
        if (!track.hidden && !track.muted) {
          track.gainNode.gain.setValueAtTime(next, this.audioContext.currentTime);
        }
        this._schedulePersistClip();
      }
    };

    let dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      applyFromClientX(cx);
    };
    const onUp = () => {
      dragging = false;
      dragShiftSnapshot = null;
      delete row.dataset.dragging;
      // re-enable per-row transitions on all rows once the group drag ends
      if (this.panelEl) this.panelEl.removeAttribute('data-shift-drag');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
    const onDown = (e) => {
      if (e.target.closest('.mixer__dot, .mixer__hide, .mixer__palette')) return;
      // right-click is reserved for soft mute; must not start a drag before contextmenu fires
      if (typeof e.button === 'number' && e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      row.dataset.dragging = 'true';
      if (e.shiftKey) {
        const draggedBase = track._trueVolume != null ? track._trueVolume : track.volume;
        dragShiftSnapshot = {
          dragged: draggedBase,
          all: this.tracks.map((t) => ({
            ord: t.ordinal,
            base: t._trueVolume != null ? t._trueVolume : t.volume
          }))
        };
        // kill .mixer__fill transition on every row so they track the drag 1:1
        if (this.panelEl) this.panelEl.setAttribute('data-shift-drag', 'true');
      } else {
        dragShiftSnapshot = null;
      }
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      applyFromClientX(cx);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
    };

    row.addEventListener('mousedown', onDown);
    row.addEventListener('touchstart', onDown, { passive: false });

    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.mixer__dot, .mixer__hide')) return;
      track.volume = 1;
      track._trueVolume = 1;
      this._paintRow(track, els);
      if (!track.hidden && !track.muted) {
        track.gainNode.gain.setValueAtTime(1, this.audioContext.currentTime);
      }
      this._schedulePersistClip();
    });

    row.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = 0.05;
      const next = clamp(track.volume + (e.deltaY < 0 ? step : -step), 0, 2);
      track.volume = detentSnap(next);
      track._trueVolume = track.volume;
      this._paintRow(track, els);
      if (!track.hidden && !track.muted) {
        track.gainNode.gain.setValueAtTime(track.volume, this.audioContext.currentTime);
      }
      this._schedulePersistClip();
    }, { passive: false });

    // right-click toggles per-clip soft mute (separate from "hide to tray")
    row.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.mixer__dot, .mixer__hide, .mixer__palette')) return;
      e.preventDefault();
      this._setMuted(track, !track.muted);
    });

    return wrap;
  }

  _buildPalette(track, els) {
    const el = document.createElement('div');
    el.className = 'mixer__palette';
    el.hidden = true;
    COLOR_PALETTE.forEach((color) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'mixer__swatch';
      sw.style.background = color;
      sw.dataset.active = String(color.toLowerCase() === track.color.toLowerCase());
      sw.title = color;
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        this._applyColorByName(track.name, color);
        this._persistGlobal(track, { color });
        this._closePalette();
      });
      el.appendChild(sw);
    });
    return el;
  }

  _buildChip(track) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mixer__chip';
    chip.style.color = track.color;
    chip.title = `Restore ${track.name} to mix`;
    chip.innerHTML = `<span class="mixer__chip-dot"></span><span class="mixer__chip-label">${this._escapeHtml(track.name)}</span>`;
    chip.addEventListener('click', () => this._setHidden(track, false));
    return chip;
  }

  _escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  _closePalette() {
    if (this._openPalette) {
      this._openPalette.el.hidden = true;
      this._openPalette = null;
    }
  }

  _attachPaletteOutsideClose() {
    this._paletteOutsideHandler = (e) => {
      if (!this._openPalette) return;
      if (!e.target.closest('.mixer__palette, .mixer__dot')) this._closePalette();
    };
    this._paletteEscHandler = (e) => {
      if (e.key === 'Escape') this._closePalette();
    };
    document.addEventListener('mousedown', this._paletteOutsideHandler);
    document.addEventListener('keydown', this._paletteEscHandler);
  }

  _setHidden(track, hidden) {
    const next = !!hidden;
    this._applyHiddenByName(track.name, next);
    this._persistGlobal(track, { hidden: next ? true : null });
    this._renderRows();
  }

  _applyColorByName(name, color) {
    for (const t of this.tracks) {
      if (t.name === name) t.color = color;
    }
    // Re-render so palette state and chip colors update everywhere.
    this._renderRows();
  }

  _applyHiddenByName(name, hidden) {
    for (const t of this.tracks) {
      if (t.name === name) {
        t.hidden = hidden;
        const gain = (hidden || t.muted) ? 0 : t.volume;
        t.gainNode.gain.setValueAtTime(gain, this.audioContext.currentTime);
      }
    }
  }

  /** per-clip soft mute (right-click): stays in the mix, just silenced */
  _setMuted(track, muted) {
    const next = !!muted;
    if (track.muted === next) return;
    track.muted = next;
    const gain = (track.hidden || next) ? 0 : track.volume;
    track.gainNode.gain.setValueAtTime(gain, this.audioContext.currentTime);
    this._repaintTrackRow(track);
    // also set muted class directly in case the row was just rebuilt
    const row = this.panelEl && this.panelEl.querySelector(`.mixer__row[data-ordinal="${track.ordinal}"]`);
    if (row) row.classList.toggle('mixer__row--muted', next);
    this._schedulePersistClip();
  }

  /** Nudge all non-hidden tracks by `delta`, preserving relative offsets via _trueVolume. */
  nudgeAll(delta) {
    if (!Number.isFinite(delta) || delta === 0) return;
    let anyChanged = false;
    for (const t of this.tracks) {
      if (t.hidden) continue;
      const base = t._trueVolume != null ? t._trueVolume : t.volume;
      const newTrue = base + delta;
      const newDisplayRaw = clamp(newTrue, 0, 2);
      const newDisplay = detentSnap(newDisplayRaw);
      t._trueVolume = newTrue;
      if (newDisplay !== t.volume) {
        t.volume = newDisplay;
        if (!t.muted) {
          t.gainNode.gain.setValueAtTime(newDisplay, this.audioContext.currentTime);
        }
        this._repaintTrackRow(t);
        anyChanged = true;
      }
    }
    if (anyChanged) this._schedulePersistClip();
    // reveal panel during nudges for feedback, auto-hide shortly after
    this._showPanelTransient();
  }

  /**
   * audible mix for export: entries not hidden or muted, each carrying the
   * absolute source stream index so ffmpeg can map it directly
   */
  getExportMix() {
    return this.tracks
      .filter((t) => !t.hidden && !t.muted)
      .map((t) => ({
        streamIndex: t.streamIndex,
        ordinal: t.ordinal,
        volume: Number.isFinite(t.volume) ? t.volume : 1
      }));
  }

  _showPanelTransient(durationMs = 1600) {
    if (!this.panelEl) return;
    this.panelEl.classList.remove('hidden');
    if (this._panelHideTimer) clearTimeout(this._panelHideTimer);
    this._panelHideTimer = setTimeout(() => {
      this._panelHideTimer = null;
      if (!this.disposed && this.panelEl) this.panelEl.classList.add('hidden');
    }, durationMs);
  }

  /** Debounced per-clip persistence (volume + muted, by ordinal). */
  _schedulePersistClip() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      const state = { tracks: {} };
      this.tracks.forEach((t) => {
        state.tracks[t.ordinal] = { volume: t.volume, muted: !!t.muted };
      });
      try {
        this.onPersistClip(state);
      } catch (err) {
        logger.error('[audio-tracks] persist clip failed:', err);
      }
    }, 300);
  }

  /** Immediate global preference write (color/hidden) keyed by track name. */
  _persistGlobal(track, patch) {
    try {
      this.onPersistGlobal(track.name, patch);
    } catch (err) {
      logger.error('[audio-tracks] persist global failed:', err);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._panelHideTimer) {
      clearTimeout(this._panelHideTimer);
      this._panelHideTimer = null;
    }
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    if (this._seekedSnapTimer) {
      clearTimeout(this._seekedSnapTimer);
      this._seekedSnapTimer = null;
    }
    if (this._onVideoSeeked && this.videoEl) {
      try { this.videoEl.removeEventListener('seeked', this._onVideoSeeked); } catch (_) {}
      this._onVideoSeeked = null;
    }
    if (this._traceEvtListeners && this._traceEvtListeners.length) {
      for (const { target, evt, h } of this._traceEvtListeners) {
        try { target.removeEventListener(evt, h); } catch (_) {}
      }
      this._traceEvtListeners = [];
    }
    if (this._paletteOutsideHandler) {
      document.removeEventListener('mousedown', this._paletteOutsideHandler);
      this._paletteOutsideHandler = null;
    }
    if (this._paletteEscHandler) {
      document.removeEventListener('keydown', this._paletteEscHandler);
      this._paletteEscHandler = null;
    }
    this._closePalette();
    this.tracks.forEach((t) => {
      try { t.audioEl.pause(); } catch (_) {}
      try { t.gainNode.disconnect(); } catch (_) {}
      try { t.sourceNode.disconnect(); } catch (_) {}
      try { t.audioEl.removeAttribute('src'); t.audioEl.load(); } catch (_) {}
      if (t.audioEl.parentNode) t.audioEl.parentNode.removeChild(t.audioEl);
    });
    this.tracks = [];

    if (this.panelEl) {
      this.panelEl.innerHTML = '';
      this.panelEl.classList.add('hidden');
    }

    // unmute video for single-track playback going forward
    try { this.videoEl.muted = false; } catch (_) {}
  }
}

module.exports = { AudioTracksManager };
