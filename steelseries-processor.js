const { promises: fs, statSync } = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class SteelSeriesProcessor {
    constructor(inputFolder, exportFolder, progressCallback, logCallback) {
        this.inputFolder = inputFolder;
        this.exportFolder = exportFolder;
        this.metadataFolder = path.join(exportFolder, '.clip_metadata');
        this.progressCallback = progressCallback;
        this.logCallback = logCallback;
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
                    
                    // Combine all STEELSERIES_META tags
                    let fullMeta = '';
                    const metaKeys = Object.keys(tags).filter(key => key.startsWith('STEELSERIES_META'));
                    metaKeys.sort(); // Ensure correct order (0000, 0001, etc.)
                    
                    for (const key of metaKeys) {
                        fullMeta += tags[key];
                    }

                    try {
                        // Parse the combined JSON
                        const metadata = JSON.parse(fullMeta);
                        resolve({
                            name: metadata.name,
                            clip_start_point: metadata.clip_start_point,
                            clip_end_point: metadata.clip_end_point
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

            ffprobe.on('error', reject);
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
                // For multiple audio streams, mix them together
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
                    resolve(false);
                }
            });

            ffmpeg.on('error', (err) => {
                console.error('FFmpeg process error:', err);
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
            // Check if all files exist
            await Promise.all([
                fs.access(outputFile),
                fs.access(nameFile),
                fs.access(trimFile)
            ]);

            // Compare timestamps
            const inputStat = statSync(inputFile);
            const outputStat = statSync(outputFile);
            const nameStat = statSync(nameFile);
            const trimStat = statSync(trimFile);

            // Check if any timestamps don't match
            const timestampsDiffer = [outputStat, nameStat, trimStat].some(
                stat => Math.abs(stat.mtimeMs - inputStat.mtimeMs) > 1000
            );

            return timestampsDiffer;
        } catch (err) {
            // If any file doesn't exist or there's an error, we should process
            return true;
        }
    }

    async processFile(inputFile) {
        try {
            if (!await this.shouldProcessFile(inputFile)) {
                this.log(`Skipping ${path.basename(inputFile)} (already processed)`);
                return;
            }

            this.log(`Processing ${path.basename(inputFile)}`);

            // Debug: First print all metadata
            this.log('Analyzing metadata for:', inputFile);
            await this.getAllMetadata(inputFile);

            const metadata = await this.extractSteelSeriesMetadata(inputFile);
            if (!metadata) {
                this.log(`No SteelSeries metadata found in ${inputFile}`);
                return;
            }

            const fileName = path.basename(inputFile);
            const outputFile = path.join(this.exportFolder, fileName);
            const nameFile = path.join(this.metadataFolder, `${fileName}.customname`);
            const trimFile = path.join(this.metadataFolder, `${fileName}.trim`);

            const trimData = {
                start: Math.round(metadata.clip_start_point * 10) / 10,
                end: Math.round(metadata.clip_end_point * 10) / 10
            };

            if (await this.combineAudioAndCopy(inputFile, outputFile)) {
                // Save metadata files
                await fs.writeFile(nameFile, metadata.name, 'utf8');
                await this.copyFileTimestamps(inputFile, nameFile);

                await fs.writeFile(trimFile, JSON.stringify(trimData, null, 2), 'utf8');
                await this.copyFileTimestamps(inputFile, trimFile);

                this.log(`Processed ${fileName}`);
                this.log(`Name: ${metadata.name}`);
                this.log(`Trim: ${JSON.stringify(trimData)}`);
                this.log('---');
            } else {
                this.log(`Failed to process ${fileName}`);
            }
        } catch (err) {
            this.log(`Error processing ${inputFile}: ${err.message}`);
            throw err;
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

module.exports = SteelSeriesProcessor;