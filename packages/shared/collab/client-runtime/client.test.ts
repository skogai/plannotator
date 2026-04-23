/**
 * Unit tests for CollabRoomClient using MockWebSocket.
 *
 * Scripts the server-side handshake, events, and admin flow deterministically.
 */

import { describe, expect, test } from 'bun:test';
import {
  CollabRoomClient,
  AdminNotAuthorizedError,
  NotConnectedError,
  AdminRejectedError,
  ConnectTimeoutError,
  InvalidOutboundPayloadError,
} from './client';
import { MockWebSocket } from './mock-websocket';
import {
  deriveRoomKeys,
  deriveAdminKey,
  computeRoomVerifier,
  computeAdminVerifier,
  computeAuthProof,
  encryptEventOp,
  encryptPresence,
  encryptSnapshot,
  decryptEventPayload,
} from '../crypto';
import { generateClientId, generateRoomSecret, generateAdminSecret, generateChallengeId, generateNonce } from '../ids';
import { ADMIN_ERROR_CODES } from '../constants';
import type { AuthChallenge, AuthAccepted, RoomSnapshot, ServerEnvelope, RoomTransportMessage, RoomAnnotation, AuthResponse, AdminChallenge, AdminCommandEnvelope } from '../types';
import type { CollabRoomState, CollabRoomUser } from './types';

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const USER: CollabRoomUser = { id: 'u1', name: 'alice', color: '#f00' };
const ROOM_ID = 'ABCDEFGHIJKLMNOPQRSTUv';  // 22 chars

/**
 * Construct a test auth.challenge including the now-required server-assigned
 * clientId. Tests that care about the exact clientId can pass it explicitly;
 * otherwise a fresh one is generated per call.
 */
function makeAuthChallenge(overrides: Partial<AuthChallenge> = {}): AuthChallenge {
  return {
    type: 'auth.challenge',
    challengeId: overrides.challengeId ?? generateChallengeId(),
    nonce: overrides.nonce ?? generateNonce(),
    expiresAt: overrides.expiresAt ?? Date.now() + 30_000,
    clientId: overrides.clientId ?? generateClientId(),
  };
}

interface TestSetup {
  client: CollabRoomClient;
  ws: MockWebSocket;
  roomSecret: Uint8Array;
  roomVerifier: string;
  adminSecret: Uint8Array;
  adminVerifier: string;
  eventKey: CryptoKey;
  presenceKey: CryptoKey;
  snapshot: RoomSnapshot;
}

async function setup(options: { withAdmin?: boolean } = {}): Promise<TestSetup> {
  const roomSecret = generateRoomSecret();
  const adminSecret = generateAdminSecret();
  const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
  const adminKey = options.withAdmin ? await deriveAdminKey(adminSecret) : null;
  const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);
  const adminVerifier = adminKey ? await computeAdminVerifier(adminKey, ROOM_ID) : null;

  const snapshot: RoomSnapshot = {
    versionId: 'v1',
    planMarkdown: '# Plan',
    annotations: [],
  };

  // Capture the constructed WebSocket for scripting
  let capturedWs: MockWebSocket | null = null;
  const WebSocketImpl = class extends MockWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      capturedWs = this;
    }
  } as unknown as typeof WebSocket;

  const client = new CollabRoomClient({
    roomId: ROOM_ID,
    baseUrl: 'http://localhost:8787',
    eventKey,
    presenceKey,
    adminKey,
    roomVerifier,
    adminVerifier,
    user: USER,
    webSocketImpl: WebSocketImpl,
    connectTimeoutMs: 2000,
    reconnect: { maxAttempts: 0 }, // disable auto-reconnect in tests unless overridden
    presenceTtlMs: 50, // short for testing
    presenceSweepIntervalMs: 20,
  });

  // Start connect asynchronously so the mock WS gets constructed
  const connectPromise = client.connect();

  // Wait for ws to be captured
  await new Promise<void>((r) => {
    const check = () => {
      if (capturedWs) r();
      else queueMicrotask(check);
    };
    check();
  });

  // Complete auth handshake
  const ws = capturedWs!;
  // Let the mock ws fire onopen
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));

  const challenge = makeAuthChallenge();
  ws.peer.sendFromServer(JSON.stringify(challenge));

  // Client responds with auth.response
  const responseMsg = await ws.peer.expectFromClient();
  const response = JSON.parse(responseMsg) as AuthResponse;
  expect(response.type).toBe('auth.response');
  expect(response.challengeId).toBe(challenge.challengeId);

  // Server sends auth.accepted
  const accepted: AuthAccepted = {
    type: 'auth.accepted',
    seq: 0,
    snapshotSeq: 0,
    snapshotAvailable: true,
  };
  ws.peer.sendFromServer(JSON.stringify(accepted));

  // Server sends snapshot
  const snapshotCiphertext = await encryptSnapshot(eventKey, snapshot);
  const snapshotMsg: RoomTransportMessage = {
    type: 'room.snapshot',
    snapshotSeq: 0,
    snapshotCiphertext,
  };
  ws.peer.sendFromServer(JSON.stringify(snapshotMsg));

  await connectPromise;
  await new Promise(r => setTimeout(r, 10)); // let snapshot decrypt settle

  return {
    client,
    ws,
    roomSecret,
    roomVerifier,
    adminSecret,
    adminVerifier: adminVerifier ?? '',
    eventKey,
    presenceKey,
    snapshot,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CollabRoomClient — constructor isolates initialSnapshot (P2)', () => {
  test('caller mutating initialSnapshot.annotations after construction does not affect internal state', async () => {
    const roomSecret = generateRoomSecret();
    const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
    const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

    const ann: RoomAnnotation = {
      id: 'seed-1', blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'original', createdA: 1,
      startMeta: { parentTagName: 'p', parentIndex: 0, textOffset: 0 },
    };
    const initialSnapshot = { versionId: 'v1' as const, planMarkdown: '# P', annotations: [ann] };

    const client = new CollabRoomClient({
      roomId: ROOM_ID,
      baseUrl: 'http://localhost:8787',
      eventKey,
      presenceKey,
      adminKey: null,
      roomVerifier,
      adminVerifier: null,
      user: USER,
      initialSnapshot,
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });

    // Mutate caller's copy.
    ann.originalText = 'MUTATED';
    ann.startMeta!.parentTagName = 'HIJACKED';
    initialSnapshot.annotations.push({ ...ann, id: 'injected' });

    // Client's internal view is unchanged.
    const snap = client.getState();
    expect(snap.annotations.length).toBe(1);
    expect(snap.annotations[0].id).toBe('seed-1');
    expect(snap.annotations[0].originalText).toBe('original');
    expect(snap.annotations[0].startMeta!.parentTagName).toBe('p');
  });
});

describe('CollabRoomClient — connect', () => {
  test('authenticates and transitions to authenticated', async () => {
    const { client } = await setup();
    expect(client.getState().connectionStatus).toBe('authenticated');
    client.disconnect();
  });

  test('getState includes snapshot plan markdown', async () => {
    const { client } = await setup();
    expect(client.getState().planMarkdown).toBe('# Plan');
    client.disconnect();
  });

  test('hasAdminCapability is true with admin key, false without', async () => {
    const withAdmin = await setup({ withAdmin: true });
    expect(withAdmin.client.getState().hasAdminCapability).toBe(true);
    withAdmin.client.disconnect();

    const noAdmin = await setup();
    expect(noAdmin.client.getState().hasAdminCapability).toBe(false);
    noAdmin.client.disconnect();
  });
});

describe('CollabRoomClient — concurrent sendOp ordering (P2)', () => {
  test('concurrent sendAnnotationAdd + sendAnnotationRemove preserves call order on the wire', async () => {
    const { client, ws, eventKey } = await setup();

    // Sized so the first encrypt (large payload) is slower than the second.
    const big: RoomAnnotation = {
      id: 'order-add', blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x'.repeat(50_000), createdA: 1,
    };

    // Fire two calls without awaiting between them — the second starts
    // encryption immediately. Without outbound serialization, the small
    // remove's ciphertext would finish first and land on the wire BEFORE
    // the add.
    const p1 = client.sendAnnotationAdd([big]);
    const p2 = client.sendAnnotationRemove(['order-add']);
    await Promise.all([p1, p2]);

    const first = JSON.parse(await ws.peer.expectFromClient()) as ServerEnvelope;
    const second = JSON.parse(await ws.peer.expectFromClient()) as ServerEnvelope;

    const firstOp = await decryptEventPayload(eventKey, first.ciphertext) as { type: string };
    const secondOp = await decryptEventPayload(eventKey, second.ciphertext) as { type: string };

    expect(firstOp.type).toBe('annotation.add');
    expect(secondOp.type).toBe('annotation.remove');
    client.disconnect();
  });
});

describe('CollabRoomClient — sendAnnotationAdd', () => {
  test('produces encrypted envelope on wire', async () => {
    const { client, ws, eventKey } = await setup();
    const ann: RoomAnnotation = {
      id: 'ann-1',
      blockId: 'b1',
      startOffset: 0,
      endOffset: 5,
      type: 'COMMENT',
      originalText: 'hello',
      createdA: 1234,
      text: 'my comment',
    };
    await client.sendAnnotationAdd([ann]);
    const sent = await ws.peer.expectFromClient();
    const envelope = JSON.parse(sent) as ServerEnvelope;
    expect(envelope.channel).toBe('event');
    expect(envelope.clientId).toBe(client.getState().clientId);

    // Decrypt the envelope ciphertext to confirm round-trip
    const decrypted = await decryptEventPayload(eventKey, envelope.ciphertext);
    expect(decrypted).toEqual({ type: 'annotation.add', annotations: [ann] });

    client.disconnect();
  });

});

