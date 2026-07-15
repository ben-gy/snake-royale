/**
 * Host-transfer takeover (multiplayer contract gate #2) + snapshot round-trip.
 *
 * A non-authoritative client must NOT advance the shared sim; once promoted to
 * host it MUST drive the round and be able to reach game-over. We prove this
 * without any real network via a minimal FakeNet whose host flag we flip, and by
 * driving ticks by hand (manualTimers) so the test is deterministic.
 */
import { describe, expect, it } from 'vitest';
import type { Net, PeerId } from '../src/engine/net';
import { NetRoyale, type Snapshot } from '../src/net-game';
import type { RoyaleState, Snake } from '../src/game';

class FakeNet implements Net {
  readonly selfId: PeerId;
  private _isHost: boolean;
  private roster: PeerId[];
  private handlers = new Map<string, (d: unknown, from: PeerId) => void>();

  constructor(selfId: PeerId, isHost: boolean, roster: PeerId[]) {
    this.selfId = selfId;
    this._isHost = isHost;
    this.roster = roster;
  }
  setHost(v: boolean) {
    this._isHost = v;
  }
  /** Simulate a message arriving on a channel from a peer. */
  deliver(name: string, data: unknown, from: PeerId) {
    this.handlers.get(name)?.(data, from);
  }
  peers() {
    return [...this.roster].sort();
  }
  host() {
    return this.peers()[0];
  }
  isHost() {
    return this._isHost;
  }
  count() {
    return this.roster.length;
  }
  channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
    this.handlers.set(name, onReceive as (d: unknown, from: PeerId) => void);
    return (_d: T, _to?: PeerId | PeerId[]) => {};
  }
  ping() {
    return Promise.resolve(0);
  }
  leave() {}
}

function craftedTwoSnake(): RoyaleState {
  const mk = (id: number, body: { x: number; y: number }[], dir: Snake['dir']): Snake => ({
    id,
    name: `P${id}`,
    color: id,
    body,
    dir,
    pending: dir,
    alive: true,
    grow: 0,
    score: 0,
    deadAt: -1,
  });
  return {
    grid: 22,
    mode: 'royale',
    // Snake 0 is 2 cells from the left wall and heading into it.
    snakes: [
      mk(0, [{ x: 2, y: 5 }, { x: 3, y: 5 }, { x: 4, y: 5 }], 'left'),
      mk(1, [{ x: 11, y: 11 }, { x: 11, y: 12 }, { x: 11, y: 13 }], 'up'),
    ],
    food: [],
    tick: 0,
    over: false,
    winner: -1,
    startCount: 2,
    foodTarget: 0,
  };
}

describe('host transfer takeover (contract gate #2)', () => {
  it('a client does not advance the sim; a promoted client drives it to game-over', () => {
    const fake = new FakeNet('peerB', false, ['peerA', 'peerB']);
    const ng = new NetRoyale({
      net: fake,
      seed: 123,
      grid: 22,
      seats: ['peerA', 'peerB'],
      players: [
        { name: 'A', color: 0 },
        { name: 'B', color: 1 },
      ],
      manualTimers: true,
      onUpdate: () => {},
    });

    // Client adopts a host snapshot mid-round (phase = play).
    const snap: Snapshot = { state: craftedTwoSnake(), phase: 'play', count: 0 };
    fake.deliver('snap', snap, 'peerA');
    expect(ng.getPhase()).toBe('play');
    const tickBefore = ng.getState().tick;

    // Before promotion, ticking must be a no-op (host is authoritative).
    ng.hostTick();
    ng.hostTick();
    expect(ng.getState().tick).toBe(tickBefore);
    expect(ng.getState().over).toBe(false);

    // The old host leaves → this peer is promoted.
    fake.setHost(true);
    ng.setHost(true);

    // Now it must actually run the sim and be able to finish.
    let guard = 30;
    while (!ng.getState().over && guard-- > 0) ng.hostTick();

    expect(ng.getState().over).toBe(true);
    expect(ng.getState().tick).toBeGreaterThan(tickBefore);
    // Snake 0 ran into the wall; snake 1 survives and wins.
    expect(ng.getState().snakes[0].alive).toBe(false);
    expect(ng.getState().winner).toBe(1);
    ng.destroy();
  });

  it('a fresh host runs its own countdown then plays', () => {
    const fake = new FakeNet('peerA', true, ['peerA', 'peerB']);
    const ng = new NetRoyale({
      net: fake,
      seed: 7,
      grid: 22,
      seats: ['peerA', 'peerB'],
      players: [
        { name: 'A', color: 0 },
        { name: 'B', color: 1 },
      ],
      manualTimers: true,
      onUpdate: () => {},
    });
    expect(ng.getPhase()).toBe('count');
    ng.hostCountStep();
    ng.hostCountStep();
    ng.hostCountStep();
    expect(ng.getPhase()).toBe('play');
    const before = ng.getState().tick;
    ng.hostTick();
    expect(ng.getState().tick).toBe(before + 1);
    ng.destroy();
  });
});

describe('snapshot serialization', () => {
  it('round-trips through JSON unchanged', () => {
    const snap: Snapshot = { state: craftedTwoSnake(), phase: 'play', count: 0 };
    const round = JSON.parse(JSON.stringify(snap)) as Snapshot;
    expect(round).toEqual(snap);
    expect(round.state.snakes[0].body).toEqual(snap.state.snakes[0].body);
  });
});
