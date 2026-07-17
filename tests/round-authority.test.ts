/**
 * round-authority.test.ts — the arena-freeze bug, and the receiver stacking the
 * channel fan-out introduces.
 *
 * THE FREEZE: a peer who wanders in mid-round has no NetRoyale — it cannot drive
 * the sim and it cannot broadcast a snapshot. If it ever holds authority, every
 * seated player stands down and the arena stops advancing for the whole room,
 * permanently. net.ts now keeps the incumbent host across joins, which closes
 * the common case, but the room's host can STILL end up unseated: it inherits
 * the room after the seated host leaves. So authority is the incumbent filtered
 * through the round's FROZEN roster — and it must still hand over when a seated
 * player goes.
 *
 * No network needed: a FakeNet whose roster and incumbent we set by hand
 * exercises the whole path, and manualTimers keeps the sim deterministic.
 */
import { describe, expect, it } from 'vitest';
import type { Net, PeerId } from '../src/engine/net';
import { NetRoyale } from '../src/net-game';

class FakeNet implements Net {
  readonly selfId: PeerId;
  private roster: PeerId[];
  /** The room's incumbent, exactly as net.ts reports it. Null = still settling. */
  private incumbent: PeerId | null;
  private handlers = new Map<string, Set<(d: unknown, from: PeerId) => void>>();
  sent: { name: string; data: unknown }[] = [];

  constructor(selfId: PeerId, roster: PeerId[], incumbent?: PeerId | null) {
    this.selfId = selfId;
    this.roster = roster;
    this.incumbent = incumbent === undefined ? roster[0] : incumbent;
  }
  /** net.ts hands the room to a survivor — min-id — when the host leaves. */
  setIncumbent(id: PeerId | null) {
    this.incumbent = id;
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
  host(): PeerId | null {
    return this.incumbent;
  }
  isHost() {
    return this.hostSettled() && this.host() === this.selfId;
  }
  hostSettled() {
    return this.incumbent !== null;
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
  it('the seated INCUMBENT drives the round, even when a seat sorts lower', () => {
    // There is one answer to "who is host": the room's incumbent. peerC minted
    // this room and holds it, so peerC runs the arena — reading authority off
    // the frozen roster instead (min-id => peerB) would put two different peers
    // in charge of the same round depending on which file you asked.
    const fake = new FakeNet('peerC', ['peerB', 'peerC'], 'peerC');
    const ng = royale(fake);
    ng.begin();
    expect(ng.getPhase()).toBe('play');

    const before = ng.getState().tick;
    ng.hostTick();
    expect(ng.getState().tick).toBe(before + 1);

    // …and peerB, the lower-sorting seat, must NOT also be driving it.
    const other = new FakeNet('peerB', ['peerB', 'peerC'], 'peerC');
    const ngB = royale(other);
    ngB.begin();
    expect(ngB.getPhase()).toBe('count'); // a client: its begin() is not the room's
    expect(other.sent.some((m) => m.name === 'snap')).toBe(false);
  });

  it('an UNSEATED incumbent never takes the round over', () => {
    // peerB is the seated host and is happily running the arena.
    const fake = new FakeNet('peerB', ['peerB', 'peerC'], 'peerB');
    const ng = royale(fake);
    ng.begin();
    expect(ng.getPhase()).toBe('play');

    // 'peerA' wandered in mid-round and then inherited the room — net.ts hands
    // it to the min-id survivor, which has no idea this arena exists. It holds
    // no NetRoyale at all, so if the seats defer to it the round dies.
    fake.arrive('peerA');
    fake.setIncumbent('peerA');
    ng.onRoster();
    ng.setHost(false); // net.onHostChange says peerA has the room, loudly

    // The seated host must keep driving, or the arena freezes for everyone.
    const before = ng.getState().tick;
    ng.hostTick();
    ng.hostTick();
    expect(ng.getState().tick).toBe(before + 2);
  });

  it('nobody drives the round until the room has settled', () => {
    // A peer that has heard nothing from the mesh must not appoint itself: that
    // is how two halves of a broken room each run their own arena.
    const fake = new FakeNet('peerB', ['peerB', 'peerC'], null);
    const ng = royale(fake);
    ng.begin();
    expect(ng.getPhase()).toBe('count');
    ng.hostTick();
    expect(ng.getState().tick).toBe(0);
    expect(fake.sent.some((m) => m.name === 'snap')).toBe(false);
  });

  it('a spectator cannot overwrite the arena with a snapshot', () => {
    const fake = new FakeNet('peerC', ['peerB', 'peerC'], 'peerB');
    const ng = royale(fake);
    fake.arrive('peerA'); // a spectator…
    fake.setIncumbent('peerA'); // …who has even been handed the room
    const before = JSON.stringify(ng.getState());

    ng.setHost(false);
    fake.deliver('snap', { state: { grid: 1, snakes: [] }, phase: 'over', count: 0 }, 'peerA');

    // Only the round's host — peerB — may rewrite this peer's state.
    expect(JSON.stringify(ng.getState())).toBe(before);
    expect(ng.getPhase()).not.toBe('over');
  });

  it('still hands over when a SEATED host leaves', () => {
    const fake = new FakeNet('peerC', ['peerB', 'peerC'], 'peerB');
    const ng = royale(fake);
    expect(fake.sent.some((m) => m.name === 'snap')).toBe(false); // client: silent

    fake.part('peerB'); // the seated host closes its tab
    fake.setIncumbent('peerC'); // net.ts promotes the min-id survivor
    ng.onRoster();

    // peerC is now the smallest seat still present: it must pick the round up.
    ng.begin();
    expect(ng.getPhase()).toBe('play');
    const before = ng.getState().tick;
    ng.hostTick();
    expect(ng.getState().tick).toBe(before + 1);
  });

  it('a seated host ignores input from a peer outside the roster', () => {
    const fake = new FakeNet('peerB', ['peerB', 'peerC'], 'peerB');
    const ng = royale(fake);
    ng.begin();
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
    ng.begin();
    ng.destroy();

    const before = ng.getState().snakes[1].pending;
    fake.deliver('in', { dir: 'down' }, 'peerC');
    expect(ng.getState().snakes[1].pending).toBe(before);
  });
});