describe('CollabRoomClient — server echo is authoritative', () => {
  test('our own echoed event applies exactly once', async () => {
    const { client, ws } = await setup();
    const ann: RoomAnnotation = {
      id: 'echo-1',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    };
    await client.sendAnnotationAdd([ann]);

    // No optimistic apply — pre-echo count is 0.
    expect(client.getState().annotations.length).toBe(0);

    const sent = await ws.peer.expectFromClient();
    const envelope = JSON.parse(sent) as ServerEnvelope;

    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(), envelope,
    }));
    await new Promise(r => setTimeout(r, 10));

    // Echo applied once; seq advanced.
    expect(client.getState().annotations.length).toBe(1);
    expect(client.getState().annotations[0].id).toBe('echo-1');
    expect(client.getState().seq).toBe(1);
    client.disconnect();
  });

  test('event from another client applies normally', async () => {
    const { client, ws, eventKey } = await setup();
    const otherAnn: RoomAnnotation = {
      id: 'other-1',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    };
    const ciphertext = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [otherAnn] });
    const envelope: ServerEnvelope = {
      clientId: 'other-client',
      opId: 'other-op-id',
      channel: 'event',
      ciphertext,
    };
    const event: RoomTransportMessage = { type: 'room.event', seq: 1, receivedAt: Date.now(), envelope };
    ws.peer.sendFromServer(JSON.stringify(event));
    await new Promise(r => setTimeout(r, 10));

    expect(client.getState().annotations.length).toBe(1);
    expect(client.getState().annotations[0].id).toBe('other-1');
    client.disconnect();
  });
});

describe('CollabRoomClient — admin', () => {
  test('deleteRoom without admin rejects', async () => {
    const { client } = await setup(); // no admin
    await expect(client.deleteRoom()).rejects.toThrow(AdminNotAuthorizedError);
    client.disconnect();
  });

  test('deleteRoom sends challenge.request, then admin.command with proof, resolves on terminal socket close', async () => {
    const { client, ws } = await setup({ withAdmin: true });

    const deletePromise = client.deleteRoom();

    // Client sends admin.challenge.request
    const req = await ws.peer.expectFromClient();
    expect(JSON.parse(req).type).toBe('admin.challenge.request');

    // Server sends admin.challenge
    const adminChallenge: AdminChallenge = {
      type: 'admin.challenge',
      challengeId: generateChallengeId(),
      nonce: generateNonce(),
      expiresAt: Date.now() + 30_000,
    };
    ws.peer.sendFromServer(JSON.stringify(adminChallenge));

    // Client sends admin.command
    const cmdMsg = await ws.peer.expectFromClient();
    const cmd = JSON.parse(cmdMsg) as AdminCommandEnvelope;
    expect(cmd.type).toBe('admin.command');
    expect(cmd.command.type).toBe('room.delete');
    expect(cmd.challengeId).toBe(adminChallenge.challengeId);
    expect(cmd.adminProof.length).toBeGreaterThan(0);

    // Server terminates the socket with the unavailable close — the
    // single success signal for delete in the simplified protocol.
    ws.peer.simulateClose(4006, 'Room unavailable');

    await deletePromise; // resolves on terminal close
    expect(client.getState().roomUnavailable).toBe(true);
    client.disconnect();
  });

  test('admin command rejects on room.error', async () => {
    const { client, ws } = await setup({ withAdmin: true });

    const deletePromise = client.deleteRoom();
    await ws.peer.expectFromClient(); // admin.challenge.request

    const adminChallenge: AdminChallenge = {
      type: 'admin.challenge',
      challengeId: generateChallengeId(),
      nonce: generateNonce(),
      expiresAt: Date.now() + 30_000,
    };
    ws.peer.sendFromServer(JSON.stringify(adminChallenge));
    await ws.peer.expectFromClient(); // admin.command

    // Server sends room.error instead of room.status
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.error',
      code: 'delete_failed',
      message: 'Cannot delete',
    }));

    await expect(deletePromise).rejects.toThrow(AdminRejectedError);
    client.disconnect();
  });

  test('contract: every code in ADMIN_ERROR_CODES rejects a pending admin command as admin-scoped', async () => {
    // Contract test for the shared admin-error-code tuple. Iterates every
    // code declared in `packages/shared/collab/constants.ts` and asserts
    // that the runtime treats it as admin-scoped (rejects pending admin
    // with AdminRejectedError, does not fall through to the 5s timeout).
    //
    // This is the single gate that prevents the class of drift where a
    // server adds a new `sendAdminError` call site with a code the
    // client's rejection Set doesn't recognize — the tuple is the shared
    // source of truth, so any new code must land in the tuple first,
    // and this test forces it to route correctly end-to-end.
    //
    // If this test fails after adding a new admin code:
    //   1. Confirm the code is in AdminErrorCode namespace in constants.ts.
    //   2. Confirm ADMIN_SCOPED_ERROR_CODES in client.ts derives from the
    //      tuple (not a duplicate literal).
    //   3. If both are correct, the runtime's rejection path has a bug —
    //      not a contract bug.
    for (const code of ADMIN_ERROR_CODES) {
      const { client, ws } = await setup({ withAdmin: true });

      const deletePromise = client.deleteRoom();
      await ws.peer.expectFromClient(); // admin.challenge.request

      const start = Date.now();
      ws.peer.sendFromServer(JSON.stringify({
        type: 'room.error',
        code,
        message: `Server rejected: ${code}`,
      }));

      await expect(deletePromise).rejects.toThrow(AdminRejectedError);
      // Reject immediately, not via 5s admin timeout.
      expect(Date.now() - start).toBeLessThan(500);

      client.disconnect();
    }
  });

  test('non-admin room.error (e.g. validation_error from event channel) does NOT reject pending admin', async () => {
    // Regression: previously ANY room.error rejected the pending admin
    // command. But room.error is also used for event-channel failures
    // (validation_error, event_persist_failed). If one of those lands
    // while a delete command is in flight, we must NOT cancel the
    // delete — its terminal socket-close may still be on the way.
    const { client, ws } = await setup({ withAdmin: true });

    const deletePromise = client.deleteRoom();
    await ws.peer.expectFromClient(); // admin.challenge.request
    const adminChallenge: AdminChallenge = {
      type: 'admin.challenge',
      challengeId: generateChallengeId(),
      nonce: generateNonce(),
      expiresAt: Date.now() + 30_000,
    };
    ws.peer.sendFromServer(JSON.stringify(adminChallenge));
    await ws.peer.expectFromClient(); // admin.command

    // Event-channel error lands BEFORE the admin command's status broadcast.
    // pendingAdmin must stay alive.
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.error',
      code: 'validation_error',
      message: 'Malformed annotation payload',
    }));
    // Give the error a tick to land.
    await new Promise(r => setTimeout(r, 20));

    // The terminal delete close arrives now — delete should resolve.
    ws.peer.simulateClose(4006, 'Room unavailable');
    await deletePromise;  // resolves (does NOT reject)

    // lastError was still set by the event-channel error for UI consumers.
    expect(client.getState().lastError?.code).toBe('validation_error');
  });
});

describe('CollabRoomClient — NotConnectedError', () => {
  test('sendAnnotationAdd before connect throws', async () => {
    const roomSecret = generateRoomSecret();
    const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
    const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

    const client = new CollabRoomClient({
      roomId: ROOM_ID,
      baseUrl: 'http://localhost:8787',
      eventKey,
      presenceKey,
      adminKey: null,
      roomVerifier,
      adminVerifier: null,
      user: USER,
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });

    // Use a valid (non-empty) annotation so the test exercises the
    // NotConnectedError path rather than tripping outbound validation's
    // empty-array rejection.
    const ann: RoomAnnotation = {
      id: 'nc-1',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    };
    await expect(client.sendAnnotationAdd([ann])).rejects.toThrow(NotConnectedError);
  });
});

describe('CollabRoomClient — initial connect timeout', () => {
  test('rejects with ConnectTimeoutError, stays disconnected, does not auto-reconnect', async () => {
    const roomSecret = generateRoomSecret();
    const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
    const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

    const constructed: MockWebSocket[] = [];
    const WebSocketImpl = class extends MockWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        constructed.push(this);
      }
    } as unknown as typeof WebSocket;

    const client = new CollabRoomClient({
      roomId: ROOM_ID,
      baseUrl: 'http://localhost:8787',
      eventKey,
      presenceKey,
      adminKey: null,
      roomVerifier,
      adminVerifier: null,
      user: USER,
      webSocketImpl: WebSocketImpl,
      connectTimeoutMs: 50,  // very short — server never sends challenge
      reconnect: { maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 20 },
    });

    // No server script — let the timeout fire
    await expect(client.connect()).rejects.toThrow(ConnectTimeoutError);

    // Wait past any potential reconnect delay + close handling
    await new Promise(r => setTimeout(r, 100));

    expect(client.getState().connectionStatus).toBe('disconnected');
    expect(constructed.length).toBe(1);  // no auto-reconnect attempt
  });
});

describe('CollabRoomClient — every event applies (no echo dedup in V1)', () => {
  test('opId collision from another client does not drop the event', async () => {
    // V1 removed echo dedup — every room.event applies, including our own
    // echoes and any event another client happens to send with the same opId.
    // This makes the "malicious participant silences our ops by opId reuse"
    // attack inapplicable.
    const { client, ws, eventKey } = await setup();
    const ourAnn: RoomAnnotation = {
      id: 'ours-1',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    };
    await client.sendAnnotationAdd([ourAnn]);
    const sent = await ws.peer.expectFromClient();
    const ourEnvelope = JSON.parse(sent) as ServerEnvelope;

    // Server echoes our op (this applies ours-1).
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(), envelope: ourEnvelope,
    }));

    // Another client sends an op with the SAME opId. Must still apply.
    const otherAnn: RoomAnnotation = {
      id: 'other-1',
      blockId: 'b2', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'y', createdA: 2,
    };
    const spoofCiphertext = await encryptEventOp(eventKey, {
      type: 'annotation.add', annotations: [otherAnn],
    });
    const spoofEnvelope: ServerEnvelope = {
      clientId: 'attacker',
      opId: ourEnvelope.opId,  // reused
      channel: 'event',
      ciphertext: spoofCiphertext,
    };
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 2, receivedAt: Date.now(), envelope: spoofEnvelope,
    }));
    await new Promise(r => setTimeout(r, 10));

    const ids = client.getState().annotations.map(a => a.id);
    expect(ids).toContain('ours-1');
    expect(ids).toContain('other-1');
    client.disconnect();
  });
});

