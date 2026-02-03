// Imports
const DiscordRPC = require('discord-rpc');
const logger = require('../utils/logger');

// Constants
const CLIENT_ID = '1264368321013219449';

// Module state
let rpc = null;
let rpcReady = false;
let getSettings = null;

/**
 * Initialize Discord RPC if enabled in settings.
 */
async function initDiscordRPC(getSettingsFn) {
  getSettings = getSettingsFn;

  const settings = await getSettings();
  if (!settings || !settings.enableDiscordRPC) {
    return;
  }

  if (rpc) {
    return;
  }

  rpc = new DiscordRPC.Client({ transport: 'ipc' });

  rpc.on('ready', () => {
    logger.info('Discord RPC connected successfully');
    rpcReady = true;
    updateDiscordPresence('Browsing clips');
  });

  rpc.login({ clientId: CLIENT_ID }).catch((error) => {
    logger.error('Failed to initialize Discord RPC:', error);
  });
}

/**
 * Update Discord presence text (if enabled/connected).
 */
async function updateDiscordPresence(details, state = null) {
  const settings = getSettings ? await getSettings() : null;

  if (!rpcReady || !settings || !settings.enableDiscordRPC) {
    logger.info('RPC not ready or disabled');
    return;
  }

  const activity = {
    details: String(details),
    largeImageKey: 'app_logo',
    largeImageText: 'Clip Library',
    buttons: [{ label: 'View on GitHub', url: 'https://github.com/yuma-dev/clip-library' }]
  };

  if (state !== null) {
    activity.state = String(state);
  }

  rpc.setActivity(activity).catch((error) => {
    logger.error('Failed to update Discord presence:', error);
  });
}

/**
 * Clear current Discord presence.
 */
function clearDiscordPresence() {
  if (rpcReady && rpc) {
    rpc.clearActivity().catch(logger.error);
  }
}

/**
 * Dispose the Discord RPC client.
 */
function destroyDiscordRPC() {
  if (!rpc) {
    rpcReady = false;
    return;
  }

  try {
    rpc.destroy();
  } catch (error) {
    logger.error('Error destroying Discord RPC client:', error);
  } finally {
    rpc = null;
    rpcReady = false;
  }
}

module.exports = {
  initDiscordRPC,
  updateDiscordPresence,
  clearDiscordPresence,
  destroyDiscordRPC
};
