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
  private roster: PeerId[];
  /** Fan-out, mirroring the real net.ts — one name may have many receivers. */
  private handlers = new Map<string, Set<(d: unknown, from: PeerId) => void>>();
  sent: { name: string; data: unknown }[] = [];

  constructor(selfId: PeerId, roster: PeerId[]) {
    this.selfId = selfId;
    this.roster = roster;
  }
  /** A peer drops out of the room. */
  part(id: PeerId) {
    this.roster = this.roster.filter((p) => p !== id);
  }
  /** A peer wanders in — e.g. mid-round, with an id small enough to win an
   *  unguarded election. */
  arrive(id: PeerId) {
    this.roster = [...this.roster, id];
  }
  /** Simulate a message arriving on a channel from a peer. */
  deliver(name: string, data: unknown, from: PeerId) {
    for (const h of [...(this.handlers.get(name) ?? [])]) h(data, from);
  }
  receiverCount(name: string) {
    return this.handlers.get(name)?.size ?? 0;
  }
  peers() {
    return [...this.roster].sort();
  }
  host(): PeerId | null {
    return this.peers()[0] ?? null;
  }
  isHost() {
    return this.host() === this.selfId;
  }
  hostSettled() {
    return true;
  }
  count() {
    return this.roster.length;
  }
  channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
    const h = onReceive as (d: unknown, from: PeerId) => void;
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(h);
    const send = ((data: T, _to?: PeerId | PeerId[]) => {
      this.sent.push({ name, data });
    }) as ((data: T, to?: PeerId | PeerId[]) => void) & { off: () => void };
    send.off = () => {
      this.handlers.get(name)!.delete(h);
    };
    return send;
  }
  ping() {
    return Promise.resolve(0);
  }
  async leave() {}
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
    death: null,
    killedBy: -1,
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
    const fake = new FakeNet('peerB', ['peerA', 'peerB']);
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
    const snap: Snapshot = { state: craftedTwoSnake(), phase: 'play' };
    fake.deliver('snap', snap, 'peerA');
    expect(ng.getPhase()).toBe('play');
    const tickBefore = ng.getState().tick;

    // Before promotion, ticking must be a no-op (host is authoritative).
    ng.hostTick();
    ng.hostTick();
    expect(ng.getState().tick).toBe(tickBefore);
    expect(ng.getState().over).toBe(false);

    // The old host leaves the room → this peer is the smallest seat still here.
    fake.part('peerA');
    ng.onRoster();

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

  it('holds the arena frozen until the host says go, then plays', () => {
    const fake = new FakeNet('peerA', ['peerA', 'peerB']);
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
    // The arena exists but nothing moves while the local 3-2-1 is running: a
    // snake that started travelling behind the overlay would be unrecoverable.
    const start = ng.getState().tick;
    ng.hostTick();
    expect(ng.getState().tick).toBe(start);

    ng.begin(); // the host's local countdown finished
    expect(ng.getPhase()).toBe('play');
    ng.hostTick();
    expect(ng.getState().tick).toBe(start + 1);
    ng.destroy();
  });
});

describe('snapshot serialization', () => {
  it('round-trips through JSON unchanged', () => {
    const snap: Snapshot = { state: craftedTwoSnake(), phase: 'play' };
    const round = JSON.parse(JSON.stringify(snap)) as Snapshot;
    expect(round).toEqual(snap);
    expect(round.state.snakes[0].body).toEqual(snap.state.snakes[0].body);
  });
});
