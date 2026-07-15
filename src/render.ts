/**
 * render.ts — Canvas 2D renderer for Snake Royale. Draws the arena, snakes
 * (smoothly interpolated between the discrete grid ticks via the rAF alpha),
 * pellets, particles and screen shake. Pure presentation — it never mutates
 * game state. Respects prefers-reduced-motion (no shake, fewer particles).
 */

import type { Cell, Dir, RoyaleState } from './game';

/** Okabe–Ito colour-blind-safe palette, one hue per seat (up to 6). */
export const SNAKE_COLORS = [
  '#0072B2', // blue
  '#D55E00', // vermillion
  '#009E73', // bluish green
  '#E69F00', // orange
  '#56B4E9', // sky
  '#CC79A7', // reddish purple
];
export const FOOD_COLOR = '#F0C420';

// Distinct head glyphs give a second, non-colour cue (colour-blind aid).
const HEAD_GLYPH = ['●', '▲', '■', '◆', '★', '✚'];

function lighten(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  r = Math.round(r + (255 - r) * amt);
  g = Math.round(g + (255 - g) * amt);
  b = Math.round(b + (255 - b) * amt);
  return `rgb(${r},${g},${b})`;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}

const DIR_VEC: Record<Dir, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export class CanvasView {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cssSize = 0;
  private cell = 0;
  private ox = 0;
  private oy = 0;

  private cur: RoyaleState | null = null;
  private prevBodies = new Map<number, Cell[]>();
  private lastUpdate = 0;
  private tickMs = 110;

  private particles: Particle[] = [];
  private shakeAmt = 0;
  private reduced = false;
  private ro: ResizeObserver | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    opts?: { tickMs?: number; reducedMotion?: boolean },
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.tickMs = opts?.tickMs ?? 110;
    this.reduced = opts?.reducedMotion ?? false;
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas.parentElement ?? canvas);
    }
  }

  setTickMs(ms: number): void {
    this.tickMs = ms;
  }
  setReducedMotion(r: boolean): void {
    this.reduced = r;
  }

  resize(): void {
    const parent = this.canvas.parentElement ?? this.canvas;
    const rect = parent.getBoundingClientRect();
    const size = Math.max(120, Math.min(rect.width, rect.height));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cssSize = size;
    this.canvas.width = Math.round(size * this.dpr);
    this.canvas.height = Math.round(size * this.dpr);
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    if (this.cur) this.layout(this.cur.grid);
  }

  private layout(grid: number): void {
    const pad = Math.round(this.cssSize * 0.02);
    this.cell = (this.cssSize - pad * 2) / grid;
    this.ox = pad;
    this.oy = pad;
  }

  /** Feed a new authoritative/simulated state (once per game tick). */
  push(state: RoyaleState): void {
    // Snapshot current bodies to interpolate from.
    this.prevBodies.clear();
    if (this.cur) {
      for (const s of this.cur.snakes) this.prevBodies.set(s.id, s.body.map((c) => ({ ...c })));
    }
    this.cur = state;
    this.layout(state.grid);
    this.lastUpdate = performance.now();
  }

  /** Reset interpolation baseline (e.g. after a countdown, no motion yet). */
  resync(state: RoyaleState): void {
    this.cur = state;
    this.prevBodies.clear();
    this.layout(state.grid);
    this.lastUpdate = performance.now();
  }

  burstAt(cell: Cell, color: string, n = 10): void {
    const cx = this.ox + (cell.x + 0.5) * this.cell;
    const cy = this.oy + (cell.y + 0.5) * this.cell;
    const count = this.reduced ? Math.ceil(n / 3) : n;
    for (let i = 0; i < count; i++) {
      const a = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const sp = 40 + Math.random() * 120;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0,
        max: 0.4 + Math.random() * 0.4,
        color,
        size: this.cell * (0.14 + Math.random() * 0.12),
      });
    }
  }

  burstBody(body: Cell[], color: string): void {
    for (let i = 0; i < body.length; i += this.reduced ? 3 : 1) {
      this.burstAt(body[i], color, this.reduced ? 3 : 6);
    }
  }

  shake(amt: number): void {
    if (this.reduced) return;
    this.shakeAmt = Math.min(16, this.shakeAmt + amt);
  }

  render(now: number, dt: number): void {
    const ctx = this.ctx;
    const state = this.cur;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.cssSize, this.cssSize);

    // Shake offset.
    let sx = 0;
    let sy = 0;
    if (this.shakeAmt > 0.1) {
      sx = (Math.random() * 2 - 1) * this.shakeAmt;
      sy = (Math.random() * 2 - 1) * this.shakeAmt;
      this.shakeAmt *= Math.pow(0.001, dt); // fast decay
    } else {
      this.shakeAmt = 0;
    }
    ctx.translate(sx, sy);

    if (state) {
      this.drawArena(ctx, state, now);
      const alpha = Math.max(0, Math.min(1, (now - this.lastUpdate) / this.tickMs));
      for (const f of state.food) this.drawFood(ctx, f, now);
      for (const s of state.snakes) {
        if (!s.alive) continue;
        this.drawSnake(ctx, s.id, s.body, s.dir, SNAKE_COLORS[s.color % 6], alpha);
      }
    }

    // Particles.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.max) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.pow(0.02, dt);
      p.vy *= Math.pow(0.02, dt);
      const t = 1 - p.life / p.max;
      ctx.globalAlpha = t;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * t, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private drawArena(ctx: CanvasRenderingContext2D, state: RoyaleState, now: number): void {
    const size = this.cssSize;
    // Backdrop.
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, size, size);
    // Grid lines.
    ctx.strokeStyle = 'rgba(120,150,190,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= state.grid; i++) {
      const x = this.ox + i * this.cell;
      const y = this.oy + i * this.cell;
      ctx.moveTo(x, this.oy);
      ctx.lineTo(x, this.oy + state.grid * this.cell);
      ctx.moveTo(this.ox, y);
      ctx.lineTo(this.ox + state.grid * this.cell, y);
    }
    ctx.stroke();
    // Border glow (pulses subtly).
    const pulse = 0.5 + 0.5 * Math.sin(now / 700);
    ctx.strokeStyle = `rgba(90,180,230,${0.35 + pulse * 0.25})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(this.ox, this.oy, state.grid * this.cell, state.grid * this.cell);
  }

  private drawFood(ctx: CanvasRenderingContext2D, f: Cell, now: number): void {
    const cx = this.ox + (f.x + 0.5) * this.cell;
    const cy = this.oy + (f.y + 0.5) * this.cell;
    const pulse = 0.5 + 0.5 * Math.sin(now / 260 + (f.x + f.y));
    const r = this.cell * (0.24 + pulse * 0.07);
    ctx.save();
    ctx.shadowColor = FOOD_COLOR;
    ctx.shadowBlur = this.cell * 0.6;
    ctx.fillStyle = FOOD_COLOR;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawSnake(
    ctx: CanvasRenderingContext2D,
    id: number,
    body: Cell[],
    dir: Dir,
    color: string,
    alpha: number,
  ): void {
    const prev = this.prevBodies.get(id);
    const pts: { x: number; y: number }[] = body.map((c, i) => {
      const from = prev && prev[i] ? prev[i] : c;
      return {
        x: this.ox + (lerp(from.x, c.x, alpha) + 0.5) * this.cell,
        y: this.oy + (lerp(from.y, c.y, alpha) + 0.5) * this.cell,
      };
    });
    const w = this.cell * 0.78;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = this.cell * 0.35;
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (pts.length === 1) {
      ctx.arc(pts[0].x, pts[0].y, w / 2, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.restore();

    // Head cap + eyes.
    const head = pts[0];
    const hr = w / 2;
    ctx.fillStyle = lighten(color, 0.28);
    ctx.beginPath();
    ctx.arc(head.x, head.y, hr, 0, Math.PI * 2);
    ctx.fill();

    // Eyes look toward the heading.
    const dv = DIR_VEC[dir];
    const perp = { x: -dv.y, y: dv.x };
    const eo = hr * 0.42;
    const ef = hr * 0.5;
    for (const s of [-1, 1]) {
      const ex = head.x + dv.x * ef + perp.x * eo * s;
      const ey = head.y + dv.y * ef + perp.y * eo * s;
      ctx.fillStyle = '#0b0e14';
      ctx.beginPath();
      ctx.arc(ex, ey, hr * 0.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Colour-blind glyph on the tail cell.
    if (pts.length > 1) {
      const tail = pts[pts.length - 1];
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = `${Math.round(this.cell * 0.5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(HEAD_GLYPH[id % 6], tail.x, tail.y + this.cell * 0.02);
    }
  }

  destroy(): void {
    this.ro?.disconnect();
    this.ro = null;
    this.particles = [];
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