describe('CollabRoomClient — state events fire on status transitions', () => {
  test('subscribers receive state for connecting/authenticating/authenticated', async () => {
    const roomSecret = generateRoomSecret();
    const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
    const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

    let capturedWs: MockWebSocket | null = null;
    const WebSocketImpl = class extends MockWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        capturedWs = this;
      }
    } as unknown as typeof WebSocket;

    const client = new CollabRoomClient({
      roomId: ROOM_ID,
      baseUrl: 'http://localhost:8787',
      eventKey,
      presenceKey,
      adminKey: null,
      roomVerifier,
      adminVerifier: null,
      user: USER,
      webSocketImpl: WebSocketImpl,
      connectTimeoutMs: 2000,
    });

    const statusesFromState: string[] = [];
    client.on('state', (s) => { statusesFromState.push(s.connectionStatus); });

    const connectPromise = client.connect();

    await new Promise<void>((r) => {
      const check = () => (capturedWs ? r() : queueMicrotask(check));
      check();
    });
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));

    const ws = capturedWs!;
    const challenge = makeAuthChallenge();
    ws.peer.sendFromServer(JSON.stringify(challenge));
    await ws.peer.expectFromClient();  // drain auth.response

    const accepted: AuthAccepted = {
      type: 'auth.accepted',
      seq: 0,
      snapshotSeq: 0,
      snapshotAvailable: false,
    };
    ws.peer.sendFromServer(JSON.stringify(accepted));
    await connectPromise;

    expect(statusesFromState).toContain('connecting');
    expect(statusesFromState).toContain('authenticating');
    expect(statusesFromState).toContain('authenticated');
    client.disconnect();
  });

  test('authenticated state is never emitted with stale lastError (P2 ordering)', async () => {
    const roomSecret = generateRoomSecret();
    const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
    const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

    let capturedWs: MockWebSocket | null = null;
    const WebSocketImpl = class extends MockWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        capturedWs = this;
      }
    } as unknown as typeof WebSocket;

    const client = new CollabRoomClient({
      roomId: ROOM_ID,
      baseUrl: 'http://localhost:8787',
      eventKey,
      presenceKey,
      adminKey: null,
      roomVerifier,
      adminVerifier: null,
      user: USER,
      webSocketImpl: WebSocketImpl,
      connectTimeoutMs: 2000,
    });

    // Record every state snapshot so we can inspect intermediate values.
    const snapshots: CollabRoomState[] = [];
    client.on('state', (s) => { snapshots.push({ ...s }); });

    const connectPromise = client.connect();
    await new Promise<void>((r) => { const c = () => capturedWs ? r() : queueMicrotask(c); c(); });
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));

    const ws = capturedWs!;
    ws.peer.sendFromServer(JSON.stringify(makeAuthChallenge()));
    await ws.peer.expectFromClient();

    ws.peer.sendFromServer(JSON.stringify({
      type: 'auth.accepted',
      seq: 0, snapshotSeq: 0, snapshotAvailable: false,
    }));
    await connectPromise;

    // Every snapshot with connectionStatus === 'authenticated' must have
    // roomUnavailable === false. If setStatus('authenticated') ever fired
    // against a terminal flag, this would fail.
    const authedSnapshots = snapshots.filter(s => s.connectionStatus === 'authenticated');
    expect(authedSnapshots.length).toBeGreaterThan(0);
    for (const s of authedSnapshots) {
      expect(s.roomUnavailable).toBe(false);
    }

    client.disconnect();
  });
});

describe('CollabRoomClient — disconnect', () => {
  test('disconnect transitions to closed', async () => {
    const { client } = await setup();
    client.disconnect();
    expect(client.getState().connectionStatus).toBe('closed');
  });

  test('reconnect after disconnect clears userDisconnected', async () => {
    const { client } = await setup();
    client.disconnect();
    expect(client.getState().connectionStatus).toBe('closed');

    // Trying to connect again should not throw immediately (userDisconnected cleared)
    // We don't fully run the handshake here — just verify the state reset
    const connectPromise = client.connect();
    // Cancel by disconnecting again
    client.disconnect();
    await expect(connectPromise).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Regression tests for P1/P2 race fixes
// ---------------------------------------------------------------------------

describe('CollabRoomClient — auth.accepted does not advance local seq (P1 replay safety)', () => {
  test('accepted.seq > 0 does not update seq until replay snapshot/event applies', async () => {
    const roomSecret = generateRoomSecret();
    const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
    const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

    let capturedWs: MockWebSocket | null = null;
    const WebSocketImpl = class extends MockWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        capturedWs = this;
      }
    } as unknown as typeof WebSocket;

    const client = new CollabRoomClient({
      roomId: ROOM_ID,
      baseUrl: 'http://localhost:8787',
      eventKey,
      presenceKey,
      adminKey: null,
      roomVerifier,
      adminVerifier: null,
      user: USER,
      webSocketImpl: WebSocketImpl,
      connectTimeoutMs: 2000,
    });

    const connectPromise = client.connect();
    await new Promise<void>((r) => { const c = () => capturedWs ? r() : queueMicrotask(c); c(); });
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));
    const ws = capturedWs!;

    const challenge = makeAuthChallenge();
    ws.peer.sendFromServer(JSON.stringify(challenge));
    await ws.peer.expectFromClient();

    // Server claims seq: 42 in auth.accepted (replay incoming)
    const accepted: AuthAccepted = {
      type: 'auth.accepted',
      seq: 42, snapshotSeq: 40, snapshotAvailable: true,
    };
    ws.peer.sendFromServer(JSON.stringify(accepted));
    await connectPromise;

    // Crucially: BEFORE any snapshot/event arrives, seq must still be 0.
    expect(client.getState().seq).toBe(0);

    // Now simulate the server delivering the snapshot — only THEN does seq move.
    const snapshot: RoomSnapshot = { versionId: 'v1', planMarkdown: '# Plan', annotations: [] };
    const snapshotCiphertext = await encryptSnapshot(eventKey, snapshot);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.snapshot', snapshotSeq: 40, snapshotCiphertext,
    }));
    await new Promise(r => setTimeout(r, 10));
    expect(client.getState().seq).toBe(40);

    // And a replayed event after the snapshot advances seq further — proving
    // the "last server seq consumed" contract holds on the event path too.
    const replayedAnn: RoomAnnotation = {
      id: 'replay-1',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    };
    const replayCipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [replayedAnn] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 42, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'replay-op-1', channel: 'event', ciphertext: replayCipher },
    }));
    await new Promise(r => setTimeout(r, 10));
    expect(client.getState().seq).toBe(42);
    expect(client.getState().annotations.map(a => a.id)).toContain('replay-1');

    client.disconnect();
  });
});

describe('CollabRoomClient — disconnect during pending auth (P2)', () => {
  test('ends in closed, not disconnected', async () => {
    const roomSecret = generateRoomSecret();
    const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
    const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

    let capturedWs: MockWebSocket | null = null;
    const WebSocketImpl = class extends MockWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        capturedWs = this;
      }
    } as unknown as typeof WebSocket;

    const client = new CollabRoomClient({
      roomId: ROOM_ID,
      baseUrl: 'http://localhost:8787',
      eventKey,
      presenceKey,
      adminKey: null,
      roomVerifier,
      adminVerifier: null,
      user: USER,
      webSocketImpl: WebSocketImpl,
      connectTimeoutMs: 5000,
    });

    const connectPromise = client.connect();
    await new Promise<void>((r) => { const c = () => capturedWs ? r() : queueMicrotask(c); c(); });
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));

    // Do NOT complete auth. User calls disconnect() while pendingConnect is live.
    client.disconnect();
    await expect(connectPromise).rejects.toThrow();

    // Must be 'closed' (terminal), NOT 'disconnected' — the pending-connect
    // close branch must respect userDisconnected.
    expect(client.getState().connectionStatus).toBe('closed');
  });
});

describe('CollabRoomClient — sendOp send() throw does not mutate state (P2)', () => {
  test('synchronous ws.send throw propagates, leaves local state clean, next send works', async () => {
    const { client, ws } = await setup();

    const sendMock = ws.send.bind(ws);
    let shouldThrow = true;
    ws.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
      if (shouldThrow) { shouldThrow = false; throw new Error('simulated send failure'); }
      return sendMock(data);
    };

    const ann: RoomAnnotation = {
      id: 'send-fail-1',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    };
    const before = client.getState().annotations.length;
    await expect(client.sendAnnotationAdd([ann])).rejects.toThrow('simulated send failure');

    // Local annotations untouched (V1 has no optimistic apply anyway).
    expect(client.getState().annotations.length).toBe(before);

    // Subsequent successful send + echo works — no lingering state blocks it.
    const ann2: RoomAnnotation = {
      id: 'send-ok-1',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'y', createdA: 2,
    };
    await client.sendAnnotationAdd([ann2]);
    const sent = await ws.peer.expectFromClient();
    const env = JSON.parse(sent) as ServerEnvelope;

    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(), envelope: env,
    }));
    await new Promise(r => setTimeout(r, 10));
    expect(client.getState().annotations.filter(a => a.id === 'send-ok-1').length).toBe(1);

    client.disconnect();
  });
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('CollabRoomClient — auth proof handler handles mid-await rotation (P2)', () => {
  test('each socket only ever receives auth.response bound to its own challengeId', async () => {
    // This test pins the invariant that `auth.response` is never sent to a
    // different socket than the one that issued the challenge. It cannot
    // deterministically force the specific race where `computeAuthProof`
    // resolves after a socket rotation without patching Web Crypto internals
    // (bun's AES-GCM is microtask-fast, rotation happens on a 10ms timer).
    // What it DOES pin: the guard's observable property — no cross-talk of
    // auth.response challengeIds between rotated sockets.
    const constructed: MockWebSocket[] = [];
    const WebSocketImpl = class extends MockWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        constructed.push(this);
      }
    } as unknown as typeof WebSocket;

    const roomSecret = generateRoomSecret();
    const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
    const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

    const client = new CollabRoomClient({
      roomId: ROOM_ID,
      baseUrl: 'http://localhost:8787',
      eventKey,
      presenceKey,
      adminKey: null,
      roomVerifier,
      adminVerifier: null,
      user: USER,
      webSocketImpl: WebSocketImpl,
      connectTimeoutMs: 2000,
      reconnect: { maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 20 },
    });

    // First handshake completes.
    const connectPromise = client.connect();
    await waitFor(() => constructed.length >= 1, 1000);
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));
    const firstWs = constructed[0];

    const firstChallengeId = generateChallengeId();
    firstWs.peer.sendFromServer(JSON.stringify(makeAuthChallenge({ challengeId: firstChallengeId })));
    await firstWs.peer.expectFromClient();
    firstWs.peer.sendFromServer(JSON.stringify({
      type: 'auth.accepted',
      seq: 0, snapshotSeq: 0, snapshotAvailable: false,
    }));
    await connectPromise;

    // Rotate to a second socket via post-auth close.
    firstWs.peer.simulateClose(1006, 'network hiccup');
    await waitFor(() => constructed.length >= 2, 2000);
    const secondWs = constructed[1];
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));

    // Fire challenge + close mid-handshake to force a rotation attempt.
    const secondChallengeId = generateChallengeId();
    secondWs.peer.sendFromServer(JSON.stringify(makeAuthChallenge({ challengeId: secondChallengeId })));
    secondWs.peer.simulateClose(1006, 'rotate mid-handshake');

    await waitFor(() => constructed.length >= 3, 2000);
    const thirdWs = constructed[2];
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => setTimeout(r, 30));

    const thirdChallengeId = generateChallengeId();
    thirdWs.peer.sendFromServer(JSON.stringify(makeAuthChallenge({ challengeId: thirdChallengeId })));
    await new Promise(r => setTimeout(r, 30));

    // Collect auth.response messages per socket and check each one only saw
    // responses for its OWN challengeId (or none, if it rotated before resolving).
    const responsesFor = (ws: MockWebSocket) => ws.peer.sent
      .map(s => { try { return JSON.parse(s) as { type?: string; challengeId?: string }; } catch { return null; } })
      .filter((m): m is { type: string; challengeId: string } => m?.type === 'auth.response');

    const firstResponses = responsesFor(firstWs);
    const secondResponses = responsesFor(secondWs);
    const thirdResponses = responsesFor(thirdWs);

    // First socket: only firstChallengeId
    expect(firstResponses.every(r => r.challengeId === firstChallengeId)).toBe(true);
    // Second socket: only secondChallengeId (if any — proof may have resolved after rotation and been dropped)
    expect(secondResponses.every(r => r.challengeId === secondChallengeId)).toBe(true);
    // Third socket: only thirdChallengeId — crucially NOT secondChallengeId
    expect(thirdResponses.every(r => r.challengeId === thirdChallengeId)).toBe(true);
    expect(thirdResponses.some(r => r.challengeId === secondChallengeId)).toBe(false);
    expect(thirdResponses.some(r => r.challengeId === firstChallengeId)).toBe(false);

    client.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the latest review round
