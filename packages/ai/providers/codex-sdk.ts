/**
 * Codex SDK provider — bridges Plannotator's AI layer with OpenAI's Codex agent.
 *
 * Uses @openai/codex-sdk to create sessions that can:
 * - Start fresh with Plannotator context as the system prompt
 * - Fake-fork from a parent session (fresh thread + preamble, no real history)
 * - Resume a previous thread by ID
 * - Stream text deltas back to the UI in real time
 *
 * Sessions default to read-only sandbox mode for safety in inline chat.
 *
 * IMPORTANT: **The chat path MUST NOT pass `--ephemeral`** (or the SDK
 * equivalent option) to Codex. Ephemeral threads write no rollout file and
 * cannot be resumed, which silently breaks every chat reconnect and every
 * `resume_by_id` strategy produced by the context resolver. Background
 * review jobs may still use ephemeral threads — they don't resume. Audited
 * on this branch: no `--ephemeral` references in any chat code path.
 *
 * CONCURRENT WRITER RACE: Codex's app-server rejects a second `thread/resume`
 * while the user is actively generating in their terminal ("thread {id} is
 * closing; retry thread/resume after the thread is closed"). We retry with
 * exponential backoff below — the user gets a clean "Codex is busy" error
 * after retries are exhausted instead of a raw protocol message.
 *
 * PROMPT CACHING: OpenAI's backend caches prefix hashes automatically. The
 * SDK doesn't expose `prompt_cache_key` or `prompt_cache_retention` as
 * parameters (confirmed by grep of the SDK's index.d.ts), so we don't pass
 * one. Cache-affinity routing still works because we reuse the same thread
 * (and therefore the same conversation prefix) across turns of a given
 * Plannotator chat session. Verify via the `cached_input_tokens` field on
 * the turn result — it's non-zero on the second turn onwards when cache hits.
 */

import { buildSystemPrompt, buildEffectivePrompt } from "../context.ts";
import { BaseSession } from "../base-session.ts";
import type {
  AIProvider,
  AIProviderCapabilities,
  AISession,
  AIMessage,
  CreateSessionOptions,
  CodexSDKConfig,
  ForkCandidate,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_NAME = "codex-sdk";
const DEFAULT_MODEL = "gpt-5.4";

// Concurrent-writer retry schedule. Codex app-server rejects `thread/resume`
// while the user's terminal has the thread open ("thread {id} is closing").
// These delays are tuned to let a typical user-initiated turn complete
// (seconds to tens of seconds) before giving up.
const CODEX_BUSY_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 10_000] as const;

/** Matches Codex app-server's concurrent-writer rejection message. */
const CODEX_BUSY_MESSAGE_RE = /thread \S+ is closing/i;

/**
 * Typed error for "Codex is actively generating in another process."
 * Carries the original error so diagnostics aren't lost, and lets the
 * query loop surface a user-facing message with a stable error code.
 */
class CodexBusyError extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "CodexBusyError";
    this.original = original;
  }
}

/**
 * Wait for `ms` unless the signal fires first. Used between retries so a
 * user hitting Abort during the backoff cancels the whole retry chain
 * instead of sitting through the full delay.
 */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Returns true if `err` matches Codex's concurrent-writer rejection.
 */
function isBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return CODEX_BUSY_MESSAGE_RE.test(message);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class CodexSDKProvider implements AIProvider {
  readonly name = PROVIDER_NAME;
  readonly capabilities: AIProviderCapabilities = {
    fork: false, // No real fork — faked with fresh thread + preamble
    resume: true,
    streaming: true,
    tools: true,
  };
  readonly models = [
    { id: 'gpt-5.4', label: 'GPT-5.4', default: true },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
    { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    { id: 'gpt-5.2', label: 'GPT-5.2' },
  ] as const;

  private config: CodexSDKConfig;

  constructor(config: CodexSDKConfig) {
    this.config = config;
  }

  async createSession(options: CreateSessionOptions): Promise<AISession> {
    return new CodexSDKSession({
      ...this.baseConfig(options),
      systemPrompt: buildSystemPrompt(options.context),
      cwd: options.cwd ?? this.config.cwd ?? process.cwd(),
      parentSessionId: null,
    });
  }

  async forkSession(_options: CreateSessionOptions): Promise<AISession> {
    throw new Error(
      "Codex does not support session forking. " +
        "The endpoint layer should fall back to createSession()."
    );
  }

  async resumeSession(sessionId: string): Promise<AISession> {
    return new CodexSDKSession({
      ...this.baseConfig(),
      systemPrompt: null,
      cwd: this.config.cwd ?? process.cwd(),
      parentSessionId: null,
      resumeThreadId: sessionId,
    });
  }

  async listForkCandidates(_cwd: string, _limit = 5): Promise<ForkCandidate[]> {
    // Codex has no "fork" primitive — resumeThread mutates the thread.
    // Surfacing arbitrary recent threads would let the user accidentally
    // interleave plannotator's messages into a colleague-shared thread.
    // Expose only the user's current terminal thread (CODEX_THREAD_ID) —
    // they already know this thread exists; the warning in the client
    // reminds them that picking it will mix conversations.
    const threadId = process.env.CODEX_THREAD_ID;
    if (!threadId) return [];
    return [{
      id: threadId,
      label: "Codex terminal thread",
      lastActiveAt: Date.now(),
      preview: `Thread ${threadId.slice(0, 8)}`,
      parentFields: { threadId },
      inheritance: "resume",
    }];
  }

  dispose(): void {
    // No persistent resources to clean up
  }

  private baseConfig(options?: CreateSessionOptions) {
    return {
      model: options?.model ?? this.config.model ?? DEFAULT_MODEL,
      maxTurns: options?.maxTurns ?? 99,
      sandboxMode: this.config.sandboxMode ?? "read-only" as const,
      codexExecutablePath: this.config.codexExecutablePath,
      reasoningEffort: options?.reasoningEffort,
      serviceTier: options?.serviceTier,
    };
  }
}

// ---------------------------------------------------------------------------
// SDK import cache — resolve once, reuse across all sessions
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: SDK type not available at compile time
let CodexClass: any = null;

async function getCodexClass() {
  if (!CodexClass) {
    // biome-ignore lint/suspicious/noExplicitAny: SDK exports vary between versions
    const mod = await import("@openai/codex-sdk") as any;
    CodexClass = mod.default ?? mod.Codex;
  }
  return CodexClass;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface SessionConfig {
  systemPrompt: string | null;
  model: string;
  maxTurns: number;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  cwd: string;
  parentSessionId: string | null;
  resumeThreadId?: string;
  codexExecutablePath?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  serviceTier?: "fast" | "flex" | null;
}

class CodexSDKSession extends BaseSession {
  private config: SessionConfig;
  // biome-ignore lint/suspicious/noExplicitAny: SDK types not available at compile time
  private _codexInstance: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: SDK types not available at compile time
  private _thread: any = null;
  /** Tracks cumulative text length per item for delta extraction. */
  private _itemTextOffsets = new Map<string, number>();

  constructor(config: SessionConfig) {
    super({
      parentSessionId: config.parentSessionId,
      initialId: config.resumeThreadId,
    });
    this.config = config;
    // If resuming, treat the thread ID as already resolved
    if (config.resumeThreadId) {
      this._resolvedId = config.resumeThreadId;
    }
  }

  async *query(prompt: string): AsyncIterable<AIMessage> {
    const started = this.startQuery();
    if (!started) { yield BaseSession.BUSY_ERROR; return; }
    const { gen, signal } = started;

    this._itemTextOffsets.clear();

    try {
      const Codex = await getCodexClass();

      // Lazy-create the Codex instance
      if (!this._codexInstance) {
        this._codexInstance = new Codex({
          ...(this.config.codexExecutablePath && { codexPathOverride: this.config.codexExecutablePath }),
        });
      }

      // Lazy-create or resume the thread
      if (!this._thread) {
        if (this.config.resumeThreadId) {
          this._thread = this._codexInstance.resumeThread(this.config.resumeThreadId, {
            model: this.config.model,
            workingDirectory: this.config.cwd,
            sandboxMode: this.config.sandboxMode,
            ...(this.config.reasoningEffort && { modelReasoningEffort: this.config.reasoningEffort }),
            ...(this.config.serviceTier && { serviceTier: this.config.serviceTier }),
          });
        } else {
          this._thread = this._codexInstance.startThread({
            model: this.config.model,
            workingDirectory: this.config.cwd,
            sandboxMode: this.config.sandboxMode,
            ...(this.config.reasoningEffort && { modelReasoningEffort: this.config.reasoningEffort }),
            ...(this.config.serviceTier && { serviceTier: this.config.serviceTier }),
          });
        }
      }

      const effectivePrompt = buildEffectivePrompt(
        prompt,
        this.config.systemPrompt,
        this._firstQuerySent,
      );

      // Retry on "thread {id} is closing" — the Codex app-server rejects a
      // second writer while the user's terminal has the thread open.
      // The busy error surfaces during iteration (runStreamed returns a lazy
      // generator), so the retry wraps the entire runStreamed + for-await.
      // The loop exits in exactly three ways: `break` on success,
      // `throw err` for non-busy errors, `throw new CodexBusyError(err)`
      // after the final busy retry is exhausted.
      //
      // Retry safety: a fresh runStreamed replays the turn from the first
      // event. If the previous attempt already yielded any messages
      // downstream, retrying would duplicate them in the session manager's
      // broadcast and the client's transcript. Track `emittedThisAttempt`
      // and escalate past-first-emission failures as CodexBusyError
      // immediately — the user sees a clean "Codex is busy" instead of
      // duplicated text.
      for (let attempt = 0; attempt <= CODEX_BUSY_RETRY_DELAYS_MS.length; attempt++) {
        let emittedThisAttempt = false;
        try {
          const streamed = await this._thread.runStreamed(effectivePrompt, { signal });

          this._firstQuerySent = true;
          let turnFailed = false;

          for await (const event of streamed.events) {
            if (
              !this._resolvedId &&
              event.type === "thread.started" &&
              typeof event.thread_id === "string"
            ) {
              this.resolveId(event.thread_id);
            }

            if (event.type === "turn.failed") {
              turnFailed = true;
            }

            const mapped = mapCodexEvent(event, this._itemTextOffsets);
            for (const msg of mapped) {
              emittedThisAttempt = true;
              yield msg;
            }
          }

          if (!turnFailed) {
            yield { type: "result", sessionId: this.id, success: true };
          }
          break;
        } catch (err) {
          if (!isBusyError(err)) throw err;
          // If we've already yielded something, retrying would duplicate
          // that output on the next runStreamed pass. Surface the busy
          // error immediately rather than risk the double.
          if (emittedThisAttempt) {
            throw new CodexBusyError(err);
          }
          if (attempt === CODEX_BUSY_RETRY_DELAYS_MS.length) {
            throw new CodexBusyError(err);
          }
          this._itemTextOffsets.clear();
          await waitOrAbort(CODEX_BUSY_RETRY_DELAYS_MS[attempt]!, signal);
        }
      }
    } catch (err) {
      if (err instanceof CodexBusyError) {
        // User-facing message — the UI can match on `code: "codex_busy"`
        // to render a specific "wait for the current turn" prompt.
        yield {
          type: "error",
          error:
            "Codex is busy — wait for the current turn in your terminal to complete, then try again.",
          code: "codex_busy",
        };
      } else {
        yield {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
          code: "provider_error",
        };
      }
    } finally {
      this.endQuery(gen);
    }
  }

}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

/**
 * Map a Codex SDK ThreadEvent to one or more AIMessages.
 *
 * The itemTextOffsets map tracks cumulative text length per item ID
 * so we can extract true deltas from the cumulative text in item.updated events.
 */
function mapCodexEvent(
  event: Record<string, unknown>,
  itemTextOffsets: Map<string, number>,
): AIMessage[] {
  const eventType = event.type as string;

  switch (eventType) {
    case "thread.started":
    case "turn.started":
      return [];

    case "turn.completed":
      return [];

    case "turn.failed": {
      const error = event.error as Record<string, unknown> | undefined;
      return [{
        type: "error",
        error: (error?.message as string) ?? "Turn failed",
        code: "turn_failed",
      }];
    }

    case "error":
      return [{
        type: "error",
        error: (event.message as string) ?? "Unknown error",
        code: "codex_error",
      }];

    case "item.started":
    case "item.updated":
    case "item.completed":
      return mapCodexItem(event, itemTextOffsets);

    default:
      return [{ type: "unknown", raw: event }];
  }
}

/**
 * Map item-level events to AIMessages.
 */
function mapCodexItem(
  event: Record<string, unknown>,
  itemTextOffsets: Map<string, number>,
): AIMessage[] {
  const item = event.item as Record<string, unknown>;
  if (!item) return [{ type: "unknown", raw: event }];

  const eventType = event.type as string;
  const itemType = item.type as string;
  const itemId = (item.id as string) ?? "";
  const isStarted = eventType === "item.started";
  const isCompleted = eventType === "item.completed";

  switch (itemType) {
    case "agent_message": {
      const text = (item.text as string) ?? "";

      if (isStarted) {
        // Reset offset tracking for this item
        itemTextOffsets.set(itemId, 0);
        return [];
      }

      if (isCompleted) {
        // Emit final complete text
        itemTextOffsets.delete(itemId);
        return text ? [{ type: "text", text }] : [];
      }

      // item.updated — extract delta from cumulative text
      const prevOffset = itemTextOffsets.get(itemId) ?? 0;
      if (text.length > prevOffset) {
        const delta = text.slice(prevOffset);
        itemTextOffsets.set(itemId, text.length);
        return [{ type: "text_delta", delta }];
      }
      return [];
    }

    case "command_execution": {
      const messages: AIMessage[] = [];
      if (isStarted) {
        messages.push({
          type: "tool_use",
          toolName: "Bash",
          toolInput: { command: item.command as string },
          toolUseId: itemId,
        });
      }
      if (isCompleted) {
        const output = (item.aggregated_output as string) ?? "";
        const exitCode = item.exit_code as number | undefined;
        messages.push({
          type: "tool_result",
          toolUseId: itemId,
          result: exitCode != null ? `${output}\n[exit code: ${exitCode}]` : output,
        });
      }
      return messages;
    }

    case "file_change": {
      const changes = item.changes as Array<{ path: string; kind: string }> | undefined;
      if (isStarted || isCompleted) {
        return [{
          type: "tool_use",
          toolName: "FileChange",
          toolInput: { changes: changes ?? [] },
          toolUseId: itemId,
        }];
      }
      return [];
    }

    case "mcp_tool_call": {
      const messages: AIMessage[] = [];
      if (isStarted) {
        messages.push({
          type: "tool_use",
          toolName: `${item.server as string}/${item.tool as string}`,
          toolInput: (item.arguments as Record<string, unknown>) ?? {},
          toolUseId: itemId,
        });
      }
      if (isCompleted) {
        if (item.result != null) {
          messages.push({
            type: "tool_result",
            toolUseId: itemId,
            result: typeof item.result === "string" ? item.result : JSON.stringify(item.result),
          });
        }
        if (item.error) {
          const err = item.error as Record<string, unknown>;
          messages.push({
            type: "error",
            error: (err.message as string) ?? "MCP tool call failed",
            code: "mcp_error",
          });
        }
      }
      return messages;
    }

    case "error":
      return [{
        type: "error",
        error: (item.message as string) ?? "Unknown error",
      }];

    case "reasoning":
    case "web_search":
    case "todo_list":
      return [{ type: "unknown", raw: { eventType, item } }];

    default:
      return [{ type: "unknown", raw: { eventType, item } }];
  }
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export { mapCodexEvent, mapCodexItem };

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

import { registerProviderFactory } from "../provider.ts";

registerProviderFactory(
  PROVIDER_NAME,
  async (config) => new CodexSDKProvider(config as CodexSDKConfig)
);
