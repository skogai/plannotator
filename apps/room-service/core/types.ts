/**
 * Server-only types for the room-service Durable Object.
 *
 * RoomDurableState is the persistent room record stored in DO storage.
 * WebSocketAttachment is serialized per-connection metadata that survives
 * DO hibernation via serializeAttachment/deserializeAttachment.
 */

// ---------------------------------------------------------------------------
// Worker Environment
// ---------------------------------------------------------------------------

/** Cloudflare Worker environment bindings. */
export interface Env {
  ROOM: DurableObjectNamespace;
  /** Wrangler-managed static asset binding. Serves `./public/index.html` (room shell) + hashed `./public/assets/*` chunks. Populated by `bun run build:shell`. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  ALLOWED_ORIGINS?: string;
  ALLOW_LOCALHOST_ORIGINS?: string;
  BASE_URL?: string;
}

/**
 * Durable state stored in DO storage under key 'room'.
 *
 * The room either exists (this record is present) or it doesn't (key
 * absent). There's no "deleted" / "expired" tombstone state — purgeRoom
 * hard-deletes the key when the 30-day alarm fires or when an admin
 * issues delete. Absence means "link doesn't resolve."
 *
 * Events are NOT stored in this record — they use separate per-event keys
 * ('event:0000000001', etc.) to stay within DO per-value size limits.
 */
export interface RoomDurableState {
  /** Stored at creation — DO can't reverse idFromName(). */
  roomId: string;
  roomVerifier: string;
  adminVerifier: string;
  seq: number;
  /** Oldest event seq still in storage. Initialized to 1 at creation. */
  earliestRetainedSeq: number;
  snapshotCiphertext?: string;
  snapshotSeq?: number;
  expiresAt: number | null;
}

/**
 * WebSocket attachment — survives hibernation via serializeAttachment/deserializeAttachment.
 *
 * Pre-auth: holds pending challenge state so the DO can verify after waking.
 * Post-auth: holds authenticated connection metadata + optional pending admin challenge.
 * Both variants carry roomId so webSocketMessage() can access it without a storage read.
 */
export type WebSocketAttachment =
  | {
      authenticated: false;
      roomId: string;
      challengeId: string;
      nonce: string;
      expiresAt: number;
      /** Server-assigned ephemeral client id for this connection. Included in
       *  the auth challenge so the client's proof binds to it; prevents a
       *  malicious participant from choosing another user's clientId at auth
       *  time and overwriting their presence slot after auth. */
      clientId: string;
    }
  | {
      authenticated: true;
      roomId: string;
      clientId: string;
      authenticatedAt: number;
      pendingAdminChallenge?: { challengeId: string; nonce: string; expiresAt: number };
    };
