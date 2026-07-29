// Identity: install_id, machine_key, session_id.
//
// install_id is SHARED with clipdip by design. When clipdip has an install_id
// on this machine we adopt it, so the server can join the two products for free
// (see docs/telemetry-cliplib-api.md §1). That is why the server keys installs
// on (product, install_id) rather than install_id alone.
//
// machine_key is a random UUID in HKCU, surviving a reinstall so that a
// reinstall is not miscounted as a new user. It is NOT derived from MachineGuid,
// hardware serials, MAC addresses or the username. Deleting the registry value
// makes this machine brand new to us.

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

/**
 * Run reg.exe, distinguishing "the value is not there" from "we could not ask".
 *
 * Collapsing those two into one null is how a machine_key gets destroyed: a
 * reg.exe that times out on a busy cold boot, or is blocked by an EDR agent,
 * looks exactly like a first run, and the caller then mints and writes a fresh
 * UUID over the existing one. That silently breaks the reinstall-survival
 * property this whole module exists for.
 *
 * @returns {Promise<{ok: boolean, transient: boolean, stdout: string}>}
 */
function execReg(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (!error) return resolve({ ok: true, transient: false, stdout: String(stdout || '') });
      // reg.exe exits with a number when it ran and had something to say
      // (1 = key or value not found). A non-numeric code means it never ran
      // (ENOENT, EACCES), and `killed` means our timeout fired.
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

/**
 * Resolve the machine key, and NEVER overwrite an existing one on a failure we
 * cannot interpret. On a transient failure we return null, which makes the
 * heartbeat omit machine_key entirely for this session. Omitting it costs one
 * session of machine correlation; overwriting it costs the install's whole
 * history.
 */
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

    // Adopt clipdip's key when it already exists so both products report the
    // same machine. A transient failure here also aborts rather than minting.
    const sibling = await readRegValue(CLIPDIP_REG_PATH);
    if (sibling.transient) {
      machineKeySource = 'unavailable';
      return null;
    }

    const candidate = sibling.value || crypto.randomUUID();
    await execReg(['add', REG_PATH, '/v', REG_VALUE, '/t', 'REG_SZ', '/d', candidate, '/f']);

    // Verify the write landed. An unverified write is how a fleet ends up
    // minting a new key every launch with nothing to show for it.
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

/**
 * Resolve the install id, preferring clipdip's.
 *
 * The old getInstallId() in main/log-uploader.js swallowed the write failure,
 * which could mint a fresh id on every launch and silently destroy server-side
 * correlation. Here the write is verified and the outcome is reported as
 * install_id_source so a fleet of ephemeral ids is visible instead.
 */
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
