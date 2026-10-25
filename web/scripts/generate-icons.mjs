// Generates the app icons by rasterizing the AgentWatch mark
// (public/icons/logo.svg) with signed-distance functions and 4x
// supersampling. Run with `npm run icons` to regenerate. Zero deps.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public/icons');
mkdirSync(outDir, { recursive: true });

// ---------- PNG encoder (RGBA) ----------

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

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolor RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- The mark (mirrors logo.svg, 512x512 logo space) ----------

const BG = [0x1a, 0x23, 0x32];
const INK = [0xe8, 0xed, 0xf5];
const ACCENT = [0x4f, 0xa3, 0xff];

const C = 256;
const LENS_R = 170; // eye outline: intersection of two circles
const LENS_D = 110; // circle centers at (256, 256±LENS_D)
const LENS_W = 22; // stroke width
const IRIS_R = 58;
const IRIS_W = 18;
const PUPIL_R = 26;
const ARC_W = 16;
const ARCS = [
  { r: 110, alpha: 1 },
  { r: 145, alpha: 0.65 },
];
const ARC_A0 = (-80 * Math.PI) / 180; // radiate upper-right from the pupil
const ARC_A1 = (-20 * Math.PI) / 180;

const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);

function arcDist(x, y, r) {
  const d = Math.abs(dist(x, y, C, C) - r) - ARC_W / 2;
  const a = Math.atan2(y - C, x - C);
  if (a >= ARC_A0 && a <= ARC_A1) return d;
  // round caps: distance to the nearer arc endpoint
  return Math.min(
    dist(x, y, C + r * Math.cos(ARC_A0), C + r * Math.sin(ARC_A0)),
    dist(x, y, C + r * Math.cos(ARC_A1), C + r * Math.sin(ARC_A1)),
  ) - ARC_W / 2;
}

// Returns [r,g,b,a] for a sample point in logo space.
function sample(x, y) {
  let r = BG[0], g = BG[1], b = BG[2], a = 255;
  const over = (rgb, alpha) => {
    r = rgb[0] * alpha + r * (1 - alpha);
    g = rgb[1] * alpha + g * (1 - alpha);
    b = rgb[2] * alpha + b * (1 - alpha);
  };

  // eye outline
  const lens =
    Math.max(dist(x, y, C, C + LENS_D) - LENS_R, dist(x, y, C, C - LENS_D) - LENS_R);
  if (Math.abs(lens) <= LENS_W / 2) over(INK, 1);

  // iris ring
  if (Math.abs(dist(x, y, C, C) - IRIS_R) <= IRIS_W / 2) over(ACCENT, 1);

  // pupil
  if (dist(x, y, C, C) <= PUPIL_R) over(ACCENT, 1);

  // broadcast arcs
  for (const arc of ARCS) {
    if (arcDist(x, y, arc.r) <= 0) over(ACCENT, arc.alpha);
  }
  return [r, g, b, a];
}

// markScale < 1 shrinks the mark into the maskable safe zone.
function render(size, markScale = 1) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const lx = ((x + (sx + 0.5) / SS) / size - 0.5) / markScale + 0.5;
          const ly = ((y + (sy + 0.5) / SS) / size - 0.5) / markScale + 0.5;
          const s = sample(lx * 512, ly * 512);
          r += s[0]; g += s[1]; b += s[2]; a += s[3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      px[o] = r / n;
      px[o + 1] = g / n;
      px[o + 2] = b / n;
      px[o + 3] = a / n;
    }
  }
  return encodePng(size, px);
}

writeFileSync(join(outDir, 'icon-192.png'), render(192));
writeFileSync(join(outDir, 'icon-512.png'), render(512));
// Maskable: keep the mark inside the ~80% safe zone.
writeFileSync(join(outDir, 'icon-maskable-512.png'), render(512, 0.8));
console.log('wrote icons to public/icons/');
