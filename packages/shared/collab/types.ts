/**
 * Plannotator Live Rooms — canonical protocol types.
 *
 * RoomAnnotation is a structural copy of the Annotation type from
 * packages/ui/types.ts with the `images` field excluded (V1 rooms
 * do not support image attachments). If Annotation gains new fields,
 * they must be manually added here when they should be part of the
 * room protocol.
 *
 * RoomState is intentionally NOT defined here — it contains server-only
 * fields (roomVerifier, adminVerifier, event log) and belongs in
 * apps/room-service.
 */

// ---------------------------------------------------------------------------
// Room Annotation
// ---------------------------------------------------------------------------

/** Annotation type values matching AnnotationType enum in packages/ui/types.ts */
export type RoomAnnotationType = 'DELETION' | 'COMMENT' | 'GLOBAL_COMMENT';

/**
 * Room-safe annotation. Structurally matches Annotation from packages/ui/types.ts
 * minus the images field. V1 rooms do not support image attachments.
 */
export interface RoomAnnotation {
  id: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  type: RoomAnnotationType;
  text?: string;
  originalText: string;
  /**
   * Creation timestamp in ms. Field name intentionally mirrors the existing
   * UI `Annotation.createdA` (see `packages/ui/types.ts`). DO NOT rename —
   * existing UI code, existing annotations persisted to disk, and share-URL
   * payloads all use this exact key.
   */
  createdA: number;
  author?: string;
  source?: string;
  isQuickLabel?: boolean;
  quickLabelTip?: string;
  diffContext?: 'added' | 'removed' | 'modified';
  startMeta?: { parentTagName: string; parentIndex: number; textOffset: number };
  endMeta?: { parentTagName: string; parentIndex: number; textOffset: number };
  images?: never;
}

const ANNOTATION_META_KEYS = new Set(['parentTagName', 'parentIndex', 'textOffset']);
function isAnnotationMeta(x: unknown): boolean {
  if (x === null || typeof x !== 'object') return false;
  const m = x as Record<string, unknown>;
  // Strict boundary: reject unknown nested keys so the validator doesn't drift.
  for (const key of Object.keys(m)) {
    if (!ANNOTATION_META_KEYS.has(key)) return false;
  }
  return (
    typeof m.parentTagName === 'string' &&
    typeof m.parentIndex === 'number' && Number.isFinite(m.parentIndex) &&
    typeof m.textOffset === 'number' && Number.isFinite(m.textOffset)
  );
}

/**
 * Centralized per-field validators for RoomAnnotation. Both isRoomAnnotation
 * and isRoomAnnotationPatch delegate to this so field definitions don't drift
 * when annotation fields are added. Each entry returns true if the value is
 * acceptable for that field (either as a full-annotation required field or as
 * a patch override, depending on the caller).
 *
 * The `satisfies` constraint forces this map to cover every RoomAnnotation key
 * except `images` (which V1 rejects outright). Adding a new field to
 * RoomAnnotation without a matching validator here is a compile error.
 */
const ROOM_ANNOTATION_FIELD_VALIDATORS = {
  id: (v) => typeof v === 'string' && v.length > 0,
  blockId: (v) => typeof v === 'string',
  startOffset: (v) => typeof v === 'number' && Number.isFinite(v),
  endOffset: (v) => typeof v === 'number' && Number.isFinite(v),
  type: (v) => v === 'DELETION' || v === 'COMMENT' || v === 'GLOBAL_COMMENT',
  originalText: (v) => typeof v === 'string',
  createdA: (v) => typeof v === 'number' && Number.isFinite(v),
  text: (v) => typeof v === 'string',
  author: (v) => typeof v === 'string',
  source: (v) => typeof v === 'string',
  isQuickLabel: (v) => typeof v === 'boolean',
  quickLabelTip: (v) => typeof v === 'string',
  diffContext: (v) => v === 'added' || v === 'removed' || v === 'modified',
  startMeta: isAnnotationMeta,
  endMeta: isAnnotationMeta,
} satisfies Record<Exclude<keyof RoomAnnotation, 'images'>, (v: unknown) => boolean>;

