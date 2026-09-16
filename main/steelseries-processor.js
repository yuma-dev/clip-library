const { promises: fs, statSync } = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../utils/logger');
const { logActivity } = require('../utils/activity-tracker');
const telemetry = require('./telemetry');

// spawns a bare `ffprobe`/`ffmpeg` from PATH, not the app's bundled binaries
// so on a stock machine this is ENOENT and import quietly does nothing
function reportBinaryMissing(binary, err) {
    telemetry.event('steelseries_binary_missing', {
        kind: telemetry.KIND.SILENT_FAILURE,
        severity: telemetry.SEVERITY.ERROR,
        context: { binary, errno: err?.code }
    });
}

class SteelSeriesProcessor {
    constructor(inputFolder, exportFolder, progressCallback, logCallback) {
        this.inputFolder = inputFolder;
        this.exportFolder = exportFolder;
        this.metadataFolder = path.join(exportFolder, '.clip_metadata');
        this.progressCallback = progressCallback;
        this.logCallback = logCallback;
        // for the import summary event only
        this.stats = { total: 0, failed: 0, skipped: 0 };
    }

    log(message) {
        if (this.logCallback) {
            this.logCallback(message);
        }
    }

    async ensureFoldersExist() {
        await fs.mkdir(this.exportFolder, { recursive: true });
        await fs.mkdir(this.metadataFolder, { recursive: true });
    }

    async copyFileTimestamps(srcPath, dstPath) {
        try {
            const srcStat = statSync(srcPath);
            await fs.utimes(dstPath, srcStat.atime, srcStat.mtime);
            return true;
        } catch (err) {
            console.error(`Failed to copy timestamps: ${err.message}`);
            return false;
        }
    }

