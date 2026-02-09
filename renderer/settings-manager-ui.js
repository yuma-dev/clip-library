/**
 * Settings Manager Module
 *
 * Handles all settings operations:
 * - Settings modal initialization and management
 * - Settings controls event handling
 * - Settings persistence
 */

// Imports
const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');
const state = require('./state');

// Dependencies (injected)
let videoPlayerModule, searchManagerModule, fetchSettings, updateSettingValue, toggleDiscordRPC, 
    applyIconGreyscale, renderClips, updateVersionDisplay, changeClipLocation, updateAllPreviewVolumes,
    populateKeybindingList, shareManagerModule;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the settings manager with required dependencies.
 */
function init(dependencies) {
  videoPlayerModule = dependencies.videoPlayerModule;
  searchManagerModule = dependencies.searchManagerModule;
  fetchSettings = dependencies.fetchSettings;
  updateSettingValue = dependencies.updateSettingValue;
  toggleDiscordRPC = dependencies.toggleDiscordRPC;
  applyIconGreyscale = dependencies.applyIconGreyscale;
  renderClips = dependencies.renderClips;
  updateVersionDisplay = dependencies.updateVersionDisplay;
  changeClipLocation = dependencies.changeClipLocation;
  updateAllPreviewVolumes = dependencies.updateAllPreviewVolumes;
  populateKeybindingList = dependencies.populateKeybindingList;
  shareManagerModule = dependencies.shareManagerModule;
}

// ============================================================================
// SETTINGS MODAL OPERATIONS
// ============================================================================

/**
 * Wire settings modal controls and tab handlers.
 */
