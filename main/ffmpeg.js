/**
 * FFmpeg module - handles video/audio encoding and export
 *
 * Provides NVENC hardware encoding with automatic fallback to software encoding.
 * Handles progress tracking and clipboard integration.
 */

// Imports
const { execFile } = require('child_process');
const { clipboard, ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const ffprobePath = require('@ffprobe-installer/ffprobe').path.replace('app.asar', 'app.asar.unpacked');
const logger = require('../utils/logger');
const telemetry = require('./telemetry');
const { logActivity } = require('../utils/activity-tracker');
const NVENC_STATUS_TTL_MS = 5 * 60 * 1000;
const DECODER_LIST_TTL_MS = 5 * 60 * 1000;
const HWACCEL_LIST_TTL_MS = 5 * 60 * 1000;
const DISCORD_TARGET_BYTES = Math.floor(9.5 * 1024 * 1024);
const DISCORD_AUDIO_BITRATE_K = 96;
const UNKNOWN_CODEC_KEY = '__unknown__';
const CUDA_DECODER_BY_CODEC = {
  h264: 'h264_cuvid',
  hevc: 'hevc_cuvid',
  av1: 'av1_cuvid',
  mpeg2video: 'mpeg2_cuvid',
  vp8: 'vp8_cuvid',
  vp9: 'vp9_cuvid',
  mjpeg: 'mjpeg_cuvid'
};
const EXPORT_QUALITY_VALUES = new Set(['discord', 'high', 'lossless']);
const EXPORT_PRESET_VALUES = new Set([
  'discord_fast',
  'discord_quality',
  'compact',
  'balanced',
  'high_fidelity',
  'quality_first',
  'max_quality',
  'archival_lossless',
  'custom'
]);
const EXPORT_SIZE_GOAL_VALUES = new Set(['auto', 'discord_10mb', 'small_25mb', 'medium_50mb', 'large_100mb', 'unlimited']);
const EXPORT_QUALITY_BIAS_VALUES = new Set(['performance', 'balanced', 'quality']);
const EXPORT_SPEED_BIAS_VALUES = new Set(['fast', 'balanced', 'best']);
const EXPORT_SIZE_GOAL_BYTES = {
  auto: null,
  discord_10mb: DISCORD_TARGET_BYTES,
  small_25mb: Math.floor(25 * 1024 * 1024),
  medium_50mb: Math.floor(50 * 1024 * 1024),
  large_100mb: Math.floor(100 * 1024 * 1024),
  unlimited: null
};
const EXPORT_PRESET_CONFIG = {
  discord_fast: {
    quality: 'discord',
    sizeGoal: 'discord_10mb',
    qualityBias: 'balanced',
    speedBias: 'fast'
  },
  discord_quality: {
    quality: 'discord',
    sizeGoal: 'discord_10mb',
    qualityBias: 'quality',
    speedBias: 'balanced'
  },
  compact: {
    quality: 'high',
    sizeGoal: 'small_25mb',
    qualityBias: 'performance',
    speedBias: 'fast'
  },
  balanced: {
    quality: 'high',
    sizeGoal: 'medium_50mb',
    qualityBias: 'balanced',
    speedBias: 'balanced'
  },
  high_fidelity: {
    quality: 'high',
    sizeGoal: 'medium_50mb',
    qualityBias: 'quality',
    speedBias: 'balanced'
  },
  quality_first: {
    quality: 'high',
    sizeGoal: 'large_100mb',
    qualityBias: 'quality',
    speedBias: 'best'
  },
  max_quality: {
    quality: 'high',
    sizeGoal: 'unlimited',
    qualityBias: 'quality',
    speedBias: 'best'
  },
  archival_lossless: {
    quality: 'lossless',
    sizeGoal: 'unlimited',
    qualityBias: 'quality',
    speedBias: 'best'
  }
};
const NVENC_PRESET_BY_SPEED_BIAS = {
  fast: { discord: 'p1', high: 'p3', lossless: 'p5' },
  balanced: { discord: 'p2', high: 'p5', lossless: 'p6' },
  best: { discord: 'p4', high: 'p6', lossless: 'p7' }
};
const SOFTWARE_PRESET_BY_SPEED_BIAS = {
  fast: 'superfast',
  balanced: 'fast',
  best: 'medium'
};
const QUALITY_BIAS_BITRATE_SCALE = {
  performance: 0.82,
  balanced: 1,
  quality: 1.2
};
const QUALITY_BIAS_CQ_DELTA = {
  performance: 3,
  balanced: 0,
  quality: -2
};
const DISCORD_LOOKAHEAD_BY_SPEED = {
  fast: 0,
  balanced: 8,
  best: 16
};
const DISCORD_BFRAMES_BY_SPEED = {
  fast: 0,
  balanced: 2,
  best: 2
};
const HIGH_LOOKAHEAD_BY_SPEED = {
  fast: 8,
  balanced: 20,
  best: 32
};
const HIGH_BFRAMES_BY_SPEED = {
  fast: 0,
  balanced: 2,
  best: 3
};
let nvencStatusCache = null;
let decoderListCache = null;
let hwAccelListCache = null;
const preferredDecodeModeByCodec = new Map();

// FFmpeg binary paths
// Configure FFmpeg paths
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const PROBE_FALLBACK_COALESCE_MS = 600000;

/**
 * Split a child_process error into the two telemetry-safe fields it can carry.
 * `code` is a string errno when the spawn itself failed and a number when the
 * process ran and exited non-zero. Accepts both a raw Error and the
 * `{ error, stdout, stderr }` shape execFileAsync rejects with.
 */
function execErrorCodes(rejection) {
  const error = rejection && rejection.error ? rejection.error : rejection;
  const code = error?.code;
  return {
    errno: typeof code === 'string' ? code : undefined,
    exit_code: typeof code === 'number' ? code : undefined
  };
}

/** Pull the numeric exit code out of a fluent-ffmpeg error message. */
function parseFfmpegExitCode(error) {
  const match = String(error?.message || '').match(/exited with code (-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

/**
 * Reduce raw NVENC failure text to a short enum. The raw text can contain the
 * input path, so it must never leave the machine.
 * @returns {'no_encoder'|'driver'|'device'|'other'}
 */
function classifyNvencFailure(rawText) {
  const text = String(rawText || '').toLowerCase();
  if (/unknown encoder|encoder not found|no such encoder|cannot find encoder/.test(text)) {
    return 'no_encoder';
  }
  if (/driver|nvcuda|nvml|version mismatch|minimum required/.test(text)) {
    return 'driver';
  }
  if (/no capable devices|no device|device not found|no_device|invalid device|out of memory|not supported/.test(text)) {
    return 'device';
  }
  return 'other';
}

/**
 * Promote the export benchmark that already gets built per export. Numbers and
 * enum strings only: `decodeErrors` holds raw ffmpeg stderr and is dropped.
 */
function reportExportBenchmark(benchmark) {
  if (!benchmark || typeof benchmark !== 'object') return;
  const context = {};
  for (const [key, value] of Object.entries(benchmark)) {
    if (key === 'decodeErrors' || key === 'timestamp') continue;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
      context[key] = value;
    } else if (Array.isArray(value)) {
      context[key] = value.filter((v) => typeof v === 'string' || typeof v === 'number');
    }
  }

  telemetry.event('export_succeeded', {
    kind: telemetry.KIND.CUSTOM,
    severity: telemetry.SEVERITY.INFO,
    context
  });

  const encoder = typeof benchmark.encoder === 'string' ? benchmark.encoder : 'unknown';
  if (Number.isFinite(benchmark.elapsedMs)) {
    telemetry.metric('export_ms', benchmark.elapsedMs, { unit: 'ms', dims: { encoder } });
  }
  // The realtime factor is an unbounded speedup (routinely 6x to 40x on a
  // hardware encoder) and the ingest API's `ratio` unit is a 0..1 fraction, so
  // it has no usable buckets above 1. Record the clip duration instead: paired
  // with export_ms above, the fleet factor is sum(duration)/sum(elapsed) server
  // side. The exact per-export value still rides on export_succeeded.
  if (Number.isFinite(benchmark.clipDurationSeconds)) {
    telemetry.metric('export_source_ms', benchmark.clipDurationSeconds * 1000, {
      unit: 'ms',
      dims: { encoder }
    });
  }
  if (Number.isFinite(benchmark.outputBytes)) {
    telemetry.metric('export_output_bytes', benchmark.outputBytes, {
      unit: 'bytes',
      dims: { encoder }
    });
  }
}

/**
 * Read the clipboard back after a write. `clipboard.writeBuffer` has no return
 * value and no error path, so a mismatch is the only failure signal available.
 */
function verifyClipboardWrite(filePath) {
  let written = false;
  try {
    if (process.platform === 'win32') {
      const readBack = clipboard.readBuffer('FileNameW');
      written = Boolean(readBack)
        && readBack.length > 0
        && readBack.toString('ucs2').replace(/\0+$/, '') === filePath;
    } else {
      written = clipboard.readText() === filePath;
    }
  } catch (error) {
    written = false;
  }
  if (written) return;

  const report = (outputBytes) => {
    telemetry.event('clipboard_copy_unverified', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { output_bytes: outputBytes }
    });
  };
  fs.stat(filePath).then((stats) => report(stats.size), () => report(undefined));
}

/**
 * Verify FFmpeg is working on startup
 */
function initFFmpeg() {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-version'], (error, stdout, stderr) => {
      if (error) {
        logger.error('Error getting ffmpeg version:', error);
        // The app still boots fully after this rejects, with a broken ffmpeg.
        // Every export and every thumbnail then fails one by one.
        telemetry.event('ffmpeg_init_failed', {
          kind: telemetry.KIND.CRASH,
          severity: telemetry.SEVERITY.FATAL,
          context: execErrorCodes(error),
          error
        });
        reject(error);
      } else {
        logger.info('FFmpeg version:', stdout);
        getNvencStatus({ forceRefresh: true })
          .then((status) => {
            logger.info(`[ffmpeg] NVENC status on startup: ${status.available ? 'available' : 'unavailable'} (${status.reason})`);
          })
          .catch((statusError) => {
            logger.warn(`[ffmpeg] Failed to probe NVENC status on startup: ${statusError?.message || statusError}`);
          });
        resolve(stdout);
      }
    });
  });
}

/**
 * Get FFmpeg version string
 * @returns {Promise<string>} FFmpeg version output
 */
function getFFmpegVersion() {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-version'], (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

function getNullOutputTarget() {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        reject({
          error,
          stdout: stdout || '',
          stderr: stderr || ''
        });
        return;
      }
      resolve({
        stdout: stdout || '',
        stderr: stderr || ''
      });
    });
  });
}

function parseFrameRate(frameRateValue) {
  if (!frameRateValue || typeof frameRateValue !== 'string') return 30;
  const [rawNum, rawDen] = frameRateValue.split('/');
  const numerator = Number(rawNum);
  const denominator = Number(rawDen);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 30;
  }
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

