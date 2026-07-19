/**
 * Pure Snake Royale simulation tests: fairness of the opening, eating/growth,
 * every death mode (wall, self, another body, head-to-head), win conditions and
 * results ordering. The sim is deterministic given an rng, so these are exact.
 */
import { describe, expect, it } from 'vitest';
import {
  aliveCount,
  createRoyale,
  ranking,
  setDir,
  spawnSnakes,
  stepRoyale,
  type Cell,
  type Dir,
  type RoyaleState,
  type Snake,
} from '../src/game';
import { makeRng } from '@ben-gy/game-engine/rng';

function snake(id: number, body: Cell[], dir: Dir): Snake {
  return {
    id,
    name: `P${id}`,
    color: id,
    body: body.map((c) => ({ ...c })),
    dir,
    pending: dir,
    alive: true,
    death: null,
    killedBy: -1,
    grow: 0,
    score: 0,
    deadAt: -1,
  };
}

function state(snakes: Snake[], food: Cell[], mode: 'solo' | 'royale' = 'royale'): RoyaleState {
  return {
    grid: 22,
    mode,
    snakes,
    food: food.map((c) => ({ ...c })),
    tick: 0,
    over: false,
    winner: -1,
    startCount: snakes.length,
    foodTarget: 0, // no auto-refill in these controlled tests
  };
}

const rng = () => makeRng(1);

describe('starting balance (fairness at turn 0)', () => {
  it('every snake starts the exact same length', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const specs = Array.from({ length: n }, (_, i) => ({ name: `P${i}`, color: i }));
      const snakes = spawnSnakes(22, specs);
      const lengths = snakes.map((s) => s.body.length);
      expect(new Set(lengths).size).toBe(1);
      expect(lengths[0]).toBe(3);
    }
  });

  it('no two snakes share a starting cell', () => {
    const specs = Array.from({ length: 6 }, (_, i) => ({ name: `P${i}`, color: i }));
    const snakes = spawnSnakes(22, specs);
    const cells = new Set<string>();
    for (const s of snakes) for (const c of s.body) cells.add(`${c.x},${c.y}`);
    expect(cells.size).toBe(6 * 3);
  });

  it('all spawn cells are inside the arena', () => {
    const specs = Array.from({ length: 6 }, (_, i) => ({ name: `P${i}`, color: i }));
    for (const s of spawnSnakes(22, specs)) {
      for (const c of s.body) {
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.x).toBeLessThan(22);
        expect(c.y).toBeLessThan(22);
      }
    }
  });
});

describe('eating and growth', () => {
  it('growing a pellet adds a segment and a point and clears the pellet', () => {
    const s = state([snake(0, [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }], 'right')], [
      { x: 6, y: 5 },
    ]);
    const ev = stepRoyale(s, rng());
    expect(ev.ate).toEqual([0]);
    expect(s.snakes[0].score).toBe(1);
    expect(s.snakes[0].body.length).toBe(4);
    expect(s.snakes[0].body[0]).toEqual({ x: 6, y: 5 });
    expect(s.food).toEqual([]);
  });

  it('a normal move keeps length and shifts the body forward', () => {
    const s = state([snake(0, [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }], 'right')], []);
    stepRoyale(s, rng());
    expect(s.snakes[0].body).toEqual([
      { x: 6, y: 5 },
      { x: 5, y: 5 },
      { x: 4, y: 5 },
    ]);
  });
});

