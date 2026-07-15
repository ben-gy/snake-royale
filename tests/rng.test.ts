/**
 * P2P-sync determinism. Two peers seeded identically must generate identical
 * boards (spawn slots + food). If this fails, every multiplayer session desyncs.
 */
import { describe, expect, it } from 'vitest';
import { makeRng, hashSeed, randInt, shuffle, pick } from '../src/engine/rng';
import { createRoyale, spawnSnakes } from '../src/game';

describe('makeRng determinism (P2P sync invariant)', () => {
  it('produces an identical stream for the same numeric seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    expect(Array.from({ length: 100 }, () => a())).toEqual(Array.from({ length: 100 }, () => b()));
  });

  it('diverges for different seeds', () => {
    expect(makeRng(1)()).not.toEqual(makeRng(2)());
  });

  it('stays within [0,1)', () => {
    const r = makeRng(99);
    for (let i = 0; i < 500; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hashSeed', () => {
  it('is stable and unsigned 32-bit', () => {
    const h = hashSeed('snake');
    expect(h).toBe(hashSeed('snake'));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('shuffle / randInt / pick agree across peers', () => {
  it('shuffles identically', () => {
    const deck = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffle(makeRng('s'), deck)).toEqual(shuffle(makeRng('s'), deck));
  });
  it('randInt matches', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    for (let i = 0; i < 50; i++) expect(randInt(a, 0, 21)).toBe(randInt(b, 0, 21));
  });
  it('pick agrees', () => {
    expect(pick(makeRng('x'), [1, 2, 3, 4])).toBe(pick(makeRng('x'), [1, 2, 3, 4]));
  });
});

describe('Snake Royale board determinism', () => {
  const players = [
    { name: 'A', color: 0 },
    { name: 'B', color: 1 },
    { name: 'C', color: 2 },
    { name: 'D', color: 3 },
  ];

  it('two peers build an identical board from the same seed', () => {
    const p1 = createRoyale(0xabcdef, { grid: 22, mode: 'royale', players });
    const p2 = createRoyale(0xabcdef, { grid: 22, mode: 'royale', players });
    expect(p1.snakes.map((s) => s.body)).toEqual(p2.snakes.map((s) => s.body));
    expect(p1.food).toEqual(p2.food);
  });

  it('different seeds place food differently', () => {
    const a = createRoyale(1, { grid: 22, mode: 'royale', players });
    const b = createRoyale(2, { grid: 22, mode: 'royale', players });
    expect(a.food).not.toEqual(b.food);
  });

  it('spawns are pure/deterministic regardless of seed (no Math.random)', () => {
    expect(spawnSnakes(22, players)).toEqual(spawnSnakes(22, players));
  });
});