async function initializeSettingsModal() {
  const settingsModal = document.getElementById('settingsModal');
  const tabs = document.querySelectorAll('.settings-tab');
  const tabContents = document.querySelectorAll('.settings-tab-content');

  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      
      // Update active states
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      tab.classList.add('active');
      document.querySelector(`.settings-tab-content[data-tab="${targetTab}"]`).classList.add('active');
      if (typeof populateKeybindingList === 'function' && targetTab === 'shortcuts') {
        populateKeybindingList();
      }
    });
  });

  // Preview volume slider
  const previewVolumeSlider = document.getElementById('previewVolumeSlider');
  const previewVolumeValue = document.getElementById('previewVolumeValue');

  previewVolumeSlider.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    previewVolumeValue.textContent = `${Math.round(value * 100)}%`;
    updateAllPreviewVolumes(value);
  });
  
  previewVolumeSlider.addEventListener('change', async (e) => {
    try {
      await updateSettingValue('previewVolume', parseFloat(e.target.value));
    } catch (error) {
      logger.error('Error saving preview volume:', error);
    }
  });

  // Settings controls event handlers
  document.getElementById('closeSettingsBtn').addEventListener('click', closeSettingsModal);
  document.getElementById('changeLocationBtn').addEventListener('click', changeClipLocation);
  document.getElementById('manageTagsBtn').addEventListener('click', () => {
    closeSettingsModal();
    searchManagerModule.openTagManagement();
  });
  
  // Escape key handler to close state.settings modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal.style.display === 'block') {
      closeSettingsModal();
    }
  });

  // Export quality change handler
  document.getElementById('exportQuality').addEventListener('change', async (e) => {
    try {
      await updateSettingValue('exportQuality', e.target.value);
    } catch (error) {
      logger.error('Error saving export quality:', error);
      e.target.value = state.settings.exportQuality;
    }
  });

  // Discord RPC toggle handler
  const discordRPCToggle = document.getElementById('enableDiscordRPC');
  discordRPCToggle.addEventListener('change', async (e) => {
    try {
      await toggleDiscordRPC(e.target.checked);
      await updateSettingValue('enableDiscordRPC', e.target.checked);
    } catch (error) {
      logger.error('Error toggling Discord RPC:', error);
      e.target.checked = !e.target.checked;
    }
  });

  // Greyscale icons toggle
  const greyscaleToggle = document.getElementById('greyscaleIcons');
  if (greyscaleToggle) {
    greyscaleToggle.checked = Boolean(state.settings.iconGreyscale);
    greyscaleToggle.addEventListener('change', async (e) => {
      try {
        await updateSettingValue('iconGreyscale', e.target.checked);
        applyIconGreyscale(e.target.checked);
      } catch (error) {
        logger.error('Error toggling Greyscale Icons:', error);
        e.target.checked = !e.target.checked;
      }
    });
  }

  // New clips indicators toggle
  const newClipsIndicatorsToggle = document.getElementById('showNewClipsIndicators');
  if (newClipsIndicatorsToggle) {
    newClipsIndicatorsToggle.checked = Boolean(state.settings.showNewClipsIndicators ?? true);
    newClipsIndicatorsToggle.addEventListener('change', async (e) => {
      try {
        await updateSettingValue('showNewClipsIndicators', e.target.checked);
        // Re-render clips to show/hide indicators instantly
        if (state.currentClipList) {
          renderClips(state.currentClipList);
        }
      } catch (error) {
        logger.error('Error toggling New Clips Indicators:', error);
        e.target.checked = !e.target.checked;
      }
    });
  }

  // Ambient Glow state.settings
  const ambientGlowEnabled = document.getElementById('ambientGlowEnabled');
  const ambientGlowSmoothing = document.getElementById('ambientGlowSmoothing');
  const ambientGlowSmoothingValue = document.getElementById('ambientGlowSmoothingValue');
  const ambientGlowFps = document.getElementById('ambientGlowFps');
  const ambientGlowBlur = document.getElementById('ambientGlowBlur');
  const ambientGlowBlurValue = document.getElementById('ambientGlowBlurValue');
  const ambientGlowOpacity = document.getElementById('ambientGlowOpacity');
  const ambientGlowOpacityValue = document.getElementById('ambientGlowOpacityValue');

  // Initialize ambient glow state.settings from saved values
  const glowSettings = state.settings?.ambientGlow || { enabled: true, smoothing: 0.5, fps: 30, blur: 80, saturation: 1.5, opacity: 0.7 };
  
  if (ambientGlowEnabled) {
    ambientGlowEnabled.checked = glowSettings.enabled;
    ambientGlowEnabled.addEventListener('change', async (e) => {
      try {
        await updateSettingValue('ambientGlow.enabled', e.target.checked);
        videoPlayerModule.applyAmbientGlowSettings(state.settings.ambientGlow);
      } catch (error) {
        logger.error('Error toggling Ambient Glow:', error);
        e.target.checked = !e.target.checked;
      }
    });
  }

  if (ambientGlowSmoothing) {
    ambientGlowSmoothing.value = glowSettings.smoothing;
    ambientGlowSmoothingValue.textContent = glowSettings.smoothing.toFixed(1);
    ambientGlowSmoothing.addEventListener('input', (e) => {
      ambientGlowSmoothingValue.textContent = parseFloat(e.target.value).toFixed(1);
    });
    ambientGlowSmoothing.addEventListener('change', async (e) => {
      try {
        await updateSettingValue('ambientGlow.smoothing', parseFloat(e.target.value));
        videoPlayerModule.applyAmbientGlowSettings(state.settings.ambientGlow);
      } catch (error) {
        logger.error('Error saving Ambient Glow smoothing:', error);
      }
    });
  }

  if (ambientGlowFps) {
    ambientGlowFps.value = glowSettings.fps.toString();
    ambientGlowFps.addEventListener('change', async (e) => {
      try {
        await updateSettingValue('ambientGlow.fps', parseInt(e.target.value));
        videoPlayerModule.applyAmbientGlowSettings(state.settings.ambientGlow);
      } catch (error) {
        logger.error('Error saving Ambient Glow FPS:', error);
      }
    });
  }

  if (ambientGlowBlur) {
    ambientGlowBlur.value = glowSettings.blur;
    ambientGlowBlurValue.textContent = `${glowSettings.blur}px`;
    ambientGlowBlur.addEventListener('input', (e) => {
      ambientGlowBlurValue.textContent = `${e.target.value}px`;
    });
    ambientGlowBlur.addEventListener('change', async (e) => {
      try {
        await updateSettingValue('ambientGlow.blur', parseInt(e.target.value));
        videoPlayerModule.applyAmbientGlowSettings(state.settings.ambientGlow);
      } catch (error) {
        logger.error('Error saving Ambient Glow blur:', error);
      }
    });
  }

  if (ambientGlowOpacity) {
    ambientGlowOpacity.value = glowSettings.opacity;
    ambientGlowOpacityValue.textContent = `${Math.round(glowSettings.opacity * 100)}%`;
    ambientGlowOpacity.addEventListener('input', (e) => {
      ambientGlowOpacityValue.textContent = `${Math.round(e.target.value * 100)}%`;
    });
    ambientGlowOpacity.addEventListener('change', async (e) => {
      try {
        await updateSettingValue('ambientGlow.opacity', parseFloat(e.target.value));
        videoPlayerModule.applyAmbientGlowSettings(state.settings.ambientGlow);
      } catch (error) {
        logger.error('Error saving Ambient Glow opacity:', error);
      }
    });
  }

  if (shareManagerModule && typeof shareManagerModule.initializeSettingsControls === 'function') {
    shareManagerModule.initializeSettingsControls({ updateSettingValue });
  }
}

/**
 * Open and hydrate the settings modal with current values.
 */
