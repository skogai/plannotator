import { describe, expect, test } from 'bun:test';
import {
  validateCreateRoomRequest,
  isValidationError,
  clampExpiryDays,
  hasRoomExpired,
  isRoomId,
  validateServerEnvelope,
  validateAdminCommandEnvelope,
} from './validation';

describe('validateCreateRoomRequest', () => {
  // 22-char base64url room ID (matches generateRoomId() output: 16 random bytes)
  const validRoomId = 'ABCDEFGHIJKLMNOPQRSTUv';
  // 43-char base64url verifiers (matches HMAC-SHA-256 output: 32 bytes)
  const validVerifier = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';
  const validAdminVerifier = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
  const validBody = {
    roomId: validRoomId,
    roomVerifier: validVerifier,
    adminVerifier: validAdminVerifier,
    initialSnapshotCiphertext: 'encrypted-snapshot-data',
  };

  test('accepts valid request', () => {
    const result = validateCreateRoomRequest(validBody);
    expect(isValidationError(result)).toBe(false);
    if (!isValidationError(result)) {
      expect(result.roomId).toBe(validRoomId);
      expect(result.roomVerifier).toBe(validVerifier);
      expect(result.adminVerifier).toBe(validAdminVerifier);
      expect(result.initialSnapshotCiphertext).toBe('encrypted-snapshot-data');
    }
  });

  test('accepts request with expiresInDays', () => {
    const result = validateCreateRoomRequest({ ...validBody, expiresInDays: 7 });
    expect(isValidationError(result)).toBe(false);
    if (!isValidationError(result)) {
      expect(result.expiresInDays).toBe(7);
    }
  });

  test('rejects null body', () => {
    const result = validateCreateRoomRequest(null);
    expect(isValidationError(result)).toBe(true);
    if (isValidationError(result)) {
      expect(result.status).toBe(400);
    }
  });

  test('rejects non-object body', () => {
    const result = validateCreateRoomRequest('not an object');
    expect(isValidationError(result)).toBe(true);
  });

  test('rejects missing roomId', () => {
    const { roomId: _, ...body } = validBody;
    const result = validateCreateRoomRequest(body);
    expect(isValidationError(result)).toBe(true);
    if (isValidationError(result)) {
      expect(result.error).toContain('roomId');
    }
  });

  test('rejects empty roomId', () => {
    const result = validateCreateRoomRequest({ ...validBody, roomId: '' });
    expect(isValidationError(result)).toBe(true);
  });

  test('rejects missing roomVerifier', () => {
    const { roomVerifier: _, ...body } = validBody;
    const result = validateCreateRoomRequest(body);
    expect(isValidationError(result)).toBe(true);
    if (isValidationError(result)) {
      expect(result.error).toContain('roomVerifier');
    }
  });

  test('rejects missing adminVerifier', () => {
    const { adminVerifier: _, ...body } = validBody;
    const result = validateCreateRoomRequest(body);
    expect(isValidationError(result)).toBe(true);
    if (isValidationError(result)) {
      expect(result.error).toContain('adminVerifier');
    }
  });

  test('rejects malformed roomVerifier (wrong length)', () => {
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, roomVerifier: 'too-short' }))).toBe(true);
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, roomVerifier: 'a'.repeat(44) }))).toBe(true);
  });

  test('rejects malformed adminVerifier (wrong length)', () => {
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, adminVerifier: 'too-short' }))).toBe(true);
  });

  test('rejects verifier with invalid characters (exactly 43 chars, bad final char)', () => {
    // 26 + 16 + 1 = 43 chars, only the / is invalid
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, roomVerifier: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop/' }))).toBe(true);
  });

  test('rejects missing initialSnapshotCiphertext', () => {
    const { initialSnapshotCiphertext: _, ...body } = validBody;
    const result = validateCreateRoomRequest(body);
    expect(isValidationError(result)).toBe(true);
    if (isValidationError(result)) {
      expect(result.error).toContain('initialSnapshotCiphertext');
    }
  });

  test('rejects oversized initialSnapshotCiphertext', () => {
    const result = validateCreateRoomRequest({
      ...validBody,
      initialSnapshotCiphertext: 'x'.repeat(1_500_001),
    });
    expect(isValidationError(result)).toBe(true);
    if (isValidationError(result)) {
      expect(result.status).toBe(413);
    }
  });

  test('rejects roomId with invalid characters (exactly 22 chars, bad final char)', () => {
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, roomId: 'ABCDEFGHIJKLMNOPQRSTU/' }))).toBe(true);
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, roomId: 'ABCDEFGHIJKLMNOPQRSTU?' }))).toBe(true);
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, roomId: 'ABCDEFGHIJKLMNOPQRSTU ' }))).toBe(true);
  });

  test('rejects roomId that is not exactly 22 chars', () => {
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, roomId: 'ABCDEFGHIJKLMNOPQRSTUvW' }))).toBe(true); // 23 chars
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, roomId: 'ABCDEFGHIJKLMNOPQRSTu' }))).toBe(true); // 21 chars
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, roomId: 'short' }))).toBe(true);
  });

  test('accepts exactly 22 base64url chars', () => {
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, roomId: 'ABCDEFGHIJKLMNOPQRSTUv' }))).toBe(false);
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, roomId: 'abcdefghijklmnopqrstuv' }))).toBe(false);
    expect(isValidationError(validateCreateRoomRequest({ ...validBody, roomId: '0123456789_-ABCDEFGHIJ' }))).toBe(false);
  });
});

