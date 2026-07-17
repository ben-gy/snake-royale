/**
 * gen-icons.mjs — rasterise the Snake Royale mark (public/favicon.svg) into the
 * PNGs a home-screen install needs. Run: `node scripts/gen-icons.mjs`.
 *
 * There is no sharp/resvg in this project and adding one for four static files
 * is not worth it, so this walks the SAME geometry as favicon.svg (the rounded
 * tile, the snaking stroke, the head, the gold pellet) and writes real PNGs via
 * node's zlib. Nothing here invents a new look: change the SVG and change the
 * constants below together.
 *
 * The three variants exist because the platforms disagree:
 *  - 192/512 plain: the favicon tile, rounded corners, transparent outside.
 *  - 512 maskable: Android crops every icon to ITS mask (circle, squircle, …).
 *    A non-maskable icon gets its corners eaten, so this one is full-bleed with
 *    the art pulled inside the 80%-diameter safe circle the spec guarantees.
 *  - 180 apple-touch: iOS ignores the manifest entirely, applies its own mask,
 *    and composites any transparency onto BLACK — so this one is fully opaque.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Palette — must match public/favicon.svg and src/styles/main.css.
const BG = [0x0b, 0x0e, 0x14];
const BODY = [0x00, 0x9e, 0x73];
const HEAD = [0x34, 0xd3, 0x9a];
const PELLET = [0xf0, 0xc4, 0x20];

/** The mark is authored in a 32×32 box, exactly like the SVG's viewBox. */
const BOX = 32;

// ── geometry ────────────────────────────────────────────────────────────────
// favicon.svg's path: M7 23 h6 a3 3 0 0 0 3-3 v-8 a3 3 0 0 1 3-3 h4
// Arcs are sampled into the polyline rather than solved: the stroke is drawn as
// a union of capsules, so more points is simply a smoother curve.

function arc(cx, cy, r, fromDeg, toDeg, steps = 24) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

const SNAKE_PATH = [
  [7, 23],
  [13, 23],
  ...arc(13, 20, 3, 90, 0), // the a3 3 0 0 0 3-3 corner
  [16, 12],
  ...arc(19, 12, 3, 180, 270), // the a3 3 0 0 1 3-3 corner
  [23, 9],
];
const STROKE = 4.5;

/** Distance from p to segment ab — the capsule primitive the stroke is made of. */
function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.hypot(dx, dy);
}

const inStroke = (x, y) => {
  for (let i = 0; i < SNAKE_PATH.length - 1; i++) {
    const [ax, ay] = SNAKE_PATH[i];
    const [bx, by] = SNAKE_PATH[i + 1];
    if (distSeg(x, y, ax, ay, bx, by) <= STROKE / 2) return true;
  }
  return false;
};

const inCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) <= r;

/** Rounded rect, rx=7 — the tile from the SVG. */
const inTile = (x, y) => {
  const r = 7;
  if (x < 0 || y < 0 || x > BOX || y > BOX) return false;
  const qx = Math.abs(x - BOX / 2) - (BOX / 2 - r);
  const qy = Math.abs(y - BOX / 2) - (BOX / 2 - r);
  if (qx <= 0 || qy <= 0) return true;
  return Math.hypot(qx, qy) <= r;
};

/**
 * Colour of the mark at a point in 32-space, painter's order, or null for the
 * transparent outside. `base` is the background already decided by the caller —
 * null outside the rounded tile, BG everywhere for a full-bleed icon.
 */
function sample(x, y, base) {
  let c = base;
  if (inCircle(x, y, 9, 9, 2.6)) c = PELLET;
  if (inStroke(x, y)) c = BODY;
  if (inCircle(x, y, 26, 9, 3.4)) c = HEAD;
  if (inCircle(x, y, 27.1, 8, 0.9)) c = BG; // the eye
  return c;
}

// ── raster ──────────────────────────────────────────────────────────────────

/**
 * @param size   pixel size
 * @param artScale  how much of the box the artwork occupies (maskable safe zone)
 * @param tile   draw the rounded tile (else full-bleed background)
 * @param opaque force alpha 255 everywhere — iOS composites transparency on black
 */
function raster(size, { artScale = 1, tile = true, opaque = false } = {}) {
  // Full-bleed icons scale the ARTWORK inside a background that still covers
  // every pixel. Scaling the background too is how a maskable icon ends up with
  // transparent margins — exactly the corners the platform mask would eat.
  const SS = 4; // 4×4 supersampling — the only anti-aliasing we get
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Pixel centre → box space, with the art scaled about the centre.
          const fx = (x + (sx + 0.5) / SS) / size;
          const fy = (y + (sy + 0.5) / SS) / size;
          const u = (fx - 0.5) / artScale + 0.5;
          const v = (fy - 0.5) / artScale + 0.5;
          const base = tile ? (inTile(fx * BOX, fy * BOX) ? BG : null) : BG;
          const c = sample(u * BOX, v * BOX, base);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      // Un-premultiply so edge pixels keep the mark's colour rather than fading
      // to black, which is what a naive average produces against a 0,0,0,0 base.
      const cov = a / n;
      px[i] = cov > 0 ? Math.round(r / (a / 255)) : 0;
      px[i + 1] = cov > 0 ? Math.round(g / (a / 255)) : 0;
      px[i + 2] = cov > 0 ? Math.round(b / (a / 255)) : 0;
      px[i + 3] = opaque ? 255 : Math.round(cov);
      if (opaque && cov < 255) {
        // Composite the partial edges onto the background instead of black.
        const k = cov / 255;
        px[i] = Math.round(px[i] * k + BG[0] * (1 - k));
        px[i + 1] = Math.round(px[i + 1] * k + BG[1] * (1 - k));
        px[i + 2] = Math.round(px[i + 2] * k + BG[2] * (1 - k));
      }
    }
  }
  return px;
}

// ── PNG encoder ─────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  // 10..12: deflate / adaptive filtering / no interlace — all zero.

  // Filter type 0 (None) on every scanline; the encoder's job here is honesty,
  // not ratio.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── write ───────────────────────────────────────────────────────────────────

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  // Art at 62% keeps every pixel of the mark inside the 80%-diameter circle
  // Android promises not to crop.
  ['icon-512-maskable.png', 512, { artScale: 0.62, tile: false }],
  ['apple-touch-icon.png', 180, { artScale: 0.84, tile: false, opaque: true }],
];

for (const [name, size, opts] of targets) {
  const file = join(OUT, name);
  writeFileSync(file, png(size, raster(size, opts)));
  console.log(`wrote public/${name} (${size}×${size})`);
}
