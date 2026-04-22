/**
 * Redaction-aware logging for the room service.
 *
 * Redacts proofs, verifiers, ciphertext, and message bodies from logs.
 */

const REDACTED_KEYS = new Set([
  'roomVerifier',
  'adminVerifier',
  'proof',
  'adminProof',
  'ciphertext',
  'initialSnapshotCiphertext',
  'snapshotCiphertext',
  'nonce',
]);

/** Shallow-clone an object, replacing sensitive field values with "[REDACTED]". */
export function redactForLog(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = REDACTED_KEYS.has(key) ? '[REDACTED]' : value;
  }
  return result;
}

/** Log with sensitive fields redacted. */
export function safeLog(label: string, obj: Record<string, unknown>): void {
  console.log(label, redactForLog(obj));
}
