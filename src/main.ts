/**
 * main.ts — Snake Royale bootstrap and orchestration. Owns the screen router,
 * the solo (Endless) and multiplayer (Royale P2P) drivers, and the in-game
 * session that turns state updates into canvas paint + particles + sound.
 * Heavy rules live in game.ts; netcode in net-game.ts; drawing in render.ts.
 */

// feedback:begin (managed by hub/scripts/feedback/backfill.mjs)
import { mountFeedback } from './feedback';
mountFeedback();
// feedback:end

import './styles/mobile.css';
import './styles/main.css';
import {
  createRoyale,
  ranking,
  setDir,
  stepRoyale,
  type Dir,
  type RoyaleState,
} from './game';
import { makeRng, newSeed, type Rng } from '@ben-gy/game-engine/rng';
import { createSfx } from './sound';
import { createStore } from '@ben-gy/game-engine/storage';
import { createInput, type Input } from '@ben-gy/game-engine/input';
import { hardenViewport } from '@ben-gy/game-engine/mobile';
import { createNet, roomAppId, setTurnConfig, type Net } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type RoundPlayer, type Rounds } from '@ben-gy/game-engine/rematch';
import {
  clearRoomInUrl,
  createLobby,
  createListing,
  createRoomEntry,
  normalizeRoomCode,
  setRoomInUrl,
  P2P_IP_NOTE,
  type BoardAccess,
  type Listing,
} from './lobby';
import { createNoticeboard, type Noticeboard, type PublicRoom } from '@ben-gy/game-engine/noticeboard';
import { NetRoyale, type NetUpdate, type Phase } from './net-game';
import { CanvasView, SNAKE_COLORS } from './render';
import { createCountdown } from './countdown';
import {
  arenaFor,
  DEFAULT_MODE,
  foodTarget,
  MODE_LIST,
  modeOf,
  soloTickMs,
  type Mode,
  type ModeId,
} from './modes';
import {
  ABOUT_HTML,
  escapeHtml,
  FOOTER_HTML,
  friendsSetupHTML,
  HOWTO_HTML,
  menuHTML,
  openModal,
} from './ui';

const APP_ID = 'snake-royale';
/**
 * The appId every mesh on this page uses — the room, and the public noticeboard.
 * roomAppId() stamps the engine's wire revision onto the slug, so a player still
 * running a cached old build partitions cleanly instead of half-joining a room
 * whose protocol it does not speak. Storage keeps the raw slug: it is a local
 * namespace, not a wire identity, and settings should survive a protocol bump.
 */
const ROOM_APP_ID = roomAppId(APP_ID);
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const NAME_POOL = ['Fox', 'Wren', 'Sage', 'Koi', 'Lark', 'Bea', 'Nova', 'Pip', 'Ozzy', 'Rio'];

// Before anything renders: iOS ignores the viewport meta's user-scalable=no, so
// a double-tap or a pinch zooms a live arena with no way back out — and steering
// a snake is all fast repeated taps and swipes.
hardenViewport();

/**
 * TURN credentials, fetched once at boot and installed before ANY mesh exists.
 *
 * Without TURN, ICE is STUN-only and a phone on carrier CGNAT never opens a data
 * channel: both players sit in the same room code looking at an empty lobby.
 * The reason this runs at BOOT rather than at room join is Trystero: it builds a
 * single page-wide pool of peer connections from the config of whichever
 * joinRoom fires first, and this game can open the noticeboard mesh (Browse
 * public rooms) long before any room is joined. A TURN config installed after
 * that pool exists leaves the initiating half of every pair STUN-only — TURN
 * working in one direction only, which is harder to diagnose than no TURN at all.
 *
 * Nothing waits on the network to be playable: getTurnConfig() is
 * session-cached, times out in 3s, and fails open to [] (exactly today's
 * STUN-only behaviour). Both mesh-opening paths await this promise, which is
 * ordering, not blocking — it is already resolved by the time anyone taps.
 */
const turnReady: Promise<void> = getTurnConfig().then(
  (servers) => setTurnConfig(servers),
  () => {},
);

const store = createStore(APP_ID);
const settings = { muted: store.get('muted', false) };
const sfx = createSfx(settings.muted);
const reducedMotion =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const app = document.getElementById('app')!;
app.innerHTML = `<main class="main-content" id="content"></main>${FOOTER_HTML}`;
const content = document.getElementById('content')!;

let net: Net | null = null;
let rounds: Rounds | null = null;
let lobby: { destroy: () => void; repaint: () => void } | null = null;
let roomEntry: { destroy: () => void } | null = null;
let activeNet: NetRoyale | null = null;
let session: GameSession | null = null;
let countdown: { cancel: () => void } | null = null;
let listing: Listing | null = null;
let listingTick: number | undefined;
/** The room we are in, and whether it is on the public list. Private by default. */
let roomCode = '';
let roomPublic = false;
/** Rounds won per peer id, kept across rematches for as long as the room lives. */
let tally = new Map<string, number>();

/** The mode this player last chose. The HOST's choice is what a room plays. */
let modeId: ModeId = modeOf(store.get<string>('mode', DEFAULT_MODE)).id;

function setMode(id: ModeId): void {
  modeId = modeOf(id).id;
  store.set('mode', modeId);
}

// An invite link's ?room= is read ONCE, at boot, and honoured once. It cannot be
// read later from the URL: leaveRoom() clears the parameter on the way out of a
// room (so a reload does not silently rejoin), and "Play with friends" leaves
// any old room before it opens the next one — so by the time it looked, the code
// it wanted was already gone and every invite link fell through to the
// create/join screen.
let pendingRoom: string | null = (() => {
  const c = normalizeRoomCode(new URL(location.href).searchParams.get('room') ?? '');
  return c.length >= 3 ? c : null;
})();

