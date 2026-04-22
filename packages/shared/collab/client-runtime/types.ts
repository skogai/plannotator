/**
 * Types for the collab room client runtime.
 *
 * Client-side state shape, options, and event map. Distinct from wire protocol
 * types (which live in ../types.ts).
 */

import type {
  PresenceState,
  RoomAnnotation,
  RoomServerEvent,
  RoomSnapshot,
  RoomStatus,
} from '../types';

// Forward type-only import to break the cycle between types.ts and client.ts.
// `import type` is erased at compile time — no runtime dependency created.
import type { CollabRoomClient } from './client';

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'authenticated'
  | 'reconnecting'
  | 'closed';

// ---------------------------------------------------------------------------
// User identity carried in encrypted presence
// ---------------------------------------------------------------------------

export interface CollabRoomUser {
  /** Stable across reconnects — lives inside encrypted PresenceState.user.id. */
  id: string;
  name: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Client state snapshot
// ---------------------------------------------------------------------------

export interface CollabRoomState {
  connectionStatus: ConnectionStatus;
  roomStatus: RoomStatus | null;
  roomId: string;
  /** Random per WebSocket connection — not a stable participant identifier. */
  clientId: string;
  /**
   * Last server seq consumed by this client. Valid events advance seq after
   * applying state. Malformed or undecryptable events also advance seq without
   * mutating annotation state so reconnect replay does not loop on a bad event.
   * Used as `lastSeq` on reconnect.
   */
  seq: number;
  planMarkdown: string;
  /** Ordered view of internal annotations Map. */
  annotations: RoomAnnotation[];
  /** Keyed by sender clientId. Stale entries are pruned by lastSeen TTL. */
  remotePresence: Record<string, PresenceState>;
  /**
   * True when this client holds the admin secret. The normal participant
   * share URL is `#key=...` only; the `#key=...&admin=...` URL is the
   * sensitive creator/recovery URL and is not intentionally shared with
   * participants. Admin commands resolve by observing the matching
   * room.status broadcast rather than a command-specific ack; a future
   * multi-admin surface would need commandId-correlated acks instead.
   */
  hasAdminCapability: boolean;
  /**
   * Most recent client or server error. `scope` classifies the source so
   * consumers can react only to the classes they care about:
   *
   *   'mutation' — server-sent rejection of a mutation (room.error on an
   *                annotation op this client sent). The annotation
   *                controller uses this to transition in-flight pending
   *                ops to failed. This is the ONLY scope that does so.
   *   'admin'    — admin-command rejection. Consumed by
   *                CollabRoomClient.pendingAdmin; never affects pending
   *                mutations (a failed admin command must not fail a racing add).
   *   'event'    — inbound event from another participant failed to
   *                decode locally (malformed payload, decrypt failure,
   *                reducer rejection). Not a rejection of OUR state.
   *   'presence' — inbound presence frame failed to decode locally. Not
   *                a rejection of our state.
   *   'snapshot' — snapshot replay failed to decode or validate. Not a
   *                rejection of our state.
   *   'join'     — connect/join-phase failure surfaced by the hook
   *                wrapper (mapJoinFailure).
   *
   * `id` is a monotonic counter bumped on every NEW error — state clones
   * rebuild the `lastError` object each emit, so object identity is NOT
   * a safe "same error" signal; consumers must dedupe on `lastErrorId`.
   */
  lastError: { code: string; message: string; scope: 'mutation' | 'admin' | 'event' | 'presence' | 'snapshot' | 'join' } | null;
  /** Monotonic identifier for `lastError`. 0 when no error has ever occurred. */
  lastErrorId: number;
}

// ---------------------------------------------------------------------------
// Event map (subscribed via CollabRoomClient.on)
// ---------------------------------------------------------------------------

export type CollabRoomEvents = {
  status: ConnectionStatus;
  'room-status': RoomStatus;
  snapshot: RoomSnapshot;
  event: RoomServerEvent;
  presence: { clientId: string; presence: PresenceState };
  error: { code: string; message: string };
  /** Fires on any state mutation — React hooks subscribe here. */
  state: CollabRoomState;
};

// ---------------------------------------------------------------------------
// createRoom options + result
// ---------------------------------------------------------------------------

export interface CreateRoomOptions {
  /** e.g. https://room.plannotator.ai or http://localhost:8787 (no trailing slash). */
  baseUrl: string;
  initialSnapshot: RoomSnapshot;
  expiresInDays?: number;
  user: CollabRoomUser;
  /** Test injection. */
  webSocketImpl?: typeof WebSocket;
  /** Test injection. */
  fetchImpl?: typeof fetch;
  /** Optional reconnect tuning for the returned client. */
  reconnect?: ReconnectOptions;
  /**
   * Abort the fetch to the room service. If the signal is already aborted
   * when createRoom() is called, it rejects immediately. If the signal
   * aborts mid-fetch, the fetch is cancelled and createRoom rejects with
   * a CreateRoomError.
   */
  signal?: AbortSignal;
  /**
   * Cap for the room-creation fetch in ms. If neither the signal fires nor
   * the server responds within this window, createRoom() rejects with a
   * CreateRoomError. Default: 10_000 ms.
   */
  timeoutMs?: number;
}

export interface CreateRoomResult {
  roomId: string;
  /** 32-byte raw secret. Callers may discard after building URLs. */
  roomSecret: Uint8Array;
  /** 32-byte raw admin secret. Callers should persist carefully (creator-only). */
  adminSecret: Uint8Array;
  /** #key-only URL. Safe to share with participants. */
  joinUrl: string;
  /** #key + #admin URL. Creator/recovery only — never the default share target. */
  adminUrl: string;
  /** Constructed but NOT connected. Caller invokes client.connect(). */
  client: CollabRoomClient;
}

// ---------------------------------------------------------------------------
// joinRoom options
// ---------------------------------------------------------------------------

export interface JoinRoomOptions {
  /** Full room URL including fragment. */
  url: string;
  /** Override if admin capability is not in URL fragment. base64url string or raw bytes. */
  adminSecret?: Uint8Array | string;
  user: CollabRoomUser;
  webSocketImpl?: typeof WebSocket;
  reconnect?: ReconnectOptions;
  /** If true, awaits connect() before returning. Default: false. */
  autoConnect?: boolean;
}

export interface ReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Exponential backoff multiplier per attempt. Default: 2. */
  factor?: number;
  /** 0 disables auto-reconnect entirely (useful in tests). Default: Infinity. */
  maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// Internal client constructor options (used by createRoom/joinRoom)
// ---------------------------------------------------------------------------

export interface InternalClientOptions {
  roomId: string;
  baseUrl: string;
  eventKey: CryptoKey;
  presenceKey: CryptoKey;
  adminKey: CryptoKey | null;
  roomVerifier: string;
  adminVerifier: string | null;
  user: CollabRoomUser;
  /** Seed initial state from known snapshot (used by createRoom). */
  initialSnapshot?: RoomSnapshot;
  webSocketImpl?: typeof WebSocket;
  reconnect?: ReconnectOptions;
  /** Connect timeout in milliseconds. Default: 10_000. */
  connectTimeoutMs?: number;
  /** Presence TTL in milliseconds. Default: 30_000. */
  presenceTtlMs?: number;
  /** Presence sweep interval. Default: 5_000. */
  presenceSweepIntervalMs?: number;
}

// Note: concrete CollabRoomClient class lives in client.ts to avoid forward-reference cycles.
