// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * modes.ts — the shapes an arena can take.
 *
 * Two knobs, and they pull against each other on purpose: how much floor there
 * is, and how long you get to think before the snake has already turned. Space
 * and speed are the whole game — snake has no other verbs — so moving both is
 * what makes these different games rather than different numbers:
 *
 *   Skirmish  a small floor at speed. Six snakes start almost touching, so the
 *             first cut-off lands in the opening seconds and you react rather
 *             than plan.
 *   Royale    the default. Room to circle, fast enough to punish a wrong turn.
 *   Colossus  a big floor, slow. Long enough between ticks to see a trap two
 *             moves out and steer around it, big enough that boxing someone in
 *             is a thing you build rather than stumble into.
 *
 * The host picks; the choice travels frozen inside the round start (see
 * the engine's rematch.ts), so every peer runs the same arena at the same speed. A
 * mode each peer read from its own UI is a mode two peers can disagree about —
 * and here that means two peers stepping the same seed at different rates.
 */

export interface Mode {
  id: ModeId;
  name: string;
  /** Arena edge in cells. game.ts spawns and steps any size. */
  grid: number;
  /** Milliseconds per authoritative tick in a Royale round. */
  tickMs: number;
  /** One line, shown under the name — say what it FEELS like, not the numbers. */
  blurb: string;
}

export type ModeId = 'skirmish' | 'royale' | 'colossus';

export const MODES: Record<ModeId, Mode> = {
  skirmish: {
    id: 'skirmish',
    name: 'Skirmish',
    grid: 14,
    tickMs: 80,
    blurb: 'Tiny arena, fast snakes. Someone dies in the first few seconds.',
  },
  royale: {
    id: 'royale',
    name: 'Royale',
    grid: 22,
    tickMs: 110,
    blurb: 'The standard arena. Room to circle, no room to daydream.',
  },
  colossus: {
    id: 'colossus',
    name: 'Colossus',
    grid: 32,
    tickMs: 150,
    blurb: 'A huge, slower floor — hunt your rivals down and box them in.',
  },
};

export const DEFAULT_MODE: ModeId = 'royale';

export const MODE_LIST: Mode[] = [MODES.skirmish, MODES.royale, MODES.colossus];

/**
 * Resolve a mode id that arrived over the wire or out of storage.
 *
 * Never trust it: an older peer, a corrupted store or a hand-edited message
 * would otherwise hand `undefined` to createRoyale and spawn snakes on a grid of
 * size NaN — every head instantly out of bounds, so the round ends before it
 * starts. Falling back keeps a mismatched peer playing Royale instead.
 *
 * hasOwn, not a truthiness check on the lookup: MODES is an object literal, so
 * MODES['constructor'] is Object.prototype.constructor — truthy, not a Mode, and
 * reachable from the wire. It would sail past the guard the guard exists for and
 * hand the arena a Function with no .grid on it.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id as ModeId];
  return MODES[DEFAULT_MODE];
}

/**
 * The arena a round runs in, read from the round-start opts the HOST froze.
 *
 * A named function rather than a cast at the call site, because this is the one
 * place allowed to answer "which arena?" for a multiplayer round, and the answer
 * must never be the local pick. `opts` is whatever came off the wire — an object
 * from a peer on a newer build, undefined from an older one, or junk — so it is
 * unwrapped defensively and validated through modeOf.
 */
export function arenaFor(opts: unknown): Mode {
  return modeOf((opts as { mode?: unknown } | null | undefined)?.mode);
}

/**
 * Pellets to keep on the floor, given the arena and how many snakes are in it.
 *
 * Not a constant, because "players + 1" is a different game on 14×14 than on
 * 32×32: three pellets in a thousand cells is a walking simulator, and the point
 * of the big arena is the hunt, not the search. Density is what has to hold, so
 * the floor's area buys pellets too.
 */
export function foodTarget(mode: Mode, players: number): number {
  return Math.max(2, players + 1 + Math.round((mode.grid * mode.grid) / 220));
}

/**
 * Solo (Endless) speed for a mode. Endless starts gentler than a Royale tick and
 * ramps with your score — the ramp IS the solo difficulty curve, and there are no
 * rivals to keep in step with, so this is local rather than on the wire.
 */
export function soloTickMs(mode: Mode, score: number): number {
  const start = Math.round(mode.tickMs * 1.27);
  const floor = Math.round(mode.tickMs * 0.7);
  return Math.max(floor, start - score * 3);
}