const unlockOnce = () => {
  sfx.unlock();
  window.removeEventListener('pointerdown', unlockOnce);
  window.removeEventListener('keydown', unlockOnce);
};
window.addEventListener('pointerdown', unlockOnce);
window.addEventListener('keydown', unlockOnce);
window.addEventListener('beforeunload', () => {
  try {
    net?.leave();
  } catch {
    /* ignore */
  }
});

function playerName(): string {
  let n = store.get<string>('name', '');
  if (!n) {
    n = NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
    store.set('name', n);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Mode picker + public/private — the two host choices a room carries.
// ---------------------------------------------------------------------------

function modePicker(): string {
  const m = modeOf(modeId);
  return `
    <div class="modes" role="radiogroup" aria-label="Arena">
      ${MODE_LIST.map(
        (x) => `<button class="mode-chip${x.id === m.id ? ' on' : ''}" type="button"
          role="radio" aria-checked="${x.id === m.id}" data-mode="${x.id}">
          <span class="mode-name">${escapeHtml(x.name)}</span>
          <span class="mode-meta">${x.grid}×${x.grid} · ${x.tickMs}ms</span>
        </button>`,
      ).join('')}
      <p class="mode-blurb">${escapeHtml(m.blurb)}</p>
    </div>`;
}

function modeNote(): string {
  // The HOST's gossiped choice — never our own local pick. Rendering `modeId`
  // here would confidently tell a guest "Host picked Skirmish" while the host
  // was actually setting up a Colossus.
  const hostOpts = rounds?.state().hostOpts as
    | { mode?: unknown; pub?: unknown }
    | null
    | undefined;
  if (hostOpts == null) return `<p class="mode-note">Waiting for the host’s pick…</p>`;
  const m = modeOf(hostOpts.mode);
  return (
    `<p class="mode-note">Host picked <strong>${escapeHtml(m.name)}</strong> · ${m.grid}×${m.grid} · ${m.tickMs}ms per step</p>` +
    // Guests are in the host's arena too. Someone who was handed an invite link
    // has no way of knowing strangers can walk in unless we say so.
    (hostOpts.pub
      ? `<p class="mode-note pub">This room is listed publicly — anyone browsing can join.</p>`
      : '')
  );
}

function wireModePicker(repaint: () => void): void {
  for (const btn of content.querySelectorAll<HTMLButtonElement>('.mode-chip')) {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.mode as ModeId);
      sfx.play('blip');
      repaint();
    });
  }
}

/** The host's own control, in the lobby: a room can be taken off the list again. */
function visibilityPicker(): string {
  const chip = (pub: boolean, name: string, meta: string): string =>
    `<button class="vis-chip${roomPublic === pub ? ' on' : ''}" type="button"
      role="radio" aria-checked="${roomPublic === pub}" data-pub="${pub ? 1 : 0}">
      <span class="vis-name">${escapeHtml(name)}</span>
      <span class="vis-meta">${escapeHtml(meta)}</span>
    </button>`;
  return `
    <div class="vis" role="radiogroup" aria-label="Who can join">
      ${chip(false, 'Private', 'Invite only')}
      ${chip(true, 'Public', 'Listed for anyone')}
    </div>
    <p class="re-note">${escapeHtml(P2P_IP_NOTE)}</p>`;
}

function wireVisibility(repaint: () => void): void {
  for (const btn of content.querySelectorAll<HTMLButtonElement>('.vis-chip')) {
    btn.addEventListener('click', () => {
      roomPublic = btn.dataset.pub === '1';
      sfx.play('blip');
      // Immediately, not on the next tick: "private" has to mean off the list
      // now, not within a second.
      syncListing();
      repaint();
    });
  }
}

// ---------------------------------------------------------------------------
// The public room list.
//
// At most one board, held only while something is actually using it — browsing
// the list, or listing our own room. It is a mesh of STRANGERS (see
// P2P_IP_NOTE), so it is never opened by the page loading and never left running
// behind a screen the player has walked away from.
// ---------------------------------------------------------------------------

let board: Noticeboard | null = null;
let boardRooms: ((rooms: PublicRoom[]) => void) | null = null;
/** Serialises open/close. net.ts throws if the board's room is rejoined while
 *  the last one is still tearing down, and browse → back → browse is two taps. */
let boardQueue: Promise<void> = Promise.resolve();

function onBoard(then: () => void): Promise<void> {
  boardQueue = boardQueue
    // The board is frequently the FIRST mesh on the page, so it is also the one
    // that decides whether this page's connection pool carries TURN at all.
    .then(() => turnReady)
    .then(() => {
      board ??= createNoticeboard({ appId: ROOM_APP_ID, onRooms: (r) => boardRooms?.(r) });
      then();
    })
    .then(
      () => undefined,
      (e) => console.error(e),
    );
  return boardQueue;
}

const boardAccess: BoardAccess = {
  open(onRooms) {
    boardRooms = onRooms;
    // Hand over whatever is already known so the list is not blank for a cycle.
    return onBoard(() => onRooms(board!.rooms()));
  },
  announce(ad) {
    return onBoard(() => board!.announce(ad));
  },
  close() {
    boardRooms = null;
    const b = board;
    board = null;
    if (!b) return;
    // CHAIN, never replace — same trap as roomTeardown below.
    boardQueue = boardQueue.then(() => b.destroy()).then(
      () => undefined,
      () => undefined,
    );
  },
};

