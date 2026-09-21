const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const resourcesDir = process.resourcesPath && path.join(process.resourcesPath, 'ffmpeg');
const isBundled = Boolean(resourcesDir && fs.existsSync(path.join(resourcesDir, 'ffmpeg.exe')));
// a separate process can benchmark another binary pair without changing the installed cache.
const ffmpegDir = process.env?.CLIPLIB_FFMPEG_DIR || (isBundled ? resourcesDir : path.join(__dirname, '..', 'vendor', 'ffmpeg'));
const ffmpegPath = path.join(ffmpegDir, 'ffmpeg.exe');
const ffprobePath = path.join(ffmpegDir, 'ffprobe.exe');

async function verify() {
  for (const file of [ffmpegPath, ffprobePath]) {
    if (!fs.existsSync(file)) throw new Error(`Missing ${file}; run npm run fetch-ffmpeg`);
  }
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-version'], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) return reject(new Error(`Cannot run ${ffmpegPath}: ${error.message}; run npm run fetch-ffmpeg`));
      resolve(stdout.split(/\r?\n/)[0]);
    });
  });
}

module.exports = { ffmpegPath, ffprobePath, ffmpegDir, isBundled, verify };
