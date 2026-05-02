/**
 * Chat context resolution — pick a strategy based on launch metadata.
 *
 * Every time a user opens Plannotator from inside a coding agent (Claude Code
 * hook or slash command, OpenCode event, Pi extension command, Codex shell-out),
 * the invoking process carries session information we'd like to fork or resume
 * from. This module defines:
 *
 *   - `LaunchMetadata`  — the raw, provider-agnostic facts each entry point
 *                         reports to the server
 *   - `ChatContextStrategy`
 *                       — the resolver's decision about what to do with those
 *                         facts (fork by id, fork by heuristic, resume by id,
 *                         or start fresh)
 *   - `resolveChatContext(launch)`
 *                       — a pure function mapping one to the other
 *
 * The resolver is I/O-free by design. Any heuristic lookup (e.g., scanning
 * `~/.claude/sessions/` by cwd slug) happens downstream when the strategy is
 * *executed*, not when it's resolved. This keeps the resolver unit-testable
 * as a plain table-driven function with no mocks.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// Harness / Invocation / ChatContextStrategy are defined in @plannotator/shared
// so the review editor (and any other client surface) can consume them without
// a back-reference into packages/ai. This file re-exports them for callers
// that already import from here.
export type { Harness, Invocation, ChatContextStrategy } from "@plannotator/shared/chat-context";
import type { Harness, Invocation, ChatContextStrategy } from "@plannotator/shared/chat-context";

/**
 * Facts the invoking harness reports to the server at launch time.
 * All fields except `harness`, `invocation`, and `cwd` are optional because
 * different harnesses surface different information.
 */
export interface LaunchMetadata {
  harness: Harness;
  invocation: Invocation;
  /** Working directory the user is operating in. */
  cwd: string;
  /**
   * Session id from the invoking harness, if available.
   * - Claude Code hook: `event.session_id` from hook stdin JSON
   * - OpenCode: `event.properties.sessionID` (walk to root via `parentID` first)
   * - Pi: the value of `ctx.sessionManager.getSessionId()`
   * - Codex: `process.env.CODEX_THREAD_ID`
   * - Claude slash command / VS Code / standalone: absent
   */
  sessionId?: string;
  /**
   * Pi-only. Absolute path to the session file (`.jsonl`). Pi RPC's
   * `switch_session` command is path-based, not id-based.
   */
  sessionPath?: string;
  /**
   * Pi-only. Id of the user-message entry to fork from. The Pi extension
   * resolves this from `ctx.sessionManager.getBranch()` before spawning.
   */
  entryId?: string;
  /**
   * Claude Code hook only. Path to the hook transcript, retained for diagnostics.
   */
  transcriptPath?: string;
}

// ---------------------------------------------------------------------------
// Debug log — structured event emitted on every resolve
// ---------------------------------------------------------------------------

/** Shape of the debug log emitted to the server console. */
export interface ResolveDebugLog {
  strategy: ChatContextStrategy["kind"];
  harness: Harness;
  invocation: Invocation;
  cwd: string;
  id?: string;
  ts: number;
}

/**
 * Log a resolved strategy to the server console in a parseable shape.
 * Extracted so tests can spy on it and so emission is consistent across paths.
 */
export function logResolvedContext(
  launch: LaunchMetadata,
  strategy: ChatContextStrategy,
): void {
  const entry: ResolveDebugLog = {
    strategy: strategy.kind,
    harness: launch.harness,
    invocation: launch.invocation,
    cwd: launch.cwd,
    ts: Date.now(),
  };
  if ("sessionId" in strategy) entry.id = strategy.sessionId;
  else if ("threadId" in strategy) entry.id = strategy.threadId;
  console.log(`[plannotator] chat-context resolved: ${JSON.stringify(entry)}`);
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the chat context strategy for a given launch. Pure function.
 *
 * Matrix 3 (from the spec) — one row per harness/invocation combination:
 *
 *   | Launch path                          | Strategy              |
 *   |--------------------------------------|-----------------------|
 *   | Claude Code hook (has sessionId)     | fork_by_id            |
 *   | Claude Code slash (cwd only)         | fork_by_heuristic     |
 *   | OpenCode (has sessionId)             | fork_by_id            |
 *   | Pi (sessionPath + entryId)           | fork_by_id            |
 *   | Pi (sessionPath only)                | resume_by_id          |
 *   | Pi (no sessionPath)                  | fresh                 |
 *   | Codex (has CODEX_THREAD_ID)          | resume_by_id          |
 *   | VS Code / standalone                 | fresh                 |
 */
export function resolveChatContext(launch: LaunchMetadata): ChatContextStrategy {
  switch (launch.harness) {
    case "claude-code":
      if (launch.sessionId) {
        return {
          kind: "fork_by_id",
          harness: "claude-code",
          sessionId: launch.sessionId,
        };
      }
      // No session id means we're invoked via a slash command or similar path
      // where Claude Code doesn't hand us the id. Downstream executor uses
      // `findSessionLogsForCwd(cwd)` to find the most-recent matching session.
      return {
        kind: "fork_by_heuristic",
        harness: "claude-code",
        cwd: launch.cwd,
      };

    case "opencode":
      if (launch.sessionId) {
        return {
          kind: "fork_by_id",
          harness: "opencode",
          sessionId: launch.sessionId,
        };
      }
      return {
        kind: "fresh",
        harness: "opencode",
        reason: "opencode launch without sessionId",
      };

    case "pi": {
      // Pi's RPC surface is path-based. Without a session path we cannot
      // switch_session or fork. Fall through to fresh.
      if (!launch.sessionPath) {
        return {
          kind: "fresh",
          harness: "pi",
          reason: "pi launch without sessionPath",
        };
      }
      // Path + user-message entry → full fork.
      if (launch.entryId) {
        return {
          kind: "fork_by_id",
          harness: "pi",
          // sessionId is useful for diagnostics/badge display, but the RPC
          // call sequence is sessionPath-driven, not id-driven.
          sessionId: launch.sessionId ?? launch.sessionPath,
          sessionPath: launch.sessionPath,
          entryId: launch.entryId,
        };
      }
      // Path only → switch_session without fork. Keeps the user on the same
      // Pi session file but doesn't fork a new branch at a specific turn.
      return {
        kind: "resume_by_id",
        harness: "pi",
        threadId: launch.sessionId ?? launch.sessionPath,
        sessionPath: launch.sessionPath,
      };
    }

    case "codex":
      if (launch.sessionId) {
        // Codex SDK has no fork (fork exists in Rust core as `thread/fork` but
        // isn't exposed). Resume mutates the user's main thread — accepted
        // tradeoff. The Plannotator turn will appear in the user's terminal
        // Codex session when they return to it.
        return {
          kind: "resume_by_id",
          harness: "codex",
          threadId: launch.sessionId,
        };
      }
      return {
        kind: "fresh",
        harness: "codex",
        reason: "codex launch without CODEX_THREAD_ID",
      };

    case "vscode":
      return {
        kind: "fresh",
        harness: "vscode",
        reason: "vscode extension — no invoking agent context",
      };

    case "standalone":
      return {
        kind: "fresh",
        harness: "standalone",
        reason: "standalone cli — no invoking agent context",
      };

    default: {
      // Exhaustiveness check — TypeScript flags this assignment at compile
      // time if a new `Harness` value is added without a matching case.
      // Runtime fallback is `fresh` so we degrade safely rather than
      // returning undefined and crashing downstream.
      const _exhaustive: never = launch.harness;
      return {
        kind: "fresh",
        harness: launch.harness,
        reason: `unhandled harness: ${String(_exhaustive)}`,
      };
    }
  }
}