/** Feed lobby.ts's roomAd() rule the room's current truth. It decides. */
function syncListing(): void {
  if (!listing) return;
  if (!net || !rounds) {
    listing.close();
    return;
  }
  const s = rounds.state();
  listing.sync({
    isPublic: roomPublic,
    isHost: net.isHost(),
    inLobby: !!lobby,
    playing: s.phase === 'playing',
    code: roomCode,
    host: playerName(),
    players: s.present.length,
    max: MAX_PLAYERS,
    note: modeOf(modeId).name,
  });
}

// ---------------------------------------------------------------------------
// Drivers — a common surface over the solo (local sim) and MP (net) games.
// ---------------------------------------------------------------------------

interface Driver {
  readonly mode: 'solo' | 'mp';
  getState(): RoyaleState;
  getPhase(): Phase;
  mySeat(): number;
  names(): string[];
  colors(): number[];
  /** Peer id per seat (MP only) — lets the results tally survive a rematch. */
  ids?(): string[];
  tickMs(): number;
  play(dir: Dir): void;
  setUpdate(cb: (u: NetUpdate) => void): void;
  start(): void;
  pause?(): void;
  resume?(): void;
  isPaused?(): boolean;
  restart?(): void;
  destroy(): void;
}

class SoloDriver implements Driver {
  readonly mode = 'solo' as const;
  private state: RoyaleState;
  private rng: Rng;
  private cb: (u: NetUpdate) => void = () => {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private curTick: number;

  /** The arena is the player's own pick here — there is no host to defer to. */
  constructor(private arena: Mode) {
    this.curTick = soloTickMs(arena, 0);
    this.rng = makeRng(newSeed());
    this.state = this.fresh();
  }

  /** Endless keeps the classic single pellet: the hunt IS the game solo, and
   *  the royale food scaling exists to stop six snakes starving each other. */
  private fresh(): RoyaleState {
    return createRoyale(newSeed(), {
      grid: this.arena.grid,
      mode: 'solo',
      players: [{ name: 'You', color: 2 }],
      foodTarget: 1,
    });
  }

  getState() {
    return this.state;
  }
  getPhase(): Phase {
    return this.state.over ? 'over' : 'play';
  }
  mySeat() {
    return 0;
  }
  names() {
    return ['You'];
  }
  colors() {
    return [2];
  }
  tickMs() {
    return this.curTick;
  }
  setUpdate(cb: (u: NetUpdate) => void) {
    this.cb = cb;
  }

  start() {
    this.emit({ ate: [], died: [], eatenAt: [] });
    this.schedule();
  }

  play(dir: Dir) {
    setDir(this.state, 0, dir);
  }

  private schedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.step(), this.curTick);
  }

  private step() {
    if (this.paused || this.state.over) return;
    const events = stepRoyale(this.state, this.rng);
    // Speed ramps up with score, floored so it stays playable — see soloTickMs.
    const next = soloTickMs(this.arena, this.state.snakes[0].score);
    this.emit(events);
    if (this.state.over) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    } else if (next !== this.curTick) {
      this.curTick = next;
      this.schedule();
    }
  }

  private emit(events: { ate: number[]; died: number[]; eatenAt: { x: number; y: number }[] }) {
    this.cb({ state: this.state, phase: this.getPhase(), events });
  }

  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  isPaused() {
    return this.paused;
  }

  restart() {
    this.paused = false;
    this.curTick = soloTickMs(this.arena, 0);
    this.rng = makeRng(newSeed());
    this.state = this.fresh();
    this.emit({ ate: [], died: [], eatenAt: [] });
    this.schedule();
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

class MpDriver implements Driver {
  readonly mode = 'mp' as const;
  private cb: (u: NetUpdate) => void = () => {};
  private ng!: NetRoyale;

  /** `arena` is the HOST's mode, unfrozen from the round start — never our own
   *  pick, or we would step the same seed at a different rate to everyone else. */
  constructor(
    private roster: RoundPlayer[],
    private arena: Mode,
  ) {}

  attach(ng: NetRoyale) {
    this.ng = ng;
  }
  forward(u: NetUpdate) {
    this.cb(u);
  }
  getState() {
    return this.ng.getState();
  }
  getPhase() {
    return this.ng.getPhase();
  }
  mySeat() {
    return this.ng.mySeat();
  }
  names() {
    return this.roster.map((p) => p.name);
  }
  colors() {
    return this.roster.map((_, i) => i);
  }
  ids() {
    return this.roster.map((p) => p.id);
  }
  tickMs() {
    return this.arena.tickMs;
  }
  setUpdate(cb: (u: NetUpdate) => void) {
    this.cb = cb;
  }
  start() {
    this.cb({
      state: this.ng.getState(),
      phase: this.ng.getPhase(),
      events: { ate: [], died: [], eatenAt: [] },
    });
  }
  play(dir: Dir) {
    this.ng.play(dir);
  }
  destroy() {
    this.ng.destroy();
  }
}

// ---------------------------------------------------------------------------
// In-game session: canvas + HUD + input + rAF render loop + results.
// ---------------------------------------------------------------------------

const DIR_FROM_AXIS = (x: number, y: number): Dir | null => {
  if (x === 0 && y === 0) return null;
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'down' : 'up';
};

class GameSession {
  private view!: CanvasView;
  private input!: Input;
  private raf = 0;
  private lastNow = 0;
  private lastAxisDir: Dir | null = null;
  private onKey!: (e: KeyboardEvent) => void;
  private touchStart: { x: number; y: number } | null = null;
  private onTouchStart!: (e: TouchEvent) => void;
  private onTouchEnd!: (e: TouchEvent) => void;
  private resultsShown = false;
  private banner!: HTMLElement;
  private startedAt = performance.now();

  constructor(private driver: Driver) {
    this.render();
    const canvas = document.getElementById('board') as HTMLCanvasElement;
    this.view = new CanvasView(canvas, { tickMs: driver.tickMs(), reducedMotion });
    this.view.resync(driver.getState());
    this.banner = document.getElementById('statusBanner')!;

    this.input = createInput({ target: canvas, keys: {}, buttons: [] });

    this.driver.setUpdate((u) => this.onUpdate(u));

    this.onKey = (e) => this.handleKey(e);
    window.addEventListener('keydown', this.onKey);

    this.onTouchStart = (e) => {
      const t = e.changedTouches[0];
      this.touchStart = { x: t.clientX, y: t.clientY };
    };
    this.onTouchEnd = (e) => {
      if (!this.touchStart) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - this.touchStart.x;
      const dy = t.clientY - this.touchStart.y;
      this.touchStart = null;
      if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return;
      const d = DIR_FROM_AXIS(dx, dy);
      if (d) this.driver.play(d);
    };
    canvas.addEventListener('touchstart', this.onTouchStart, { passive: true });
    canvas.addEventListener('touchend', this.onTouchEnd, { passive: true });

    this.refreshHud(driver.getState());
    this.updateBanner();
    this.driver.start();
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private render() {
    const solo = this.driver.mode === 'solo';
    content.innerHTML = `
      <section class="screen game">
        <div class="topbar">
          <button class="icon-btn" data-act="menu">‹ Menu</button>
          <div class="status" id="statusBanner" role="status" aria-live="polite"></div>
          <button class="icon-btn" data-act="mute" id="muteBtn" aria-label="Toggle sound"></button>
        </div>
        <div class="hud" id="hud"></div>
        <div class="board-wrap">
          <canvas id="board" aria-label="Snake Royale arena"></canvas>
          <div class="overlay" id="overlay" hidden></div>
        </div>
        <div class="game-actions">
          <button class="btn btn-ghost" data-act="howto">How to play</button>
          ${solo ? '<button class="btn btn-ghost" data-act="pause" id="pauseBtn">⏸ Pause</button>' : ''}
          ${solo ? '<button class="btn btn-ghost" data-act="restart">↻ Restart</button>' : ''}
        </div>
      </section>`;

    content.querySelector('[data-act="menu"]')?.addEventListener('click', () => toMenu());
    content.querySelector('[data-act="mute"]')?.addEventListener('click', () => {
      toggleMute();
      this.updateMuteBtn();
    });
    content
      .querySelector('[data-act="howto"]')
      ?.addEventListener('click', () => openModal('How to play', HOWTO_HTML));
    content.querySelector('[data-act="restart"]')?.addEventListener('click', () => this.doRestart());
    content.querySelector('[data-act="pause"]')?.addEventListener('click', () => this.togglePause());
    this.updateMuteBtn();
  }

  private updateMuteBtn() {
    const b = document.getElementById('muteBtn');
    if (b) b.textContent = sfx.muted() ? '🔇' : '🔊';
  }

  private handleKey(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    const map: Record<string, Dir> = {
      arrowup: 'up',
      arrowdown: 'down',
      arrowleft: 'left',
      arrowright: 'right',
      w: 'up',
      s: 'down',
      a: 'left',
      d: 'right',
    };
    if (map[k]) {
      e.preventDefault();
      this.driver.play(map[k]);
      return;
    }
    if ((k === 'p' || k === 'escape') && this.driver.mode === 'solo') this.togglePause();
    else if (k === 'r' && this.driver.mode === 'solo') this.doRestart();
    else if (k === 'm') {
      toggleMute();
      this.updateMuteBtn();
    } else if ((k === ' ' || k === 'enter') && this.resultsShown && this.driver.mode === 'solo') {
      this.doRestart();
    }
  }

  private togglePause() {
    if (this.driver.mode !== 'solo' || this.driver.getState().over) return;
    if (this.driver.isPaused?.()) {
      this.driver.resume?.();
      this.hideOverlay();
    } else {
      this.driver.pause?.();
      this.showOverlay('<div class="ov-big">Paused</div><div class="ov-sub">Press P to resume</div>');
    }
    const b = document.getElementById('pauseBtn');
    if (b) b.textContent = this.driver.isPaused?.() ? '▶ Resume' : '⏸ Pause';
  }

  private doRestart() {
    this.resultsShown = false;
    this.hideOverlay();
    this.startedAt = performance.now();
    this.driver.restart?.();
    this.view.resync(this.driver.getState());
    const b = document.getElementById('pauseBtn');
    if (b) b.textContent = '⏸ Pause';
  }

  private frame(now: number) {
    const dt = Math.min(0.05, (now - this.lastNow) / 1000);
    this.lastNow = now;

    // Touch D-pad → direction (axis reflects the virtual pad's held button).
    const a = this.input.state.axis;
    const d = DIR_FROM_AXIS(a.x, a.y);
    if (d && d !== this.lastAxisDir) {
      this.lastAxisDir = d;
      this.driver.play(d);
    } else if (!d) {
      this.lastAxisDir = null;
    }
    this.input.endFrame();

    this.view.render(now, dt);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private onUpdate(u: NetUpdate) {
    this.view.setTickMs(this.driver.tickMs());
    this.view.push(u.state);

    // Juice from events.
    for (const cell of u.events.eatenAt) this.view.burstAt(cell, '#F0C420', 12);
    if (u.events.ate.length) {
      const combo = 1 + Math.min(0.8, (this.driver.getState().snakes[u.events.ate[0]]?.score ?? 0) * 0.03);
      sfx.play('eat', combo);
    }
    for (const seat of u.events.died) {
      const s = u.state.snakes[seat];
      this.view.burstBody(s.body, SNAKE_COLORS[s.color % 6]);
      this.view.shake(seat === this.driver.mySeat() ? 12 : 6);
      sfx.play(seat === this.driver.mySeat() ? 'die' : 'crash');
    }

    if (u.promoted) flashToast("The host left — you're running the round now");

    this.refreshHud(u.state);
    this.updateBanner();

    // The 3-2-1 overlay and its pips belong to src/countdown.ts, which every peer
    // runs locally from the round start — this screen only reflects the arena.

    if (u.state.over && !this.resultsShown) {
      this.resultsShown = true;
      setTimeout(() => this.showResults(u.state), 420);
    }
  }

  private updateBanner() {
    const state = this.driver.getState();
    const me = this.driver.mySeat();
    const phase = this.driver.getPhase();
    if (this.driver.mode === 'solo') {
      this.banner.textContent = state.over
        ? 'Game over'
        : `Score ${state.snakes[0].score} · Length ${state.snakes[0].body.length}`;
      return;
    }
    if (phase === 'count') {
      this.banner.textContent = 'Get ready…';
    } else if (state.over) {
      this.banner.textContent = 'Round over';
    } else if (me < 0) {
      this.banner.innerHTML = `<span class="spinner sm" aria-hidden="true"></span> Spectating`;
    } else if (!state.snakes[me]?.alive) {
      this.banner.textContent = 'You crashed — watching…';
    } else {
      const alive = state.snakes.filter((s) => s.alive).length;
      this.banner.textContent = `${alive} snakes left`;
    }
  }

  private refreshHud(state: RoyaleState) {
    const hud = document.getElementById('hud');
    if (!hud) return;
    const names = this.driver.names();
    const me = this.driver.mySeat();
    const ranked = ranking(state);
    hud.innerHTML = ranked
      .map((seat) => {
        const s = state.snakes[seat];
        return `<div class="chip ${s.alive ? '' : 'dead'} ${seat === me ? 'me' : ''}"
          style="--c:${SNAKE_COLORS[s.color % 6]}">
          <span class="chip-dot"></span>
          <span class="chip-name">${escapeHtml(names[seat] ?? `P${seat + 1}`)}${seat === me ? ' (you)' : ''}</span>
          <span class="chip-score">${s.score}</span>
        </div>`;
      })
      .join('');
  }

  private showOverlay(html: string) {
    const ov = document.getElementById('overlay');
    if (!ov) return;
    ov.innerHTML = html;
    ov.hidden = false;
  }
  private hideOverlay() {
    const ov = document.getElementById('overlay');
    if (ov) {
      ov.hidden = true;
      ov.innerHTML = '';
    }
  }

  private showResults(state: RoyaleState) {
    const names = this.driver.names();
    const me = this.driver.mySeat();
    const solo = this.driver.mode === 'solo';

    let headline: string;
    if (solo) {
      const score = state.snakes[0].score;
      const prevBest = store.get('best', 0);
      const isBest = score > prevBest;
      if (isBest) store.set('best', score);
      headline = isBest ? `New best — ${score}!` : `You scored ${score}`;
      sfx.play(isBest ? 'win' : 'lose');
    } else {
      const win = state.winner;
      if (win < 0) headline = "It's a draw!";
      else if (win === me) headline = 'You win! 🐍';
      else headline = `${escapeHtml(names[win] ?? 'A rival')} wins`;
      sfx.play(win === me || me < 0 ? 'win' : 'lose');
    }

    const ids = this.driver.ids?.() ?? [];

    // The round is done — reopen voting so "Play again" has something to say.
    if (!solo) {
      rounds?.finish();
      const winId = ids[state.winner];
      if (winId) tally.set(winId, (tally.get(winId) ?? 0) + 1);
    }

    const ranked = ranking(state);
    const best = store.get('best', 0);
    const showTally = !solo && [...tally.values()].some((n) => n > 0);

    /** Seconds this snake lasted. An MP round ticks at its mode's fixed rate, so
     *  ticks convert honestly; solo's tick ramps with the score, so only the wall
     *  clock means anything there. */
    const secs = (seat: number): number => {
      const s = state.snakes[seat];
      if (solo) return (performance.now() - this.startedAt) / 1000;
      return ((s.alive ? state.tick : s.deadAt) * this.driver.tickMs()) / 1000;
    };
    const nameOf = (seat: number): string => names[seat] ?? `P${seat + 1}`;
    const fate = (seat: number): string => {
      const s = state.snakes[seat];
      if (s.alive) return solo ? 'Survived' : 'Last snake slithering';
      switch (s.death) {
        case 'self':
          return 'Bit its own tail';
        case 'body':
          return `Cut off by ${escapeHtml(nameOf(s.killedBy))}`;
        case 'head':
          return `Head-on with ${escapeHtml(nameOf(s.killedBy))}`;
        default:
          return 'Hit the wall';
      }
    };

    const overlay = document.createElement('div');
    overlay.className = 'results-overlay';
    overlay.innerHTML = `
      <div class="results" role="dialog" aria-modal="true" aria-label="Results">
        <h2 class="results-title">${headline}</h2>
        ${solo ? `<p class="results-best">Best: ${best}</p>` : ''}
        ${
          showTally
            ? `<p class="results-tally">Rounds won · ${ids
                .map((id, seat) => `<span>${escapeHtml(nameOf(seat))} ${tally.get(id) ?? 0}</span>`)
                .join(' · ')}</p>`
            : ''
        }
        <ul class="results-list">
          ${ranked
            .map((seat, i) => {
              const s = state.snakes[seat];
              return `<li class="result-row ${seat === me ? 'me' : ''}">
                <span class="result-rank">${i + 1}</span>
                <span class="result-dot" style="background:${SNAKE_COLORS[s.color % 6]}"></span>
                <span class="result-main">
                  <span class="result-name">${escapeHtml(nameOf(seat))}${seat === me ? ' (you)' : ''}</span>
                  <span class="result-fate">${fate(seat)}</span>
                </span>
                <span class="result-stats">
                  <span class="result-stat"><b>${s.body.length}</b> long</span>
                  <span class="result-stat"><b>${s.score}</b> pellet${s.score === 1 ? '' : 's'}</span>
                  <span class="result-stat"><b>${secs(seat).toFixed(1)}s</b> alive</span>
                </span>
                <span class="result-score">${s.score}</span>
              </li>`;
            })
            .join('')}
        </ul>
        <div class="results-actions">
          <button class="btn btn-primary" data-act="again">Play again</button>
          ${solo ? '' : '<button class="btn" data-act="startnow" hidden>Start now</button>'}
          ${solo ? '' : '<button class="btn" data-act="lobby">Back to lobby</button>'}
          <button class="btn" data-act="share">Share</button>
          <button class="btn btn-ghost" data-act="menu">Menu</button>
        </div>
        <p class="results-ready" role="status" aria-live="polite"></p>
      </div>`;
    content.querySelector('.game')?.appendChild(overlay);

    const againBtn = overlay.querySelector<HTMLButtonElement>('[data-act="again"]')!;
    const readyEl = overlay.querySelector<HTMLElement>('.results-ready')!;

    againBtn.addEventListener('click', () => {
      if (solo) {
        overlay.remove();
        this.doRestart();
        return;
      }
      // NOT a rejoin. The room and the whole peer mesh stay exactly as they are;
      // this only registers a vote, and the next arena starts underneath us once
      // everyone has voted. Leaving and rejoining here is what used to strand
      // both players alone as host — see @ben-gy/game-engine/net.
      if (!rounds) return;
      if (rounds.state().voted) rounds.unvote();
      else rounds.vote();
      paintReady();
    });
    overlay.querySelector('[data-act="startnow"]')?.addEventListener('click', () => rounds?.go());
    overlay.querySelector('[data-act="lobby"]')?.addEventListener('click', () => {
      // Back to the lobby WITHOUT leaving the room — the mesh, the roster and the
      // running tally all survive. From there you can wait, re-ready, or see who
      // is still around, instead of the summary being a dead end with only Menu.
      rounds?.unvote();
      backToLobby();
    });
    overlay.querySelector('[data-act="menu"]')?.addEventListener('click', () => toMenu());
    overlay.querySelector('[data-act="share"]')?.addEventListener('click', () => {
      const score = state.snakes[me >= 0 ? me : 0]?.score ?? 0;
      void shareResult(solo, score, state.winner === me);
    });

    function paintReady(): void {
      if (solo || !rounds) return;
      const s = rounds.state();
      againBtn.textContent = s.voted ? 'Ready — waiting…' : 'Play again';
      againBtn.classList.toggle('waiting', s.voted);

      // The host never has to sit and hope: once enough snakes are in, it can
      // tee off immediately rather than wait out the countdown.
      const startNow = overlay.querySelector<HTMLButtonElement>('[data-act="startnow"]');
      if (startNow) startNow.hidden = !s.canStart || s.votes.length === s.present.length;

      const waiting = s.present.length - s.votes.length;
      const secs = s.startsInMs !== null ? Math.ceil(s.startsInMs / 1000) : null;
      if (!s.voted) {
        readyEl.textContent = `${s.votes.length}/${s.present.length} ready for another round`;
      } else if (secs !== null) {
        // Say WHY we are still waiting and when it ends. A bare "waiting…" with
        // no horizon is what made this feel like a hang.
        readyEl.textContent = `Starting in ${secs}s — waiting for ${waiting} more player${
          waiting === 1 ? '' : 's'
        }`;
      } else if (waiting > 0) {
        readyEl.textContent = `Waiting for ${waiting} more player${waiting === 1 ? '' : 's'}…`;
      } else {
        readyEl.textContent = 'Starting…';
      }
    }

    if (!solo) {
      paintReady();
      const tick = setInterval(() => {
        if (!document.body.contains(againBtn)) {
          clearInterval(tick);
          return;
        }
        paintReady();
      }, 500);
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.input.destroy();
    this.view.destroy();
    this.driver.destroy();
    const ov = content.querySelector('.results-overlay');
    ov?.remove();
  }
}

async function shareResult(solo: boolean, score: number, won: boolean): Promise<void> {
  const text = solo
    ? `I grew to ${score} in Snake Royale 🐍`
    : won
      ? `I won a round of Snake Royale 🐍`
      : `I scored ${score} in a Snake Royale round 🐍`;
  const url = 'https://snake-royale.benrichardson.dev';
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Snake Royale', text, url });
      return;
    }
    await navigator.clipboard.writeText(`${text} ${url}`);
    flashToast('Result copied');
  } catch {
    flashToast(`${text} ${url}`);
  }
}

function flashToast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 2200);
}

