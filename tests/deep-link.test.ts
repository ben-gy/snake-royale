/**
 * deep-link.test.ts — an invite link must actually land you in the room.
 *
 * This one boots the real main.ts, because the bug it pins is an ORDERING trap
 * that no unit of it can show on its own: leaveRoom() now clears ?room= from the
 * URL (so a reload cannot silently rejoin a room you left), and "Play with
 * friends" leaves any old room BEFORE it opens the next one. Reading the invite
 * code from the URL at that point reads a parameter its own cleanup just
 * deleted, so every invite link quietly fell through to the create/join screen —
 * the link looked like it worked and simply did not.
 *
 * Trystero is stubbed: this is our routing, and it must not need a relay.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TURN, stubbed. main.ts fetches ICE servers at boot (before any mesh exists),
 * and these cases are about routing and privacy, not infra — a test that made a
 * real HTTPS request to the credential Worker would be slow, offline-fragile,
 * and would time its own assertions against someone else's DNS. Resolving empty
 * is exactly the fail-open path production takes when the Worker is
 * unreachable, so nothing here is being papered over. tests/turn-wiring.test.ts
 * owns the ordering guarantee itself.
 */
vi.mock('@ben-gy/game-engine/turn', () => ({ getTurnConfig: async () => [] }));

const joined: string[] = [];

function stubRoom() {
  return {
    getPeers: () => ({}),
    makeAction: () => [() => {}, () => {}],
    onPeerJoin: () => {},
    onPeerLeave: () => {},
    leave: async () => {},
  };
}

async function boot(url: string): Promise<void> {
  joined.length = 0;
  history.replaceState(null, '', url);
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  vi.doMock('trystero', () => ({
    selfId: 'self',
    joinRoom: (_c: unknown, roomId: string) => {
      joined.push(roomId);
      return stubRoom();
    },
  }));
  await import('../src/main');
}

/** main.ts auto-opens How to play on a first visit; it sits over everything. */
const dismissModal = (): void => {
  document.querySelector<HTMLButtonElement>('.modal-close')?.click();
};

const click = (sel: string): void => {
  const el = document.querySelector<HTMLButtonElement>(sel);
  if (!el) throw new Error(`no ${sel} on screen`);
  el.click();
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('an invite link', () => {
  it('joins the room from ?room= instead of showing the create/join screen', async () => {
    await boot('/?room=K7QP');
    dismissModal();
    click('[data-act="friends"]');
    await tick();

    // The create/join screen appearing here IS the bug: the player followed a
    // link to a specific room and was silently asked to make a new one.
    expect(document.querySelector('.room-entry')).toBeNull();
    expect(joined).toEqual(['K7QP']);
  });

  it('normalizes a hand-shared code before joining', async () => {
    await boot('/?room=k7-qp');
    dismissModal();
    click('[data-act="friends"]');
    await tick();
    expect(joined).toEqual(['K7QP']);
  });

  it('is honoured ONCE — going back for a second game offers a fresh room', async () => {
    await boot('/?room=K7QP');
    dismissModal();
    click('[data-act="friends"]');
    await tick();

    click('[data-act="back"]'); // ‹ Menu — leaves the room for good
    await tick();
    expect(new URL(location.href).searchParams.has('room')).toBe(false);

    click('[data-act="friends"]');
    await tick();
    // The link must not be the only way in, and it must not drag the player
    // back into a room they deliberately left.
    expect(document.querySelector('.room-entry')).not.toBeNull();
  });

  it('shows the create/join screen when there is no link', async () => {
    await boot('/');
    dismissModal();
    click('[data-act="friends"]');
    await tick();
    expect(document.querySelector('.room-entry')).not.toBeNull();
    expect(joined).toEqual([]);
  });
});
