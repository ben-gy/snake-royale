/**
 * net.ts — zero-backend P2P networking for browser games.
 *
 * Thin, game-friendly wrapper over Trystero (https://github.com/dmotz/trystero).
 * Trystero establishes an encrypted WebRTC mesh between everyone in a room using
 * FREE public infrastructure for the initial handshake — no server of your own,
 * which is exactly what GitHub Pages hosting needs. The default strategy here is
 * `nostr` (public Nostr relays); swap the import for `trystero/torrent` or
 * `trystero/mqtt` if relays are flaky in your region (see README).
 *
 * Netcode model this wrapper assumes: **host-authoritative star**. Every peer
 * runs the same election (lexicographically smallest peer id, self included) so
 * they all independently agree on who the host is — no handshake needed, and it
 * re-elects automatically when the host leaves. The host owns authoritative game
 * state and broadcasts snapshots; clients send inputs. For deterministic
 * lockstep games, pair this with rng.ts (shared seed) instead.
 *
 * COPY THIS FILE into src/ and adapt — do not re-roll the peer/host logic.
 *
 *   npm i trystero
 *
 * Trystero limits to remember:
 *  - Action names (channels) must be <= 12 bytes. Keep them short: 'mv','snap'.
 *  - Payloads are JSON-serialized (or ArrayBuffer/Blob for binary). Keep small.
 */

// Default = nostr strategy. To switch: `import { joinRoom, selfId } from 'trystero/torrent'`.
import { joinRoom, selfId } from 'trystero';

export type PeerId = string;

/** Cheap deep-ish JSON-safe payloads. Trystero handles ArrayBuffer/Blob too. */
export type NetData = unknown;

export interface NetConfig {
  /** Namespaces your game on the shared signaling infra. Use the repo slug. */
  appId: string;
  /** Room id — the shareable code. Peers with the same appId+roomId connect. */
  roomId: string;
  /** Optional shared secret — end-to-end encrypts signaling AND data channels.
   *  Derive it from a code in the invite link for private rooms. */
  password?: string;
}

export interface NetHandlers {
  /** A peer connected. */
  onPeerJoin?: (id: PeerId) => void;
  /** A peer disconnected (tab closed, network dropped). */
  onPeerLeave?: (id: PeerId) => void;
  /** Roster changed (join OR leave). Gives the full, sorted peer list + self. */
  onPeers?: (peers: PeerId[], selfId: PeerId) => void;
  /** The elected host changed (initial election, or host left). */
  onHostChange?: (hostId: PeerId, isSelfHost: boolean) => void;
}

export interface Net {
  /** This peer's stable id for the session. */
  readonly selfId: PeerId;
  /** All connected peers plus self, sorted — identical order on every client. */
  peers(): PeerId[];
  /** The currently elected host id. */
  host(): PeerId;
  /** True when THIS peer is the authoritative host. */
  isHost(): boolean;
  /** How many are in the room right now (peers + self). */
  count(): number;
  /**
   * Register a receive handler for a named channel. Returns a `send` function.
   * Channels are lazily created and memoized. `send(data)` broadcasts to all;
   * `send(data, toPeers)` targets a subset (e.g. just the host).
   */
  channel<T = NetData>(
    name: string,
    onReceive: (data: T, from: PeerId) => void,
  ): (data: T, toPeers?: PeerId | PeerId[]) => void;
  /** Round-trip latency (ms) to a peer, measured via the ping channel. */
  ping(id: PeerId): Promise<number>;
  /** Tear down the room and all channels. Call on unload / leave. */
  leave(): void;
}

/** min-id election: everyone computes the same host from the same sorted list. */
function electHost(peers: PeerId[]): PeerId {
  return peers.reduce((min, p) => (p < min ? p : min), peers[0]);
}

export function createNet(config: NetConfig, handlers: NetHandlers = {}): Net {
  const room = joinRoom(
    { appId: config.appId, ...(config.password ? { password: config.password } : {}) },
    config.roomId,
  );

  const sends = new Map<string, (d: NetData, to?: PeerId | PeerId[]) => void>();
  let currentHost: PeerId = selfId;

  const roster = (): PeerId[] => [selfId, ...Object.keys(room.getPeers())].sort();

  function recomputeHost(): void {
    const next = electHost(roster());
    if (next !== currentHost) {
      currentHost = next;
      handlers.onHostChange?.(currentHost, currentHost === selfId);
    }
  }

  // Seed the initial host (self, until peers arrive) so callers can render state
  // on the very first frame without waiting for a peer event.
  handlers.onHostChange?.(currentHost, true);

  room.onPeerJoin((id) => {
    handlers.onPeerJoin?.(id);
    handlers.onPeers?.(roster(), selfId);
    recomputeHost();
  });

  room.onPeerLeave((id) => {
    handlers.onPeerLeave?.(id);
    handlers.onPeers?.(roster(), selfId);
    recomputeHost();
  });

  // Built-in ping/pong channel for latency HUDs and lag compensation.
  const pending = new Map<string, (rtt: number) => void>();
  const [sendPing, getPing] = room.makeAction<{ t: number; id: string; pong?: boolean }>('ping');
  getPing((msg, from) => {
    if (msg.pong) {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(performance.now() - msg.t);
      }
    } else {
      sendPing({ ...msg, pong: true }, from);
    }
  });

  return {
    selfId,
    peers: roster,
    host: () => currentHost,
    isHost: () => currentHost === selfId,
    count: () => roster().length,

    channel<T = NetData>(name: string, onReceive: (data: T, from: PeerId) => void) {
      if (name.length > 12) {
        // Trystero hard-limits action names to 12 bytes; fail loud in dev.
        throw new Error(`net channel "${name}" exceeds 12 bytes`);
      }
      const existing = sends.get(name);
      if (existing) return existing as (d: T, to?: PeerId | PeerId[]) => void;
      // Trystero 0.21 constrains action payloads to its DataPayload union; our
      // JSON-safe generic satisfies it at runtime, so bypass the compile check.
      const make = room.makeAction as unknown as (
        n: string,
      ) => [
        (d: T, to?: PeerId | PeerId[]) => void,
        (cb: (d: T, from: PeerId) => void) => void,
      ];
      const [send, get] = make(name);
      get((data, from) => onReceive(data, from));
      sends.set(name, send as (d: NetData, to?: PeerId | PeerId[]) => void);
      return send as (d: T, to?: PeerId | PeerId[]) => void;
    },

    ping(id: PeerId) {
      return new Promise<number>((resolve) => {
        const pid = `${performance.now()}-${Math.floor(Math.random() * 1e6)}`;
        pending.set(pid, resolve);
        sendPing({ t: performance.now(), id: pid }, id);
        setTimeout(() => {
          if (pending.delete(pid)) resolve(Infinity);
        }, 5000);
      });
    },

    leave() {
      room.leave();
      sends.clear();
      pending.clear();
    },
  };
}

/** Export selfId for callers that need it before createNet (e.g. UI seeds). */
export { selfId };
