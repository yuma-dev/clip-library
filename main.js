// First line on purpose: records process start for the cold-start harness.
const bootTrace = require('./main/boot-trace');
const { app, BrowserWindow, ipcMain, dialog, Menu, powerMonitor, shell, screen, crashReporter } = require("electron");
app.setAppUserModelId('com.yuma-dev.clips');

// ClipLib rebrand keeps the pre-rename data: packaged Electron derives
// userData from productName ("Clips" -> "ClipLib"), which would silently
// abandon settings/thumbnails in %APPDATA%\Clips. Pin the old folder while it
// exists. Must run before ANY userData consumer (incl. the logger below).
{
  const path = require('path');
  const fs = require('fs');
  const legacyUserData = path.join(app.getPath('appData'), 'Clips');
  if (process.env.CLIPLIB_PROFILE_DIR) {
    // Benchmark harness (benchmark/cold-start.js): an isolated profile so
    // runs never touch the real one.
    app.setPath('userData', path.resolve(process.env.CLIPLIB_PROFILE_DIR));
  } else if (fs.existsSync(legacyUserData)) {
    app.setPath('userData', legacyUserData);
  }
}

const logger = require('./utils/logger');
const consoleBuffer = require('./utils/console-log-buffer');
consoleBuffer.patchConsole();

// Anonymous diagnostics. Required this early so the process-level handlers
// below can report; init() lands once settings are loaded (createWindow).
// Events recorded before init are buffered and replayed there.
const telemetry = require('./main/telemetry');

// Start of the module-load phase, mirroring the benchmark harness mark below.
// Kept unconditionally so startup timings exist in production too.
const moduleLoadStartedAt = Date.now();

// ms since process start (perf_hooks' timeOrigin), the baseline for
// startup.total_ms. Cheaper and more accurate than a Date.now() delta here.
const perfNow = () => require('perf_hooks').performance.now();

// Coarse startup/running split for the crash handlers below.
let appIsReady = false;

// Native crashes (Electron/Node/GPU) bypass the logger entirely; Crashpad
// minidumps in userData\Crashpad are the only trace, so keep them locally.
// Never uploaded; the diagnostics zip surfaces their metadata.
crashReporter.start({ uploadToServer: false });

// A main-process JS crash would otherwise kill the process before anything
// reaches userData\logs. Log it first, then exit; the timeout guarantees we
// don't hang on a broken async logger.
process.on('uncaughtException', (error) => {
  // Recorded first: the queue append is synchronous, so it survives the
  // process.exit(1) below even when the logger never resolves.
  telemetry.event('main_uncaught_exception', {
    kind: telemetry.KIND.CRASH,
    severity: telemetry.SEVERITY.FATAL,
    error,
    context: { phase: appIsReady ? 'running' : 'startup' },
    attachLog: true,
    coalesceMs: 0
  });
  setTimeout(() => process.exit(1), 2000);
  Promise.resolve(logger.error('[fatal] uncaughtException in main process:', error))
    .then(() => process.exit(1), () => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  telemetry.event('main_unhandled_rejection', {
    kind: telemetry.KIND.ERROR,
    severity: telemetry.SEVERITY.ERROR,
    error,
    context: { phase: appIsReady ? 'running' : 'startup' }
  });
  logger.error('[fatal] unhandledRejection in main process (continuing):', error);
});

// Benchmark mode detection and harness initialization
const isBenchmarkMode = process.env.CLIPS_BENCHMARK === '1';
let benchmarkHarness = null;
if (isBenchmarkMode) {
  try {
    const { getMainHarness } = require('./benchmark/main-harness');
    benchmarkHarness = getMainHarness();
    benchmarkHarness.markStartup('moduleLoad');
    logger.info('[Benchmark] Main process harness initialized');
  } catch (e) {
    logger.error('[Benchmark] Failed to load harness:', e);
  }
}
// Performance profiler (main side) — ONLY active on `npm run dev:trace`, which
// sets CLIPS_PERF_STARTUP=1. Not in normal `npm run dev`, not in packaged
// builds. Must run BEFORE any ipcMain.handle registration so it can wrap every
// handler for timing. See benchmark/perf-main.js.
if (!app.isPackaged && process.env.CLIPS_PERF_STARTUP === '1') {
  try {
    const perf = require('./benchmark/perf-main');
    perf.initPerfMain({ isDev: true });
    logger.info('[perf] dev:trace profiler initialized');
    // Feed the startup mark sites already placed below (settingsLoad /
    // fileWatcherSetup / windowCreation / appReady) by standing in as
    // `benchmarkHarness` when the offline benchmark isn't running.
    if (!benchmarkHarness) {
      benchmarkHarness = perf.getStartupRecorder();
      benchmarkHarness.markStartup('moduleLoad');
    }
  } catch (e) {
    logger.error('[perf] failed to init profiler:', e);
  }
}

// Time and report every ipcMain.handle body. Installed once, here, before the
// first registration below; it composes with the dev-only perf wrapper above
// rather than replacing it (whichever installed first ends up on the inside).
// Channel names are a fixed enum from our own code, so they are safe as a dim.
// Arguments and return values are never recorded.
{
  // Channels whose duration is user think time or a network transfer, not the
  // app being slow: native dialogs the user has to answer, the OAuth round trip
  // through the browser, uploads/downloads, and export jobs that run as long as
  // the encode takes. They still report ipc.handler_ms, they just never fire
  // the slow-call event.
  const SLOW_EVENT_EXEMPT = new Set([
    'open-save-dialog',
    'open-folder-dialog',
    'open-folder-dialog-steelseries',
    'show-diagnostics-save-dialog',
    'share-upload-banner',
    'start-cliplib-auth',
    'start-update',
    'upload-session-logs',
    'upload-diagnostics-bundle',
    'share-clip',
    'import-steelseries-clips',
    'export-video',
    'export-trimmed-video',
    'export-audio'
  ]);
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = function (channel, handler) {
    const wrapped = async (event, ...args) => {
      const startedAt = Date.now();
      try {
        const result = await handler(event, ...args);
        const ms = Date.now() - startedAt;
        telemetry.metric('ipc.handler_ms', ms, { unit: 'ms', dims: { channel } });
        if (ms > 2000 && !SLOW_EVENT_EXEMPT.has(channel)) {
          telemetry.event('ipc_call_slow', {
            kind: telemetry.KIND.DEGRADED,
            severity: telemetry.SEVERITY.WARNING,
            context: { channel, ms },
            // Per channel, otherwise one slow channel would mute every other
            // one for the whole ten minute window.
            fingerprint: telemetry.hash32(channel),
            coalesceMs: 600000
          });
        }
        return result;
      } catch (error) {
        const ms = Date.now() - startedAt;
        telemetry.metric('ipc.handler_ms', ms, { unit: 'ms', dims: { channel } });
        telemetry.event('ipc_handler_threw', {
          kind: telemetry.KIND.SILENT_FAILURE,
          severity: telemetry.SEVERITY.ERROR,
          error,
          context: { channel, error_name: error?.name, errno: error?.code, ms }
        });
        throw error;
      }
    };
    return originalHandle(channel, wrapped);
  };
}

// Defer heavy, non-startup-critical modules (axios/electron-updater,
// discord-rpc, archiver) to first use — together they account for a
// large slice of the ~530ms module-load phase before the window can open.
// The Proxy loads the real module on first property access; require() caches.
const lazyModule = (modulePath) =>
  new Proxy({}, { get: (_t, prop) => require(modulePath)[prop] });

const updaterModule = lazyModule('./main/updater');
const isDev = !app.isPackaged;
const path = require("path");
const fs = require("fs").promises;
const { loadSettings, saveSettings, updateSettings, getDefaultKeybindings, getClipLocation, setClipLocation } = require("./utils/settings-manager");
// Modules that nothing needs before the library is on screen load on first
// use (the Proxy defers the require); each one costs tens of ms at boot and
// the browser thread cannot serve the renderer while it loads.
const steelSeriesModule = lazyModule('./main/steelseries-processor');
const { logActivity } = require('./utils/activity-tracker');
const diagnosticsModule = lazyModule('./diagnostics/collector');
const logUploader = lazyModule('./main/log-uploader');
const shareModule = require('./main/share');
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const IDLE_TIMEOUT = 5 * 60 * 1000;
const CLIPLIB_PROTOCOL = 'cliplib';
const CLIPLIB_AUTH_SESSION_TTL_MS = 10 * 60 * 1000;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  telemetry.event('single_instance_lost', {
    kind: telemetry.KIND.CUSTOM,
    severity: telemetry.SEVERITY.INFO
  });
  app.quit();
}

