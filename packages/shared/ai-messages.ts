/**
 * AI message envelope — the discriminated union of events a provider can
 * stream back, plus the server-level augmentations (permission_resolved).
 *
 * Lives in `@plannotator/shared` so the transcript accumulator
 * (`chat-transcript.ts`) can operate on these types without importing
 * across package boundaries into `@plannotator/ai`. `@plannotator/ai`
 * re-exports every type here through `packages/ai/types.ts` for
 * backward-compat with existing callers.
 *
 * All types in this file are structural — no classes, no runtime values —
 * so the module contributes nothing to the runtime bundle.
 */

// ---------------------------------------------------------------------------
// Individual message kinds
// ---------------------------------------------------------------------------

export interface AITextMessage {
  type: "text";
  text: string;
}

export interface AITextDeltaMessage {
  type: "text_delta";
  delta: string;
}

/**
 * A streaming chunk of reasoning/thinking tokens, distinct from the final answer.
 *
 * Claude's SDK emits thinking blocks as separate event kinds from text content;
 * the Claude adapter routes them here so the UI can render thinking collapsed,
 * separate from the answer (#406). Codex and Pi don't surface reasoning
 * separately and continue emitting only `text_delta`. OpenCode emits reasoning
 * via `part.type === "reasoning"` with same-partID deltas; routing to this
 * envelope kind is a follow-up slice.
 */
export interface AIThinkingDeltaMessage {
  type: "thinking_delta";
  delta: string;
}

export interface AIToolUseMessage {
  type: "tool_use";
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
}

export interface AIToolResultMessage {
  type: "tool_result";
  toolUseId?: string;
  result: string;
}

export interface AIErrorMessage {
  type: "error";
  error: string;
  code?: string;
}

export interface AIResultMessage {
  type: "result";
  sessionId: string;
  success: boolean;
  /** The final text result (if success). */
  result?: string;
  /** Total cost in USD (if available). */
  costUsd?: number;
  /** Number of agentic turns used. */
  turns?: number;
}

export interface AIPermissionRequestMessage {
  type: "permission_request";
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseId: string;
}

/**
 * Broadcast to all subscribers of a session's SSE stream after a permission
 * request is resolved. Enables multi-tab safety: tab A answering a prompt
 * clears the pending request in tab B. Emitted from the server's permission
 * endpoint; not produced directly by providers.
 */
export interface AIPermissionResolvedMessage {
  type: "permission_resolved";
  requestId: string;
  allowed: boolean;
}

export interface AIUnknownMessage {
  type: "unknown";
  /** The raw message from the provider, for debugging/transparency. */
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export type AIMessage =
  | AITextMessage
  | AITextDeltaMessage
  | AIThinkingDeltaMessage
  | AIToolUseMessage
  | AIToolResultMessage
  | AIErrorMessage
  | AIResultMessage
  | AIPermissionRequestMessage
  | AIPermissionResolvedMessage
  | AIUnknownMessage;
