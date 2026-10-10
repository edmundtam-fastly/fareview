// Draws the app icon (three quote rows, the cheapest in green) as PNGs with
// no dependencies. Run: npm run icons
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const BG_TOP = hex('#16213a');
const BG_BOT = hex('#0b1020');
const GREEN = hex('#3ddc84');
const WHITE = [255, 255, 255];

// Shapes in unit coordinates (0..1). Each returns coverage-free inside test.
function roundRect(x, y, w, h, r) {
  return (px, py) => {
    const cx = Math.min(Math.max(px, x + r), x + w - r);
    const cy = Math.min(Math.max(py, y + r), y + h - r);
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r && px >= x && px <= x + w && py >= y && py <= y + h;
  };
}
const rows = [
  { y: 0.285, len: 0.34, color: GREEN, alpha: 1 },
  { y: 0.47, len: 0.5, color: WHITE, alpha: 0.42 },
  { y: 0.655, len: 0.42, color: WHITE, alpha: 0.42 },
];
const shapes = rows.flatMap((r) => [
  { test: roundRect(0.2, r.y - 0.055, 0.11, 0.11, 0.03), color: r.color, alpha: r.alpha },
  { test: roundRect(0.36, r.y - 0.04, r.len, 0.08, 0.04), color: r.color, alpha: r.alpha },
]);

function draw(size) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          let c = BG_TOP.map((t, i) => t + (BG_BOT[i] - t) * v);
          for (const s of shapes) if (s.test(u, v)) c = c.map((t, i) => t + (s.color[i] - t) * s.alpha);
          acc = acc.map((a, i) => a + c[i]);
        }
      }
      const o = (y * size + x) * 4;
      buf[o] = acc[0] / (SS * SS);
      buf[o + 1] = acc[1] / (SS * SS);
      buf[o + 2] = acc[2] / (SS * SS);
      buf[o + 3] = 255;
    }
  }
  return png(size, buf);
}

for (const [name, size] of [['apple-touch-icon', 180], ['icon-192', 192], ['icon-512', 512]]) {
  writeFileSync(new URL(`../public/icons/${name}.png`, import.meta.url), draw(size));
  console.log(`wrote ${name}.png`);
}