describe('death modes', () => {
  it('hitting a wall kills the snake (solo → game over)', () => {
    const s = state([snake(0, [{ x: 0, y: 5 }, { x: 1, y: 5 }], 'left')], [], 'solo');
    stepRoyale(s, rng());
    expect(s.snakes[0].alive).toBe(false);
    expect(s.over).toBe(true);
    expect(s.winner).toBe(-1);
  });

  it('running into your own body kills you', () => {
    const s = state(
      [
        snake(
          0,
          [
            { x: 5, y: 5 },
            { x: 5, y: 6 },
            { x: 6, y: 6 },
            { x: 6, y: 5 },
            { x: 7, y: 5 },
          ],
          'up',
        ),
      ],
      [],
      'solo',
    );
    setDir(s, 0, 'right'); // head → {6,5}, a non-tail body cell
    stepRoyale(s, rng());
    expect(s.snakes[0].alive).toBe(false);
  });

  it('can safely follow a vacating tail', () => {
    // Tight square: head chases the tail cell, which moves away this tick.
    const s = state(
      [
        snake(
          0,
          [
            { x: 5, y: 5 },
            { x: 5, y: 6 },
            { x: 6, y: 6 },
            { x: 6, y: 5 },
          ],
          'up',
        ),
      ],
      [],
      'solo',
    );
    setDir(s, 0, 'right'); // head → {6,5} == current tail, which vacates
    stepRoyale(s, rng());
    expect(s.snakes[0].alive).toBe(true);
  });

  it('head-to-head collision kills both snakes', () => {
    const s = state([
      snake(0, [{ x: 5, y: 5 }, { x: 4, y: 5 }], 'right'),
      snake(1, [{ x: 7, y: 5 }, { x: 8, y: 5 }], 'left'),
    ], []);
    stepRoyale(s, rng());
    expect(s.snakes[0].alive).toBe(false);
    expect(s.snakes[1].alive).toBe(false);
    expect(s.over).toBe(true);
  });

  it('running into another snake body kills only the mover', () => {
    // Snake 0 heads right into {6,5}, which is a mid-body cell of snake 1.
    const s = state([
      snake(0, [{ x: 5, y: 5 }, { x: 4, y: 5 }], 'right'),
      snake(1, [{ x: 6, y: 4 }, { x: 6, y: 5 }, { x: 6, y: 6 }], 'up'),
    ], []);
    stepRoyale(s, rng());
    expect(s.snakes[0].alive).toBe(false);
    expect(s.snakes[1].alive).toBe(true);
    expect(s.winner).toBe(1);
  });
});

describe('win condition + ranking', () => {
  it('royale ends when one snake remains and names the winner', () => {
    const s = state([
      snake(0, [{ x: 0, y: 5 }, { x: 1, y: 5 }], 'left'), // into wall
      snake(1, [{ x: 10, y: 10 }, { x: 9, y: 10 }], 'right'),
    ], []);
    stepRoyale(s, rng());
    expect(aliveCount(s)).toBe(1);
    expect(s.over).toBe(true);
    expect(s.winner).toBe(1);
  });

  it('setDir refuses a direct reversal into itself', () => {
    const s = state([snake(0, [{ x: 5, y: 5 }, { x: 4, y: 5 }], 'right')], []);
    setDir(s, 0, 'left');
    expect(s.snakes[0].pending).toBe('right');
    setDir(s, 0, 'up');
    expect(s.snakes[0].pending).toBe('up');
  });

  it('ranks alive snakes first, then later deaths, then score', () => {
    const a = snake(0, [{ x: 1, y: 1 }], 'right');
    a.score = 3;
    const b = snake(1, [{ x: 2, y: 2 }], 'right');
    b.alive = false;
    b.deadAt = 5;
    b.score = 2;
    const c = snake(2, [{ x: 3, y: 3 }], 'right');
    c.alive = false;
    c.deadAt = 2;
    c.score = 9;
    expect(ranking(state([a, b, c], []))).toEqual([0, 1, 2]);
  });
});

describe('createRoyale integration', () => {
  it('places the requested number of pellets on empty cells', () => {
    const s = createRoyale(42, {
      grid: 22,
      mode: 'royale',
      players: [
        { name: 'A', color: 0 },
        { name: 'B', color: 1 },
      ],
      foodTarget: 5,
    });
    expect(s.food.length).toBe(5);
    const bodies = new Set<string>();
    for (const sn of s.snakes) for (const c of sn.body) bodies.add(`${c.x},${c.y}`);
    for (const f of s.food) expect(bodies.has(`${f.x},${f.y}`)).toBe(false);
  });
});
