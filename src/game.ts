/**
 * game.ts — the pure, deterministic Snake Royale simulation.
 *
 * A single grid sim powers both modes:
 *  - Endless (solo): one snake, walls/self lethal, play until you crash.
 *  - Royale (2–6 P2P): shared arena, last snake alive wins; a dead snake drops
 *    pellets so trapping a rival also feeds you.
 *
 * Everything here is a pure function of (state, inputs, rng) so it is trivially
 * testable and — crucially — a peer promoted to host can adopt any snapshot and
 * keep stepping it to a valid game-over. All shared randomness (food placement,
 * spawn slots) flows from the lobby seed via engine/rng.ts; never Math.random().
 */

import { makeRng, randInt, type Rng } from './engine/rng';

export type Dir = 'up' | 'down' | 'left' | 'right';
export interface Cell {
  x: number;
  y: number;
}

export interface Snake {
  /** Seat index — stable, matches the sorted peer roster. */
  id: number;
  name: string;
  /** Index into the colour palette. */
  color: number;
  /** Head at index 0. */
  body: Cell[];
  dir: Dir;
  /** Direction the player wants next; applied (reverse-guarded) at each tick. */
  pending: Dir;
  alive: boolean;
  /** Pending growth segments (tail stays put while > 0). */
  grow: number;
  /** Food eaten this game. */
  score: number;
  /** Tick this snake died on (-1 if alive) — used to rank the results. */
  deadAt: number;
}

export type Mode = 'solo' | 'royale';

export interface RoyaleState {
  grid: number;
  mode: Mode;
  snakes: Snake[];
  food: Cell[];
  tick: number;
  over: boolean;
  /** Winner seat when over (royale). -1 = none yet / tie / solo. */
  winner: number;
  /** How many snakes were alive at the start (fixes the win condition). */
  startCount: number;
  /** Target number of pellets to keep on the board. */
  foodTarget: number;
}

export const DIRS: Record<Dir, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE: Record<Dir, Dir> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

/** Growth per pellet — 1 keeps the classic feel and keeps arenas from clogging. */
const GROW_PER_FOOD = 1;
/** Starting body length for every snake (equal starts = fair). */
const START_LEN = 3;

function key(c: Cell): number {
  return c.y * 10000 + c.x;
}

