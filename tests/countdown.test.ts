/**
 * countdown.test.ts — the 3-2-1 between the round arriving and the snakes moving.
 *
 * Two separate promises, and they are easy to confuse:
 *
 *   1. LOCAL: every peer counts its own 3-2-1 from the moment the host's start
 *      arrived. No digits on the wire.
 *   2. AUTHORITATIVE: only the host's count actually starts the arena. A guest's
 *      clock running out does not move anyone's snake — otherwise a peer with a
 *      fast local timer plays two ticks of a round nobody else has started.
 *
 * The last test here is the seam between them, and it is the one that would
 * hang a room forever rather than merely look wrong.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCountdown } from '../src/countdown';
import { NetRoyale } from '../src/net-game';
import type { Net, PeerId } from '../src/engine/net';
import type { Sfx, SfxName } from '../src/engine/sound';

/** The same shape round-authority.test.ts uses: roster and incumbent set by hand,
 *  no network, so the count/play seam is exercised deterministically. */
class FakeNet implements Net {
  readonly selfId: PeerId;
  private roster: PeerId[];
  private incumbent: PeerId | null;
  private handlers = new Map<string, Set<(d: unknown, from: PeerId) => void>>();
  sent: { name: string; data: unknown }[] = [];

  constructor(selfId: PeerId, roster: PeerId[], incumbent?: PeerId | null) {
    this.selfId = selfId;
    this.roster = roster;
    this.incumbent = incumbent === undefined ? roster[0] : incumbent;
  }
  setIncumbent(id: PeerId | null) {
    this.incumbent = id;
  }
  part(id: PeerId) {
    this.roster = this.roster.filter((p) => p !== id);
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

function fakeSfx(): Sfx & { played: SfxName[] } {
  return {
    played: [] as SfxName[],
    unlock() {},
    play(n: SfxName) {
      this.played.push(n);
    },
    muted: () => false,
    setMuted() {},
  };
}

describe('createCountdown', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
    vi.useFakeTimers();
  });

  it('counts 3-2-1 then GO, and only then hands over the round', () => {
    const sfx = fakeSfx();
    const onDone = vi.fn();
    createCountdown({ root, sfx, everyMs: 1000, onDone });

    expect(root.querySelector('.cd-num')!.textContent).toBe('3');
    expect(onDone).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(root.querySelector('.cd-num')!.textContent).toBe('2');
    vi.advanceTimersByTime(1000);
    expect(root.querySelector('.cd-num')!.textContent).toBe('1');
    vi.advanceTimersByTime(1000);
    expect(root.querySelector('.cd-num')!.textContent).toBe('GO');
    // Still not started: GO is a beat you can see, not a label on a moving arena.
    expect(onDone).not.toHaveBeenCalled();

    vi.advanceTimersByTime(450);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.countdown')).toBeNull(); // cleans up after itself
  });

  it('sounds each tick and a different note on GO', () => {
    // Players watch the arena, not the overlay: the pips ARE the countdown for
    // them, so a silent one is not a countdown at all.
    const sfx = fakeSfx();
    createCountdown({ root, sfx, everyMs: 1000, onDone: () => {} });
    vi.advanceTimersByTime(3000);
    expect(sfx.played).toEqual(['beep', 'beep', 'beep', 'go']);
  });

  it('rises in pitch across the count', () => {
    // The ear tracks the count without reading it — but only if it climbs.
    const pitches: number[] = [];
    const sfx: Sfx = {
      unlock() {},
      play(_n, p) {
        if (p !== undefined) pitches.push(p);
      },
      muted: () => false,
      setMuted() {},
    };
    createCountdown({ root, sfx, everyMs: 1000, onDone: () => {} });
    vi.advanceTimersByTime(2000);
    expect(pitches).toHaveLength(3);
    expect(pitches[1]).toBeGreaterThan(pitches[0]);
    expect(pitches[2]).toBeGreaterThan(pitches[1]);
  });

