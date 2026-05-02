/**
 * Chat context resolution types — shared across server, client, and tests.
 *
 * The resolver itself (`resolveChatContext`) and all heuristic-promotion
 * logic live in `packages/ai/resolve-context.ts`. This file holds only the
 * data types so the review editor and any other client surface can depend
 * on one canonical shape instead of maintaining a structural mirror.
 *
 * Runtime-agnostic: no node:* imports, no Bun APIs, no DOM.
 */

// ---------------------------------------------------------------------------
// Harness + invocation enums
// ---------------------------------------------------------------------------

/** Which coding-agent harness invoked Plannotator. */
export type Harness =
  | "claude-code"
  | "opencode"
  | "pi"
  | "codex"
  | "vscode"
  | "standalone";

/** How Plannotator was entered within that harness. */
export type Invocation =
  | "hook"
  | "slash"
  | "tool"
  | "event"
  | "shell-out"
  | "extension"
  | "cli";

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

/**
 * What the server should do with a session request given the launch facts.
 *
 * - `fork_by_id`: we have the exact id (and path+entry for Pi). Create a new
 *   chat session that inherits the parent's conversation history from that point.
 * - `fork_by_heuristic`: we don't have a session id, but we can find one by
 *   scanning for matches by cwd (currently only used for Claude slash commands).
 *   The scan happens when the strategy is executed, not during resolution.
 * - `resume_by_id`: Codex has no SDK fork, so resume mutates the user's main
 *   thread. Pi with a session path but no user-message entry falls here too.
 * - `fresh`: no prior-context available or requested. The chat still gets the
 *   diff/plan as system-prompt context; "fresh" means no prior conversation.
 */
export type ChatContextStrategy =
  | {
      kind: "fork_by_id";
      harness: Harness;
      sessionId: string;
      sessionPath?: string;
      entryId?: string;
    }
  | { kind: "fork_by_heuristic"; harness: Harness; cwd: string }
  | {
      kind: "resume_by_id";
      harness: Harness;
      threadId: string;
      sessionPath?: string;
    }
  | { kind: "fresh"; harness: Harness; reason: string };