// ---------------------------------------------------------------------------

describe('CollabRoomClient — presence shape validation (P2)', () => {
  test('malformed presence payload is rejected with presence_malformed error and not stored', async () => {
    const { client, ws, presenceKey } = await setup();

    const errors: { code: string; message: string }[] = [];
    client.on('error', (e) => errors.push(e));

    // Encrypt a payload that decrypts to something that is NOT a valid PresenceState.
    // Use the presence crypto path (encryptPresence accepts an object) with a
    // garbage object that is valid encrypted JSON but wrong shape.
    const malformed = { user: { id: 'x', name: 42 /* not a string */, color: '#f00' }, cursor: null };
    // encryptPresence is typed to take PresenceState; cast to bypass for this adversarial test.
    const ciphertext = await encryptPresence(presenceKey, malformed as unknown as import('../types').PresenceState);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.presence',
      envelope: { clientId: 'attacker', opId: 'p1', channel: 'presence', ciphertext },
    }));
    await new Promise(r => setTimeout(r, 10));

    expect(errors.some(e => e.code === 'presence_malformed')).toBe(true);
    expect(client.getState().remotePresence.attacker).toBeUndefined();
    // lastError must reflect the malformed presence so hook consumers see it.
    expect(client.getState().lastError?.code).toBe('presence_malformed');
    client.disconnect();
  });

  test('valid presence payload is stored and emitted', async () => {
    const { client, ws, presenceKey } = await setup();

    const valid = {
      user: { id: 'u2', name: 'bob', color: '#0f0' },
      cursor: { x: 10, y: 20, coordinateSpace: 'document' as const },
    };
    const ciphertext = await encryptPresence(presenceKey, valid);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.presence',
      envelope: { clientId: 'friend', opId: 'p2', channel: 'presence', ciphertext },
    }));
    await new Promise(r => setTimeout(r, 10));

    expect(client.getState().remotePresence.friend).toEqual(valid);
    client.disconnect();
  });
});

describe('CollabRoomClient — snapshot is authoritative baseline (P2)', () => {
  test('snapshotSeq overrides this.seq even when snapshotSeq < this.seq', async () => {
    const { client, ws, eventKey } = await setup();

    // Drive seq up with an incoming event.
    const ann: RoomAnnotation = {
      id: 'e-1', blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    };
    const cipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [ann] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 10, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'o1', channel: 'event', ciphertext: cipher },
    }));
    await waitFor(() => client.getState().seq === 10, 1000);

    // Now the server delivers a snapshot with snapshotSeq=5 (LOWER than local seq).
    // This simulates the "future claim" fallback where the server's view diverges
    // from the client's. The snapshot must replace seq unconditionally so future
    // reconnects don't keep sending the stale higher lastSeq.
    const snap: RoomSnapshot = { versionId: 'v1', planMarkdown: '# Recovered', annotations: [] };
    const snapCipher = await encryptSnapshot(eventKey, snap);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.snapshot', snapshotSeq: 5, snapshotCiphertext: snapCipher,
    }));
    await waitFor(() => client.getState().planMarkdown === '# Recovered', 1000);

    expect(client.getState().seq).toBe(5);
    client.disconnect();
  });
});