// FFmpeg module (fluent-ffmpeg and the binary paths; first needed for
// thumbnails, well after the window is up)
const ffmpegModule = lazyModule('./main/ffmpeg');

// Thumbnails module
const thumbnailsModule = lazyModule('./main/thumbnails');

// Metadata module
const metadataModule = lazyModule('./main/metadata');

// File watcher module
const fileWatcherModule = require('./main/file-watcher');

// Warms the slow, cacheable part of opening a clip ahead of the click.
const clipWarmer = require('./main/clip-warmer');
// Library order (newest first) from the last get-clips, for the warmer.
let lastClipNames = [];

// Discord RPC module (lazy — discord-rpc is heavy and not needed to open the window)
const discordModule = lazyModule('./main/discord');

// Discord profile widget pusher (lazy; inert without its userData token file)
const discordWidgetModule = lazyModule('./main/discord-widget');

// Renderer console ring buffer for diagnostics (log upload + zip)
const rendererConsoleCapture = require('./main/renderer-console-capture');

// Clips module
const clipsModule = lazyModule('./main/clips');

// Dialogs Module - handles all Electron dialog interactions
const dialogsModule = lazyModule('./main/dialogs');

// Integrated clipdip (clipdip binary): process lifecycle + TOML config bridge
const clipdipModule = lazyModule('./main/clipdip');

// FFmpeg verification (and the NVENC probe it chains) runs from
// runDeferredServices() once the library is on screen; see there.

function sendLog(window, type, message) {
  if (window && !window.isDestroyed()) {
    window.webContents.send('log', { type, message });
  }
}

// Log ffmpeg version
ipcMain.handle('get-ffmpeg-version', async (event) => {
  try {
    const version = await ffmpegModule.getFFmpegVersion();
    sendLog(event.sender.getOwnerBrowserWindow(), 'info', `FFmpeg version: ${version}`);
    return version;
  } catch (error) {
    sendLog(event.sender.getOwnerBrowserWindow(), 'error', `Error getting ffmpeg version: ${error}`);
    throw error;
  }
});

ipcMain.handle('get-export-acceleration-status', async () => {
  return ffmpegModule.getExportAccelerationStatus();
});

let idleTimer;

let mainWindow;
let mainWindowRevealed = false;
let settings;

// Side work that is not needed to show the library: it spawns processes
// (ffmpeg, PowerShell, tasklist, clipdip) or blocks on COM, and on the
// startup path it competed with the renderer and GPU process for the first
// seconds of every launch. Runs once, shortly after the library is visible.
let deferredServicesScheduled = false;
function scheduleDeferredServices() {
  if (deferredServicesScheduled) return;
  deferredServicesScheduled = true;
  setTimeout(() => {
    runDeferredServices().catch((error) => {
      logger.warn(`Deferred startup services failed: ${error.message}`);
    });
  }, 1500);
}

async function runDeferredServices() {
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    updaterModule.init(win);
    // "Updated to vX" toast after a silent update landed.
    try {
      updaterModule.checkPostUpdateMarker(win);
    } catch (error) {
      logger.warn(`Post-update marker check failed: ${error.message}`);
    }
    if (settings.enableDiscordRPC && !isBenchmarkMode) {
      discordModule.initDiscordRPC(getSettings);
    }
    if (!isBenchmarkMode) {
      // Owner-only profile widget pusher; inert unless its token file exists
      // in userData (see main/discord-widget.js).
      discordWidgetModule.init(getSettings);
    }
    if (isBenchmarkMode) {
      logger.info('[Benchmark] Skipping update check in benchmark mode');
    } else {
      setTimeout(() => {
        logger.info('Starting update check after delay');
        checkForUpdatesInBackground(win);
      }, 1500);
    }
  }

  ffmpegModule.initFFmpeg().catch((err) => {
    logger.error('FFmpeg initialization failed:', err);
  });

  // Machine block for the heartbeat. The collector needs the clip folder
  // (volume class + free space, never the path itself) and is a no-op until
  // telemetry.init() has run, which it has by now.
  void telemetry.collectMachine({ app, screen, clipLocation: settings.clipLocation });

  // Bring the integrated clipdip up. Opt-out: the first launch where the
  // user never chose (no clipdip.enabled key) auto-enables it — supported
  // hardware only; a failed start records enabled=false so it never loops.
  // Later launches just start it if it's enabled but not running.
  clipdipModule
    .autoEnableIfUnconfigured(async (value) => {
      settings.clipdip = { ...(settings.clipdip || {}), enabled: value };
      await saveSettings(settings);
    })
    .then((autoEnabled) => {
      if (!autoEnabled) clipdipModule.ensureStartedIfEnabled();
    })
    .catch((error) => logger.warn(`Clipdip bootstrap failed: ${error.message}`));

  // The Clips → ClipLib rebrand renamed the exe, which orphans taskbar pins
  // (their .lnk targets the old Clips.exe path). Retarget any pin whose
  // Clips.exe target no longer exists to the running exe. Idempotent; cheap
  // no-op when there's nothing to repair.
  repairTaskbarPins().catch((error) => {
    logger.warn(`Taskbar pin repair failed: ${error.message}`);
  });

  // Newest clips are the likeliest first opens; warm them once the other
  // deferred work has had its moment.
  setTimeout(() => clipWarmer.warmMany(lastClipNames, 12), 3000);
}

// The window is created hidden and shown once, as soon as the renderer has
// painted the library (or shortly after its first paint, whichever comes
// first). There used to be a separate splash window here: its own renderer
// process competed with the main window's, and its dismiss animation added a
// fixed 300 ms between "library painted" and "library visible".
// The window is created hidden and revealed once the compositor has framed
// the library grid with its thumbnails (the renderer reports that state as
// renderer-ready). Two facts drove this, both measured with a screen pixel
// probe:
//  - ready-to-show fires when the renderer submits its first frame, but the
//    GPU process still needs time to compile shaders and raster before that
//    frame can be presented; showing the window earlier means a white window
//    until then. A tiny DevTools screencast of the hidden window reports each
//    frame the compositor actually produces, so the reveal waits for the
//    second one.
//  - Windows presents one white frame for a window it has never shown. The
//    window is shown at opacity 0 and made opaque one frame later.
// The grid's first frame is expensive (about 600 ms of GPU work on a fast
// machine), so the reveal lands at about 1.5 s after launch; anything earlier
// is a white or empty window, not a faster app.
const REVEAL_FALLBACK_MS = 1500;
let framesSincePaint = 0;
// screencastActive: the reveal still waits for compositor frames.
// frameWatchAttached: the DevTools session is attached and must be torn down
// whatever path the reveal took (a fallback clears screencastActive first).
let screencastActive = false;
let frameWatchAttached = false;
// Set by renderer-ready: the grid and its visible thumbnails are committed.
let firstPaintSeen = false;

function startFrameWatch(win) {
  if (!win || win.isDestroyed()) return;
  const dbg = win.webContents.debugger;
  try {
    dbg.attach('1.3');
  } catch (error) {
    logger.warn(`Frame watch unavailable, revealing on first paint: ${error.message}`);
    return;
  }
  screencastActive = true;
  frameWatchAttached = true;
  dbg.on('message', (_event, method, params) => {
    if (method !== 'Page.screencastFrame') return;
    dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    if (!firstPaintSeen) return;
    framesSincePaint += 1;
    if (framesSincePaint <= 3) bootTrace.mark(`frame_${framesSincePaint}`);
    maybeReveal();
  });
  dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 10, maxWidth: 16, maxHeight: 16, everyNthFrame: 1 }).catch((error) => {
    logger.warn(`Frame watch screencast failed: ${error.message}`);
    screencastActive = false;
    maybeReveal();
  });
}

function stopFrameWatch() {
  screencastActive = false;
  if (!frameWatchAttached || !mainWindow || mainWindow.isDestroyed()) return;
  frameWatchAttached = false;
  const dbg = mainWindow.webContents.debugger;
  dbg.sendCommand('Page.stopScreencast').catch(() => {}).then(() => {
    try { dbg.detach(); } catch (_) { /* already detached */ }
  });
}

function maybeReveal() {
  if (mainWindowRevealed || !firstPaintSeen) return;
  if (!screencastActive || framesSincePaint >= 2) revealMainWindow();
}

