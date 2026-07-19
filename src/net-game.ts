/**
 * net-game.ts — multiplayer glue for Snake Royale. Host-authoritative star.
 *
 * The elected host owns the canonical RoyaleState, advances it on a fixed
 * setInterval tick (NOT rAF — so it keeps ticking when the host tab is
 * backgrounded and is verifiable headlessly), and broadcasts a full snapshot
 * each tick. Clients send only their direction intent and render snapshots.
 *
 * AUTHORITY IS net.host(), CONSTRAINED TO THE FROZEN ROSTER. There is one answer
 * to "who is host" — the room's incumbent (net.ts hands it over only when the
 * host leaves) — and roundHost() below simply refuses to point at a peer who
 * cannot act on it.
 *
 * The countdown DIGITS are not in here — each peer runs its own from the moment
 * the round start arrived (src/countdown.ts). This file owns only the flip from
 * 'count' to 'play', which the host performs when its local count ends: that is
 * the instant every snake begins moving, and a room needs exactly one of it.
 *
 * A spectator who wandered in after the countdown holds no
 * NetRoyale: if it ever drove the round, the real host would stand down, nobody
 * would broadcast a snapshot, and the arena would freeze for the whole room,
 * permanently. So when the incumbent is not seated in THIS round, the seats fall
 * back to min-id among themselves — a rule every peer computes identically from
 * the same frozen bytes. Either way a mid-round joiner never takes over, and a
 * seated host leaving still hands off: the promoted peer already holds the last
 * snapshot, adopts it as canonical, re-broadcasts, and resumes the host-only
 * timers, so the round keeps advancing and can still reach game-over. A dropped
 * seat's snake simply keeps moving straight until it crashes — the sim never
 * stalls.
 */

import type { Net, PeerId, Unsubscribe } from '@ben-gy/game-engine/net';
import { makeRng, type Rng } from '@ben-gy/game-engine/rng';
import {
  createRoyale,
  setDir,
  stepRoyale,
  type Dir,
  type RoyaleState,
  type StepEvents,
} from './game';

/**
 * 'count' is the arena built but frozen: snapshots flow, nothing steps. The
 * DIGITS are not here — every peer counts locally from the moment the round
 * start arrived (see src/countdown.ts). What must stay on the wire is the flip
 * to 'play', because that is the instant the snakes start moving and there can
 * only be one of it.
 */
export type Phase = 'count' | 'play' | 'over';

export interface Snapshot {
  state: RoyaleState;
  phase: Phase;
}

export interface NetUpdate {
  state: RoyaleState;
  phase: Phase;
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
  /** Pellets to hold on the floor. Defaults to one per snake plus one. */
  foodTarget?: number;
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
  private onUpdate: (u: NetUpdate) => void;
  private manual: boolean;

  private state: RoyaleState;
  private phase: Phase = 'count';
  private rng: Rng;

  /**
   * Our local countdown finished and asked for the snakes to move, but we were
   * not this round's host at the time so it was not ours to grant.
   *
   * Remembered rather than dropped, because of a real gap: if the host leaves in
   * the sliver between our count ending and its own, nobody is left who is both
   * host and still counting — our begin() was ignored for not being host, and
   * the promoted peer's countdown has already fired. The arena would sit frozen
   * at 3-2-1 forever with every peer waiting on a start that cannot come.
   */
  private beginRequested = false;

  private hosting = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  private sendIn: ((d: { dir: Dir }, to?: PeerId | PeerId[]) => void) & { off: Unsubscribe };
  private sendSnap: ((d: Snapshot, to?: PeerId | PeerId[]) => void) & { off: Unsubscribe };
  private reqSync: ((d: null, to?: PeerId | PeerId[]) => void) & { off: Unsubscribe };

  constructor(cfg: NetRoyaleConfig) {
    this.net = cfg.net;
    this.seed = cfg.seed;
    this.seats = cfg.seats;
    this.tickMs = cfg.tickMs ?? 110;
    this.onUpdate = cfg.onUpdate;
    this.manual = cfg.manualTimers ?? false;
    this.rng = makeRng(cfg.seed);
    this.state = createRoyale(cfg.seed, {
      grid: cfg.grid,
      mode: 'royale',
      players: cfg.players,
      foodTarget: cfg.foodTarget ?? Math.max(2, cfg.players.length + 1),
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
   * The authority for THIS round: the room's incumbent host whenever it is
   * actually seated here, and otherwise the smallest seated peer still present.
   * The fallback covers the two cases where the incumbent cannot serve — it
   * joined mid-round as a spectator, or it inherited the room after the seated
   * host left — and every peer computes it from the same frozen roster, so they
   * cannot disagree. Null until the room has settled: a peer that has not heard
   * from the mesh must not appoint itself.
   */
  private roundHost(): PeerId | null {
    const here = new Set(this.net.peers());
    const live = this.seats.filter((id) => here.has(id));
    if (!live.length) return null;
    const incumbent = this.net.hostSettled() ? this.net.host() : null;
    if (!incumbent) return null;
    if (live.includes(incumbent)) return incumbent;
    return live.reduce((min, p) => (p < min ? p : min));
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
  mySeat(): number {
    return this.seats.indexOf(this.net.selfId);
  }
  snapshot(): Snapshot {
    return { state: this.state, phase: this.phase };
  }

  /**
   * Our local 3-2-1 finished. On the host that starts the arena for everyone; on
   * a guest it is noted and forgotten, because the guest's clock does not get to
   * move anyone's snake — the flip arrives by snapshot a hop later.
   */
  begin(): void {
    this.beginRequested = true;
    if (this.destroyed || !this.amHost() || this.phase !== 'count') return;
    this.phase = 'play';
    this.sendSnap(this.snapshot());
    this.emit(NO_EVENTS);
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
    // The flag is the room's answer; roundHost() is the same answer filtered
    // through the frozen roster, so recheck rather than trust it directly.
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
      // Our own countdown may have run out while we were still a guest, in which
      // case nobody is left to start the arena — see beginRequested.
      if (this.beginRequested && this.phase === 'count') this.begin();
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
    // Safe to run from the moment we host: hostTick() is a no-op until the phase
    // flips, and the flip is begin()'s job alone.
    this.tickTimer = setInterval(() => this.hostTick(), this.tickMs);
    void fresh;
  }

  private stopHosting(): void {
    this.hosting = false;
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private emit(events: StepEvents, promoted = false): void {
    this.onUpdate({
      state: this.state,
      phase: this.phase,
      events,
      promoted,
    });
  }
}
