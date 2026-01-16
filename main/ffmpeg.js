/**
 * FFmpeg module - handles video/audio encoding and export
 *
 * Provides NVENC hardware encoding with automatic fallback to software encoding.
 * Handles progress tracking and clipboard integration.
 */

const { execFile } = require('child_process');
const { clipboard, ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const ffprobePath = require('@ffprobe-installer/ffprobe').path.replace('app.asar', 'app.asar.unpacked');
const logger = require('../logger');
const { logActivity } = require('../activity-tracker');

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
 * @returns {Promise<boolean>} True if fallback was used
 */
async function exportVideoWithFallback(options) {
  const { inputPath, outputPath, start, end, volume, speed, quality, volumeData } = options;
  const duration = end - start;

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

      const fps = eval(metadata.streams[0].r_frame_rate);
      totalFrames = Math.ceil(duration * fps);

      let command = ffmpeg(inputPath)
        .setStartTime(start)
        .setDuration(duration)
        .videoFilters(`setpts=${1/speed}*PTS`)
        .audioFilters(`atempo=${speed}`);

      // Apply volume filter
      if (volumeData) {
        // Convert absolute timestamps to relative timestamps based on trim
        const relativeStart = Math.max(0, volumeData.start - start);
        const relativeEnd = Math.min(duration, volumeData.end - start);

        if (relativeStart < duration && relativeEnd > 0) {
          // Complex volume filter for the specified range
          command.audioFilters([
            `volume=${volume}`,
            `volume=${volumeData.level}:enable='between(t,${relativeStart},${relativeEnd})'`
          ]);
        } else {
          command.audioFilters(`volume=${volume}`);
        }
      } else {
        command.audioFilters(`volume=${volume}`);
      }

      // Apply quality settings
      switch (quality) {
        case 'lossless':
          command.outputOptions([
            '-c:v h264_nvenc',
            '-preset p7',
            '-rc:v constqp',
            '-qp 16',
            '-profile:v high',
            '-b:a 256k'
          ]);
          break;
        case 'high':
          command.outputOptions([
            '-c:v h264_nvenc',
            '-preset p4',
            '-rc vbr',
            '-cq 20',
            '-b:v 8M',
            '-maxrate 10M',
            '-bufsize 10M',
            '-profile:v high',
            '-rc-lookahead 32'
          ]);
          break;
        default: // discord
          command.outputOptions([
            '-c:v h264_nvenc',
            '-preset slow',
            '-crf 23'
          ]);
      }

      command.outputOptions([
        '-progress pipe:1',
        '-stats_period 0.1'
      ])
      .on('start', (commandLine) => {
        logger.info('Spawned FFmpeg with command: ' + commandLine);
      })
      .on('stderr', (stderrLine) => {
        // Parse frame information from stderr
        const frameMatch = stderrLine.match(/frame=\s*(\d+)/);
        if (frameMatch) {
          processedFrames = parseInt(frameMatch[1]);
          const progress = Math.min((processedFrames / totalFrames) * 100, 99.9);

          // Throttle updates to max 10 per second
          const now = Date.now();
          if (now - lastProgressTime >= 100) {
            emitProgress(progress);
            lastProgressTime = now;
          }
        }
      })
      .on('error', (err, stdout, stderr) => {
        logger.warn('Hardware encoding failed, falling back to software encoding');
        logger.error('Error:', err.message);
        logger.error('stdout:', stdout);
        logger.error('stderr:', stderr);

        usingFallback = true;
        emitFallbackNotice();

        // Reset progress tracking for fallback
        processedFrames = 0;
        lastProgressTime = Date.now();

        // Software encoding fallback
        ffmpeg(inputPath)
          .setStartTime(start)
          .setDuration(duration)
          .audioFilters(`volume=${volume}`)
          .videoFilters(`setpts=${1/speed}*PTS`)
          .audioFilters(`atempo=${speed}`)
          .outputOptions([
            '-c:v libx264',
            '-preset medium',
            '-crf 23',
            '-progress pipe:1',
            '-stats_period 0.1'
          ])
          .on('stderr', (stderrLine) => {
            const frameMatch = stderrLine.match(/frame=\s*(\d+)/);
            if (frameMatch) {
              processedFrames = parseInt(frameMatch[1]);
              const progress = Math.min((processedFrames / totalFrames) * 100, 99.9);

              const now = Date.now();
              if (now - lastProgressTime >= 100) {
                emitProgress(progress);
                lastProgressTime = now;
              }
            }
          })
          .on('end', () => {
            emitProgress(100);
            resolve(usingFallback);
          })
          .on('error', (err, stdout, stderr) => {
            logger.error('FFmpeg error:', err.message);
            logger.error('FFmpeg stdout:', stdout);
            logger.error('FFmpeg stderr:', stderr);
            reject(err);
          })
          .save(outputPath);
      })
      .on('end', () => {
        emitProgress(100);
        resolve(usingFallback);
      })
      .save(outputPath);
    });
  });
}

/**
 * Export video to file or clipboard
 */
async function exportVideo(clipName, start, end, volume, speed, savePath, getSettings) {
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
    await exportVideoWithFallback({
      inputPath,
      outputPath,
      start,
      end,
      volume,
      speed,
      quality: settings.exportQuality || 'discord',
      volumeData
    });

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

    return { success: true, path: outputPath };
  } catch (error) {
    logger.error('Error exporting video:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Export trimmed video to clipboard
 */
async function exportTrimmedVideo(clipName, start, end, volume, speed, getSettings) {
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
    await exportVideoWithFallback({
      inputPath,
      outputPath,
      start,
      end,
      volume,
      speed,
      quality: settings.exportQuality || 'discord',
      volumeData
    });

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

    return { success: true, path: outputPath };
  } catch (error) {
    logger.error('Error exporting trimmed video:', error);
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

  // Adjust duration based on speed
  const adjustedDuration = (end - start) / speed;

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(start)
        .setDuration(adjustedDuration)
        .audioFilters(`volume=${volume},atempo=${speed}`)
        .output(outputPath)
        .audioCodec('libmp3lame')
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

    return { success: true, path: outputPath };
  } catch (error) {
    logger.error('Error exporting audio:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Copy file path to clipboard (platform-specific)
 */
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
function setupProgressListeners() {
  ipcMain.on('ffmpeg-fallback', () => {
    emitFallbackNotice();
  });

  ipcMain.on('ffmpeg-progress', (percent) => {
    emitProgress(percent);
  });
}

module.exports = {
  initFFmpeg,
  getFFmpegVersion,
  ffprobeAsync,
  exportVideo,
  exportTrimmedVideo,
  exportAudio,
  exportVideoWithFallback,
  generateScreenshot,
  setupProgressListeners,
  // Re-export fluent-ffmpeg for thumbnail generation
  ffmpeg
};
