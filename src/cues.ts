// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * cues.ts — Snake Royale's own sound patches.
 *
 * These used to require a forked copy of the whole engine `sound.ts`, purely
 * because `SfxName` was a closed union of arcade cues and `play` took a
 * positional pitch multiplier. Engine v1.3.0 takes game patches through
 * `createSfx({ patches })` and transposes with `play(name, { pitch })`, so all
 * that survives here is the table itself — the only part that was ever
 * game-specific. `go` is redefined so the arena's launch tone stays exactly as
 * shipped rather than inheriting the engine default.
 */

import type { Patch } from '@ben-gy/game-engine/sound';

export const CUES: Record<string, Patch> = {
  blip: { type: 'square', freq: [440, 620], dur: 0.06, gain: 0.18 },
  select: { type: 'triangle', freq: [520, 880], dur: 0.09, gain: 0.2 },
  eat: { type: 'square', freq: [660, 1180], dur: 0.1, gain: 0.2 },
  turn: { type: 'triangle', freq: [300, 380], dur: 0.04, gain: 0.08 },
  crash: { type: 'sawtooth', freq: [260, 60], dur: 0.28, gain: 0.3, noise: true },
  die: { type: 'sawtooth', freq: [200, 40], dur: 0.5, gain: 0.34, noise: true },
  beep: { type: 'square', freq: [520, 520], dur: 0.12, gain: 0.2 },
  go: { type: 'square', freq: [660, 990], dur: 0.28, gain: 0.24 },
  powerup: { type: 'square', freq: [520, 1040], dur: 0.3, gain: 0.22 },
  lose: { type: 'sawtooth', freq: [400, 120], dur: 0.5, gain: 0.3 },
  win: { type: 'triangle', freq: [520, 1040], dur: 0.5, gain: 0.28 },
};
