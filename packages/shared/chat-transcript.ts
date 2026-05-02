/**
 * Chat transcript types and the pure `accumulateTurn` function.
 *
 * The server accumulates every AIMessage from every chat turn into a
 * canonical per-session transcript so the client can rehydrate after
 * refresh/reconnect without loss. The transcript is a list of turns
 * (user / assistant), not a raw stream of deltas — deltas merge into the
 * trailing assistant turn as they arrive.
 *
 * Runtime-agnostic: no node:* imports, no Bun APIs, no DOM. Both the Bun
 * server and any future runtime can import this module.
 */

import type { AIMessage } from "./ai-messages";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lifecycle status for a turn.
 * - `streaming`: an assistant turn actively receiving deltas
 * - `complete`: finished normally (provider emitted a final `result`)
 * - `aborted`: user cancelled the query before completion
 * - `error`: provider emitted an `error` message; see `content.error`
 *
 * User turns are always created in `complete` state (we have the full prompt
 * at the moment we start the turn).
 */
export type TurnStatus = "streaming" | "complete" | "aborted" | "error";

/**
 * The payload of a user turn. Carries the prompt plus whatever anchor
 * metadata the client attached (line range, file scope, selected code).
 * The anchor survives snapshot rehydration so the UI's line-range chip
 * and file-scope badge come back correctly after refresh.
 */
export interface UserTurnContent {
  prompt: string;
  /**
   * The user's original question text, before context enrichment (the
   * "Re: file, lines N-M ..." prefix). When present, the UI renders this
   * instead of `prompt` so rehydrated questions show the user's words, not
   * the model-facing context blob.
   */
  displayPrompt?: string;
  scope?: "line" | "file";
  lineStart?: number;
  lineEnd?: number;
  /** Which side of the diff the line range refers to. Review-mode only. */
  side?: "old" | "new";
  filePath?: string;
  selectedCode?: string;
  /**
   * Optional client-generated question ID. The client creates an optimistic
   * entry keyed by this ID when the user submits a prompt; sending it along
   * in the `POST /api/ai/query` body lets the server stamp it on the user
   * turn so that on snapshot rehydration the client can match the restored
   * entry back to its original local ID (instead of creating a duplicate
   * entry keyed by the server's turn UUID). Opaque to the server.
   */
  clientQuestionId?: string;
}

/**
 * A tool invocation observed within an assistant turn.
 * `result` is filled in when the matching `tool_result` message arrives.
 */
export interface TurnToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  error?: string;
}

/**
 * A permission request observed within an assistant turn.
 * `resolved`/`allowed` are set when the matching `permission_resolved`
 * message arrives (either from the user answering the prompt in the UI
 * or from another tab answering for a multi-tab session).
 *
 * UI-display fields (`title`, `displayName`, `description`) are preserved
 * from the original `AIPermissionRequestMessage` so that after a refresh
 * the permission prompt re-renders with the same human-readable text.
 */
export interface TurnPermissionRequest {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  resolved?: boolean;
  allowed?: boolean;
}

/**
 * The payload of an assistant turn. Deltas are merged into `text` and
 * `thinking` as they arrive; terminal messages populate `error` and
 * `costUsd`.
 *
 * `thinking` stays empty for providers that don't emit `thinking_delta`
 * (Codex, Pi, OpenCode today). Claude is wired to emit `thinking_delta`
 * in Slice 1 PR 3. The envelope kind is reserved here so the shape is
 * stable before the adapter starts producing it.
 */
export interface AssistantTurnContent {
  text: string;
  thinking: string;
  toolCalls: TurnToolCall[];
  permissionRequests: TurnPermissionRequest[];
  error?: string;
  costUsd?: number;
}

/**
 * One turn in the transcript — either a user prompt or an assistant response.
 * Discriminated by `role`.
 */
export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  status: TurnStatus;
  content: UserTurnContent | AssistantTurnContent;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Constructors — small helpers so callers don't hand-build empty shapes
// ---------------------------------------------------------------------------

/** Create a completed user turn. */
export function createUserTurn(
  id: string,
  content: UserTurnContent,
  now: number = Date.now(),
): ChatTurn {
  return {
    id,
    role: "user",
    status: "complete",
    content,
    createdAt: now,
    updatedAt: now,
  };
}

