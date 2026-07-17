/**
 * round-arena.test.ts — the arena a round runs in comes off the WIRE.
 *
 * modes.test.ts proves arenaFor() unwraps the host's opts correctly, and
 * rematch.test.ts proves those opts travel frozen on the start. Neither touches
 * main.ts, which is where the two are joined — so the one line that decides
 * which grid this peer actually plays on was covered by nothing.
 *
 * That gap is not theoretical. Swapping main.ts's `arenaFor(opts)` for the local
 * `modeOf(modeId)` — the exact bug this design exists to prevent, and one that
 * has shipped here before — left `npx tsc --noEmit` clean and all 175 other
 * tests green, because `opts` is typed `unknown` and every mode test uses its
 * own harness. Six peers would have stepped the same seed on six different
 * grids at six different speeds, and the suite would have said nothing.
 *
 * So this drives the real module graph: boot main.ts, create a room, and hand
 * the captured onRound the host's opts while THIS peer's local pick is set to
 * something else on purpose. The two must not agree, or the assertion is empty.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoundsConfig, RoundsState } from '../src/engine/rematch';
import type { NetRoyaleConfig } from '../src/net-game';

const joinRoom = vi.fn(() => ({
  makeAction: () => [() => {}, () => {}, () => {}],
  onPeerJoin: () => {},
  onPeerLeave: () => {},
  getPeers: () => ({}),
  leave: () => {},
  ping: async () => 0,
}));
vi.mock('trystero', () => ({ joinRoom, selfId: 'self-test' }));

/** The round protocol, stubbed to a wire we hold the other end of. */
let roundsCfg: RoundsConfig | null = null;
const roundsState: RoundsState = {
  round: 0,
  phase: 'waiting',
  votes: [],
  present: [],
  voted: false,
  isHost: true,
  canStart: false,
  hostOpts: null,
  startsInMs: null,
};
vi.mock('../src/engine/rematch', async (orig) => ({
  ...(await orig<typeof import('../src/engine/rematch')>()),
  createRounds: (cfg: RoundsConfig) => {
    roundsCfg = cfg;
    return {
      vote: () => {},
      unvote: () => {},
      go: () => {},
      finish: () => {},
      state: () => roundsState,
      destroy: () => {},
    };
  },
}));

/** The arena, stubbed so we can read the grid it was actually built with. */
let arenaCfg: NetRoyaleConfig | null = null;
vi.mock('../src/net-game', async (orig) => ({
  ...(await orig<typeof import('../src/net-game')>()),
  NetRoyale: class {
    constructor(cfg: NetRoyaleConfig) {
      arenaCfg = cfg;
    }
    getState() {
      return { snakes: [], food: [], grid: arenaCfg?.grid ?? 0, tick: 0 };
    }
    getPhase() {
      return 'count';
    }
    mySeat() {
      return 0;
    }
    begin() {}
    play() {}
    steer() {}
    setHost() {}
    onRoster() {}
    hostTick() {}
    snapshot() {
      return {};
    }
    destroy() {}
  },
}));

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * jsdom has no canvas and no matchMedia, and a started round reaches both. They
 * are stubbed rather than avoided because the point of this file is to run the
 * REAL enterMpGame — the moment it is stubbed out, the call site under test is
 * gone. Any 2d-context property answers as a no-op; nothing here draws.
 */
function stubTheScreen(): void {
  (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  HTMLCanvasElement.prototype.getContext = (() =>
    new Proxy({} as CanvasRenderingContext2D, {
      get: (_t, k) => (k === 'canvas' ? document.createElement('canvas') : () => {}),
      set: () => true,
    })) as unknown as HTMLCanvasElement['getContext'];
}

/** Boot, pick `local` on the menu, then open a room as host. */
async function hostARoomPicking(local: string): Promise<void> {
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  localStorage.clear();
  // Hosting a room puts ?room= in the URL, and main.ts deep-links straight into
  // that room on the next boot — correctly. Each test starts from a cold URL, or
  // it would never see the entry screen it is trying to click through.
  history.replaceState(null, '', '/');
  stubTheScreen();
  roundsCfg = null;
  arenaCfg = null;
  await import('../src/main');
  await settle();
  document.querySelector<HTMLElement>(`.mode-chip[data-mode="${local}"]`)!.click();
  document.querySelector<HTMLElement>('[data-act="friends"]')!.click();
  await settle();
  document.querySelector<HTMLElement>('.re-create')!.click();
  await settle();
}

describe('the arena a round is played on', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    joinRoom.mockClear();
  });

  it('is the HOST’s, off the round start — not this peer’s own menu pick', async () => {
    // Local pick is deliberately the SMALLEST arena and the host's the biggest,
    // so a peer reading its own setting cannot accidentally look correct.
    await hostARoomPicking('skirmish');
    expect(roundsCfg).toBeTruthy();

    roundsCfg!.onRound({
      round: 1,
      seed: 42,
      players: [{ id: 'self-test', name: 'Me' }],
      isHost: true,
      opts: { mode: 'colossus', pub: false },
    });
    await settle();

    expect(arenaCfg).toBeTruthy();
    expect(arenaCfg!.grid).toBe(32);
    expect(arenaCfg!.tickMs).toBe(150);
  });

  it('falls back to the default arena when the start carries junk', async () => {
    // An older peer sends no opts at all; a hand-edited one sends a key off
    // Object.prototype. Neither may reach the generator as an undefined grid.
    await hostARoomPicking('skirmish');
    for (const opts of [undefined, null, {}, { mode: 'constructor' }, { mode: 7 }]) {
      arenaCfg = null;
      roundsCfg!.onRound({
        round: 1,
        seed: 1,
        players: [{ id: 'self-test', name: 'Me' }],
        isHost: true,
        opts,
      });
      await settle();
      expect(arenaCfg!.grid).toBe(22);
      expect(arenaCfg!.tickMs).toBe(110);
    }
  });

  it('freezes the host’s CURRENT menu pick into the start it sends', async () => {
    // roundOpts is read at go() time, so the last thing the host tapped is what
    // the room plays — not whatever was selected when the room was opened.
    await hostARoomPicking('colossus');
    expect(roundsCfg!.roundOpts!()).toEqual({ mode: 'colossus', pub: false });
  });
});
