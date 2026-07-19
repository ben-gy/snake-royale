/**
 * turn-wiring.test.ts — every mesh this page opens carries TURN, whichever one
 * the player opens first.
 *
 * WHY THIS IS ITS OWN FILE. Without TURN relays, ICE is STUN-only, and a phone
 * on carrier-grade NAT never opens a data channel: both players sit in the same
 * room code looking at an empty lobby. Passing a turnConfig to the game room is
 * not enough, because Trystero allocates ONE page-wide pool of peer connections
 * from the config of whichever joinRoom fires FIRST. This game can open the
 * public noticeboard mesh (Browse public games) long before any room exists, so
 * a board join that arrived turnless would leave the initiating half of every
 * later pair STUN-only — TURN working in one direction, for about half of all
 * pairs, which is far harder to diagnose than no TURN at all.
 *
 * So the assertion is not "the room got TURN". It is "the FIRST join got TURN",
 * asserted separately down each of the two paths that can be first.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** What the stubbed credential Worker hands back. */
const TURN_URLS = 'turn:relay.test:3478';

/** Every joinRoom call, in order, with the ICE config Trystero was handed. */
interface Join {
  roomId: string;
  turnConfig: unknown;
}
const joins: Join[] = [];

vi.mock('trystero', () => ({
  selfId: 'self-test',
  joinRoom: (cfg: { turnConfig?: unknown }, roomId: string) => {
    joins.push({ roomId, turnConfig: cfg.turnConfig });
    return {
      makeAction: () => [() => {}, () => {}, () => {}],
      onPeerJoin: () => {},
      onPeerLeave: () => {},
      getPeers: () => ({}),
      leave: () => {},
      ping: async () => 0,
    };
  },
}));

// The real credential Worker, stubbed: a test must not depend on someone else's
// DNS. The shape is what matters — main.ts must install whatever comes back
// before it opens anything.
vi.mock('@ben-gy/game-engine/turn', () => ({
  getTurnConfig: async () => [{ urls: 'turn:relay.test:3478', username: 'u', credential: 'c' }],
}));

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function boot(): Promise<void> {
  joins.length = 0;
  history.replaceState(null, '', '/');
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  await import('../src/main');
  await tick();
  // main.ts opens How to play on a first visit; it sits over everything.
  document.querySelector<HTMLButtonElement>('.modal-close')?.click();
}

const click = (sel: string): void => {
  const el = document.querySelector<HTMLButtonElement>(sel);
  if (!el) throw new Error(`no ${sel} on screen`);
  el.click();
};

/** The relay urls Trystero was given for a join, flattened for assertion. */
function urlsOf(join: Join): string[] {
  const servers = (join.turnConfig ?? []) as { urls?: string | string[] }[];
  return servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : s.urls ? [s.urls] : []));
}

describe('TURN reaches the mesh', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('carries relays into a room join', async () => {
    await boot();
    click('[data-act="friends"]');
    await tick();
    click('.re-create');
    await tick();

    expect(joins).toHaveLength(1);
    expect(urlsOf(joins[0])).toContain(TURN_URLS);
  });

  it('carries relays into the noticeboard too — the mesh that is often FIRST', async () => {
    await boot();
    click('[data-act="friends"]');
    await tick();
    // Browsing public games opens a mesh of strangers before any room exists.
    // If this one is turnless, it poisons the pool for the room that follows.
    click('.re-browse');
    await tick();

    expect(joins.length).toBeGreaterThan(0);
    expect(urlsOf(joins[0])).toContain(TURN_URLS);
  });

  it('still opens rooms with TURN once the board has already gone first', async () => {
    await boot();
    click('[data-act="friends"]');
    await tick();
    click('.re-browse');
    await tick();
    // "Create a room instead", straight off the browse screen — the room mesh
    // now follows a board mesh that already exists.
    click('.re-make');
    await tick();

    // Every join on the page, in the order Trystero saw them.
    expect(joins.length).toBeGreaterThanOrEqual(2);
    for (const j of joins) expect(urlsOf(j)).toContain(TURN_URLS);
  });
});