function revealMainWindow() {
  if (mainWindowRevealed) return;
  mainWindowRevealed = true;
  scheduleDeferredServices();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setOpacity(0);
  mainWindow.show();
  mainWindow.maximize();
  mainWindow.focus();
  bootTrace.mark('window_visible');
  telemetry.metric('startup.window_visible_ms', Math.round(perfNow()), { unit: 'ms' });
  let opaque = false;
  const makeOpaque = () => {
    if (opaque || mainWindow.isDestroyed()) return;
    opaque = true;
    mainWindow.setOpacity(1);
    bootTrace.mark('window_opaque');
    stopFrameWatch();
  };
  const dbg = mainWindow.webContents.debugger;
  if (frameWatchAttached && dbg.isAttached()) {
    let frames = 0;
    const onFrame = (_event, method) => {
      if (method !== 'Page.screencastFrame') return;
      frames += 1;
      if (frames >= 2) {
        dbg.removeListener('message', onFrame);
        makeOpaque();
      }
    };
    dbg.on('message', onFrame);
  }
  setTimeout(makeOpaque, 150);
}

let pendingCliplibAuthSession = null;
let isProcessingProtocolQueue = false;
const queuedProtocolUrls = [];
const queuedCliplibAuthEvents = [];

// Getter for cached settings (used by modules instead of loadSettings which reads from disk)
// Settings load in parallel with the first window; anything that asks
// before they land waits for that load instead of seeing undefined.
let settingsLoading = null;
const getSettings = async () => settings ?? (await settingsLoading);
clipWarmer.init(getSettings);
// Wires the settings getter only (no process work): a cliplib://settings/clipdip
// deep link can ask for clipdip status before the deferred services run.
clipdipModule.init(getSettings);

function registerCliplibProtocol() {
  try {
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(CLIPLIB_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
        return;
      }
    }
    app.setAsDefaultProtocolClient(CLIPLIB_PROTOCOL);
  } catch (error) {
    // Login can never complete without the protocol handler, and nothing in
    // the UI says so.
    telemetry.event('protocol_registration_failed', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.ERROR,
      error
    });
    logger.warn(`Failed to register ${CLIPLIB_PROTOCOL}:// protocol: ${error.message}`);
  }
}

function extractCliplibProtocolUrl(args = []) {
  if (!Array.isArray(args)) return null;
  return args.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(`${CLIPLIB_PROTOCOL}://`)) || null;
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Still booting: the reveal will show it (maximized, opaque) in a moment;
  // showing it now would flash an unpainted window and then an opacity blink.
  if (!mainWindowRevealed) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function queueCliplibAuthEvent(eventPayload) {
  if (!eventPayload || typeof eventPayload !== 'object') return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    queuedCliplibAuthEvents.push(eventPayload);
    return;
  }
  const isLoading = typeof mainWindow.webContents.isLoadingMainFrame === 'function'
    ? mainWindow.webContents.isLoadingMainFrame()
    : mainWindow.webContents.isLoading();
  if (isLoading) {
    queuedCliplibAuthEvents.push(eventPayload);
    return;
  }
  mainWindow.webContents.send('cliplib-auth-event', eventPayload);
}

// Generic main->renderer event queue for events that may fire before the
// renderer is loaded (same lifecycle as the auth queue above, but not tied
// to one channel). Used by cliplib://settings/... navigation deep links.
const queuedRendererEvents = [];

function queueRendererEvent(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    queuedRendererEvents.push({ channel, payload });
    return;
  }
  const isLoading = typeof mainWindow.webContents.isLoadingMainFrame === 'function'
    ? mainWindow.webContents.isLoadingMainFrame()
    : mainWindow.webContents.isLoading();
  if (isLoading) {
    queuedRendererEvents.push({ channel, payload });
    return;
  }
  mainWindow.webContents.send(channel, payload);
}

function flushQueuedRendererEvents() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const isLoading = typeof mainWindow.webContents.isLoadingMainFrame === 'function'
    ? mainWindow.webContents.isLoadingMainFrame()
    : mainWindow.webContents.isLoading();
  if (isLoading) return;
  while (queuedRendererEvents.length > 0) {
    const { channel, payload } = queuedRendererEvents.shift();
    mainWindow.webContents.send(channel, payload);
  }
}

function flushCliplibAuthEvents() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const isLoading = typeof mainWindow.webContents.isLoadingMainFrame === 'function'
    ? mainWindow.webContents.isLoadingMainFrame()
    : mainWindow.webContents.isLoading();
  if (isLoading) {
    return;
  }
  while (queuedCliplibAuthEvents.length > 0) {
    const payload = queuedCliplibAuthEvents.shift();
    mainWindow.webContents.send('cliplib-auth-event', payload);
  }
}

async function clearLegacySharingToken() {
  if (!settings?.sharing || typeof settings.sharing !== 'object') return;
  if (!settings.sharing.apiToken) return;

  settings.sharing.apiToken = '';
  try {
    await saveSettings(settings);
  } catch (error) {
    logger.warn(`Failed to clear legacy sharing token from settings: ${error.message}`);
  }
}

async function migrateLegacySharingTokenIfPresent() {
  const legacyToken = typeof settings?.sharing?.apiToken === 'string'
    ? settings.sharing.apiToken.trim()
    : '';
  if (!legacyToken) return;

  const existingToken = await shareModule.getStoredApiToken();
  if (!existingToken) {
    await shareModule.setStoredApiToken(legacyToken);
  }
  await clearLegacySharingToken();
}

function hasValidPendingCliplibSession() {
  if (!pendingCliplibAuthSession) return false;
  return (Date.now() - pendingCliplibAuthSession.createdAt) <= CLIPLIB_AUTH_SESSION_TTL_MS;
}

async function handleCliplibProtocolUrl(protocolUrl) {
  // Navigation deep links (e.g. cliplib://settings/clipdip from the
  // clipdip's tray icon) — everything else falls through to the original
  // auth-callback handling.
  try {
    const url = new URL(protocolUrl);
    if (url.host === 'settings') {
      const section = url.pathname.replace(/^\/+|\/+$/g, '') || undefined;
      queueRendererEvent('cliplib-navigate', { view: 'settings', section });
      focusMainWindow();
      return;
    }
  } catch (_) {
    // not a parseable URL — let the auth parser produce the error
  }

  const parsed = shareModule.parseDesktopAuthCallbackUrl(protocolUrl);
  if (!parsed.ok) {
    queueCliplibAuthEvent({
      status: 'error',
      message: parsed.error || 'Invalid ClipLib auth callback.'
    });
    return;
  }

  if (!hasValidPendingCliplibSession()) {
    pendingCliplibAuthSession = null;
    queueCliplibAuthEvent({
      status: 'error',
      message: 'No active ClipLib login session. Start login again from Settings.'
    });
    return;
  }

  if (parsed.session !== pendingCliplibAuthSession.session) {
    queueCliplibAuthEvent({
      status: 'error',
      message: 'ClipLib login session mismatch. Please retry login.'
    });
    return;
  }

  const expectedServerUrl = pendingCliplibAuthSession.serverUrl;
  pendingCliplibAuthSession = null;

  try {
    await shareModule.setStoredApiToken(parsed.token);
    await clearLegacySharingToken();

    const verify = await shareModule.testConnection(getSettings, {
      serverUrl: expectedServerUrl,
      apiToken: parsed.token
    });

    if (!verify?.success) {
      // The token itself may well be good: any transient blip on /auth/me
      // throws it away and sends the user back to the login flow.
      telemetry.event('auth_verify_discarded_token', {
        kind: telemetry.KIND.ERROR,
        severity: telemetry.SEVERITY.ERROR,
        context: {
          reason: !verify ? 'no_result' : (typeof verify.status === 'number' ? 'http_error' : 'request_failed'),
          http_status: typeof verify?.status === 'number' ? verify.status : undefined
        }
      });
      await shareModule.clearStoredApiToken();
      queueCliplibAuthEvent({
        status: 'error',
        message: verify?.error || 'ClipLib login succeeded but token verification failed.'
      });
      return;
    }

    queueCliplibAuthEvent({
      status: 'success',
      displayName: verify.displayName || 'Unknown user'
    });
  } catch (error) {
    try {
      await shareModule.clearStoredApiToken();
    } catch (_) {
      // ignore cleanup errors
    }
    queueCliplibAuthEvent({
      status: 'error',
      message: `ClipLib login failed: ${error.message}`
    });
  } finally {
    focusMainWindow();
  }
}

