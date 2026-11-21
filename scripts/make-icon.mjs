#!/usr/bin/env node
// Renders the Stewie app icon with no dependencies: raw RGBA -> PNG -> .icns.
// Squircle badge, node-graph glyph, one green "done" node.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.build');
fs.mkdirSync(OUT, { recursive: true });

const SIZE = 1024;
const SS = 3; // supersamples per axis

// ---------------------------------------------------------------- shapes

const len = (x, y) => Math.hypot(x, y);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return len(px - cx, py - cy) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay || 1), 0, 1);
  return len(pax - bax * h, pay - bay * h);
}

// glyph geometry
const TL = { x: 306, y: 344 };
const TR = { x: 718, y: 344 };
const BT = { x: 512, y: 716 };
const EDGES = [
  [TL, TR],
  [TL, BT],
  [TR, BT],
];
const NODE_R = 78;
const EDGE_R = 22;

function shade(px, py) {
  // returns [r,g,b,a] 0..255
  const bgSd = sdRoundRect(px, py, 512, 512, 452, 452, 214);
  const bgCov = clamp(0.5 - bgSd, 0, 1);
  if (bgCov <= 0) return [0, 0, 0, 0];

  // violet gradient with a warm top-left lift
  const t = clamp((py - 60) / 904, 0, 1);
  let r = mix(139, 91, t);
  let g = mix(102, 58, t);
  let b = mix(255, 232, t);
  const lift = clamp(1 - len(px - 330, py - 250) / 900, 0, 1) * 0.16;
  r = mix(r, 255, lift);
  g = mix(g, 255, lift);
  b = mix(b, 255, lift);

  let cr = r;
  let cg = g;
  let cb = b;
  const paint = (col, cov) => {
    if (cov <= 0) return;
    cr = mix(cr, col[0], cov);
    cg = mix(cg, col[1], cov);
    cb = mix(cb, col[2], cov);
  };

  // connecting edges
  let edgeCov = 0;
  for (const [a, b] of EDGES) {
    edgeCov = Math.max(edgeCov, clamp(0.5 - (sdSegment(px, py, a.x, a.y, b.x, b.y) - EDGE_R), 0, 1));
  }
  paint([255, 255, 255], edgeCov * 0.55);

  // nodes: white, white, white halo + green
  for (const n of [TL, TR]) {
    paint([255, 255, 255], clamp(0.5 - sdCircle(px, py, n.x, n.y, NODE_R), 0, 1));
  }
  paint([255, 255, 255], clamp(0.5 - sdCircle(px, py, BT.x, BT.y, NODE_R + 18), 0, 1));
  paint([74, 222, 128], clamp(0.5 - sdCircle(px, py, BT.x, BT.y, NODE_R), 0, 1));

  return [Math.round(cr), Math.round(cg), Math.round(cb), Math.round(bgCov * 255)];
}

// ---------------------------------------------------------------- render

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = size / SIZE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / scale;
          const py = (y + (sy + 0.5) / SS) / scale;
          const [cr, cg, cb, ca] = shade(px, py);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const n = SS * SS;
      const aa = a / n;
      const i = (y * size + x) * 4;
      if (aa > 0) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
        buf[i + 3] = Math.round(aa);
      }
    }
  }
  return buf;
}

// ---------------------------------------------------------------- png

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- iconset

const master = path.join(OUT, 'icon-1024.png');
fs.writeFileSync(master, png(SIZE, render(SIZE)));
console.log('wrote', path.relative(ROOT, master));

const iconset = path.join(OUT, 'AppIcon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });

const sizes = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];
for (const [size, name] of sizes) {
  fs.writeFileSync(path.join(iconset, name), png(size, render(size)));
}

const icns = path.join(OUT, 'AppIcon.icns');
try {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  console.log('wrote', path.relative(ROOT, icns), '(iconutil)');
} catch {
  execFileSync('sips', ['-s', 'format', 'icns', master, '--out', icns]);
  console.log('wrote', path.relative(ROOT, icns), '(sips fallback)');
}