async function getNvencStatus(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const now = Date.now();

  if (
    !forceRefresh &&
    nvencStatusCache &&
    (now - nvencStatusCache.checkedAt) < NVENC_STATUS_TTL_MS
  ) {
    return nvencStatusCache;
  }

  try {
    const encoderResult = await execFileAsync(ffmpegPath, ['-hide_banner', '-encoders']);
    const supportsNvenc = /h264_nvenc/i.test(`${encoderResult.stdout}\n${encoderResult.stderr}`);

    if (!supportsNvenc) {
      nvencStatusCache = {
        available: false,
        mode: 'software',
        reason: 'Bundled FFmpeg does not include h264_nvenc.',
        checkedAt: now
      };
      return nvencStatusCache;
    }

    await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'testsrc=duration=0.2:size=320x180:rate=30',
      '-frames:v', '1',
      '-an',
      '-c:v', 'h264_nvenc',
      '-f', 'null',
      getNullOutputTarget()
    ]);

    nvencStatusCache = {
      available: true,
      mode: 'nvenc',
      reason: 'NVENC probe succeeded.',
      checkedAt: now
    };
    return nvencStatusCache;
  } catch (probeError) {
    const stderr = probeError?.stderr || '';
    const stdout = probeError?.stdout || '';
    const message = probeError?.error?.message || '';
    const reasonRaw = `${stderr}\n${stdout}\n${message}`.trim();
    telemetry.event('nvenc_probe_failed', {
      kind: telemetry.KIND.DEGRADED,
      severity: telemetry.SEVERITY.WARNING,
      context: {
        reason_class: classifyNvencFailure(reasonRaw),
        exit_code: execErrorCodes(probeError).exit_code,
        ms: Date.now() - now
      }
    });
    nvencStatusCache = {
      available: false,
      mode: 'software',
      reason: (reasonRaw || 'NVENC probe failed.').slice(0, 1200),
      checkedAt: now
    };
    return nvencStatusCache;
  }
}

async function getDecoderNames(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const now = Date.now();

  if (
    !forceRefresh &&
    decoderListCache &&
    (now - decoderListCache.checkedAt) < DECODER_LIST_TTL_MS
  ) {
    return new Set(decoderListCache.names);
  }

  const decoderResult = await execFileAsync(ffmpegPath, ['-hide_banner', '-decoders']);
  const rawText = `${decoderResult.stdout}\n${decoderResult.stderr}`;
  const names = new Set();

  rawText.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*[VASD\.]{6}\s+([^\s]+)\s+/);
    if (match && match[1]) {
      names.add(match[1].toLowerCase());
    }
  });

  decoderListCache = {
    names: Array.from(names),
    checkedAt: now
  };

  return names;
}

async function getHwAccelNames(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const now = Date.now();

  if (
    !forceRefresh &&
    hwAccelListCache &&
    (now - hwAccelListCache.checkedAt) < HWACCEL_LIST_TTL_MS
  ) {
    return new Set(hwAccelListCache.names);
  }

  const hwAccelResult = await execFileAsync(ffmpegPath, ['-hide_banner', '-hwaccels']);
  const rawText = `${hwAccelResult.stdout}\n${hwAccelResult.stderr}`;
  const names = new Set();

  rawText.split(/\r?\n/).forEach((line) => {
    const normalized = String(line || '').trim().toLowerCase();
    if (!normalized || normalized.startsWith('hardware acceleration methods')) {
      return;
    }
    if (/^[a-z0-9_]+$/.test(normalized)) {
      names.add(normalized);
    }
  });

  hwAccelListCache = {
    names: Array.from(names),
    checkedAt: now
  };

  return names;
}

function getCudaDecoderForCodec(codecName, decoderNames) {
  const normalizedCodec = String(codecName || '').toLowerCase();
  const candidate = CUDA_DECODER_BY_CODEC[normalizedCodec];
  if (!candidate) return null;
  return decoderNames.has(candidate) ? candidate : null;
}

function getCodecPreferenceKey(codecName) {
  const normalized = String(codecName || '').toLowerCase().trim();
  return normalized || UNKNOWN_CODEC_KEY;
}

