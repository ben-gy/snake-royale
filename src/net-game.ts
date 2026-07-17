/**
 * net-game.ts — multiplayer glue for Snake Royale. Host-authoritative star.
 *
 * The elected host owns the canonical RoyaleState, advances it on a fixed
 * setInterval tick (NOT rAF — so it keeps ticking when the host tab is
 * backgrounded and is verifiable headlessly), and broadcasts a full snapshot
 * each tick. Clients send only their direction intent and render snapshots.
 *
 * AUTHORITY FOLLOWS THE FROZEN ROSTER, NOT net.host(). net.ts elects the
 * smallest id in the *room*, which includes people who wandered in after the
 * countdown. Deferring to it meant a mid-round joiner with a small id was
 * elected host by everyone, and it holds no NetRoyale at all — so the real host
 * stood down, nobody broadcast a snapshot, and the arena froze for the whole
 * room, permanently. The round's host is instead the smallest id among the seats
 * that are STILL HERE (roundHost below): a peer outside `seats` is a spectator
 * and can never host this round, while a seated player leaving still hands over
 * to the next seated player. The promoted peer already holds the last snapshot;
 * it adopts it as canonical, re-broadcasts, and resumes the host-only timers, so
 * the round keeps advancing and can still reach game-over. A dropped seat's
 * snake simply keeps moving straight until it crashes — the sim never stalls.
 */

import type { Net, PeerId, Unsubscribe } from './engine/net';
import { makeRng, type Rng } from './engine/rng';
import {
  createRoyale,
  setDir,
  stepRoyale,
  type Dir,
  type RoyaleState,
  type StepEvents,
} from './game';

export type Phase = 'count' | 'play' | 'over';

export interface Snapshot {
  state: RoyaleState;
  phase: Phase;
  count: number;
}

export interface NetUpdate {
  state: RoyaleState;
  phase: Phase;
  count: number;
  events: StepEvents;
  /** True the frame this peer was promoted to host. */
  promoted?: boolean;
}

export interface NetRoyaleConfig {
  net: Net;
  seed: number;
  grid: number;
  /** Canonical seating: peer ids ascending. Index = seat / snake id. */
  seats: PeerId[];
  players: { name: string; color: number }[];
  tickMs?: number;
  countMs?: number;
  onUpdate: (u: NetUpdate) => void;
  /** Disable the real setInterval timers (unit tests drive ticks by hand). */
  manualTimers?: boolean;
}

const NO_EVENTS: StepEvents = { ate: [], died: [], eatenAt: [] };

export class NetRoyale {
  private net: Net;
  private seed: number;
  private seats: PeerId[];
  private tickMs: number;
  private countMs: number;
  private onUpdate: (u: NetUpdate) => void;
  private manual: boolean;

  private state: RoyaleState;
  private phase: Phase = 'count';
  private count = 3;
  private rng: Rng;

  private hosting = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private countTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  private sendIn: ((d: { dir: Dir }, to?: PeerId | PeerId[]) => void) & { off: Unsubscribe };
  private sendSnap: ((d: Snapshot, to?: PeerId | PeerId[]) => void) & { off: Unsubscribe };
  private reqSync: ((d: null, to?: PeerId | PeerId[]) => void) & { off: Unsubscribe };

  constructor(cfg: NetRoyaleConfig) {
    this.net = cfg.net;
    this.seed = cfg.seed;
    this.seats = cfg.seats;
    this.tickMs = cfg.tickMs ?? 110;
    this.countMs = cfg.countMs ?? 800;
    this.onUpdate = cfg.onUpdate;
    this.manual = cfg.manualTimers ?? false;
    this.rng = makeRng(cfg.seed);
    this.state = createRoyale(cfg.seed, {
      grid: cfg.grid,
      mode: 'royale',
      players: cfg.players,
      foodTarget: Math.max(2, cfg.players.length + 1),
    });

    this.sendIn = this.net.channel<{ dir: Dir }>('in', (data, from) => {
      if (!this.amHost()) return;
      const seat = this.seats.indexOf(from);
      if (seat >= 0) setDir(this.state, seat, data.dir);
    });

    this.sendSnap = this.net.channel<Snapshot>('snap', (snap, from) => {
      if (this.amHost()) return; // host is the source of truth
      // Only this round's host may rewrite our state. Without this, a spectator
      // or a peer still holding a finished round could overwrite a live arena.
      if (from !== this.roundHost()) return;
      this.state = snap.state;
      this.phase = snap.phase;
      this.count = snap.count;
      this.emit(NO_EVENTS);
    });

    this.reqSync = this.net.channel<null>('sync', (_d, from) => {
      if (this.amHost()) this.sendSnap(this.snapshot(), from);
    });

    if (this.amHost()) {
      this.startHosting(true);
    } else {
      this.reqSync(null);
    }
    this.emit(NO_EVENTS);
  }

