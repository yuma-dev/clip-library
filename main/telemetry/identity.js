// Identity: install_id, machine_key, session_id.
// install_id is shared with clipdip when present, so the server keys installs on (product,
// install_id) (docs/telemetry-cliplib-api.md 1).
// machine_key: random UUID in HKCU, survives reinstall, not derived from
// hardware/MachineGuid/username. Delete the value to reset it.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REG_PATH = 'HKCU\\Software\\ClipLib';
const REG_VALUE = 'telemetry_machine_key';
const CLIPDIP_REG_PATH = 'HKCU\\Software\\Clipdip';

let installId = null;
let installIdSource = 'unknown';
let machineKey = null;
let machineKeySource = 'unknown';
let sessionId = null;
let sessionStartedAt = null;

/** distinguishes "value not there" from "could not ask": collapsing those is how a busy-boot or EDR-blocked reg.exe looks like a first run and overwrites machine_key
 * @returns {Promise<{ok: boolean, transient: boolean, stdout: string}>} */
function execReg(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (!error) return resolve({ ok: true, transient: false, stdout: String(stdout || '') });
      // numeric exit code = reg.exe ran and answered (1 = not found); non-numeric = never ran
      // (ENOENT/EACCES); killed = our timeout
      const ranAndAnswered = typeof error.code === 'number' && !error.killed;
      resolve({ ok: false, transient: !ranAndAnswered, stdout: String(stdout || '') });
    });
  });
}

function parseRegSz(stdout, valueName) {
  if (!stdout) return null;
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf(valueName);
    if (idx === -1) continue;
    const parts = line.slice(idx).trim().split(/\s{2,}|\t+/);
    if (parts.length >= 3) {
      const value = parts[parts.length - 1].trim();
      if (value) return value.slice(0, 128);
    }
  }
  return null;
}

/** @returns {Promise<{value: string|null, transient: boolean}>} */
async function readRegValue(regPath) {
  const result = await execReg(['query', regPath, '/v', REG_VALUE]);
  if (result.transient) return { value: null, transient: true };
  return { value: parseRegSz(result.stdout, REG_VALUE), transient: false };
}

/** never overwrites an existing key on an unreadable failure, returns null instead so the heartbeat
 * just omits machine_key this session rather than risk clobbering the install's whole history */
async function resolveMachineKey() {
  if (machineKey) return machineKey;
  if (process.platform !== 'win32') {
    machineKeySource = 'unsupported_platform';
    return null;
  }
  try {
    const own = await readRegValue(REG_PATH);
    if (own.transient) {
      machineKeySource = 'unavailable';
      return null;
    }
    if (own.value) {
      machineKey = own.value;
      machineKeySource = 'existing';
      return machineKey;
    }

    // adopt clipdip's key if it exists, so both products report the same machine; transient failure
    // aborts rather than minting
    const sibling = await readRegValue(CLIPDIP_REG_PATH);
    if (sibling.transient) {
      machineKeySource = 'unavailable';
      return null;
    }

    const candidate = sibling.value || crypto.randomUUID();
    await execReg(['add', REG_PATH, '/v', REG_VALUE, '/t', 'REG_SZ', '/d', candidate, '/f']);

    // verify the write landed, else a fleet mints a new key every launch with nothing to show for it
    const verify = await readRegValue(REG_PATH);
    if (verify.value !== candidate) {
      machineKeySource = 'write_failed';
      return null;
    }
    machineKey = candidate;
    machineKeySource = sibling.value ? 'adopted_clipdip' : 'created';
  } catch {
    machineKeySource = 'error';
    machineKey = null;
  }
  return machineKey;
}

/** prefers clipdip's install id. Old main/log-uploader.js getInstallId() swallowed write failures and could mint a fresh id every launch;
 * here the write is verified and the outcome reported as install_id_source */
function resolveInstallId(userDataDir, clipdipInstallIdPath) {
  if (installId) return installId;

  if (clipdipInstallIdPath) {
    try {
      const id = fs.readFileSync(clipdipInstallIdPath, 'utf8').trim();
      if (id) {
        installId = id;
        installIdSource = 'clipdip';
        return installId;
      }
    } catch {
      /* clipdip may never have run here */
    }
  }

  const localPath = path.join(userDataDir, 'install_id');
  try {
    const id = fs.readFileSync(localPath, 'utf8').trim();
    if (id) {
      installId = id;
      installIdSource = 'local';
      return installId;
    }
  } catch {
    /* first run */
  }

  const fresh = crypto.randomUUID();
  try {
    fs.writeFileSync(localPath, fresh, 'utf8');
    const verify = fs.readFileSync(localPath, 'utf8').trim();
    installId = verify === fresh ? fresh : verify || fresh;
    installIdSource = verify === fresh ? 'local' : 'ephemeral';
  } catch {
    installId = fresh;
    installIdSource = 'ephemeral';
  }
  return installId;
}

function startSession() {
  sessionId = crypto.randomUUID();
  sessionStartedAt = new Date().toISOString();
  return { sessionId, sessionStartedAt };
}

module.exports = {
  resolveInstallId,
  resolveMachineKey,
  startSession,
  getInstallId: () => installId,
  getInstallIdSource: () => installIdSource,
  getMachineKey: () => machineKey,
  getMachineKeySource: () => machineKeySource,
  getSessionId: () => sessionId,
  getSessionStartedAt: () => sessionStartedAt
};
