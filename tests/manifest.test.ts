/**
 * manifest.test.ts — the home-screen install contract.
 *
 * Every assertion here is something that fails SILENTLY in the browser: a
 * manifest with a typo, or an icon whose declared size is a lie, just quietly
 * gives the player a blank/cropped tile on their home screen with no error
 * anywhere. So the sizes are read out of each PNG's IHDR rather than trusted
 * from the filename or the manifest, and the paths are checked to be relative —
 * this game is served from a project subpath in dev and a custom domain root in
 * prod, and a leading slash only resolves in the second.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: Icon[];
}

const manifest = (): Manifest =>
  JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as Manifest;

/** Read a real PNG's dimensions + colour type straight out of its IHDR. */
function ihdr(file: string): { width: number; height: number; colorType: number } {
  const buf = readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...buf.subarray(0, 8)]).toEqual(sig);
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25],
  };
}

/** Every RGBA pixel's alpha — iOS composites a transparent icon onto black. */
function minAlpha(file: string): number {
  const buf = readFileSync(file);
  // Only our own encoder's output is inspected, and it writes filter-0 rows.
  const { width, height } = ihdr(file);
  // Concatenate every IDAT before inflating: a large PNG is split across chunks.
  let pos = 8;
  const parts: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    if (type === 'IDAT') parts.push(buf.subarray(pos + 8, pos + 8 + len));
    pos += len + 12;
  }
  const raw = inflateSync(Buffer.concat(parts));
  let min = 255;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1) + 1;
    for (let x = 0; x < width; x++) min = Math.min(min, raw[row + x * 4 + 3]);
  }
  return min;
}

describe('manifest.webmanifest', () => {
  it('parses and declares everything an install prompt needs', () => {
    const m = manifest();
    expect(m.name).toBe('Snake Royale');
    expect(m.short_name.length).toBeGreaterThan(0);
    // Android's install prompt silently withholds itself if short_name is long.
    expect(m.short_name.length).toBeLessThanOrEqual(12);
    expect(m.display).toBe('standalone');
    expect(m.orientation).toBe('portrait');
    // The splash screen is painted from these before a single pixel of ours is.
    expect(m.background_color).toBe('#0b0e14');
    expect(m.theme_color).toBe('#0b0e14');
    expect(m.icons.length).toBeGreaterThanOrEqual(3);
  });

  it('uses relative paths, so it resolves on a subpath AND at a domain root', () => {
    const m = manifest();
    expect(m.start_url).toBe('./');
    expect(m.scope).toBe('./');
    for (const icon of m.icons) expect(icon.src.startsWith('./')).toBe(true);
  });

  it('every icon it references exists, at the size it claims', () => {
    const m = manifest();
    for (const icon of m.icons) {
      const [w, h] = icon.sizes.split('x').map(Number);
      const info = ihdr(join(PUBLIC, icon.src.replace('./', '')));
      expect([icon.src, info.width, info.height]).toEqual([icon.src, w, h]);
      expect(icon.type).toBe('image/png');
    }
  });

  it('ships a 512 maskable icon — Android crops the others to its own mask', () => {
    const maskable = manifest().icons.filter((i) => i.purpose === 'maskable');
    expect(maskable).toHaveLength(1);
    expect(maskable[0].sizes).toBe('512x512');
  });
});

describe('iOS icons — the manifest does not reach them', () => {
  it('has a 180x180 apple-touch-icon', () => {
    const info = ihdr(join(PUBLIC, 'apple-touch-icon.png'));
    expect([info.width, info.height]).toEqual([180, 180]);
  });

  it('the apple-touch-icon is fully opaque', () => {
    // iOS does not honour alpha: it composites onto BLACK, so a transparent
    // icon gets black corners baked around the mark on the home screen.
    expect(minAlpha(join(PUBLIC, 'apple-touch-icon.png'))).toBe(255);
  });
});

describe('index.html head', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

  it('links the manifest and the full iOS set', () => {
    expect(html).toContain('<link rel="manifest" href="./manifest.webmanifest" />');
    expect(html).toContain('<meta name="theme-color" content="#0b0e14" />');
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="./apple-touch-icon.png"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="black-translucent"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Snake Royale"');
  });

  it('registers no service worker', () => {
    // Deliberate: the bundle is self-contained, and a stale SW cache would serve
    // players an old build after every deploy.
    expect(html).not.toContain('serviceWorker');
  });
});
