/**
 * Plannotator Room Durable Object.
 *
 * Uses Cloudflare Workers WebSocket Hibernation API.
 * All per-connection state lives in WebSocket attachments
 * (survives DO hibernation).
 *
 * Implements: room creation, WebSocket auth, event sequencing,
 * presence relay, reconnect replay, admin commands, lifecycle enforcement.
 *
 * Zero-knowledge: stores/relays ciphertext only. Never needs roomSecret,
 * eventKey, presenceKey, or plaintext content.
 */

import type {
  AuthChallenge,
  AuthResponse,
  AuthAccepted,
  AdminChallenge,
  CreateRoomRequest,
  CreateRoomResponse,
  ServerEnvelope,
  SequencedEnvelope,
  RoomTransportMessage,
} from '@plannotator/shared/collab';
import { verifyAuthProof, verifyAdminProof, generateChallengeId, generateClientId, generateNonce } from '@plannotator/shared/collab';
// Shared terminal close-signal constants — client treats this pair as
// "the link no longer resolves" (admin delete, auto-expiry, or a room
// that never existed — from the client's perspective, indistinguishable).
import { AdminErrorCode, WS_CLOSE_REASON_ROOM_UNAVAILABLE, WS_CLOSE_ROOM_UNAVAILABLE } from '@plannotator/shared/collab/constants';
import { DurableObject } from 'cloudflare:workers';
import type { Env, RoomDurableState, WebSocketAttachment } from './types';
import { clampExpiryDays, hasRoomExpired, validateServerEnvelope, validateAdminCommandEnvelope, isValidationError } from './validation';
import { safeLog } from './log';

const CHALLENGE_TTL_MS = 30_000;
const ADMIN_CHALLENGE_TTL_MS = 30_000;
const DELETE_BATCH_SIZE = 128; // Cloudflare DO storage.delete() max keys per call
/**
 * Page size for reconnect replay. Bounds peak DO memory during replay —
 * storage.list() without a limit reads all matching rows at once, which
 * fails for large/noisy rooms. Each page is streamed out to the WebSocket,
 * then released. 128 is a conservative starting point well within DO memory
 * budgets even if each event ciphertext is a few KB.
 */
const REPLAY_PAGE_SIZE = 128;

/**
 * Abuse/failure containment: per-room WebSocket cap. Not about expected
 * normal room sizes — V1 rooms are small — but bounds broadcast fanout
 * and runaway reconnect loops if a misbehaving client (or attacker with
 * the room URL) opens sockets without releasing them. Returns 429 Too
 * Many Requests when exceeded; honest clients see this only if the room
 * is already saturated.
 */
const MAX_CONNECTIONS_PER_ROOM = 100;

/** Pre-auth length caps on the auth.response message. Real values are
 *  much smaller (challengeId ~22 chars, clientId server-assigned, proof
 *  ~43 chars for HMAC-SHA-256 base64url). Generous caps bound the
 *  unauthenticated work the server is willing to do per connection. */
const AUTH_CHALLENGE_ID_MAX_LENGTH = 64;
const AUTH_CLIENT_ID_MAX_LENGTH = 64;
const AUTH_PROOF_MAX_LENGTH = 128;

// WebSocket close codes (room-service-internal; shared close codes come from constants.ts)
const WS_CLOSE_AUTH_REQUIRED = 4001;
const WS_CLOSE_UNKNOWN_CHALLENGE = 4002;
const WS_CLOSE_CHALLENGE_EXPIRED = 4003;
const WS_CLOSE_INVALID_PROOF = 4004;
const WS_CLOSE_PROTOCOL_ERROR = 4005;

/** Zero-pad a seq number to 10 digits for lexicographic storage ordering. */
function padSeq(seq: number): string {
  return String(seq).padStart(10, '0');
}