function toggleMute(): void {
  settings.muted = !settings.muted;
  sfx.setMuted(settings.muted);
  store.set('muted', settings.muted);
  if (!settings.muted) sfx.play('blip');
}

// ---------------------------------------------------------------------------
// Screen router.
// ---------------------------------------------------------------------------

function cleanupSession(): void {
  // The countdown belongs to the arena screen, so it dies with it — otherwise a
  // player who tapped Menu mid-count keeps hearing pips over the main menu, and
  // its onDone would start a round nobody is watching.
  countdown?.cancel();
  countdown = null;
  session?.destroy();
  session = null;
}

/** Resolves once any in-flight room teardown has fully finished. */
let roomTeardown: Promise<void> = Promise.resolve();

/**
 * Tear the room down for good. Only ever called on the way to the menu — NEVER
 * between rounds. `net.leave()` is awaited because Trystero keeps the room in
 * its cache until teardown finishes; joining again before then hands back the
 * dying room and every peer ends up alone and self-elected as host. Rematches
 * keep the Net alive and start a new round inside it (the engine's rematch.ts).
 */
function leaveRoom(): Promise<void> {
  lobby?.destroy();
  lobby = null;
  roomEntry?.destroy();
  roomEntry = null;
  rounds?.destroy();
  rounds = null;
  activeNet?.destroy();
  activeNet = null;
  countdown?.cancel();
  countdown = null;
  // Off the list and off the board, before anything else can go wrong. Leaving
  // is one of the three ways a room stops being public (the others are going
  // private and starting a round) and it is the one where nobody is left to
  // notice a stale listing.
  listing?.close();
  listing = null;
  if (listingTick) clearInterval(listingTick);
  listingTick = undefined;
  roomPublic = false;
  roomCode = '';
  // Also covers a board opened by the browse screen: leaveRoom() is on every
  // path out of it.
  boardAccess.close();
  tally = new Map();
  // The room is over for us — take it out of the URL so a refresh, or reopening
  // from the home-screen icon, lands on the menu instead of silently rejoining.
  clearRoomInUrl();
  const leaving = net;
  net = null;
  // CHAIN, never replace. leaveRoom() runs again on the way into a new room, and
  // by then `net` is already null — replacing the promise there would hand back
  // an instantly-resolved teardown while the real one was still inside
  // Trystero's 99ms window, and the next createNet would throw.
  roomTeardown = roomTeardown.then(() => leaving?.leave()).then(
    () => undefined,
    () => undefined,
  );
  return roomTeardown;
}