const ROOM_ANNOTATION_KNOWN_FIELDS = new Set<string>([
  ...Object.keys(ROOM_ANNOTATION_FIELD_VALIDATORS),
  'images',  // known-but-forbidden
]);

const ROOM_ANNOTATION_REQUIRED_FIELDS = [
  'id', 'blockId', 'startOffset', 'endOffset', 'type', 'originalText', 'createdA',
] as const;

/** Fast membership check for optional-field iteration in isRoomAnnotation. */
const ROOM_ANNOTATION_REQUIRED_FIELD_SET = new Set<string>(ROOM_ANNOTATION_REQUIRED_FIELDS);

/**
 * Fields that are NOT accepted in an annotation.update patch. `id` is the
 * critical one: letting a patch replace the id lets a malicious sender store
 * an annotation under map key `old-id` whose object reports `id: "new-id"`.
 * Later removes/updates by the visible id would miss it. `images` is excluded
 * because V1 room annotations cannot carry images.
 */
const ROOM_ANNOTATION_PATCH_FORBIDDEN_FIELDS = new Set(['id', 'images']);

/**
 * Runtime validator for a decrypted RoomAnnotation. Encryption proves only
 * that the sender held the room key; payload shape is not proven. Any room
 * participant can encrypt arbitrary JSON, so annotations that are about to
 * enter client state must be shape-checked first. Without this, malformed
 * annotations can crash UI render paths that assume well-formed fields.
 */
export function isRoomAnnotation(x: unknown): x is RoomAnnotation {
  if (x === null || typeof x !== 'object') return false;
  const a = x as Record<string, unknown>;
  // Strict boundary: reject unknown keys. The validators are the contract —
  // anything outside ROOM_ANNOTATION_KNOWN_FIELDS would silently pass through
  // otherwise, defeating the purpose of the validation pass.
  for (const key of Object.keys(a)) {
    if (!ROOM_ANNOTATION_KNOWN_FIELDS.has(key)) return false;
  }
  // Single pass over the validator map: required fields must pass validation
  // regardless of value; optional fields only run validation when present.
  for (const [field, validate] of Object.entries(ROOM_ANNOTATION_FIELD_VALIDATORS)) {
    const required = ROOM_ANNOTATION_REQUIRED_FIELD_SET.has(field);
    if (required) {
      if (!validate(a[field])) return false;
    } else if (a[field] !== undefined) {
      if (!validate(a[field])) return false;
    }
  }
  // Cross-field invariant: inline annotations (COMMENT, DELETION) must have a
  // non-empty blockId — they attach to a block in the rendered plan. Only
  // GLOBAL_COMMENT is allowed to carry blockId: '' (it's a top-level comment
  // with no block anchor, matching the existing UI convention).
  if ((a.type === 'COMMENT' || a.type === 'DELETION') && (a.blockId as string).length === 0) {
    return false;
  }
  // images must be absent in V1 room annotations
  if ('images' in a && a.images !== undefined) return false;
  return true;
}

/**
 * Runtime validator for a partial RoomAnnotation patch (annotation.update).
 * Allows any subset of fields but each present field must be well-typed.
 * Forbids mutating required fields into invalid values (e.g. type=null) and
 * forbids the `id` and `images` fields entirely (see
 * ROOM_ANNOTATION_PATCH_FORBIDDEN_FIELDS for rationale).
 */
