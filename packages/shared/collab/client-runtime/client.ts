/**
 * CollabRoomClient — the browser/agent runtime for Plannotator Live Rooms.
 *
 * Owns WebSocket lifecycle, auth handshake, message dispatch, state management,
 * auto-reconnect with backoff, and admin command flow.
 *
 * V1 state model: server echo is authoritative. Annotation mutations are NOT
 * applied optimistically — they are only applied when the server echoes them
 * back via room.event. See sendOp() for the rationale (no opId-correlated
 * ack/reject in V1, so no safe rollback path).
 *
 * Zero-knowledge: decrypts server-provided ciphertext locally; encrypts before send.
 */

import {
  computeAuthProof,
  computeAdminProof,
  encryptEventOp,
  decryptEventPayload,
  encryptPresence,
  decryptPresence,
  decryptSnapshot,
} from '../crypto';
import { ADMIN_ERROR_CODES, WS_CLOSE_ROOM_UNAVAILABLE } from '../constants';
import { generateOpId } from '../ids';
import type {
  AdminChallenge,
  AdminCommand,
  AuthAccepted,
  AuthChallenge,
  PresenceState,
  RoomAnnotation,
  RoomEventClientOp,
  RoomServerEvent,
  RoomSnapshot,
  RoomTransportMessage,
  ServerEnvelope,
} from '../types';
import { isPresenceState, isRoomEventClientOp, isRoomSnapshot } from '../types';
// Event channel uses isRoomEventClientOp (event ops ONLY — no presence.update).
// Presence channel uses isPresenceState (validates raw PresenceState payloads).
// This split prevents presence.update from leaking into the durable event log.
import { applyAnnotationEvent, annotationsToArray, cloneRoomAnnotation, cloneRoomAnnotationPatch } from './apply-event';
import { computeBackoffMs, DEFAULT_BACKOFF } from './backoff';
import { TypedEventEmitter } from './emitter';
import type {
  CollabRoomEvents,
  CollabRoomState,
  ConnectionStatus,
  InternalClientOptions,
  ReconnectOptions,
} from './types';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ConnectTimeoutError extends Error { constructor() { super('WebSocket connect/auth timed out'); this.name = 'ConnectTimeoutError'; } }
export class AuthRejectedError extends Error { constructor(msg = 'Auth rejected') { super(msg); this.name = 'AuthRejectedError'; } }
export class RoomUnavailableError extends Error { constructor(msg = 'Room unavailable') { super(msg); this.name = 'RoomUnavailableError'; } }
export class NotConnectedError extends Error { constructor() { super('Client is not authenticated'); this.name = 'NotConnectedError'; } }
export class AdminNotAuthorizedError extends Error { constructor() { super('No admin capability'); this.name = 'AdminNotAuthorizedError'; } }
export class AdminTimeoutError extends Error { constructor() { super('Admin command timed out'); this.name = 'AdminTimeoutError'; } }
export class AdminInterruptedError extends Error { constructor() { super('Admin command interrupted by socket close'); this.name = 'AdminInterruptedError'; } }
export class AdminRejectedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AdminRejectedError';
  }
}

/**
 * Thrown by public mutation methods when the payload fails shape validation
 * BEFORE encryption/send. This catches UI bugs early — without it, a bad
 * payload would be encrypted, sequenced by the server, echoed, and then
 * rejected by every client (including the sender) with no clear signal that
 * the original send was the cause.
 */
export class InvalidOutboundPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutboundPayloadError';
  }
}

// ---------------------------------------------------------------------------
// Clone helpers for getState() immutability
//
// V1 state is server-authoritative: internal annotation/presence objects must
// only be mutated by decrypted server events. If getState() exposed internal
// references, UI code could silently corrupt local state by mutating a
// returned annotation or cursor. These helpers keep the public surface
// read-only.
//
// cloneRoomAnnotation is imported from apply-event.ts (single source of truth
// for the nested-meta clone rule — avoids drift if a new nested field is
// added to RoomAnnotation).
// ---------------------------------------------------------------------------

function clonePresenceState(p: PresenceState): PresenceState {
  return {
    ...p,
    user: { ...p.user },
    cursor: p.cursor ? { ...p.cursor } : null,
  };
}

/** Clone a decoded RoomServerEvent so emission to subscribers is isolated from internal state. */
/**
 * Clone an outbound RoomEventClientOp so the payload the client queues for
 * encryption is immune to caller mutation. Public mutation methods clone
 * synchronously before validation + queueing; if the caller mutates the
 * annotation/patch/ids array after the call returns, the queued op stays
 * pinned to the value at call time.
 */
function cloneRoomEventClientOp(op: RoomEventClientOp): RoomEventClientOp {
  switch (op.type) {
    case 'annotation.add':
      return { type: 'annotation.add', annotations: op.annotations.map(cloneRoomAnnotation) };
    case 'annotation.update':
      return { type: 'annotation.update', id: op.id, patch: cloneRoomAnnotationPatch(op.patch) };
    case 'annotation.remove':
      return { type: 'annotation.remove', ids: [...op.ids] };
    case 'annotation.clear':
      return { type: 'annotation.clear', source: op.source };
  }
}