describe('CollabRoomClient — stale-seq and baseline-invalid guards (P2)', () => {
  test('stale event (seq <= this.seq) is dropped — no decrypt, no state change, no event emission', async () => {
    const { client, ws, eventKey } = await setup();

    // Drive seq to 5 with a valid event.
    const ann: RoomAnnotation = {
      id: 'guard-1', blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    };
    const cipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [ann] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 5, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'o1', channel: 'event', ciphertext: cipher },
    }));
    await waitFor(() => client.getState().seq === 5, 1000);
    const snapBefore = client.getState();
    expect(snapBefore.annotations.length).toBe(1);

    // Replay the SAME event (seq 5) — must be dropped entirely.
    let eventEmissions = 0;
    client.on('event', () => { eventEmissions++; });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 5, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'o1-dup', channel: 'event', ciphertext: cipher },
    }));
    await new Promise(r => setTimeout(r, 20));
    expect(eventEmissions).toBe(0);
    expect(client.getState().seq).toBe(5);
    expect(client.getState().annotations.length).toBe(1);

    client.disconnect();
  });

  test('malformed snapshot blocks subsequent event application (baseline invalid)', async () => {
    const { client, ws, eventKey } = await setup();

    // Deliver a malformed snapshot.
    const badSnap = { versionId: 'v99', planMarkdown: 'bad', annotations: [] };
    const badSnapCipher = await encryptSnapshot(eventKey, badSnap as unknown as RoomSnapshot);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.snapshot', snapshotSeq: 10, snapshotCiphertext: badSnapCipher,
    }));
    await waitFor(() => client.getState().lastError?.code === 'snapshot_malformed', 1000);
    const annsBefore = client.getState().annotations.length;

    // Now a valid event at seq 11 — must NOT apply (baseline is invalid).
    const ann: RoomAnnotation = {
      id: 'post-bad-snap', blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'y', createdA: 1,
    };
    const cipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [ann] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 11, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'o2', channel: 'event', ciphertext: cipher },
    }));
    await waitFor(() => client.getState().seq === 11, 1000);
    // seq advanced for forward-progress, annotations untouched.
    expect(client.getState().annotations.length).toBe(annsBefore);
    expect(client.getState().annotations.find(a => a.id === 'post-bad-snap')).toBeUndefined();

    // Delivering a VALID snapshot clears baseline-invalid; subsequent events apply.
    const goodSnap: RoomSnapshot = {
      versionId: 'v1',
      planMarkdown: '# Recovered',
      annotations: [],
    };
    const goodSnapCipher = await encryptSnapshot(eventKey, goodSnap);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.snapshot', snapshotSeq: 20, snapshotCiphertext: goodSnapCipher,
    }));
    await waitFor(() => client.getState().planMarkdown === '# Recovered', 1000);

    const ann2: RoomAnnotation = {
      id: 'post-good-snap', blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'z', createdA: 1,
    };
    const cipher2 = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [ann2] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 21, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'o3', channel: 'event', ciphertext: cipher2 },
    }));
    await waitFor(() =>
      client.getState().annotations.some(a => a.id === 'post-good-snap'),
      1000,
    );

    client.disconnect();
  });

  test('baselineInvalid persists across reconnect: lastSeq omitted, events blocked until valid snapshot', async () => {
    // 1. Authenticate socket A and consume a valid event to drive seq to 1.
    const roomSecret = generateRoomSecret();
    const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
    const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

    const constructed: MockWebSocket[] = [];
    const WebSocketImpl = class extends MockWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        constructed.push(this);
      }
    } as unknown as typeof WebSocket;

    const client = new CollabRoomClient({
      roomId: ROOM_ID,
      baseUrl: 'http://localhost:8787',
      eventKey,
      presenceKey,
      adminKey: null,
      roomVerifier,
      adminVerifier: null,
      user: USER,
      webSocketImpl: WebSocketImpl,
      connectTimeoutMs: 2000,
      reconnect: { maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 20 },
    });

    const connectPromise = client.connect();
    await waitFor(() => constructed.length >= 1, 1000);
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));
    const wsA = constructed[0];
    wsA.peer.sendFromServer(JSON.stringify(makeAuthChallenge()));
    await wsA.peer.expectFromClient();
    wsA.peer.sendFromServer(JSON.stringify({
      type: 'auth.accepted',
      seq: 0, snapshotSeq: 0, snapshotAvailable: false,
    }));
    await connectPromise;

    // Drive seq to 10 with a malformed snapshot (baselineInvalid = true).
    const badSnap = { versionId: 'v99', planMarkdown: 'bad', annotations: [] };
    const badSnapCipher = await encryptSnapshot(eventKey, badSnap as unknown as RoomSnapshot);
    wsA.peer.sendFromServer(JSON.stringify({
      type: 'room.snapshot', snapshotSeq: 10, snapshotCiphertext: badSnapCipher,
    }));
    await waitFor(() => client.getState().lastError?.code === 'snapshot_malformed', 1000);

    // Deliver a post-snapshot event; it must NOT apply but SEQ must advance.
    const blockedAnn: RoomAnnotation = {
      id: 'blocked', blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'should-not-show', createdA: 1,
    };
    const blockedCipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [blockedAnn] });
    wsA.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 11, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'b1', channel: 'event', ciphertext: blockedCipher },
    }));
    await waitFor(() => client.getState().seq === 11, 1000);
    expect(client.getState().annotations.find(a => a.id === 'blocked')).toBeUndefined();

    // 2. Force a reconnect. The new socket's auth.response MUST omit lastSeq
    //    because baselineInvalid is true — otherwise the server might skip
    //    snapshot replay and leave us stale forever.
    wsA.peer.simulateClose(1006, 'reconnect drill');
    await waitFor(() => constructed.length >= 2, 2000);
    const wsB = constructed[1];
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));

    wsB.peer.sendFromServer(JSON.stringify(makeAuthChallenge()));
    const authResponseMsg = await wsB.peer.expectFromClient();
    const authResp = JSON.parse(authResponseMsg) as { lastSeq?: number };
    expect(authResp.lastSeq).toBeUndefined();

    wsB.peer.sendFromServer(JSON.stringify({
      type: 'auth.accepted',
      seq: 11, snapshotSeq: 11, snapshotAvailable: true,
    }));
    // auth.accepted alone must NOT clear baselineInvalid — only a valid
    // snapshot apply does. Prove by delivering another event BEFORE the
    // snapshot: it must still not apply.
    await new Promise(r => setTimeout(r, 20));
    const stillBlockedAnn: RoomAnnotation = {
      id: 'still-blocked', blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'still-should-not-show', createdA: 1,
    };
    const stillBlockedCipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [stillBlockedAnn] });
    wsB.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 12, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'b2', channel: 'event', ciphertext: stillBlockedCipher },
    }));
    await waitFor(() => client.getState().seq === 12, 1000);
    expect(client.getState().annotations.find(a => a.id === 'still-blocked')).toBeUndefined();

    // 3. Valid snapshot arrives and clears baselineInvalid — subsequent
    //    events apply.
    const goodSnap: RoomSnapshot = {
      versionId: 'v1',
      planMarkdown: '# Recovered',
      annotations: [],
    };
    const goodSnapCipher = await encryptSnapshot(eventKey, goodSnap);
    wsB.peer.sendFromServer(JSON.stringify({
      type: 'room.snapshot', snapshotSeq: 20, snapshotCiphertext: goodSnapCipher,
    }));
    await waitFor(() => client.getState().planMarkdown === '# Recovered', 1000);

    const recoveredAnn: RoomAnnotation = {
      id: 'recovered', blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'ok', createdA: 1,
    };
    const recoveredCipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [recoveredAnn] });
    wsB.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 21, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'r1', channel: 'event', ciphertext: recoveredCipher },
    }));
    await waitFor(() =>
      client.getState().annotations.some(a => a.id === 'recovered'),
      1000,
    );

    client.disconnect();
  });

  test('reducer-rejected update (merged-annotation invalid) advances seq without mutating state or emitting event', async () => {
    const { client, ws, eventKey } = await setup();

    // Seed a COMMENT with a valid non-empty blockId.
    const seed: RoomAnnotation = {
      id: 'reducer-seed', blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    };
    const seedCipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [seed] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'seed', channel: 'event', ciphertext: seedCipher },
    }));
    await waitFor(() => client.getState().annotations.length === 1, 1000);
    const stored = client.getState().annotations[0];

    // Patch passes op-level validation (blockId is a string per field rules)
    // but the merged final annotation violates the cross-field invariant
    // (COMMENT must have non-empty blockId). The reducer should reject.
    let eventEmissions = 0;
    client.on('event', () => { eventEmissions++; });

    const badPatch = { type: 'annotation.update', id: 'reducer-seed', patch: { blockId: '' } };
    const badCipher = await encryptEventOp(eventKey, badPatch as unknown as import('../types').RoomEventClientOp);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 2, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'bad-patch', channel: 'event', ciphertext: badCipher },
    }));
    await waitFor(() => client.getState().seq === 2, 1000);

    // seq advanced for forward-progress, annotation untouched, lastError set,
    // no `event` emitted.
    const after = client.getState().annotations[0];
    expect(after.blockId).toBe(stored.blockId);
    expect(client.getState().lastError?.code).toBe('event_rejected_by_reducer');
    expect(eventEmissions).toBe(0);

    client.disconnect();
  });

  test('outbound event payload is cloned before encryption — caller mutations cannot alter the wire op', async () => {
    const { client, ws, eventKey } = await setup();

    const ann: RoomAnnotation = {
      id: 'clone-1', blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'original', createdA: 1,
    };
    const anns = [ann];

    // Synchronously kick off the send, THEN mutate the caller's arrays before
    // the encryption queue has had a chance to run.
    const sendPromise = client.sendAnnotationAdd(anns);
    ann.originalText = 'MUTATED';
    anns.push({ ...ann, id: 'injected' });
    await sendPromise;

    const sent = JSON.parse(await ws.peer.expectFromClient()) as ServerEnvelope;
    const decrypted = await decryptEventPayload(eventKey, sent.ciphertext) as { type: string; annotations: RoomAnnotation[] };
    expect(decrypted.type).toBe('annotation.add');
    expect(decrypted.annotations).toHaveLength(1);  // injected push did NOT affect wire
    expect(decrypted.annotations[0].id).toBe('clone-1');
    expect(decrypted.annotations[0].originalText).toBe('original');

    client.disconnect();
  });
});

describe('CollabRoomClient — event/snapshot shape validation (P2)', () => {
  test('malformed RoomClientOp is rejected via event_malformed error, does not enter state', async () => {
    const { client, ws, eventKey } = await setup();

    const errors: { code: string; message: string }[] = [];
    client.on('error', (e) => errors.push(e));

    // A participant holds the eventKey but ships a structurally bad annotation.
    const malformed = {
      type: 'annotation.add',
      annotations: [{ id: null, blockId: 'b', type: null, originalText: null, startOffset: 0, endOffset: 0, createdA: 0 }],
    };
    const ciphertext = await encryptEventOp(eventKey, malformed as unknown as import('../types').RoomEventClientOp);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(),
      envelope: { clientId: 'attacker', opId: 'o1', channel: 'event', ciphertext },
    }));
    await new Promise(r => setTimeout(r, 20));

    expect(errors.some(e => e.code === 'event_malformed')).toBe(true);
    expect(client.getState().annotations.length).toBe(0);
    // V1 forward-progress: seq MUST advance even though the event was rejected.
    // If it didn't, reconnect lastSeq would keep replaying the malformed event
    // forever and block every valid event behind it.
    expect(client.getState().seq).toBe(1);
    // Event errors must also surface via state.lastError for hook consumers.
    expect(client.getState().lastError?.code).toBe('event_malformed');
    client.disconnect();
  });

  test('inbound presence.update on event channel is rejected (event/presence split)', async () => {
    const { client, ws, eventKey } = await setup();
    const errors: { code: string; message: string }[] = [];
    client.on('error', (e) => errors.push(e));

    // A participant with the eventKey encrypts a presence.update as if it
    // were an event-channel op. The narrow event validator must reject it so
    // presence traffic cannot pollute the durable event log.
    const presenceOnEvent = {
      type: 'presence.update',
      presence: {
        user: { id: 'u', name: 'x', color: '#f00' },
        cursor: null,
      },
    };
    const ciphertext = await encryptEventOp(eventKey, presenceOnEvent as unknown as import('../types').RoomEventClientOp);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(),
      envelope: { clientId: 'attacker', opId: 'sneaky', channel: 'event', ciphertext },
    }));
    await waitFor(() => client.getState().seq === 1, 1000);

    expect(errors.some(e => e.code === 'event_malformed')).toBe(true);
    expect(client.getState().annotations.length).toBe(0);
    client.disconnect();
  });

  test('malformed event at seq=N does not block valid events at seq>N (forward-progress)', async () => {
    const { client, ws, eventKey } = await setup();

    // Ship a malformed event at seq=1.
    const malformed = {
      type: 'annotation.add',
      annotations: [{ id: null, blockId: 'b', type: null, originalText: null, startOffset: 0, endOffset: 0, createdA: 0 }],
    };
    const badCipher = await encryptEventOp(eventKey, malformed as unknown as import('../types').RoomEventClientOp);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(),
      envelope: { clientId: 'attacker', opId: 'bad', channel: 'event', ciphertext: badCipher },
    }));
    await waitFor(() => client.getState().seq === 1, 1000);

    // Ship a valid event at seq=2. It must apply — replay-stream is not poisoned.
    const goodAnn: RoomAnnotation = {
      id: 'after-bad',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'y', createdA: 2,
    };
    const goodCipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [goodAnn] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 2, receivedAt: Date.now(),
      envelope: { clientId: 'friend', opId: 'good', channel: 'event', ciphertext: goodCipher },
    }));
    await waitFor(() => client.getState().seq === 2, 1000);

    const ids = client.getState().annotations.map(a => a.id);
    expect(ids).toContain('after-bad');
    client.disconnect();
  });

  test('malformed annotation.update patch is rejected (does not corrupt existing annotations)', async () => {
    const { client, ws, eventKey } = await setup();

    // Seed a real annotation first.
    const ann: RoomAnnotation = {
      id: 'real-1',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    };
    const addCipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [ann] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'a1', channel: 'event', ciphertext: addCipher },
    }));
    await waitFor(() => client.getState().annotations.length === 1, 1000);

    // Malicious update with patch that tries to set type=null (not a valid enum).
    const malformedPatch = {
      type: 'annotation.update',
      id: 'real-1',
      patch: { type: null, originalText: 42 },
    };
    const ciphertext = await encryptEventOp(eventKey, malformedPatch as unknown as import('../types').RoomEventClientOp);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 2, receivedAt: Date.now(),
      envelope: { clientId: 'attacker', opId: 'u1', channel: 'event', ciphertext },
    }));
    await new Promise(r => setTimeout(r, 20));

    // The existing annotation must be untouched.
    const stillThere = client.getState().annotations.find(a => a.id === 'real-1');
    expect(stillThere).toBeDefined();
    expect(stillThere!.type).toBe('COMMENT');
    expect(stillThere!.originalText).toBe('x');
    client.disconnect();
  });

  test('annotation.update with mismatched id in patch is rejected (identity-mutation attack)', async () => {
    const { client, ws, eventKey } = await setup();

    // Seed a real annotation via a valid event.
    const ann: RoomAnnotation = {
      id: 'stable-id',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    };
    const addCipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [ann] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'a1', channel: 'event', ciphertext: addCipher },
    }));
    await waitFor(() => client.getState().annotations.length === 1, 1000);

    // Malicious update: patch tries to hijack the id to a new value.
    // isRoomClientOp must reject this via isRoomAnnotationPatch — event_malformed emitted.
    const errors: { code: string; message: string }[] = [];
    client.on('error', (e) => errors.push(e));
    const hijackPatch = {
      type: 'annotation.update',
      id: 'stable-id',
      patch: { id: 'hijacked-id', text: 'pwned' },
    };
    const hijackCipher = await encryptEventOp(
      eventKey,
      hijackPatch as unknown as import('../types').RoomEventClientOp,
    );
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 2, receivedAt: Date.now(),
      envelope: { clientId: 'attacker', opId: 'hijack', channel: 'event', ciphertext: hijackCipher },
    }));
    await waitFor(() => client.getState().seq === 2, 1000);

    expect(errors.some(e => e.code === 'event_malformed')).toBe(true);
    const ids = client.getState().annotations.map(a => a.id);
    expect(ids).toContain('stable-id');
    expect(ids).not.toContain('hijacked-id');
    // Also confirm no renaming happened under the hood — the annotation at key 'stable-id' is intact.
    const stored = client.getState().annotations.find(a => a.id === 'stable-id')!;
    expect(stored.originalText).toBe('x');
    expect(stored.text).toBeUndefined();  // not patched with 'pwned'
    client.disconnect();
  });

  test('malformed snapshot is rejected via snapshot_malformed error, does not corrupt state', async () => {
    const { client, ws, eventKey } = await setup();

    const errors: { code: string; message: string }[] = [];
    client.on('error', (e) => errors.push(e));

    // First seed a real annotation via event so we can assert state is unchanged.
    const ann: RoomAnnotation = {
      id: 'keep-me',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    };
    const addCipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [ann] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'a1', channel: 'event', ciphertext: addCipher },
    }));
    await waitFor(() => client.getState().annotations.length === 1, 1000);

    // Now a malformed snapshot: wrong versionId.
    const malformedSnap = { versionId: 'v99', planMarkdown: 'corrupt', annotations: [] };
    const snapCipher = await encryptSnapshot(eventKey, malformedSnap as unknown as RoomSnapshot);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.snapshot', snapshotSeq: 99, snapshotCiphertext: snapCipher,
    }));
    await new Promise(r => setTimeout(r, 20));

    expect(errors.some(e => e.code === 'snapshot_malformed')).toBe(true);
    // Existing state preserved
    expect(client.getState().annotations.length).toBe(1);
    expect(client.getState().planMarkdown).toBe('# Plan');  // from setup()
    // seq not advanced by rejected snapshot
    expect(client.getState().seq).toBe(1);
    // Snapshot errors must surface to `state` subscribers via lastError so
    // hook consumers (which only subscribe to state) can react.
    expect(client.getState().lastError?.code).toBe('snapshot_malformed');
    client.disconnect();
  });
});

