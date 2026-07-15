/**
 * main.ts — Snake Royale bootstrap and orchestration. Owns the screen router,
 * the solo (Endless) and multiplayer (Royale P2P) drivers, and the in-game
 * session that turns state updates into canvas paint + particles + sound.
 * Heavy rules live in game.ts; netcode in net-game.ts; drawing in render.ts.
 */

import './styles/main.css';
import {
  createRoyale,
  ranking,
  setDir,
  stepRoyale,
  type Dir,
  type RoyaleState,
} from './game';
import { makeRng, newSeed, type Rng } from './engine/rng';
import { createSfx } from './engine/sound';
import { createStore } from './engine/storage';
import { createInput, type Input } from './engine/input';
import { createNet, type Net } from './engine/net';
import {
  createLobby,
  createRoomEntry,
  normalizeRoomCode,
  setRoomInUrl,
  type LobbyPlayer,
} from './engine/lobby';
import { NetRoyale, type NetUpdate, type Phase } from './net-game';
import { CanvasView, SNAKE_COLORS } from './render';
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
const GRID = 22;
const MP_TICK = 110;
const NAME_POOL = ['Fox', 'Wren', 'Sage', 'Koi', 'Lark', 'Bea', 'Nova', 'Pip', 'Ozzy', 'Rio'];

const store = createStore(APP_ID);
const settings = { muted: store.get('muted', false) };
const sfx = createSfx(settings.muted);
const reducedMotion =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const app = document.getElementById('app')!;
app.innerHTML = `<main class="main-content" id="content"></main>${FOOTER_HTML}`;
const content = document.getElementById('content')!;

let net: Net | null = null;
let activeNet: NetRoyale | null = null;
let session: GameSession | null = null;

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
// Drivers — a common surface over the solo (local sim) and MP (net) games.
// ---------------------------------------------------------------------------

interface Driver {
  readonly mode: 'solo' | 'mp';
  getState(): RoyaleState;
  getPhase(): Phase;
  getCount(): number;
  mySeat(): number;
  names(): string[];
  colors(): number[];
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
  private curTick = 140;