function buildDecodeModeOrder({ sourceCodec, requestedCudaDecoder, hwAccelNames }) {
  const modes = [];
  const addMode = (mode) => {
    if (!mode || modes.includes(mode)) return;
    modes.push(mode);
  };

  const hasCuda = hwAccelNames.has('cuda');
  const hasD3d11va = hwAccelNames.has('d3d11va');
  const hasDxva2 = hwAccelNames.has('dxva2');
  const preferenceKey = getCodecPreferenceKey(sourceCodec);
  const preferredMode = preferredDecodeModeByCodec.get(preferenceKey);

  if (preferredMode) {
    addMode(preferredMode);
  }
  if (hasCuda && requestedCudaDecoder) {
    addMode('cuda_cuvid');
  }
  if (hasCuda) {
    addMode('cuda');
  }
  if (hasD3d11va) {
    addMode('d3d11va');
  }
  if (hasDxva2) {
    addMode('dxva2');
  }
  addMode('none');

  return modes;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function chooseSetting(rawValue, allowedValues, fallbackValue) {
  return allowedValues.has(rawValue) ? rawValue : fallbackValue;
}

function calculateTargetVideoBitrateKbps(durationSeconds, targetBytes, audioBitrateKbps, options = {}) {
  const duration = Math.max(0.5, Number(durationSeconds) || 0.5);
  const bytes = Number(targetBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  const reserveKbps = Number.isFinite(options.reserveKbps) ? options.reserveKbps : 48;
  const minKbps = Number.isFinite(options.minKbps) ? options.minKbps : 450;
  const maxKbps = Number.isFinite(options.maxKbps) ? options.maxKbps : 14000;
  const totalKbpsBudget = Math.floor((bytes * 8) / duration / 1000);
  const videoKbps = totalKbpsBudget - Math.max(0, Number(audioBitrateKbps) || 0) - reserveKbps;
  return Math.max(minKbps, Math.min(maxKbps, videoKbps));
}

function resolveAudioBitrateKbps({ quality, sizeGoal }) {
  if (quality === 'discord') {
    return DISCORD_AUDIO_BITRATE_K;
  }
  if (quality === 'lossless') {
    return sizeGoal === 'unlimited' ? 320 : 192;
  }
  if (sizeGoal === 'discord_10mb' || sizeGoal === 'small_25mb') {
    return 128;
  }
  if (sizeGoal === 'large_100mb' || sizeGoal === 'unlimited') {
    return 256;
  }
  return 192;
}

function resolveExportTuning(settings, requestedQuality, durationSeconds) {
  const normalizedQuality = chooseSetting(requestedQuality, EXPORT_QUALITY_VALUES, 'discord');
  const normalizedPreset = chooseSetting(settings?.exportPreset, EXPORT_PRESET_VALUES, 'balanced');
  const normalizedSizeGoal = chooseSetting(settings?.exportSizeGoal, EXPORT_SIZE_GOAL_VALUES, 'discord_10mb');
  const normalizedQualityBias = chooseSetting(settings?.exportQualityBias, EXPORT_QUALITY_BIAS_VALUES, 'balanced');
  const normalizedSpeedBias = chooseSetting(settings?.exportSpeedBias, EXPORT_SPEED_BIAS_VALUES, 'fast');

  let resolvedQuality = normalizedQuality;
  let resolvedSizeGoal = normalizedSizeGoal;
  let resolvedQualityBias = normalizedQualityBias;
  let resolvedSpeedBias = normalizedSpeedBias;

  if (normalizedPreset !== 'custom') {
    const presetValues = EXPORT_PRESET_CONFIG[normalizedPreset];
    if (presetValues) {
      resolvedQuality = presetValues.quality;
      resolvedSizeGoal = presetValues.sizeGoal;
      resolvedQualityBias = presetValues.qualityBias;
      resolvedSpeedBias = presetValues.speedBias;
    }
  }

  const audioBitrateKbps = resolveAudioBitrateKbps({
    quality: resolvedQuality,
    sizeGoal: resolvedSizeGoal
  });
  const sizeGoalBytes = EXPORT_SIZE_GOAL_BYTES[resolvedSizeGoal];
  const qualityBitrateScale = QUALITY_BIAS_BITRATE_SCALE[resolvedQualityBias] || 1;

  const bitrateMaxByQuality = resolvedQuality === 'discord'
    ? 14000
    : (resolvedQuality === 'high' ? 50000 : 120000);
  const bitrateMinByQuality = resolvedQuality === 'discord' ? 450 : 900;

  let sizeCapVideoBitrateKbps = null;
  if (Number.isFinite(sizeGoalBytes) && sizeGoalBytes > 0) {
    sizeCapVideoBitrateKbps = calculateTargetVideoBitrateKbps(
      durationSeconds,
      sizeGoalBytes,
      audioBitrateKbps,
      // Keep this as a real cap; do not force a high floor that can inflate output.
      { minKbps: 32, maxKbps: bitrateMaxByQuality }
    );
  }

  let nominalVideoBitrateKbps = null;
  if (resolvedQuality === 'discord') {
    nominalVideoBitrateKbps = calculateTargetVideoBitrateKbps(
      durationSeconds,
      DISCORD_TARGET_BYTES,
      audioBitrateKbps,
      { minKbps: 450, maxKbps: 14000 }
    );
  } else if (resolvedQuality === 'high') {
    nominalVideoBitrateKbps = clampNumber(
      14000,
      bitrateMinByQuality,
      bitrateMaxByQuality
    );
  }

  if (Number.isFinite(nominalVideoBitrateKbps) && nominalVideoBitrateKbps > 0) {
    nominalVideoBitrateKbps = Math.round(clampNumber(
      nominalVideoBitrateKbps * qualityBitrateScale,
      bitrateMinByQuality,
      bitrateMaxByQuality
    ));
  }

  let targetVideoBitrateKbps = nominalVideoBitrateKbps;
  if (
    Number.isFinite(sizeCapVideoBitrateKbps) &&
    sizeCapVideoBitrateKbps > 0 &&
    Number.isFinite(targetVideoBitrateKbps) &&
    targetVideoBitrateKbps > 0
  ) {
    targetVideoBitrateKbps = Math.min(targetVideoBitrateKbps, sizeCapVideoBitrateKbps);
  }
  if (Number.isFinite(targetVideoBitrateKbps) && targetVideoBitrateKbps > 0) {
    const targetMinKbps = Number.isFinite(sizeCapVideoBitrateKbps) && sizeCapVideoBitrateKbps > 0
      ? 32
      : bitrateMinByQuality;
    targetVideoBitrateKbps = Math.round(clampNumber(
      targetVideoBitrateKbps,
      targetMinKbps,
      bitrateMaxByQuality
    ));
  }

  const speedPresetMap = NVENC_PRESET_BY_SPEED_BIAS[resolvedSpeedBias] || NVENC_PRESET_BY_SPEED_BIAS.fast;
  const nvencPreset = speedPresetMap[resolvedQuality] || 'p3';
  const softwarePreset = SOFTWARE_PRESET_BY_SPEED_BIAS[resolvedSpeedBias] || SOFTWARE_PRESET_BY_SPEED_BIAS.fast;
  const cqDelta = QUALITY_BIAS_CQ_DELTA[resolvedQualityBias] || 0;
  const discordLookahead = DISCORD_LOOKAHEAD_BY_SPEED[resolvedSpeedBias] ?? 0;
  const discordBframes = DISCORD_BFRAMES_BY_SPEED[resolvedSpeedBias] ?? 0;
  const highLookahead = HIGH_LOOKAHEAD_BY_SPEED[resolvedSpeedBias] ?? 20;
  const highBframes = HIGH_BFRAMES_BY_SPEED[resolvedSpeedBias] ?? 2;

  return {
    preset: normalizedPreset,
    requestedQuality: normalizedQuality,
    quality: resolvedQuality,
    sizeGoal: resolvedSizeGoal,
    qualityBias: resolvedQualityBias,
    speedBias: resolvedSpeedBias,
    sizeGoalBytes,
    qualityBitrateScale,
    nominalVideoBitrateKbps,
    sizeCapVideoBitrateKbps,
    audioBitrateKbps,
    targetVideoBitrateKbps,
    nvencPreset,
    softwarePreset,
    cqDelta,
    discordLookahead,
    discordBframes,
    highLookahead,
    highBframes
  };
}

async function getExportAccelerationStatus(options = {}) {
  const nvencStatus = await getNvencStatus(options);
  let cudaDecoders = [];
  let hwAccels = [];

  try {
    const decoderNames = await getDecoderNames(options);
    cudaDecoders = Object.values(CUDA_DECODER_BY_CODEC).filter((decoderName) => decoderNames.has(decoderName));
  } catch (error) {
    logger.warn(`[ffmpeg] Failed to query decoders for acceleration status: ${error.message}`);
  }

  try {
    const hwAccelNames = await getHwAccelNames(options);
    hwAccels = Array.from(hwAccelNames);
  } catch (error) {
    logger.warn(`[ffmpeg] Failed to query hwaccels for acceleration status: ${error.message}`);
  }

  return {
    ...nvencStatus,
    cudaDecoders,
    hwAccels
  };
}

async function buildExportBenchmark(payload) {
  const {
    mode,
    destination,
    outputPath,
    startedAtMs,
    start,
    end,
    speed,
    volume,
    quality = null,
    requestedQuality = null,
    exportPreset = null,
    exportSizeGoal = null,
    exportQualityBias = null,
    exportSpeedBias = null,
    encoder,
    sourceWidth = null,
    sourceHeight = null,
    sourceFps = null,
    sourceCodec = null,
    sourcePixelFormat = null,
    hwDecodeEnabled = false,
    hwDecodeMode = 'none',
    requestedCudaDecoder = null,
    decodeAttempts = [],
    decodeErrors = {},
    targetSizeBytes = null,
    nominalVideoBitrateKbps = null,
    sizeCapVideoBitrateKbps = null,
    targetVideoBitrateKbps = null,
    targetAudioBitrateKbps = null,
    videoFilters = [],
    audioFilters = []
  } = payload;

  const clipDurationSeconds = Math.max(0.01, Number(end) - Number(start));
  const elapsedMs = Math.max(1, Date.now() - startedAtMs);
  const elapsedSeconds = Number((elapsedMs / 1000).toFixed(2));
  const realtimeFactorX = Number((clipDurationSeconds / (elapsedMs / 1000)).toFixed(2));

  let outputBytes = null;
  let outputSizeMB = null;
  try {
    const stats = await fs.stat(outputPath);
    outputBytes = stats.size;
    outputSizeMB = Number((stats.size / (1024 * 1024)).toFixed(2));
  } catch (error) {
    logger.warn(`[ffmpeg] Failed to read export output size for benchmark: ${error.message}`);
  }

  const benchmark = {
    mode,
    destination,
    encoder,
    quality,
    requestedQuality,
    exportPreset,
    exportSizeGoal,
    exportQualityBias,
    exportSpeedBias,
    sourceWidth,
    sourceHeight,
    sourceFps,
    sourceCodec,
    sourcePixelFormat,
    hwDecodeEnabled,
    hwDecodeMode,
    requestedCudaDecoder,
    decodeAttempts,
    decodeErrors,
    targetSizeMB: Number.isFinite(targetSizeBytes) && targetSizeBytes > 0
      ? Number((targetSizeBytes / (1024 * 1024)).toFixed(2))
      : null,
    nominalVideoBitrateKbps: Number.isFinite(nominalVideoBitrateKbps) && nominalVideoBitrateKbps > 0
      ? Math.round(nominalVideoBitrateKbps)
      : null,
    sizeCapVideoBitrateKbps: Number.isFinite(sizeCapVideoBitrateKbps) && sizeCapVideoBitrateKbps > 0
      ? Math.round(sizeCapVideoBitrateKbps)
      : null,
    targetVideoBitrateKbps: Number.isFinite(targetVideoBitrateKbps) && targetVideoBitrateKbps > 0
      ? Math.round(targetVideoBitrateKbps)
      : null,
    targetAudioBitrateKbps: Number.isFinite(targetAudioBitrateKbps) && targetAudioBitrateKbps > 0
      ? Math.round(targetAudioBitrateKbps)
      : null,
    videoFilters,
    audioFilters,
    clipDurationSeconds: Number(clipDurationSeconds.toFixed(2)),
    elapsedMs,
    elapsedSeconds,
    realtimeFactorX,
    speed: Number((Number(speed) || 1).toFixed(2)),
    volume: Number((Number(volume) || 1).toFixed(2)),
    outputBytes,
    outputSizeMB,
    timestamp: new Date().toISOString()
  };

  return benchmark;
}

/**
 * Run ffprobe on a video file
 * @param {string} filePath - Path to the video file
 * @returns {Promise<object>} FFprobe metadata
 */
function ffprobeAsync(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
}

/**
 * Export video with NVENC hardware encoding, falling back to software encoding on failure.
 *
 * @param {object} options
 * @param {string} options.inputPath - Path to source video
 * @param {string} options.outputPath - Path for output video
 * @param {number} options.start - Start time in seconds
 * @param {number} options.end - End time in seconds
 * @param {number} options.volume - Volume multiplier (1 = 100%)
 * @param {number} options.speed - Playback speed multiplier
 * @param {string} options.quality - Quality preset: 'lossless', 'high', or 'discord'
 * @param {object|null} options.volumeData - Optional volume range data
 * @returns {Promise<{usingFallback: boolean, pipeline: object}>}
 */
// Export helpers
/**
 * Build an audio filter_complex graph that mixes a list of source streams with
 * per-track volumes, then layers the trim-time master volume / volume range /
 * speed (atempo) on top. Returns `null` when no mix is requested.
 *
 * Output label is always `[aout]` so the caller can `-map [aout]`.
 */
function buildAudioMixFilterComplex({
  audioMix,
  effectiveVolume,
  hasBaseVolumeChange,
  effectiveSpeed,
  hasSpeedChange,
  hasRangeVolumeChange,
  rangeLevelRaw,
  relativeRangeStart,
  relativeRangeEnd,
  videoFilters = null
}) {
  if (!Array.isArray(audioMix) || audioMix.length === 0) return null;

  const parts = [];

  // If video filters are present we have to inline them into the complex
  // graph too. Mixing `-vf` with `-filter_complex` on the same output stream
  // is rejected by ffmpeg ("Filtergraph 'X' was specified through the -vf/-af
  // option ... which is fed from a complex filtergraph").
  if (Array.isArray(videoFilters) && videoFilters.length > 0) {
    parts.push(`[0:v:0]${videoFilters.join(',')}[vout]`);
  }
  const inputLabels = [];
  audioMix.forEach((track, idx) => {
    const streamIndex = Number(track.streamIndex);
    if (!Number.isFinite(streamIndex)) return;
    const vol = Number.isFinite(track.volume) ? Math.max(0, track.volume) : 1;
    const label = `mt${idx}`;
    inputLabels.push(label);
    // Pre-stage volume per track so amix sees properly weighted inputs.
    parts.push(`[0:${streamIndex}]volume=${vol}[${label}]`);
  });
  if (inputLabels.length === 0) return null;

  // Mix down to a single stream (or pass through for a single track).
  let mixedLabel;
  if (inputLabels.length === 1) {
    mixedLabel = inputLabels[0];
  } else {
    mixedLabel = 'mt_mix';
    parts.push(
      `${inputLabels.map((l) => `[${l}]`).join('')}` +
      `amix=inputs=${inputLabels.length}:normalize=0:duration=longest[${mixedLabel}]`
    );
  }

  // Post-mix transforms (mirror the single-stream filter chain).
  const postFilters = [];
  if (hasBaseVolumeChange) postFilters.push(`volume=${effectiveVolume}`);
  if (hasRangeVolumeChange) {
    postFilters.push(
      `volume=${rangeLevelRaw}:enable='between(t,${relativeRangeStart},${relativeRangeEnd})'`
    );
  }
  if (hasSpeedChange) postFilters.push(`atempo=${effectiveSpeed}`);

  if (postFilters.length > 0) {
    parts.push(`[${mixedLabel}]${postFilters.join(',')}[aout]`);
  } else if (inputLabels.length === 1) {
    // Lone track, no transforms — pass through under the [aout] label.
    parts.push(`[${mixedLabel}]anull[aout]`);
  } else {
    // amix already produced [mt_mix]; rename to [aout].
    const last = parts.pop();
    parts.push(last.replace(`[${mixedLabel}]`, '[aout]'));
  }

  return parts.join(';');
}

async function exportVideoWithFallback(options) {
  const {
    inputPath,
    outputPath,
    start,
    end,
    volume,
    speed,
    quality,
    exportSettings = null,
    volumeData,
    audioMix = null,
    onProgress,
    onFallback,
    onDecodeFallback,
    allowAudioCopy = true,
    emitGlobalProgress = true
  } = options;
  const duration = Math.max(0.01, Number(end) - Number(start));
  const resolvedTuning = resolveExportTuning(exportSettings, quality, duration);
  const effectiveQuality = resolvedTuning.quality;

  const reportProgress = (percent) => {
    const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
    if (typeof onProgress === 'function') {
      try {
        onProgress(normalized);
      } catch (error) {
        logger.warn(`Export progress callback failed: ${error.message}`);
      }
    }
    if (emitGlobalProgress) {
      emitProgress(normalized);
    }
  };

  const notifyFallback = () => {
    if (typeof onFallback === 'function') {
      try {
        onFallback();
      } catch (error) {
        logger.warn(`Export fallback callback failed: ${error.message}`);
      }
    }
    if (emitGlobalProgress) {
      emitFallbackNotice();
    }
  };

  const notifyDecodeFallback = (payload) => {
    if (typeof onDecodeFallback === 'function') {
      try {
        onDecodeFallback(payload);
      } catch (error) {
        logger.warn(`Export decode fallback callback failed: ${error.message}`);
      }
    }
    if (emitGlobalProgress) {
      emitDecodeFallbackNotice(payload);
    }
  };

  return new Promise((resolve, reject) => {
    let usingFallback = false;
    let lastProgressTime = Date.now();
    let totalFrames = 0;
    let processedFrames = 0;
    let decodeFallbackNotified = false;
    const pipelineStartedAtMs = Date.now();

    ffmpeg.ffprobe(inputPath, async (err, metadata) => {
      if (err) {
        logger.error('Error getting video info:', err);
        telemetry.event('export_failed', {
          kind: telemetry.KIND.ERROR,
          severity: telemetry.SEVERITY.ERROR,
          context: {
            stage: 'probe',
            ms: Date.now() - pipelineStartedAtMs,
            duration_s: Math.round(duration),
            exit_code: parseFfmpegExitCode(err),
            errno: typeof err?.code === 'string' ? err.code : undefined
          }
        });
        reject(err);
        return;
      }

      const videoStream = Array.isArray(metadata.streams)
        ? metadata.streams.find((stream) => stream.codec_type === 'video') || metadata.streams[0]
        : null;
      const fps = parseFrameRate(videoStream?.r_frame_rate);
      totalFrames = Math.ceil(duration * fps);
      const sourceWidth = Number(videoStream?.width) || null;
      const sourceHeight = Number(videoStream?.height) || null;
      const sourceFps = Number(fps.toFixed(2));
      const sourceCodec = typeof videoStream?.codec_name === 'string'
        ? videoStream.codec_name.toLowerCase()
        : null;
      const sourcePixelFormat = typeof videoStream?.pix_fmt === 'string'
        ? videoStream.pix_fmt
        : null;
      const codecPreferenceKey = getCodecPreferenceKey(sourceCodec);

      const speedValue = Number(speed);
      const volumeValue = Number(volume);
      const effectiveSpeed = Number.isFinite(speedValue) && speedValue > 0 ? speedValue : 1;
      const effectiveVolume = Number.isFinite(volumeValue) ? volumeValue : 1;

      const rangeStartRaw = Number(volumeData?.start);
      const rangeEndRaw = Number(volumeData?.end);
      const rangeLevelRaw = Number(volumeData?.level);

      const hasSpeedChange = Math.abs(effectiveSpeed - 1) > 0.001;
      const hasBaseVolumeChange = Math.abs(effectiveVolume - 1) > 0.001;

      const hasValidVolumeRange = (
        Number.isFinite(rangeStartRaw) &&
        Number.isFinite(rangeEndRaw) &&
        Number.isFinite(rangeLevelRaw) &&
        rangeEndRaw > rangeStartRaw
      );

      const relativeRangeStart = hasValidVolumeRange ? Math.max(0, rangeStartRaw - start) : 0;
      const relativeRangeEnd = hasValidVolumeRange ? Math.min(duration, rangeEndRaw - start) : 0;
      const hasRangeVolumeChange = (
        hasValidVolumeRange &&
        Math.abs(rangeLevelRaw - 1) > 0.001 &&
        relativeRangeStart < duration &&
        relativeRangeEnd > 0
      );

      const needsScaleDown = (
        effectiveQuality === 'discord' &&
        Number.isFinite(sourceHeight) &&
        sourceHeight > 1080
      );

      const videoFilters = [];
      if (hasSpeedChange) {
        videoFilters.push(`setpts=${1 / effectiveSpeed}*PTS`);
      }
      if (needsScaleDown) {
        videoFilters.push('scale=-2:1080:flags=fast_bilinear');
      }

      const buildAudioFilter = () => {
        const filters = [];
        if (hasBaseVolumeChange) {
          filters.push(`volume=${effectiveVolume}`);
        }
        if (hasRangeVolumeChange) {
          filters.push(`volume=${rangeLevelRaw}:enable='between(t,${relativeRangeStart},${relativeRangeEnd})'`);
        }
        if (hasSpeedChange) {
          filters.push(`atempo=${effectiveSpeed}`);
        }
        return filters;
      };

      const audioFilters = buildAudioFilter();
      const needsVideoFilter = videoFilters.length > 0;
      // Multi-track audio export: when the renderer provided an explicit mix,
      // we replace the single-stream audio filter chain with a filter_complex
      // graph that mixes per-track volumes and re-applies master/range/speed.
      // An *empty* mix means every track was muted/hidden — we silence the
      // output entirely with `-an`.
      const audioMixProvided = Array.isArray(audioMix);
      const audioMixSilent = audioMixProvided && audioMix.length === 0;
      const audioFilterComplex = audioMixProvided && !audioMixSilent
        ? buildAudioMixFilterComplex({
            audioMix,
            effectiveVolume,
            hasBaseVolumeChange,
            effectiveSpeed,
            hasSpeedChange,
            hasRangeVolumeChange,
            rangeLevelRaw,
            relativeRangeStart,
            relativeRangeEnd,
            videoFilters
          })
        : null;
      const usingAudioMix = audioFilterComplex !== null || audioMixSilent;
      const needsAudioFilter = !usingAudioMix && audioFilters.length > 0;
      const canAttemptHwDecode = !needsVideoFilter;

      const targetVideoBitrateKbps = Number.isFinite(resolvedTuning.targetVideoBitrateKbps)
        ? resolvedTuning.targetVideoBitrateKbps
        : null;
      const nominalVideoBitrateKbps = Number.isFinite(resolvedTuning.nominalVideoBitrateKbps)
        ? resolvedTuning.nominalVideoBitrateKbps
        : null;
      const sizeCapVideoBitrateKbps = Number.isFinite(resolvedTuning.sizeCapVideoBitrateKbps)
        ? resolvedTuning.sizeCapVideoBitrateKbps
        : null;
      const targetAudioBitrateKbps = resolvedTuning.audioBitrateKbps;
      logger.info(
        `[ffmpeg] Export pipeline: quality=${effectiveQuality}, requestedQuality=${resolvedTuning.requestedQuality}, ` +
        `preset=${resolvedTuning.preset}, sizeGoal=${resolvedTuning.sizeGoal}, qualityBias=${resolvedTuning.qualityBias}, speedBias=${resolvedTuning.speedBias}, ` +
        `speed=${effectiveSpeed}, videoFilter=${needsVideoFilter}, audioFilter=${needsAudioFilter}, hwDecodeCandidate=${canAttemptHwDecode}, scaleDown=${needsScaleDown}, ` +
        `nominalVideo=${nominalVideoBitrateKbps || 'none'}k, videoCap=${sizeCapVideoBitrateKbps || 'none'}k, ` +
        `targetVideo=${targetVideoBitrateKbps || 'none'}k, targetAudio=${targetAudioBitrateKbps}k`
      );

      const maybeReportProgress = (percent) => {
        if (!Number.isFinite(percent)) return;
        const now = Date.now();
        if (now - lastProgressTime >= 100) {
          reportProgress(Math.min(percent, 99.9));
          lastProgressTime = now;
        }
      };

      const handleProgressEvent = (progressData) => {
        const eventPercent = Number(progressData?.percent);
        if (Number.isFinite(eventPercent)) {
          maybeReportProgress(eventPercent);
          return;
        }
        const eventFrames = Number(progressData?.frames);
        if (Number.isFinite(eventFrames) && totalFrames > 0) {
          maybeReportProgress((eventFrames / totalFrames) * 100);
        }
      };

      let requestedCudaDecoder = null;
      let activeDecodeMode = 'none';
      let hwDecodeEnabled = false;
      const attemptedDecodeModes = [];
      const decodeErrors = {};

      const createBaseCommand = (decodeMode = 'none') => {
        const command = ffmpeg(inputPath)
          .inputOptions(['-threads 0'])
          .seekInput(start)
          .setDuration(duration);

        if (decodeMode === 'cuda_cuvid') {
          const cudaInputOptions = [
            '-hwaccel cuda',
            '-hwaccel_output_format cuda',
            '-extra_hw_frames 8'
          ];
          if (requestedCudaDecoder) {
            cudaInputOptions.push(`-c:v ${requestedCudaDecoder}`);
          }
          command.inputOptions(cudaInputOptions);
        } else if (decodeMode === 'cuda') {
          command.inputOptions([
            '-hwaccel cuda',
            '-hwaccel_output_format cuda',
            '-extra_hw_frames 8'
          ]);
        } else if (decodeMode === 'd3d11va') {
          command.inputOptions(['-hwaccel d3d11va']);
        } else if (decodeMode === 'dxva2') {
          command.inputOptions(['-hwaccel dxva2']);
        }

        if (audioFilterComplex) {
          // Multi-track mix path. Video filters (if any) were folded into the
          // complex graph as [vout]; map that instead of 0:v:0. -filter_complex
          // disables automatic mapping, so both outputs are explicit.
          const videoMap = needsVideoFilter ? '[vout]' : '0:v:0';
          command.outputOptions([
            '-filter_complex', audioFilterComplex,
            '-map', videoMap,
            '-map', '[aout]'
          ]);
        } else {
          if (needsVideoFilter) {
            command.videoFilters(videoFilters);
          }
          if (audioMixSilent) {
            command.outputOptions(['-an']);
          } else if (needsAudioFilter) {
            command.audioFilters(audioFilters);
          }
        }

        return command;
      };

      const getPipelineInfo = () => ({
        sourceWidth,
        sourceHeight,
        sourceFps,
        sourceCodec,
        sourcePixelFormat,
        requestedQuality: resolvedTuning.requestedQuality,
        resolvedQuality: effectiveQuality,
        exportPreset: resolvedTuning.preset,
        exportSizeGoal: resolvedTuning.sizeGoal,
        exportQualityBias: resolvedTuning.qualityBias,
        exportSpeedBias: resolvedTuning.speedBias,
        targetSizeBytes: resolvedTuning.sizeGoalBytes,
        nominalVideoBitrateKbps,
        sizeCapVideoBitrateKbps,
        targetVideoBitrateKbps,
        targetAudioBitrateKbps,
        hwDecodeEnabled,
        hwDecodeMode: activeDecodeMode,
        requestedCudaDecoder,
        decodeAttempts: [...attemptedDecodeModes],
        decodeErrors: { ...decodeErrors },
        videoFilters: [...videoFilters],
        audioFilters: [...audioFilters]
      });

      const runSoftwareEncode = () => {
        const softwareStartedAtMs = Date.now();
        const softwarePreset = resolvedTuning.softwarePreset;
        const baseSoftwareCrf = effectiveQuality === 'discord'
          ? 28
          : (effectiveQuality === 'high' ? 20 : 0);
        const softwareCrf = effectiveQuality === 'lossless'
          ? 0
          : clampNumber(baseSoftwareCrf + resolvedTuning.cqDelta, 14, 36);

        const softwareOptions = [
          '-c:v libx264',
          `-preset ${softwarePreset}`,
          effectiveQuality === 'lossless' ? '-crf 0' : `-crf ${softwareCrf}`,
          '-pix_fmt yuv420p',
          '-progress pipe:1',
          '-stats_period 0.1'
        ];

        const shouldCopyAudio = !usingAudioMix && !needsAudioFilter && allowAudioCopy && effectiveQuality !== 'discord';
        if (audioMixSilent) {
          // No audio output at all — codec selection irrelevant.
        } else if (shouldCopyAudio) {
          softwareOptions.push('-c:a copy');
        } else {
          softwareOptions.push(`-b:a ${targetAudioBitrateKbps}k`);
          softwareOptions.push('-c:a aac');
        }

        if (effectiveQuality !== 'lossless' && Number.isFinite(targetVideoBitrateKbps)) {
          softwareOptions.push(`-maxrate ${targetVideoBitrateKbps}k`);
          softwareOptions.push(`-bufsize ${Math.max(targetVideoBitrateKbps * 2, 1200)}k`);
        }

        createBaseCommand('none')
          .outputOptions(softwareOptions)
          .on('progress', handleProgressEvent)
          .on('stderr', (stderrLine) => {
            const frameMatch = stderrLine.match(/frame=\s*(\d+)/);
            if (frameMatch) {
              processedFrames = parseInt(frameMatch[1]);
              maybeReportProgress((processedFrames / totalFrames) * 100);
            }
          })
          .on('end', () => {
            reportProgress(100);
            resolve({
              usingFallback,
              pipeline: getPipelineInfo()
            });
          })
          .on('error', (ffmpegError, stdout, stderr) => {
            logger.error('FFmpeg error:', ffmpegError.message);
            logger.error('FFmpeg stdout:', stdout);
            logger.error('FFmpeg stderr:', stderr);
            // Terminal: software encode is the last resort, there is nothing
            // left to fall back to.
            telemetry.event('export_failed', {
              kind: telemetry.KIND.ERROR,
              severity: telemetry.SEVERITY.ERROR,
              context: {
                stage: 'encode',
                encoder: 'libx264',
                exit_code: parseFfmpegExitCode(ffmpegError),
                ms: Date.now() - softwareStartedAtMs,
                duration_s: Math.round(duration),
                source_codec: sourceCodec,
                width: sourceWidth,
                height: sourceHeight,
                fps: sourceFps
              }
            });
            reject(ffmpegError);
          })
          .save(outputPath);
      };

      const nvencStatus = await getNvencStatus();
      if (!nvencStatus.available) {
        usingFallback = true;
        notifyFallback();
        logger.warn(`[ffmpeg] NVENC unavailable. Using software encode. Reason: ${nvencStatus.reason}`);
        // The user is told nothing beyond a notice; the export just takes
        // several times longer. reason is classified, never the raw stderr.
        telemetry.event('nvenc_runtime_fallback', {
          kind: telemetry.KIND.DEGRADED,
          severity: telemetry.SEVERITY.WARNING,
          context: {
            reason: classifyNvencFailure(nvencStatus.reason),
            elapsed_ms: Date.now() - pipelineStartedAtMs
          }
        });
        reportProgress(0);
        runSoftwareEncode();
        return;
      }

      let decodeModes = ['none'];
      if (canAttemptHwDecode) {
        let decoderNames = new Set();
        let hwAccelNames = new Set();

        try {
          decoderNames = await getDecoderNames();
        } catch (decoderError) {
          logger.warn(`[ffmpeg] Failed to query decoder support: ${decoderError.message}`);
        }

        try {
          hwAccelNames = await getHwAccelNames();
        } catch (hwAccelError) {
          logger.warn(`[ffmpeg] Failed to query hwaccel support: ${hwAccelError.message}`);
        }

        requestedCudaDecoder = getCudaDecoderForCodec(sourceCodec, decoderNames);
        decodeModes = buildDecodeModeOrder({
          sourceCodec,
          requestedCudaDecoder,
          hwAccelNames
        });

        logger.info(
          `[ffmpeg] Decode mode order for codec=${sourceCodec || 'unknown'}: ${decodeModes.join(' -> ')}` +
          `${requestedCudaDecoder ? ` (cudaDecoder=${requestedCudaDecoder})` : ''}`
        );

        if (decodeModes.length === 1 && decodeModes[0] === 'none') {
          decodeFallbackNotified = true;
          notifyDecodeFallback({
            sourceCodec,
            requestedCudaDecoder,
            decodeAttempts: ['none'],
            decodeErrors: {
              none: 'No compatible hardware decode backend detected by ffmpeg.'
            }
          });
        }
      }

      // Each cascade step is a full ffmpeg spawn that produces only a
      // logger.warn line today, while the user just sees a slow export.
      let cascadeReported = false;
      const reportDecodeCascade = (finalMode) => {
        if (cascadeReported || attemptedDecodeModes.length < 2) return;
        cascadeReported = true;
        telemetry.event('hwdecode_cascade', {
          kind: telemetry.KIND.DEGRADED,
          severity: telemetry.SEVERITY.WARNING,
          context: {
            modes_tried: [...attemptedDecodeModes],
            final_mode: finalMode,
            attempts: attemptedDecodeModes.length,
            source_codec: sourceCodec,
            pix_fmt: sourcePixelFormat
          }
        });
      };

      const runNvencAttempt = (decodeModeIndex = 0) => {
        const decodeMode = decodeModes[decodeModeIndex] || 'none';
        const isCudaDecodeMode = decodeMode === 'cuda' || decodeMode === 'cuda_cuvid';
        activeDecodeMode = decodeMode;
        hwDecodeEnabled = decodeMode !== 'none';
        attemptedDecodeModes.push(decodeMode);

        if (decodeMode === 'none' && decodeModeIndex > 0 && !decodeFallbackNotified) {
          decodeFallbackNotified = true;
          notifyDecodeFallback({
            sourceCodec,
            requestedCudaDecoder,
            decodeAttempts: [...attemptedDecodeModes],
            decodeErrors: { ...decodeErrors }
          });
        }

        processedFrames = 0;
        lastProgressTime = Date.now();

        const command = createBaseCommand(decodeMode);

        const nvencQualityOptions = [];
        switch (effectiveQuality) {
          case 'lossless':
            nvencQualityOptions.push(
              '-c:v h264_nvenc',
              `-preset ${resolvedTuning.nvencPreset}`,
              '-tune lossless',
              '-rc:v constqp',
              '-qp 0',
              '-profile:v high',
              '-c:a aac',
              `-b:a ${targetAudioBitrateKbps}k`
            );
            break;
          case 'high':
            {
              const highTargetVideo = Number.isFinite(targetVideoBitrateKbps)
                ? targetVideoBitrateKbps
                : Math.round(14000 * resolvedTuning.qualityBitrateScale);
              const highMaxRate = Number.isFinite(sizeCapVideoBitrateKbps)
                ? Math.round(highTargetVideo)
                : Math.round(highTargetVideo * 1.4);
              const highBufSize = Math.max(highMaxRate * 2, 6000);
              const highCq = clampNumber(20 + resolvedTuning.cqDelta, 14, 34);
              const highBframes = resolvedTuning.highBframes;
              const highLookahead = resolvedTuning.highLookahead;

            nvencQualityOptions.push(
              '-c:v h264_nvenc',
              `-preset ${resolvedTuning.nvencPreset}`,
              '-rc:v vbr',
              `-cq:v ${highCq}`,
              `-b:v ${highTargetVideo}k`,
              `-maxrate:v ${highMaxRate}k`,
              `-bufsize:v ${highBufSize}k`,
              '-profile:v high',
              `-rc-lookahead ${highLookahead}`,
              `-bf ${highBframes}`,
              '-c:a aac',
              `-b:a ${targetAudioBitrateKbps}k`
            );
            }
            break;
          default: // discord
            nvencQualityOptions.push(
              '-c:v h264_nvenc',
              `-preset ${resolvedTuning.nvencPreset}`,
              '-rc:v cbr',
              '-tune ll',
              `-b:v ${targetVideoBitrateKbps}k`,
              `-maxrate:v ${targetVideoBitrateKbps}k`,
              `-bufsize:v ${Math.max(targetVideoBitrateKbps * 2, 1200)}k`,
              '-profile:v high',
              `-rc-lookahead ${resolvedTuning.discordLookahead}`,
              `-bf ${resolvedTuning.discordBframes}`,
              '-c:a aac',
              `-b:a ${targetAudioBitrateKbps}k`
            );
        }

        if (!isCudaDecodeMode) {
          nvencQualityOptions.push('-pix_fmt yuv420p');
        }
        // When the export is silent (all tracks muted/hidden), strip any audio
        // codec/bitrate options that would otherwise fight with -an.
        const filteredNvencOptions = audioMixSilent
          ? nvencQualityOptions.filter((opt) => !/^-c:a |^-b:a /.test(opt))
          : nvencQualityOptions;
        command.outputOptions(filteredNvencOptions);

        if (!usingAudioMix && !needsAudioFilter && allowAudioCopy && effectiveQuality !== 'discord') {
          command.outputOptions(['-c:a copy']);
        }

        command.outputOptions([
          '-progress pipe:1',
          '-stats_period 0.1'
        ])
          .on('start', (commandLine) => {
            logger.info(`Spawned FFmpeg (${decodeMode} decode) with command: ${commandLine}`);
          })
          .on('progress', handleProgressEvent)
          .on('stderr', (stderrLine) => {
            const frameMatch = stderrLine.match(/frame=\s*(\d+)/);
            if (frameMatch) {
              processedFrames = parseInt(frameMatch[1]);
              maybeReportProgress((processedFrames / totalFrames) * 100);
            }
          })
          .on('error', (err, stdout, stderr) => {
            logger.warn(`[ffmpeg] NVENC export attempt failed (decode=${decodeMode}): ${err.message}`);
            const stderrText = String(stderr || '').trim();
            const firstStderrLine = stderrText.split(/\r?\n/).find((line) => line.trim().length > 0) || '';
            const conciseError = [err?.message, firstStderrLine]
              .filter(Boolean)
              .join(' | ')
              .slice(0, 400);
            decodeErrors[decodeMode] = conciseError || 'unknown decode failure';
            if (preferredDecodeModeByCodec.get(codecPreferenceKey) === decodeMode) {
              preferredDecodeModeByCodec.delete(codecPreferenceKey);
            }

            if (decodeModeIndex + 1 < decodeModes.length) {
              const nextDecodeMode = decodeModes[decodeModeIndex + 1];
              logger.warn(`[ffmpeg] Retrying NVENC export with decode mode: ${nextDecodeMode}`);
              runNvencAttempt(decodeModeIndex + 1);
              return;
            }

            logger.warn('Hardware encoding failed, falling back to software encoding');
            logger.error('Error:', err.message);
            logger.error('stdout:', stdout);
            logger.error('stderr:', stderr);

            nvencStatusCache = {
              available: false,
              mode: 'software',
              reason: err.message || 'Hardware encoding failed during export.',
              checkedAt: Date.now()
            };

            usingFallback = true;
            notifyFallback();
            reportDecodeCascade('software');
            runSoftwareEncode();
          })
          .on('end', () => {
            if (decodeMode !== 'none') {
              preferredDecodeModeByCodec.set(codecPreferenceKey, decodeMode);
            }
            reportDecodeCascade(decodeMode);
            reportProgress(100);
            resolve({
              usingFallback,
              pipeline: getPipelineInfo()
            });
          })
          .save(outputPath);
      };

      reportProgress(0);
      runNvencAttempt(0);
    });
  });
}

/**
 * Export video to file or clipboard
 */
async function exportVideo(clipName, start, end, volume, speed, savePath, getSettings, progressCallbacks = null, extraOptions = {}) {
  const audioMix = extraOptions && Array.isArray(extraOptions.audioMix) ? extraOptions.audioMix : null;
  const settings = await getSettings();
  const inputPath = path.join(settings.clipLocation, clipName);
  const outputPath = savePath || path.join(os.tmpdir(), `exported_${Date.now()}_${path.basename(clipName)}`);

  // Load volume range data if it exists
  const metadataFolder = path.join(settings.clipLocation, '.clip_metadata');
  const volumeRangeFilePath = path.join(metadataFolder, `${clipName.replace(/\//g, '--')}.volumerange`);

  let volumeData = null;
  let volumeDataRaw = null;
  try {
    volumeDataRaw = await fs.readFile(volumeRangeFilePath, 'utf8');
    volumeData = JSON.parse(volumeDataRaw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading volume range data:', error);
    }
    // The file was there but unparseable, so the range is dropped from the
    // export and the output gets the wrong audio with no user-visible sign.
    if (volumeDataRaw !== null) {
      telemetry.event('volume_range_dropped', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.WARNING,
        context: { file_bytes: Buffer.byteLength(volumeDataRaw, 'utf8') }
      });
    }
  }

  try {
    const onProgress = typeof progressCallbacks?.onProgress === 'function'
      ? progressCallbacks.onProgress
      : null;
    const onFallback = typeof progressCallbacks?.onFallback === 'function'
      ? progressCallbacks.onFallback
      : null;
    const onDecodeFallback = typeof progressCallbacks?.onDecodeFallback === 'function'
      ? progressCallbacks.onDecodeFallback
      : null;
    const quality = settings.exportQuality || 'discord';

    const exportStartedAt = Date.now();
    const exportResult = await exportVideoWithFallback({
      inputPath,
      outputPath,
      start,
      end,
      volume,
      speed,
      quality,
      exportSettings: settings,
      volumeData,
      audioMix,
      onProgress,
      onFallback,
      onDecodeFallback,
      // Audio copy is incompatible with a custom mix — we have to re-encode
      // when filter_complex builds [aout].
      allowAudioCopy: !savePath && quality !== 'discord' && !audioMix,
      emitGlobalProgress: !onProgress
    });
    const usingFallback = Boolean(exportResult?.usingFallback);
    const pipeline = exportResult?.pipeline || {};
    const elapsedSeconds = ((Date.now() - exportStartedAt) / 1000).toFixed(2);
    logger.info(`[ffmpeg] Video export finished in ${elapsedSeconds}s using ${usingFallback ? 'libx264' : 'h264_nvenc'}`);

    // Copy to clipboard if no save path provided
    if (!savePath) {
      copyFileToClipboard(outputPath);
    }

    // Log export activity
    logActivity('export', {
      clipName,
      format: 'video',
      destination: savePath ? 'file' : 'clipboard',
      start,
      end,
      volume,
      speed
    });

    const benchmark = await buildExportBenchmark({
      mode: 'video',
      destination: savePath ? 'file' : 'clipboard',
      outputPath,
      startedAtMs: exportStartedAt,
      start,
      end,
      speed,
      volume,
      quality: pipeline.resolvedQuality || quality,
      requestedQuality: pipeline.requestedQuality || quality,
      exportPreset: pipeline.exportPreset,
      exportSizeGoal: pipeline.exportSizeGoal,
      exportQualityBias: pipeline.exportQualityBias,
      exportSpeedBias: pipeline.exportSpeedBias,
      encoder: usingFallback ? 'libx264' : 'h264_nvenc',
      sourceWidth: pipeline.sourceWidth,
      sourceHeight: pipeline.sourceHeight,
      sourceFps: pipeline.sourceFps,
      hwDecodeEnabled: pipeline.hwDecodeEnabled,
      hwDecodeMode: pipeline.hwDecodeMode,
      sourceCodec: pipeline.sourceCodec,
      sourcePixelFormat: pipeline.sourcePixelFormat,
      requestedCudaDecoder: pipeline.requestedCudaDecoder,
      decodeAttempts: pipeline.decodeAttempts,
      decodeErrors: pipeline.decodeErrors,
      targetSizeBytes: pipeline.targetSizeBytes,
      nominalVideoBitrateKbps: pipeline.nominalVideoBitrateKbps,
      sizeCapVideoBitrateKbps: pipeline.sizeCapVideoBitrateKbps,
      targetVideoBitrateKbps: pipeline.targetVideoBitrateKbps,
      targetAudioBitrateKbps: pipeline.targetAudioBitrateKbps,
      videoFilters: pipeline.videoFilters,
      audioFilters: pipeline.audioFilters
    });
    logger.info('[ffmpeg] Export benchmark:', benchmark);
    reportExportBenchmark(benchmark);

    return {
      success: true,
      path: outputPath,
      encoder: usingFallback ? 'libx264' : 'h264_nvenc',
      benchmark
    };
  } catch (error) {
    logger.error('Error exporting video:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Export trimmed video to clipboard
 */
async function exportTrimmedVideo(clipName, start, end, volume, speed, getSettings, progressCallbacks = null, extraOptions = {}) {
  const audioMix = extraOptions && Array.isArray(extraOptions.audioMix) ? extraOptions.audioMix : null;
  const settings = await getSettings();
  const inputPath = path.join(settings.clipLocation, clipName);
  const outputPath = path.join(os.tmpdir(), `trimmed_${Date.now()}_${path.basename(clipName)}`);

  // Load volume range data if it exists
  const metadataFolder = path.join(settings.clipLocation, '.clip_metadata');
  const volumeRangeFilePath = path.join(metadataFolder, `${clipName.replace(/\//g, '--')}.volumerange`);

  let volumeData = null;
  let volumeDataRaw = null;
  try {
    volumeDataRaw = await fs.readFile(volumeRangeFilePath, 'utf8');
    volumeData = JSON.parse(volumeDataRaw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading volume range data:', error);
    }
    // The file was there but unparseable, so the range is dropped from the
    // export and the output gets the wrong audio with no user-visible sign.
    if (volumeDataRaw !== null) {
      telemetry.event('volume_range_dropped', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.WARNING,
        context: { file_bytes: Buffer.byteLength(volumeDataRaw, 'utf8') }
      });
    }
  }

  try {
    const onProgress = typeof progressCallbacks?.onProgress === 'function'
      ? progressCallbacks.onProgress
      : null;
    const onFallback = typeof progressCallbacks?.onFallback === 'function'
      ? progressCallbacks.onFallback
      : null;
    const onDecodeFallback = typeof progressCallbacks?.onDecodeFallback === 'function'
      ? progressCallbacks.onDecodeFallback
      : null;
    const quality = settings.exportQuality || 'discord';

    const exportStartedAt = Date.now();
    const exportResult = await exportVideoWithFallback({
      inputPath,
      outputPath,
      start,
      end,
      volume,
      speed,
      quality,
      exportSettings: settings,
      volumeData,
      audioMix,
      onProgress,
      onFallback,
      onDecodeFallback,
      allowAudioCopy: quality !== 'discord' && !audioMix,
      emitGlobalProgress: !onProgress
    });
    const usingFallback = Boolean(exportResult?.usingFallback);
    const pipeline = exportResult?.pipeline || {};
    const elapsedSeconds = ((Date.now() - exportStartedAt) / 1000).toFixed(2);
    logger.info(`[ffmpeg] Trimmed export finished in ${elapsedSeconds}s using ${usingFallback ? 'libx264' : 'h264_nvenc'}`);

    // Copy to clipboard
    copyFileToClipboard(outputPath);

    // Log export activity
    logActivity('export', {
      clipName,
      format: 'video',
      destination: 'trimmed_clipboard',
      start,
      end,
      volume,
      speed
    });

    const benchmark = await buildExportBenchmark({
      mode: 'video',
      destination: 'trimmed_clipboard',
      outputPath,
      startedAtMs: exportStartedAt,
      start,
      end,
      speed,
      volume,
      quality: pipeline.resolvedQuality || quality,
      requestedQuality: pipeline.requestedQuality || quality,
      exportPreset: pipeline.exportPreset,
      exportSizeGoal: pipeline.exportSizeGoal,
      exportQualityBias: pipeline.exportQualityBias,
      exportSpeedBias: pipeline.exportSpeedBias,
      encoder: usingFallback ? 'libx264' : 'h264_nvenc',
      sourceWidth: pipeline.sourceWidth,
      sourceHeight: pipeline.sourceHeight,
      sourceFps: pipeline.sourceFps,
      hwDecodeEnabled: pipeline.hwDecodeEnabled,
      hwDecodeMode: pipeline.hwDecodeMode,
      sourceCodec: pipeline.sourceCodec,
      sourcePixelFormat: pipeline.sourcePixelFormat,
      requestedCudaDecoder: pipeline.requestedCudaDecoder,
      decodeAttempts: pipeline.decodeAttempts,
      decodeErrors: pipeline.decodeErrors,
      targetSizeBytes: pipeline.targetSizeBytes,
      nominalVideoBitrateKbps: pipeline.nominalVideoBitrateKbps,
      sizeCapVideoBitrateKbps: pipeline.sizeCapVideoBitrateKbps,
      targetVideoBitrateKbps: pipeline.targetVideoBitrateKbps,
      targetAudioBitrateKbps: pipeline.targetAudioBitrateKbps,
      videoFilters: pipeline.videoFilters,
      audioFilters: pipeline.audioFilters
    });
    logger.info('[ffmpeg] Export benchmark:', benchmark);
    reportExportBenchmark(benchmark);

    return {
      success: true,
      path: outputPath,
      encoder: usingFallback ? 'libx264' : 'h264_nvenc',
      benchmark
    };
  } catch (error) {
    logger.error('Error exporting trimmed video:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Export trimmed video for sharing uploads (no clipboard side effects).
 */
async function exportTrimmedVideoForShare(clipName, start, end, volume, speed, getSettings, onProgress = null, extraOptions = {}) {
  const audioMix = extraOptions && Array.isArray(extraOptions.audioMix) ? extraOptions.audioMix : null;
  const settings = await getSettings();
  const inputPath = path.join(settings.clipLocation, clipName);
  const outputPath = path.join(os.tmpdir(), `shared_${Date.now()}_${path.parse(clipName).name}.mp4`);

  const metadataFolder = path.join(settings.clipLocation, '.clip_metadata');
  const volumeRangeFilePath = path.join(metadataFolder, `${clipName.replace(/\//g, '--')}.volumerange`);

  let volumeData = null;
  let volumeDataRaw = null;
  try {
    volumeDataRaw = await fs.readFile(volumeRangeFilePath, 'utf8');
    volumeData = JSON.parse(volumeDataRaw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading volume range data:', error);
    }
    // The file was there but unparseable, so the range is dropped from the
    // export and the output gets the wrong audio with no user-visible sign.
    if (volumeDataRaw !== null) {
      telemetry.event('volume_range_dropped', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.WARNING,
        context: { file_bytes: Buffer.byteLength(volumeDataRaw, 'utf8') }
      });
    }
  }

  try {
    const quality = settings.exportQuality || 'discord';
    const exportStartedAt = Date.now();
    const exportResult = await exportVideoWithFallback({
      inputPath,
      outputPath,
      start,
      end,
      volume,
      speed,
      quality,
      exportSettings: settings,
      volumeData,
      audioMix,
      onProgress,
      // Audio copy is incompatible with a custom mix — re-encode when
      // filter_complex builds [aout].
      allowAudioCopy: quality !== 'discord' && !audioMix,
      emitGlobalProgress: false
    });
    const usingFallback = Boolean(exportResult?.usingFallback);
    const pipeline = exportResult?.pipeline || {};
    const elapsedSeconds = ((Date.now() - exportStartedAt) / 1000).toFixed(2);
    logger.info(`[ffmpeg] Share export finished in ${elapsedSeconds}s using ${usingFallback ? 'libx264' : 'h264_nvenc'}`);

    logActivity('export', {
      clipName,
      format: 'video',
      destination: 'share_upload',
      start,
      end,
      volume,
      speed
    });

    const benchmark = await buildExportBenchmark({
      mode: 'video',
      destination: 'share_upload',
      outputPath,
      startedAtMs: exportStartedAt,
      start,
      end,
      speed,
      volume,
      quality: pipeline.resolvedQuality || quality,
      requestedQuality: pipeline.requestedQuality || quality,
      exportPreset: pipeline.exportPreset,
      exportSizeGoal: pipeline.exportSizeGoal,
      exportQualityBias: pipeline.exportQualityBias,
      exportSpeedBias: pipeline.exportSpeedBias,
      encoder: usingFallback ? 'libx264' : 'h264_nvenc',
      sourceWidth: pipeline.sourceWidth,
      sourceHeight: pipeline.sourceHeight,
      sourceFps: pipeline.sourceFps,
      hwDecodeEnabled: pipeline.hwDecodeEnabled,
      hwDecodeMode: pipeline.hwDecodeMode,
      sourceCodec: pipeline.sourceCodec,
      sourcePixelFormat: pipeline.sourcePixelFormat,
      requestedCudaDecoder: pipeline.requestedCudaDecoder,
      decodeAttempts: pipeline.decodeAttempts,
      decodeErrors: pipeline.decodeErrors,
      targetSizeBytes: pipeline.targetSizeBytes,
      nominalVideoBitrateKbps: pipeline.nominalVideoBitrateKbps,
      sizeCapVideoBitrateKbps: pipeline.sizeCapVideoBitrateKbps,
      targetVideoBitrateKbps: pipeline.targetVideoBitrateKbps,
      targetAudioBitrateKbps: pipeline.targetAudioBitrateKbps,
      videoFilters: pipeline.videoFilters,
      audioFilters: pipeline.audioFilters
    });
    logger.info('[ffmpeg] Export benchmark:', benchmark);
    reportExportBenchmark(benchmark);

    return {
      success: true,
      path: outputPath,
      encoder: usingFallback ? 'libx264' : 'h264_nvenc',
      benchmark
    };
  } catch (error) {
    logger.error('Error exporting trimmed video for sharing:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Export audio as MP3
 */
async function exportAudio(clipName, start, end, volume, speed, savePath, getSettings, extraOptions = {}) {
  const settings = await getSettings();
  const inputPath = path.join(settings.clipLocation, clipName);
  const outputPath = savePath || path.join(os.tmpdir(), `audio_${Date.now()}_${path.parse(clipName).name}.mp3`);
  const duration = Math.max(0.01, Number(end) - Number(start));
  const speedValue = Number(speed);
  const volumeValue = Number(volume);
  const effectiveSpeed = Number.isFinite(speedValue) && speedValue > 0 ? speedValue : 1;
  const effectiveVolume = Number.isFinite(volumeValue) ? volumeValue : 1;
  const hasSpeedChange = Math.abs(effectiveSpeed - 1) > 0.001;
  const hasVolumeChange = Math.abs(effectiveVolume - 1) > 0.001;

  const audioMix = extraOptions && Array.isArray(extraOptions.audioMix) ? extraOptions.audioMix : null;
  const audioMixSilent = Array.isArray(audioMix) && audioMix.length === 0;
  const audioFilterComplex = Array.isArray(audioMix) && audioMix.length > 0
    ? buildAudioMixFilterComplex({
        audioMix,
        effectiveVolume,
        hasBaseVolumeChange: hasVolumeChange,
        effectiveSpeed,
        hasSpeedChange,
        hasRangeVolumeChange: false,
        rangeLevelRaw: 0,
        relativeRangeStart: 0,
        relativeRangeEnd: 0
      })
    : null;

  const exportStartedAt = Date.now();
  try {
    await new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath)
        .seekInput(start)
        .setDuration(duration)
        .output(outputPath);

      if (audioMixSilent) {
        // Refuse to write an empty/silent mp3 — caller probably hid/muted
        // every track by mistake. Surface as an error.
        reject(new Error('All audio tracks are hidden or muted — nothing to export.'));
        return;
      }

      command.audioCodec('libmp3lame');

      if (audioFilterComplex) {
        command.outputOptions([
          '-filter_complex', audioFilterComplex,
          '-map', '[aout]'
        ]);
      } else {
        const audioFilters = [];
        if (hasVolumeChange) {
          audioFilters.push(`volume=${effectiveVolume}`);
        }
        if (hasSpeedChange) {
          audioFilters.push(`atempo=${effectiveSpeed}`);
        }
        if (audioFilters.length > 0) {
          command.audioFilters(audioFilters);
        }
      }

      command
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Copy to clipboard if no save path provided
    if (!savePath) {
      copyFileToClipboard(outputPath);
    }

    // Log export activity
    logActivity('export', {
      clipName,
      format: 'audio',
      destination: savePath ? 'file' : 'clipboard',
      start,
      end,
      volume,
      speed
    });

    const benchmark = await buildExportBenchmark({
      mode: 'audio',
      destination: savePath ? 'file' : 'clipboard',
      outputPath,
      startedAtMs: exportStartedAt,
      start,
      end,
      speed,
      volume,
      quality: 'audio_mp3',
      encoder: 'libmp3lame'
    });
    logger.info('[ffmpeg] Export benchmark:', benchmark);
    reportExportBenchmark(benchmark);

    return {
      success: true,
      path: outputPath,
      encoder: 'libmp3lame',
      benchmark
    };
  } catch (error) {
    logger.error('Error exporting audio:', error);
    telemetry.event('export_failed', {
      kind: telemetry.KIND.ERROR,
      severity: telemetry.SEVERITY.ERROR,
      context: {
        stage: 'audio',
        encoder: 'libmp3lame',
        exit_code: parseFfmpegExitCode(error),
        ms: Date.now() - exportStartedAt,
        duration_s: Math.round(duration)
      }
    });
    return { success: false, error: error.message };
  }
}

/**
 * Copy file path to clipboard (platform-specific)
 */
// Clipboard helpers
function copyFileToClipboard(filePath) {
  if (process.platform === 'win32') {
    clipboard.writeBuffer('FileNameW', Buffer.from(filePath + '\0', 'ucs2'));
  } else {
    clipboard.writeText(filePath);
  }
  verifyClipboardWrite(filePath);
}

/**
 * Emit progress to all renderer windows
 */
// Progress events
function emitProgress(percent) {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('export-progress', percent);
  });
}

/**
 * Emit fallback notice to all renderer windows
 */
function emitFallbackNotice() {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('show-fallback-notice');
  });
}

/**
 * Emit decode fallback notice to all renderer windows
 */
function emitDecodeFallbackNotice(payload = {}) {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('show-decode-fallback-notice', payload);
  });
}

/**
 * Generate a screenshot from a video at a specific timestamp
 * @param {string} videoPath - Path to the video file
 * @param {number} timestamp - Time in seconds
 * @param {string} outputPath - Full path for the output screenshot
 * @returns {Promise<void>}
 */
// Screenshots
function generateScreenshot(videoPath, timestamp, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: [timestamp],
        filename: path.basename(outputPath),
        folder: path.dirname(outputPath),
        size: '640x360'
      })
      .on('end', resolve)
      .on('error', reject);
  });
}