// Retarget taskbar pins orphaned by the Clips → ClipLib exe rename. Windows
// taskbar pins are .lnk files whose target is the exe's full path; renaming
// the exe leaves them pointing at a file the upgrade deleted. Only touches
// pins that target a now-missing Clips.exe.
async function repairTaskbarPins() {
  if (!app.isPackaged) return;
  const fss = require('fs');
  const pinDir = path.join(
    app.getPath('appData'),
    'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'
  );
  let entries;
  try {
    entries = await fs.readdir(pinDir);
  } catch {
    return; // no pin folder — nothing pinned
  }
  let scanned = 0;
  let repaired = 0;
  let failed = 0;
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.lnk')) continue;
    const lnkPath = path.join(pinDir, name);
    scanned += 1;
    try {
      const details = shell.readShortcutLink(lnkPath);
      const target = details?.target || '';
      const lowered = target.toLowerCase();
      // Prefer the native launcher next to the app (instant splash); the
      // Electron binary itself is the fallback.
      const launcher = path.join(path.dirname(process.execPath), 'ClipLib Launcher.exe');
      const haveLauncher = fss.existsSync(launcher);
      const orphanedLegacy = lowered.endsWith('\\clips.exe') && !fss.existsSync(target);
      // A pin created from the running window targets the Electron exe;
      // move it to the launcher once, so pinned launches get the splash.
      const pinnedElectron = haveLauncher && lowered === process.execPath.toLowerCase();
      if (!orphanedLegacy && !pinnedElectron) continue;
      const newTarget = haveLauncher ? launcher : process.execPath;
      shell.writeShortcutLink(lnkPath, 'replace', {
        ...details,
        target: newTarget,
        cwd: path.dirname(process.execPath),
        icon: newTarget,
        iconIndex: 0,
        appUserModelId: 'com.yuma-dev.clips'
      });
      repaired += 1;
      logger.info(`Repaired orphaned taskbar pin: ${name}`);
    } catch {
      // unreadable/foreign .lnk — skip
      failed += 1;
    }
  }
  if (failed > 0) {
    // A pin that stays orphaned launches nothing when clicked, and the user
    // never learns why.
    telemetry.event('taskbar_pin_repair_failed', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { scanned, repaired, failed }
    });
  }
}

async function processQueuedProtocolUrls() {
  if (isProcessingProtocolQueue || !app.isReady() || !settings) {
    return;
  }

  isProcessingProtocolQueue = true;
  try {
    while (queuedProtocolUrls.length > 0) {
      const nextUrl = queuedProtocolUrls.shift();
      await handleCliplibProtocolUrl(nextUrl);
    }
  } finally {
    isProcessingProtocolQueue = false;
  }
}

function queueProtocolUrl(protocolUrl) {
  if (typeof protocolUrl !== 'string' || !protocolUrl.trim()) {
    return;
  }
  queuedProtocolUrls.push(protocolUrl.trim());
  processQueuedProtocolUrls().catch((error) => {
    logger.error('Failed processing queued protocol URLs:', error);
  });
}

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

const initialProtocolUrl = extractCliplibProtocolUrl(process.argv);
if (initialProtocolUrl) {
  queuedProtocolUrls.push(initialProtocolUrl);
}

app.on('second-instance', (event, commandLine) => {
  const protocolUrl = extractCliplibProtocolUrl(commandLine);
  if (protocolUrl) {
    queueProtocolUrl(protocolUrl);
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow().catch((error) => {
      logger.error('Failed to create window on second-instance event:', error);
    });
  }
  focusMainWindow();
});

app.on('open-url', (event, protocolUrl) => {
  event.preventDefault();
  queueProtocolUrl(protocolUrl);
});

// Renderer death. The window goes white or blank and the app keeps running,
// so without this the only trace is a user saying "it froze".
app.on('render-process-gone', (event, webContents, details) => {
  telemetry.event('renderer_process_gone', {
    kind: telemetry.KIND.CRASH,
    severity: telemetry.SEVERITY.FATAL,
    // A one-line summary so the issue list is readable without opening the
    // event. These lifecycle codes carry no natural error message, and without
    // one the dashboard row is just the code name.
    message: `renderer process gone: ${details?.reason || 'unknown'} (exit ${details?.exitCode ?? '?'})`,
    context: {
      reason: details?.reason,
      exit_code: details?.exitCode,
      uptime_s: Math.round(process.uptime())
    }
  });
});

// GPU / utility / pepper plugin processes. A dead GPU process is the usual
// cause of "video plays black" reports.
app.on('child-process-gone', (event, details) => {
  telemetry.event('child_process_gone', {
    kind: telemetry.KIND.CRASH,
    severity: telemetry.SEVERITY.ERROR,
    message: `${details?.type || 'child'} process gone: ${details?.reason || 'unknown'}${details?.serviceName ? ` (${details.serviceName})` : ''}`,
    context: {
      type: details?.type,
      reason: details?.reason,
      exit_code: details?.exitCode,
      service_name: details?.serviceName
    }
  });
});

// Windows logoff/shutdown. Distinguishes an OS shutdown from a crash, which
// otherwise both look like a session that stopped heartbeating.
app.on('session-end', () => {
  telemetry.sessionEnd('shutdown');
});

// clipdip's anonymous install id, resolved the same way main/clipdip.js builds
// its data dir. Sharing the id is what joins a cliplib session to the clipdip
// crash reports from the same machine. Returns a path that may not exist; the
// telemetry core falls back to a local id then.
function clipdipInstallIdPath() {
  try {
    const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
    return path.join(localAppData, 'clipdip', 'data', 'install_id');
  } catch {
    return undefined;
  }
}

// The heartbeat's `app` block, from settings only. Never carries clipLocation,
// binaryPath, apiToken or serverUrl.
function reportAppInfo() {
  try {
    if (!settings) return;
    const defaults = getDefaultKeybindings() || {};
    const bindings = settings.keybindings || {};
    const keybindingsCustomized = Object.keys(defaults)
      .filter((action) => bindings[action] && bindings[action] !== defaults[action])
      .length;

    telemetry.setAppInfo({
      export_preset: settings.exportPreset,
      export_quality: settings.exportQuality,
      export_size_goal: settings.exportSizeGoal,
      ui_font: settings.uiFont,
      discord_rpc_enabled: Boolean(settings.enableDiscordRPC),
      controller_enabled: settings.controller?.enabled !== false,
      ambient_glow_enabled: settings.ambientGlow?.enabled !== false,
      onboarding_version: Number(settings.onboardingVersion) || 0,
      clipdip_enabled: Boolean(settings.clipdip?.enabled),
      keybindings_customized: keybindingsCustomized
    });
  } catch (error) {
    logger.warn(`Failed to report telemetry app info: ${error.message}`);
  }
}

// Library size as a bucket. The raw count is a fingerprint-grade number and is
// never sent; the bucket answers every question we actually ask of it.
function clipCountBucket(count) {
  if (count <= 0) return '0';
  if (count <= 50) return '1_50';
  if (count <= 200) return '50_200';
  if (count <= 1000) return '200_1k';
  if (count <= 5000) return '1k_5k';
  if (count <= 20000) return '5k_20k';
  return '20k_plus';
}

// The dynamic half of the `app` block: state that only exists at runtime, so
// it cannot come from settings the way reportAppInfo's fields do. Every probe
// is guarded on its own, because one unreachable clip folder must not cost us
// the other five fields. A field that will not resolve is omitted rather than
// sent as null. Never throws and is never awaited.
async function reportDynamicAppInfo() {
  const info = {};

  try {
    const count = clipsModule.getLastClipCount();
    if (Number.isFinite(count)) info.clip_count_bucket = clipCountBucket(count);
  } catch (_) { /* no successful scan yet */ }

  try {
    // 4 min TTL cache behind this, so it is a memory read on all but the
    // first call of the session.
    const { bytes } = await clipsModule.getClipsFolderSize(getSettings);
    if (Number.isFinite(bytes)) info.library_bytes_gb = Math.round((bytes / 1e9) * 10) / 10;
  } catch (_) { /* folder unreadable */ }

  try {
    const tags = await metadataModule.loadGlobalTags(app.getPath.bind(app));
    // Count only. Tag text never leaves the machine.
    if (Array.isArray(tags)) info.tag_count = tags.length;
  } catch (_) { /* tags file unreadable */ }

  try {
    const nvenc = await ffmpegModule.getNvencStatus();
    if (nvenc) info.nvenc_available = Boolean(nvenc.available);
  } catch (_) { /* probe failed */ }

  try {
    // Boolean only. The token itself is never read into telemetry.
    info.share_connected = Boolean(await shareModule.getStoredApiToken());
  } catch (_) { /* auth store unreadable */ }

  try {
    info.clipdip_running = Boolean(await clipdipModule.isRunning());
  } catch (_) { /* tasklist probe failed */ }

  try {
    info.watcher_alive = fileWatcherModule.isWatcherAlive();
  } catch (_) { /* ignore */ }

  telemetry.setAppInfo(info);
}