  constructor() {
    this.rng = makeRng(newSeed());
    this.state = createRoyale(newSeed(), {
      grid: GRID,
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
  getCount() {
    return 0;
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
    // Speed ramps up with score, capped so it stays playable.
    const next = Math.max(75, 140 - this.state.snakes[0].score * 3);
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
    this.cb({ state: this.state, phase: this.getPhase(), count: 0, events });
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
    this.curTick = 140;
    this.rng = makeRng(newSeed());
    this.state = createRoyale(newSeed(), {
      grid: GRID,
      mode: 'solo',
      players: [{ name: 'You', color: 2 }],
      foodTarget: 1,
    });
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

  constructor(
    private _names: string[],
    private _colors: number[],
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
  getCount() {
    return this.ng.getCount();
  }
  mySeat() {
    return this.ng.mySeat();
  }
  names() {
    return this._names;
  }
  colors() {
    return this._colors;
  }
  tickMs() {
    return MP_TICK;
  }
  setUpdate(cb: (u: NetUpdate) => void) {
    this.cb = cb;
  }
  start() {
    this.cb({
      state: this.ng.getState(),
      phase: this.ng.getPhase(),
      count: this.ng.getCount(),
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
  private lastCount = 99;
  private banner!: HTMLElement;

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
    this.lastCount = 99;
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

    // Countdown beeps (MP).
    if (u.phase === 'count' && u.count !== this.lastCount) {
      this.lastCount = u.count;
      if (u.count > 0) sfx.play('beep', 1 + (3 - u.count) * 0.12);
    }
    if (u.promoted) flashToast("The host left — you're running the round now");

    this.refreshHud(u.state);
    this.updateBanner();

    if (u.phase === 'count') {
      this.showOverlay(`<div class="ov-count">${u.count > 0 ? u.count : 'Go!'}</div>`);
    } else if (this.overlayIsCount()) {
      sfx.play('go');
      this.hideOverlay();
    }

    if (u.state.over && !this.resultsShown) {
      this.resultsShown = true;
      setTimeout(() => this.showResults(u.state), 420);
    }
  }

  private overlayIsCount(): boolean {
    const ov = document.getElementById('overlay');
    return !!ov && !ov.hidden && ov.querySelector('.ov-count') !== null;
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

    const ranked = ranking(state);
    const best = store.get('best', 0);
    const overlay = document.createElement('div');
    overlay.className = 'results-overlay';
    overlay.innerHTML = `
      <div class="results" role="dialog" aria-modal="true" aria-label="Results">
        <h2 class="results-title">${headline}</h2>
        ${solo ? `<p class="results-best">Best: ${best}</p>` : ''}
        <ul class="results-list">
          ${ranked
            .map((seat, i) => {
              const s = state.snakes[seat];
              return `<li class="result-row ${seat === me ? 'me' : ''}">
                <span class="result-rank">${i + 1}</span>
                <span class="result-dot" style="background:${SNAKE_COLORS[s.color % 6]}"></span>
                <span class="result-name">${escapeHtml(names[seat] ?? `P${seat + 1}`)}${seat === me ? ' (you)' : ''}</span>
                <span class="result-score">${s.score}</span>
              </li>`;
            })
            .join('')}
        </ul>
        <div class="results-actions">
          <button class="btn btn-primary" data-act="again">${solo ? 'Play again' : 'Back to menu'}</button>
          <button class="btn" data-act="share">Share</button>
          ${solo ? '<button class="btn btn-ghost" data-act="menu">Menu</button>' : ''}
        </div>
      </div>`;
    content.querySelector('.game')?.appendChild(overlay);

    overlay.querySelector('[data-act="again"]')?.addEventListener('click', () => {
      overlay.remove();
      if (solo) this.doRestart();
      else toMenu();
    });
    overlay.querySelector('[data-act="menu"]')?.addEventListener('click', () => toMenu());
    overlay.querySelector('[data-act="share"]')?.addEventListener('click', () => {
      const score = state.snakes[me >= 0 ? me : 0]?.score ?? 0;
      void shareResult(solo, score, state.winner === me);
    });
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
  session?.destroy();
  session = null;
}

function cleanupMp(): void {
  activeNet?.destroy();
  activeNet = null;
  try {
    net?.leave();
  } catch {
    /* ignore */
  }
  net = null;
}

function stripRoomParam(): void {
  const url = new URL(location.href);
  if (url.searchParams.has('room')) {
    url.searchParams.delete('room');
    history.replaceState(null, '', url.toString());
  }
}

function toMenu(): void {
  cleanupSession();
  cleanupMp();
  stripRoomParam();
  renderMenu();
}

function renderMenu(): void {
  content.innerHTML = menuHTML(store.get('best', 0));
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
  cleanupMp();
  session = new GameSession(new SoloDriver());
}

function enterFriends(): void {
  cleanupMp();
  const deep = normalizeRoomCode(new URL(location.href).searchParams.get('room') ?? '');
  if (deep.length >= 3) {
    openRoom(deep);
    return;
  }
  content.innerHTML = friendsSetupHTML();
  content.querySelector('[data-act="back"]')?.addEventListener('click', toMenu);
  createRoomEntry({
    container: document.getElementById('entryMount')!,
    subtitle: 'Start a new room, or enter a friend’s code to join theirs.',
    onSubmit: (code) => openRoom(code),
  });
}

function openRoom(code: string): void {
  cleanupSession();
  cleanupMp();
  setRoomInUrl(code);
  net = createNet(
    { appId: APP_ID, roomId: code },
    {
      onHostChange: (_id, isSelf) => activeNet?.setHost(isSelf),
      onPeers: () => activeNet?.onRoster(),
    },
  );

  content.innerHTML = `
    <section class="screen lobby-screen">
      <button class="back" data-act="back" aria-label="Back to menu">‹ Menu</button>
      <div class="lobby-mount" id="lobbyMount"></div>
    </section>`;
  content.querySelector('[data-act="back"]')?.addEventListener('click', toMenu);

  const mount = document.getElementById('lobbyMount')!;
  const lobby = createLobby({
    container: mount,
    net,
    roomCode: code,
    playerName: playerName(),
    minPlayers: 2,
    maxPlayers: 6,
    onStart: (info) => {
      lobby.destroy();
      enterMpGame(info.seed, info.players);
    },
  });
}

function enterMpGame(seed: number, players: LobbyPlayer[]): void {
  const seated = [...players].sort((a, b) => a.id.localeCompare(b.id));
  const seats = seated.map((p) => p.id);
  const names = seated.map((p) => p.name);
  const colors = seated.map((_, i) => i);
  const driver = new MpDriver(names, colors);
  activeNet = new NetRoyale({
    net: net!,
    seed,
    grid: GRID,
    seats,
    players: seated.map((p, i) => ({ name: p.name, color: i })),
    tickMs: MP_TICK,
    onUpdate: (u) => driver.forward(u),
  });
  driver.attach(activeNet);
  cleanupSession();
  session = new GameSession(driver);
}

// First visit: auto-show how to play.
renderMenu();
if (!store.get('seenHowto', false)) {
  store.set('seenHowto', true);
  openModal('How to play', HOWTO_HTML);
}