/**
 * Setup IPC event listeners for progress
 * Called once during app initialization
 */
// IPC wiring
function setupProgressListeners() {
  ipcMain.on('ffmpeg-fallback', () => {
    emitFallbackNotice();
  });

  ipcMain.on('ffmpeg-progress', (percent) => {
    emitProgress(percent);
  });
}

/**
 * Get clip info (duration) with caching
 * @param {string} clipName - Name of the clip file
 * @param {Function} getSettings - Function that returns settings
 * @param {Object} thumbnailsModule - Thumbnails module for cache access
 * @returns {Promise<Object>} Clip info object with format.duration
 */
// Metadata helpers
function buildAudioTracksFromStreams(streams) {
  if (!Array.isArray(streams)) return [];
  const audio = streams.filter((s) => s && s.codec_type === 'audio');
  return audio.map((s, ordinal) => {
    const tags = s.tags || {};
    const rawTitle = typeof tags.title === 'string' ? tags.title.trim() : '';
    const rawHandler = typeof tags.handler_name === 'string' ? tags.handler_name.trim() : '';
    const handlerIsGeneric = !rawHandler || /^sound\s*handler$/i.test(rawHandler);
    const resolvedName = rawTitle || (handlerIsGeneric ? '' : rawHandler) || `Track ${ordinal + 1}`;
    // A stream's first packet PTS (start_time) is non-zero when the source
    // has an mp4 edit-list (elst) that maps a leading slice of presentation
    // time to nothing — i.e. the audio track starts late relative to the
    // video. Stream-copying such a track preserves the elst and breaks
    // seeking (Chrome's <audio> clamps currentTime up to the playable start),
    // so we must re-encode to apply the elst and pad silence. Tracks with
    // start_time == 0 have no such issue and can be stream-copied at near-
    // zero cost.
    const startTime = Number(s.start_time);
    const needsReencode = Number.isFinite(startTime) && Math.abs(startTime) > 0.0005;
    return {
      streamIndex: Number.isFinite(s.index) ? s.index : ordinal,
      ordinal,
      codec: s.codec_name || null,
      channels: Number.isFinite(s.channels) ? s.channels : null,
      sampleRate: Number.isFinite(Number(s.sample_rate)) ? Number(s.sample_rate) : null,
      language: tags.language || null,
      name: resolvedName,
      isDefault: !!(s.disposition && s.disposition.default),
      startTime: Number.isFinite(startTime) ? startTime : 0,
      needsReencode
    };
  });
}

