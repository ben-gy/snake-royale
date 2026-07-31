/**
 * lobby-host-offer.test.ts — the way out of a lobby that will never settle.
 *
 * net.ts refuses to self-elect on a roster of one, and that is correct: silence
 * means "no mesh formed", not "the room is empty", and a peer that assumed the
 * latter became a phantom host which stole a live room when the partition
 * healed. The honest cost of that rule is one dead end — follow an invite link
 * to a room whose host has not turned up, and nothing will ever settle. Before
 * this, that was a spinner with no button on it.
 *
 * So the room is offered, never taken: the button appears only after a long
 * wait, only while genuinely alone, and only a tap calls takeover().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLobby } from '@ben-gy/game-engine/lobby';
import type { Net, NetDiag, PeerId } from '@ben-gy/game-engine/net';
import type { Rounds, RoundsState } from '@ben-gy/game-engine/rematch';

function fakeNet(over: Partial<Net> = {}): Net & { takeovers: number } {
  const takeoverSpy = { n: 0 };
  const net = {
    selfId: 'self' as PeerId,
    peers: () => ['self'],
    host: () => null,
    isHost: () => false,
    hostSettled: () => false,
    hostEpoch: () => 0,
    count: () => 1,
    onPeersChange: () => () => {},
    takeover: () => {
      takeoverSpy.n++;
    },
    netDiag: (): NetDiag => ({
      selfId: 'self',
      host: null,
      epoch: 0,
      settled: false,
      peers: ['self'],
      relaySockets: {},
      turn: true,
    }),
    channel: <T>() => {
      const send = ((_d: T, _to?: PeerId | PeerId[]) => {}) as ((
        d: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: () => void };
      send.off = () => {};
      return send;
    },
    ping: async () => 0,
    leave: async () => {},
    ...over,
  } as Net;
  return Object.defineProperty(net, 'takeovers', { get: () => takeoverSpy.n }) as Net & {
    takeovers: number;
  };
}

const waitingState: RoundsState = {
  round: 0,
  phase: 'waiting',
  votes: [],
  present: [{ id: 'self', name: 'Me' }],
  voted: false,
  seated: false,
  isHost: false,
  canStart: false,
  hostOpts: null,
  startsInMs: null,
};

function fakeRounds(state: RoundsState = waitingState): Rounds {
  return {
    vote: () => {},
    unvote: () => {},
    go: () => {},
    finish: () => {},
    state: () => state,
    destroy: () => {},
  } as unknown as Rounds;
}

function mount(net: Net): { container: HTMLElement; destroy: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const lobby = createLobby({
    container,
    net,
    rounds: fakeRounds(),
    roomCode: 'K7QP',
    minPlayers: 2,
    maxPlayers: 6,
  });
  return { container, destroy: () => lobby.destroy() };
}

const offer = (c: HTMLElement): HTMLButtonElement | null =>
  c.querySelector<HTMLButtonElement>('.lobby-host');

describe('a lobby that never settles', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a spinner first — the room may still be forming', () => {
    const { container, destroy } = mount(fakeNet());
    expect(container.querySelector('.lobby-searching')).toBeTruthy();
    expect(offer(container)).toBeNull();

    // Ten seconds in, still no offer: taking the room this early is exactly the
    // impatience that produced two hosts of the same room.
    vi.advanceTimersByTime(10_000);
    expect(offer(container)).toBeNull();
    destroy();
  });

  it('offers the room after a long lonely wait, and only on a tap', () => {
    const net = fakeNet();
    const { container, destroy } = mount(net);

    vi.advanceTimersByTime(16_000);
    const btn = offer(container);
    expect(btn).toBeTruthy();
    // Appearing is not taking. Nothing has been claimed yet.
    expect(net.takeovers).toBe(0);

    btn!.click();
    expect(net.takeovers).toBe(1);
    destroy();
  });

  it('never offers the room while somebody else is in it', () => {
    // Two peers present but unsettled means the mesh IS forming — the incumbent
    // just has not been heard from. Minting a rival term here is the theft the
    // epoch model exists to prevent.
    const net = fakeNet({ count: () => 2, peers: () => ['self', 'other'] });
    const { container, destroy } = mount(net);

    vi.advanceTimersByTime(30_000);
    expect(offer(container)).toBeNull();
    expect(net.takeovers).toBe(0);
    destroy();
  });

  it('never offers the room once it has settled', () => {
    const net = fakeNet({ hostSettled: () => true, host: () => 'other' });
    const { container, destroy } = mount(net);

    vi.advanceTimersByTime(30_000);
    expect(offer(container)).toBeNull();
    destroy();
  });
});
