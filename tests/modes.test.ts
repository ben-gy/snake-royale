/**
 * modes.test.ts — the host's arena is what the room plays, and all three of them
 * are actually playable.
 *
 * A mode here moves the grid AND the tick, so two peers that resolve it
 * differently are not merely looking at different sizes — they are stepping the
 * same seed at different rates, and every snapshot fights the last. The mode
 * therefore travels frozen inside the round start, and these tests pin that.
 *
 * The rest of this file is the viability check. Snake Royale is host-
 * authoritative: one peer steps the sim and broadcasts a FULL snapshot every
 * tick to everyone else. Making the arena bigger makes both of those bigger, and
 * a mode that a mid-range phone cannot host is not a mode. So it is measured
 * here rather than assumed — with bots that actually survive, because unsteered
 * snakes crash in the first second and would flatter every number in the file.
 */

import { describe, expect, it } from 'vitest';
import {
  arenaFor,
  DEFAULT_MODE,
  MODES,
  MODE_LIST,
  foodTarget,
  modeOf,
  soloTickMs,
} from '../src/modes';
import { createRoyale, stepRoyale, setDir, DIRS, type Dir, type RoyaleState } from '../src/game';
import { makeRng } from '@ben-gy/game-engine/rng';

describe('modeOf', () => {
  it('resolves a known id', () => {
    expect(modeOf('skirmish').grid).toBe(14);
    expect(modeOf('colossus').tickMs).toBe(150);
  });

  it('falls back rather than handing createRoyale an undefined grid', () => {
    // A start from an older peer, a corrupted store, or a hand-edited message.
    // Without the fallback this becomes createRoyale(seed, {grid: undefined}) —
    // every snake spawns at NaN and is instantly out of bounds, so the round is
    // over before the countdown finishes.
    for (const bad of [undefined, null, '', 'nope', 42, {}, 'royale ']) {
      expect(modeOf(bad as unknown).id).toBe(DEFAULT_MODE);
      expect(Number.isInteger(modeOf(bad as unknown).grid)).toBe(true);
      expect(Number.isInteger(modeOf(bad as unknown).tickMs)).toBe(true);
    }
  });

  it('does not inherit Object.prototype keys as modes', () => {
    // MODES is an object literal, so 'constructor' and 'toString' are truthy on
    // it. Either would sail past the lookup and hand a Function to the arena.
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(modeOf(key).id).toBe(DEFAULT_MODE);
    }
  });
});

describe('arenaFor — the round plays the HOST\'s arena', () => {
  it('takes the mode out of the round-start opts', () => {
    expect(arenaFor({ mode: 'colossus' }).id).toBe('colossus');
    expect(arenaFor({ mode: 'skirmish', pub: true }).id).toBe('skirmish');
  });

  it('survives opts from a peer that does not send a mode at all', () => {
    // An older build, or a start from before modes existed. It must land on the
    // default, not on undefined.grid.
    for (const bad of [undefined, null, {}, { mode: undefined }, { mode: 'gone' }, 'nope', 7]) {
      const m = arenaFor(bad);
      expect(m.id).toBe(DEFAULT_MODE);
      expect(Number.isInteger(m.grid)).toBe(true);
      expect(Number.isInteger(m.tickMs)).toBe(true);
    }
  });

  it('gives two peers the same arena from the same start bytes', () => {
    // The whole point. The start is one set of bytes broadcast by the host, so
    // whatever each peer's own lobby pick was, they resolve the same arena.
    const start = JSON.parse(JSON.stringify({ mode: 'skirmish', pub: false }));
    const a = arenaFor(start);
    const b = arenaFor(JSON.parse(JSON.stringify(start)));
    expect(a).toEqual(b);
    expect([a.grid, a.tickMs]).toEqual([MODES.skirmish.grid, MODES.skirmish.tickMs]);
  });
});

