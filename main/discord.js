const DiscordRPC = require('discord-rpc');
const logger = require('../utils/logger');

const CLIENT_ID = '1264368321013219449';

let rpc = null;
let rpcReady = false;
let getSettings = null;

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

// startTimestamp: epoch ms or Date, discord shows it as "elapsed"
async function updateDiscordPresence(details, state = null, startTimestamp = null) {
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

  const start = startTimestamp instanceof Date ? startTimestamp.getTime() : Number(startTimestamp);
  if (Number.isFinite(start) && start > 0) {
    activity.startTimestamp = start;
  }

  rpc.setActivity(activity).catch((error) => {
    logger.error('Failed to update Discord presence:', error);
  });
}

function clearDiscordPresence() {
  if (rpcReady && rpc) {
    rpc.clearActivity().catch(logger.error);
  }
}

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