// Off the startup path deliberately: the first pass is late enough that the
// library scan and the ffmpeg probe have already happened, so it reads caches
// instead of warming them. The heartbeat only transmits `app` when a value
// changed, so re-running it on the interval is nearly free.
const DYNAMIC_APP_INFO_FIRST_MS = 60000;
const DYNAMIC_APP_INFO_INTERVAL_MS = 600000;

function scheduleDynamicAppInfo() {
  try {
    const first = setTimeout(() => { void reportDynamicAppInfo(); }, DYNAMIC_APP_INFO_FIRST_MS);
    if (typeof first.unref === 'function') first.unref();
    const repeat = setInterval(() => { void reportDynamicAppInfo(); }, DYNAMIC_APP_INFO_INTERVAL_MS);
    if (typeof repeat.unref === 'function') repeat.unref();
  } catch (error) {
    logger.warn(`Failed to schedule dynamic telemetry app info: ${error.message}`);
  }
}

async function createWindow() {
  // The window needs nothing from settings, and its renderer process takes a
  // few hundred ms to come up: start it first and load settings meanwhile.
  if (benchmarkHarness) benchmarkHarness.markStartup('settingsLoad');
  const settingsLoadStartedAt = Date.now();
  settingsLoading = loadSettings().then((loaded) => {
    settings = loaded;
    bootTrace.mark('settings_loaded');
    telemetry.metric('startup.settings_load_ms', Date.now() - settingsLoadStartedAt, { unit: 'ms' });
    if (benchmarkHarness) benchmarkHarness.endStartup('settingsLoad');
    return loaded;
  });

  // Discord RPC starts after the renderer loads (below).
  // Sized to the work area before it is ever shown: the window always opens
  // maximized, and the renderer lays the library out once at its final width
  // instead of once at 1024x768 and again on maximize.
  const workArea = screen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    titleBarStyle: "hidden",
    backgroundColor: '#050608',
    autoHideMenuBar: true,
    frame: false,
    titleBarOverlay: {
      color: '#050608',
      symbolColor: '#c8c8c8',
      // 1px shorter than the 34px titlebar strip: the overlay is opaque and
      // drawn over the page, so this lets the titlebar's bottom border run
      // uninterrupted beneath the min/max/close buttons.
      height: 33
    },
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false,
      enableRemoteModule: true,
      preload: path.join(__dirname, "preload.js"),
      // Dev serves the renderer from http://127.0.0.1:5173, so file:// thumbnails
      // /videos would be blocked as cross-origin. Relax only in dev; the packaged
      // app loads from file:// where same-scheme access already works.
      webSecurity: !isDev,
    },
  });

  bootTrace.mark('window_constructed');
  const windowCreatedAt = Date.now();
  let rendererDidFinishLoad = false;
  rendererConsoleCapture.attach(mainWindow.webContents);

  // Renderer rewrite: the React renderer draws its own titlebar strip; native
  // window controls come from `titleBarOverlay` above. custom-electron-titlebar
  // is no longer used (its renderer-side Titlebar went away with the legacy UI).
  // Renderer rewrite (plan D9): plain Vite serves the React renderer.
  // Dev -> Vite dev server; packaged -> the built bundle in dist/.
  if (isDev) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "renderer-dist", "index.html"));
  }
  Menu.setApplicationMenu(null);

  // Safety fallback in case the renderer never signals ready. Armed before
  // any await below: if one of them throws, the window must still appear.
  const splashFallback = setTimeout(() => {
    // The fallback firing means the renderer never reported ready: the user is
    // looking at a window that may be empty. It used to fire with no log at all.
    if (!mainWindowRevealed) {
      telemetry.event('renderer_never_ready', {
        kind: telemetry.KIND.CRASH,
        severity: telemetry.SEVERITY.FATAL,
        message: `renderer never reported ready after ${Math.round((Date.now() - windowCreatedAt) / 1000)}s`,
        context: {
          ms_waited: Date.now() - windowCreatedAt,
          did_finish_load: rendererDidFinishLoad
        }
      });
    }
    revealMainWindow();
  }, 30000);
  mainWindow.on('closed', () => clearTimeout(splashFallback));

  try {
    await settingsLoading;
  } catch (error) {
    // loadSettings falls back to defaults internally; a throw here means even
    // that failed. The window is up and must not be orphaned by a rejection.
    logger.error('Settings failed to load; continuing with defaults:', error);
    settings = settings || {};
  }
  // Telemetry knows the user's choice only once settings exist, so init runs
  // here; everything recorded earlier is replayed.
  telemetry.init({
    userDataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    enabled: settings.telemetry?.enabled !== false,
    clipdipInstallIdPath: clipdipInstallIdPath(),
    ipcMain
  });
  reportAppInfo();
  scheduleDynamicAppInfo();

  // Cheap async setup that must exist before the renderer asks for
  // thumbnails or a new clip lands; the renderer is still loading.
  migrateLegacySharingTokenIfPresent().catch((error) => {
    logger.warn(`Legacy sharing token migration failed: ${error.message}`);
  });
  try {
    await thumbnailsModule.initThumbnailCache();
  } catch (error) {
    logger.error('Thumbnail cache init failed; thumbnails will be regenerated on demand:', error);
  }
  if (benchmarkHarness) benchmarkHarness.markStartup('fileWatcherSetup');
  fileWatcherModule.setupFileWatcher(settings.clipLocation, {
    onNewClip: (fileName) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('new-clip-added', fileName);
      }
    },
    // The single recursive watch has one change buffer; when it overflows,
    // events were lost. Walk the library and announce anything not yet known.
    onOverflow: async () => {
      const known = new Set(lastClipNames);
      const clips = await clipsModule.getClips(getSettings);
      const names = Array.isArray(clips) ? clips.map((c) => c.originalName) : [];
      lastClipNames = names;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      for (const name of names) {
        if (!known.has(name)) mainWindow.webContents.send('new-clip-added', name);
      }
    }
  });
  if (benchmarkHarness) benchmarkHarness.endStartup('fileWatcherSetup');


  // Renderer signals when clips are loaded and UI is fully ready
  // The renderer reports when the library grid is painted with its visible
  // thumbnails loaded (it fades its brand screen out at the same moment).
  ipcMain.once('renderer-ready', () => {
    bootTrace.mark('renderer_ready');
    // Process start to a usable library. The only startup number a user ever
    // notices; startup.window_visible_ms is the brand screen before it.
    telemetry.metric('startup.total_ms', Math.round(perfNow()), { unit: 'ms', dims: { cold: true } });
    firstPaintSeen = true;
    maybeReveal();
    // The compositor normally frames this state within a few dozen ms;
    // never keep the window hidden for long if it does not.
    setTimeout(() => {
      screencastActive = false;
      maybeReveal();
    }, REVEAL_FALLBACK_MS);
  });

  // Without a snapshot the renderer only reports ready after the folder
  // scan; if even that never comes, show the window with whatever it has.
  mainWindow.once('ready-to-show', () => {
    bootTrace.mark('ready_to_show');
    setTimeout(() => {
      if (mainWindowRevealed) return;
      firstPaintSeen = true;
      screencastActive = false;
      maybeReveal();
    }, 6000);
  });
  startFrameWatch(mainWindow);

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key.toLowerCase() === 'i' && input.control && input.shift) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // The page itself failed to load — in packaged builds that is a blank
  // window with no way forward. Sub-frame failures are not fatal, skip them.
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    telemetry.event('renderer_load_failed', {
      kind: telemetry.KIND.CRASH,
      severity: telemetry.SEVERITY.FATAL,
      message: `renderer failed to load (error ${errorCode})`,
      context: { error_code: errorCode, is_dev: isDev }
    });
  });

  // Main-thread hangs. Paired with 'responsive' so the event carries how long
  // the freeze actually lasted instead of just "it happened".
  let unresponsiveSince = 0;
  mainWindow.webContents.on('unresponsive', () => {
    unresponsiveSince = Date.now();
  });
  mainWindow.webContents.on('responsive', () => {
    if (!unresponsiveSince) return;
    const msUnresponsive = Date.now() - unresponsiveSince;
    unresponsiveSince = 0;
    telemetry.event('renderer_unresponsive', {
      kind: telemetry.KIND.DEGRADED,
      severity: telemetry.SEVERITY.WARNING,
      message: `renderer main thread froze for ${Math.round(msUnresponsive / 1000)}s`,
      context: { ms_unresponsive: msUnresponsive }
    });
  });

  mainWindow.webContents.on('did-finish-load', () => {
    rendererDidFinishLoad = true;
    // Trace marker: splits the window-created -> renderer-running "dark gap"
    // into page-load (Chromium + module serving) vs renderer boot.
    if (global.__perf?.now && global.__perf?.fsSpan) {
      global.__perf.fsSpan('renderer-did-finish-load', global.__perf.now(), 0, {});
    }
    flushCliplibAuthEvents();
    flushQueuedRendererEvents();
    processQueuedProtocolUrls().catch((error) => {
      logger.error('Failed processing protocol queue after renderer load:', error);
    });
  });
  
  if (isDev) {
    try {
      require("electron-reloader")(module, {
        debug: process.env.CLIPS_RELOADER_DEBUG === '1',
        // Vite owns renderer reloading now; only reload for main-process changes.
        watchRenderer: false,
        ignore: ['src/**', 'dist/**', 'legacy/**'],
      });
    } catch (_) {
      logger.info("Error");
    }
  }

  // detect idling

  mainWindow.on('focus', () => {
    clearTimeout(idleTimer);
    if (settings.enableDiscordRPC) {
      mainWindow.webContents.send('check-activity-state');
    }
  });

  mainWindow.on('blur', () => {
    if (settings.enableDiscordRPC) {
      idleTimer = setTimeout(() => {
        discordModule.clearDiscordPresence();
      }, IDLE_TIMEOUT);
    }
  });

  powerMonitor.on('unlock-screen', () => {
    clearTimeout(idleTimer);
    if (settings.enableDiscordRPC) {
      mainWindow.webContents.send('check-activity-state');
    }
  });

  powerMonitor.on('lock-screen', () => {
    if (settings.enableDiscordRPC) {
      discordModule.clearDiscordPresence();
    }
  });

  // Always resolve with the created window so callers can await it
  return mainWindow;
}