describe('the modes are actually different games', () => {
  it('offers a real spread of floor and speed', () => {
    const grids = MODE_LIST.map((m) => m.grid);
    const ticks = MODE_LIST.map((m) => m.tickMs);
    expect(new Set(grids).size).toBe(MODE_LIST.length); // no two feel the same
    expect(new Set(ticks).size).toBe(MODE_LIST.length);
    // Not a rounding difference: the big arena holds >5x the floor of the small
    // one, and gives you nearly twice as long to decide what to do with it.
    expect(MODES.colossus.grid ** 2 / MODES.skirmish.grid ** 2).toBeGreaterThan(5);
    expect(MODES.colossus.tickMs / MODES.skirmish.tickMs).toBeGreaterThan(1.8);
  });

  it('builds the arena its mode asks for', () => {
    for (const m of MODE_LIST) {
      const st = createRoyale(7, {
        grid: m.grid,
        mode: 'royale',
        players: Array.from({ length: 6 }, (_, i) => ({ name: `P${i}`, color: i })),
        foodTarget: foodTarget(m, 6),
      });
      expect(st.grid).toBe(m.grid);
      // Six snakes have to physically fit, each with a full-length body inside
      // the walls, or the mode kills someone on tick one for spawning.
      expect(st.snakes).toHaveLength(6);
      for (const s of st.snakes) {
        for (const c of s.body) {
          expect(c.x, `${m.id} spawn x`).toBeGreaterThanOrEqual(0);
          expect(c.x, `${m.id} spawn x`).toBeLessThan(m.grid);
          expect(c.y, `${m.id} spawn y`).toBeGreaterThanOrEqual(0);
          expect(c.y, `${m.id} spawn y`).toBeLessThan(m.grid);
        }
      }
      expect(st.food.length).toBe(foodTarget(m, 6));
    }
  });

  it('keeps pellet density roughly constant instead of pellet count', () => {
    // players+1 pellets is a different game on 14x14 than on 32x32: three pellets
    // in a thousand cells is a walking simulator, and the big arena is supposed
    // to be a hunt. So the floor buys pellets too.
    const density = (id: 'skirmish' | 'colossus'): number =>
      foodTarget(MODES[id], 2) / MODES[id].grid ** 2;
    expect(density('colossus')).toBeGreaterThan(density('skirmish') / 3);
    expect(foodTarget(MODES.colossus, 2)).toBeGreaterThan(foodTarget(MODES.skirmish, 2));
  });

  it('ramps solo speed within its mode and never past the floor', () => {
    for (const m of MODE_LIST) {
      expect(soloTickMs(m, 0)).toBeGreaterThan(m.tickMs); // Endless starts gentler
      expect(soloTickMs(m, 50)).toBeLessThan(soloTickMs(m, 0)); // and speeds up
      // A tick that races off to zero would make the snake untouchable.
      expect(soloTickMs(m, 100_000), `${m.id} floor`).toBeGreaterThanOrEqual(
        Math.round(m.tickMs * 0.7),
      );
    }
  });
});

// ---- viability ---------------------------------------------------------------

const ALL: Dir[] = ['up', 'down', 'left', 'right'];

/**
 * A greedy survival bot: never steps into a wall or a body, otherwise heads for
 * the nearest pellet. It exists so bodies get LONG — the cost of a tick is
 * driven by body length, and snakes left unsteered die in the first second and
 * would make every mode look free.
 */
function botSteer(st: RoyaleState): void {
  const occ = new Set<string>();
  for (const s of st.snakes) if (s.alive) for (const c of s.body) occ.add(`${c.x},${c.y}`);
  for (const s of st.snakes) {
    if (!s.alive) continue;
    const h = s.body[0];
    const dist = (c: { x: number; y: number }): number => Math.abs(c.x - h.x) + Math.abs(c.y - h.y);
    const food = st.food.slice().sort((a, b) => dist(a) - dist(b))[0];
    const safe = ALL.filter((d) => {
      const n = { x: h.x + DIRS[d].x, y: h.y + DIRS[d].y };
      if (n.x < 0 || n.y < 0 || n.x >= st.grid || n.y >= st.grid) return false;
      return !occ.has(`${n.x},${n.y}`);
    });
    if (!safe.length) continue;
    const toward = (d: Dir): number =>
      food
        ? Math.abs(h.x + DIRS[d].x - food.x) + Math.abs(h.y + DIRS[d].y - food.y)
        : 0;
    setDir(st, s.id, safe.sort((a, b) => toward(a) - toward(b))[0]);
  }
}

