/**
 * Session manager — tracks active and historical AI sessions.
 *
 * Each Plannotator server instance (plan review, code review, annotate)
 * gets its own SessionManager. It tracks:
 *
 * - Active sessions (currently streaming or idle but resumable)
 * - The lineage from forked sessions back to their parent
 * - Metadata for UI display (timestamps, mode, status)
 *
 * This is an in-memory store scoped to the server's lifetime. Sessions
 * are not persisted to disk by the manager (the underlying provider
 * handles its own persistence via the agent SDK).
 */

import type { AISession, AIContextMode, AIMessage } from "./types.ts";
import type { ChatContextStrategy } from "./resolve-context.ts";
import {
  accumulateTurn,
  abortTurn,
  createUserTurn,
  createAssistantTurn,
  type ChatTurn,
  type TurnStatus,
  type UserTurnContent,
} from "@plannotator/shared/chat-transcript";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionEntry {
  /** The live session handle (if still active). */
  session: AISession;
  /** What mode this session was created for. */
  mode: AIContextMode;
  /** The parent session ID this was forked from (null if standalone). */
  parentSessionId: string | null;
  /** When this session was created. */
  createdAt: number;
  /** When the last query was sent. */
  lastActiveAt: number;
  /** Short description for UI display (e.g., the user's first question). */
  label?: string;
  /**
   * Resolved chat-context strategy for this session. Captured at track time
   * from `resolveChatContext`; consumed by the chat stream endpoint's
   * snapshot emission so the client can render the context badge.
   * Null for sessions created without a resolver (e.g. internal tests,
   * backward-compat callers).
   */
  strategy: ChatContextStrategy | null;
  /**
   * Full conversation turn list for this session. Populated by
   * `startUserTurn`, `appendMessage`, and `finalizeTurn`. Sent wholesale as
   * the `snapshot` event on SSE connect so clients can rehydrate after a
   * refresh without re-playing deltas.
   */
  transcript: ChatTurn[];
  /**
   * SSE controllers subscribed to this session's transcript stream. Populated
   * by `subscribe`, drained by `broadcast`. Closed out and cleared on
   * eviction so stale clients hit the `/exists` 404 path and create a
   * fresh session rather than retry against a gone one.
   */
  streamSubscribers: Set<ReadableStreamDefaultController<Uint8Array>>;
  /**
   * Id of the in-flight assistant turn. Set by `startUserTurn`, cleared by
   * `finalizeTurn`. Lets `/api/ai/abort` discover the turn the abort applies
   * to without the client having to pass it.
   */
  activeAssistantTurnId: string | null;
  /**
   * Abort was requested for the in-flight turn. The query handler's `finally`
   * reads this so `finalizeTurn` can record status="aborted" even when the
   * provider's generator returns cleanly on abort (no error thrown). Cleared
   * in `finalizeTurn`.
   */
  abortRequested: boolean;
}

/**
 * Options for tracking a new session. Extended from the original `label?`-only
 * third argument — existing callers that didn't pass anything keep working;
 * new callers can supply the resolved strategy up front.
 */
export interface TrackOptions {
  label?: string;
  strategy?: ChatContextStrategy | null;
}

export interface SessionManagerOptions {
  /**
   * Maximum number of sessions to keep in the manager.
   * Oldest idle sessions are evicted when the limit is reached.
   * Default: 20.
   */
  maxSessions?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private aliases = new Map<string, string>();
  private maxSessions: number;

  constructor(options: SessionManagerOptions = {}) {
    this.maxSessions = options.maxSessions ?? 20;
  }

  /**
   * Track a newly created session.
   *
   * If the session supports ID resolution (e.g., the real SDK session ID
   * arrives after the first query), call `remapId()` to update the key.
   *
   * `options.strategy` carries the resolved chat-context strategy so the
   * snapshot emitted on SSE connect can include it for the context badge.
   * `options.label` is a short UI description; if omitted the endpoint
   * layer typically sets it from the first user prompt via direct mutation.
   */
  track(
    session: AISession,
    mode: AIContextMode,
    options?: TrackOptions,
  ): SessionEntry {
    this.evictIfNeeded();

    const entry: SessionEntry = {
      session,
      mode,
      parentSessionId: session.parentSessionId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      label: options?.label,
      strategy: options?.strategy ?? null,
      transcript: [],
      streamSubscribers: new Set(),
      activeAssistantTurnId: null,
      abortRequested: false,
    };
    this.sessions.set(session.id, entry);

    // Wire up ID remapping so providers can resolve the real session ID later
    session.onIdResolved = (oldId, newId) => this.remapId(oldId, newId);

    return entry;
  }

  /**
   * Remap a session from one ID to another.
   * Used when the real session ID is resolved after initial tracking.
   */
  remapId(oldId: string, newId: string): void {
    const entry = this.sessions.get(oldId);
    if (entry) {
      this.sessions.delete(oldId);
      this.sessions.set(newId, entry);
      // Keep the old ID as an alias so clients using the original ID still work
      this.aliases.set(oldId, newId);
    }
  }