/** Create a streaming assistant turn with empty content. */
export function createAssistantTurn(
  id: string,
  now: number = Date.now(),
): ChatTurn {
  const content: AssistantTurnContent = {
    text: "",
    thinking: "",
    toolCalls: [],
    permissionRequests: [],
  };
  return {
    id,
    role: "assistant",
    status: "streaming",
    content,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// The accumulator
// ---------------------------------------------------------------------------

/**
 * Fold an `AIMessage` into an assistant turn, returning a new turn.
 *
 * Pure function: input turn is not mutated. Input messages that don't apply
 * to an assistant turn (e.g., applied to a user turn, or unknown types) are
 * no-ops and return a new turn with only `updatedAt` bumped. Status
 * transitions happen here for `error` and `result`; the caller (SessionManager)
 * handles external transitions like `aborted`.
 *
 * Messages that don't fit the assistant turn (e.g., someone calls this on a
 * user turn) are ignored — this is defensive, not a common path.
 */
export function accumulateTurn(
  turn: ChatTurn,
  msg: AIMessage,
  now: number = Date.now(),
): ChatTurn {
  if (turn.role !== "assistant") {
    // User turns don't accept AI messages. Bump timestamp and return.
    return { ...turn, updatedAt: now };
  }

  const content = turn.content as AssistantTurnContent;
  const next: AssistantTurnContent = {
    text: content.text,
    thinking: content.thinking,
    toolCalls: content.toolCalls,
    permissionRequests: content.permissionRequests,
    error: content.error,
    costUsd: content.costUsd,
  };
  let status: TurnStatus = turn.status;

  switch (msg.type) {
    case "text_delta":
      next.text = content.text + msg.delta;
      break;

    case "thinking_delta":
      next.thinking = content.thinking + msg.delta;
      break;

    case "text":
      // Terminal full-text message: overwrite any partial deltas.
      next.text = msg.text;
      break;

    case "tool_use":
      next.toolCalls = [
        ...content.toolCalls,
        { id: msg.toolUseId, name: msg.toolName, input: msg.toolInput },
      ];
      break;

    case "tool_result": {
      // Match by toolUseId if present; otherwise attach to the most recent
      // call without a result.
      if (msg.toolUseId) {
        next.toolCalls = content.toolCalls.map((tc) =>
          tc.id === msg.toolUseId ? { ...tc, result: msg.result } : tc,
        );
      } else {
        // Find the last call without a result.
        let patched = false;
        next.toolCalls = [...content.toolCalls].reverse().map((tc) => {
          if (!patched && tc.result === undefined) {
            patched = true;
            return { ...tc, result: msg.result };
          }
          return tc;
        }).reverse();
      }
      break;
    }

    case "permission_request": {
      const pr: TurnPermissionRequest = {
        id: msg.requestId,
        toolName: msg.toolName,
        toolInput: msg.toolInput,
      };
      if (msg.title !== undefined) pr.title = msg.title;
      if (msg.displayName !== undefined) pr.displayName = msg.displayName;
      if (msg.description !== undefined) pr.description = msg.description;
      next.permissionRequests = [...content.permissionRequests, pr];
      break;
    }

    case "permission_resolved":
      next.permissionRequests = content.permissionRequests.map((pr) =>
        pr.id === msg.requestId
          ? { ...pr, resolved: true, allowed: msg.allowed }
          : pr,
      );
      break;

    case "error":
      next.error = msg.error;
      status = "error";
      break;

    case "result":
      if (msg.result !== undefined && !content.text) {
        next.text = msg.result;
      }
      if (msg.costUsd !== undefined) next.costUsd = msg.costUsd;
      status = msg.success ? "complete" : "error";
      break;

    case "unknown":
      // No-op; raw event is kept out of the transcript to keep it compact.
      break;

    default: {
      // Exhaustiveness check — if a new AIMessage variant is added to the
      // union without a case here, TypeScript flags this assignment at
      // compile time. Preserves forward-compatibility: the actual runtime
      // behavior is still a no-op (safer than throwing on an unrecognized
      // message in the middle of a stream).
      const _exhaustive: never = msg;
      void _exhaustive;
    }
  }

  return {
    ...turn,
    status,
    content: next,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Terminal transitions driven externally (abort)
// ---------------------------------------------------------------------------

/**
 * Mark an assistant turn as aborted. Called when the user cancels a query
 * before completion — there's no AIMessage event for abort, so the
 * SessionManager sets status directly.
 */
export function abortTurn(turn: ChatTurn, now: number = Date.now()): ChatTurn {
  if (turn.role !== "assistant") return turn;
  return { ...turn, status: "aborted", updatedAt: now };
}