describe('CollabRoomClient — terminal close sets roomUnavailable (P2)', () => {
  test('close 4006 "Room unavailable" sets roomUnavailable=true and closes the connection', async () => {
    const { client, ws } = await setup();
    expect(client.getState().roomUnavailable).toBe(false);
    ws.peer.simulateClose(4006, 'Room unavailable');
    await new Promise(r => setTimeout(r, 10));
    expect(client.getState().roomUnavailable).toBe(true);
    expect(client.getState().connectionStatus).toBe('closed');
  });

  test('network drop (code 1006) does NOT set roomUnavailable', async () => {
    const { client, ws } = await setup();
    ws.peer.simulateClose(1006, '');
    await new Promise(r => setTimeout(r, 10));
    expect(client.getState().roomUnavailable).toBe(false);
  });
});

describe('CollabRoomClient — deleteRoom socket-close semantics (P2)', () => {
  test('deleteRoom rejects with AdminInterruptedError on network drop (not a delete close)', async () => {
    const { client, ws } = await setup({ withAdmin: true });

    const deletePromise = client.deleteRoom();
    await ws.peer.expectFromClient();  // admin.challenge.request

    const adminChallenge: AdminChallenge = {
      type: 'admin.challenge', challengeId: generateChallengeId(),
      nonce: generateNonce(), expiresAt: Date.now() + 30_000,
    };
    ws.peer.sendFromServer(JSON.stringify(adminChallenge));
    await ws.peer.expectFromClient();  // admin.command

    // Simulate a network drop — NOT the server's delete close.
    // Code 1006, no reason. Must NOT be treated as successful delete.
    ws.peer.simulateClose(1006, '');

    await expect(deletePromise).rejects.toThrow(/interrupted/i);
  });

  test('deleteRoom resolves on server close (code 4006, "Room unavailable")', async () => {
    const { client, ws } = await setup({ withAdmin: true });

    const deletePromise = client.deleteRoom();
    await ws.peer.expectFromClient();
    const adminChallenge: AdminChallenge = {
      type: 'admin.challenge', challengeId: generateChallengeId(),
      nonce: generateNonce(), expiresAt: Date.now() + 30_000,
    };
    ws.peer.sendFromServer(JSON.stringify(adminChallenge));
    await ws.peer.expectFromClient();

    // Server's purge-initiated close — the single success signal.
    ws.peer.simulateClose(4006, 'Room unavailable');

    await deletePromise;
    expect(client.getState().roomUnavailable).toBe(true);
  });
});

describe('CollabRoomClient — stale socket handlers do not clobber current socket (P3)', () => {
  // Helper: create a client + constructed-sockets array, with configurable reconnect.
  async function makeClient(opts: { asyncClose?: boolean; reconnect?: { maxAttempts: number; initialDelayMs?: number; maxDelayMs?: number } } = {}) {
    const prevAsyncMode = MockWebSocket.asyncCloseMode;
    MockWebSocket.asyncCloseMode = opts.asyncClose ?? false;
    const constructed: MockWebSocket[] = [];
    const WebSocketImpl = class extends MockWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        constructed.push(this);
      }
    } as unknown as typeof WebSocket;

    const roomSecret = generateRoomSecret();
    const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
    const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

    const client = new CollabRoomClient({
      roomId: ROOM_ID,
      baseUrl: 'http://localhost:8787',
      eventKey,
      presenceKey,
      adminKey: null,
      roomVerifier,
      adminVerifier: null,
      user: USER,
      webSocketImpl: WebSocketImpl,
      connectTimeoutMs: 5000,
      reconnect: opts.reconnect ?? { maxAttempts: 0 },
    });
    return {
      client, constructed,
      restore: () => { MockWebSocket.asyncCloseMode = prevAsyncMode; },
    };
  }

  async function completeAuth(ws: MockWebSocket, connectPromise: Promise<void>) {
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));
    ws.peer.sendFromServer(JSON.stringify(makeAuthChallenge()));
    await ws.peer.expectFromClient();
    ws.peer.sendFromServer(JSON.stringify({
      type: 'auth.accepted',
      seq: 0, snapshotSeq: 0, snapshotAvailable: false,
    }));
    await connectPromise;
  }

  test('auto-reconnect + explicit connect() during B: B is retired, C completes auth, late B events are ignored', async () => {
    // Exact original-race reproduction — NO intervening disconnect():
    //   1. Authenticate socket A.
    //   2. Server closes A; auto-reconnect opens socket B.
    //   3. Caller invokes connect() while B is still in flight.
    //   4. connect() must rotate: retire B, open socket C.
    //   5. Fire late onclose / onmessage on B — handlers must no-op, C must not be clobbered.
    //   6. Complete auth on C — must succeed.
    const { client, constructed, restore } = await makeClient({
      reconnect: { maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 20 },
    });

    try {
      // 1) Authenticate on socket A.
      const firstConnect = client.connect();
      await waitFor(() => constructed.length >= 1, 1000);
      const socketA = constructed[0];
      await completeAuth(socketA, firstConnect);
      expect(client.getState().connectionStatus).toBe('authenticated');

      // 2) Server closes A. Auto-reconnect opens socket B (post-auth, so
      //    pendingConnect is null and handleSocketClose schedules a reconnect).
      socketA.peer.simulateClose(1006, 'network flap');
      await waitFor(() => constructed.length >= 2, 1000);
      const socketB = constructed[1];
      // At this point B is the current socket; its handlers are bound; status
      // should be reconnecting / connecting. pendingConnect is null because
      // this is auto-reconnect, not initial-connect or explicit connect().

      // 3) Caller invokes connect() DIRECTLY while B is live (no disconnect()).
      //    This must open socket C and retire socket B.
      const rotationConnect = client.connect();
      await waitFor(() => constructed.length >= 3, 1000);
      const socketC = constructed[2];
      expect(socketC).not.toBe(socketB);

      // B should be closed by retireSocket (the implementation calls
      // ws.close() when it adds a socket to retiredSockets).
      expect(socketB.readyState).toBe(socketB.CLOSED);

      // 4) Fire a late onclose directly on the retired B — the handler
      //    (bound to B when it was constructed) must short-circuit on the
      //    retiredSockets check. If the guard is broken, this would re-enter
      //    handleSocketClose and null out this.ws, orphaning C.
      socketB.onclose?.(new CloseEvent('close', { code: 1006, reason: 'late B straggler', wasClean: false }));
      // Also fire a late onmessage on B — must be gated out.
      socketB.onmessage?.(new MessageEvent('message', { data: '{"type":"room.error","code":"stale","message":"from B"}' }));

      // 5) Complete auth on socket C — if B had clobbered this.ws, this would hang.
      await completeAuth(socketC, rotationConnect);
      expect(client.getState().connectionStatus).toBe('authenticated');

      client.disconnect();
    } finally {
      restore();
    }
  });

  test('async-close mock: intentional disconnect rejects pendingConnect synchronously (does not wait for deferred onclose)', async () => {
    // In real browsers ws.close() returns immediately and onclose fires in a
    // later microtask. Previously the client relied on the synchronous onclose
    // from closeSocket() to reject pendingConnect/pendingAdmin. Under true
    // async-close semantics, that produced a hang until timeout. This test
    // pins the fix: disconnect() rejects pendingConnect synchronously.
    const { client, constructed, restore } = await makeClient({ asyncClose: true });

    try {
      const connectPromise = client.connect();
      await waitFor(() => constructed.length === 1, 1000);
      await new Promise(r => queueMicrotask(r));
      await new Promise(r => queueMicrotask(r));

      // Do NOT complete auth. Just disconnect while pendingConnect is live.
      // Under the OLD implementation, this would hang until the 5000ms
      // connectTimeout fired because the onclose that would reject was
      // deferred as a microtask AND then gated away by `this.ws !== ws`.
      // Under the fix, disconnect() rejects synchronously.
      const start = Date.now();
      client.disconnect();
      await expect(connectPromise).rejects.toThrow();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);  // must not wait for 5s timeout
      expect(client.getState().connectionStatus).toBe('closed');
    } finally {
      restore();
    }
  });

  test('async-close mock: connect timeout rejects and transitions to disconnected even when onclose is deferred', async () => {
    const { client, constructed, restore } = await makeClient({ asyncClose: true });

    try {
      // Reach into the instance to shorten the connect timeout for test speed.
      // Construct a new client with a short timeout instead.
      client.disconnect();
      const roomSecret = generateRoomSecret();
      const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
      const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

      const WebSocketImpl = class extends MockWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          constructed.push(this);
        }
      } as unknown as typeof WebSocket;

      const fastClient = new CollabRoomClient({
        roomId: ROOM_ID,
        baseUrl: 'http://localhost:8787',
        eventKey,
        presenceKey,
        adminKey: null,
        roomVerifier,
        adminVerifier: null,
        user: USER,
        webSocketImpl: WebSocketImpl,
        connectTimeoutMs: 50,  // trigger timeout path
        reconnect: { maxAttempts: 0 },
      });

      const connectPromise = fastClient.connect();
      await expect(connectPromise).rejects.toThrow(ConnectTimeoutError);

      // Let the deferred onclose fire (from the timeout's closeSocket call).
      await new Promise(r => setTimeout(r, 50));

      // Critical assertions: the deferred onclose must not clobber the
      // already-settled state. Status must be 'disconnected' (not mutated
      // back by a late handleSocketClose).
      expect(fastClient.getState().connectionStatus).toBe('disconnected');
    } finally {
      restore();
    }
  });
});