/** Leave the arena for the room's lobby, keeping the Net (and the tally) alive. */
function backToLobby(): void {
  cleanupSession();
  activeNet = null; // the session's destroy() already tore the round's channels down
  showLobby(new URL(location.href).searchParams.get('room') ?? '');
}

function toMenu(): void {
  cleanupSession();
  void leaveRoom();
  renderMenu();
}

function renderMenu(): void {
  content.innerHTML = menuHTML(store.get('best', 0), modePicker());
  wireModePicker(renderMenu);
  const muteBtn = content.querySelector<HTMLButtonElement>('[data-act="mute"]');
  if (muteBtn) {
    muteBtn.textContent = settings.muted ? '🔇 Sound off' : '🔊 Sound on';
    muteBtn.setAttribute('aria-pressed', String(!settings.muted));
  }
  content.querySelector('[data-act="solo"]')?.addEventListener('click', startSolo);
  content.querySelector('[data-act="friends"]')?.addEventListener('click', enterFriends);
  content
    .querySelector('[data-act="howto"]')
    ?.addEventListener('click', () => openModal('How to play', HOWTO_HTML));
  content
    .querySelector('[data-act="about"]')
    ?.addEventListener('click', () => openModal('About Snake Royale', ABOUT_HTML));
  content.querySelector('[data-act="mute"]')?.addEventListener('click', () => {
    toggleMute();
    const b = content.querySelector<HTMLButtonElement>('[data-act="mute"]');
    if (b) {
      b.textContent = settings.muted ? '🔇 Sound off' : '🔊 Sound on';
      b.setAttribute('aria-pressed', String(!settings.muted));
    }
  });
}

