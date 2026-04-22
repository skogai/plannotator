/**
 * Plannotator Live Rooms — cryptographic primitives.
 *
 * HKDF key derivation, HMAC verifier/proof generation, and AES-256-GCM
 * encrypt/decrypt for event, presence, and snapshot channels.
 *
 * Uses only Web Crypto API (crypto.subtle) — works in browsers, Bun,
 * and Cloudflare Workers.
 *
 * Protocol decisions:
 * - HKDF uses SHA-256 with a zero-filled 32-byte salt (standard when
 *   no application-specific salt is provided).
 * - HMAC input concatenation uses null byte (\0) separators between
 *   components to prevent ambiguity.
 * - AES-GCM uses a 12-byte random IV prepended to ciphertext.
 */

import { bytesToBase64url, base64urlToBytes } from './encoding';
import { canonicalJson } from './canonical-json';
import { ADMIN_SECRET_LENGTH_BYTES, ROOM_SECRET_LENGTH_BYTES } from './constants';
import type { AdminCommand, PresenceState, RoomEventClientOp, RoomSnapshot } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HKDF_SALT = new Uint8Array(32); // zero-filled, per protocol spec
const IV_LENGTH = 12;

const LABELS = {
  auth: 'plannotator:v1:room-auth',
  event: 'plannotator:v1:event',
  presence: 'plannotator:v1:presence',
  admin: 'plannotator:v1:room-admin',
  roomVerifier: 'plannotator:v1:room-verifier:',
  adminVerifier: 'plannotator:v1:admin-verifier:',
  authProof: 'plannotator:v1:auth-proof',
  adminProof: 'plannotator:v1:admin-proof',
} as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Copy a Uint8Array view into an exact ArrayBuffer for Web Crypto APIs. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Import raw secret bytes as HKDF key material. */
async function importKeyMaterial(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(secret), 'HKDF', false, ['deriveKey']);
}

/** Derive an HMAC-SHA-256 key via HKDF. */
async function deriveHmacKey(material: CryptoKey, info: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: encoder.encode(info) },
    material,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Derive an AES-256-GCM key via HKDF. */
