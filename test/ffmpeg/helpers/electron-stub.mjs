import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cliplib-ffmpeg-profile-'));
const buffers = new Map();
let text = '';
export const electron = {
  app: { isPackaged: false, isReady: () => true, getPath: () => profile, getVersion: () => '0.0.0-test' },
  clipboard: {
    writeBuffer: (name, value) => buffers.set(name, Buffer.from(value)),
    readBuffer: name => buffers.get(name) || Buffer.alloc(0),
    writeText: value => { text = value; },
    readText: () => text
  },
  ipcMain: { on() {}, handle() {} },
  BrowserWindow: { getAllWindows: () => [] }
};
const load = Module._load;
Module._load = function (name, ...args) {
  return name === 'electron' ? electron : load.call(this, name, ...args);
};
export const require = createRequire(import.meta.url);
// routine application logs would obscure the benchmark table.
const logger = require('../../../utils/logger');
for (const level of ['info', 'debug', 'warn']) logger[level] = () => {};
process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true }));
