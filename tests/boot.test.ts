/**
 * boot.test.ts — the app actually starts, and the screens it opens on are the
 * ones the privacy contract describes.
 *
 * Everything else in the suite tests a module in isolation, which means nothing
 * tests the wiring: main.ts could pass the wrong arguments to a lobby, render a
 * menu with no mode picker, or — the one that matters — mesh with strangers on
 * page load, and all 160-odd other tests would stay green. This drives the real
 * module graph in jsdom and asserts the things a first-time visitor gets.
 *
 * It deliberately never taps anything that opens a Net: no room is created and
 * no board is joined, because that is precisely the property being asserted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Trystero would try to reach a real relay from jsdom. Nothing here should get
 * as far as calling it, so it is stubbed rather than allowed to hang — and the
 * stub is what proves "no mesh at boot".
 *
 * The module specifier must match engine/net.ts's import EXACTLY ('trystero',
 * not 'trystero/nostr'): a mock on a path nothing imports is not a mock, it is a
 * test that always passes. That is not hypothetical — this file had it, and the
 * mutation that opened the board at boot sailed straight through.
 */
const joinRoom = vi.fn(() => ({
  makeAction: () => [() => {}, () => {}, () => {}],
  onPeerJoin: () => {},
  onPeerLeave: () => {},
  getPeers: () => ({}),
  leave: () => {},
  ping: async () => 0,
}));
vi.mock('trystero', () => ({ joinRoom, selfId: 'self-test' }));

/** Let queued microtasks AND timers run. The board is opened through a promise
 *  chain, so a synchronous expect() after a click asserts nothing at all. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

async function boot(): Promise<void> {
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  localStorage.clear();
  await import('../src/main');
  await settle();
}

describe('a first visit', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    joinRoom.mockClear();
  });

  it('boots to the menu without touching the network', async () => {
    await boot();
    expect(document.querySelector('.menu')).toBeTruthy();
    await settle();
    // The whole privacy promise in one assertion: opening the game meshes with
    // nobody. Not the noticeboard, not a room.
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it('offers the three arenas on the menu, with one selected', async () => {
    await boot();
    const chips = [...document.querySelectorAll('.mode-chip')];
    expect(chips.map((c) => c.textContent?.trim().split(/\s+/)[0])).toEqual([
      'Skirmish',
      'Royale',
      'Colossus',
    ]);
    expect(document.querySelectorAll('.mode-chip.on')).toHaveLength(1);
    expect(document.querySelector('.mode-blurb')!.textContent).toBeTruthy();
  });

  it('remembers the arena the player picked', async () => {
    await boot();
    const colossus = document.querySelector<HTMLElement>('.mode-chip[data-mode="colossus"]')!;
    colossus.click();
    expect(
      document.querySelector<HTMLElement>('.mode-chip.on')!.dataset.mode,
    ).toBe('colossus');
    // …and survives a reload, so the pick is a setting rather than a mood.
    expect(localStorage.getItem('game:snake-royale:mode')).toContain('colossus');
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it('keeps the footer pointing at the hub', async () => {
    await boot();
    const links = [...document.querySelectorAll('.site-footer a')].map((a) =>
      a.getAttribute('href'),
    );
    expect(links).toContain('https://hub.benrichardson.dev');
  });
});

describe('“Play with friends” — before any room exists', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    joinRoom.mockClear();
  });

  it('shows private/public with the IP cost stated at BOTH opt-ins, and joins nothing', async () => {
    await boot();
    document.querySelector<HTMLElement>('[data-act="friends"]')!.click();
    await settle();

    // Private is preselected — a public room has to be reached for.
    const on = document.querySelector<HTMLElement>('.vis-chip.on')!;
    expect(on.dataset.pub).toBe('0');
    expect(document.querySelector('.re-create')!.textContent).toContain('private');

    const notes = [...document.querySelectorAll('.re-note')].map((n) => n.textContent ?? '');
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n).toMatch(/IP address/);

    // Browse exists but has not been tapped, so no mesh of strangers.
    expect(document.querySelector('.re-browse')).toBeTruthy();
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it('says "public" on the create button only once Public is chosen', async () => {
    await boot();
    document.querySelector<HTMLElement>('[data-act="friends"]')!.click();
    document.querySelector<HTMLElement>('.vis-chip[data-pub="1"]')!.click();
    await settle();
    expect(document.querySelector('.re-create')!.textContent).toContain('public');
    expect(joinRoom).not.toHaveBeenCalled();
  });
});

describe('About', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    joinRoom.mockClear();
  });

  it('explains the public-room IP cost without weakening the no-tracking claims', async () => {
    await boot();
    document.querySelector<HTMLElement>('[data-act="about"]')!.click();
    const text = document.querySelector('.modal-body')!.textContent!;
    expect(text).toMatch(/private by default/i);
    expect(text).toMatch(/IP address/);
    expect(text).toMatch(/No cookies, no tracking/i);
  });
});