    async getAudioStreamCount(inputFile) {
        return new Promise((resolve, reject) => {
            const ffprobe = spawn('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                '-select_streams', 'a',
                inputFile
            ]);

            let outputData = '';

            ffprobe.stdout.on('data', (data) => {
                outputData += data;
            });

            ffprobe.on('close', (code) => {
                try {
                    const data = JSON.parse(outputData);
                    const streamCount = data.streams ? data.streams.length : 0;
                    this.log(`Found ${streamCount} audio streams`);
                    resolve(streamCount);
                } catch (err) {
                    console.error('Error parsing audio stream data:', err);
                    resolve(0);
                }
            });

            ffprobe.on('error', (err) => {
                console.error('FFprobe process error:', err);
                reportBinaryMissing('ffprobe', err);
                resolve(0);
            });
        });
    }

    async extractSteelSeriesMetadata(inputFile) {
        return new Promise((resolve, reject) => {
            const ffprobe = spawn('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_format',
                inputFile
            ]);

            let outputData = '';

            ffprobe.stdout.on('data', (data) => {
                outputData += data;
            });

            ffprobe.on('close', async (code) => {
                try {
                    const mediaInfo = JSON.parse(outputData);
                    const tags = mediaInfo.format.tags || {};

                    // STEELSERIES_META tags are numbered (0000, 0001, ...) and split across
                    // multiple keys; concatenate in sorted order to get the full JSON
                    let fullMeta = '';
                    const metaKeys = Object.keys(tags).filter(key => key.startsWith('STEELSERIES_META'));
                    metaKeys.sort();

                    for (const key of metaKeys) {
                        fullMeta += tags[key];
                    }

                    try {
                        const metadata = JSON.parse(fullMeta);
                        resolve({
                            name: metadata.name,
                            clip_start_point: metadata.clip_start_point,
                            clip_end_point: metadata.clip_end_point,
                            recording_timestamp: metadata.recording_timestamp
                        });
                    } catch (parseErr) {
                        console.error('Error parsing combined metadata:', parseErr);
                        resolve(null);
                    }
                } catch (err) {
                    console.error('Error processing metadata:', err);
                    resolve(null);
                }
            });

            ffprobe.on('error', (err) => {
                console.error('FFprobe process error:', err);
                reportBinaryMissing('ffprobe', err);
                resolve(null);
            });
        });
    }

    async getAllMetadata(inputFile) {
        return new Promise((resolve, reject) => {
            const ffprobe = spawn('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_format',
                '-show_streams',
                inputFile
            ]);

            let outputData = '';

            ffprobe.stdout.on('data', (data) => {
                outputData += data;
            });

            ffprobe.on('close', (code) => {
                try {
                    const mediaInfo = JSON.parse(outputData);
                    this.log('Complete metadata:', JSON.stringify(mediaInfo, null, 2));
                    resolve(mediaInfo);
                } catch (err) {
                    reject(err);
                }
            });

            ffprobe.on('error', (err) => {
                reportBinaryMissing('ffprobe', err);
                reject(err);
            });
        });
    }

    async combineAudioAndCopy(inputFile, outputFile) {
        return new Promise(async (resolve) => {
            const audioStreams = await this.getAudioStreamCount(inputFile);
            
            if (audioStreams === 0) {
                this.log(`No audio streams found in ${inputFile}`);
                resolve(false);
                return;
            }

            let ffmpegArgs;
            if (audioStreams === 1) {
                ffmpegArgs = [
                    '-i', inputFile,
                    '-c:v', 'copy',
                    '-c:a', 'copy',
                    '-y',
                    outputFile
                ];
            } else {
                // mix multiple audio streams together
                const filterInputs = Array.from({ length: audioStreams }, (_, i) => `[0:a:${i}]`).join('');
                const filterString = `${filterInputs}amix=inputs=${audioStreams}:duration=longest[aout]`;
                
                ffmpegArgs = [
                    '-i', inputFile,
                    '-c:v', 'copy',
                    '-filter_complex', filterString,
                    '-map', '0:v:0',
                    '-map', '[aout]',
                    '-y',
                    outputFile
                ];
            }

            const ffmpeg = spawn('ffmpeg', ffmpegArgs);

            ffmpeg.stderr.on('data', (data) => {
                this.log(`FFmpeg: ${data}`);
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    this.copyFileTimestamps(inputFile, outputFile);
                    resolve(true);
                } else {
                    console.error(`FFmpeg process exited with code ${code}`);
                    telemetry.event('steelseries_import_failed', {
                        kind: telemetry.KIND.ERROR,
                        severity: telemetry.SEVERITY.ERROR,
                        context: { exit_code: code, stage: 'combine_audio', audio_streams: audioStreams }
                    });
                    resolve(false);
                }
            });

            ffmpeg.on('error', (err) => {
                console.error('FFmpeg process error:', err);
                reportBinaryMissing('ffmpeg', err);
                resolve(false);
            });
        });
    }

    async shouldProcessFile(inputFile) {
        const fileName = path.basename(inputFile);
        const outputFile = path.join(this.exportFolder, fileName);
        const nameFile = path.join(this.metadataFolder, `${fileName}.customname`);
        const trimFile = path.join(this.metadataFolder, `${fileName}.trim`);

        try {
            await Promise.all([
                fs.access(outputFile),
                fs.access(nameFile),
                fs.access(trimFile)
            ]);

            const inputStat = statSync(inputFile);
            const outputStat = statSync(outputFile);
            const nameStat = statSync(nameFile);
            const trimStat = statSync(trimFile);

            const timestampsDiffer = [outputStat, nameStat, trimStat].some(
                stat => Math.abs(stat.mtimeMs - inputStat.mtimeMs) > 1000
            );

            return timestampsDiffer;
        } catch (err) {
            return true;
        }
    }

    async isFileReady(filePath) {
        try {
            // opening for write fails if the recorder still has it locked
            const fileHandle = await fs.open(filePath, 'r+');
            await fileHandle.close();

            // stable size over 1s means the write is done
            const size1 = (await fs.stat(filePath)).size;
            await new Promise(resolve => setTimeout(resolve, 1000));
            const size2 = (await fs.stat(filePath)).size;
            
            return size1 === size2;
        } catch (error) {
            return false;
        }
    }

    async processFile(inputFile) {
        try {
            if (!await this.shouldProcessFile(inputFile)) {
                this.log(`Skipping ${path.basename(inputFile)} (already processed)`);
                this.stats.skipped++;
                return;
              }

              if (!await this.isFileReady(inputFile)) {
                this.log(`File ${path.basename(inputFile)} is still being written, skipping...`);
                this.stats.skipped++;
                return;
              }
          
              this.log(`Processing ${path.basename(inputFile)}`);

            this.log('Analyzing metadata for:', inputFile);
            await this.getAllMetadata(inputFile);

            const metadata = await this.extractSteelSeriesMetadata(inputFile);
            if (!metadata) {
                this.log(`No SteelSeries metadata found in ${inputFile}`);
                this.stats.skipped++;
                return;
            }

            const fileName = path.basename(inputFile);
            const outputFile = path.join(this.exportFolder, fileName);
            const nameFile = path.join(this.metadataFolder, `${fileName}.customname`);
            const trimFile = path.join(this.metadataFolder, `${fileName}.trim`);
            const tagsFile = path.join(this.metadataFolder, `${fileName}.tags`);
            const dateFile = path.join(this.metadataFolder, `${fileName}.date`);

            const trimData = {
                start: Math.round(metadata.clip_start_point * 10) / 10,
                end: Math.round(metadata.clip_end_point * 10) / 10
            };

            if (await this.combineAudioAndCopy(inputFile, outputFile)) {
                await fs.writeFile(nameFile, metadata.name, 'utf8');
                await this.copyFileTimestamps(inputFile, nameFile);

                await fs.writeFile(trimFile, JSON.stringify(trimData, null, 2), 'utf8');
                await this.copyFileTimestamps(inputFile, trimFile);

                await fs.writeFile(tagsFile, JSON.stringify(["Imported"]), 'utf8');
                await this.copyFileTimestamps(inputFile, tagsFile);

                if (metadata.recording_timestamp) {
                    await fs.writeFile(dateFile, metadata.recording_timestamp, 'utf8');
                    await this.copyFileTimestamps(inputFile, dateFile);
                    this.log(`Timestamp: ${metadata.recording_timestamp}`);
                }

                this.log(`Processed ${fileName}`);
                this.log(`Name: ${metadata.name}`);
                this.log(`Trim: ${JSON.stringify(trimData)}`);
                this.log('---');
            } else {
                this.log(`Failed to process ${fileName}`);
                this.stats.failed++;
            }
        } catch (err) {
            this.log(`Error processing ${inputFile}: ${err.message}`);
            this.stats.failed++;
            // this.log only reaches a renderer IPC channel, never the log file
            telemetry.event('steelseries_import_failed', {
                kind: telemetry.KIND.ERROR,
                severity: telemetry.SEVERITY.ERROR,
                // no `error:`: fs messages here carry the clip's own filename
                context: { stage: 'process_file', errno: err?.code, error_name: err?.name }
            });
            return false;
        }
    }

    async processFolder() {
        try {
            await this.ensureFoldersExist();

            const files = await fs.readdir(this.inputFolder);
            const mp4Files = files.filter(file => file.toLowerCase().endsWith('.mp4'));

            if (mp4Files.length === 0) {
                this.log('No MP4 files found!');
                return;
            }

            let processed = 0;
            const total = mp4Files.length;
            this.stats.total = total;

            for (const file of mp4Files) {
                await this.processFile(path.join(this.inputFolder, file));
                processed++;
                if (this.progressCallback) {
                    this.progressCallback(processed, total);
                }
            }
        } catch (err) {
            this.log(`Error processing folder: ${err.message}`);
            throw err;
        }
    }
}