describe('CollabRoomClient — getState() returns immutable snapshot (P2)', () => {
  test('mutating returned annotations / remotePresence does not affect internal state', async () => {
    const { client, ws, eventKey, presenceKey } = await setup();

    // Seed an annotation via server echo.
    const ann: RoomAnnotation = {
      id: 'imm-1',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
      startMeta: { parentTagName: 'p', parentIndex: 0, textOffset: 0 },
    };
    const cipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [ann] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'a1', channel: 'event', ciphertext: cipher },
    }));
    await waitFor(() => client.getState().annotations.length === 1, 1000);

    // Seed presence.
    const presence = {
      user: { id: 'u2', name: 'bob', color: '#0f0' },
      cursor: { x: 10, y: 20, coordinateSpace: 'document' as const },
    };
    const pCipher = await encryptPresence(presenceKey, presence);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.presence',
      envelope: { clientId: 'friend', opId: 'p1', channel: 'presence', ciphertext: pCipher },
    }));
    await waitFor(() => client.getState().remotePresence.friend !== undefined, 1000);

    // Seed a non-null lastError by pushing a room.error from the server.
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.error', code: 'validation_error', message: 'Test error message',
    }));
    await waitFor(() => client.getState().lastError !== null, 1000);

    // Grab the snapshot and MUTATE the returned objects.
    const snap1 = client.getState();
    (snap1.annotations[0] as RoomAnnotation).originalText = 'MUTATED';
    snap1.annotations[0].startMeta!.parentTagName = 'HIJACKED';
    snap1.remotePresence.friend.user.name = 'MUTATED';
    snap1.remotePresence.friend.cursor!.x = 9999;
    snap1.annotations.push({ ...ann, id: 'injected' });
    snap1.remotePresence.intruder = {
      user: { id: 'x', name: 'x', color: '#000' },
      cursor: null,
    };
    snap1.lastError!.message = 'MUTATED ERROR';

    // Fresh snapshot must reflect internal state, not the mutations above.
    const snap2 = client.getState();
    expect(snap2.annotations.length).toBe(1);
    expect(snap2.annotations[0].id).toBe('imm-1');
    expect(snap2.annotations[0].originalText).toBe('x');
    expect(snap2.annotations[0].startMeta!.parentTagName).toBe('p');
    expect(snap2.remotePresence.friend.user.name).toBe('bob');
    expect(snap2.remotePresence.friend.cursor!.x).toBe(10);
    expect(snap2.remotePresence.intruder).toBeUndefined();
    expect(snap2.lastError).not.toBeNull();
    expect(snap2.lastError!.message).toBe('Test error message');
    expect(snap2.lastError!.code).toBe('validation_error');

    client.disconnect();
  });

});

// NOTE: the auth-proof failure during auto-reconnect code path (handleAuthChallenge
// catch branch when pendingConnect === null) is defensive and hard to exercise
// deterministically without patching WebCrypto. It's covered by code review and the
// existing initial-connect auth-failure path is tested above.

describe('CollabRoomClient — auth.challenge missing clientId (P3 protocol violation)', () => {
  test('initial-connect: rejects pendingConnect and transitions to disconnected (does not hang until timeout)', async () => {
    const roomSecret = generateRoomSecret();
    const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
    const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

    let capturedWs: MockWebSocket | null = null;
    const WebSocketImpl = class extends MockWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        capturedWs = this;
      }
    } as unknown as typeof WebSocket;

    const client = new CollabRoomClient({
      roomId: ROOM_ID,
      baseUrl: 'http://localhost:8787',
      eventKey,
      presenceKey,
      adminKey: null,
      roomVerifier,
      adminVerifier: null,
      user: USER,
      webSocketImpl: WebSocketImpl,
      connectTimeoutMs: 5000,  // intentionally long — test must reject fast
      reconnect: { maxAttempts: 0 },
    });

    const connectPromise = client.connect();
    await waitFor(() => capturedWs !== null, 1000);
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));

    // Send a challenge WITHOUT clientId (simulates old server / malformed).
    const ws = capturedWs!;
    ws.peer.sendFromServer(JSON.stringify({
      type: 'auth.challenge',
      challengeId: generateChallengeId(),
      nonce: generateNonce(),
      expiresAt: Date.now() + 30_000,
      // clientId: missing
    }));

    const start = Date.now();
    await expect(connectPromise).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);  // not waiting for connectTimeoutMs
    expect(client.getState().connectionStatus).toBe('disconnected');
  });
});

describe('CollabRoomClient — openSocket synchronous throw is cleaned up (P2)', () => {
  test('synchronous WebSocket constructor throw: connect rejects, state returns to disconnected, next connect is not blocked', async () => {
    const roomSecret = generateRoomSecret();
    const { authKey, eventKey, presenceKey } = await deriveRoomKeys(roomSecret);
    const roomVerifier = await computeRoomVerifier(authKey, ROOM_ID);

    // First impl throws synchronously from the constructor. Second impl is
    // a normal MockWebSocket so a follow-up connect() can actually proceed.
    let attempt = 0;
    const boom = new Error('WebSocket constructor exploded');
    const capturedSockets: MockWebSocket[] = [];
    const WebSocketImpl = class extends MockWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        attempt++;
        if (attempt === 1) {
          // Throw from the constructor so the `new this.WebSocketImpl(wsUrl)`
          // expression in openSocket() fails before `this.ws = ws`.
          super(url, protocols);
          throw boom;
        }
        super(url, protocols);
        capturedSockets.push(this);
      }
    } as unknown as typeof WebSocket;

    const client = new CollabRoomClient({
      roomId: ROOM_ID,
      baseUrl: 'http://localhost:8787',
      eventKey,
      presenceKey,
      adminKey: null,
      roomVerifier,
      adminVerifier: null,
      user: USER,
      webSocketImpl: WebSocketImpl,
      connectTimeoutMs: 2000,
      reconnect: { maxAttempts: 0 },
    });

    // First connect — constructor throws. Must reject quickly with the
    // underlying error, not sit until connectTimeoutMs.
    const start = Date.now();
    await expect(client.connect()).rejects.toThrow('WebSocket constructor exploded');
    expect(Date.now() - start).toBeLessThan(500);

    // State must be disconnected — not stuck in 'connecting'.
    expect(client.getState().connectionStatus).toBe('disconnected');

    // A subsequent connect() must NOT be trapped behind stale pendingConnect
    // state. Drive it to full auth to prove end-to-end that the pending state
    // was cleaned up.
    const secondConnect = client.connect();
    await waitFor(() => capturedSockets.length === 1, 1000);
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));

    const ws = capturedSockets[0];
    ws.peer.sendFromServer(JSON.stringify(makeAuthChallenge()));
    await ws.peer.expectFromClient();
    ws.peer.sendFromServer(JSON.stringify({
      type: 'auth.accepted',
      seq: 0, snapshotSeq: 0, snapshotAvailable: false,
    }));
    await secondConnect;
    expect(client.getState().connectionStatus).toBe('authenticated');
    client.disconnect();
  });
});

