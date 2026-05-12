/**
 * Request body validation — pure functions, no Cloudflare APIs.
 * Fully testable with bun:test.
 */

import type { CreateRoomRequest, ServerEnvelope, AdminCommandEnvelope } from '@plannotator/shared/collab';

export interface ValidationError {
  error: string;
  status: number;
}

const MIN_EXPIRY_DAYS = 1;
const MAX_EXPIRY_DAYS = 30;
const DEFAULT_EXPIRY_DAYS = 30;
const MAX_SNAPSHOT_CIPHERTEXT_LENGTH = 1_500_000; // ~1.5 MB
const MAX_EVENT_CIPHERTEXT_LENGTH = 512_000; // ~512 KB per event
const MAX_PRESENCE_CIPHERTEXT_LENGTH = 8_192; // ~8 KB per presence update

/** Clamp expiry days to [1, 30], default 30. 0 means never. */
export function clampExpiryDays(days: number | undefined): number | null {
  if (days === undefined || days === null) return DEFAULT_EXPIRY_DAYS;
  if (days === 0) return null;
  return Math.max(MIN_EXPIRY_DAYS, Math.min(MAX_EXPIRY_DAYS, Math.floor(days)));
}

/** True when a room is beyond its fixed retention deadline. Never-expiring rooms return false. */
export function hasRoomExpired(expiresAt: number | null, now: number = Date.now()): boolean {
  if (expiresAt === null) return false;
  return now > expiresAt;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Room IDs are generated from 16 random bytes and base64url-encoded without padding.
 * That yields 22 URL-safe characters and 128 bits of entropy.
 */
const ROOM_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Runtime check for the roomId shape. Exported for use in WebSocket upgrade
 *  paths where invalid IDs must be rejected BEFORE idFromName/DO instantiation
 *  to avoid arbitrary DO names and storage reads on attacker-controlled input. */
export function isRoomId(s: unknown): s is string {
  return typeof s === 'string' && ROOM_ID_RE.test(s);
}

/**
 * HMAC-SHA-256 output is 32 bytes, which base64url-encodes to 43 chars without padding.
 * Verifiers must match this exact shape.
 */
const VERIFIER_RE = /^[A-Za-z0-9_-]{43}$/;

/** Validate a POST /api/rooms request body. */
export function validateCreateRoomRequest(
  body: unknown,
): CreateRoomRequest | ValidationError {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object', status: 400 };
  }

  const obj = body as Record<string, unknown>;

  if (!isNonEmptyString(obj.roomId)) {
    return { error: 'Missing or empty "roomId"', status: 400 };
  }

  if (!ROOM_ID_RE.test(obj.roomId)) {
    return { error: '"roomId" must be exactly 22 base64url characters', status: 400 };
  }

  if (!isNonEmptyString(obj.roomVerifier) || !VERIFIER_RE.test(obj.roomVerifier)) {
    return { error: '"roomVerifier" must be a 43-char base64url HMAC-SHA-256 verifier', status: 400 };
  }

  if (!isNonEmptyString(obj.adminVerifier) || !VERIFIER_RE.test(obj.adminVerifier)) {
    return { error: '"adminVerifier" must be a 43-char base64url HMAC-SHA-256 verifier', status: 400 };
  }

  if (!isNonEmptyString(obj.initialSnapshotCiphertext)) {
    return { error: 'Missing or empty "initialSnapshotCiphertext"', status: 400 };
  }

  if (obj.initialSnapshotCiphertext.length > MAX_SNAPSHOT_CIPHERTEXT_LENGTH) {
    return { error: `"initialSnapshotCiphertext" exceeds max size (${Math.round(MAX_SNAPSHOT_CIPHERTEXT_LENGTH / 1024)} KB)`, status: 413 };
  }

  return {
    roomId: obj.roomId,
    roomVerifier: obj.roomVerifier,
    adminVerifier: obj.adminVerifier,
    initialSnapshotCiphertext: obj.initialSnapshotCiphertext,
    expiresInDays: typeof obj.expiresInDays === 'number' ? obj.expiresInDays : undefined,
  };
}

/** Type guard: is the result a ValidationError? Works with any validated union. */
export function isValidationError<T>(result: T | ValidationError): result is ValidationError {
  return typeof result === 'object' && result !== null && 'error' in result;
}

// ---------------------------------------------------------------------------
// Post-Auth Message Validation
// ---------------------------------------------------------------------------

const VALID_CHANNELS = new Set(['event', 'presence']);
const VALID_ADMIN_COMMANDS = new Set(['room.delete']);

/**
 * Max opId length on inbound event-channel envelopes. opId is stored DURABLY
 * inside sequenced envelopes, so an authenticated participant could otherwise
 * bloat replay bandwidth/storage by sending oversized opIds. generateOpId()
 * produces 22-char base64url values (128 bits); 64 gives comfortable headroom
 * without enabling amplification.
 */
const MAX_OP_ID_LENGTH = 64;
/**
 * Max clientId length. Server overrides envelope.clientId with the
 * authenticated meta.clientId before persistence, but we still cap inbound
 * values to keep validation symmetric and avoid storing oversized strings
 * if the override is ever removed.
 */
const MAX_CLIENT_ID_LENGTH = 64;

