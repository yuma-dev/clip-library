// Machine profile, sent once per session on the first successful beat.
// Category/number only: no hostname, username, path or serial. Electron/Chrome/Node versions and DPI/refresh
// are cliplib-only additions over clipdip's block, for "only on 4K at 150% scaling" style bug reports.

const os = require('os');
const { execFile } = require('child_process');
const fsp = require('fs').promises;

// Win32_LogicalDisk DriveType; 3 (fixed) is split system/other via %SystemDrive%.
const DRIVE_TYPES = { 2: 'removable', 3: 'fixed', 4: 'network', 5: 'removable' };

const GPU_VENDORS = {
  0x10de: 'nvidia',
  0x1002: 'amd',
  0x1022: 'amd',
  0x8086: 'intel'
};

function windowsMarketingVersion(release) {
  // os.release() is "10.0.26100"; build >= 22000 = Windows 11
  const parts = String(release || '').split('.');
  const build = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(build)) return release || null;
  return `${build >= 22000 ? '11' : '10'} ${build}`;
}

// getGPUInfo('complete') blocks the browser process (~2.1s stall, freezes every window); 'basic' +
// a PowerShell query avoids that.
async function collectGpu(app) {
  const out = {};
  try {
    const info = await app.getGPUInfo('basic');
    const device = Array.isArray(info?.gpuDevice) ? info.gpuDevice.find((d) => d.active) || info.gpuDevice[0] : null;
    if (device) out.gpu_vendor = GPU_VENDORS[device.vendorId] || 'other';
  } catch {
    /* GPU info is best effort */
  }
  if (process.platform === 'win32') {
    const controller = await queryVideoController();
    if (controller?.Name) out.gpu_model = String(controller.Name);
    if (controller?.DriverVersion) out.gpu_driver = String(controller.DriverVersion);
  }
  return out;
}

function queryVideoController() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object -First 1 Name, DriverVersion | ConvertTo-Json -Compress'
      ],
      { windowsHide: true, timeout: 10000 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          resolve(JSON.parse(String(stdout).trim()));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

function collectDisplays(screen) {
  const out = {};
  try {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    out.monitor_count = displays.length;
    out.monitors = displays
      .map((d) => {
        const w = Math.round(d.size.width * (d.scaleFactor || 1));
        const h = Math.round(d.size.height * (d.scaleFactor || 1));
        return `${w}x${h}${d.id === primary.id ? '*' : ''}`;
      })
      .join(',')
      .slice(0, 200);
    out.dpi_scale = primary.scaleFactor || 1;
    if (primary.displayFrequency) out.display_refresh_hz = primary.displayFrequency;
  } catch {
    /* screen module needs app ready */
  }
  return out;
}

/** category of the clips folder's volume; network share is the strongest predictor of watcher/enumeration failures.
 * Never returns anything derived from the path itself, only the category. */
function classifyVolumeCheap(clipLocation) {
  if (/^\\\\/.test(clipLocation)) return 'network';
  const match = /^([A-Za-z]):/.exec(clipLocation);
  if (!match) return undefined;
  const systemDrive = String(process.env.SystemDrive || 'C:').toUpperCase();
  return `${match[1]}:`.toUpperCase() === systemDrive ? 'system' : 'other';
}

function queryDriveType(letter) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'").DriveType`
      ],
      { windowsHide: true, timeout: 10000 },
      (error, stdout) => {
        if (error) return resolve(null);
        const parsed = Number.parseInt(String(stdout).trim(), 10);
        resolve(Number.isFinite(parsed) ? parsed : null);
      }
    );
  });
}

async function collectDisk(clipLocation) {
  const out = {};
  if (!clipLocation || typeof clipLocation !== 'string') return out;

  try {
    if (typeof fsp.statfs === 'function') {
      const stats = await fsp.statfs(clipLocation);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(freeBytes) && freeBytes >= 0) {
        out.disk_free_gb = Math.round((freeBytes / 1e9) * 10) / 10;
      }
    }
  } catch {
    /* unreachable volume, missing folder */
  }

  const cheap = classifyVolumeCheap(clipLocation);
  out.disk_volume = cheap;

  const letter = /^([A-Za-z]):/.exec(clipLocation)?.[1];
  if (letter && process.platform === 'win32') {
    const type = await queryDriveType(letter);
    const mapped = DRIVE_TYPES[type];
    if (mapped === 'network' || mapped === 'removable') out.disk_volume = mapped;
    else if (mapped === 'fixed') out.disk_volume = cheap === 'system' ? 'system' : 'other';
  }
  return out;
}

/** Requires app.whenReady() for the display half. */
async function collect({ app, screen, clipLocation }) {
  const cpus = os.cpus() || [];
  const profile = {
    os: process.platform === 'win32' ? 'windows' : process.platform,
    os_version: process.platform === 'win32' ? windowsMarketingVersion(os.release()) : os.release(),
    arch: process.arch,
    cpu: cpus[0]?.model ? String(cpus[0].model).trim().slice(0, 100) : undefined,
    cores: cpus.length || undefined,
    ram_mb: Math.round(os.totalmem() / (1024 * 1024)),
    locale: undefined,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  };

  try {
    profile.locale = app.getLocale() || undefined;
  } catch {
    /* pre-ready */
  }

  try {
    profile.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    /* ICU unavailable */
  }

  Object.assign(profile, await collectGpu(app));
  if (screen) Object.assign(profile, collectDisplays(screen));
  Object.assign(profile, await collectDisk(clipLocation));

  for (const key of Object.keys(profile)) {
    if (profile[key] === undefined) delete profile[key];
  }
  return profile;
}

module.exports = { collect };
