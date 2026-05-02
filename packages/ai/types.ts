/**
 * Core types for the Plannotator AI provider layer.
 *
 * This module defines the abstract interfaces that any agent runtime
 * (Claude Agent SDK, OpenCode, future providers) must implement to
 * power AI features inside Plannotator's plan review and code review UIs.
 */

// ---------------------------------------------------------------------------
// Context — what the AI session knows about
// ---------------------------------------------------------------------------

/** The surface the user is interacting with when they invoke AI. */
export type AIContextMode = "plan-review" | "code-review" | "annotate";

/**
 * Describes the parent agent session that originally produced the plan or diff.
 * Used to fork conversations with full history.
 *
 * Some providers need more than a bare session id to fork. Pi's RPC fork is
 * path-based and requires a user-message entry id as the fork anchor, so the
 * resolver surfaces both as optional fields here. Providers that don't use
 * them (Claude, Codex, OpenCode) ignore them.
 */
export interface ParentSession {
  /**
   * Session ID from the host agent. Required for fork paths
   * (Claude/OpenCode/Pi). Omitted when the parent is Codex-shaped
   * (resume-only, anchored on `threadId`) or a Pi resume fallback
   * (no entry anchor).
   */
  sessionId?: string;
  /** Working directory the parent session was running in. */
  cwd?: string;
  /**
   * Pi-only. Absolute path to the session JSONL file. Used by Pi RPC
   * `switch_session` before `fork`, and by Pi's `resumeSession` when
   * no entry anchor is available.
   */
  sessionPath?: string;
  /**
   * Pi-only. Entry id of the user-message within the parent session's
   * branch that we fork from. Used by Pi RPC `fork`.
   */
  entryId?: string;
  /**
   * Codex-only. Thread id used by `codex.resumeThread(threadId)`.
   * Mutating — writes into the original Codex thread.
   */
  threadId?: string;
}

/**
 * Snapshot of plan-review-specific context.
 * Passed when AIContextMode is "plan-review".
 */
export interface PlanContext {
  /** The full plan markdown as submitted by the agent. */
  plan: string;
  /** Previous plan version (if this is a resubmission). */
  previousPlan?: string;
  /** The version number in the plan's history. */
  version?: number;
  /** Annotations the user has made so far (serialised for the prompt). */
  annotations?: string;
}

/**
 * Snapshot of code-review-specific context.
 * Passed when AIContextMode is "code-review".
 */
export interface CodeReviewContext {
  /** The unified diff patch. */
  patch: string;
  /** The specific file being discussed (if scoped). */
  filePath?: string;
  /** The line range being discussed (if scoped). */
  lineRange?: { start: number; end: number; side: "old" | "new" };
  /** The code snippet being discussed (if scoped). */
  selectedCode?: string;
  /** Summary of annotations the user has made. */
  annotations?: string;
}

/**
 * Snapshot of annotate-mode context.
 * Passed when AIContextMode is "annotate".
 */
export interface AnnotateContext {
  /** The markdown file content being annotated. */
  content: string;
  /** Path to the file on disk. */
  filePath: string;
  /** Summary of annotations the user has made. */
  annotations?: string;
}

/**
 * Union of mode-specific contexts, discriminated by `mode`.
 */
export type AIContext =
  | { mode: "plan-review"; plan: PlanContext; parent?: ParentSession }
  | { mode: "code-review"; review: CodeReviewContext; parent?: ParentSession }
  | { mode: "annotate"; annotate: AnnotateContext; parent?: ParentSession };

// ---------------------------------------------------------------------------
// Messages — what streams back from the AI
//
// These types live in @plannotator/shared/ai-messages so that the transcript
// accumulator (`packages/shared/chat-transcript.ts`) can reference them
// without reaching across package boundaries. We re-export them here so
// existing callers that import from `@plannotator/ai/types` keep working,
// and pull them in locally for the `AISession.query` return type below.
// ---------------------------------------------------------------------------

import type {
  AITextMessage,
  AITextDeltaMessage,
  AIThinkingDeltaMessage,
  AIToolUseMessage,
  AIToolResultMessage,
  AIErrorMessage,
  AIResultMessage,
  AIPermissionRequestMessage,
  AIPermissionResolvedMessage,
  AIUnknownMessage,
  AIMessage,
} from "@plannotator/shared/ai-messages";

export type {
  AITextMessage,
  AITextDeltaMessage,
  AIThinkingDeltaMessage,
  AIToolUseMessage,
  AIToolResultMessage,
  AIErrorMessage,
  AIResultMessage,
  AIPermissionRequestMessage,
  AIPermissionResolvedMessage,
  AIUnknownMessage,
  AIMessage,
};

// ---------------------------------------------------------------------------
// Session — a live conversation with the AI
// ---------------------------------------------------------------------------

export interface AISession {
  /** Unique identifier for this session. */
  readonly id: string;

