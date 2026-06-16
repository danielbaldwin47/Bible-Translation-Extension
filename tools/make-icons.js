#!/usr/bin/env node
/*
 * Generates simple placeholder PNG icons (a teal tile with an open-book glyph)
 * at the sizes the manifest needs, using only Node's built-in zlib. Re-run with:
 *   node tools/make-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(__dirname, '..', 'icons');
const SIZES = [16, 32, 48, 128];

// Palette (RGBA).
const BG = [0, 97, 132, 255];      // teal accent
const PAGE = [245, 245, 245, 255]; // off-white page
const LINE = [180, 200, 210, 255]; // faint text line
const TRANSPARENT = [0, 0, 0, 0];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y, size);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Draw a rounded teal tile with a centered open book.
function pixel(x, y, size) {
  const u = x / size, v = y / size;
  // Rounded-rect mask for the tile.
  const m = 0.08, r = 0.14;
  const inX = u > m && u < 1 - m, inY = v > m && v < 1 - m;
  if (!inX || !inY) {
    // corner rounding
    const corners = [[m + r, m + r], [1 - m - r, m + r], [m + r, 1 - m - r], [1 - m - r, 1 - m - r]];
    let nearCorner = false;
    for (const [cx, cy] of corners) {
      const near = (u < m + r || u > 1 - m - r) && (v < m + r || v > 1 - m - r);
      if (near && Math.hypot(u - cx, v - cy) <= r && u > m - 0.001 && u < 1 - m + 0.001 && v > m - 0.001 && v < 1 - m + 0.001) {
        nearCorner = true; break;
      }
    }
    if (!nearCorner) return TRANSPARENT;
  }

  // Book pages: two white panels with a teal gutter down the middle.
  const px0 = 0.22, px1 = 0.78, py0 = 0.30, py1 = 0.72;
  if (u > px0 && u < px1 && v > py0 && v < py1) {
    const gutter = Math.abs(u - 0.5) < 0.018;
    if (gutter) return BG;
    // faint horizontal text lines
    const rel = (v - py0) / (py1 - py0);
    const onLine = [0.25, 0.5, 0.75].some((ly) => Math.abs(rel - ly) < 0.05);
    const inText = (u > px0 + 0.04 && u < 0.47) || (u > 0.53 && u < px1 - 0.04);
    if (onLine && inText) return LINE;
    return PAGE;
  }
  return BG;
}

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, pixel);
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), png);
  console.log(`wrote icons/icon-${size}.png (${png.length} bytes)`);
}