function startSolo(): void {
  cleanupSession();
  void leaveRoom();
  session = new GameSession(new SoloDriver(modeOf(modeId)));
}

function enterFriends(): void {
  void leaveRoom();

  // Deep-linked via an invite? Join it straight away, once. We are the guest
  // here, never the host — the person who sent the link already holds the room.
  if (pendingRoom) {
    const code = pendingRoom;
    pendingRoom = null;
    void openRoom(code, false, false);
    return;
  }
  content.innerHTML = friendsSetupHTML();
  content.querySelector('[data-act="back"]')?.addEventListener('click', toMenu);
  // Handing the entry `board` is what makes public rooms exist at all — it does
  // not join anything until the player taps Browse.
  roomEntry = createRoomEntry({
    container: document.getElementById('entryMount')!,
    subtitle: 'Start a new room, or enter a friend’s code to join theirs.',
    board: boardAccess,
    onSubmit: (code, created, isPublic) => void openRoom(code, created, isPublic),
  });
}

/**
 * Join a room ONCE and hold it for as long as the player stays. Every arena —
 * the first and every rematch — runs inside this one Net via `rounds`. Nothing
 * here may call net.leave() except the trip back to the menu.
 */
async function openRoom(code: string, created: boolean, isPublic: boolean): Promise<void> {
  cleanupSession();
  leaveRoom();
  // A previous room may still be tearing down (Trystero defers it ~99ms).
  // Joining inside that window returns the dying room, so wait it out.
  await roomTeardown;
  // TURN must be in force before this mesh is built (see turnReady at boot).
  await turnReady;
  // The public flag stays OUT of the URL. It is the host's live choice, not a
  // property of the code: baked into an invite link it would survive the host
  // flipping the room private, and every guest who forwarded the link would be
  // handing on a claim that is no longer true.
  setRoomInUrl(code);
  roomCode = code;
  roomPublic = created && isPublic;

  try {
    net = createNet(
      // `created` is the difference between minting this code and walking into
      // someone else's room. Only the minter may host on arrival; a guest waits
      // to hear from the incumbent instead of racing it for the role.
      { appId: ROOM_APP_ID, roomId: code, claimHost: created },
      {
        onHostChange: (_id, isSelf) => activeNet?.setHost(isSelf),
        onPeers: () => activeNet?.onRoster(),
      },
    );
  } catch (err) {
    // The room is somehow still held (see the engine's net.ts). Never strand the
    // player on a blank screen — say so and go back somewhere they can act.
    console.error(err);
    flashToast('Could not open that room — try again');
    toMenu();
    return;
  }

  rounds = createRounds({
    net,
    playerName: playerName(),
    minPlayers: MIN_PLAYERS,
    // Only the host's pick counts, and it travels frozen with the start — a mode
    // each peer read from its own UI is a mode two peers can disagree about, and
    // here that means stepping the same seed at different speeds. `pub` rides
    // along so a guest can see that strangers may walk in; it is gossiped with
    // presence, so it is live rather than a claim from join time.
    roundOpts: () => ({ mode: modeId, pub: roomPublic }),
    onRound: ({ seed, players, opts }) => enterMpGame(seed, players, opts),
  });

  listing = createListing(boardAccess);
  // Player counts move, the host can flip the room private, and the host role
  // itself can transfer mid-lobby. Poll one rule rather than hunt every edge.
  listingTick = window.setInterval(syncListing, 1000);

  showLobby(code);
}