/**
 * @param {string} sourcePath
 * @param {Function} getSettings
 * @param {Function} getAppPath
 * @param {Object} eventSender
 * @returns {Promise<Object>}
 */
async function importSteelSeriesClips(sourcePath, getSettings, getAppPath, eventSender) {
  const startedAt = Date.now();
  let processor = null;

  const reportFinished = (errored) => {
    const stats = processor?.stats || { total: 0, failed: 0, skipped: 0 };
    telemetry.event('steelseries_import_finished', {
      kind: telemetry.KIND.CUSTOM,
      severity: telemetry.SEVERITY.INFO,
      context: {
        files_total: stats.total,
        files_failed: stats.failed,
        files_skipped: stats.skipped,
        duration_ms: Date.now() - startedAt,
        errored
      },
      coalesceMs: 0
    });
  };

  try {
    const settings = await getSettings();
    const clipLocation = settings.clipLocation;

    let globalTags = [];
    try {
      const tagsFilePath = path.join(getAppPath("userData"), "global_tags.json");
      try {
        const tagsData = await fs.readFile(tagsFilePath, "utf8");
        globalTags = JSON.parse(tagsData);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }

      if (!globalTags.includes("Imported")) {
        globalTags.push("Imported");
        await fs.writeFile(tagsFilePath, JSON.stringify(globalTags));
      }
    } catch (error) {
      logger.error("Error managing global tags:", error);
    }

    processor = new SteelSeriesProcessor(
      sourcePath,
      clipLocation,
      (current, total) => {
        if (eventSender && !eventSender.isDestroyed()) {
          eventSender.send('steelseries-progress', { current, total });
        }
      },
      (message) => {
        if (eventSender && !eventSender.isDestroyed()) {
          eventSender.send('steelseries-log', { type: 'info', message });
        }
      }
    );

    logActivity('import_start', { source: 'steelseries', sourcePath });

    await processor.processFolder();
    reportFinished(false);
    return { success: true };
  } catch (error) {
    logger.error('SteelSeries import error:', error);
    reportFinished(true);
    return { success: false, error: error.message };
  }
}

module.exports = SteelSeriesProcessor;
module.exports.importSteelSeriesClips = importSteelSeriesClips;
