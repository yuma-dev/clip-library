/**
 * Discord Manager Module
 *
 * Handles Discord Rich Presence integration and idle tracking.
 */

// Imports
const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');
const state = require('./state');

// Module state
let videoPlayer = null;
let videoPlayerModule = null;
let idleTimeoutMs = 0;
let initialized = false;

// Activity tracking
function handleActivity() {
  state.lastActivityTime = Date.now();
}

// Presence helpers
function updateDiscordPresence(details, presenceState = null) {
  if (state.settings && state.settings.enableDiscordRPC) {
    ipcRenderer.invoke('update-discord-presence', details, presenceState);
  }
}

/**
 * Update Discord presence based on the active clip and playback state.
 */
function updateDiscordPresenceForClip(clip, isPlaying = true) {
  if (!videoPlayer || !videoPlayerModule) return;
  if (state.settings && state.settings.enableDiscordRPC) {
    clearInterval(state.discordPresenceInterval);

    if (clip.tags && clip.tags.includes('Private')) {
      logger.info('Private clip detected. Clearing presence');
      updateDiscordPresence('Download Clip Library now!', '');
    } else {
      if (isPlaying) {
        state.clipStartTime = Date.now() - (state.elapsedTime * 1000);
      }

      const updatePresence = () => {
        if (isPlaying) {
          state.elapsedTime = Math.floor((Date.now() - state.clipStartTime) / 1000);
        }
        const totalDuration = Math.floor(videoPlayer.duration);
        const timeString = `${videoPlayerModule.formatTime(state.elapsedTime)}/${videoPlayerModule.formatTime(totalDuration)}`;
        updateDiscordPresence(`${clip.customName}`, `${timeString}`);
      };

      updatePresence();

      if (isPlaying) {
        state.discordPresenceInterval = setInterval(updatePresence, 1000);
      }
    }
  }
}

/**
 * Choose presence based on current view (clip vs. grid).
 */
function updateDiscordPresenceBasedOnState() {
  if (!videoPlayer) return;
  if (state.currentClip) {
    updateDiscordPresenceForClip(state.currentClip, !videoPlayer.paused);
  } else {
    const publicClipCount = state.currentClipList.filter(clip => !clip.tags.includes('Private')).length;
    updateDiscordPresence('Browsing clips', `Total: ${publicClipCount}`);
  }
}

/**
 * Enable/disable RPC and refresh presence if enabled.
 */
async function toggleDiscordRPC(enable) {
  await ipcRenderer.invoke('toggle-discord-rpc', enable);
  if (enable) {
    updateDiscordPresenceBasedOnState();
  }
}

// Module API
function init({ videoPlayer: player, videoPlayerModule: playerModule, idleTimeoutMs: idleTimeout } = {}) {
  if (initialized) return;

  videoPlayer = player;
  videoPlayerModule = playerModule;
  idleTimeoutMs = idleTimeout || 0;

  document.addEventListener('mousemove', handleActivity);
  document.addEventListener('keydown', handleActivity);

  setInterval(() => {
    if (!videoPlayer || !idleTimeoutMs) return;
    if (Date.now() - state.lastActivityTime > idleTimeoutMs && !videoPlayer.playing) {
      ipcRenderer.invoke('clear-discord-presence');
    }
  }, 60000);

  ipcRenderer.on('check-activity-state', () => {
    if (!videoPlayer || !idleTimeoutMs) return;
    if (Date.now() - state.lastActivityTime <= idleTimeoutMs || videoPlayer.playing) {
      updateDiscordPresenceBasedOnState();
    }
  });

  initialized = true;
}

module.exports = {
  init,
  updateDiscordPresence,
  updateDiscordPresenceForClip,
  updateDiscordPresenceBasedOnState,
  toggleDiscordRPC
};