// Bump when the audioTracks parsing logic changes so cached entries are recomputed.
// v3 added per-track startTime + needsReencode (elst detection).
const AUDIO_TRACKS_CACHE_VERSION = 3;

// Short-lived memo: opening a clip fires get-clip-info more than once
// (player + audio-track extraction), so identical calls within a couple of
// seconds share one promise instead of re-reading/probing.
const clipInfoMemo = new Map();
const CLIP_INFO_MEMO_TTL_MS = 2000;

function getClipInfo(clipName, getSettings, thumbnailsModule) {
  const now = Date.now();
  const hit = clipInfoMemo.get(clipName);
  if (hit && now - hit.ts < CLIP_INFO_MEMO_TTL_MS) return hit.promise;

  const promise = getClipInfoUncached(clipName, getSettings, thumbnailsModule);
  clipInfoMemo.set(clipName, { promise, ts: now });
  promise.catch(() => {
    // Only evict if this rejection still owns the slot — a slow failure must
    // not delete a newer entry that replaced it.
    if (clipInfoMemo.get(clipName)?.promise === promise) clipInfoMemo.delete(clipName);
  });
  // Opportunistic sweep so the map doesn't grow with every opened clip.
  if (clipInfoMemo.size > 64) {
    for (const [key, entry] of clipInfoMemo) {
      if (now - entry.ts >= CLIP_INFO_MEMO_TTL_MS) clipInfoMemo.delete(key);
    }
  }
  return promise;
}

