/**
 * seating.test.ts — seats come from the host's frozen roster, and the results
 * screen has a real story to tell.
 *
 * Seat drift: the lobby used to hand each peer `players()` derived from its OWN
 * presence map at the instant 'go' arrived, then main.ts sorted it locally. A
 * peer whose presence map was one gossip message behind built a different seat
 * list — so two players disagreed about who was which snake, and the scores
 * landed on the wrong names. createRounds freezes ONE roster into the start
 * message instead; these tests pin that the seating is a pure function of it.
 */
import { describe, expect, it } from 'vitest';
import { createRounds } from '../src/engine/rematch';
import type { Net, PeerId } from '../src/engine/net';
import { createRoyale, ranking, stepRoyale, type Snake } from '../src/game';
import { makeRng } from '../src/engine/rng';

/** Shared synchronous bus — protocol decisions, not timing. */
class Bus {
  peers = new Map<PeerId, Map<string, Set<(d: unknown, from: PeerId) => void>>>();
  join(id: PeerId) {
    this.peers.set(id, new Map());
  }
  roster() {
    return [...this.peers.keys()].sort();
  }
  send(from: PeerId, name: string, data: unknown, to?: PeerId | PeerId[]) {
    const targets = to ? (Array.isArray(to) ? to : [to]) : this.roster().filter((p) => p !== from);
    for (const t of targets) for (const h of this.peers.get(t)?.get(name) ?? []) h(data, from);
  }
  on(id: PeerId, name: string, h: (d: unknown, from: PeerId) => void) {
    const chans = this.peers.get(id)!;
    if (!chans.has(name)) chans.set(name, new Set());
    chans.get(name)!.add(h);
    return () => chans.get(name)!.delete(h);
  }
}

function mockNet(bus: Bus, selfId: PeerId): Net {
  bus.join(selfId);
  return {
    selfId,
    peers: () => bus.roster(),
    host: () => bus.roster()[0],
    isHost: () => bus.roster()[0] === selfId,
    count: () => bus.roster().length,
    channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
      const off = bus.on(selfId, name, onReceive as (d: unknown, from: PeerId) => void);
      const send = ((data: T, to?: PeerId | PeerId[]) => bus.send(selfId, name, data, to)) as ((
        data: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: () => void };
      send.off = off;
      return send;
    },
    ping: async () => 0,
    leave: async () => {},
  };
}

/** Exactly what main.ts's enterMpGame does with the frozen roster. */
const seatsOf = (players: { id: string; name: string }[]) => players.map((p) => p.id);

/** Stand up N peers on one bus, capturing the seats each one derives. */
function table(ids: string[], minPlayers: number) {
  const bus = new Bus();
  const seats = new Map<string, string[]>();
  const rounds = ids.map((id) => {
    const net = mockNet(bus, id);
    return {
      id,
      net,
      r: createRounds({
        net,
        playerName: id.toUpperCase(),
        minPlayers,
        onRound: ({ players }) => seats.set(id, seatsOf(players)),
      }),
    };
  });
  return { bus, seats, rounds };
}

describe('seating from the frozen roster', () => {
  it('every peer derives the SAME seats, in the same order', () => {
    const { seats, rounds } = table(['peerC', 'peerA', 'peerB'], 3);
    rounds.forEach((p) => p.r.vote());

    // Seat N is the same player on every peer — this is what stops a score
    // landing on the wrong snake.
    expect(seats.get('peerA')).toEqual(['peerA', 'peerB', 'peerC']);
    expect(seats.get('peerB')).toEqual(seats.get('peerA'));
    expect(seats.get('peerC')).toEqual(seats.get('peerA'));
  });

  it('seats a player at the index the HOST chose, not one it re-derives', () => {
    const { seats, rounds } = table(['peerB', 'peerA'], 2);
    rounds.forEach((p) => p.r.vote());

    // peerB looking itself up in its own copy of the roster must land on the
    // same seat peerA would give it. Drift here = your rival drives your snake.
    const asSelf = seats.get('peerB')!.indexOf('peerB');
    const asRival = seats.get('peerA')!.indexOf('peerB');
    expect(asSelf).toBe(asRival);
    expect(asSelf).toBeGreaterThanOrEqual(0);
  });

  it('leaves a peer that joined after the start OUT of the seats', () => {
    const { bus, seats, rounds } = table(['peerB', 'peerC'], 2);
    rounds.forEach((p) => p.r.vote());

    // 'peerA' arrives once the arena is already running. It is not seated, so
    // main.ts sends it to the lobby rather than letting it play as seat 0.
    bus.join('peerA');
    expect(seats.get('peerB')).toEqual(['peerB', 'peerC']);
    expect(seats.get('peerB')!.includes('peerA')).toBe(false);
    expect(seats.has('peerA')).toBe(false);
  });
});

describe('results breakdown (factory principle #9)', () => {
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

  it('records a wall death', () => {
    const state = createRoyale(1, { grid: 22, mode: 'royale', players: [], foodTarget: 0 });
    state.snakes = [
      mk(0, [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }], 'left'),
      mk(1, [{ x: 15, y: 15 }, { x: 15, y: 16 }, { x: 15, y: 17 }], 'up'),
    ];
    state.startCount = 2;
    state.food = [];
    stepRoyale(state, makeRng(1));
    expect(state.snakes[0].death).toBe('wall');
    expect(state.snakes[0].killedBy).toBe(-1);
  });

  it('names the rival whose body you crashed into', () => {
    const state = createRoyale(1, { grid: 22, mode: 'royale', players: [], foodTarget: 0 });
    // Snake 0 heads right, straight into the middle of snake 1's vertical body.
    state.snakes = [
      mk(0, [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }], 'right'),
      mk(1, [{ x: 10, y: 9 }, { x: 10, y: 10 }, { x: 10, y: 11 }], 'up'),
    ];
    state.startCount = 2;
    state.food = [];
    stepRoyale(state, makeRng(1));
    expect(state.snakes[0].alive).toBe(false);
    expect(state.snakes[0].death).toBe('body');
    expect(state.snakes[0].killedBy).toBe(1);
  });

  it('records a head-on as mutual, naming each other', () => {
    const state = createRoyale(1, { grid: 22, mode: 'royale', players: [], foodTarget: 0 });
    // Two heads one cell apart, closing — both must land on x=10.
    state.snakes = [
      mk(0, [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }], 'right'),
      mk(1, [{ x: 11, y: 10 }, { x: 12, y: 10 }, { x: 13, y: 10 }], 'left'),
    ];
    state.startCount = 2;
    state.food = [];
    stepRoyale(state, makeRng(1));
    expect(state.snakes.map((s) => s.death)).toEqual(['head', 'head']);
    expect(state.snakes[0].killedBy).toBe(1);
    expect(state.snakes[1].killedBy).toBe(0);
  });

  it('leaves a survivor with no death recorded, and ranks it first', () => {
    const state = createRoyale(1, { grid: 22, mode: 'royale', players: [], foodTarget: 0 });
    state.snakes = [
      mk(0, [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }], 'left'),
      mk(1, [{ x: 15, y: 15 }, { x: 15, y: 16 }, { x: 15, y: 17 }], 'up'),
    ];
    state.startCount = 2;
    state.food = [];
    stepRoyale(state, makeRng(1));
    expect(state.snakes[1].death).toBeNull();
    expect(state.snakes[1].deadAt).toBe(-1);
    expect(ranking(state)[0]).toBe(1);
  });
});