  /** Resolve an alias to the canonical ID, or return the ID as-is. */
  private resolve(sessionId: string): string {
    return this.aliases.get(sessionId) ?? sessionId;
  }

  /**
   * Get a tracked session by ID (or alias).
   */
  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(this.resolve(sessionId));
  }

  /**
   * Mark a session as recently active (updates lastActiveAt).
   */
  touch(sessionId: string): void {
    const entry = this.sessions.get(this.resolve(sessionId));
    if (entry) {
      entry.lastActiveAt = Date.now();
    }
  }

  /**
   * Remove a session from tracking.
   * Does NOT abort the session — call session.abort() first if needed.
   * Closes any outstanding SSE subscribers so their clients reconnect
   * (and get a 404 from `/exists` if the removal is permanent).
   */
  remove(sessionId: string): void {
    const canonical = this.resolve(sessionId);
    const entry = this.sessions.get(canonical);
    if (entry) closeSubscribers(entry);
    this.sessions.delete(canonical);
    this.removeAliasesFor(canonical);
  }

  /** Drop every alias that resolves to `canonical`. */
  private removeAliasesFor(canonical: string): void {
    for (const [alias, target] of this.aliases) {
      if (target === canonical) this.aliases.delete(alias);
    }
  }

  /**
   * List all tracked sessions, newest first.
   */
  list(): SessionEntry[] {
    return [...this.sessions.values()].sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt
    );
  }

  /**
   * List sessions forked from a specific parent.
   */
  forksOf(parentSessionId: string): SessionEntry[] {
    return this.list().filter(
      (e) => e.parentSessionId === parentSessionId
    );
  }

  /**
   * Get the number of tracked sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  // -------------------------------------------------------------------------
  // Transcript accumulation
  // -------------------------------------------------------------------------

  /**
   * Open a new user→assistant turn pair for a query.
   *
   * Called by the query endpoint at the moment a `POST /api/ai/query` arrives,
   * before iterating the provider stream. Creates:
   *   - a completed user turn carrying the prompt + anchor content
   *   - a streaming assistant turn to accumulate provider events into
   *
   * Broadcasts both new turns to SSE subscribers and returns the assistant
   * turn id so the endpoint can pass it to `finalizeTurn` when the stream ends.
   *
   * Returns `null` if the session doesn't exist (e.g. evicted between the
   * request's session lookup and here). Callers should treat this as a
   * 404-equivalent.
   */
  startUserTurn(sessionId: string, content: UserTurnContent): string | null {
    const entry = this.sessions.get(this.resolve(sessionId));
    if (!entry) return null;

    const now = Date.now();
    const userTurn = createUserTurn(`u-${crypto.randomUUID()}`, content, now);
    const assistantTurn = createAssistantTurn(
      `a-${crypto.randomUUID()}`,
      now,
    );
    entry.transcript.push(userTurn, assistantTurn);
    entry.lastActiveAt = now;
    entry.activeAssistantTurnId = assistantTurn.id;
    entry.abortRequested = false;

    this.broadcastTo(entry, { type: "turn", turn: userTurn });
    this.broadcastTo(entry, { type: "turn", turn: assistantTurn });
    return assistantTurn.id;
  }

  /**
   * Mark the in-flight turn as aborted so the query handler's `finally` can
   * pass status="aborted" to `finalizeTurn`. Returns `true` if there was an
   * in-flight turn to mark. Call `session.abort()` separately — this method
   * only records the intent.
   */
  markAbortRequested(sessionId: string): boolean {
    const entry = this.sessions.get(this.resolve(sessionId));
    if (!entry || !entry.activeAssistantTurnId) return false;
    entry.abortRequested = true;
    return true;
  }

  /**
   * Fold a single `AIMessage` into the specified assistant turn and broadcast
   * a `delta` event to subscribers. The client-side accumulator applies the
   * same `accumulateTurn` logic to produce a coherent rendered turn.
   *
   * `turnId` is required: the query handler captures its own assistant-turn
   * id from `startUserTurn` and passes it here so concurrent writers (two
   * tabs sharing a session) can't leak messages into each other's turns.
   * Targeting by id also means a still-unwinding stream whose turn was
   * finalized earlier will no-op safely once the turn is gone.
   *
   * No-op if the session or turn is unknown, or the turn isn't an assistant.
   */
  appendMessage(sessionId: string, turnId: string, msg: AIMessage): void {
    const entry = this.sessions.get(this.resolve(sessionId));
    if (!entry) return;

    const idx = entry.transcript.findIndex((t) => t.id === turnId);
    if (idx < 0) return;
    const turn = entry.transcript[idx];
    if (!turn || turn.role !== "assistant") return;

    const updated = accumulateTurn(turn, msg);
    entry.transcript[idx] = updated;
    entry.lastActiveAt = Date.now();

    // Send the raw AIMessage with the turn id so subscribers can fold it
    // into their own mirror. Cheaper than re-sending the full turn on every
    // delta (which for long streams is many kilobytes per token).
    this.broadcastTo(entry, {
      type: "delta",
      turnId: updated.id,
      message: msg,
    });
  }

  /**
   * Transition an assistant turn's status (usually to `"complete"`,
   * `"aborted"`, or `"error"`) and broadcast the finalized turn to
   * subscribers. Clients replace their local turn by id with this final
   * state, which is safer than relying on the last-delta having arrived.
   *
   * No-op if the session/turn doesn't exist. `aborted` uses `abortTurn`
   * from the shared helpers so status + updatedAt transition together.
   */
  finalizeTurn(sessionId: string, turnId: string, status: TurnStatus): void {
    const entry = this.sessions.get(this.resolve(sessionId));
    if (!entry) return;

    const idx = entry.transcript.findIndex((t) => t.id === turnId);
    if (idx < 0) return;
    const turn = entry.transcript[idx];
    if (!turn || turn.role !== "assistant") return;

    const finalized =
      status === "aborted"
        ? abortTurn(turn)
        : { ...turn, status, updatedAt: Date.now() };
    entry.transcript[idx] = finalized;
    entry.lastActiveAt = Date.now();
    if (entry.activeAssistantTurnId === turnId) {
      entry.activeAssistantTurnId = null;
      entry.abortRequested = false;
    }
    this.broadcastTo(entry, { type: "turn", turn: finalized });
  }

  /** Return a copy of the session's transcript (or empty if unknown). */
  getTranscript(sessionId: string): ChatTurn[] {
    const entry = this.sessions.get(this.resolve(sessionId));
    return entry ? entry.transcript.slice() : [];
  }

  // -------------------------------------------------------------------------
  // SSE subscriber wiring
  // -------------------------------------------------------------------------

  /**
   * Register an SSE controller as a subscriber for a session's transcript
   * stream. Returns an unsubscribe function; callers MUST call it when the
   * stream cancels so we don't accumulate dead controllers.
   *
   * If the session doesn't exist, returns a no-op unsubscribe. The SSE
   * endpoint should probe `/exists` before calling subscribe.
   */
  subscribe(
    sessionId: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): () => void {
    const entry = this.sessions.get(this.resolve(sessionId));
    if (!entry) return () => {};
    entry.streamSubscribers.add(controller);
    return () => {
      entry.streamSubscribers.delete(controller);
    };
  }

  /**
   * Broadcast a serializable event to all current subscribers for a session.
   * Encoded as a standard SSE `data: ...\n\n` line. Failed enqueues (stream
   * closed) drop the bad controller.
   *
   * Exposed so the endpoint layer can send one-off events (e.g., the initial
   * `snapshot` to a newly connected subscriber, or a `permission_resolved`
   * broadcast from the permission handler) without going through the
   * turn-level helpers above.
   */
  broadcast(sessionId: string, event: unknown): void {
    const entry = this.sessions.get(this.resolve(sessionId));
    if (!entry) return;
    this.broadcastTo(entry, event);
  }

  private broadcastTo(entry: SessionEntry, event: unknown): void {
    if (entry.streamSubscribers.size === 0) return;
    const payload = SESSION_SSE_ENCODER.encode(
      `data: ${JSON.stringify(event)}\n\n`,
    );
    for (const controller of [...entry.streamSubscribers]) {
      try {
        controller.enqueue(payload);
      } catch {
        // Stream is already closed; drop the subscriber. Safe to delete
        // during iteration because we copied the set above.
        entry.streamSubscribers.delete(controller);
      }
    }
  }

  /**
   * Abort all active sessions and clear tracking.
   */
  disposeAll(): void {
    for (const entry of this.sessions.values()) {
      if (entry.session.isActive) {
        entry.session.abort();
      }
      closeSubscribers(entry);
    }
    this.sessions.clear();
    this.aliases.clear();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private evictIfNeeded(): void {
    if (this.sessions.size < this.maxSessions) return;

    // Find the oldest idle session to evict
    let oldest: { id: string; at: number } | null = null;
    for (const [id, entry] of this.sessions) {
      if (entry.session.isActive) continue; // don't evict active sessions
      if (!oldest || entry.lastActiveAt < oldest.at) {
        oldest = { id, at: entry.lastActiveAt };
      }
    }

    if (oldest) {
      const evictedEntry = this.sessions.get(oldest.id);
      if (evictedEntry) closeSubscribers(evictedEntry);
      this.sessions.delete(oldest.id);
      this.removeAliasesFor(oldest.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Module-scoped encoder reused by every broadcast. Creating a new TextEncoder
 * per event is cheap but not free, and we broadcast on every streaming delta
 * of every active session — worth the micro-optimization.
 */
const SESSION_SSE_ENCODER = new TextEncoder();

/**
 * Close every SSE controller attached to an entry and forget them. Used by
 * `remove`, `disposeAll`, and the eviction path so stale clients can't keep
 * reading from a session the server no longer owns.
 */
function closeSubscribers(entry: SessionEntry): void {
  for (const controller of entry.streamSubscribers) {
    try {
      controller.close();
    } catch {
      // Already closed or errored — ignore.
    }
  }
  entry.streamSubscribers.clear();
}