async function checkForUpdatesInBackground(mainWindow) {
  try {
    await updaterModule.checkForUpdates(mainWindow);
  } catch (error) {
    logger.error('Background update check failed:', error);
  }
}

bootTrace.mark('modules_loaded');
app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) {
    return;
  }

  appIsReady = true;
  bootTrace.mark('app_ready');
  bootTrace.init({ ipcMain, userData: app.getPath('userData') });

  registerCliplibProtocol();

  telemetry.metric('startup.module_load_ms', Date.now() - moduleLoadStartedAt, { unit: 'ms' });
  if (benchmarkHarness) {
    benchmarkHarness.endStartup('moduleLoad');
    benchmarkHarness.recordAppReady();
    benchmarkHarness.markStartup('windowCreation');
  }

  const windowCreateStartedAt = Date.now();
  const win = await createWindow();
  telemetry.metric('startup.window_create_ms', Date.now() - windowCreateStartedAt, { unit: 'ms' });

  if (benchmarkHarness) benchmarkHarness.endStartup('windowCreation');

  // Feed media (<video>/<img> pointed at the share server) needs the Bearer
  // token attached main-side; JSON API calls go through share-api-request.
  shareModule.installMediaAuthHeaders(win.webContents.session);

  // Heavy optional subsystems (updater -> axios, Discord RPC) start after the
  // renderer has loaded so their requires never sit on the startup path.
  win.webContents.once('did-finish-load', () => {
    logger.info('Renderer did-finish-load event fired');
    // Updater (axios, semver), Discord RPC and the profile widget used to
    // start here, which is while the renderer is booting and waiting on this
    // thread for its first IPC replies. They run from runDeferredServices().
  });
  
  // Start periodic saves to prevent data loss
  clipsModule.startPeriodicSave(getSettings);

  // clipdip bootstrap, ffmpeg verification and taskbar pin repair run from
  // runDeferredServices() once the library is visible.
  processQueuedProtocolUrls().catch((error) => {
    logger.error('Failed processing startup protocol queue:', error);
  });

  // Prune stale settings backups and diagnostics zips well after startup;
  // lazyModule keeps the require itself off the startup path too.
  setTimeout(() => {
    lazyModule('./main/storage-maintenance')
      .run()
      .catch((error) => logger.warn(`Storage maintenance failed: ${error.message}`));
  }, 10_000);
}).catch((error) => {
  // Boot never got past window creation: there is no UI to show an error in,
  // so this was previously an unhandled rejection and nothing else.
  telemetry.event('boot_window_create_failed', {
    kind: telemetry.KIND.CRASH,
    severity: telemetry.SEVERITY.FATAL,
    error
  });
  logger.error('Startup failed before the window was ready:', error);
});