async function getClipInfoUncached(clipName, getSettings, thumbnailsModule) {
  logger.info(`[ffmpeg] get-clip-info requested for: ${clipName}`);
  const settings = await getSettings();
  const clipPath = path.join(settings.clipLocation, clipName);
  const thumbnailPath = thumbnailsModule.generateThumbnailPath(clipPath);

  try {
    // Check if file exists first
    try {
      await fs.access(clipPath);
      logger.info(`[ffmpeg] Clip file exists: ${clipPath}`);
    } catch (accessError) {
      logger.error(`[ffmpeg] Clip file does not exist: ${clipPath}`, accessError);
      telemetry.event('clip_open_failed', {
        kind: telemetry.KIND.ERROR,
        severity: telemetry.SEVERITY.ERROR,
        context: { errno: accessError?.code }
      });
      throw new Error(`Clip file not found: ${clipName}`);
    }

    // Try to get metadata from cache first
    const metadata = await thumbnailsModule.getThumbnailMetadata(thumbnailPath);
    const cacheHasFreshAudio = metadata
      && metadata.duration
      && Array.isArray(metadata.audioTracks)
      && metadata.audioTracksVersion === AUDIO_TRACKS_CACHE_VERSION;

    if (cacheHasFreshAudio) {
      logger.info(`[ffmpeg] Using cached metadata for ${clipName} - duration: ${metadata.duration}, audioTracks: ${metadata.audioTracks.length}`);
      return {
        format: {
          filename: clipPath,
          duration: metadata.duration
        },
        audioTracks: metadata.audioTracks
      };
    }

    logger.info(`[ffmpeg] No (complete) cached metadata, running ffprobe for: ${clipName}`);
    // One direct ffprobe returns format + streams together with raw stream
    // tags. (This used to be two spawns per cold clip: fluent-ffmpeg's probe
    // for the format, then a second direct probe for reliable tags — ~2x the
    // ~120ms process cost on the open path.)
    let info;
    let probeStdout = '';
    try {
      const { stdout } = await execFileAsync(ffprobePath, [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        clipPath
      ]);
      probeStdout = stdout || '';
      const parsed = JSON.parse(probeStdout || '{}');
      const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
      info = {
        format: {
          filename: clipPath,
          duration: Number(parsed.format && parsed.format.duration) || 0
        },
        streams,
        audioTracks: buildAudioTracksFromStreams(streams)
      };
    } catch (directErr) {
      // Fall back to fluent-ffmpeg's probe (its stream tags are sometimes
      // filtered, but a generic track name beats failing the open).
      logger.warn(`[ffmpeg] direct ffprobe failed for ${clipName}, falling back to fluent probe: ${directErr?.error?.message || directErr.message || directErr}`);
      // Costs a second probe spawn on the open path, and malformed JSON looks
      // exactly like a failed spawn from the outside.
      telemetry.event('clip_probe_fallback', {
        kind: telemetry.KIND.DEGRADED,
        severity: telemetry.SEVERITY.INFO,
        context: {
          ...execErrorCodes(directErr),
          stdout_bytes: Buffer.byteLength(probeStdout || directErr?.stdout || '', 'utf8')
        },
        coalesceMs: PROBE_FALLBACK_COALESCE_MS
      });
      info = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(clipPath, (err, res) => (err ? reject(err) : resolve(res)));
      });
      info.audioTracks = buildAudioTracksFromStreams(info.streams);
    }
    logger.info(`[ffmpeg] ffprobe successful for ${clipName} - duration: ${info.format.duration}, audioTracks: ${info.audioTracks.length} (${info.audioTracks.map((t) => t.name).join(' | ')})`);
    const existingMetadata = await thumbnailsModule.getThumbnailMetadata(thumbnailPath) || {};
    await thumbnailsModule.saveThumbnailMetadata(thumbnailPath, {
      ...existingMetadata,
      duration: info.format.duration,
      audioTracks: info.audioTracks,
      audioTracksVersion: AUDIO_TRACKS_CACHE_VERSION,
      timestamp: Date.now()
    });
    return info;
  } catch (error) {
    logger.error(`[ffmpeg] Error getting clip info for ${clipName}:`, error);
    throw error;
  }
}