interface RoundStats {
  ticks: number;
  meanStepMs: number;
  worstStepMs: number;
  worstSnapBytes: number;
}

/** Play a whole bot round of `mode` and measure what hosting it costs. */
function playRound(gridN: number, tickMs: number, players: number, seed: number): RoundStats {
  const st = createRoyale(seed, {
    grid: gridN,
    mode: 'royale',
    players: Array.from({ length: players }, (_, i) => ({ name: `P${i}`, color: i })),
    foodTarget: foodTarget({ grid: gridN, tickMs } as never, players),
  });
  const rng = makeRng(seed);
  let ticks = 0;
  let total = 0;
  let worst = 0;
  let worstSnap = 0;
  while (!st.over && ticks < 20_000) {
    botSteer(st);
    const t0 = performance.now();
    stepRoyale(st, rng);
    const dt = performance.now() - t0;
    total += dt;
    if (dt > worst) worst = dt;
    ticks++;
    // What the host actually puts on the wire every tick.
    const bytes = JSON.stringify({ state: st, phase: 'play' }).length;
    if (bytes > worstSnap) worstSnap = bytes;
  }
  return { ticks, meanStepMs: total / ticks, worstStepMs: worst, worstSnapBytes: worstSnap };
}

describe('every mode is viable to host', () => {
  it('steps the sim in a sliver of its own tick budget, even at 6 snakes', () => {
    // The host runs this on a phone while also rendering. Measured on this
    // machine it is ~0.02% of the budget for all three; 5% is the line at which
    // hosting would start to eat the frame, and it is 200x away.
    for (const m of MODE_LIST) {
      const r = playRound(m.grid, m.tickMs, 6, 1);
      expect(r.meanStepMs, `${m.id} mean step`).toBeLessThan(m.tickMs * 0.05);
      expect(r.worstStepMs, `${m.id} worst step`).toBeLessThan(m.tickMs * 0.25);
    }
  });

  it('does not let the big arena blow up the host\'s uplink', () => {
    // The real cost of a bigger arena is not CPU, it is that a full snapshot goes
    // out every tick to all five rivals. Colossus's snapshot IS bigger — but its
    // slower tick pays for it, so the bandwidth comes out roughly FLAT across the
    // three modes rather than scaling with area. That is why the modes move both
    // knobs together, and this is the test that would catch someone "just"
    // raising a grid.
    const perPeer = MODE_LIST.map((m) => {
      const r = playRound(m.grid, m.tickMs, 6, 1);
      return { id: m.id, kib: (r.worstSnapBytes * 1000) / m.tickMs / 1024 };
    });
    for (const p of perPeer) {
      expect(p.kib, `${p.id} KiB/s per peer`).toBeLessThan(40);
      // x5 rivals is what the host actually uploads.
      expect(p.kib * 5, `${p.id} KiB/s host uplink`).toBeLessThan(200);
    }
    const max = Math.max(...perPeer.map((p) => p.kib));
    const min = Math.min(...perPeer.map((p) => p.kib));
    expect(max / min, 'bandwidth should stay flat across modes').toBeLessThan(1.6);
  });

  it('gives each mode a distinctly different round length', () => {
    // The point of the spread. Deterministic: fixed seeds, no Math.random in the
    // sim. Measured here: Skirmish ~3-6s, Royale ~10-16s, Colossus ~21-40s.
    const seconds = (id: 'skirmish' | 'royale' | 'colossus'): number => {
      const m = MODES[id];
      const seeds = [4, 11, 23];
      const mean =
        seeds.reduce((n, s) => n + playRound(m.grid, m.tickMs, 2, s).ticks, 0) / seeds.length;
      return (mean * m.tickMs) / 1000;
    };
    const skirmish = seconds('skirmish');
    const royale = seconds('royale');
    const colossus = seconds('colossus');
    expect(royale).toBeGreaterThan(skirmish * 1.5);
    expect(colossus).toBeGreaterThan(royale * 1.5);
    // And none of them is so long it stops being a round you play again.
    expect(colossus).toBeLessThan(180);
  });
});
