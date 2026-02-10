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
const { logActivity } = require('../utils/activity-tracker');
const NVENC_STATUS_TTL_MS = 5 * 60 * 1000;
const DECODER_LIST_TTL_MS = 5 * 60 * 1000;
const DISCORD_TARGET_BYTES = Math.floor(9.5 * 1024 * 1024);
const DISCORD_AUDIO_BITRATE_K = 96;
const CUDA_DECODER_BY_CODEC = {
  h264: 'h264_cuvid',
  hevc: 'hevc_cuvid',
  av1: 'av1_cuvid',
  mpeg2video: 'mpeg2_cuvid',
  vp8: 'vp8_cuvid',
  vp9: 'vp9_cuvid',
  mjpeg: 'mjpeg_cuvid'
};
let nvencStatusCache = null;
let decoderListCache = null;

// FFmpeg binary paths
// Configure FFmpeg paths
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

/**
 * Verify FFmpeg is working on startup
 */
function initFFmpeg() {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-version'], (error, stdout, stderr) => {
      if (error) {
        logger.error('Error getting ffmpeg version:', error);
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

function getCudaDecoderForCodec(codecName, decoderNames) {
  const normalizedCodec = String(codecName || '').toLowerCase();
  const candidate = CUDA_DECODER_BY_CODEC[normalizedCodec];
  if (!candidate) return null;
  return decoderNames.has(candidate) ? candidate : null;
}

async function getExportAccelerationStatus(options = {}) {
  const nvencStatus = await getNvencStatus(options);
  let cudaDecoders = [];

  try {
    const decoderNames = await getDecoderNames(options);
    cudaDecoders = Object.values(CUDA_DECODER_BY_CODEC).filter((decoderName) => decoderNames.has(decoderName));
  } catch (error) {
    logger.warn(`[ffmpeg] Failed to query decoders for acceleration status: ${error.message}`);
  }

  return {
    ...nvencStatus,
    cudaDecoders
  };
}

function calculateDiscordVideoBitrateKbps(durationSeconds) {
  const duration = Math.max(0.5, Number(durationSeconds) || 0.5);
  const totalKbpsBudget = Math.floor((DISCORD_TARGET_BYTES * 8) / duration / 1000);
  const videoKbps = totalKbpsBudget - DISCORD_AUDIO_BITRATE_K - 48;
  return Math.max(450, Math.min(14000, videoKbps));
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

  if (quality === 'discord') {
    benchmark.targetSizeMB = Number((DISCORD_TARGET_BYTES / (1024 * 1024)).toFixed(2));
    benchmark.targetVideoBitrateKbps = calculateDiscordVideoBitrateKbps(clipDurationSeconds);
    benchmark.targetAudioBitrateKbps = DISCORD_AUDIO_BITRATE_K;
  }

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
async function exportVideoWithFallback(options) {
  const {
    inputPath,
    outputPath,
    start,
    end,
    volume,
    speed,
    quality,
    volumeData,
    onProgress,
    onFallback,
    allowAudioCopy = true,
    emitGlobalProgress = true
  } = options;
  const duration = Math.max(0.01, Number(end) - Number(start));

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

  return new Promise((resolve, reject) => {
    let usingFallback = false;
    let lastProgressTime = Date.now();
    let totalFrames = 0;
    let processedFrames = 0;

    ffmpeg.ffprobe(inputPath, async (err, metadata) => {
      if (err) {
        logger.error('Error getting video info:', err);
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
        quality === 'discord' &&
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
      const needsAudioFilter = audioFilters.length > 0;
      const canAttemptHwDecode = !needsVideoFilter;

      const discordVideoBitrateKbps = calculateDiscordVideoBitrateKbps(duration);
      logger.info(
        `[ffmpeg] Export pipeline: quality=${quality}, speed=${effectiveSpeed}, ` +
        `videoFilter=${needsVideoFilter}, audioFilter=${needsAudioFilter}, hwDecodeCandidate=${canAttemptHwDecode}, scaleDown=${needsScaleDown}, ` +
        `discordTargetVideo=${discordVideoBitrateKbps}k`
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

        if (needsVideoFilter) {
          command.videoFilters(videoFilters);
        }

        if (needsAudioFilter) {
          command.audioFilters(audioFilters);
        }

        return command;
      };

      const getPipelineInfo = () => ({
        sourceWidth,
        sourceHeight,
        sourceFps,
        sourceCodec,
        sourcePixelFormat,
        hwDecodeEnabled,
        hwDecodeMode: activeDecodeMode,
        requestedCudaDecoder,
        decodeAttempts: [...attemptedDecodeModes],
        decodeErrors: { ...decodeErrors },
        videoFilters: [...videoFilters],
        audioFilters: [...audioFilters]
      });

      const runSoftwareEncode = () => {
        const softwarePreset = quality === 'discord'
          ? 'superfast'
          : (quality === 'high' ? 'fast' : 'medium');
        const softwareCrf = quality === 'discord'
          ? 28
          : (quality === 'high' ? 19 : 0);

        const softwareOptions = [
          '-c:v libx264',
          `-preset ${softwarePreset}`,
          quality === 'lossless' ? '-crf 0' : `-crf ${softwareCrf}`,
          '-pix_fmt yuv420p',
          '-progress pipe:1',
          '-stats_period 0.1'
        ];

        const shouldCopyAudio = !needsAudioFilter && allowAudioCopy && quality !== 'discord';
        if (shouldCopyAudio) {
          softwareOptions.push('-c:a copy');
        } else {
          const audioBitrateK = quality === 'discord'
            ? DISCORD_AUDIO_BITRATE_K
            : (quality === 'high' ? 192 : 320);
          softwareOptions.push(`-b:a ${audioBitrateK}k`);
          softwareOptions.push('-c:a aac');
        }

        if (quality === 'discord') {
          softwareOptions.push(`-maxrate ${discordVideoBitrateKbps}k`);
          softwareOptions.push(`-bufsize ${Math.max(discordVideoBitrateKbps * 2, 1200)}k`);
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
            reject(ffmpegError);
          })
          .save(outputPath);
      };

      const nvencStatus = await getNvencStatus();
      if (!nvencStatus.available) {
        usingFallback = true;
        notifyFallback();
        logger.warn(`[ffmpeg] NVENC unavailable. Using software encode. Reason: ${nvencStatus.reason}`);
        reportProgress(0);
        runSoftwareEncode();
        return;
      }

      const decodeModes = ['none'];
      if (canAttemptHwDecode) {
        decodeModes.unshift('dxva2');
        decodeModes.unshift('d3d11va');
        decodeModes.unshift('cuda');
        try {
          const decoderNames = await getDecoderNames();
          requestedCudaDecoder = getCudaDecoderForCodec(sourceCodec, decoderNames);
          if (requestedCudaDecoder) {
            decodeModes.unshift('cuda_cuvid');
            logger.info(`[ffmpeg] CUDA decode enabled with decoder: ${requestedCudaDecoder}`);
          } else {
            logger.info(`[ffmpeg] CUDA decode will use generic hwaccel path for source codec "${sourceCodec || 'unknown'}".`);
          }
        } catch (decoderError) {
          logger.warn(`[ffmpeg] Failed to query decoder support, continuing with generic CUDA decode: ${decoderError.message}`);
        }
      }

      const runNvencAttempt = (decodeModeIndex = 0) => {
        const decodeMode = decodeModes[decodeModeIndex] || 'none';
        const isCudaDecodeMode = decodeMode === 'cuda' || decodeMode === 'cuda_cuvid';
        activeDecodeMode = decodeMode;
        hwDecodeEnabled = decodeMode !== 'none';
        attemptedDecodeModes.push(decodeMode);

        processedFrames = 0;
        lastProgressTime = Date.now();

        const command = createBaseCommand(decodeMode);

        const nvencQualityOptions = [];
        switch (quality) {
          case 'lossless':
            nvencQualityOptions.push(
              '-c:v h264_nvenc',
              '-preset p7',
              '-tune lossless',
              '-rc:v constqp',
              '-qp 0',
              '-profile:v high',
              '-c:a aac',
              '-b:a 192k'
            );
            break;
          case 'high':
            nvencQualityOptions.push(
              '-c:v h264_nvenc',
              '-preset p5',
              '-rc:v vbr',
              '-cq:v 18',
              '-b:v 14M',
              '-maxrate:v 20M',
              '-bufsize:v 28M',
              '-profile:v high',
              '-rc-lookahead 32',
              '-c:a aac',
              '-b:a 192k'
            );
            break;
          default: // discord
            nvencQualityOptions.push(
              '-c:v h264_nvenc',
              '-preset p1',
              '-rc:v cbr',
              '-tune ll',
              `-b:v ${discordVideoBitrateKbps}k`,
              `-maxrate:v ${discordVideoBitrateKbps}k`,
              `-bufsize:v ${Math.max(discordVideoBitrateKbps * 2, 1200)}k`,
              '-profile:v high',
              '-rc-lookahead 0',
              '-bf 0',
              '-c:a aac',
              `-b:a ${DISCORD_AUDIO_BITRATE_K}k`
            );
        }

        if (!isCudaDecodeMode) {
          nvencQualityOptions.push('-pix_fmt yuv420p');
        }
        command.outputOptions(nvencQualityOptions);

        if (!needsAudioFilter && allowAudioCopy && quality !== 'discord') {
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
            runSoftwareEncode();
          })
          .on('end', () => {
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
async function exportVideo(clipName, start, end, volume, speed, savePath, getSettings, progressCallbacks = null) {
  const settings = await getSettings();
  const inputPath = path.join(settings.clipLocation, clipName);
  const outputPath = savePath || path.join(os.tmpdir(), `exported_${Date.now()}_${clipName}`);

  // Load volume range data if it exists
  const metadataFolder = path.join(path.dirname(inputPath), '.clip_metadata');
  const volumeRangeFilePath = path.join(metadataFolder, `${clipName}.volumerange`);

  let volumeData = null;
  try {
    const volumeDataRaw = await fs.readFile(volumeRangeFilePath, 'utf8');
    volumeData = JSON.parse(volumeDataRaw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading volume range data:', error);
    }
  }

  try {
    const onProgress = typeof progressCallbacks?.onProgress === 'function'
      ? progressCallbacks.onProgress
      : null;
    const onFallback = typeof progressCallbacks?.onFallback === 'function'
      ? progressCallbacks.onFallback
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
      volumeData,
      onProgress,
      onFallback,
      allowAudioCopy: !savePath && quality !== 'discord',
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
      quality,
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
      videoFilters: pipeline.videoFilters,
      audioFilters: pipeline.audioFilters
    });
    logger.info('[ffmpeg] Export benchmark:', benchmark);

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
async function exportTrimmedVideo(clipName, start, end, volume, speed, getSettings, progressCallbacks = null) {
  const settings = await getSettings();
  const inputPath = path.join(settings.clipLocation, clipName);
  const outputPath = path.join(os.tmpdir(), `trimmed_${Date.now()}_${clipName}`);

  // Load volume range data if it exists
  const metadataFolder = path.join(path.dirname(inputPath), '.clip_metadata');
  const volumeRangeFilePath = path.join(metadataFolder, `${clipName}.volumerange`);

  let volumeData = null;
  try {
    const volumeDataRaw = await fs.readFile(volumeRangeFilePath, 'utf8');
    volumeData = JSON.parse(volumeDataRaw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading volume range data:', error);
    }
  }

  try {
    const onProgress = typeof progressCallbacks?.onProgress === 'function'
      ? progressCallbacks.onProgress
      : null;
    const onFallback = typeof progressCallbacks?.onFallback === 'function'
      ? progressCallbacks.onFallback
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
      volumeData,
      onProgress,
      onFallback,
      allowAudioCopy: quality !== 'discord',
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
      quality,
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
      videoFilters: pipeline.videoFilters,
      audioFilters: pipeline.audioFilters
    });
    logger.info('[ffmpeg] Export benchmark:', benchmark);

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
async function exportTrimmedVideoForShare(clipName, start, end, volume, speed, getSettings, onProgress = null) {
  const settings = await getSettings();
  const inputPath = path.join(settings.clipLocation, clipName);
  const outputPath = path.join(os.tmpdir(), `shared_${Date.now()}_${path.parse(clipName).name}.mp4`);

  const metadataFolder = path.join(path.dirname(inputPath), '.clip_metadata');
  const volumeRangeFilePath = path.join(metadataFolder, `${clipName}.volumerange`);

  let volumeData = null;
  try {
    const volumeDataRaw = await fs.readFile(volumeRangeFilePath, 'utf8');
    volumeData = JSON.parse(volumeDataRaw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading volume range data:', error);
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
      volumeData,
      onProgress,
      allowAudioCopy: quality !== 'discord',
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
      quality,
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
      videoFilters: pipeline.videoFilters,
      audioFilters: pipeline.audioFilters
    });
    logger.info('[ffmpeg] Export benchmark:', benchmark);

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
async function exportAudio(clipName, start, end, volume, speed, savePath, getSettings) {
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

  try {
    const exportStartedAt = Date.now();
    await new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath)
        .seekInput(start)
        .setDuration(duration)
        .output(outputPath)
        .audioCodec('libmp3lame');

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

    return {
      success: true,
      path: outputPath,
      encoder: 'libmp3lame',
      benchmark
    };
  } catch (error) {
    logger.error('Error exporting audio:', error);
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
async function getClipInfo(clipName, getSettings, thumbnailsModule) {
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
      throw new Error(`Clip file not found: ${clipName}`);
    }

    // Try to get metadata from cache first
    const metadata = await thumbnailsModule.getThumbnailMetadata(thumbnailPath);
    if (metadata && metadata.duration) {
      logger.info(`[ffmpeg] Using cached metadata for ${clipName} - duration: ${metadata.duration}`);
      return {
        format: {
          filename: clipPath,
          duration: metadata.duration
        }
      };
    }

    logger.info(`[ffmpeg] No cached metadata found, running ffprobe for: ${clipName}`);
    // If no cached metadata, get it from ffprobe and cache it
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(clipPath, async (err, info) => {
        if (err) {
          logger.error(`[ffmpeg] ffprobe failed for ${clipName}:`, err);
          reject(err);
        } else {
          logger.info(`[ffmpeg] ffprobe successful for ${clipName} - duration: ${info.format.duration}`);
          // Cache the metadata
          const existingMetadata = await thumbnailsModule.getThumbnailMetadata(thumbnailPath) || {};
          await thumbnailsModule.saveThumbnailMetadata(thumbnailPath, {
            ...existingMetadata,
            duration: info.format.duration,
            timestamp: Date.now()
          });
          resolve(info);
        }
      });
    });
  } catch (error) {
    logger.error(`[ffmpeg] Error getting clip info for ${clipName}:`, error);
    throw error;
  }
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
  // Re-export fluent-ffmpeg for thumbnail generation
  ffmpeg
};