async function deriveAesKey(material: CryptoKey, info: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: encoder.encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Concatenate string components with null byte separators.
 * Returns UTF-8 encoded bytes for HMAC input.
 */
function concatComponents(...components: string[]): Uint8Array {
  return encoder.encode(components.join('\0'));
}

/** Import a base64url-encoded verifier as an HMAC signing key. */
async function importVerifierAsKey(verifierB64: string): Promise<CryptoKey> {
  const bytes = base64urlToBytes(verifierB64);
  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(bytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** HMAC-SHA-256 sign and return base64url. */
async function hmacSign(key: CryptoKey, data: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', key, toArrayBuffer(data));
  return bytesToBase64url(new Uint8Array(sig));
}

/** HMAC-SHA-256 verify. */
async function hmacVerify(key: CryptoKey, data: Uint8Array, signature: string): Promise<boolean> {
  const sigBytes = base64urlToBytes(signature);
  return crypto.subtle.verify('HMAC', key, toArrayBuffer(sigBytes), toArrayBuffer(data));
}

// ---------------------------------------------------------------------------
// Key Derivation
// ---------------------------------------------------------------------------

/** Derive all room keys from a room secret. */
export async function deriveRoomKeys(roomSecret: Uint8Array): Promise<{
  authKey: CryptoKey;
  eventKey: CryptoKey;
  presenceKey: CryptoKey;
}> {
  if (roomSecret.length !== ROOM_SECRET_LENGTH_BYTES) {
    throw new Error(`Invalid room secret: expected ${ROOM_SECRET_LENGTH_BYTES} bytes`);
  }
  const material = await importKeyMaterial(roomSecret);
  const [authKey, eventKey, presenceKey] = await Promise.all([
    deriveHmacKey(material, LABELS.auth),
    deriveAesKey(material, LABELS.event),
    deriveAesKey(material, LABELS.presence),
  ]);
  return { authKey, eventKey, presenceKey };
}

/** Derive the admin HMAC key from an admin secret. */
export async function deriveAdminKey(adminSecret: Uint8Array): Promise<CryptoKey> {
  if (adminSecret.length !== ADMIN_SECRET_LENGTH_BYTES) {
    throw new Error(`Invalid admin secret: expected ${ADMIN_SECRET_LENGTH_BYTES} bytes`);
  }
  const material = await importKeyMaterial(adminSecret);
  return deriveHmacKey(material, LABELS.admin);
}

// ---------------------------------------------------------------------------
// Verifiers
// ---------------------------------------------------------------------------

/** Compute roomVerifier = HMAC(authKey, "plannotator:v1:room-verifier:" \0 roomId) */
export async function computeRoomVerifier(authKey: CryptoKey, roomId: string): Promise<string> {
  return hmacSign(authKey, concatComponents(LABELS.roomVerifier, roomId));
}

/** Compute adminVerifier = HMAC(adminKey, "plannotator:v1:admin-verifier:" \0 roomId) */
export async function computeAdminVerifier(adminKey: CryptoKey, roomId: string): Promise<string> {
  return hmacSign(adminKey, concatComponents(LABELS.adminVerifier, roomId));
}

// ---------------------------------------------------------------------------
// Auth Proofs
// ---------------------------------------------------------------------------

/** Compute auth proof for WebSocket connection. */
export async function computeAuthProof(
  roomVerifier: string,
  roomId: string,
  clientId: string,
  challengeId: string,
  nonce: string,
): Promise<string> {
  const key = await importVerifierAsKey(roomVerifier);
  return hmacSign(key, concatComponents(LABELS.authProof, roomId, clientId, challengeId, nonce));
}

/** Verify an auth proof against the stored room verifier. */
export async function verifyAuthProof(
  roomVerifier: string,
  roomId: string,
  clientId: string,
  challengeId: string,
  nonce: string,
  proof: string,
): Promise<boolean> {
  try {
    const key = await importVerifierAsKey(roomVerifier);
    return await hmacVerify(key, concatComponents(LABELS.authProof, roomId, clientId, challengeId, nonce), proof);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Admin Proofs
// ---------------------------------------------------------------------------

/** Compute admin proof for an admin command. */
export async function computeAdminProof(
  adminVerifier: string,
  roomId: string,
  clientId: string,
  challengeId: string,
  nonce: string,
  command: AdminCommand,
): Promise<string> {
  const key = await importVerifierAsKey(adminVerifier);
  const data = concatComponents(
    LABELS.adminProof, roomId, clientId, challengeId, nonce, canonicalJson(command),
  );
  return hmacSign(key, data);
}

/** Verify an admin command proof. */
export async function verifyAdminProof(
  adminVerifier: string,
  roomId: string,
  clientId: string,
  challengeId: string,
  nonce: string,
  command: AdminCommand,
  proof: string,
): Promise<boolean> {
  try {
    const key = await importVerifierAsKey(adminVerifier);
    const data = concatComponents(
      LABELS.adminProof, roomId, clientId, challengeId, nonce, canonicalJson(command),
    );
    return await hmacVerify(key, data, proof);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// AES-256-GCM Encrypt / Decrypt
// ---------------------------------------------------------------------------

/** Encrypt plaintext with AES-256-GCM. Returns base64url(IV || ciphertext+tag). */
export async function encryptPayload(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return bytesToBase64url(combined);
}

/** Decrypt base64url(IV || ciphertext+tag) with AES-256-GCM. Returns plaintext string. */
export async function decryptPayload(key: CryptoKey, ciphertext: string): Promise<string> {
  const combined = base64urlToBytes(ciphertext);
  const iv = combined.slice(0, IV_LENGTH);
  const encrypted = combined.slice(IV_LENGTH);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted,
  );
  return decoder.decode(decrypted);
}

// ---------------------------------------------------------------------------
// Channel convenience wrappers
// ---------------------------------------------------------------------------

/** Encrypt a RoomEventClientOp for the event channel.
 *  Presence is intentionally NOT accepted here — the presence channel ships
 *  a raw PresenceState via encryptPresence(). */
export async function encryptEventOp(eventKey: CryptoKey, op: RoomEventClientOp): Promise<string> {
  return encryptPayload(eventKey, JSON.stringify(op));
}

/** Decrypt an event channel ciphertext. */
export async function decryptEventPayload(eventKey: CryptoKey, ciphertext: string): Promise<unknown> {
  const plaintext = await decryptPayload(eventKey, ciphertext);
  return JSON.parse(plaintext);
}

/** Encrypt a PresenceState for the presence channel. */
export async function encryptPresence(presenceKey: CryptoKey, presence: PresenceState): Promise<string> {
  return encryptPayload(presenceKey, JSON.stringify(presence));
}

/**
 * Decrypt a presence channel ciphertext. Returns `unknown` — encryption only
 * proves the sender had the presence key. Callers MUST validate the shape
 * (via isPresenceState) before entering state.
 */
export async function decryptPresence(presenceKey: CryptoKey, ciphertext: string): Promise<unknown> {
  const plaintext = await decryptPayload(presenceKey, ciphertext);
  return JSON.parse(plaintext);
}

/** Encrypt a RoomSnapshot with the event key. */
export async function encryptSnapshot(eventKey: CryptoKey, snapshot: RoomSnapshot): Promise<string> {
  return encryptPayload(eventKey, JSON.stringify(snapshot));
}

/**
 * Decrypt a snapshot ciphertext. Returns `unknown` — same reasoning as
 * decryptPresence. Callers MUST validate via isRoomSnapshot before use.
 */
export async function decryptSnapshot(eventKey: CryptoKey, ciphertext: string): Promise<unknown> {
  const plaintext = await decryptPayload(eventKey, ciphertext);
  return JSON.parse(plaintext);
}
