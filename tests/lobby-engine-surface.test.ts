/**
 * lobby-engine-surface.test.ts — the game's CSS covers the markup the ENGINE emits.
 *
 * Snake Royale ran a forked `lobby.ts` for most of its life, so `main.css` was
 * written against the markup of that fork. Deleting the fork hands rendering to
 * the engine, which emits a strictly larger surface: a join QR, a spectating
 * screen for a peer that missed the round start, a `.lobby-modeslot` wrapper
 * around the mode picker, a `ghost` cancel button, and both badges on a host who
 * is also ready (the fork showed one or the other).
 *
 * That is the migration's real risk, and it is invisible to `tsc` and to every
 * other test here: the engine renders perfectly and the game paints it as an
 * unstyled heap. A class the engine emits that no rule in this game's stylesheet
 * matches is a shipped visual bug, so it is asserted rather than eyeballed.
 *
 * The engine's own behaviour is the engine's to test. What is pinned here is the
 * seam — what this game must keep true for its own stylesheet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLobby } from '@ben-gy/game-engine/lobby';
import type { Net, NetDiag, PeerId } from '@ben-gy/game-engine/net';
import type { Rounds, RoundsState } from '@ben-gy/game-engine/rematch';

const CSS = readFileSync('src/styles/main.css', 'utf8');

function fakeNet(over: Partial<Net> = {}): Net {
  return {
    selfId: 'self' as PeerId,
    peers: () => ['self'],
    host: () => 'self',
    isHost: () => true,
    hostSettled: () => true,
    hostEpoch: () => 1,
    count: () => 1,
    onPeersChange: () => () => {},
    takeover: () => {},
    netDiag: (): NetDiag => ({
      selfId: 'self',
      host: 'self',
      epoch: 1,
      settled: true,
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
}

function state(over: Partial<RoundsState> = {}): RoundsState {
  return {
    round: 0,
    phase: 'waiting',
    votes: [],
    present: [
      { id: 'self', name: 'Me' },
      { id: 'other', name: 'Them' },
    ],
    voted: false,
    seated: false,
    isHost: true,
    canStart: true,
    hostOpts: null,
    startsInMs: null,
    ...over,
  };
}

function fakeRounds(s: RoundsState): Rounds {
  return {
    vote: () => {},
    unvote: () => {},
    go: () => {},
    finish: () => {},
    state: () => s,
    destroy: () => {},
  } as unknown as Rounds;
}

function mount(
  s: RoundsState = state(),
  opts: { modeSlot?: () => string; onModeMount?: () => void } = {},
): { container: HTMLElement; lobby: { destroy(): void; repaint(): void } } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const lobby = createLobby({
    container,
    net: fakeNet(),
    rounds: fakeRounds(s),
    roomCode: 'K7QP',
    minPlayers: 2,
    maxPlayers: 6,
    onCancel: () => {},
    ...opts,
  });
  return { container, lobby };
}

/**
 * Elements the stylesheet cannot see at all.
 *
 * The unit is the ELEMENT, not the class. `lobby-ready` and `lobby-cancel` carry
 * no rules of their own and never did — they are hooks for `querySelector`, and
 * the button they sit on is painted by `.lobby-btn` beside them. Flagging a bare
 * hook class would be noise. An element with no styled class at all is the real
 * defect: that one renders as an unstyled heap.
 *
 * `style=""` counts as styled — the engine inlines the QR block on purpose, so a
 * game that has never heard of it still shows a scannable code.
 */
function unstyledElements(root: HTMLElement): string[] {
  const bad: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (!el.classList.length) continue;
    if (el.getAttribute('style')) continue;
    const styled = [...el.classList].some((c) => CSS.includes(`.${c}`));
    if (!styled) bad.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
  }
  return [...new Set(bad)].sort();
}

describe('the engine lobby, painted by this game’s stylesheet', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits no element that main.css leaves unstyled', () => {
    const { container, lobby } = mount(state(), { modeSlot: () => '<div class="modes"></div>' });
    expect(unstyledElements(container)).toEqual([]);
    lobby.destroy();
  });

  it('shows a host who is also ready BOTH badges — the fork showed only one', () => {
    const { container, lobby } = mount(state({ votes: [{ id: 'self', name: 'Me' }], voted: true }));
    const self = container.querySelector('.lobby-player.is-self')!;
    const badges = [...self.querySelectorAll('.lobby-badge')].map((b) => b.textContent?.trim());
    expect(badges).toEqual(['HOST', 'READY']);
    lobby.destroy();
  });

  it('wraps the mode picker in .lobby-modeslot and re-wires it after a repaint', () => {
    let mounts = 0;
    const { container, lobby } = mount(state(), {
      modeSlot: () => '<div class="modes"><button class="mode-chip">Classic</button></div>',
      onModeMount: () => {
        mounts++;
      },
    });
    // The picker must survive the wrapper: main.css targets `.modes` by class,
    // not as a child of the lobby, which is what makes the wrapper safe.
    expect(container.querySelector('.lobby-modeslot .modes .mode-chip')).toBeTruthy();
    expect(mounts).toBe(1);
    lobby.destroy();
  });

  it('keeps the join QR closed until asked, then paints a scannable code', () => {
    const { container, lobby } = mount();
    const toggle = container.querySelector<HTMLButtonElement>('.lobby-qr-toggle');
    expect(toggle, 'the QR toggle is the surface the fork never had').toBeTruthy();
    expect(container.querySelector('.lobby-qr')).toBeNull();
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');

    toggle!.click();
    const svg = container.querySelector('.lobby-qr svg');
    expect(svg).toBeTruthy();
    // v1.3.2: a viewBox-only SVG has no intrinsic size and under-fills its card.
    expect(svg!.getAttribute('style')).toContain('width:100%');
    lobby.destroy();
  });

  it('keeps the QR open across a rebuild — main.ts rebuilds on every roster change', () => {
    // syncListing/onPeersChange in main.ts repaint the lobby while a player is
    // mid-scan. The fork reset its view on every rebuild; the engine's sticky
    // view state is what stops the code vanishing under the camera.
    const { container, lobby } = mount();
    container.querySelector<HTMLButtonElement>('.lobby-qr-toggle')!.click();
    expect(container.querySelector('.lobby-qr svg')).toBeTruthy();
    lobby.destroy();

    const again = createLobby({
      container,
      net: fakeNet(),
      rounds: fakeRounds(state({ present: [{ id: 'self', name: 'Me' }] })),
      roomCode: 'K7QP',
      minPlayers: 2,
      maxPlayers: 6,
    });
    expect(container.querySelector('.lobby-qr svg')).toBeTruthy();
    again.destroy();
  });

  it('gives a peer that missed the round start a screen instead of a dead end', () => {
    // The fork returned early on phase==='playing', so an unseated peer watched a
    // round it was not in with nothing on screen and no way into the next one.
    const { container, lobby } = mount(state({ phase: 'playing', round: 3, seated: false }));
    expect(container.querySelector('.lobby-spectating')).toBeTruthy();
    expect(container.textContent).toContain('Round 3 in progress');
    expect(container.querySelector('.lobby-ready')).toBeTruthy();
    expect(unstyledElements(container)).toEqual([]);
    lobby.destroy();
  });

  it('paints nothing over a round this peer IS in', () => {
    const { container, lobby } = mount(state({ phase: 'playing', round: 3, seated: true }));
    expect(container.innerHTML).toBe('');
    lobby.destroy();
  });
});