  it('cancel() stops the clock, the sound and the start', () => {
    // A player who tapped Menu mid-count must not hear pips over the menu, and
    // must certainly not have onDone start a round underneath them.
    const sfx = fakeSfx();
    const onDone = vi.fn();
    const cd = createCountdown({ root, sfx, everyMs: 1000, onDone });
    vi.advanceTimersByTime(1000);
    const heard = sfx.played.length;

    cd.cancel();
    vi.advanceTimersByTime(10_000);

    expect(onDone).not.toHaveBeenCalled();
    expect(sfx.played.length).toBe(heard);
    expect(root.querySelector('.countdown')).toBeNull();
  });

  it('cancel() after GO cannot start the round late', () => {
    const onDone = vi.fn();
    const cd = createCountdown({ root, sfx: fakeSfx(), everyMs: 1000, onDone });
    vi.advanceTimersByTime(3000); // showing GO, 450ms still to run
    cd.cancel();
    vi.advanceTimersByTime(1000);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('drops the pop animation when the player asked for reduced motion', () => {
    createCountdown({ root, sfx: fakeSfx(), reducedMotion: true, onDone: () => {} });
    expect(root.querySelector('.countdown')!.classList.contains('reduced')).toBe(true);
  });
});

describe('the countdown and the arena', () => {
  function royale(fake: FakeNet, onUpdate = () => {}): NetRoyale {
    return new NetRoyale({
      net: fake,
      seed: 7,
      grid: 22,
      seats: ['peerA', 'peerB'],
      players: [
        { name: 'A', color: 0 },
        { name: 'B', color: 1 },
      ],
      manualTimers: true,
      onUpdate,
    });
  }

  it('keeps every snake still until the host says go', () => {
    const fake = new FakeNet('peerA', ['peerA', 'peerB'], 'peerA');
    const ng = royale(fake);
    expect(ng.getPhase()).toBe('count');
    ng.hostTick();
    ng.hostTick();
    expect(ng.getState().tick).toBe(0);
    ng.begin();
    ng.hostTick();
    expect(ng.getState().tick).toBe(1);
    ng.destroy();
  });

  it('does not let a guest\'s local clock start the arena', () => {
    // Guests count too — but their 3-2-1 only draws digits. If a guest's begin()
    // moved snakes, a peer with a fast timer would play a round nobody else had
    // started yet, and its optimistic state would fight every snapshot.
    const fake = new FakeNet('peerB', ['peerA', 'peerB'], 'peerA');
    const ng = royale(fake);
    ng.begin();
    expect(ng.getPhase()).toBe('count');
    expect(fake.sent.some((m) => m.name === 'snap')).toBe(false);
    ng.destroy();
  });

  it('starts the arena for a peer promoted AFTER its own countdown ran out', () => {
    // The gap that hangs a room forever. Our local count finishes while we are
    // still a guest, so begin() is refused — correctly. Then the host leaves
    // before its own count ended. Nobody is left who is both host and still
    // counting: without remembering the request, every peer sits at 3-2-1 waiting
    // on a start that can never come.
    const fake = new FakeNet('peerB', ['peerA', 'peerB'], 'peerA');
    const ng = royale(fake);

    ng.begin(); // our countdown ended; not ours to grant yet
    expect(ng.getPhase()).toBe('count');

    fake.part('peerA'); // peerA left; net.ts promotes the survivor
    fake.setIncumbent('peerB');
    ng.setHost(true);

    expect(ng.getPhase()).toBe('play');
    expect(fake.sent.some((m) => m.name === 'snap')).toBe(true);
    ng.destroy();
  });

  it('does not start the arena on promotion if our countdown is still running', () => {
    // The mirror of the above: inheriting the room mid-count must not skip the
    // beat everyone else is still watching.
    const fake = new FakeNet('peerB', ['peerA', 'peerB'], 'peerA');
    const ng = royale(fake);

    fake.part('peerA');
    fake.setIncumbent('peerB');
    ng.setHost(true);

    expect(ng.getPhase()).toBe('count');
    ng.destroy();
  });
});