describe('clampExpiryDays', () => {
  test('defaults to 30', () => {
    expect(clampExpiryDays(undefined)).toBe(30);
  });

  test('0 means never (null)', () => {
    expect(clampExpiryDays(0)).toBe(null);
  });

  test('clamps negative to 1', () => {
    expect(clampExpiryDays(-5)).toBe(1);
  });

  test('clamps 100 to 30', () => {
    expect(clampExpiryDays(100)).toBe(30);
  });

  test('passes through valid value', () => {
    expect(clampExpiryDays(7)).toBe(7);
  });

  test('floors fractional days', () => {
    expect(clampExpiryDays(7.9)).toBe(7);
  });
});

describe('hasRoomExpired', () => {
  test('returns false before expiry', () => {
    expect(hasRoomExpired(2_000, 1_999)).toBe(false);
  });

  test('returns false at exact expiry timestamp', () => {
    expect(hasRoomExpired(2_000, 2_000)).toBe(false);
  });

  test('returns true after expiry', () => {
    expect(hasRoomExpired(2_000, 2_001)).toBe(true);
  });

  test('returns false when expiresAt is null (never)', () => {
    expect(hasRoomExpired(null)).toBe(false);
  });
});

describe('isRoomId', () => {
  test('accepts valid 22-char base64url ids', () => {
    expect(isRoomId('ABCDEFGHIJKLMNOPQRSTUv')).toBe(true);
    expect(isRoomId('abcdef_ghij-klmnopqrst')).toBe(true);
  });
  test('rejects wrong-length ids', () => {
    expect(isRoomId('short')).toBe(false);
    expect(isRoomId('A'.repeat(21))).toBe(false);
    expect(isRoomId('A'.repeat(23))).toBe(false);
  });
  test('rejects ids containing disallowed characters', () => {
    expect(isRoomId('A'.repeat(21) + '!')).toBe(false);
    expect(isRoomId('A'.repeat(21) + '/')).toBe(false);
    expect(isRoomId('A'.repeat(21) + '=')).toBe(false);
  });
  test('rejects non-string inputs', () => {
    expect(isRoomId(undefined)).toBe(false);
    expect(isRoomId(42 as unknown as string)).toBe(false);
    expect(isRoomId(null)).toBe(false);
  });
});

describe('validateAdminCommandEnvelope — strips extra fields (P2)', () => {
  const validBase = {
    type: 'admin.command',
    challengeId: 'cid',
    clientId: 'client',
    adminProof: 'proof',
  };
  test('room.delete strips extras from command', () => {
    const r = validateAdminCommandEnvelope({
      ...validBase,
      command: { type: 'room.delete', piggyback: 'value', extra: 'smuggled' },
    });
    expect(isValidationError(r)).toBe(false);
    if (!isValidationError(r)) {
      expect(r.command).toEqual({ type: 'room.delete' });
      expect(Object.keys(r.command)).toEqual(['type']);
    }
  });
  test('rejects unknown command type', () => {
    const r = validateAdminCommandEnvelope({
      ...validBase,
      command: { type: 'room.explode' },
    });
    expect(isValidationError(r)).toBe(true);
  });

  test('rejects overlong adminProof', () => {
    const r = validateAdminCommandEnvelope({
      ...validBase,
      adminProof: 'x'.repeat(129),
      command: { type: 'room.delete' },
    });
    expect(isValidationError(r)).toBe(true);
    if (isValidationError(r)) expect(r.error).toMatch(/adminProof/);
  });

  test('rejects overlong challengeId', () => {
    const r = validateAdminCommandEnvelope({
      ...validBase,
      challengeId: 'x'.repeat(65),
      command: { type: 'room.delete' },
    });
    expect(isValidationError(r)).toBe(true);
    if (isValidationError(r)) expect(r.error).toMatch(/challengeId/);
  });

  test('rejects overlong clientId', () => {
    const r = validateAdminCommandEnvelope({
      ...validBase,
      clientId: 'x'.repeat(65),
      command: { type: 'room.delete' },
    });
    expect(isValidationError(r)).toBe(true);
    if (isValidationError(r)) expect(r.error).toMatch(/clientId/);
  });
});

describe('validateServerEnvelope — length caps (P3)', () => {
  const validBase = {
    clientId: 'c123',
    opId: 'o123',
    channel: 'event' as const,
    ciphertext: 'abc',
  };
  test('accepts valid envelope', () => {
    const r = validateServerEnvelope({ ...validBase });
    expect(isValidationError(r)).toBe(false);
  });
  test('rejects opId over 64 chars (replay amplification surface)', () => {
    const r = validateServerEnvelope({ ...validBase, opId: 'x'.repeat(65) });
    expect(isValidationError(r)).toBe(true);
    if (isValidationError(r)) expect(r.error).toMatch(/opId/);
  });
  test('rejects clientId over 64 chars', () => {
    const r = validateServerEnvelope({ ...validBase, clientId: 'x'.repeat(65) });
    expect(isValidationError(r)).toBe(true);
    if (isValidationError(r)) expect(r.error).toMatch(/clientId/);
  });
});
