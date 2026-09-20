import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

// Xcursor image chunks contain premultiplied ARGB and a per-image hotspot.
// https://xorg.freedesktop.org/archive/X11R6.9.0/doc/html/Xcursor.3.html
export function decodeCursor(bytes, size = 48) {
  const u32 = offset => bytes.readUInt32LE(offset);
  if (u32(0) !== 0x72756358) throw Error('not an Xcursor file');
  const entries = [];
  for (let i = 0; i < u32(12); i++) {
    const p = u32(4) + i * 12;
    if (u32(p) === 0xfffd0002) entries.push({ size: u32(p + 4), offset: u32(p + 8) });
  }
  entries.sort((a, b) => Math.abs(a.size - size) - Math.abs(b.size - size));
  if (!entries.length) throw Error('cursor has no images');
  const p = entries[0].offset;
  const width = u32(p + 16), height = u32(p + 20), hotX = u32(p + 24), hotY = u32(p + 28);
  if (width > 1024 || height > 1024 || !width || !height) throw Error('invalid cursor dimensions');
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const argb = u32(p + u32(p) + i * 4), a = argb >>> 24;
    rgba[i * 4] = a ? Math.min(255, Math.round(((argb >>> 16) & 255) * 255 / a)) : 0;
    rgba[i * 4 + 1] = a ? Math.min(255, Math.round(((argb >>> 8) & 255) * 255 / a)) : 0;
    rgba[i * 4 + 2] = a ? Math.min(255, Math.round((argb & 255) * 255 / a)) : 0;
    rgba[i * 4 + 3] = a;
  }
  return { width, height, hotX, hotY, rgba, nominalSize: entries[0].size };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function cursorPng({ width, height, rgba }) {
  const chunk = (type, data) => {
    const b = Buffer.concat([Buffer.from(type), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(b));
    return Buffer.concat([len, b, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
export async function importCursorTheme(themePath, out) {
  const cursors = {};
  await fs.mkdir(out, { recursive: true });
  for (const [name, file] of Object.entries({ arrow: 'left_ptr', pointer: 'pointer', text: 'text', grab: 'grab', grabbing: 'grabbing', resize: 'ew-resize' })) {
    const decoded = decodeCursor(await fs.readFile(path.join(themePath, 'cursors', file)), 48);
    const png = path.join(out, `${name}.png`);
    await fs.writeFile(png, cursorPng(decoded));
    const ratio = 36 / decoded.nominalSize;
    cursors[name] = { src: pathToFileURL(png).href, width: decoded.width * ratio, height: decoded.height * ratio, hotspot: [decoded.hotX * ratio, decoded.hotY * ratio] };
  }
  return { theme: path.basename(themePath), shapes: cursors };
}