/**
 * Max adminProof length. HMAC-SHA-256 base64url-encodes to 43 chars; the
 * generous cap guards against pathological input without rejecting any
 * legitimate client. Prevents an authenticated peer from spamming
 * oversized proof strings to blow up verification cost / log volume.
 */
const MAX_ADMIN_PROOF_LENGTH = 128;

/** Max challengeId length. generateChallengeId() produces 16-byte base64url
 *  (22 chars); the cap leaves generous headroom without legitimizing abuse. */
const MAX_CHALLENGE_ID_LENGTH = 64;

/** Validate a ServerEnvelope from an authenticated WebSocket message. */
export function validateServerEnvelope(
  msg: Record<string, unknown>,
): ServerEnvelope | ValidationError {
  if (!isNonEmptyString(msg.clientId)) {
    return { error: 'Missing or empty "clientId"', status: 400 };
  }
  if (msg.clientId.length > MAX_CLIENT_ID_LENGTH) {
    return { error: `"clientId" exceeds max length ${MAX_CLIENT_ID_LENGTH}`, status: 400 };
  }
  if (!isNonEmptyString(msg.opId)) {
    return { error: 'Missing or empty "opId"', status: 400 };
  }
  if (msg.opId.length > MAX_OP_ID_LENGTH) {
    return { error: `"opId" exceeds max length ${MAX_OP_ID_LENGTH}`, status: 400 };
  }
  if (!isNonEmptyString(msg.channel) || !VALID_CHANNELS.has(msg.channel)) {
    return { error: '"channel" must be "event" or "presence"', status: 400 };
  }
  if (!isNonEmptyString(msg.ciphertext)) {
    return { error: 'Missing or empty "ciphertext"', status: 400 };
  }

  const maxSize = msg.channel === 'presence'
    ? MAX_PRESENCE_CIPHERTEXT_LENGTH
    : MAX_EVENT_CIPHERTEXT_LENGTH;
  if (msg.ciphertext.length > maxSize) {
    return { error: `Ciphertext exceeds max size for ${msg.channel} (${Math.round(maxSize / 1024)} KB)`, status: 413 };
  }

  return {
    clientId: msg.clientId,
    opId: msg.opId,
    channel: msg.channel as 'event' | 'presence',
    ciphertext: msg.ciphertext,
  };
}

/** Validate an AdminCommandEnvelope from an authenticated WebSocket message. */
export function validateAdminCommandEnvelope(
  msg: Record<string, unknown>,
): AdminCommandEnvelope | ValidationError {
  if (!isNonEmptyString(msg.challengeId)) {
    return { error: 'Missing or empty "challengeId"', status: 400 };
  }
  // Cap string inputs that flow into proof verification and command dispatch.
  // Prevents an authenticated peer from spamming oversized identifiers that
  // would otherwise hit canonicalJson / log volume on every admin attempt.
  if (msg.challengeId.length > MAX_CHALLENGE_ID_LENGTH) {
    return { error: `"challengeId" exceeds max length ${MAX_CHALLENGE_ID_LENGTH}`, status: 400 };
  }
  if (!isNonEmptyString(msg.clientId)) {
    return { error: 'Missing or empty "clientId"', status: 400 };
  }
  if (msg.clientId.length > MAX_CLIENT_ID_LENGTH) {
    return { error: `"clientId" exceeds max length ${MAX_CLIENT_ID_LENGTH}`, status: 400 };
  }
  if (!isNonEmptyString(msg.adminProof)) {
    return { error: 'Missing or empty "adminProof"', status: 400 };
  }
  if (msg.adminProof.length > MAX_ADMIN_PROOF_LENGTH) {
    return { error: `"adminProof" exceeds max length ${MAX_ADMIN_PROOF_LENGTH}`, status: 400 };
  }

  if (!msg.command || typeof msg.command !== 'object') {
    return { error: 'Missing or invalid "command"', status: 400 };
  }

  const cmd = msg.command as Record<string, unknown>;
  if (!isNonEmptyString(cmd.type) || !VALID_ADMIN_COMMANDS.has(cmd.type)) {
    return { error: `Unknown command type: ${String(cmd.type)}`, status: 400 };
  }

  // Build a SANITIZED command with exactly the expected fields. Extra fields
  // on the inbound payload are dropped. This is defense-in-depth:
  // - The admin proof is computed over canonicalJson(command), so if a client
  //   smuggles extra fields into the payload, their proof is bound to
  //   `canonicalJson(dirty)` while the server's re-verification will be
  //   computed over `canonicalJson(sanitized)` — proof verification fails.
  //   Honest clients serialize clean commands and their proofs verify.
  // - Downstream code (logging, storage, proof recomputation) only ever sees
  //   the narrow shape its type says it does.
  // The type gate above (VALID_ADMIN_COMMANDS.has(cmd.type)) already
  // restricts cmd.type to the single valid value. If a future admin
  // command is added, expand the Set AND split the sanitization below
  // into per-type branches at the same time.
  const sanitizedCommand: AdminCommandEnvelope['command'] = { type: 'room.delete' };

  return {
    type: 'admin.command',
    challengeId: msg.challengeId,
    clientId: msg.clientId,
    command: sanitizedCommand,
    adminProof: msg.adminProof,
  };
}