/**
 * Extract each audio track to its own .m4a file (stream-copy, no re-encode).
 * Cached under <clipLocation>/.clip_metadata/audio_tracks/<safe-clipname>/track_<ordinal>.m4a
 * Returns [{ ordinal, streamIndex, path }] for every audio track in the clip.
 */
async function extractAudioTracks(clipName, getSettings, thumbnailsModule) {
  const settings = await getSettings();
  const clipPath = path.join(settings.clipLocation, clipName);

  // Reuse the cached audio-track metadata if present.
  const info = await getClipInfo(clipName, getSettings, thumbnailsModule);
  const tracks = Array.isArray(info?.audioTracks) ? info.audioTracks : [];
  if (tracks.length === 0) return [];

  const safeName = clipName.replace(/\//g, '--').replace(/\\/g, '--');
  // v3 dir bump — extractor now branches per-track between stream-copy
  // (fast, default for tracks with no edit-list offset) and re-encode (only
  // for tracks where ffprobe reported a non-zero start_time). v2 always
  // re-encoded; v1 always stream-copied and produced broken offset tracks.
  const outDir = path.join(settings.clipLocation, '.clip_metadata', 'audio_tracks_v3', safeName);
  await fs.mkdir(outDir, { recursive: true });

  let sourceMtimeMs = 0;
  try {
    const sourceStat = await fs.stat(clipPath);
    sourceMtimeMs = sourceStat.mtimeMs;
  } catch (error) {
    logger.warn(`[ffmpeg] extractAudioTracks: could not stat source ${clipPath}: ${error.message}`);
    // mtime 0 makes every cached track compare as fresh forever, so a
    // re-recorded clip keeps serving the old audio.
    telemetry.event('audio_cache_stale_forever', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { errno: error?.code }
    });
  }

  const results = [];
  const missing = [];
  for (const track of tracks) {
    const outPath = path.join(outDir, `track_${track.ordinal}.m4a`);
    let needsExtract = true;
    try {
      const st = await fs.stat(outPath);
      if (st.size > 0 && st.mtimeMs >= sourceMtimeMs) {
        needsExtract = false;
      }
    } catch (_) {
      needsExtract = true;
    }
    results.push({ ordinal: track.ordinal, streamIndex: track.streamIndex, path: outPath });
    if (needsExtract) missing.push({ track, outPath });
  }

  if (missing.length === 0) {
    return results;
  }

  // Per-track extraction in parallel — one ffmpeg process per stream.
  //
  // Why not a single multi-output ffmpeg call? Multi-output shares a single
  // decode pass across all outputs but serializes the encoders; for clips
  // with several long tracks the encode phase dominates and benefits more
  // from process-level parallelism than from a shared demuxer.
  //
  // Per-track branching:
  //   - needsReencode === false → `-c:a copy` (stream copy, near-zero CPU).
  //   - needsReencode === true  → re-encode with aresample to flatten the
  //     edit-list offset. AAC @ 192k VBR-ish is well above transparent for
  //     voice/desktop audio and ~25% faster than the previous 256k CBR.
  //
  // Both produce .m4a (audio-only mp4). Chrome plays both via <audio>.
  const reencodeCount = missing.filter(({ track }) => track.needsReencode).length;
  logger.info(`[ffmpeg] Extracting ${missing.length} audio track(s) for ${clipName} (${missing.length - reencodeCount} copy, ${reencodeCount} re-encode)`);

  const buildArgsForTrack = ({ track, outPath }) => {
    const baseArgs = ['-y', '-hide_banner', '-loglevel', 'error', '-i', clipPath,
      '-map', `0:${track.streamIndex}`, '-vn'];
    if (track.needsReencode) {
      return [
        ...baseArgs,
        '-c:a', 'aac',
        '-b:a', '192k',
        '-af', 'aresample=async=1:first_pts=0',
        outPath
      ];
    }
    return [
      ...baseArgs,
      '-c:a', 'copy',
      outPath
    ];
  };

  await Promise.all(missing.map((entry) => execFileAsync(ffmpegPath, buildArgsForTrack(entry))))
    .catch((error) => {
      // The rejection keeps propagating exactly as before: main.js turns it
      // into [] and the player shows zero audio tracks with no error anywhere.
      telemetry.event('audio_track_extract_failed', {
        kind: telemetry.KIND.SILENT_FAILURE,
        severity: telemetry.SEVERITY.ERROR,
        context: {
          expected_tracks: tracks.length,
          ...execErrorCodes(error)
        }
      });
      throw error;
    });

  return results;
}

