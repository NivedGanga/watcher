// Generates the placeholder app icons (solid brand color with a simple
// border) as valid PNGs. Run with `npm run icons` if the icons need to be
// regenerated. These are placeholders until real artwork is made — see
// NOTES.md.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public/icons');
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 8 + data.length);
  return out;
}

function png(size, fill, border) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  const bw = Math.max(2, Math.floor(size / 16));
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const onBorder = x < bw || y < bw || x >= size - bw || y >= size - bw;
      const c = onBorder ? border : fill;
      const o = y * stride + 1 + x * 3;
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const FILL = [0x1a, 0x23, 0x32]; // #1a2332
const BORDER = [0x4f, 0xa3, 0xff]; // accent

writeFileSync(join(outDir, 'icon-192.png'), png(192, FILL, BORDER));
writeFileSync(join(outDir, 'icon-512.png'), png(512, FILL, BORDER));
// Maskable: full-bleed fill, no border (safe zone handled by the mask).
writeFileSync(join(outDir, 'icon-maskable-512.png'), png(512, FILL, FILL));
console.log('wrote icons to public/icons/');