describe('CollabRoomClient — outbound validation (P2)', () => {
  // Helper: a rejected outbound validation must not push a new message onto the
  // wire. setup() already drains the auth.response, so compare against baseline.
  const assertNoNewSend = (ws: MockWebSocket, sentBefore: number) => {
    expect(ws.peer.sent.length).toBe(sentBefore);
  };

  test('sendAnnotationAdd rejects annotation with images before encryption/send', async () => {
    const { client, ws } = await setup();
    const sentBefore = ws.peer.sent.length;
    const bad = {
      id: 'bad-1',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT' as const, originalText: 'x', createdA: 1,
      // images is forbidden in V1 RoomAnnotation
      images: [{ path: '/tmp/x', name: 'x.png' }],
    } as unknown as RoomAnnotation;
    await expect(client.sendAnnotationAdd([bad])).rejects.toThrow(InvalidOutboundPayloadError);
    assertNoNewSend(ws, sentBefore);
    client.disconnect();
  });

  test('sendAnnotationAdd rejects annotation with null id before send', async () => {
    const { client, ws } = await setup();
    const sentBefore = ws.peer.sent.length;
    const bad = {
      id: null,
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
    } as unknown as RoomAnnotation;
    await expect(client.sendAnnotationAdd([bad])).rejects.toThrow(InvalidOutboundPayloadError);
    assertNoNewSend(ws, sentBefore);
    client.disconnect();
  });

  test('sendAnnotationUpdate rejects patch that tries to mutate id', async () => {
    const { client, ws } = await setup();
    const sentBefore = ws.peer.sent.length;
    await expect(
      client.sendAnnotationUpdate('some-id', { id: 'hijacked' } as Partial<RoomAnnotation>),
    ).rejects.toThrow(InvalidOutboundPayloadError);
    assertNoNewSend(ws, sentBefore);
    client.disconnect();
  });

  test('sendAnnotationRemove rejects non-string / empty ids', async () => {
    const { client, ws } = await setup();
    const sentBefore = ws.peer.sent.length;
    await expect(
      client.sendAnnotationRemove(['valid-id', ''] as string[]),
    ).rejects.toThrow(InvalidOutboundPayloadError);
    assertNoNewSend(ws, sentBefore);
    client.disconnect();
  });

  test('sendPresence rejects non-finite cursor coordinates', async () => {
    const { client, ws } = await setup();
    const sentBefore = ws.peer.sent.length;
    const bad = {
      user: { id: 'u', name: 'a', color: '#f00' },
      cursor: { x: Infinity, y: 0, coordinateSpace: 'document' as const },
    };
    await expect(client.sendPresence(bad as never)).rejects.toThrow(InvalidOutboundPayloadError);
    assertNoNewSend(ws, sentBefore);
    client.disconnect();
  });

});

describe('createRoom — success body is not parsed (P2)', () => {
  test('resolves after 201 even when the response body is malformed JSON', async () => {
    // Adversarial body covers the empty-body case too: createRoom must
    // never attempt to parse the success body, regardless of content.
    const { createRoom } = await import('./create-room');
    const goodSnapshot = {
      versionId: 'v1' as const,
      planMarkdown: '# Plan',
      annotations: [],
    };
    const fakeFetch: typeof fetch = async () => new Response('not-json{{{', { status: 201 });

    const result = await createRoom({
      baseUrl: 'http://localhost:8787',
      initialSnapshot: goodSnapshot,
      user: USER,
      fetchImpl: fakeFetch,
    });

    expect(result.roomId).toBeTruthy();
    expect(result.roomSecret).toBeTruthy();
    expect(result.adminSecret).toBeTruthy();
    expect(result.joinUrl).toContain(result.roomId);
    expect(result.adminUrl).toContain(result.roomId);
    expect(result.client).toBeDefined();
  });
});

describe('createRoom — outbound validation (P2)', () => {
  test('rejects malformed initialSnapshot before any fetch', async () => {
    const { createRoom } = await import('./create-room');
    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };
    const bad = { versionId: 'v99', planMarkdown: 'x', annotations: [] } as unknown as RoomSnapshot;
    await expect(createRoom({
      baseUrl: 'http://localhost:8787',
      initialSnapshot: bad,
      user: USER,
      fetchImpl: fakeFetch,
    })).rejects.toThrow(InvalidOutboundPayloadError);
    expect(fetchCalls).toBe(0);
  });

  test('rejects initialSnapshot containing malformed annotation', async () => {
    const { createRoom } = await import('./create-room');
    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };
    const badAnn = {
      id: 'x', blockId: 'b', startOffset: 0, endOffset: 0,
      type: 'INVALID_TYPE', originalText: 'x', createdA: 1,
    };
    const bad = {
      versionId: 'v1', planMarkdown: '', annotations: [badAnn],
    } as unknown as RoomSnapshot;
    await expect(createRoom({
      baseUrl: 'http://localhost:8787',
      initialSnapshot: bad,
      user: USER,
      fetchImpl: fakeFetch,
    })).rejects.toThrow(InvalidOutboundPayloadError);
    expect(fetchCalls).toBe(0);
  });
});

describe('CollabRoomClient — runAdminCommand send() failure (P3)', () => {
  test('synchronous send throw clears pendingAdmin; subsequent admin command works', async () => {
    const { client, ws } = await setup({ withAdmin: true });

    const sendMock = ws.send.bind(ws);
    let shouldThrow = true;
    ws.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
      if (shouldThrow) { shouldThrow = false; throw new Error('simulated admin send failure'); }
      return sendMock(data);
    };

    await expect(client.deleteRoom()).rejects.toThrow('simulated admin send failure');

    // pendingAdmin should be cleared — a fresh command must not report "Another admin command is pending".
    // Drive a full successful delete now.
    const deletePromise = client.deleteRoom();
    await ws.peer.expectFromClient();  // admin.challenge.request

    const adminChallenge: AdminChallenge = {
      type: 'admin.challenge',
      challengeId: generateChallengeId(),
      nonce: generateNonce(),
      expiresAt: Date.now() + 30_000,
    };
    ws.peer.sendFromServer(JSON.stringify(adminChallenge));
    await ws.peer.expectFromClient();  // admin.command
    ws.peer.simulateClose(4006, 'Room unavailable');
    await deletePromise;
  });
});

describe('CollabRoomClient — socket-generation guards drop stale queued messages', () => {
  // These tests simulate a reconnect that rolls the socket while a queued
  // snapshot or event is mid-flight. The guard check (gen !== socketGeneration)
  // must cause the queued handler to return without mutating state. We bump
  // socketGeneration synchronously between enqueue and queue drain to simulate
  // a rotation deterministically — the natural race is hard to pin to a single
  // microtask boundary, but the guard is the same code path either way.

  test('queued room.event from retired socket does not mutate state after generation advances', async () => {
    const { client, ws, eventKey } = await setup();

    // Sanity: baseline is empty at seq=0.
    expect(client.getState().annotations.length).toBe(0);
    expect(client.getState().seq).toBe(0);

    // Inject a valid annotation.add room.event — handleSocketMessage enqueues
    // handleRoomEvent with the CURRENT socketGeneration captured.
    const ann: RoomAnnotation = {
      id: 'stale-ev-1',
      blockId: 'b1', startOffset: 0, endOffset: 5,
      type: 'COMMENT', originalText: 'x', createdA: 1,
      startMeta: { parentTagName: 'p', parentIndex: 0, textOffset: 0 },
    };
    const cipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [ann] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'a1', channel: 'event', ciphertext: cipher },
    }));

    // Synchronously simulate a socket rotation: bump the generation counter
    // before the queued handler's microtask runs. The next time the handler
    // compares `gen !== this.socketGeneration`, it must short-circuit.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).socketGeneration = (client as any).socketGeneration + 1;

    // Drain the message queue.
    await new Promise(r => setTimeout(r, 20));

    // State must be untouched — no annotation applied, seq not advanced.
    expect(client.getState().annotations.length).toBe(0);
    expect(client.getState().seq).toBe(0);
    // lastError should not be a decrypt/shape error either — the handler
    // short-circuited entirely.
    expect(client.getState().lastError).toBeNull();

    // After the stale drop, the newer socket must still accept valid events.
    // Restore the counter so the next message's captured gen matches.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).socketGeneration = (client as any).socketGeneration - 1;
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'a2', channel: 'event', ciphertext: cipher },
    }));
    await new Promise(r => setTimeout(r, 20));
    expect(client.getState().annotations.length).toBe(1);
    expect(client.getState().seq).toBe(1);

    client.disconnect();
  });

  test('queued room.snapshot from retired socket does not replace baseline after generation advances', async () => {
    const { client, ws, eventKey } = await setup();

    // Seed a single annotation so we can detect unwanted baseline replacement.
    const seedAnn: RoomAnnotation = {
      id: 'seed-ann', blockId: 'b1', startOffset: 0, endOffset: 3,
      type: 'COMMENT', originalText: 'seed', createdA: 1,
      startMeta: { parentTagName: 'p', parentIndex: 0, textOffset: 0 },
    };
    const seedCipher = await encryptEventOp(eventKey, { type: 'annotation.add', annotations: [seedAnn] });
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.event', seq: 1, receivedAt: Date.now(),
      envelope: { clientId: 'other', opId: 'seed', channel: 'event', ciphertext: seedCipher },
    }));
    await new Promise(r => setTimeout(r, 20));
    expect(client.getState().annotations.length).toBe(1);
    expect(client.getState().seq).toBe(1);

    // Queue a stale snapshot that WOULD wipe the seed annotation and rewind seq
    // to 0 if it applied. The generation guard must drop it.
    const staleSnapshot: RoomSnapshot = { versionId: 'v-stale', planMarkdown: '# stale', annotations: [] };
    const staleCipher = await encryptSnapshot(eventKey, staleSnapshot);
    ws.peer.sendFromServer(JSON.stringify({
      type: 'room.snapshot', snapshotSeq: 0, snapshotCiphertext: staleCipher,
    }));

    // Synchronously advance the generation before the queued decrypt task runs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).socketGeneration = (client as any).socketGeneration + 1;

    await new Promise(r => setTimeout(r, 20));

    // Baseline untouched: annotation still present, seq still 1.
    expect(client.getState().annotations.length).toBe(1);
    expect(client.getState().annotations[0].id).toBe('seed-ann');
    expect(client.getState().seq).toBe(1);
    expect(client.getState().planMarkdown).toBe('# Plan');  // unchanged from setup()
    // No snapshot-decrypt error surfaced on the newer socket.
    expect(client.getState().lastError).toBeNull();

    client.disconnect();
  });
});
