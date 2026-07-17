/**
 * round-authority.test.ts — the arena-freeze bug, and the receiver stacking the
 * channel fan-out introduces.
 *
 * THE FREEZE: net.ts elects the smallest id in the ROOM. A peer who wanders in
 * mid-round has no NetRoyale — it cannot drive the sim, it cannot broadcast a
 * snapshot. If it wins that election every seated player stands down and the
 * arena stops advancing for everyone, permanently. Authority must instead follow
 * the round's FROZEN roster, while still handing over when a seated player goes.
 *
 * No network needed: a FakeNet whose roster we mutate by hand exercises the
 * whole election path, and manualTimers keeps the sim deterministic.
 */
import { describe, expect, it } from 'vitest';
import type { Net, PeerId } from '../src/engine/net';
import { NetRoyale } from '../src/net-game';

class FakeNet implements Net {
  readonly selfId: PeerId;
  private roster: PeerId[];
  private handlers = new Map<string, Set<(d: unknown, from: PeerId) => void>>();
  sent: { name: string; data: unknown }[] = [];

  constructor(selfId: PeerId, roster: PeerId[]) {
    this.selfId = selfId;
    this.roster = roster;
  }
  part(id: PeerId) {
    this.roster = this.roster.filter((p) => p !== id);
  }
  arrive(id: PeerId) {
    this.roster = [...this.roster, id];
  }
  deliver(name: string, data: unknown, from: PeerId) {
    for (const h of [...(this.handlers.get(name) ?? [])]) h(data, from);
  }
  receiverCount(name: string) {
    return this.handlers.get(name)?.size ?? 0;
  }
  peers() {
    return [...this.roster].sort();
  }
  host() {
    return this.peers()[0];
  }
  isHost() {
    return this.host() === this.selfId;
  }
  count() {
    return this.roster.length;
  }
  channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
    const h = onReceive as (d: unknown, from: PeerId) => void;
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(h);
    const send = ((data: T) => {
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

/** Seats are 'peerB' and 'peerC'; `self` picks which one we are simulating. */
function royale(fake: FakeNet) {
  return new NetRoyale({
    net: fake,
    seed: 99,
    grid: 22,
    seats: ['peerB', 'peerC'],
    players: [
      { name: 'B', color: 0 },
      { name: 'C', color: 1 },
    ],
    manualTimers: true,
    onUpdate: () => {},
  });
}

describe('round authority follows the frozen roster', () => {
  it('a mid-round joiner with the smallest id NEVER takes the round over', () => {
    // peerB is the seated host and is happily running the arena.
    const fake = new FakeNet('peerB', ['peerB', 'peerC']);
    const ng = royale(fake);
    for (let i = 0; i < 3; i++) ng.hostCountStep();
    expect(ng.getPhase()).toBe('play');

    // 'peerA' wanders into the room mid-round. It sorts first, so the room-wide
    // election makes it host — and it holds no NetRoyale at all.
    fake.arrive('peerA');
    expect(fake.isHost()).toBe(false); // the ROOM now thinks peerA is host…
    ng.onRoster();
    ng.setHost(false); // …and net.onHostChange says so, loudly

    // …but the seated host must keep driving, or the arena freezes for everyone.
    const before = ng.getState().tick;
    ng.hostTick();
    ng.hostTick();
    expect(ng.getState().tick).toBe(before + 2);
  });

  it('a spectator cannot overwrite the arena with a snapshot', () => {
    const fake = new FakeNet('peerC', ['peerB', 'peerC']);
    const ng = royale(fake);
    fake.arrive('peerA'); // spectator, and the room's elected host
    const before = JSON.stringify(ng.getState());

    ng.setHost(false);
    fake.deliver('snap', { state: { grid: 1, snakes: [] }, phase: 'over', count: 0 }, 'peerA');

    // Only the round's host — peerB — may rewrite this peer's state.
    expect(JSON.stringify(ng.getState())).toBe(before);
    expect(ng.getPhase()).not.toBe('over');
  });

  it('still hands over when a SEATED host leaves', () => {
    const fake = new FakeNet('peerC', ['peerB', 'peerC']);
    const ng = royale(fake);
    expect(fake.sent.some((m) => m.name === 'snap')).toBe(false); // client: silent

    fake.part('peerB'); // the seated host closes its tab
    ng.onRoster();

    // peerC is now the smallest seat still present: it must pick the round up.
    for (let i = 0; i < 3; i++) ng.hostCountStep();
    expect(ng.getPhase()).toBe('play');
    const before = ng.getState().tick;
    ng.hostTick();
    expect(ng.getState().tick).toBe(before + 1);
  });

  it('a seated host ignores input from a peer outside the roster', () => {
    const fake = new FakeNet('peerB', ['peerB', 'peerC']);
    const ng = royale(fake);
    for (let i = 0; i < 3; i++) ng.hostCountStep();
    fake.arrive('peerA');

    const dir = ng.getState().snakes[0].pending;
    fake.deliver('in', { dir: 'up' }, 'peerA'); // not a seat — no snake to steer
    expect(ng.getState().snakes[0].pending).toBe(dir);
  });
});

describe('per-round channel teardown (the fan-out hazard)', () => {
  it('destroy() detaches every receiver so a dead round cannot feed the next', () => {
    const fake = new FakeNet('peerB', ['peerB', 'peerC']);
    const first = royale(fake);
    expect(fake.receiverCount('snap')).toBe(1);
    expect(fake.receiverCount('in')).toBe(1);

    // net.channel() fans out now: without off() in destroy(), round 2 would
    // STACK its receivers on round 1's and the finished arena would keep
    // resolving inputs and broadcasting over the live one.
    first.destroy();
    expect(fake.receiverCount('snap')).toBe(0);
    expect(fake.receiverCount('in')).toBe(0);

    const second = royale(fake);
    expect(fake.receiverCount('snap')).toBe(1);
    expect(fake.receiverCount('in')).toBe(1);
    expect(fake.receiverCount('sync')).toBe(1);
    second.destroy();
  });

  it('a destroyed round stops steering its stale state', () => {
    const fake = new FakeNet('peerB', ['peerB', 'peerC']);
    const ng = royale(fake);
    for (let i = 0; i < 3; i++) ng.hostCountStep();
    ng.destroy();

    const before = ng.getState().snakes[1].pending;
    fake.deliver('in', { dir: 'down' }, 'peerC');
    expect(ng.getState().snakes[1].pending).toBe(before);
  });
});