  /**
   * The parent session this was forked from, if any.
   * Null for fresh sessions.
   */
  readonly parentSessionId: string | null;

  /**
   * Send a prompt and stream back messages.
   * The returned async iterable yields messages as they arrive.
   */
  query(prompt: string): AsyncIterable<AIMessage>;

  /**
   * Abort the current in-flight query.
   * Safe to call if no query is running (no-op).
   */
  abort(): void;

  /** Whether a query is currently in progress. */
  readonly isActive: boolean;

  /**
   * Respond to a permission request from the provider.
   * Called when the user approves or denies a tool use in the UI.
   */
  respondToPermission?(requestId: string, allow: boolean, message?: string): void;

  /**
   * Callback invoked when the real session ID is resolved from the provider.
   * Set by the SessionManager to remap its internal tracking key.
   */
  onIdResolved?: (oldId: string, newId: string) => void;
}

// ---------------------------------------------------------------------------
// Provider — the pluggable backend
// ---------------------------------------------------------------------------

export interface AIProviderCapabilities {
  /** Whether the provider supports forking from a parent session. */
  fork: boolean;
  /** Whether the provider supports resuming a prior session by ID. */
  resume: boolean;
  /** Whether the provider streams partial text deltas. */
  streaming: boolean;
  /** Whether the provider can execute tools (read files, search, etc.). */
  tools: boolean;
}

export interface CreateSessionOptions {
  /** The context (plan, diff, file) to seed the session with. */
  context: AIContext;
  /**
   * Working directory override for the agent session.
   * Falls back to the provider's configured cwd if omitted.
   */
  cwd?: string;
  /**
   * Model override. Provider-specific string.
   * Falls back to provider default if omitted.
   */
  model?: string;
  /**
   * Maximum agentic turns for the session.
   * Keeps inline chat cost-bounded.
   */
  maxTurns?: number;
  /**
   * Maximum budget in USD for this session.
   */
  maxBudgetUsd?: number;
  /**
   * Reasoning effort level — cross-provider.
   *   - Codex maps to `modelReasoningEffort` on the SDK thread.
   *   - Claude maps to the `effort` query option (`low`/`medium`/`high`/`max`).
   *     `"minimal"` and `"xhigh"` fall through unchanged where unsupported —
   *     providers that only accept a subset should coerce at their adapter.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * Extended-thinking configuration — Claude only today.
   *   - `{ type: "adaptive" }`: Claude decides depth (the default for models
   *     that support it — the adapter applies this automatically for
   *     Opus 4.7+; callers only need to pass this to force adaptive on
   *     older models that don't default to it).
   *   - `{ type: "enabled", budgetTokens }`: fixed thinking token budget.
   *   - `{ type: "disabled" }`: no extended thinking.
   * Providers that don't support thinking ignore this field.
   */
  thinking?:
    | { type: "adaptive" }
    | { type: "enabled"; budgetTokens: number }
    | { type: "disabled" };
  /**
   * Service tier — Codex only. "fast" enables priority processing.
   * Kept on the cross-provider options for now; other adapters ignore it.
   */
  serviceTier?: "fast" | "flex" | null;
}

/**
 * An AI provider implements the bridge between Plannotator and a specific
 * agent runtime. The provider is responsible for:
 *
 * 1. Creating new AI sessions seeded with review context
 * 2. Forking from parent agent sessions to maintain conversation history
 * 3. Streaming responses back as AIMessage events
 *
 * Providers are registered by name and selected at runtime based on the
 * host environment (Claude Code → "claude-agent-sdk", OpenCode → "opencode-sdk").
 */
export interface AIProvider {
  /** Unique name for this provider (e.g. "claude-agent-sdk"). */
  readonly name: string;

  /** What this provider can do. */
  readonly capabilities: AIProviderCapabilities;

  /** Available models for this provider. */
  readonly models?: ReadonlyArray<{ id: string; label: string; default?: boolean }>;

  /**
   * Create a fresh session (no parent history).
   * Context is injected via the system prompt.
   */
  createSession(options: CreateSessionOptions): Promise<AISession>;

  /**
   * Fork from a parent agent session.
   *
   * The new session inherits the parent's full conversation history
   * (files read, analysis performed, decisions made) and additionally
   * receives the Plannotator review context. This enables the user to
   * ask contextual questions like "why did you change this function?"
   * without the AI losing insight.
   *
   * Providers that don't support real forking MUST throw. The endpoint
   * layer checks `capabilities.fork` before calling this, so it should
   * only be reached by providers that genuinely support history inheritance.
   */
  forkSession(options: CreateSessionOptions): Promise<AISession>;

  /**
   * Resume a previously created Plannotator AI session by its ID.
   * Used when the user returns to a conversation they started earlier.
   *
   * If the provider doesn't support resuming, this should throw.
   */
  resumeSession(sessionId: string): Promise<AISession>;