function cloneRoomServerEvent(event: RoomServerEvent): RoomServerEvent {
  switch (event.type) {
    case 'annotation.add':
      return { type: 'annotation.add', annotations: event.annotations.map(cloneRoomAnnotation) };
    case 'annotation.update':
      return { type: 'annotation.update', id: event.id, patch: cloneRoomAnnotationPatch(event.patch) };
    case 'annotation.remove':
      return { type: 'annotation.remove', ids: [...event.ids] };
    case 'annotation.clear':
      return { type: 'annotation.clear', source: event.source };
    case 'snapshot':
      return {
        type: 'snapshot',
        snapshotSeq: event.snapshotSeq,
        payload: { ...event.payload, annotations: event.payload.annotations.map(cloneRoomAnnotation) },
      };
    case 'presence.update':
      return { type: 'presence.update', clientId: event.clientId, presence: clonePresenceState(event.presence) };
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PRESENCE_TTL_MS = 30_000;
const DEFAULT_PRESENCE_SWEEP_INTERVAL_MS = 5_000;
const ADMIN_COMMAND_TIMEOUT_MS = 5_000;

/**
 * `room.error` codes that are emitted exclusively from the admin command
 * path on the server. A pending admin command rejects ONLY when a room.error
 * with one of these codes arrives; other codes (e.g. `validation_error`
 * from an event-channel op) are event-channel failures and must not
 * cancel an in-flight admin command.
 *
 * Derived from the shared `ADMIN_ERROR_CODES` tuple so there is exactly
 * one source of truth across the server (`sendAdminError` call sites in
 * `room-do.ts`) and this client. Membership check tolerates unknown
 * strings as non-admin — forward-compatible with servers that add
 * future codes we don't yet recognize.
 */
// Typed as `Set<string>` (not `Set<AdminErrorCode>`) because we call
// `.has(msg.code)` where `msg.code: string` arrives from the wire —
// forward-compatibility with unknown future codes is intentional:
// they fall through as non-admin, not typecheck errors at the
// membership site.
const ADMIN_SCOPED_ERROR_CODES: ReadonlySet<string> =
  new Set<string>(ADMIN_ERROR_CODES);


// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingAdmin {
  command: AdminCommand;
  resolve: () => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface PendingConnect {
  resolve: () => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class CollabRoomClient {
  // Identity / keys (stable across reconnects)
  private readonly roomId: string;
  private readonly baseUrl: string;
  private readonly eventKey: CryptoKey;
  private readonly presenceKey: CryptoKey;
  private readonly adminKey: CryptoKey | null;
  private readonly roomVerifier: string;
  private readonly adminVerifier: string | null;

  // Runtime state
  private ws: WebSocket | null = null;
  /**
   * Monotonic generation counter. Incremented every time openSocket()
   * installs a new WebSocket. Queued async handlers (room.snapshot,
   * room.event, room.presence, room.status, room.error) capture the
   * generation at dispatch time and re-check it after any async decrypt
   * before mutating state — so a late decrypt from a retired socket can
   * never clobber the newer socket's state, even though the retired
   * socket's onmessage was already short-circuited by the retiredSockets
   * gate (the async continuation could still be in flight).
   */
  private socketGeneration = 0;
  /**
   * Sockets we've actively retired. Their onmessage/onclose/onerror handlers
   * no-op once a socket is in this set. WeakSet so retired sockets can be
   * GC'd once they close.
   *
   * Two paths add to this set:
   *   1. openSocket() when REPLACING a prior socket — the replacement retires
   *      the predecessor so its late events don't clobber the new socket.
   *   2. closeSocket() for INTENTIONAL closes of the current socket
   *      (disconnect, connect timeout, auth-proof failure). These callers
   *      do their own synchronous lifecycle cleanup (reject pendingConnect /
   *      pendingAdmin, set status, clear presence) BEFORE calling closeSocket,
   *      so the async onclose does not need to run handleSocketClose — and
   *      must not, or it could clobber state the caller already settled.
   *
   * Network-initiated closes of the current socket (server close, network
   * drop) do NOT go through closeSocket — they reach onclose directly with
   * the socket NOT in this set, so handleSocketClose runs as normal and does
   * the reconnect / pending-rejection logic itself.
   */
  private retiredSockets = new WeakSet<WebSocket>();
  private clientId: string = '';                // regenerated per connect
  private status: ConnectionStatus = 'disconnected';
  /**
   * True after the server closed our socket with the "room unavailable"
   * terminal code. Replaces the former `roomStatus` tri-state — the
   * client does not distinguish admin delete, auto-expiry, or
   * unknown-room. All three produce the same generic terminal UX.
   */
  private roomUnavailable: boolean = false;
  private seq: number = 0;
  private planMarkdown: string = '';
  private annotations = new Map<string, RoomAnnotation>();
  private remotePresence = new Map<string, { presence: PresenceState; lastSeen: number }>();
  private lastError: { code: string; message: string; scope: 'mutation' | 'admin' | 'event' | 'presence' | 'snapshot' | 'join' } | null = null;
  /**
   * Monotonic id bumped on every NEW lastError assignment. Exposed via
   * `CollabRoomState.lastErrorId` so consumers can dedupe state emissions
   * without relying on object identity — buildState() clones `lastError`
   * each call, so identity changes even when the underlying error didn't.
   * Clearing (lastError = null) does NOT bump — consumers can check
   * `state.lastError === null` independently.
   */
  private lastErrorId: number = 0;

  /**
   * Centralized setter so every event-channel error assignment bumps
   * `lastErrorId`. Prefer this over direct `this.lastError = ...`; the
   * direct form is only appropriate for `= null` resets.
   */
  private setLastError(
    code: string,
    message: string,
    scope: 'mutation' | 'admin' | 'event' | 'presence' | 'snapshot' | 'join',
  ): void {
    this.lastError = { code, message, scope };
    this.lastErrorId++;
  }
  /**
   * True when the most-recent snapshot attempt failed (malformed or
   * decrypt-failed) and a valid baseline has not yet been re-established.
   * While true, inbound room.events are rejected — applying events on top of
   * a stale baseline would produce silently-divergent local state. Cleared
   * when a valid snapshot is applied or the client reconnects.
   */
  private baselineInvalid = false;

  // Admin flow
  private pendingAdmin: PendingAdmin | null = null;

  // Lifecycle state
  private pendingConnect: PendingConnect | null = null;
  private pendingConnectPromise: Promise<void> | null = null;
  private userDisconnected = false;

  // Serialized async message processing queue.
  // Ensures snapshot/event/presence decrypts apply in wire order regardless
  // of decrypt latency variance. Prevents the race where an event's decrypt
  // finishes before a concurrent snapshot's decrypt and then gets clobbered.
  private messageQueue: Promise<void> = Promise.resolve();
  /**
   * Serializes outbound EVENT-channel sends. Encryption is async, so two
   * concurrent sendAnnotationAdd()/Remove()/Update()/Clear() calls could
   * otherwise race and send in completion order rather than call order —
   * a user clicking "add" then "remove" could see remove land first, leaving
   * the annotation the remove was supposed to delete. Presence is NOT in
   * this queue — it's lossy by design and throughput matters more than
   * strict ordering there.
   */
  private outboundEventQueue: Promise<unknown> = Promise.resolve();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceSweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Watchdog for auto-reconnect handshakes. Initial connect() uses
   * pendingConnect's own connectTimeoutMs; auto-reconnect does not, so
   * without this a reconnect socket that opens but never authenticates would
   * hang the client in `connecting` / `authenticating` forever.
   */
  private reconnectHandshakeTimer: ReturnType<typeof setTimeout> | null = null;

  // Injected / options
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly reconnectOpts: Required<ReconnectOptions>;
  private readonly connectTimeoutMs: number;
  private readonly presenceTtlMs: number;
  private readonly presenceSweepIntervalMs: number;

  // Emitter
  private readonly emitter = new TypedEventEmitter<CollabRoomEvents>();

  constructor(options: InternalClientOptions) {
    this.roomId = options.roomId;
    this.baseUrl = options.baseUrl;
    this.eventKey = options.eventKey;
    this.presenceKey = options.presenceKey;
    this.adminKey = options.adminKey;
    this.roomVerifier = options.roomVerifier;
    this.adminVerifier = options.adminVerifier;
    // options.user is reserved for future use (presence auto-construction); not stored.
    this.WebSocketImpl = options.webSocketImpl ?? WebSocket;
    this.reconnectOpts = {
      initialDelayMs: options.reconnect?.initialDelayMs ?? DEFAULT_BACKOFF.initialDelayMs,
      maxDelayMs: options.reconnect?.maxDelayMs ?? DEFAULT_BACKOFF.maxDelayMs,
      factor: options.reconnect?.factor ?? DEFAULT_BACKOFF.factor,
      maxAttempts: options.reconnect?.maxAttempts ?? Number.POSITIVE_INFINITY,
    };
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.presenceTtlMs = options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;
    this.presenceSweepIntervalMs = options.presenceSweepIntervalMs ?? DEFAULT_PRESENCE_SWEEP_INTERVAL_MS;

    // Seed initial snapshot if provided (by createRoom). Clone on store so
    // a caller mutating their snapshot object later can't reach back into
    // the client's internal annotations map.
    if (options.initialSnapshot) {
      this.planMarkdown = options.initialSnapshot.planMarkdown;
      for (const ann of options.initialSnapshot.annotations) {
        this.annotations.set(ann.id, cloneRoomAnnotation(ann));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  on<K extends keyof CollabRoomEvents>(
    name: K,
    fn: (p: CollabRoomEvents[K]) => void,
  ): () => void {
    return this.emitter.on(name, fn);
  }

  getState(): CollabRoomState {
    return this.buildState();
  }

  async connect(): Promise<void> {
    // Already authenticated → resolved no-op
    if (this.status === 'authenticated') {
      return;
    }

    // Already in-flight → return the existing pending promise (shared by all callers).
    // Invariant: pendingConnect and pendingConnectPromise are always set/cleared
    // together. If this fires, it indicates a programming error.
    if (this.pendingConnect) {
      if (!this.pendingConnectPromise) {
        throw new Error('CollabRoomClient connect() invariant violated: pendingConnect set without pendingConnectPromise');
      }
      return this.pendingConnectPromise;
    }

    // Explicit connect clears any poisoned state from prior disconnect/terminal
    this.userDisconnected = false;
    this.lastError = null;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();

    // Build the promise FIRST, wire up pendingConnect + pendingConnectPromise,
    // and only then open the socket. openSocket() calls setStatus('connecting'),
    // which synchronously emits state. If a listener re-enters connect() during
    // that emission, both refs must already be consistent — otherwise the
    // fallback return would hand out a promise that's disconnected from the
    // actual handshake.
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const timeoutHandle = setTimeout(() => {
      if (this.pendingConnect) {
        // Synchronous cleanup: closeSocket retires the socket so its async
        // onclose won't re-enter handleSocketClose. All lifecycle transitions
        // happen here.
        this.pendingConnect = null;
        this.pendingConnectPromise = null;
        this.closeSocket(1000, 'connect timeout');
        this.setStatus('disconnected');
        reject(new ConnectTimeoutError());
      }
    }, this.connectTimeoutMs);

    this.pendingConnect = { resolve, reject, timeoutHandle };
    this.pendingConnectPromise = promise;
    // Clean up promise ref when settled — attach BEFORE openSocket so the
    // handlers exist if an unusual synchronous rejection path fires.
    promise.then(
      () => { if (this.pendingConnectPromise === promise) this.pendingConnectPromise = null; },
      () => { if (this.pendingConnectPromise === promise) this.pendingConnectPromise = null; },
    );

    // openSocket() runs outside the Promise executor (so pendingConnectPromise
    // is already assigned before `setStatus('connecting')` emits). That means
    // a synchronous throw here — e.g. `new URL(baseUrl)` rejecting a bad base,
    // or a WebSocket constructor throwing — would otherwise leave pendingConnect
    // and the timeout live, poisoning later connect() calls with a stale
    // in-flight promise. Catch, clean up, and reject the connect promise.
    try {
      this.openSocket();
    } catch (err) {
      clearTimeout(timeoutHandle);
      if (this.pendingConnect?.timeoutHandle === timeoutHandle) {
        this.pendingConnect = null;
      }
      if (this.pendingConnectPromise === promise) {
        this.pendingConnectPromise = null;
      }
      this.setStatus('disconnected');
      reject(err instanceof Error ? err : new Error(String(err)));
    }
    return promise;
  }

  disconnect(reason?: string): void {
    this.userDisconnected = true;
    this.clearReconnectTimer();
    this.clearReconnectHandshakeTimer();
    // Synchronous lifecycle cleanup — closeSocket retires the socket, so the
    // async onclose will NOT run handleSocketClose to do this cleanup for us.
    if (this.pendingConnect) {
      clearTimeout(this.pendingConnect.timeoutHandle);
      const { reject } = this.pendingConnect;
      this.pendingConnect = null;
      this.pendingConnectPromise = null;
      reject(new AuthRejectedError('Disconnected by user'));
    }
    if (this.pendingAdmin) {
      const pending = this.pendingAdmin;
      this.pendingAdmin = null;
      clearTimeout(pending.timeoutHandle);
      pending.reject(new AdminInterruptedError());
    }
    this.remotePresence.clear();
    this.closeSocket(1000, reason ?? 'user disconnect');
    this.stopPresenceSweep();
    this.setStatus('closed');
  }

  // ---------------------------------------------------------------------------
  // Mutation contract (V1)
  //
  // Mutation methods below resolve when the op is SENT, not when local state
  // has been updated. Local state updates when the server echoes the op back
  // via room.event — subscribe to the `state` event to observe post-echo
  // state.annotations. A caller that awaits `sendAnnotationAdd(...)` and then
  // reads `getState().annotations` may still see pre-echo state.
  //
  // Rationale: V1 has no opId-correlated ack/reject (see sendOp comments).
  // Applying optimistically would be unsafe; requiring a round-trip before
  // resolution would couple send latency to UI responsiveness. Decoupling the
  // send ack from the state update matches the wire semantics exactly.
  // ---------------------------------------------------------------------------

  /** Resolves when queued/sent to the server. State updates arrive via `state` events after echo. */
  async sendAnnotationAdd(annotations: RoomAnnotation[]): Promise<void> {
    // Clone SYNCHRONOUSLY before validation + queueing so the payload is
    // immutable with respect to caller mutations after this call returns.
    const op = cloneRoomEventClientOp({ type: 'annotation.add', annotations });
    if (!isRoomEventClientOp(op)) {
      throw new InvalidOutboundPayloadError('Invalid annotation.add payload');
    }
    await this.sendOp(op);
  }

  /** Resolves when queued/sent to the server. State updates arrive via `state` events after echo. */
  async sendAnnotationUpdate(id: string, patch: Partial<RoomAnnotation>): Promise<void> {
    const op = cloneRoomEventClientOp({ type: 'annotation.update', id, patch });
    if (!isRoomEventClientOp(op)) {
      throw new InvalidOutboundPayloadError('Invalid annotation.update payload');
    }
    await this.sendOp(op);
  }

  /** Resolves when queued/sent to the server. State updates arrive via `state` events after echo. */
  async sendAnnotationRemove(ids: string[]): Promise<void> {
    const op = cloneRoomEventClientOp({ type: 'annotation.remove', ids });
    if (!isRoomEventClientOp(op)) {
      throw new InvalidOutboundPayloadError('Invalid annotation.remove payload');
    }
    await this.sendOp(op);
  }

  /** Resolves when queued/sent to the server. State updates arrive via `state` events after echo. */
  async sendAnnotationClear(source?: string): Promise<void> {
    const op = cloneRoomEventClientOp({ type: 'annotation.clear', source });
    if (!isRoomEventClientOp(op)) {
      throw new InvalidOutboundPayloadError('Invalid annotation.clear payload');
    }
    await this.sendOp(op);
  }

  async sendPresence(presence: PresenceState): Promise<void> {
    // Shape validation is a real programming error (caller passed an
    // invalid object); surface it even for fire-and-forget callers.
    if (!isPresenceState(presence)) {
      throw new InvalidOutboundPayloadError('Invalid presence payload');
    }
    // Presence is lossy by design — a dropped cursor update is fine; the
    // next mouse move fires another. Swallow disconnect-only failures so
    // UI code that calls sendPresence() without awaiting (common for cursor
    // throttles) doesn't log spurious "not connected" errors during brief
    // reconnect windows. Shape errors above still throw.
    try {
      this.assertConnected();
    } catch {
      return;
    }
    const opId = generateOpId();
    const ciphertext = await encryptPresence(this.presenceKey, presence);

    // Recheck socket after async encryption — it may have closed.
    const ws = this.ws;
    if (this.status !== 'authenticated' || !ws) {
      return;  // lossy: see comment above
    }

    const envelope: ServerEnvelope = {
      clientId: this.clientId,
      opId,
      channel: 'presence',
      ciphertext,
    };
    try {
      ws.send(JSON.stringify(envelope));
    } catch {
      // Socket transitioned to closing between the liveness check and send.
      // Still lossy — drop silently.
    }
  }

  async deleteRoom(): Promise<void> {
    if (!this.adminKey || !this.adminVerifier) throw new AdminNotAuthorizedError();
    await this.runAdminCommand({ type: 'room.delete' });
  }

  // ---------------------------------------------------------------------------
  // Internal: socket lifecycle
  // ---------------------------------------------------------------------------

  private openSocket(): void {
    // Reset clientId; the authoritative value will come from auth.challenge.clientId.
    // We leave a placeholder here for pre-auth logging only.
    this.clientId = '';

    // If a socket is already in-flight (e.g. auto-reconnect opened one and the
    // caller immediately invoked connect() again), RETIRE it. Retirement
    // marks the socket so its handlers no-op when they eventually fire —
    // otherwise the old socket's late onclose/onmessage could clobber state
    // belonging to the new socket.
    if (this.ws) {
      this.retireSocket(this.ws);
    }

    const wsUrl = this.buildWebSocketUrl();
    this.setStatus('connecting');

    // Abort guard: setStatus emits synchronously. A listener could call
    // disconnect() during that emission, which sets userDisconnected=true
    // and puts status at 'closed'. If we continue, we'd open a dead socket.
    // The same applies if another listener cascade rotated status away from
    // 'connecting'.
    if (this.userDisconnected || this.status !== 'connecting') {
      return;
    }

    const ws = new this.WebSocketImpl(wsUrl);
    this.ws = ws;
    this.socketGeneration++;

    // Arm a handshake watchdog when this socket is opened by auto-reconnect
    // (pendingConnect is null). Initial connect paths already have their own
    // connectTimeoutMs on pendingConnect, so we don't double-arm there.
    this.clearReconnectHandshakeTimer();
    if (!this.pendingConnect) {
      this.reconnectHandshakeTimer = setTimeout(() => {
        this.reconnectHandshakeTimer = null;
        // Only act if this is still the current socket and we're not
        // authenticated yet — otherwise the watchdog is stale.
        if (this.ws !== ws || this.status === 'authenticated') return;
        this.closeSocket(1000, 'reconnect handshake timeout');
        this.scheduleReconnectAfterSocketFailure();
      }, this.connectTimeoutMs);
    }

    // No ws.onopen handler — we transition to 'authenticating' when the
    // server sends auth.challenge, not when the socket opens.

    // Handlers gate on the retiredSockets set rather than on `this.ws !== ws`.
    // The reason: network-initiated closes of the current socket must still
    // reach handleSocketClose() (for reconnect scheduling and pending-promise
    // rejection), while replaced or intentionally retired sockets must no-op.
    // A `this.ws !== ws` check would gate out both paths, so we use the
    // explicit retiredSockets set to distinguish them.
    ws.onmessage = (ev: MessageEvent) => {
      if (this.retiredSockets.has(ws)) return;
      this.handleSocketMessage(ev.data);
    };

    ws.onclose = (ev: CloseEvent) => {
      if (this.retiredSockets.has(ws)) return;
      this.handleSocketClose(ev.code, ev.reason);
    };

    ws.onerror = () => {
      if (this.retiredSockets.has(ws)) return;
      this.emitter.emit('error', { code: 'socket_error', message: 'WebSocket error' });
    };
  }

  /**
   * Retire a socket without touching this.ws. Used by openSocket() when a
   * replacement is being installed. Stale handlers on this socket no-op.
   */
  private retireSocket(ws: WebSocket): void {
    this.retiredSockets.add(ws);
    try { ws.close(1000, 'replaced by new connection'); } catch { /* ignore */ }
  }

  /**
   * Intentionally close the CURRENT socket (disconnect, connect timeout, auth
   * failure). Retires the socket so its async onclose will not re-enter
   * handleSocketClose in a state where this.ws may have been repointed (in
   * browsers, ws.close() fires onclose asynchronously — if the caller opens
   * a new socket before that fires, the stale onclose would otherwise clobber
   * the new socket's state).
   *
   * Because onclose is short-circuited after retirement, callers of this
   * method MUST do their own synchronous lifecycle cleanup — reject
   * pendingConnect/pendingAdmin, set status, stop presence sweep — BEFORE
   * calling closeSocket. Do NOT rely on handleSocketClose running as a side
   * effect of this call.
   *
   * Network-initiated closes of the current socket (server close, network
   * drop) do NOT go through this method and remain handled by handleSocketClose.
   */
  private closeSocket(code: number, reason: string): void {
    if (!this.ws) return;
    const ws = this.ws;
    this.retiredSockets.add(ws);
    this.ws = null;
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }

  private handleSocketClose(code: number, reason: string): void {
    this.ws = null;
    // Socket is gone — any reconnect-handshake watchdog for it is moot.
    this.clearReconnectHandshakeTimer();

    // Set the terminal flag BEFORE the pendingAdmin and terminal checks
    // below. Any close with the dedicated "room unavailable" code means
    // the link no longer resolves — admin delete, auto-expiry, or an
    // unknown-room connect. We don't distinguish the cause.
    if (code === WS_CLOSE_ROOM_UNAVAILABLE) {
      this.roomUnavailable = true;
    }

    if (this.pendingConnect) {
      clearTimeout(this.pendingConnect.timeoutHandle);
      const { reject } = this.pendingConnect;
      this.pendingConnect = null;
      // Clear pendingConnectPromise synchronously too — the microtask-scheduled
      // .then cleanup runs later; during that window the invariant
      // "pendingConnect <=> pendingConnectPromise" would be broken if read by
      // a reentrant caller.
      this.pendingConnectPromise = null;
      const err = code === WS_CLOSE_ROOM_UNAVAILABLE
        ? new RoomUnavailableError(reason || 'Room unavailable')
        : new AuthRejectedError(`Socket closed during auth: ${reason}`);
      reject(err);
      // If disconnect() already fired, respect the terminal intent — don't
      // overwrite 'closed' with 'disconnected' just because auth was pending.
      if (this.userDisconnected) {
        this.stopPresenceSweep();
        this.setStatus('closed');
      } else {
        this.setStatus('disconnected');
      }
      return;
    }

    // Reject pending admin if socket closed mid-flight.
    // For delete: the server closes our socket with WS_CLOSE_ROOM_UNAVAILABLE
    // as the success signal — purging the room tears down all sockets
    // (including ours). Any other close (network drop, server error) must
    // reject so callers don't mistakenly believe a failed/interrupted
    // delete succeeded.
    if (this.pendingAdmin) {
      const pending = this.pendingAdmin;
      this.pendingAdmin = null;
      clearTimeout(pending.timeoutHandle);
      const isSuccessfulDeleteClose =
        pending.command.type === 'room.delete' &&
        code === WS_CLOSE_ROOM_UNAVAILABLE;
      if (isSuccessfulDeleteClose) {
        pending.resolve();
      } else {
        pending.reject(new AdminInterruptedError());
      }
    }

    this.remotePresence.clear();
    this.stopPresenceSweep();

    // Terminal close or user-initiated? Don't reconnect.
    const isTerminal =
      this.userDisconnected ||
      code === WS_CLOSE_ROOM_UNAVAILABLE ||
      this.roomUnavailable;

    if (isTerminal) {
      // setStatus already emits `state` on a transition; no trailing emitState
      // needed (would cause a redundant React render).
      this.setStatus('closed');
      return;
    }

    // Auto-reconnect shares implementation with the explicit-failure path.
    this.scheduleReconnect();
  }

  /**
   * Explicit reconnect scheduling without waiting for onclose. Used by code
   * paths that deterministically close the current socket (e.g. auth-proof
   * failure during auto-reconnect) and need the client to continue the
   * reconnect loop rather than sit in the closing state waiting for a
   * deferred close event.
   */
  private scheduleReconnectAfterSocketFailure(): void {
    this.remotePresence.clear();
    this.stopPresenceSweep();

    if (this.userDisconnected || this.roomUnavailable) {
      this.setStatus('closed');
      return;
    }

    this.scheduleReconnect();
  }

  /**
   * Shared reconnect scheduling: checks max-attempts, transitions to
   * 'reconnecting' or 'closed', and arms the backoff timer.
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= this.reconnectOpts.maxAttempts) {
      this.setStatus('closed');
      return;
    }
    this.setStatus('reconnecting');
    const delay = computeBackoffMs(this.reconnectAttempt++, this.reconnectOpts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Internal: message dispatch
  // ---------------------------------------------------------------------------

  private handleSocketMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      const text = typeof raw === 'string' ? raw : String(raw);
      msg = JSON.parse(text);
    } catch {
      return; // malformed server message — ignore
    }

    // Auth phase messages
    if (msg.type === 'auth.challenge') {
      this.handleAuthChallenge(msg as unknown as AuthChallenge);
      return;
    }
    if (msg.type === 'auth.accepted') {
      this.handleAuthAccepted(msg as unknown as AuthAccepted);
      return;
    }

    // Admin challenge (response to admin.challenge.request)
    if (msg.type === 'admin.challenge') {
      this.handleAdminChallenge(msg as unknown as AdminChallenge);
      return;
    }

    // Transport messages — serialize via messageQueue so decrypts apply in wire order.
    // Capture the socket generation at dispatch time. The handlers below
    // re-check it after any async decrypt and drop the message if the
    // generation has rolled (reconnect opened a new socket during the
    // decrypt). This prevents stale messages from clobbering newer state.
    const gen = this.socketGeneration;
    if (msg.type === 'room.snapshot') {
      const snap = msg as unknown as Extract<RoomTransportMessage, { type: 'room.snapshot' }>;
      this.enqueue(() => this.handleRoomSnapshot(snap, gen));
      return;
    }
    if (msg.type === 'room.event') {
      const event = msg as unknown as Extract<RoomTransportMessage, { type: 'room.event' }>;
      this.enqueue(() => this.handleRoomEvent(event, gen));
      return;
    }
    if (msg.type === 'room.presence') {
      const presence = msg as unknown as Extract<RoomTransportMessage, { type: 'room.presence' }>;
      this.enqueue(() => this.handleRoomPresence(presence, gen));
      return;
    }
    if (msg.type === 'room.error') {
      // Route through the queue so an error that references a specific event
      // (e.g. validation_error for an in-flight op) can't beat the event /
      // status messages that preceded it in wire order.
      const err = msg as unknown as Extract<RoomTransportMessage, { type: 'room.error' }>;
      this.enqueue(async () => { this.handleRoomError(err, gen); });
      return;
    }
    if (msg.type === 'room.participant.left') {
      // Broadcast from the server when a peer's WebSocket closed.
      // Drop their presence immediately so the UI doesn't hold a
      // ghost cursor until the 30s TTL sweep — that stale window
      // made "refresh to test" show one extra bubble per refresh.
      //
      // Route through the queue so the delete observes wire order
      // against any still-decrypting presence from the same peer.
      // Without this, wire order presence→left lets the queued
      // presence decrypt resolve AFTER the synchronous delete and
      // re-insert the peer — reviving the ghost for a full TTL.
      //
      // Protocol validation: require a non-empty string clientId.
      // Garbage from a non-conforming server or a buggy relay is
      // ignored rather than corrupting the presence map.
      const left = msg as unknown as Extract<RoomTransportMessage, { type: 'room.participant.left' }>;
      this.enqueue(async () => {
        if (typeof left.clientId === 'string' && left.clientId.length > 0) {
          if (this.remotePresence.delete(left.clientId)) {
            this.emitState();
          }
        }
      });
      return;
    }
  }

  private async handleAuthChallenge(challenge: AuthChallenge): Promise<void> {
    this.setStatus('authenticating');
    // The server assigns clientId on the challenge; adopt it here so the
    // proof binds to exactly the value the server will verify. Capturing
    // `ws` and `clientId` locally lets the post-await guard detect a
    // rotation (reconnect opened a new socket mid-proof) and drop the
    // stale response.
    //
    // Protocol-shape validation. Missing/malformed challenge fields come from
    // an old server or malformed message and must fail fast — otherwise the
    // client would sit in `authenticating` until connectTimeoutMs.
    const protocolError =
      (typeof challenge.clientId !== 'string' || challenge.clientId.length === 0)
        ? 'Missing or invalid clientId in auth.challenge'
      : (typeof challenge.challengeId !== 'string' || challenge.challengeId.length === 0)
        ? 'Missing or invalid challengeId in auth.challenge'
      : (typeof challenge.nonce !== 'string' || challenge.nonce.length === 0)
        ? 'Missing or invalid nonce in auth.challenge'
      : (typeof challenge.expiresAt !== 'number' || !Number.isFinite(challenge.expiresAt))
        ? 'Missing or invalid expiresAt in auth.challenge'
      : null;
    if (protocolError) {
      this.emitter.emit('error', { code: 'auth_error', message: protocolError });
      const currentWs = this.ws;
      if (this.pendingConnect) {
        clearTimeout(this.pendingConnect.timeoutHandle);
        const { reject } = this.pendingConnect;
        this.pendingConnect = null;
        this.pendingConnectPromise = null;
        this.closeSocket(1000, 'invalid auth.challenge');
        this.setStatus('disconnected');
        reject(new AuthRejectedError(protocolError));
      } else if (currentWs) {
        // Auto-reconnect path — close and schedule the next attempt.
        this.closeSocket(1000, 'invalid auth.challenge');
        this.scheduleReconnectAfterSocketFailure();
      }
      return;
    }
    this.clientId = challenge.clientId;
    const ws = this.ws;
    const clientId = challenge.clientId;
    try {
      const proof = await computeAuthProof(
        this.roomVerifier,
        this.roomId,
        clientId,
        challenge.challengeId,
        challenge.nonce,
      );
      if (this.userDisconnected || !ws || this.ws !== ws || this.clientId !== clientId || this.status !== 'authenticating') {
        return;  // socket/identity rotated or cleared, or user disconnected during async proof; drop the stale response
      }
      const response = {
        type: 'auth.response',
        challengeId: challenge.challengeId,
        clientId,
        proof,
        // When baselineInvalid, our local state is unknown relative to the
        // server. Omit lastSeq so the server falls back to the snapshot path
        // and re-establishes an authoritative baseline — otherwise it may
        // "fast-forward" replay, skip the snapshot, and leave us silently
        // stale forever.
        lastSeq: !this.baselineInvalid && this.seq > 0 ? this.seq : undefined,
      };
      ws.send(JSON.stringify(response));
    } catch (err) {
      // Stale-identity drop: mirror the success-path guard. If the socket or
      // identity rotated during the failed proof computation, the current
      // pending state belongs to a NEW attempt; acting on it would clobber it.
      if (this.userDisconnected || !ws || this.ws !== ws || this.clientId !== clientId) {
        return;
      }
      // Reject pendingConnect immediately with the real error rather than waiting for timeout
      const authErr = new AuthRejectedError(`Auth proof computation failed: ${String(err)}`);
      this.emitter.emit('error', { code: 'auth_error', message: String(err) });
      if (this.pendingConnect) {
        // Initial connect path — reject the caller and transition to disconnected.
        clearTimeout(this.pendingConnect.timeoutHandle);
        const { reject } = this.pendingConnect;
        this.pendingConnect = null;
        this.pendingConnectPromise = null;
        // Synchronous cleanup: closeSocket retires the socket so its async
        // onclose won't re-enter handleSocketClose.
        this.closeSocket(1000, 'auth proof failed');
        this.setStatus('disconnected');
        reject(authErr);
      } else if (ws && this.ws === ws) {
        // Auto-reconnect path — pendingConnect is null, but we're still in
        // `authenticating` from setStatus() above. Without explicit handling,
        // the client would sit in 'authenticating' until the server eventually
        // closes the socket.
        //
        // Retire the socket synchronously (so its deferred onclose no-ops via
        // retiredSockets) and explicitly schedule the next reconnect attempt
        // instead of waiting for the onclose round-trip. This is deterministic
        // and avoids any double-transition emission.
        this.closeSocket(1000, 'auth proof failed');
        this.scheduleReconnectAfterSocketFailure();
      }
    }
  }

  private handleAuthAccepted(accepted: AuthAccepted): void {
    // Defense-in-depth: a rotated/disconnected client should not promote
    // itself to 'authenticated' on a late auth.accepted from a retired socket.
    if (this.userDisconnected) return;
    // Handshake complete — disarm any reconnect-phase watchdog.
    this.clearReconnectHandshakeTimer();
    // Do NOT clear baselineInvalid here. Authentication itself does not
    // establish an authoritative baseline — only a valid snapshot apply
    // does (see handleRoomSnapshot). If the previous session ended with a
    // bad-snapshot baselineInvalid=true and the reconnect's lastSeq was
    // (correctly) omitted, the server will send us a snapshot next; that
    // snapshot's apply is what clears the flag. Clearing here would leave
    // a window where post-accept events apply on stale local state.
    // Clear lastError BEFORE transitioning to 'authenticated'. setStatus()
    // emits the `state` event; if we flipped to 'authenticated' first,
    // subscribers would briefly see connectionStatus='authenticated' with a
    // stale lastError — a confusing intermediate state for UI consumers.
    this.lastError = null;
    this.setStatus('authenticated');
    // this.seq means "last server seq consumed by this client".
    // Valid events advance seq after applying state. Malformed or undecryptable
    // events may advance seq without state mutation to preserve replay forward
    // progress (see handleRoomEvent).
    //
    // Do NOT advance this.seq from accepted.seq. The server sends the snapshot
    // and replayed events *after* auth.accepted. If the socket drops between
    // accepted and those events being consumed, the next reconnect's
    // auth.response could claim lastSeq = server.seq and skip replay, leaving
    // local state stale. seq advances only when an event/snapshot has actually
    // been consumed by this client.

    // Start presence sweep
    this.startPresenceSweep();

    // Reset reconnect state
    this.reconnectAttempt = 0;

    // Resolve pending connect
    if (this.pendingConnect) {
      clearTimeout(this.pendingConnect.timeoutHandle);
      const { resolve } = this.pendingConnect;
      this.pendingConnect = null;
      // Keep the invariant literally true: clear the promise ref synchronously
      // alongside pendingConnect rather than waiting for the microtask cleanup.
      this.pendingConnectPromise = null;
      resolve();
    }

    this.emitState();
  }

  private async handleRoomSnapshot(
    msg: Extract<RoomTransportMessage, { type: 'room.snapshot' }>,
    gen: number,
  ): Promise<void> {
    // Pre-decrypt socket-generation guard: drop snapshots that arrived on a
    // now-retired socket BEFORE spending decrypt time on them. Mirrors the
    // pre-decrypt check in handleRoomEvent/handleRoomPresence.
    if (gen !== this.socketGeneration) return;
    try {
      const snapshot = await decryptSnapshot(this.eventKey, msg.snapshotCiphertext);
      // Post-decrypt re-check: if reconnect rolled the socket while we were
      // decrypting, this snapshot belongs to the retired session and must
      // not mutate current state or the newer socket's baseline.
      if (gen !== this.socketGeneration) return;
      // Encryption only proves the sender held the room key. Validate shape
      // before replacing state — a malformed snapshot would corrupt the view.
      if (!isRoomSnapshot(snapshot)) {
        // Snapshot is the highest-impact inbound message (it establishes or
        // replaces the entire baseline). Surface failures via lastError +
        // state so hook consumers subscribed only to `state` can react.
        // Also mark the baseline invalid so subsequent room.events cannot
        // apply on top of stale local state until a valid snapshot lands.
        this.baselineInvalid = true;
        this.setLastError('snapshot_malformed', 'Snapshot payload failed shape validation', 'snapshot');
        this.emitter.emit('error', { code: 'snapshot_malformed', message: 'Snapshot payload failed shape validation' });
        this.emitState();
        return;
      }
      // Valid snapshot — baseline is authoritative again.
      this.baselineInvalid = false;
      this.planMarkdown = snapshot.planMarkdown;
      this.annotations.clear();
      // Defensive clone on store: the decrypted snapshot payload is untrusted
      // shape-wise AND is a freshly-allocated JSON object that we might also
      // emit to external subscribers; cloning here guarantees later mutations
      // to the emitted snapshot cannot reach back into our internal map.
      for (const ann of snapshot.annotations) {
        this.annotations.set(ann.id, cloneRoomAnnotation(ann));
      }
      // A received snapshot is the authoritative baseline — set seq to
      // msg.snapshotSeq unconditionally. If we only raised seq when
      // snapshotSeq > this.seq, a client whose local seq was somehow ahead
      // (e.g. a corrupted reconnect state or the server's "future claim"
      // fallback) would keep sending that bad lastSeq on subsequent
      // reconnects and never self-repair.
      this.seq = msg.snapshotSeq;
      // Emit a cloned snapshot so direct event subscribers can mutate freely.
      this.emitter.emit('snapshot', {
        ...snapshot,
        annotations: snapshot.annotations.map(cloneRoomAnnotation),
      });
      this.emitState();
    } catch (err) {
      // Socket-generation guard: decrypt failed on a stale socket; do not
      // mark the NEW session's baseline invalid.
      if (gen !== this.socketGeneration) return;
      // Baseline establishment failed — block event application until the
      // next valid snapshot or reconnect clears the flag.
      this.baselineInvalid = true;
      const payload = { code: 'snapshot_decrypt_failed', message: String(err) };
      this.setLastError(payload.code, payload.message, 'snapshot');
      this.emitter.emit('error', payload);
      this.emitState();
    }
  }

  private async handleRoomEvent(
    msg: Extract<RoomTransportMessage, { type: 'room.event' }>,
    gen: number,
  ): Promise<void> {
    const { seq, envelope } = msg;

    // Socket-generation guard: drop events that arrived on a now-retired
    // socket. This must run BEFORE the stale-seq check because a retired
    // socket might deliver seq values that look valid relative to the
    // current socket's (possibly-different) seq.
    if (gen !== this.socketGeneration) return;

    // Stale-event guard: drop anything at-or-below our consumed seq. This
    // can happen on reconnect replay if the server re-sends events we
    // already consumed, or on a dup from a server-side hiccup. We must not
    // decrypt, validate, apply, OR emit — doing any of those would lie
    // about local state having changed.
    if (seq <= this.seq) {
      return;
    }

    // Baseline-invalid guard: a prior snapshot decrypt/shape failure left
    // local state in an unknown relation to the server. Applying events on
    // top of that is silent divergence. Consume the seq for forward progress
    // and keep surfacing the (already-set) snapshot error via state, but do
    // not apply.
    if (this.baselineInvalid) {
      this.seq = seq;
      this.emitState();
      return;
    }

    // V1: no optimistic apply and no echo dedup. Every room.event (including
    // our own echoes) is applied here. The server's event log is the authority;
    // replay after reconnect also funnels through this path.
    try {
      const decrypted = await decryptEventPayload(this.eventKey, envelope.ciphertext);
      // Post-decrypt generation guard — reconnect could have rolled the
      // socket while we were decrypting.
      if (gen !== this.socketGeneration) return;
      // Encryption only proves the sender had the room key. Reject malformed
      // ops (e.g. annotation.add with null id/type fields) before they hit
      // applyAnnotationEvent and corrupt state.
      // Narrow validator: event-channel ops only. presence.update must NOT
      // be accepted here — it would otherwise land in the durable event log.
      if (!isRoomEventClientOp(decrypted)) {
        const err = {
          code: 'event_malformed',
          message: `Malformed event op from clientId=${envelope.clientId} at seq=${seq}`,
        };
        this.setLastError(err.code, err.message, 'event');  // inbound event malformed
        this.emitter.emit('error', err);
        // V1 forward-progress policy: the server has already sequenced and
        // persisted this event, so NOT advancing this.seq would cause the
        // same malformed event to replay on every reconnect (and block all
        // subsequent valid events 43+). Advance seq, apply nothing, emit the
        // error. This makes a single malformed event lossy but keeps the
        // replay stream unblocked, and prevents a malicious participant from
        // poisoning the client's replay state.
        this.seq = seq;
        this.emitState();
        return;
      }
      const op = decrypted;
      const event = this.clientOpToServerEvent(op);
      const result = applyAnnotationEvent(this.annotations, event);
      // Consume the seq regardless — forward-progress (same rationale as the
      // malformed-op branch above).
      this.seq = seq;
      if (!result.applied) {
        // Op was shape-valid but produced an invalid final state (e.g. an
        // annotation.update merge that violates the cross-field invariants).
        // Surface as an error on state; do NOT emit `event` — listeners must
        // not see a notification for an op that didn't actually change state.
        const err = {
          code: 'event_rejected_by_reducer',
          message: `Event at seq=${seq} rejected by reducer: ${result.reason ?? 'unknown'}`,
        };
        this.setLastError(err.code, err.message, 'event');  // inbound event reducer-rejected
        this.emitter.emit('error', err);
        this.emitState();
        return;
      }
      // Emit a cloned event so direct event subscribers can mutate freely
      // without reaching into our internal annotations map.
      this.emitter.emit('event', cloneRoomServerEvent(event));
      this.emitState();
    } catch (err) {
      // Post-decrypt generation guard — don't mutate newer socket's state
      // from a stale decrypt failure.
      if (gen !== this.socketGeneration) return;
      const payload = { code: 'event_decrypt_failed', message: String(err) };
      this.setLastError(payload.code, payload.message, 'event');  // inbound event decrypt failed
      this.emitter.emit('error', payload);
      // Same forward-progress policy as malformed events — the server has
      // already sequenced this event, so we must advance seq or the same
      // undecryptable payload will replay on every reconnect indefinitely.
      // Stale-seq guard at the top of this method already ruled out seq <= this.seq,
      // so unconditional assignment here is safe.
      this.seq = seq;
      this.emitState();
    }
  }

  private async handleRoomPresence(
    msg: Extract<RoomTransportMessage, { type: 'room.presence' }>,
    gen: number,
  ): Promise<void> {
    // Pre-decrypt generation guard: skip presence from retired sockets.
    if (gen !== this.socketGeneration) return;
    try {
      const presence = await decryptPresence(this.presenceKey, msg.envelope.ciphertext);
      // Post-decrypt generation guard — reconnect could have rolled during decrypt.
      if (gen !== this.socketGeneration) return;
      // Encryption only proves the sender has the room key. Validate the shape
      // before letting it into client state to prevent malformed-presence attacks
      // from crashing UI render code.
      if (!isPresenceState(presence)) {
        const err = {
          code: 'presence_malformed',
          message: `Malformed presence from clientId=${msg.envelope.clientId}`,
        };
        this.setLastError(err.code, err.message, 'presence');
        this.emitter.emit('error', err);
        this.emitState();
        return;
      }
      // Store a clone so subsequent mutations to the decrypted/emitted object
      // can't reach back into our internal remotePresence map.
      this.remotePresence.set(msg.envelope.clientId, {
        presence: clonePresenceState(presence),
        lastSeen: Date.now(),
      });
      this.emitter.emit('presence', {
        clientId: msg.envelope.clientId,
        presence: clonePresenceState(presence),
      });
      this.emitState();
    } catch (err) {
      // Post-decrypt generation guard.
      if (gen !== this.socketGeneration) return;
      const payload = { code: 'presence_decrypt_failed', message: String(err) };
      this.setLastError(payload.code, payload.message, 'presence');
      this.emitter.emit('error', payload);
      this.emitState();
    }
  }

  private handleRoomError(
    msg: Extract<RoomTransportMessage, { type: 'room.error' }>,
    gen: number,
  ): void {
    // Drop errors from retired sockets — they reference operations on a
    // session the client has already moved past.
    if (gen !== this.socketGeneration) return;
    // Classify scope from the server code. `admin` errors are consumed
    // by pendingAdmin handling; everything else from the server is a
    // rejection of a mutation WE sent (the server only returns room.error
    // to the originator of the rejected op). The annotation controller
    // uses `'mutation'` to transition pending → failed.
    const scope: 'mutation' | 'admin' = ADMIN_SCOPED_ERROR_CODES.has(msg.code) ? 'admin' : 'mutation';
    this.setLastError(msg.code, msg.message, scope);
    this.emitter.emit('error', { code: msg.code, message: msg.message });

    // Reject pending admin ONLY for admin-scoped error codes. Event-channel
    // errors like `validation_error` can land while an admin command is in
    // flight (e.g. a concurrent annotation op hit a validation failure just
    // after the admin command was accepted); rejecting pendingAdmin on those
    // would fail a successful admin command whose terminal status broadcast
    // is still in-flight. Admin-scoped codes are the ones the server emits
    // exclusively from the admin command path.
    if (this.pendingAdmin && scope === 'admin') {
      const pending = this.pendingAdmin;
      clearTimeout(pending.timeoutHandle);
      this.pendingAdmin = null;
      pending.reject(new AdminRejectedError(msg.code, msg.message));
    }

    this.emitState();
  }

  // ---------------------------------------------------------------------------
  // Internal: sending ops
  // ---------------------------------------------------------------------------

  private sendOp(op: RoomEventClientOp): Promise<void> {
    // Synchronous precondition check — fail fast before enqueuing.
    // `assertConnected` throws if status isn't 'authenticated'; a terminal
    // close (room-unavailable) flips status to 'closed' in handleSocketClose,
    // so this catches rooms that have been purged as well.
    this.assertConnected();
    // Chain onto the outbound queue so concurrent calls send in CALL order,
    // not encryption-completion order. Without this, a user adding then
    // removing an annotation in quick succession could see the remove land
    // first (empty payloads encrypt faster), leaving the annotation that
    // the remove was meant to delete.
    const next = this.outboundEventQueue.then(async () => {
      // Re-check liveness inside the queue — a disconnect or terminal close
      // could have landed while we were waiting our turn.
      this.assertConnected();

      const opId = generateOpId();
      const ciphertext = await encryptEventOp(this.eventKey, op);

      // Recheck socket after async encryption. A terminal close during the
      // encrypt would otherwise let us send an op the server will never
      // receive — the user would see the mutation resolve as "sent" and
      // only learn from async lastError.
      const ws = this.ws;
      if (this.status !== 'authenticated' || !ws) {
        throw new NotConnectedError();
      }

      const envelope: ServerEnvelope = {
        clientId: this.clientId,
        opId,
        channel: 'event',
        ciphertext,
      };

      // V1 policy: server echo is authoritative. We do NOT apply annotation
      // ops optimistically. See class header for full rationale.
      ws.send(JSON.stringify(envelope));
    });
    // Keep the chain alive even if this op rejects — later ops must still
    // serialize. The caller's returned promise surfaces the rejection.
    this.outboundEventQueue = next.catch(() => { /* swallow; caller sees it */ });
    return next;
  }

  // Event-channel ops only. Presence is a separate channel with its own
  // encryption and dispatch; it never flows through this converter.
  private clientOpToServerEvent(op: RoomEventClientOp): RoomServerEvent {
    switch (op.type) {
      case 'annotation.add':
        return { type: 'annotation.add', annotations: op.annotations };
      case 'annotation.update':
        return { type: 'annotation.update', id: op.id, patch: op.patch };
      case 'annotation.remove':
        return { type: 'annotation.remove', ids: op.ids };
      case 'annotation.clear':
        return { type: 'annotation.clear', source: op.source };
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: admin flow
  // ---------------------------------------------------------------------------

  private async runAdminCommand(command: AdminCommand): Promise<void> {
    this.assertConnected();
    if (this.pendingAdmin) {
      throw new Error('Another admin command is pending');
    }

    return new Promise<void>((resolve, reject) => {
      const ws = this.ws;
      if (!ws) {
        reject(new NotConnectedError());
        return;
      }

      const timeoutHandle = setTimeout(() => {
        if (this.pendingAdmin) {
          this.pendingAdmin = null;
          reject(new AdminTimeoutError());
        }
      }, ADMIN_COMMAND_TIMEOUT_MS);

      this.pendingAdmin = { command, resolve, reject, timeoutHandle };

      // Request admin challenge. If send() throws synchronously, don't leave
      // pendingAdmin stuck until timeout — clear it and propagate the error.
      try {
        ws.send(JSON.stringify({ type: 'admin.challenge.request' }));
      } catch (err) {
        clearTimeout(timeoutHandle);
        this.pendingAdmin = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async handleAdminChallenge(challenge: AdminChallenge): Promise<void> {
    const pending = this.pendingAdmin;
    if (!pending || !this.adminVerifier) return;

    // Capture socket and identity now. Mirror of handleAuthChallenge: if a
    // rotation happens mid-await, the stale admin proof (bound to the old
    // clientId) must not be sent on the replacement socket.
    const ws = this.ws;
    const clientId = this.clientId;

    try {
      const proof = await computeAdminProof(
        this.adminVerifier,
        this.roomId,
        clientId,
        challenge.challengeId,
        challenge.nonce,
        pending.command,
      );
      if (!ws || this.ws !== ws || this.clientId !== clientId || this.pendingAdmin !== pending) {
        return;  // socket/identity/pending rotated during async proof; drop stale response
      }
      ws.send(JSON.stringify({
        type: 'admin.command',
        challengeId: challenge.challengeId,
        clientId,
        command: pending.command,
        adminProof: proof,
      }));
      // Promise stays pending — resolves via room.status or socket close
    } catch (err) {
      // Stale-identity drop: mirror the success-path guard. If the socket,
      // identity, or pending-admin slot rotated during the failed proof, the
      // current pendingAdmin belongs to a NEW admin command; do not clear it
      // and do not reject — the original caller's `pending` promise still
      // gets rejected below so nothing is leaked, but current client state
      // stays untouched.
      if (this.userDisconnected || !ws || this.ws !== ws || this.clientId !== clientId || this.pendingAdmin !== pending) {
        // Still clear the ORIGINAL pending's timeout so it doesn't leak, even
        // though we're not touching the current pendingAdmin slot (which
        // belongs to a NEW command after the rotation).
        clearTimeout(pending.timeoutHandle);
        pending.reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      clearTimeout(pending.timeoutHandle);
      this.pendingAdmin = null;
      pending.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: helpers
  // ---------------------------------------------------------------------------

  private buildWebSocketUrl(): string {
    const base = new URL(this.baseUrl);
    const wsScheme = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsScheme}//${base.host}/ws/${this.roomId}`;
  }

  private assertConnected(): void {
    if (this.status !== 'authenticated' || !this.ws) {
      throw new NotConnectedError();
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emitter.emit('status', status);
    // Also emit state so consumers subscribed only to `state` (e.g. useCollabRoom)
    // see connecting/authenticating/reconnecting transitions.
    this.emitter.emit('state', this.buildState());
  }

  private buildState(): CollabRoomState {
    // Clone every value exposed through getState()/state events. V1's
    // server-authoritative model means local state mutations must come ONLY
    // from decrypted server events; if a consumer (UI code) accidentally
    // mutated a returned annotation or cursor, they'd corrupt local state
    // with no server echo. Returning fresh clones makes getState() an
    // isolated snapshot — it is not frozen, but mutation by the caller
    // does not reach back into the client's internal state.
    const presence: Record<string, PresenceState> = {};
    for (const [clientId, entry] of this.remotePresence) {
      presence[clientId] = clonePresenceState(entry.presence);
    }
    return {
      connectionStatus: this.status,
      roomUnavailable: this.roomUnavailable,
      roomId: this.roomId,
      clientId: this.clientId,
      seq: this.seq,
      planMarkdown: this.planMarkdown,
      annotations: annotationsToArray(this.annotations).map(cloneRoomAnnotation),
      remotePresence: presence,
      hasAdminCapability: this.adminKey !== null,
      lastError: this.lastError ? { ...this.lastError } : null,
      lastErrorId: this.lastErrorId,
    };
  }

  private emitState(): void {
    this.emitter.emit('state', this.buildState());
  }

  private startPresenceSweep(): void {
    if (this.presenceSweepTimer) return;
    this.presenceSweepTimer = setInterval(() => {
      const now = Date.now();
      let pruned = false;
      for (const [clientId, entry] of this.remotePresence) {
        if (now - entry.lastSeen > this.presenceTtlMs) {
          this.remotePresence.delete(clientId);
          pruned = true;
        }
      }
      if (pruned) this.emitState();
    }, this.presenceSweepIntervalMs);
  }

  private stopPresenceSweep(): void {
    if (this.presenceSweepTimer) {
      clearInterval(this.presenceSweepTimer);
      this.presenceSweepTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearReconnectHandshakeTimer(): void {
    if (this.reconnectHandshakeTimer) {
      clearTimeout(this.reconnectHandshakeTimer);
      this.reconnectHandshakeTimer = null;
    }
  }

  /**
   * Chain an async task on the serialized message queue.
   *
   * Two-arg .then(task, task) is intentional: if the previous queue entry
   * rejected, we still want the NEXT task to run (forward progress — we're
   * serializing for ordering, not coupling failures). The trailing .catch
   * then swallows any rejection from the task itself so one failed handler
   * doesn't permanently poison the chain with an unhandled rejection.
   * Individual task errors are already surfaced via `error` events inside
   * the handlers themselves.
   */
  private enqueue(task: () => Promise<void>): void {
    this.messageQueue = this.messageQueue.then(task, task).catch(() => { /* swallow */ });
  }
}