function showLobby(code: string): void {
  if (!net || !rounds) return;
  content.innerHTML = `
    <section class="screen lobby-screen">
      <button class="back" data-act="back" aria-label="Back to menu">‹ Menu</button>
      <div class="lobby-mount" id="lobbyMount"></div>
    </section>`;
  content.querySelector('[data-act="back"]')?.addEventListener('click', toMenu);

  lobby = createLobby({
    container: document.getElementById('lobbyMount')!,
    net,
    rounds,
    roomCode: code,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    // Only the host chooses; everyone else sees what they are about to play, so
    // nobody is surprised by a 32×32 arena they did not pick.
    modeSlot: () => (net!.isHost() ? modePicker() + visibilityPicker() : modeNote()),
    onModeMount: () => {
      wireModePicker(() => lobby?.repaint());
      wireVisibility(() => lobby?.repaint());
    },
  });
  syncListing();
}

function enterMpGame(seed: number, players: RoundPlayer[], opts: unknown): void {
  if (!net) return;
  lobby?.destroy();
  lobby = null;
  // The round is starting, so the room comes off the list right now — not up to
  // a tick later, and not "once someone notices". syncListing reads `lobby`,
  // which is the null above.
  syncListing();

  // The roster arrives FROZEN from the host — identical bytes on every peer — so
  // seat N is the same player everywhere. Re-deriving or re-sorting it locally
  // is how two peers used to disagree about which snake was whose. The mode
  // rides the same start, for the same reason.
  const seats = players.map((p) => p.id);
  if (!seats.includes(net.selfId)) {
    // Not in this round's roster (we joined mid-start). Wait for the next one
    // rather than silently playing as seat 0.
    showLobby(new URL(location.href).searchParams.get('room') ?? '');
    flashToast('Next round — you’re in the lobby');
    return;
  }

  // The HOST's arena, off the wire. Never modeOf(modeId) — that is this peer's
  // own lobby pick, and using it here is how six snakes end up on six grids.
  const arena = arenaFor(opts);
  const driver = new MpDriver(players, arena);
  activeNet?.destroy();
  activeNet = new NetRoyale({
    net,
    seed,
    grid: arena.grid,
    seats,
    players: players.map((p, i) => ({ name: p.name, color: i })),
    tickMs: arena.tickMs,
    foodTarget: foodTarget(arena, players.length),
    onUpdate: (u) => driver.forward(u),
  });
  driver.attach(activeNet);
  cleanupSession();
  session = new GameSession(driver);

  // The arena is up and visible but frozen (phase 'count') so everyone gets the
  // same look at where their snake is and which way it points. Each peer counts
  // locally; only the host's count moves the snakes — see net-game.ts.
  countdown?.cancel();
  const mount = content.querySelector<HTMLElement>('.board-wrap');
  if (!mount) return;
  const host = document.createElement('div');
  host.className = 'cd-host';
  mount.appendChild(host);
  countdown = createCountdown({
    root: host,
    sfx,
    reducedMotion,
    onDone: () => {
      countdown = null;
      host.remove();
      activeNet?.begin();
    },
  });
}

// First visit: auto-show how to play.
renderMenu();
if (!store.get('seenHowto', false)) {
  store.set('seenHowto', true);
  openModal('How to play', HOWTO_HTML);
}