/** Choose the cardinal direction that best matches a float vector. */
function vecToDir(dx: number, dy: number): Dir {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

/**
 * Deterministic, symmetric spawn slots: snakes sit evenly on a ring around the
 * centre, each the SAME length, each heading tangentially (so nobody spawns
 * facing a wall). Equal starts for everyone regardless of the layout — the
 * arcade equivalent of the territory-game starting-balance rule.
 */
export function spawnSnakes(grid: number, specs: { name: string; color: number }[]): Snake[] {
  const n = specs.length;
  const c = (grid - 1) / 2;
  const radius = grid * (n <= 1 ? 0 : 0.3);
  return specs.map((spec, i) => {
    const ang = (Math.PI * 2 * i) / Math.max(1, n) - Math.PI / 2;
    const hx = Math.round(c + radius * Math.cos(ang));
    const hy = Math.round(c + radius * Math.sin(ang));
    // Tangent (clockwise) heading so the snake runs along the ring, not into a wall.
    const dir = n <= 1 ? 'right' : vecToDir(Math.sin(ang), -Math.cos(ang));
    const back = DIRS[OPPOSITE[dir]];
    const body: Cell[] = [];
    for (let s = 0; s < START_LEN; s++) {
      body.push({
        x: clamp(hx + back.x * s, 0, grid - 1),
        y: clamp(hy + back.y * s, 0, grid - 1),
      });
    }
    return {
      id: i,
      name: spec.name,
      color: spec.color,
      body,
      dir,
      pending: dir,
      alive: true,
      grow: 0,
      score: 0,
      deadAt: -1,
    };
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export interface CreateOpts {
  grid: number;
  mode: Mode;
  players: { name: string; color: number }[];
  foodTarget?: number;
}

export function createRoyale(seed: number, opts: CreateOpts): RoyaleState {
  const rng = makeRng(seed);
  const snakes = spawnSnakes(opts.grid, opts.players);
  const state: RoyaleState = {
    grid: opts.grid,
    mode: opts.mode,
    snakes,
    food: [],
    tick: 0,
    over: false,
    winner: -1,
    startCount: snakes.length,
    foodTarget: opts.foodTarget ?? Math.max(1, snakes.length),
  };
  // Burn a few rng values so the food layout depends on the seed, then fill.
  refillFood(state, rng);
  return state;
}

/** All cells currently occupied by any snake body. */
function occupied(state: RoyaleState): Set<number> {
  const set = new Set<number>();
  for (const s of state.snakes) {
    if (!s.alive) continue;
    for (const c of s.body) set.add(key(c));
  }
  return set;
}

/** Top up the board to foodTarget pellets on empty cells (seed-deterministic). */
export function refillFood(state: RoyaleState, rng: Rng): void {
  const occ = occupied(state);
  for (const f of state.food) occ.add(key(f));
  let guard = state.grid * state.grid * 2;
  while (state.food.length < state.foodTarget && guard-- > 0) {
    const cell = { x: randInt(rng, 0, state.grid - 1), y: randInt(rng, 0, state.grid - 1) };
    if (occ.has(key(cell))) continue;
    occ.add(key(cell));
    state.food.push(cell);
  }
}

export function aliveCount(state: RoyaleState): number {
  return state.snakes.reduce((n, s) => n + (s.alive ? 1 : 0), 0);
}

/** Set a snake's intended direction (reverse into itself is ignored). */
export function setDir(state: RoyaleState, seat: number, dir: Dir): void {
  const s = state.snakes[seat];
  if (!s || !s.alive) return;
  if (s.body.length > 1 && dir === OPPOSITE[s.dir]) return;
  s.pending = dir;
}

/**
 * Advance the simulation by exactly one tick. Deterministic given `rng`.
 * Returns the events that happened this tick (for juice on the render side).
 */
export interface StepEvents {
  ate: number[]; // seats that ate a pellet
  died: number[]; // seats that died
  eatenAt: Cell[]; // pellet cells consumed
}

export function stepRoyale(state: RoyaleState, rng: Rng): StepEvents {
  const events: StepEvents = { ate: [], died: [], eatenAt: [] };
  if (state.over) return events;
  state.tick++;

  const alive = state.snakes.filter((s) => s.alive);

  // 1. Resolve heading + intended new head for each alive snake.
  const newHeads = new Map<number, Cell>();
  for (const s of alive) {
    if (s.body.length <= 1 || s.pending !== OPPOSITE[s.dir]) s.dir = s.pending;
    const d = DIRS[s.dir];
    newHeads.set(s.id, { x: s.body[0].x + d.x, y: s.body[0].y + d.y });
  }

  // 2. Which snakes eat this tick (determines whether their tail vacates).
  const foodSet = new Map<number, number>(); // cellKey -> food index
  state.food.forEach((f, i) => foodSet.set(key(f), i));
  const eats = new Map<number, number>(); // seat -> food index
  for (const s of alive) {
    const h = newHeads.get(s.id)!;
    const fi = foodSet.get(key(h));
    if (fi !== undefined) eats.set(s.id, fi);
  }

  // 3. Determine deaths. A snake dies if its new head is out of bounds, or hits
  //    any snake body cell (its own tail vacates unless it's growing this tick),
  //    or two new heads collide (head-to-head → both die).
  const dead = new Set<number>();
  for (const s of alive) {
    const h = newHeads.get(s.id)!;
    if (h.x < 0 || h.y < 0 || h.x >= state.grid || h.y >= state.grid) {
      dead.add(s.id);
      continue;
    }
    for (const t of alive) {
      const grows = eats.has(t.id);
      const cells = t.body;
      const lastIdx = cells.length - 1;
      for (let i = 0; i < cells.length; i++) {
        // The tail cell will move away this tick unless that snake grows.
        if (i === lastIdx && !grows && t.id !== s.id) {
          // another snake's vacating tail is safe to enter
          continue;
        }
        if (i === lastIdx && !grows && t.id === s.id) {
          // our own tail vacates too — safe to follow it
          continue;
        }
        if (cells[i].x === h.x && cells[i].y === h.y) {
          dead.add(s.id);
          break;
        }
      }
      if (dead.has(s.id)) break;
    }
  }
  // Head-to-head: same target cell → all involved die.
  const headTargets = new Map<number, number[]>();
  for (const s of alive) {
    if (dead.has(s.id)) continue;
    const k = key(newHeads.get(s.id)!);
    (headTargets.get(k) ?? headTargets.set(k, []).get(k)!).push(s.id);
  }
  for (const ids of headTargets.values()) {
    if (ids.length > 1) for (const id of ids) dead.add(id);
  }

  // 4. Apply movement for survivors; kill the rest and scatter pellets.
  for (const s of alive) {
    if (dead.has(s.id)) continue;
    const h = newHeads.get(s.id)!;
    s.body.unshift(h);
    if (eats.has(s.id)) {
      s.grow += GROW_PER_FOOD;
      s.score++;
      events.ate.push(s.id);
    }
    if (s.grow > 0) s.grow--;
    else s.body.pop();
  }

  // Remove eaten pellets (record cells for juice).
  const eatenIdx = new Set(eats.values());
  if (eatenIdx.size) {
    const kept: Cell[] = [];
    state.food.forEach((f, i) => {
      if (eatenIdx.has(i)) events.eatenAt.push(f);
      else kept.push(f);
    });
    state.food = kept;
  }

  // Kill snakes and drop food along their bodies (royale comeback juice).
  for (const s of alive) {
    if (!dead.has(s.id)) continue;
    s.alive = false;
    s.deadAt = state.tick;
    events.died.push(s.id);
    if (state.mode === 'royale') {
      for (let i = 0; i < s.body.length; i += 3) {
        const c = s.body[i];
        if (!state.food.some((f) => f.x === c.x && f.y === c.y)) state.food.push({ ...c });
      }
    }
  }

  refillFood(state, rng);

  // 5. Win / end condition.
  if (state.mode === 'solo') {
    if (aliveCount(state) === 0) {
      state.over = true;
      state.winner = -1;
    }
  } else {
    if (aliveCount(state) <= 1 && state.startCount > 1) {
      state.over = true;
      const last = state.snakes.find((s) => s.alive);
      state.winner = last ? last.id : -1;
    }
  }
  return events;
}

/** Seats ranked best→worst for the results screen. */
export function ranking(state: RoyaleState): number[] {
  return state.snakes
    .map((s) => s.id)
    .sort((a, b) => {
      const sa = state.snakes[a];
      const sb = state.snakes[b];
      if (sa.alive !== sb.alive) return sa.alive ? -1 : 1;
      if (sa.alive && sb.alive) return sb.score - sa.score;
      // both dead: later death ranks higher, then score
      if (sb.deadAt !== sa.deadAt) return sb.deadAt - sa.deadAt;
      return sb.score - sa.score;
    });
}