export class RoomDurableObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      return this.handleCreate(request);
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  // ---------------------------------------------------------------------------
  // Room Creation
  // ---------------------------------------------------------------------------

  private async handleCreate(request: Request): Promise<Response> {
    let body: CreateRoomRequest;
    try {
      body = await request.json() as CreateRoomRequest;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const existing = await this.ctx.storage.get<RoomDurableState>('room');
    if (existing) {
      // Lazy-expiry backstop: if somehow the alarm didn't fire (e.g. the
      // room outlived its deadline without anyone connecting AND without
      // the alarm landing), purge here and allow the new create to
      // supplant the stale roomId. The alarm is the primary cleanup
      // path — this is defense in depth.
      if (hasRoomExpired(existing.expiresAt)) {
        await this.purgeRoom('create-preempted-expired');
        // fall through to create a fresh room at this id
      } else {
        return Response.json({ error: 'Room already exists' }, { status: 409 });
      }
    }

    const expiryDays = clampExpiryDays(body.expiresInDays);
    const expiresAt = Date.now() + expiryDays * 24 * 60 * 60 * 1000;

    const state: RoomDurableState = {
      roomId: body.roomId,
      roomVerifier: body.roomVerifier,
      adminVerifier: body.adminVerifier,
      seq: 0,
      earliestRetainedSeq: 1,
      snapshotCiphertext: body.initialSnapshotCiphertext,
      snapshotSeq: 0,
      expiresAt,
    };

    try {
      await this.ctx.storage.put('room', state);
    } catch (e) {
      safeLog('room:create-storage-error', { roomId: body.roomId, error: String(e) });
      return Response.json({ error: 'Failed to store room state' }, { status: 507 });
    }

    // Schedule the 30-day (or whatever expiryDays clamps to) auto-purge.
    // `setAlarm` overwrites any pending alarm, which is what we want if
    // this create supplanted an expired-but-alarm-less room above.
    try {
      await this.ctx.storage.setAlarm(expiresAt);
    } catch (e) {
      // Non-fatal: lazy-expiry in checkRoomLifecycle + the defense-in-depth
      // check above still catch overdue rooms. Log and carry on.
      safeLog('room:set-alarm-error', { roomId: body.roomId, error: String(e) });
    }

    const base = new URL(this.env.BASE_URL || 'https://room.plannotator.ai');
    const wsScheme = base.protocol === 'https:' ? 'wss:' : 'ws:';

    const response: CreateRoomResponse = {
      roomId: body.roomId,
      seq: 0,
      snapshotSeq: 0,
      joinUrl: `${base.origin}/c/${body.roomId}`,
      websocketUrl: `${wsScheme}//${base.host}/ws/${body.roomId}`,
    };

    safeLog('room:created', { roomId: body.roomId, expiryDays });
    return Response.json(response, { status: 201 });
  }

  // ---------------------------------------------------------------------------
  // Durable Object alarm — fires at `expiresAt`, purges the room.
  // ---------------------------------------------------------------------------

  async alarm(): Promise<void> {
    // The alarm wakes the DO. We don't check expiresAt here — the alarm
    // was scheduled specifically for now, so if there's any room in
    // storage we purge it. purgeRoom is idempotent on absence.
    await this.purgeRoom('expiry');
  }

  // ---------------------------------------------------------------------------
  // WebSocket Upgrade
  // ---------------------------------------------------------------------------

  private async handleWebSocketUpgrade(_request: Request): Promise<Response> {
    const roomState = await this.ctx.storage.get<RoomDurableState>('room');
    if (!roomState) {
      return this.rejectUpgradeAsUnavailable();
    }
    if (hasRoomExpired(roomState.expiresAt)) {
      // Alarm should have fired; this is defense in depth.
      await this.purgeRoom('upgrade-preempted-expired');
      return this.rejectUpgradeAsUnavailable();
    }

    // Per-room connection cap — see MAX_CONNECTIONS_PER_ROOM for rationale.
    // Kept as HTTP 429 (not a WS close) because "full" is a transient,
    // retryable condition worth signaling to any consumer — distinct from
    // the permanent "room unavailable" UX state below.
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS_PER_ROOM) {
      safeLog('ws:room-full', { roomId: roomState.roomId, cap: MAX_CONNECTIONS_PER_ROOM });
      return Response.json({ error: 'Room is full' }, { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const challengeId = generateChallengeId();
    const nonce = generateNonce();
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;
    // Server-assigned clientId — see WebSocketAttachment docstring. The auth
    // proof is bound to this value, so a participant cannot choose an active
    // peer's clientId at auth time.
    const clientId = generateClientId();

    this.ctx.acceptWebSocket(server);

    const attachment: WebSocketAttachment = {
      authenticated: false,
      roomId: roomState.roomId,
      challengeId,
      nonce,
      expiresAt,
      clientId,
    };
    server.serializeAttachment(attachment);

    const challenge: AuthChallenge = {
      type: 'auth.challenge',
      challengeId,
      nonce,
      expiresAt,
      clientId,
    };
    server.send(JSON.stringify(challenge));

    safeLog('ws:challenge-sent', { roomId: roomState.roomId, challengeId });
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Complete the WebSocket upgrade and immediately close the client side
   * with WS_CLOSE_ROOM_UNAVAILABLE. Used when the room is gone (never
   * created, admin-deleted, or auto-expired).
   *
   * Why not return HTTP 404? Browsers don't expose the HTTP status of a
   * failed WebSocket upgrade to page JS — a failed upgrade fires `close`
   * with code 1006 and no reason, indistinguishable from a network drop.
   * Accepting and immediately closing with our dedicated close code is
   * the only way the client can route cold visitors to the dedicated
   * RoomUnavailableScreen on the same code path as mid-session closes.
   */
  private rejectUpgradeAsUnavailable(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.close(WS_CLOSE_ROOM_UNAVAILABLE, WS_CLOSE_REASON_ROOM_UNAVAILABLE);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------------------
  // WebSocket Message Handler (Hibernation API)
  // ---------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = ws.deserializeAttachment() as WebSocketAttachment | null;
    if (!meta) {
      ws.close(WS_CLOSE_AUTH_REQUIRED, 'No connection state');
      return;
    }

    let msg: Record<string, unknown>;
    try {
      const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
      msg = JSON.parse(raw);
    } catch {
      ws.close(WS_CLOSE_PROTOCOL_ERROR, 'Invalid message format');
      return;
    }

    // Pre-auth: only accept auth.response
    if (!meta.authenticated) {
      if (msg.type !== 'auth.response') {
        ws.close(WS_CLOSE_AUTH_REQUIRED, 'Authentication required');
        return;
      }
      if (
        typeof msg.challengeId !== 'string' || !msg.challengeId ||
        typeof msg.clientId !== 'string' || !msg.clientId ||
        typeof msg.proof !== 'string' || !msg.proof
      ) {
        ws.close(WS_CLOSE_PROTOCOL_ERROR, 'Malformed auth response');
        return;
      }
      // Pre-auth length caps. Proofs + IDs are small in practice
      // (challengeId ~22 chars, clientId server-assigned, proof 43 chars).
      // Without caps, an unauthenticated peer can allocate/verify oversized
      // strings. Match the admin-envelope caps for consistency.
      if (msg.challengeId.length > AUTH_CHALLENGE_ID_MAX_LENGTH) {
        ws.close(WS_CLOSE_PROTOCOL_ERROR, 'challengeId too long');
        return;
      }
      if (msg.clientId.length > AUTH_CLIENT_ID_MAX_LENGTH) {
        ws.close(WS_CLOSE_PROTOCOL_ERROR, 'clientId too long');
        return;
      }
      if (msg.proof.length > AUTH_PROOF_MAX_LENGTH) {
        ws.close(WS_CLOSE_PROTOCOL_ERROR, 'proof too long');
        return;
      }
      // Validate lastSeq as non-negative integer if provided
      let lastSeq: number | undefined;
      if (msg.lastSeq !== undefined) {
        if (typeof msg.lastSeq !== 'number' || !Number.isInteger(msg.lastSeq) || msg.lastSeq < 0) {
          ws.close(WS_CLOSE_PROTOCOL_ERROR, 'lastSeq must be a non-negative integer');
          return;
        }
        lastSeq = msg.lastSeq;
      }
      const authResponse: AuthResponse = {
        type: 'auth.response',
        challengeId: msg.challengeId as string,
        clientId: msg.clientId as string,
        proof: msg.proof as string,
        lastSeq,
      };
      await this.handleAuthResponse(ws, meta, authResponse);
      return;
    }

    // Post-auth: dispatch by message type
    await this.handlePostAuthMessage(ws, meta, msg);
  }

  // ---------------------------------------------------------------------------
  // Post-Auth Message Dispatch
  // ---------------------------------------------------------------------------

  private async handlePostAuthMessage(
    ws: WebSocket,
    meta: Extract<WebSocketAttachment, { authenticated: true }>,
    msg: Record<string, unknown>,
  ): Promise<void> {
    // Admin challenge request
    if (msg.type === 'admin.challenge.request') {
      await this.handleAdminChallengeRequest(ws, meta);
      return;
    }

    // Admin command
    if (msg.type === 'admin.command') {
      await this.handleAdminCommand(ws, meta, msg);
      return;
    }

    // ServerEnvelope — detect via channel field (no type field)
    if (typeof msg.channel === 'string' && (msg.channel === 'event' || msg.channel === 'presence')) {
      await this.handleServerEnvelope(ws, meta, msg);
      return;
    }

    ws.close(WS_CLOSE_PROTOCOL_ERROR, 'Unknown message type');
  }

  // ---------------------------------------------------------------------------
  // Lifecycle Check (shared by event, presence, admin paths)
  // ---------------------------------------------------------------------------

  /**
   * Check room lifecycle state. Returns roomState if usable, or null if terminal.
   * Closes the socket for rooms that are gone (purged) or past their deadline.
   */
  private async checkRoomLifecycle(
    ws: WebSocket,
    _roomId: string,
  ): Promise<RoomDurableState | null> {
    const roomState = await this.ctx.storage.get<RoomDurableState>('room');
    if (!roomState) {
      ws.close(WS_CLOSE_ROOM_UNAVAILABLE, WS_CLOSE_REASON_ROOM_UNAVAILABLE);
      return null;
    }
    // Lazy-expiry backstop. Alarm handles the common case; this fires only
    // if a socket somehow reached us after the deadline without the alarm
    // having landed yet.
    if (hasRoomExpired(roomState.expiresAt)) {
      await this.purgeRoom('lifecycle-preempted-expired', ws);
      ws.close(WS_CLOSE_ROOM_UNAVAILABLE, WS_CLOSE_REASON_ROOM_UNAVAILABLE);
      return null;
    }
    return roomState;
  }

  // ---------------------------------------------------------------------------
  // Event Sequencing & Presence Relay
  // ---------------------------------------------------------------------------

  private async handleServerEnvelope(
    ws: WebSocket,
    meta: Extract<WebSocketAttachment, { authenticated: true }>,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const validated = validateServerEnvelope(msg);
    if (isValidationError(validated)) {
      this.sendError(ws, 'validation_error', validated.error);
      return;
    }
    // isValidationError narrows; `validated` is ServerEnvelope here.
    const envelope: ServerEnvelope = {
      ...validated,
      clientId: meta.clientId, // Override — prevent spoofing
    };

    const roomState = await this.checkRoomLifecycle(ws, meta.roomId);
    if (!roomState) return;

    if (envelope.channel === 'event') {
      // Sequence the event on an IMMUTABLE next-state object. If the
      // durable write fails, we must NOT have already bumped roomState.seq
      // in memory — the next event must reuse the current seq, not a gap'd
      // one. Nor may we broadcast an event that was never persisted.
      const nextSeq = roomState.seq + 1;
      const sequenced: SequencedEnvelope = {
        seq: nextSeq,
        receivedAt: Date.now(),
        envelope,
      };
      const nextRoomState: RoomDurableState = { ...roomState, seq: nextSeq };

      // Atomic write: event key + room metadata in one put.
      try {
        await this.ctx.storage.put({
          [`event:${padSeq(nextSeq)}`]: sequenced,
          'room': nextRoomState,
        } as Record<string, unknown>);
      } catch (e) {
        // Persistence failed. Surface a clean error to the sender so their
        // sendAnnotation* promise rejects (or their UI sees lastError) —
        // otherwise they'd think the op landed on the wire. Do NOT bump
        // in-memory seq, do NOT broadcast.
        safeLog('room:event-persist-error', {
          roomId: roomState.roomId,
          attemptedSeq: nextSeq,
          clientId: meta.clientId,
          error: String(e),
        });
        this.sendError(ws, 'event_persist_failed', 'Failed to persist event');
        return;
      }

      // Durable write succeeded — commit in-memory state and broadcast.
      Object.assign(roomState, nextRoomState);
      const transport: RoomTransportMessage = {
        type: 'room.event',
        seq: sequenced.seq,
        receivedAt: sequenced.receivedAt,
        envelope: sequenced.envelope,
      };
      this.broadcast(transport);

      safeLog('room:event-sequenced', { roomId: roomState.roomId, seq: roomState.seq, clientId: meta.clientId });
    } else {
      // Presence — allowed in any non-terminal room state
      const transport: RoomTransportMessage = {
        type: 'room.presence',
        envelope,
      };
      this.broadcast(transport, ws);
    }
  }

  // ---------------------------------------------------------------------------
  // Auth Response + Reconnect Replay
  // ---------------------------------------------------------------------------

  private async handleAuthResponse(
    ws: WebSocket,
    meta: Extract<WebSocketAttachment, { authenticated: false }>,
    authResponse: AuthResponse,
  ): Promise<void> {
    if (authResponse.challengeId !== meta.challengeId) {
      safeLog('ws:auth-rejected', { reason: 'unknown-challenge', roomId: meta.roomId });
      ws.close(WS_CLOSE_UNKNOWN_CHALLENGE, 'Unknown challenge');
      return;
    }

    // The clientId in auth.response MUST match the server-assigned clientId
    // from this connection's challenge. This prevents a participant from
    // choosing another peer's clientId at auth time and overwriting their
    // presence slot.
    if (authResponse.clientId !== meta.clientId) {
      safeLog('ws:auth-rejected', { reason: 'clientId-mismatch', roomId: meta.roomId });
      ws.close(WS_CLOSE_INVALID_PROOF, 'clientId does not match challenge');
      return;
    }

    if (Date.now() > meta.expiresAt) {
      safeLog('ws:auth-rejected', { reason: 'expired', roomId: meta.roomId });
      ws.close(WS_CLOSE_CHALLENGE_EXPIRED, 'Challenge expired');
      return;
    }

    // Delegate lifecycle checks (deleted / expired / lazy-expiry) to the
    // shared helper so this path doesn't drift from the post-auth path.
    const roomState = await this.checkRoomLifecycle(ws, meta.roomId);
    if (!roomState) return;

    const valid = await verifyAuthProof(
      roomState.roomVerifier,
      meta.roomId,
      authResponse.clientId,
      meta.challengeId,
      meta.nonce,
      authResponse.proof,
    );

    if (!valid) {
      safeLog('ws:auth-rejected', { reason: 'invalid-proof', roomId: meta.roomId });
      ws.close(WS_CLOSE_INVALID_PROOF, 'Invalid proof');
      return;
    }

    // Auth successful — update attachment
    const authenticatedMeta: WebSocketAttachment = {
      authenticated: true,
      roomId: meta.roomId,
      clientId: authResponse.clientId,
      authenticatedAt: Date.now(),
    };
    ws.serializeAttachment(authenticatedMeta);

    // Send auth.accepted
    const accepted: AuthAccepted = {
      type: 'auth.accepted',
      seq: roomState.seq,
      snapshotSeq: roomState.snapshotSeq,
      snapshotAvailable: !!roomState.snapshotCiphertext,
    };
    ws.send(JSON.stringify(accepted));

    // Reconnect replay
    await this.replayEvents(ws, roomState, authResponse.lastSeq);

    safeLog('ws:authenticated', { roomId: meta.roomId, clientId: authResponse.clientId, lastSeq: authResponse.lastSeq });
  }

  private async replayEvents(
    ws: WebSocket,
    roomState: RoomDurableState,
    lastSeq: number | undefined,
  ): Promise<void> {
    // Local helper: single place that constructs and sends a room.snapshot
    // transport message. Keeps the message shape in one place so any future
    // field addition lands once.
    const sendSnapshotToSocket = (): void => {
      if (!roomState.snapshotCiphertext) return;
      const snapshotMsg: RoomTransportMessage = {
        type: 'room.snapshot',
        snapshotSeq: roomState.snapshotSeq ?? 0,
        snapshotCiphertext: roomState.snapshotCiphertext,
      };
      ws.send(JSON.stringify(snapshotMsg));
    };

    // Determine replay strategy
    let sendSnapshot = false;
    let replayFrom: number;

    if (lastSeq === undefined) {
      // Fresh join — send snapshot + all events
      sendSnapshot = true;
      replayFrom = (roomState.snapshotSeq ?? 0) + 1;
    } else if (lastSeq > roomState.seq) {
      // Future claim — anomaly, fall back to snapshot
      sendSnapshot = true;
      replayFrom = (roomState.snapshotSeq ?? 0) + 1;
      safeLog('ws:replay-anomaly', { roomId: roomState.roomId, lastSeq, currentSeq: roomState.seq });
    } else if (lastSeq === roomState.seq) {
      // Fully caught up — still send snapshot if seq is 0 (fresh room, no events yet)
      if (roomState.seq === 0) {
        sendSnapshotToSocket();
      }
      return;
    } else {
      // Check if we can replay incrementally
      const nextNeededSeq = lastSeq + 1;
      // In V1 earliestRetainedSeq stays 1 because there is no compaction.
      // This branch becomes active once future compaction advances it.
      if (nextNeededSeq < roomState.earliestRetainedSeq) {
        // Too old — need snapshot fallback
        sendSnapshot = true;
        replayFrom = (roomState.snapshotSeq ?? 0) + 1;
      } else {
        // Can replay from retained log
        replayFrom = nextNeededSeq;
      }
    }

    if (sendSnapshot) {
      sendSnapshotToSocket();
    }

    // Replay events from storage (if any exist). Paginated so large rooms
    // don't load the full event log into DO memory at reconnect time —
    // storage.list() without a limit can blow memory in rooms with many
    // retained events (V1 retains all events for the room lifetime).
    if (roomState.seq > 0 && replayFrom <= roomState.seq) {
      let cursor = `event:${padSeq(replayFrom)}`;
      const end = `event:${padSeq(roomState.seq)}\uffff`;  // inclusive of roomState.seq
      while (true) {
        const page = await this.ctx.storage.list<SequencedEnvelope>({
          prefix: 'event:',
          start: cursor,
          end,
          limit: REPLAY_PAGE_SIZE,
        });
        if (page.size === 0) break;
        let lastKey = cursor;
        for (const [key, sequenced] of page) {
          const transport: RoomTransportMessage = {
            type: 'room.event',
            seq: sequenced.seq,
            receivedAt: sequenced.receivedAt,
            envelope: sequenced.envelope,
          };
          ws.send(JSON.stringify(transport));
          lastKey = key;
        }
        if (page.size < REPLAY_PAGE_SIZE) break;
        // Advance cursor past the last emitted key. `storage.list({ start })`
        // is INCLUSIVE, so passing `lastKey` would re-emit the final event.
        // Appending U+0000 (the smallest Unicode code point) produces a string
        // strictly greater than `lastKey` but strictly less than any valid
        // next key — because padded numeric seq keys are ASCII digits only
        // and never contain a null byte, no real key can fall between them.
        // Using `\uffff` (max code point) here would be WRONG: it would skip
        // all keys lexicographically between `lastKey` and `lastKey\uffff`,
        // dropping legitimate events from the replay.
        cursor = `${lastKey}\u0000`;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Admin Challenge-Response
  // ---------------------------------------------------------------------------

  private async handleAdminChallengeRequest(
    ws: WebSocket,
    meta: Extract<WebSocketAttachment, { authenticated: true }>,
  ): Promise<void> {
    // Lifecycle check — reject for terminal rooms
    const roomState = await this.checkRoomLifecycle(ws, meta.roomId);
    if (!roomState) return;

    const challengeId = generateChallengeId();
    const nonce = generateNonce();
    const expiresAt = Date.now() + ADMIN_CHALLENGE_TTL_MS;

    // Store in attachment (survives hibernation)
    const updatedMeta: WebSocketAttachment = {
      ...meta,
      pendingAdminChallenge: { challengeId, nonce, expiresAt },
    };
    ws.serializeAttachment(updatedMeta);

    const challenge: AdminChallenge = {
      type: 'admin.challenge',
      challengeId,
      nonce,
      expiresAt,
    };
    ws.send(JSON.stringify(challenge));

    safeLog('admin:challenge-sent', { roomId: meta.roomId, clientId: meta.clientId, challengeId });
  }

  private async handleAdminCommand(
    ws: WebSocket,
    meta: Extract<WebSocketAttachment, { authenticated: true }>,
    msg: Record<string, unknown>,
  ): Promise<void> {
    // ADMIN ERROR-CODE CONTRACT
    // -------------------------
    // Every error code emitted from this method AND from helpers it calls
    // (applyDelete, admin-scoped branches of handleAdminChallengeRequest)
    // must be listed in the client's ADMIN_SCOPED_ERROR_CODES Set in
    // packages/shared/collab/client-runtime/client.ts. That Set gates which
    // room.error payloads reject a pending admin promise; a code that
    // fires here but is missing from the Set leaves the client hanging
    // until AdminTimeoutError. A code that fires on the event channel but
    // is ADDED to the Set (e.g. validation_error) wrongly cancels
    // unrelated in-flight admin commands. When adding/renaming/removing
    // admin-path codes, update the client Set in the same change.
    const validated = validateAdminCommandEnvelope(msg);
    if (isValidationError(validated)) {
      // Admin-scoped code so the client can distinguish admin-flow failures
      // from event-channel failures (e.g. validation_error fires on the
      // event channel while an admin command is in flight — rejecting
      // pendingAdmin on those would be wrong).
      this.sendAdminError(ws, AdminErrorCode.ValidationError, validated.error);
      return;
    }
    // isValidationError narrows; `validated` is AdminCommandEnvelope here.
    const cmdEnvelope = validated;

    // Reject cross-connection clientId spoofing
    if (cmdEnvelope.clientId !== meta.clientId) {
      this.sendAdminError(ws, AdminErrorCode.ClientIdMismatch, 'clientId does not match authenticated connection');
      return;
    }

    // Check pending admin challenge
    if (!meta.pendingAdminChallenge) {
      this.sendAdminError(ws, AdminErrorCode.NoAdminChallenge, 'Request an admin challenge first');
      return;
    }
    if (cmdEnvelope.challengeId !== meta.pendingAdminChallenge.challengeId) {
      this.sendAdminError(ws, AdminErrorCode.UnknownAdminChallenge, 'Challenge ID does not match');
      return;
    }

    // Save challenge data before clearing
    const { challengeId, nonce, expiresAt } = meta.pendingAdminChallenge;

    // Clear challenge from attachment (single-use) — serialize immediately
    const { pendingAdminChallenge: _, ...cleanMeta } = meta;
    ws.serializeAttachment(cleanMeta);

    // Check expiry
    if (Date.now() > expiresAt) {
      this.sendAdminError(ws, AdminErrorCode.AdminChallengeExpired, 'Admin challenge expired');
      return;
    }

    // Lifecycle check — reject for terminal rooms
    const roomState = await this.checkRoomLifecycle(ws, meta.roomId);
    if (!roomState) return;

    // Verify admin proof
    const valid = await verifyAdminProof(
      roomState.adminVerifier,
      meta.roomId,
      meta.clientId,
      challengeId,
      nonce,
      cmdEnvelope.command,
      cmdEnvelope.adminProof,
    );

    if (!valid) {
      safeLog('admin:proof-rejected', { roomId: meta.roomId, clientId: meta.clientId });
      this.sendAdminError(ws, AdminErrorCode.InvalidAdminProof, 'Admin proof verification failed');
      return;
    }

    // Apply command
    switch (cmdEnvelope.command.type) {
      case 'room.delete':
        await this.applyDelete(ws, roomState);
        break;
      default: {
        // Compile-time exhaustiveness guard: if a new admin command is added
        // to the union and a case here is missed, TypeScript fails here.
        const _exhaustive: never = cmdEnvelope.command.type;
        void _exhaustive;
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Admin Command Execution
  // ---------------------------------------------------------------------------

  private async applyDelete(
    ws: WebSocket,
    roomState: RoomDurableState,
  ): Promise<void> {
    // checkRoomLifecycle ran at the top of handleAdminCommand, so this
    // path is only reachable for a live room. purgeRoom wipes storage,
    // purges event keys, cancels the expiry alarm, and closes every
    // socket (including the admin's) with the generic unavailable
    // reason — same terminal UX as an expired room or a never-created
    // URL.
    try {
      await this.purgeRoom('admin');
    } catch (e) {
      // purgeRoom already handles its own storage-error logging. Signal
      // the admin caller that the delete didn't complete so their
      // pending promise rejects cleanly.
      safeLog('room:delete-error', { roomId: roomState.roomId, error: String(e) });
      this.sendAdminError(ws, AdminErrorCode.DeleteFailed, 'Failed to delete room');
    }
  }

  // ---------------------------------------------------------------------------
  // Storage Helpers
  // ---------------------------------------------------------------------------

  /**
   * Delete all event keys from storage in batches. Paginated for the same
   * reason as replay: avoid loading the full event log into DO memory.
   * Less latency-sensitive than replay but the memory bound still matters.
   */
  private async purgeEventKeys(): Promise<void> {
    while (true) {
      const page = await this.ctx.storage.list({
        prefix: 'event:',
        limit: DELETE_BATCH_SIZE,
      });
      if (page.size === 0) break;
      await this.ctx.storage.delete([...page.keys()]);
      if (page.size < DELETE_BATCH_SIZE) break;
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup — single unified hard-delete path
  // ---------------------------------------------------------------------------

  /**
   * Hard-delete the room. No tombstone, no lingering state — once this
   * returns, the DO storage is empty of room data and every connected
   * socket has been closed with the generic "room unavailable" reason.
   *
   * Called from four triggers:
   *   - 'expiry'                       alarm fired at expiresAt
   *   - 'admin'                        creator clicked Delete room
   *   - 'create-preempted-expired'     a fresh create is supplanting a
   *                                    room whose alarm never fired
   *   - 'lifecycle-preempted-expired'  a socket reached us after the
   *                                    deadline; alarm hadn't landed yet
   *   - 'upgrade-preempted-expired'    same, on the HTTP upgrade path
   *
   * `reason` is logged but not surfaced to clients — from their
   * perspective, every purge looks the same: the link stops resolving.
   */
  private async purgeRoom(
    reason: 'expiry' | 'admin' | 'create-preempted-expired' | 'lifecycle-preempted-expired' | 'upgrade-preempted-expired',
    except?: WebSocket,
  ): Promise<void> {
    // Hard-delete the room record FIRST. Absence is what makes the room
    // unreachable to any new connection — a concurrent WS upgrade or
    // lifecycle check that lands mid-purge sees nothing and rejects.
    // Closing sockets before this would leave a window where the room
    // key still reads as present.
    try {
      await this.ctx.storage.delete('room');
    } catch (e) {
      safeLog('room:purge-delete-error', { reason, error: String(e) });
      throw e;
    }

    // Now close connected peers so they see the terminal close.
    this.closeRoomSockets(WS_CLOSE_REASON_ROOM_UNAVAILABLE, except);

    // Best-effort: cancel the pending alarm in case the trigger wasn't
    // the alarm itself. Avoids a redundant alarm wake after we've
    // already emptied the room.
    try {
      await this.ctx.storage.deleteAlarm();
    } catch (e) {
      safeLog('room:purge-delete-alarm-error', { reason, error: String(e) });
    }

    // Purge event log (per-event keys).
    try {
      await this.purgeEventKeys();
    } catch (e) {
      safeLog('room:purge-event-keys-error', { reason, error: String(e) });
    }

    safeLog('room:purged', { reason });
  }

  // ---------------------------------------------------------------------------
  // Broadcast Helpers
  // ---------------------------------------------------------------------------

  /**
   * Send a transport message to every authenticated socket in the room,
   * optionally excluding one (e.g. the sender for presence relay). Send
   * failures are intentionally ignored — the target socket may have closed.
   */
  private broadcast(message: RoomTransportMessage, exclude?: WebSocket): void {
    const json = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      const att = socket.deserializeAttachment() as WebSocketAttachment | null;
      if (att?.authenticated) {
        try { socket.send(json); } catch { /* socket may have closed */ }
      }
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    const error: RoomTransportMessage = { type: 'room.error', code, message };
    try { ws.send(JSON.stringify(error)); } catch { /* socket may have closed */ }
  }

  /**
   * Admin-scoped error emitter. Every admin-command rejection path
   * (validate, challenge, proof, state, persist) MUST go through this
   * wrapper instead of raw `sendError` so the `AdminErrorCode` type
   * enforces the contract the client's rejection gate relies on
   * (see `ADMIN_ERROR_CODES` in shared/collab/constants.ts). Adding a
   * new admin error = add a key to `AdminErrorCode`, use it here;
   * typos and non-admin codes surface as compile errors.
   */
  private sendAdminError(ws: WebSocket, code: AdminErrorCode, message: string): void {
    this.sendError(ws, code, message);
  }

  private closeRoomSockets(reason: string, except?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except) {
        socket.close(WS_CLOSE_ROOM_UNAVAILABLE, reason);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket Lifecycle (Hibernation API)
  // ---------------------------------------------------------------------------

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const meta = ws.deserializeAttachment() as WebSocketAttachment | null;
    const roomId = meta?.roomId ?? 'unknown';
    const clientId = meta?.authenticated ? meta.clientId : 'unauthenticated';
    safeLog('ws:closed', { roomId, clientId, code });

    // Tell the remaining peers the closed client has left so they can
    // drop that clientId's presence (cursor + avatar) immediately.
    // Without this, peers wait out the 30s client-side TTL sweep,
    // which made "refresh to test" pile up one ghost cursor per
    // refresh until the entries expired. Only broadcast for
    // authenticated sockets — unauth'd ones were never in peers'
    // presence maps, so nothing needs cleanup.
    //
    // `exclude: ws` leaves the closing socket out of the fan-out.
    // It may already be detached, but the broadcast's send-try/catch
    // tolerates that either way. No payload beyond clientId — the
    // protocol is zero-knowledge; we only relay opaque encrypted
    // presence packets, and the clientId is server-assigned in the
    // auth challenge so it's already non-secret.
    if (meta?.authenticated) {
      this.broadcast(
        { type: 'room.participant.left', clientId: meta.clientId },
        ws,
      );
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const meta = ws.deserializeAttachment() as WebSocketAttachment | null;
    const roomId = meta?.roomId ?? 'unknown';
    safeLog('ws:error', { roomId, error: String(error) });
  }
}