/**
 * Reset every cached artifact tied to a single clip: thumbnail jpg, thumbnail
 * .meta file (which holds duration + audioTracks), and every versioned
 * audio-track extraction dir (audio_tracks, audio_tracks_v2, audio_tracks_v3,
 * …). Does NOT touch user-owned data (trim, speed, volume, tags, trackstate)
 * — that's persisted under `.clip_metadata/<clip>.{trim,speed,volume,tags,
 * trackstate}` and survives a cache reset by design.
 *
 * Used by the right-click "Reset cache" entry to test first-show timings.
 */
async function resetClipCache(clipName, getSettings, thumbnailsModule) {
  // Drop the in-memory memo too — a hit within its TTL would resurrect the
  // just-deleted .meta contents.
  clipInfoMemo.delete(clipName);
  const settings = await getSettings();
  const clipPath = path.join(settings.clipLocation, clipName);
  const thumbnailPath = thumbnailsModule.generateThumbnailPath(clipPath);
  const removed = [];

  const rmFile = async (p) => {
    try {
      await fs.unlink(p);
      removed.push(p);
    } catch (err) {
      if (err && err.code !== 'ENOENT') logger.warn(`[reset-cache] unlink ${p}: ${err.message}`);
    }
  };
  const rmDir = async (p) => {
    try {
      await fs.rm(p, { recursive: true, force: true });
      removed.push(p);
    } catch (err) {
      if (err && err.code !== 'ENOENT') logger.warn(`[reset-cache] rm ${p}: ${err.message}`);
    }
  };

  await rmFile(thumbnailPath);
  await rmFile(thumbnailPath + '.meta');

  const safeName = clipName.replace(/\//g, '--').replace(/\\/g, '--');
  const audioTrackDirs = ['audio_tracks', 'audio_tracks_v2', 'audio_tracks_v3'];
  await Promise.all(audioTrackDirs.map((d) =>
    rmDir(path.join(settings.clipLocation, '.clip_metadata', d, safeName))
  ));

  logger.info(`[reset-cache] ${clipName}: removed ${removed.length} path(s)`);
  return { removed };
}

module.exports = {
  initFFmpeg,
  getFFmpegVersion,
  getNvencStatus,
  getExportAccelerationStatus,
  ffprobeAsync,
  exportVideo,
  exportTrimmedVideo,
  exportTrimmedVideoForShare,
  exportAudio,
  exportVideoWithFallback,
  generateScreenshot,
  setupProgressListeners,
  getClipInfo,
  extractAudioTracks,
  resetClipCache,
  // Re-export fluent-ffmpeg for thumbnail generation
  ffmpeg
};