async function openSettingsModal() {
  logger.debug('Opening state.settings modal. Current state.settings:', state.settings);
  
  // Fetch fresh state.settings
  state.settings = await fetchSettings();
  logger.debug('Fresh state.settings fetched:', state.settings);
  
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) {
    settingsModal.style.display = 'block';
    if (window.uiBlur) window.uiBlur.enable();
    
    // Update version display
    updateVersionDisplay();
    
    // Update clip location
    const currentClipLocation = document.getElementById('currentClipLocation');
    if (currentClipLocation) {
      currentClipLocation.textContent = state.clipLocation || 'Not set';
    }
    
    // Set control values from state.settings
    const enableDiscordRPCToggle = document.getElementById('enableDiscordRPC');
    const exportQualitySelect = document.getElementById('exportQuality');
    const previewVolumeSlider = document.getElementById('previewVolumeSlider');
    const previewVolumeValue = document.getElementById('previewVolumeValue');

    logger.debug('Setting controls with values:', {
      enableDiscordRPC: state.settings.enableDiscordRPC,
      exportQuality: state.settings.exportQuality,
      previewVolume: state.settings.previewVolume
    });

    if (enableDiscordRPCToggle) {
      enableDiscordRPCToggle.checked = Boolean(state.settings.enableDiscordRPC);
    }
    
    if (exportQualitySelect) {
      exportQualitySelect.value = state.settings.exportQuality || 'discord';
    }

    // Refresh greyscale toggle to reflect persisted value
    const greyscaleToggleEl = document.getElementById('greyscaleIcons');
    if (greyscaleToggleEl) {
      greyscaleToggleEl.checked = Boolean(state.settings.iconGreyscale);
    }

    // Refresh new clips indicators toggle to reflect persisted value
    const newClipsIndicatorsToggleEl = document.getElementById('showNewClipsIndicators');
    if (newClipsIndicatorsToggleEl) {
      newClipsIndicatorsToggleEl.checked = Boolean(state.settings.showNewClipsIndicators ?? true);
    }

    if (previewVolumeSlider && previewVolumeValue) {
      const savedVolume = state.settings.previewVolume ?? 0.1;
      previewVolumeSlider.value = savedVolume;
      previewVolumeValue.textContent = `${Math.round(savedVolume * 100)}%`;
    }

    if (shareManagerModule && typeof shareManagerModule.syncSettingsUiFromState === 'function') {
      shareManagerModule.syncSettingsUiFromState();
    }

    // Refresh ambient glow state.settings to reflect persisted values
    const glowSettings = state.settings.ambientGlow || { enabled: true, smoothing: 0.5, fps: 30, blur: 80, saturation: 1.5, opacity: 0.7 };
    
    const ambientGlowEnabledEl = document.getElementById('ambientGlowEnabled');
    if (ambientGlowEnabledEl) {
      ambientGlowEnabledEl.checked = Boolean(glowSettings.enabled);
    }
    
    const ambientGlowSmoothingEl = document.getElementById('ambientGlowSmoothing');
    const ambientGlowSmoothingValueEl = document.getElementById('ambientGlowSmoothingValue');
    if (ambientGlowSmoothingEl && ambientGlowSmoothingValueEl) {
      ambientGlowSmoothingEl.value = glowSettings.smoothing;
      ambientGlowSmoothingValueEl.textContent = glowSettings.smoothing.toFixed(1);
    }
    
    const ambientGlowFpsEl = document.getElementById('ambientGlowFps');
    if (ambientGlowFpsEl) {
      ambientGlowFpsEl.value = glowSettings.fps.toString();
    }
    
    const ambientGlowBlurEl = document.getElementById('ambientGlowBlur');
    const ambientGlowBlurValueEl = document.getElementById('ambientGlowBlurValue');
    if (ambientGlowBlurEl && ambientGlowBlurValueEl) {
      ambientGlowBlurEl.value = glowSettings.blur;
      ambientGlowBlurValueEl.textContent = `${glowSettings.blur}px`;
    }
    
    const ambientGlowOpacityEl = document.getElementById('ambientGlowOpacity');
    const ambientGlowOpacityValueEl = document.getElementById('ambientGlowOpacityValue');
    if (ambientGlowOpacityEl && ambientGlowOpacityValueEl) {
      ambientGlowOpacityEl.value = glowSettings.opacity;
      ambientGlowOpacityValueEl.textContent = `${Math.round(glowSettings.opacity * 100)}%`;
    }

    // Set initial active tab
    const defaultTab = document.querySelector('.settings-tab[data-tab="general"]');
    if (defaultTab) {
      defaultTab.click();
    }
  }
}

/**
 * Close the settings modal and persist state.
 */
function closeSettingsModal() {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) {
    // Add fade-out animation
    settingsModal.style.opacity = '0';
    if (window.uiBlur) window.uiBlur.disable();
    setTimeout(() => {
      settingsModal.style.display = 'none';
      settingsModal.style.opacity = '1';
    }, 300);
  }
  
  // Save state.settings state
  updateSettings();
  
  // Update preview volumes
  const previewVolumeSlider = document.getElementById('previewVolumeSlider');
  if (previewVolumeSlider) {
    updateAllPreviewVolumes(parseFloat(previewVolumeSlider.value));
  }
}

/**
 * Refresh cached settings from disk.
 */
async function updateSettings() {
  state.settings = await ipcRenderer.invoke('get-settings');
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Initialization
  init,

  // Settings operations
  initializeSettingsModal,
  openSettingsModal,
  closeSettingsModal,
  updateSettings
};