  /**
   * The authority for THIS round: the smallest seated peer still in the room.
   * Derived from the frozen roster, so a mid-round joiner — who has no NetRoyale
   * and could never drive the sim — is never elected and the arena cannot stall.
   */
  private roundHost(): PeerId | null {
    const here = new Set(this.net.peers());
    const live = this.seats.filter((id) => here.has(id));
    return live.length ? live.reduce((min, p) => (p < min ? p : min)) : null;
  }

  private amHost(): boolean {
    return this.roundHost() === this.net.selfId;
  }

  // --- public surface ------------------------------------------------------

  getState(): RoyaleState {
    return this.state;
  }
  getPhase(): Phase {
    return this.phase;
  }
  getCount(): number {
    return this.count;
  }
  mySeat(): number {
    return this.seats.indexOf(this.net.selfId);
  }
  snapshot(): Snapshot {
    return { state: this.state, phase: this.phase, count: this.count };
  }

  /** Player asked to turn. Optimistic locally; authoritative on the host. */
  play(dir: Dir): void {
    const seat = this.mySeat();
    if (seat < 0 || this.phase === 'over') return;
    setDir(this.state, seat, dir); // optimistic — corrected by next snapshot
    if (this.amHost()) {
      // already applied to canonical state above
    } else {
      const host = this.roundHost();
      if (host) this.sendIn({ dir }, host);
    }
  }

  /** Test/host helper: steer an arbitrary seat (host only). */
  steer(seat: number, dir: Dir): void {
    if (this.amHost()) setDir(this.state, seat, dir);
  }

  /** Wired to net.onHostChange. Becoming this round's host = the takeover. */
  setHost(_isSelfHost: boolean): void {
    // The room's elected host is only a hint — recheck against the frozen
    // roster, which is what actually decides who drives this round.
    this.refreshAuthority();
  }

  /** Roster changed — a seat may have dropped, so re-run the round election.
   *  Dropped seats' snakes just coast straight into a wall; the sim never stalls. */
  onRoster(): void {
    this.refreshAuthority();
  }

  private refreshAuthority(): void {
    if (this.destroyed) return;
    const mine = this.amHost();
    if (mine && !this.hosting) {
      this.startHosting(false);
      this.emit(NO_EVENTS, true);
    } else if (!mine && this.hosting) {
      this.stopHosting();
    }
  }

  /** One authoritative tick. Public so tests can drive it without timers. */
  hostTick(): void {
    if (this.destroyed || !this.amHost()) return;
    if (this.phase !== 'play' || this.state.over) return;
    const events = stepRoyale(this.state, this.rng);
    if (this.state.over) this.phase = 'over';
    this.sendSnap(this.snapshot());
    this.emit(events);
  }

  /** One countdown step. Public for tests. */
  hostCountStep(): void {
    if (this.destroyed || !this.amHost() || this.phase !== 'count') return;
    this.count--;
    if (this.count <= 0) {
      this.phase = 'play';
      this.count = 0;
      if (this.countTimer) {
        clearInterval(this.countTimer);
        this.countTimer = null;
      }
    }
    this.sendSnap(this.snapshot());
    this.emit(NO_EVENTS);
  }

  destroy(): void {
    this.destroyed = true;
    this.stopHosting();
    // MANDATORY. The Net now outlives the round (it spans the room's whole life)
    // and net.channel() fans out rather than memoizing, so leaving these
    // attached means every finished round STACKS another 'in'/'snap' receiver on
    // the live one: the old host resolves the new round's inputs against its
    // dead state and broadcasts snapshots of a finished arena over the real one.
    this.sendIn.off();
    this.sendSnap.off();
    this.reqSync.off();
  }

  // --- host internals ------------------------------------------------------

  private startHosting(fresh: boolean): void {
    this.hosting = true;
    // A fresh rng each time hosting begins is fine: clients render snapshots, so
    // food positions never need to match a departed host's rng stream.
    this.rng = makeRng((this.seed ^ (this.state.tick * 2654435761)) >>> 0);
    // Adopt whatever state we hold as canonical and tell everyone immediately.
    this.sendSnap(this.snapshot());
    if (this.manual) return;
    this.stopTimers();
    if (this.phase === 'count') {
      this.countTimer = setInterval(() => this.hostCountStep(), this.countMs);
    }
    this.tickTimer = setInterval(() => this.hostTick(), this.tickMs);
    void fresh;
  }

  private stopHosting(): void {
    this.hosting = false;
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.countTimer) clearInterval(this.countTimer);
    this.tickTimer = null;
    this.countTimer = null;
  }

  private emit(events: StepEvents, promoted = false): void {
    this.onUpdate({
      state: this.state,
      phase: this.phase,
      count: this.count,
      events,
      promoted,
    });
  }
}