export function isRoomAnnotationPatch(x: unknown): x is Partial<RoomAnnotation> {
  if (x === null || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  // Strict boundary: reject unknown keys. Patches must not smuggle in
  // fields the type doesn't know about.
  for (const key of Object.keys(p)) {
    if (!ROOM_ANNOTATION_KNOWN_FIELDS.has(key)) return false;
  }
  for (const forbidden of ROOM_ANNOTATION_PATCH_FORBIDDEN_FIELDS) {
    if (forbidden in p && p[forbidden] !== undefined) return false;
  }
  // Reject effectively-empty patches. A patch with no allowed/defined fields
  // (including `{}` and `{ text: undefined }`) would burn a durable seq for
  // a guaranteed no-op when sent — avoidable log noise with no effect.
  let hasDefinedAllowedField = false;
  for (const [field, validate] of Object.entries(ROOM_ANNOTATION_FIELD_VALIDATORS)) {
    if (ROOM_ANNOTATION_PATCH_FORBIDDEN_FIELDS.has(field)) continue;
    if (p[field] === undefined) continue;
    if (!validate(p[field])) return false;
    hasDefinedAllowedField = true;
  }
  if (!hasDefinedAllowedField) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export interface CursorState {
  blockId?: string;
  x: number;
  y: number;
  coordinateSpace: 'block' | 'document' | 'viewport';
}

export interface PresenceState {
  user: { id: string; name: string; color: string };
  cursor: CursorState | null;
  activeAnnotationId?: string | null;
  idle?: boolean;
}

/**
 * Runtime validator for decrypted PresenceState. Encryption only proves the
 * sender holds the room key; it does not prove payload shape. Without this,
 * a malicious participant could ship a valid-encrypted but malformed presence
 * and crash UI render code that assumes `user.name` is a string, etc.
 */
const PRESENCE_STATE_KEYS = new Set(['user', 'cursor', 'activeAnnotationId', 'idle']);
const PRESENCE_USER_KEYS = new Set(['id', 'name', 'color']);
const CURSOR_STATE_KEYS = new Set(['blockId', 'x', 'y', 'coordinateSpace']);

export function isPresenceState(x: unknown): x is PresenceState {
  if (x === null || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;

  // Required-field intent made explicit (previously relied on subsequent
  // typeof checks to reject missing fields via undefined).
  if (!('user' in p) || !('cursor' in p)) return false;

  // Strict boundary: reject unknown top-level keys.
  for (const key of Object.keys(p)) {
    if (!PRESENCE_STATE_KEYS.has(key)) return false;
  }

  const user = p.user;
  if (user === null || typeof user !== 'object') return false;
  const u = user as Record<string, unknown>;
  for (const key of Object.keys(u)) {
    if (!PRESENCE_USER_KEYS.has(key)) return false;
  }
  if (typeof u.id !== 'string' || typeof u.name !== 'string' || typeof u.color !== 'string') return false;

  // cursor: null OR CursorState
  if (p.cursor !== null) {
    if (p.cursor === undefined || typeof p.cursor !== 'object') return false;
    const c = p.cursor as Record<string, unknown>;
    for (const key of Object.keys(c)) {
      if (!CURSOR_STATE_KEYS.has(key)) return false;
    }
    // Require finite coordinates — JSON can encode Infinity/NaN via non-standard
    // parsers or adversarial payloads, and non-finite cursors would corrupt
    // remote-cursor rendering math downstream.
    if (typeof c.x !== 'number' || !Number.isFinite(c.x)) return false;
    if (typeof c.y !== 'number' || !Number.isFinite(c.y)) return false;
    if (c.coordinateSpace !== 'block' && c.coordinateSpace !== 'document' && c.coordinateSpace !== 'viewport') return false;
    if (c.blockId !== undefined && typeof c.blockId !== 'string') return false;
  }

  if (p.activeAnnotationId !== undefined && p.activeAnnotationId !== null && typeof p.activeAnnotationId !== 'string') return false;
  if (p.idle !== undefined && typeof p.idle !== 'boolean') return false;

  return true;
}

// ---------------------------------------------------------------------------
// Server Envelope
// ---------------------------------------------------------------------------

/**
 * Server-visible message wrapper. The DO can read clientId, opId, and channel
 * but cannot read the encrypted ciphertext.
 *
 * clientId is random per WebSocket connection — not a stable user identity.
 * Stable identity lives inside the encrypted PresenceState.user.id.
 */
export interface ServerEnvelope {
  clientId: string;
  opId: string;
  channel: 'event' | 'presence';
  ciphertext: string;
}

// ---------------------------------------------------------------------------
// Client Operations (encrypted inside envelope ciphertext)
//
// Event channel payloads are annotation ops only. Presence is encrypted as a
// raw PresenceState on the presence channel (the wire envelope's `channel`
// field already discriminates). Keeping presence OUT of the event-channel
// type and validator prevents clients from writing durable no-op presence
// events into the sequenced event log.
// ---------------------------------------------------------------------------

/** Ops valid on the event channel. */
export type RoomEventClientOp =
  | { type: 'annotation.add'; annotations: RoomAnnotation[] }
  | { type: 'annotation.update'; id: string; patch: Partial<RoomAnnotation> }
  | { type: 'annotation.remove'; ids: string[] }
  | { type: 'annotation.clear'; source?: string };

/**
 * Superset union retained for protocol-level typing and tests that want one
 * client-op union. Runtime event-channel code uses RoomEventClientOp; presence
 * is sent as raw PresenceState on the presence channel.
 */
export type RoomClientOp =
  | RoomEventClientOp
  | { type: 'presence.update'; presence: PresenceState };

/**
 * Runtime validator for a decrypted EVENT-channel op. Does NOT accept
 * presence.update — presence ops flow through the presence channel with a
 * raw PresenceState payload validated by isPresenceState.
 */
export function isRoomEventClientOp(x: unknown): x is RoomEventClientOp {
  if (x === null || typeof x !== 'object') return false;
  const op = x as Record<string, unknown>;
  switch (op.type) {
    case 'annotation.add':
      // Empty-array adds would burn a durable seq for a no-op; reject.
      return (
        Array.isArray(op.annotations) &&
        op.annotations.length > 0 &&
        op.annotations.every(isRoomAnnotation)
      );
    case 'annotation.update':
      return (
        typeof op.id === 'string' && op.id.length > 0 &&
        isRoomAnnotationPatch(op.patch)
      );
    case 'annotation.remove':
      // Empty-array removes would burn a durable seq for a no-op; reject.
      return (
        Array.isArray(op.ids) &&
        op.ids.length > 0 &&
        op.ids.every((id: unknown) => typeof id === 'string' && id.length > 0)
      );
    case 'annotation.clear':
      return op.source === undefined || typeof op.source === 'string';
    default:
      return false;
  }
}

/**
 * Superset validator — accepts event-channel ops OR presence.update. Not
 * currently used by the runtime (outbound mutation methods validate event
 * ops via isRoomEventClientOp, and presence via isPresenceState directly).
 * Retained for completeness; inbound event-channel validation should always
 * use isRoomEventClientOp so presence.update cannot pollute the durable log.
 */
export function isRoomClientOp(x: unknown): x is RoomClientOp {
  if (isRoomEventClientOp(x)) return true;
  if (x === null || typeof x !== 'object') return false;
  const op = x as Record<string, unknown>;
  return op.type === 'presence.update' && isPresenceState(op.presence);
}

// ---------------------------------------------------------------------------
// Server Events (decrypted by client from envelope ciphertext)
// ---------------------------------------------------------------------------

export type RoomServerEvent =
  | { type: 'snapshot'; payload: RoomSnapshot; snapshotSeq: number }
  | { type: 'annotation.add'; annotations: RoomAnnotation[] }
  | { type: 'annotation.update'; id: string; patch: Partial<RoomAnnotation> }
  | { type: 'annotation.remove'; ids: string[] }
  | { type: 'annotation.clear'; source?: string }
  | { type: 'presence.update'; clientId: string; presence: PresenceState };

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface RoomSnapshot {
  versionId: 'v1';
  planMarkdown: string;
  annotations: RoomAnnotation[];
}

/**
 * Runtime validator for a decrypted RoomSnapshot. A malformed snapshot must
 * not enter client state — it clears and re-seeds the annotations map plus
 * planMarkdown, so garbage here corrupts the whole view.
 */
const ROOM_SNAPSHOT_KEYS = new Set(['versionId', 'planMarkdown', 'annotations']);

export function isRoomSnapshot(x: unknown): x is RoomSnapshot {
  if (x === null || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  // Strict boundary: reject unknown keys so future protocol drift fails
  // loudly instead of silently slipping fields past the validator.
  for (const key of Object.keys(s)) {
    if (!ROOM_SNAPSHOT_KEYS.has(key)) return false;
  }
  if (s.versionId !== 'v1') return false;
  if (typeof s.planMarkdown !== 'string') return false;
  if (!Array.isArray(s.annotations)) return false;
  return s.annotations.every(isRoomAnnotation);
}

// ---------------------------------------------------------------------------
// Transport Messages (server-to-client, pre-decryption)
// ---------------------------------------------------------------------------

export type RoomTransportMessage =
  | { type: 'room.snapshot'; snapshotSeq: number; snapshotCiphertext: string }
  | { type: 'room.event'; seq: number; receivedAt: number; envelope: ServerEnvelope }
  | { type: 'room.presence'; envelope: ServerEnvelope }
  | { type: 'room.status'; status: RoomStatus }
  | { type: 'room.error'; code: string; message: string }
  /**
   * Peer left the room. Broadcast by the room service on a
   * WebSocket close so other participants can drop the peer's
   * presence (cursor, avatar) immediately rather than waiting for
   * the client-side presence TTL sweep to expire the entry.
   *
   * `clientId` is the server-assigned id from the peer's
   * auth.challenge; the server knows it from the socket's
   * attachment. No encrypted payload — nothing here that a
   * receiver couldn't have inferred from absence anyway.
   */
  | { type: 'room.participant.left'; clientId: string };

// ---------------------------------------------------------------------------
// Room Status
// ---------------------------------------------------------------------------

// 'created' was in this union historically, but the DO initializes rooms
// directly to 'active' on creation and never transitions through 'created'.
// Keeping it in the type would imply an unused lifecycle step.
export type RoomStatus = 'active' | 'locked' | 'deleted' | 'expired';

// ---------------------------------------------------------------------------
// Sequenced Envelope (for event log storage)
// ---------------------------------------------------------------------------

export interface SequencedEnvelope {
  seq: number;
  receivedAt: number;
  envelope: ServerEnvelope;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthChallenge {
  type: 'auth.challenge';
  challengeId: string;
  nonce: string;
  expiresAt: number;
  /**
   * Server-assigned ephemeral clientId for this WebSocket. Binding the auth
   * proof to it prevents a malicious participant from choosing another active
   * connection's visible clientId and overwriting their presence slot after
   * auth. Clients MUST use this value as their clientId for the connection
   * (not self-generate one).
   */
  clientId: string;
}

export interface AuthResponse {
  type: 'auth.response';
  challengeId: string;
  /** Must equal the server-assigned clientId from the corresponding AuthChallenge. */
  clientId: string;
  proof: string;
  lastSeq?: number;
}

export interface AuthAccepted {
  type: 'auth.accepted';
  roomStatus: RoomStatus;
  seq: number;
  snapshotSeq?: number;
  snapshotAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type AdminCommand =
  | { type: 'room.lock'; finalSnapshotCiphertext?: string; finalSnapshotAtSeq?: number }
  | { type: 'room.unlock' }
  | { type: 'room.delete' };

export interface AdminChallengeRequest {
  type: 'admin.challenge.request';
}

export interface AdminChallenge {
  type: 'admin.challenge';
  challengeId: string;
  nonce: string;
  expiresAt: number;
}

export interface AdminCommandEnvelope {
  type: 'admin.command';
  challengeId: string;
  clientId: string;
  command: AdminCommand;
  adminProof: string;
}

// ---------------------------------------------------------------------------
// Room Creation
// ---------------------------------------------------------------------------

export interface CreateRoomRequest {
  roomId: string;
  roomVerifier: string;
  adminVerifier: string;
  initialSnapshotCiphertext: string;
  expiresInDays?: number;
}

export interface CreateRoomResponse {
  roomId: string;
  status: 'active';
  seq: 0;
  snapshotSeq: 0;
  joinUrl: string;
  websocketUrl: string;
}

// ---------------------------------------------------------------------------
// Agent-Readable State
// ---------------------------------------------------------------------------

export interface AgentReadableRoomState {
  roomId: string;
  status: RoomStatus;
  versionId: 'v1';
  planMarkdown: string;
  annotations: RoomAnnotation[];
}