  /**
   * List parent sessions the user could fork/resume from in this cwd.
   *
   * Returned candidates are provider-specific: Claude returns local
   * `.jsonl` sessions; Codex returns only the current CODEX_THREAD_ID
   * (if set); OpenCode walks its session API; Pi walks its RPC session
   * list. The client passes the chosen candidate's `parentFields` back
   * verbatim as `CreateSessionOptions.context.parent`, so the endpoint's
   * existing fork/resume routing takes over without new logic.
   *
   * Optional — providers that have no inheritance primitive (e.g. a
   * hypothetical standalone-only provider) may omit this.
   */
  listForkCandidates?(cwd: string, limit?: number): Promise<ForkCandidate[]>;

  /**
   * Clean up any resources held by the provider.
   * Called when the server shuts down.
   */
  dispose(): void;
}

/**
 * A session the user could fork or resume from, surfaced in the AI config
 * bar's Context picker. Each candidate carries display metadata plus the
 * provider-specific `parentFields` payload that the client echoes back on
 * session creation.
 */
export interface ForkCandidate {
  /** Opaque id for client-side keying; not required to match a real session id. */
  id: string;
  /** Short display label (e.g., "Sonnet 4.6" or "Codex terminal thread"). */
  label: string;
  /** UNIX ms of last activity. Client renders as relative age. */
  lastActiveAt: number;
  /** Model used by this session, when known. */
  model?: string;
  /** Rough token count for cost-hint UX. Optional. */
  tokenEstimate?: number;
  /** Last user-visible text, truncated to ~120 chars. Optional. */
  preview?: string;
  /**
   * Provider-specific fields for the fork/resume call. The client echoes
   * this back under `CreateSessionOptions.context.parent` on session
   * creation — e.g. `{ sessionId }` for Claude/OpenCode, `{ threadId }`
   * for Codex, `{ sessionPath, entryId }` for Pi.
   */
  parentFields: Record<string, unknown>;
  /**
   * Semantics of picking this candidate:
   *   - "fork"   → branches; original untouched (Claude/OpenCode/Pi)
   *   - "resume" → mutates the original conversation (Codex)
   * Client uses this to surface a warning for `resume` candidates.
   */
  inheritance: "fork" | "resume";
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

/**
 * Configuration passed to a provider factory.
 * Each provider type may extend this with its own fields.
 */
export interface AIProviderConfig {
  /** Provider type identifier (matches AIProvider.name). */
  type: string;
  /** Working directory for the agent. */
  cwd?: string;
  /** Default model to use. */
  model?: string;
}

export interface ClaudeAgentSDKConfig extends AIProviderConfig {
  type: "claude-agent-sdk";
  /**
   * Tools the AI session is allowed to use.
   * Defaults to read-only tools for safety in inline chat.
   */
  allowedTools?: string[];
  /**
   * Permission mode for the session.
   * Defaults to "default" (inherits user's existing permission rules).
   */
  permissionMode?: "default" | "plan" | "bypassPermissions";
  /**
   * Explicit path to the claude CLI binary.
   * Required when running inside a compiled binary where PATH resolution
   * doesn't work the same way (e.g., bun build --compile).
   */
  claudeExecutablePath?: string;
  /**
   * Setting sources to load permission rules from.
   * Loads user's existing Claude Code permission rules so inline chat
   * inherits what they've already approved.
   */
  settingSources?: string[];
  /**
   * Optional host-provided hook for enumerating `.jsonl` session files
   * matching a cwd. Injected from `packages/server/session-log.ts` on
   * Bun; Pi can inject its own implementation. Keeps `packages/ai` free
   * of filesystem concerns.
   *
   * When absent, the provider returns `[]` from `listForkCandidates`.
   */
  findSessionLogsForCwd?: (cwd: string) => string[];
}

export interface CodexSDKConfig extends AIProviderConfig {
  type: "codex-sdk";
  /**
   * Sandbox mode controls what the Codex agent can do.
   * Defaults to "read-only" for safety in inline chat.
   */
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  /**
   * Explicit path to the codex CLI binary.
   * Required when running inside a compiled binary where PATH resolution
   * doesn't work the same way (e.g., bun build --compile).
   */
  codexExecutablePath?: string;
}

export interface PiSDKConfig extends AIProviderConfig {
  type: "pi-sdk";
  /**
   * Explicit path to the pi CLI binary.
   * Required when running inside a compiled binary where PATH resolution
   * doesn't work the same way (e.g., bun build --compile).
   */
  piExecutablePath?: string;
}

export interface OpenCodeConfig extends AIProviderConfig {
  type: "opencode-sdk";
  /** Hostname for the OpenCode server. Default: "127.0.0.1". */
  hostname?: string;
  /** Port for the OpenCode server. Default: 4096. */
  port?: number;
}