app.on("window-all-closed", () => {
  telemetry.sessionEnd('window_all_closed');
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('update-discord-presence', (event, details, state, startTimestamp) => {
  clearTimeout(idleTimer);
  discordModule.updateDiscordPresence(details, state);
});

ipcMain.handle('toggle-discord-rpc', async (event, enable) => {
  settings.enableDiscordRPC = enable;
  await saveSettings(settings);
  if (enable) {
    await discordModule.initDiscordRPC(getSettings);
  } else {
    discordModule.clearDiscordPresence();
    discordModule.destroyDiscordRPC();
  }
});

ipcMain.handle('clear-discord-presence', () => {
  discordModule.clearDiscordPresence();
});

ipcMain.handle('get-settings', () => {
  return settings;
});

// --- Integrated clipdip -----------------------------------------------------

ipcMain.handle('clipdip-get-config', () => clipdipModule.getConfig());

ipcMain.handle('clipdip-set-config', (event, patch) => clipdipModule.setConfig(patch));

ipcMain.handle('clipdip-status', () => clipdipModule.getStatus());

ipcMain.handle('clipdip-start', () => clipdipModule.start());

ipcMain.handle('clipdip-stop', () => clipdipModule.quit());

ipcMain.handle('clipdip-restart', () => clipdipModule.restart());

// Side effects only — the renderer persists clipdip.enabled/autostart through
// its normal settings path (SettingsContext -> save-settings), which replaces
// the whole settings object; writing settings here too would race that copy.
ipcMain.handle('clipdip-set-autostart', async (event, enabled) => {
  await clipdipModule.setAutostart(enabled);
  return { success: true };
});

ipcMain.handle('clipdip-set-enabled', (event, enabled) => clipdipModule.setEnabled(enabled));

// Stateless CLI queries (spawn the exe, parse its JSON line).
ipcMain.handle('clipdip-list-audio-devices', () => clipdipModule.listAudioDevices());

ipcMain.handle('clipdip-list-monitors', () => clipdipModule.listMonitors());

ipcMain.handle('clipdip-filename-variables', () => clipdipModule.getFilenameVariables());

ipcMain.handle('clipdip-preview-filename', (event, template) =>
  clipdipModule.previewFilename(template));

// Control-server call against the running instance ({ok:false,error:"not_running"}
// when it isn't up).
ipcMain.handle('clipdip-control', (event, payload) =>
  clipdipModule.control(payload?.cmd, payload?.args));

ipcMain.handle("get-clips", async () => {
  const clips = await clipsModule.getClips(getSettings);
  bootTrace.mark('get_clips_resolved');
  lastClipNames = Array.isArray(clips) ? clips.map((c) => c.originalName) : [];
  return clips;
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('quit-app', () => {
  app.quit();
});

ipcMain.handle('check-for-updates', async () => {
  return updaterModule.checkForUpdates(mainWindow, { silent: true });
});

ipcMain.handle('get-new-clip-info', async (event, fileName) => {
  return await clipsModule.getNewClipInfo(getSettings, fileName);
});

ipcMain.handle("save-custom-name", async (event, originalName, customName) => {
  try {
    await metadataModule.saveCustomName(originalName, customName, getSettings);
    return { success: true, customName };
  } catch (error) {
    logger.error("Error in save-custom-name handler:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-clip-info", async (event, clipName) => {
  return ffmpegModule.getClipInfo(clipName, getSettings, thumbnailsModule);
});

ipcMain.handle("extract-audio-tracks", async (event, clipName) => {
  try {
    return await ffmpegModule.extractAudioTracks(clipName, getSettings, thumbnailsModule);
  } catch (error) {
    logger.error(`Error extracting audio tracks for ${clipName}:`, error);
    return [];
  }
});

ipcMain.handle("reset-clip-cache", async (event, clipName) => {
  try {
    clipWarmer.forget(clipName);
    return await ffmpegModule.resetClipCache(clipName, getSettings, thumbnailsModule);
  } catch (error) {
    logger.error(`Error resetting cache for ${clipName}:`, error);
    return { removed: [], error: error.message };
  }
});

ipcMain.handle("save-track-state", async (event, clipName, trackState) => {
  return metadataModule.saveTrackState(clipName, trackState, getSettings);
});

ipcMain.handle("get-track-state", async (event, clipName) => {
  return metadataModule.getTrackState(clipName, getSettings);
});

ipcMain.handle("get-track-preferences", async () => {
  return metadataModule.getTrackPreferences(app.getPath.bind(app));
});

ipcMain.handle("save-track-preferences", async (event, trackName, patch) => {
  return metadataModule.saveTrackPreferences(trackName, patch, app.getPath.bind(app));
});

ipcMain.handle("get-trim", async (event, clipName) => {
  return metadataModule.getTrimData(clipName, getSettings);
});

// Hover-preview start time in one round trip: trim.start when set, else
// mid-clip from the cached thumbnail-metadata duration. Never probes — a
// cache miss returns 0 and the preview simply starts at the beginning
// (the full probe happens when the clip is actually opened).
ipcMain.handle("get-preview-start-time", async (event, clipName) => {
  try {
    const trim = await metadataModule.getTrimData(clipName, getSettings);
    if (trim && typeof trim.start === "number") return trim.start;
    const settings = await getSettings();
    const clipPath = path.join(settings.clipLocation, clipName);
    const thumbnailPath = thumbnailsModule.generateThumbnailPath(clipPath);
    const metadata = await thumbnailsModule.getThumbnailMetadata(thumbnailPath);
    const duration = Number(metadata && metadata.duration);
    if (Number.isFinite(duration) && duration > 0) {
      return duration > 40 ? duration / 2 : 0;
    }
  } catch (error) {
    logger.warn(`Error resolving preview start time for ${clipName}: ${error.message}`);
  }
  return 0;
});

// Everything the player needs to open a clip, gathered in one round trip
// (the player used to fire ~9 read-only IPCs per open across several waves,
// each paying queueing latency on a busy main process).
ipcMain.handle("warm-clip-open", (_event, clipName) => {
  clipWarmer.warm(clipName, true);
});

ipcMain.handle("get-clip-open-state", async (event, clipName) => {
  const startedAt = Date.now();
  clipWarmer.pause();
  // Each fallback below is indistinguishable from a real value once it reaches
  // the player: no trim, no tags, default volume. The slot name turns "the clip
  // opened wrong" into "these two reads failed" without naming the clip.
  const missing = [];
  // Why the probe failed, for the clip_open_partial context. The clip name is
  // stripped out (it is user content) and telemetry scrubs paths on top.
  let probeError;
  const swallow = (slot, promise, fallback) => {
    const slotStartedAt = Date.now();
    const timeSlot = () => {
      telemetry.metric('clip_open_slot_ms', Date.now() - slotStartedAt, { unit: 'ms', dims: { slot } });
    };
    return promise.then(
      (value) => {
        timeSlot();
        return value;
      },
      (error) => {
        timeSlot();
        missing.push(slot);
        if (slot === 'clip_info') {
          logger.error(`get-clip-open-state: clip info probe failed for ${clipName} (code ${error?.code ?? 'n/a'}):`, error);
          probeError = String(error?.message || error || 'unknown')
            .split(clipName).join('<clip>')
            .slice(0, 120);
        }
        return fallback;
      }
    );
  };
  const [clipInfo, trimData, clipTags, thumbnailPath, volume, speed, volumeRange, trackState, trackPreferences] =
    await Promise.all([
      swallow('clip_info', ffmpegModule.getClipInfo(clipName, getSettings, thumbnailsModule), null),
      swallow('trim', metadataModule.getTrimData(clipName, getSettings), null),
      swallow('tags', metadataModule.getClipTags(clipName, getSettings), []),
      swallow('thumbnail', thumbnailsModule.getThumbnailPath(clipName, getSettings), null),
      swallow('volume', metadataModule.getVolume(clipName, getSettings), 1),
      swallow('speed', metadataModule.getSpeed(clipName, getSettings), 1),
      swallow('volume_range', metadataModule.getVolumeRange(clipName, getSettings), null),
      swallow('track_state', metadataModule.getTrackState(clipName, getSettings), null),
      swallow('track_prefs', metadataModule.getTrackPreferences(app.getPath.bind(app)), null),
    ]);
  const totalMs = Date.now() - startedAt;
  telemetry.metric('clip_open_ms', totalMs, { unit: 'ms' });
  if (missing.length > 0) {
    telemetry.event('clip_open_partial', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.ERROR,
      context: { missing, total_ms: totalMs, probe_error: probeError }
    });
  }
  return { clipInfo, trimData, clipTags, thumbnailPath, volume, speed, volumeRange, trackState, trackPreferences };
});

ipcMain.handle("save-speed", async (event, clipName, speed) => {
  return metadataModule.saveSpeed(clipName, speed, getSettings);
});

ipcMain.handle("get-speed", async (event, clipName) => {
  return metadataModule.getSpeed(clipName, getSettings);
});

ipcMain.handle("save-volume", async (event, clipName, volume) => {
  return metadataModule.saveVolume(clipName, volume, getSettings);
});

ipcMain.handle("get-volume", async (event, clipName) => {
  return metadataModule.getVolume(clipName, getSettings);
});

ipcMain.handle("get-clip-tags", async (event, clipName) => {
  return metadataModule.getClipTags(clipName, getSettings);
});

ipcMain.handle("get-clip-tags-batch", async (event, clipNames) => {
  return metadataModule.getClipTagsBatch(clipNames, getSettings);
});

ipcMain.handle("save-clip-tags", async (event, clipName, tags) => {
  return metadataModule.saveClipTags(clipName, tags, getSettings);
});

ipcMain.handle("load-global-tags", async () => {
  return metadataModule.loadGlobalTags(app.getPath.bind(app));
});

ipcMain.handle("save-global-tags", async (event, tags) => {
  return metadataModule.saveGlobalTags(tags, app.getPath.bind(app));
});

ipcMain.handle("restore-missing-global-tags", async () => {
  return metadataModule.restoreMissingGlobalTags(getSettings, app.getPath.bind(app));
});

ipcMain.handle('show-diagnostics-save-dialog', async () => {
  return dialogsModule.showDiagnosticsSaveDialog(mainWindow);
});

ipcMain.handle('generate-diagnostics-zip', async (event, targetPath, options) => {
  return diagnosticsModule.generateDiagnosticsZip(targetPath, event.sender, options);
});

ipcMain.handle('upload-session-logs', async (event, payload) => {
  return logUploader.uploadSessionLogs(payload);
});

ipcMain.handle('upload-diagnostics-bundle', async (event, payload) => {
  return logUploader.uploadDiagnosticsBundle({
    ...(payload || {}),
    progressCallback: (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('diagnostics-progress', progress);
    }
  });
});

ipcMain.handle('test-share-connection', async (event, overrides) => {
  return shareModule.testConnection(getSettings, overrides || {});
});

ipcMain.handle('start-cliplib-auth', async (event, overrides) => {
  const serverUrl = shareModule.DEFAULT_SERVER_URL;
  const requestedServerUrl = overrides?.serverUrl || serverUrl;
  const normalizedServerUrl = typeof requestedServerUrl === 'string' ? requestedServerUrl.trim() : serverUrl;

  try {
    const session = shareModule.generateDesktopAuthSessionId();
    const authUrl = shareModule.buildDesktopAuthUrl(normalizedServerUrl, session);
    pendingCliplibAuthSession = {
      session,
      serverUrl: normalizedServerUrl,
      createdAt: Date.now()
    };

    await shell.openExternal(authUrl);
    return {
      success: true
    };
  } catch (error) {
    pendingCliplibAuthSession = null;
    logger.error('Failed to start ClipLib desktop auth:', error);
    return {
      success: false,
      error: `Unable to open ClipLib login: ${error.message}`
    };
  }
});

ipcMain.handle('disconnect-cliplib-auth', async () => {
  pendingCliplibAuthSession = null;
  try {
    await shareModule.clearStoredApiToken();
    await clearLegacySharingToken();
    return { success: true };
  } catch (error) {
    logger.error('Failed to disconnect ClipLib auth:', error);
    return {
      success: false,
      error: `Unable to disconnect ClipLib account: ${error.message}`
    };
  }
});

ipcMain.handle('share-clip', async (event, payload) => {
  const sender = event.sender;
  const progressHandler = (progressPayload) => {
    if (!sender || sender.isDestroyed()) return;
    sender.send('share-upload-progress', progressPayload);
  };
  return shareModule.shareClip(payload, getSettings, ffmpegModule, progressHandler);
});

ipcMain.handle('get-share-users', async (event, overrides) => {
  return shareModule.fetchMentionableUsers(getSettings, overrides || {});
});

ipcMain.handle('share-api-request', async (event, request) => {
  return shareModule.apiRequest(getSettings, request || {});
});

// Profile banner upload: pick an image via the native dialog, then multipart
// POST it to /users/me/banner. Returns { success, error?, canceled? }.
ipcMain.handle('share-upload-banner', async (event) => {
  const owner = event.sender.getOwnerBrowserWindow?.() || mainWindow;
  const result = await dialog.showOpenDialog(owner, {
    title: 'Choose a banner image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }
  return shareModule.uploadProfileBanner(getSettings, result.filePaths[0]);
});

ipcMain.handle("remove-tag-from-all-clips", async (event, tagToRemove) => {
  return metadataModule.removeTagFromAllClips(tagToRemove, getSettings);
});

ipcMain.handle("update-tag-in-all-clips", async (event, oldTag, newTag) => {
  return metadataModule.updateTagInAllClips(oldTag, newTag, getSettings);
});

ipcMain.handle("get-clip-location", async () => {
  const location = await getClipLocation(getSettings);
  return location;
});

ipcMain.handle("set-clip-location", async (event, newLocation) => {
  const location = await setClipLocation(getSettings, newLocation);
  settings.clipLocation = newLocation; // Update cached settings
  return location;
});

ipcMain.handle("open-folder-dialog", async () => {
  return dialogsModule.showFolderDialog(mainWindow);
});

ipcMain.handle("get-thumbnail-path", async (event, clipName) => {
  return thumbnailsModule.getThumbnailPath(clipName, getSettings);
});

ipcMain.handle("get-thumbnail-paths-batch", async (event, clipNames) => {
  return thumbnailsModule.getThumbnailPathsBatch(clipNames, getSettings);
});

app.on('before-quit', () => {
  telemetry.sessionEnd('quit');

  // Stop periodic saves
  clipsModule.stopPeriodicSave();

  // Stop thumbnail queue processing
  thumbnailsModule.stopQueue();

  // Save current clip list for next session comparison
  clipsModule.saveCurrentClipList(getSettings);
  bootTrace.flush();
});

ipcMain.handle("regenerate-thumbnail-for-trim", async (event, clipName, startTime) => {
  return thumbnailsModule.regenerateThumbnailForTrim(clipName, startTime, getSettings);
});

// In main.js
ipcMain.handle('save-settings', async (event, newSettings) => {
  try {
    const updated = await updateSettings(newSettings);
    settings = updated; // Update main process settings cache
    // The opt-out has to bite immediately, not on the next launch.
    telemetry.setEnabled(newSettings.telemetry?.enabled !== false);
    reportAppInfo();
    return updated;
  } catch (error) {
    logger.error('Error in save-settings handler:', error);
    throw error;
  }
});

// Get default keybindings from settings-manager
ipcMain.handle('get-default-keybindings', () => {
  return getDefaultKeybindings();
});

ipcMain.handle("generate-thumbnails-progressively", async (event, clipNames) => {
  // Wrapper to call metadata module's getTrimData with getSettings
  const getTrimDataWrapper = (clipName) => metadataModule.getTrimData(clipName, getSettings);
  return thumbnailsModule.generateThumbnailsProgressively(clipNames, event, getSettings, getTrimDataWrapper);
});


ipcMain.handle("generate-thumbnail", async (event, clipName) => {
  return thumbnailsModule.generateThumbnail(clipName, getSettings);
});

ipcMain.handle("save-trim", async (event, clipName, start, end) => {
  try {
    await metadataModule.saveTrimData(clipName, { start, end }, getSettings);
    return { success: true };
  } catch (error) {
    logger.error("Error in save-trim handler:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("delete-trim", async (event, clipName) => {
  try {
    await metadataModule.deleteTrimData(clipName, getSettings);
    return { success: true };
  } catch (error) {
    logger.error("Error in delete-trim handler:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("delete-clip", async (event, clipName, videoPlayer) => {
  return clipsModule.deleteClip(clipName, getSettings, thumbnailsModule, videoPlayer);
});

// Reveal clip in File Explorer
ipcMain.handle('reveal-clip', async (event, clipName) => {
  return clipsModule.revealClip(clipName, getSettings);
});

ipcMain.handle("open-save-dialog", async (event, type, clipName, customName) => {
  return dialogsModule.showSaveDialog(mainWindow, type, clipName, customName);
});

function buildExportProgressCallbacks(event) {
  return {
    onProgress: (percent) => {
      if (!event?.sender?.isDestroyed()) {
        event.sender.send('export-progress', percent);
      }
    },
    onFallback: () => {
      if (!event?.sender?.isDestroyed()) {
        event.sender.send('show-fallback-notice');
      }
    },
    onDecodeFallback: (payload) => {
      if (!event?.sender?.isDestroyed()) {
        event.sender.send('show-decode-fallback-notice', payload);
      }
    }
  };
}

// Exports own the CPU and the disk while they run; the clip warmer waits.
async function withoutWarmer(work) {
  clipWarmer.pause(60 * 60 * 1000);
  try {
    return await work();
  } finally {
    clipWarmer.resume();
  }
}

ipcMain.handle("export-video", (event, clipName, start, end, volume, speed, savePath, audioMix) => withoutWarmer(() => {
  const callbacks = buildExportProgressCallbacks(event);
  return ffmpegModule.exportVideo(clipName, start, end, volume, speed, savePath, getSettings, callbacks, { audioMix });
}));

ipcMain.handle("export-trimmed-video", (event, clipName, start, end, volume, speed, audioMix) => withoutWarmer(() => {
  const callbacks = buildExportProgressCallbacks(event);
  return ffmpegModule.exportTrimmedVideo(clipName, start, end, volume, speed, getSettings, callbacks, { audioMix });
}));

ipcMain.handle("export-audio", (event, clipName, start, end, volume, speed, savePath, audioMix) => withoutWarmer(() =>
  ffmpegModule.exportAudio(clipName, start, end, volume, speed, savePath, getSettings, { audioMix })
));

ipcMain.handle('get-tag-preferences', async () => {
  return metadataModule.getTagPreferences(app.getPath.bind(app));
});

ipcMain.handle('save-tag-preferences', async (event, preferences) => {
  return metadataModule.saveTagPreferences(preferences, app.getPath.bind(app));
});

ipcMain.handle('open-folder-dialog-steelseries', async () => {
  return dialogsModule.showSteelSeriesFolderDialog();
});

ipcMain.handle('import-steelseries-clips', async (event, sourcePath) => {
  return steelSeriesModule.importSteelSeriesClips(
    sourcePath,
    loadSettings,
    app.getPath.bind(app),
    event.sender
  );
});

ipcMain.handle('save-volume-range', async (event, clipName, volumeData) => {
  return metadataModule.saveVolumeRange(clipName, volumeData, getSettings);
});

ipcMain.handle('get-volume-range', async (event, clipName) => {
  return metadataModule.getVolumeRange(clipName, getSettings);
});

// Handler to log watch sessions from the renderer
ipcMain.handle('log-watch-session', (event, sessionData) => {
  if (sessionData && sessionData.durationSeconds > 0) {
    logActivity('watch_session', sessionData);
  }
  // No return value needed
});

ipcMain.handle("get-game-icon", async (event, clipName) => {
  return metadataModule.getGameIcon(clipName, getSettings);
});

ipcMain.handle("get-game-icons-batch", async (event, clipNames) => {
  return metadataModule.getGameIconsBatch(clipNames, getSettings);
});

ipcMain.handle("get-clip-participants", async (event, clipNames) => {
  return metadataModule.getClipParticipants(clipNames, getSettings);
});

// The renderer passes the names it just got from get-clips, so this does not
// walk the library a second time.
ipcMain.handle('get-new-clips-info', async (_event, knownNames) => {
  return await clipsModule.getNewClipsInfo(getSettings, Array.isArray(knownNames) ? knownNames : undefined);
});

ipcMain.handle('get-clips-folder-size', async () => {
  return await clipsModule.getClipsFolderSize(getSettings);
});

ipcMain.handle('mark-clips-watched', async (event, clipNames) => {
  return await clipsModule.markClipsWatched(clipNames);
});

ipcMain.handle('save-clip-list-immediately', async () => {
  await clipsModule.saveCurrentClipList(getSettings);
});

