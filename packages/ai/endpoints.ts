/**
 * HTTP endpoint handlers for AI features.
 *
 * These handlers are provider-agnostic — they work with whatever AIProvider
 * is registered in the provided ProviderRegistry. They're designed to be
 * mounted into any Plannotator server (plan review, code review, annotate).
 *
 * Endpoints (static paths — dispatched via path-map):
 *   POST /api/ai/session       — Create or fork an AI session
 *   POST /api/ai/query         — Send a message; streams AIMessages back
 *                                AND writes them into the session transcript
 *                                broadcast channel (the new session stream).
 *   POST /api/ai/abort         — Abort the current query
 *   POST /api/ai/permission    — Respond to a permission_request; broadcasts
 *                                permission_resolved to session subscribers.
 *   GET  /api/ai/sessions      — List active sessions
 *   GET  /api/ai/capabilities  — Check if AI features are available
 *
 * Endpoints (parameterized — dispatched via `handleDynamic`):
 *   GET  /api/ai/session/:id/exists — 200/404 existence probe used by the
 *                                     client to decide reconnect vs fresh.
 *   GET  /api/ai/session/:id/stream — Persistent SSE of the transcript:
 *                                     `snapshot` on connect, `turn`/`delta`
 *                                     events as the conversation evolves,
 *                                     heartbeat comments every 30s.
 */

import type { AIContext, AIMessage, CreateSessionOptions } from "./types.ts";
import type { ProviderRegistry } from "./provider.ts";
import type { SessionManager } from "./session-manager.ts";
import { logResolvedContext, resolveChatContext, type ChatContextStrategy, type Harness, type LaunchMetadata } from "./resolve-context.ts";
import type { UserTurnContent, TurnStatus } from "@plannotator/shared/chat-transcript";

// ---------------------------------------------------------------------------
// Constants — SSE shape
// ---------------------------------------------------------------------------

/** Heartbeat comment. Kept local to avoid a packages/ai → packages/server import. */
const SSE_HEARTBEAT_COMMENT = ":\n\n";
const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Types for request/response
// ---------------------------------------------------------------------------

export interface CreateSessionRequest {
  /** The context mode and content for the session. */
  context: AIContext;
  /** Instance ID of the provider to use (optional — uses default if omitted). */
  providerId?: string;
  /** Optional model override. */
  model?: string;
  /** Max agentic turns. */
  maxTurns?: number;
  /** Max budget in USD. */
  maxBudgetUsd?: number;
  /** Reasoning effort — Codex maps to modelReasoningEffort, Claude to `effort`. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Extended-thinking config — Claude only today. See CreateSessionOptions. */
  thinking?:
    | { type: "adaptive" }
    | { type: "enabled"; budgetTokens: number }
    | { type: "disabled" };
  /** Service tier (Codex only). "fast" for priority processing. */
  serviceTier?: "fast" | "flex" | null;
}

export interface QueryRequest {
  /** The session ID to query. */
  sessionId: string;
  /** The user's prompt/question. */
  prompt: string;
  /** Optional context update (e.g., new annotations since session was created). */
  contextUpdate?: string;
  /**
   * Anchor metadata for the user turn — line range, file scope, selected
   * code. Stored on the transcript's user turn so snapshot rehydration
   * re-renders the question with its original chip/badge. Prompt text is
   * carried in `prompt` above; the anchor fields here are everything else.
   */
  anchor?: Omit<UserTurnContent, "prompt" | "clientQuestionId">;
  /**
   * Opaque client-generated ID for the user's optimistic entry. Round-tripped
   * on the user turn so snapshot rehydration can match the restored entry
   * back to the same local ID (avoids duplicate entries when the server
   * assigns its own turn UUID).
   */
  clientQuestionId?: string;
}

export interface AbortRequest {
  /** The session ID to abort. */
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface AIEndpointDeps {
  /** Provider registry (one per server or shared). */
  registry: ProviderRegistry;
  /** Session manager instance (one per server). */
  sessionManager: SessionManager;
  /** Resolve the current working directory for new AI sessions. */
  getCwd?: () => string;
  /**
   * Resolve the launch metadata this server was started with, if any.
   * Step 5 of Slice 1 PR 1 reads this in the session-creation handler and
   * runs it through `resolveChatContext` to pick a fork/resume/fresh strategy.
   * Returning `undefined` is the same as launching standalone — the session
   * will be `fresh`.
   */
  getLaunch?: () => LaunchMetadata | undefined;
  /**
   * Promote a `fork_by_heuristic` strategy into a concrete session id by
   * scanning the host's per-cwd session records. Wired to Claude Code's
   * `~/.claude/projects/` resolver cascade in the Bun server; keeps the
   * AI layer free of filesystem concerns. Returns null when no matching
   * session exists — caller falls back to `fresh`.
   */
  resolveHeuristicSession?: (cwd: string) => string | null;
  /**
   * Heartbeat helper injected from `packages/server/sse-utils.ts`. Kept as
   * an injected dep so `packages/ai` doesn't import from `packages/server`.
   * The session-stream endpoint uses it to keep SSE alive past proxy idle
   * timeouts and to evict dead controllers on enqueue failure. When absent,
   * the endpoint still works — the stream simply has no heartbeat.
   */
  startHeartbeat?: (
    controller: ReadableStreamDefaultController<Uint8Array>,
    options?: { intervalMs?: number; onFailure?: () => void },
  ) => () => void;
}

/**
 * Create the route handler map for AI endpoints.
 *
 * Usage in a Bun server:
 * ```ts
 * const aiHandlers = createAIEndpoints({ registry, sessionManager });
 *
 * // In your request handler:
 * if (url.pathname.startsWith('/api/ai/')) {
 *   const handler = aiHandlers[url.pathname];
 *   if (handler) return handler(req);
 * }
 * ```
 */
export function createAIEndpoints(deps: AIEndpointDeps) {
  const {
    registry,
    sessionManager,
    getCwd,
    getLaunch,
    resolveHeuristicSession,
    startHeartbeat,
  } = deps;

  // -------------------------------------------------------------------------
  // Static handlers — dispatched by path-map lookup in the server request loop.
  // -------------------------------------------------------------------------

  const routes = {
    "/api/ai/capabilities": async (_req: Request) => {
      const defaultEntry = registry.getDefault();
      const providerDetails = registry.list().map(id => {
        const p = registry.get(id)!;
        return {
          id,
          name: p.name,
          capabilities: p.capabilities,
          models: p.models ?? [],
        };
      });
      return Response.json({
        available: !!defaultEntry,
        providers: providerDetails,
        defaultProvider: defaultEntry?.id ?? null,
      });
    },

    "/api/ai/session": async (req: Request) => {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const body = (await req.json()) as CreateSessionRequest;
      const { context, providerId, model, maxTurns, maxBudgetUsd, reasoningEffort, thinking, serviceTier } = body;

      if (!context?.mode) {
        return Response.json(
          { error: "Missing context.mode" },
          { status: 400 }
        );
      }

      // Resolve the chat context strategy from the launch metadata the
      // server was booted with. The resolver itself is pure; the optional
      // heuristic-session promotion below is the one I/O step — it runs
      // only when the resolver returned fork_by_heuristic and the host
      // provided a `resolveHeuristicSession` callback.
      const launch = getLaunch?.();
      let strategy = launch ? resolveChatContext(launch) : null;

      // fork_by_heuristic handling:
      //   - with a resolver wired: scan host's session records, promote to
      //     fork_by_id on match, demote to fresh on miss.
      //   - without a resolver (the current default): demote to fresh
      //     unconditionally so the badge and behavior agree. fork_by_heuristic
      //     that never gets acted on would otherwise show as "forked" in the
      //     UI while the actual session is fresh.
      if (strategy?.kind === "fork_by_heuristic") {
        if (resolveHeuristicSession) {
          const matched = resolveHeuristicSession(strategy.cwd);
          strategy = matched
            ? {
                kind: "fork_by_id",
                harness: strategy.harness,
                sessionId: matched,
              }
            : {
                kind: "fresh",
                harness: strategy.harness,
                reason: "no matching session found for cwd",
              };
        } else {
          strategy = {
            kind: "fresh",
            harness: strategy.harness,
            reason: "heuristic fork disabled",
          };
        }
      }

      if (launch && strategy) {
        logResolvedContext(launch, strategy);
      }

      // Resolve provider: explicit ID > harness-matched > default.
      // When launched from a specific harness (e.g., Codex shell-out),
      // prefer the matching provider so the strategy's session/thread
      // IDs reach the right adapter instead of being fed to a
      // mismatched provider that can't use them.
      const harnessProvider = strategy?.harness
        ? resolveProviderForHarness(registry, strategy.harness)
        : undefined;
      const provider = providerId
        ? registry.get(providerId)
        : harnessProvider ?? registry.getDefault()?.provider;

      if (!provider) {
        return Response.json(
          { error: providerId ? `Provider "${providerId}" not found` : "No AI provider available" },
          { status: 503 }
        );
      }

      // Demote strategy when an explicit provider was picked that doesn't
      // match the launch harness. Otherwise we'd feed a Codex thread id
      // to the Claude adapter (or similar cross-harness misroute). The
      // user's provider choice wins; the inherited context is dropped.
      if (
        providerId &&
        strategy &&
        strategy.kind !== "fresh" &&
        provider.name !== HARNESS_TO_PROVIDER[strategy.harness]
      ) {
        strategy = {
          kind: "fresh",
          harness: strategy.harness,
          reason: `explicit provider "${providerId}" does not match harness "${strategy.harness}"`,
        };
      }

      // Inheritance is PICKER-DRIVEN only. The launch resolver's strategy
      // (Claude hook session_id, Codex CODEX_THREAD_ID, etc.) is no longer
      // auto-executed — if it were, a user launching from inside a Claude
      // session, or with CODEX_THREAD_ID set, would silently inherit that
      // context even though the UI defaults to "New chat". Especially bad
      // for Codex `resume`, which writes our messages into their terminal
      // thread without explicit opt-in.
      //
      // The launch candidate still appears in the Context picker's list
      // (so it's one click away), but auto-execution is gone.
      if (!context.parent && strategy && strategy.kind !== "fresh") {
        strategy = {
          kind: "fresh",
          harness: strategy.harness,
          reason: "client did not request inheritance (defaulted to New chat)",
        };
      }

      try {
        const options: CreateSessionOptions = {
          context,
          cwd: getCwd?.(),
          model,
          maxTurns,
          maxBudgetUsd,
          reasoningEffort,
          thinking,
          serviceTier,
        };

        // Execution is driven solely by `context.parent` (set by the user
        // via the Context picker). If the parent is absent, we createSession
        // regardless of any launch strategy. If it's present, routing uses
        // provider capabilities to pick fork vs resume.
        const parentSupportsFork = !!context.parent && provider.capabilities.fork;
        const parentForceResume =
          !!context.parent && !provider.capabilities.fork && provider.capabilities.resume;
        const wantFork = parentSupportsFork;
        const wantResume = parentForceResume;

        // Harness label to stamp on synthesized strategy when the picker
        // triggers inheritance. The candidate came from the *active*
        // provider's `listForkCandidates`, so the provider is the source
        // of truth — not the launch. If the user launches from Claude
        // Code and switches to Codex, a Codex-thread resume must badge
        // as "Codex", not "Claude". `launch.harness` only applies when
        // the provider isn't in the map (future providers).
        const harnessForStrategy: Harness =
          (PROVIDER_TO_HARNESS[provider.name] as Harness | undefined)
          ?? launch?.harness
          ?? "standalone";

        let session;
        if (wantFork) {
          try {
            session = await provider.forkSession(options);
            // Picker-driven fork succeeded — overwrite strategy so the
            // badge/snapshot honestly reflect the parent chain.
            strategy = {
              kind: "fork_by_id",
              harness: harnessForStrategy,
              sessionId: (context.parent?.sessionId as string | undefined) ?? "",
              ...(context.parent?.sessionPath && {
                sessionPath: context.parent.sessionPath as string,
              }),
              ...(context.parent?.entryId && {
                entryId: context.parent.entryId as string,
              }),
            };
          } catch (err) {
            // Provider refused fork (e.g. Pi without entryId, or other
            // fork-time validation failure). If the provider also
            // supports resume and we can derive a resume id from the
            // parent, try resume. Otherwise fall back to createSession.
            console.warn(
              `[plannotator] forkSession failed, trying fallback: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            const resumeIdFromParent = deriveResumeIdFromParent(context.parent);
            if (provider.capabilities.resume && resumeIdFromParent) {
              try {
                session = await provider.resumeSession(resumeIdFromParent);
                // Fork→resume fallback succeeded — reflect resume in the
                // strategy so the badge doesn't claim we forked.
                strategy = {
                  kind: "resume_by_id",
                  harness: harnessForStrategy,
                  threadId: resumeIdFromParent,
                  ...(context.parent?.sessionPath && {
                    sessionPath: context.parent.sessionPath as string,
                  }),
                };
              } catch (resumeErr) {
                console.warn(
                  `[plannotator] resumeSession fallback failed: ${
                    resumeErr instanceof Error ? resumeErr.message : String(resumeErr)
                  }`,
                );
                session = await provider.createSession(options);
                strategy = strategy
                  ? {
                      kind: "fresh",
                      harness: strategy.harness,
                      reason: `fork + resume both failed: ${
                        err instanceof Error ? err.message : String(err)
                      }`,
                    }
                  : strategy;
              }
            } else {
              session = await provider.createSession(options);
              strategy = strategy
                ? {
                    kind: "fresh",
                    harness: strategy.harness,
                    reason: `fork failed: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  }
                : strategy;
            }
          }
        } else if (wantResume) {
          // Derive resume id from either the resolved strategy (launch path)
          // or the user-picked parent (Context picker path).
          let resumeId: string | undefined;
          if (strategy?.kind === "resume_by_id") {
            resumeId = strategy.sessionPath ?? strategy.threadId;
          } else if (context.parent) {
            resumeId = deriveResumeIdFromParent(context.parent);
          }
          if (!resumeId) {
            // Neither channel produced an id — drop to fresh rather than
            // calling provider.resumeSession with undefined.
            session = await provider.createSession(options);
            strategy = strategy
              ? { kind: "fresh", harness: strategy.harness, reason: "no resume id" }
              : strategy;
          } else {
            try {
              session = await provider.resumeSession(resumeId);
              // Picker-driven resume succeeded — synthesize strategy so
              // badge/snapshot truthfully show "resumed".
              strategy = {
                kind: "resume_by_id",
                harness: harnessForStrategy,
                threadId: resumeId,
                ...(context.parent?.sessionPath && {
                  sessionPath: context.parent.sessionPath as string,
                }),
              };
            } catch (err) {
              console.warn(
                `[plannotator] resumeSession failed, falling back to createSession: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
              session = await provider.createSession(options);
              strategy = strategy
                ? {
                    kind: "fresh",
                    harness: strategy.harness,
                    reason: `resume failed: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  }
                : strategy;
            }
          }
        } else {
          session = await provider.createSession(options);
        }

        const entry = sessionManager.track(session, context.mode, { strategy });

        return Response.json({
          sessionId: session.id,
          parentSessionId: session.parentSessionId,
          mode: context.mode,
          createdAt: entry.createdAt,
          strategy,
        });
      } catch (err) {
        return Response.json(
          {
            error:
              err instanceof Error ? err.message : "Failed to create session",
          },
          { status: 500 }
        );
      }
    },

    "/api/ai/query": async (req: Request) => {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const body = (await req.json()) as QueryRequest;
      const { sessionId, prompt, contextUpdate, anchor, clientQuestionId } = body;

      if (!sessionId || !prompt) {
        return Response.json(
          { error: "Missing sessionId or prompt" },
          { status: 400 }
        );
      }

      const entry = sessionManager.get(sessionId);
      if (!entry) {
        return Response.json(
          { error: "Session not found" },
          { status: 404 }
        );
      }

      sessionManager.touch(sessionId);

      // If context update provided, prepend it to the prompt
      const effectivePrompt = contextUpdate
        ? `[Context update: the user has made changes since this conversation started]\n${contextUpdate}\n\n${prompt}`
        : prompt;

      // Set label from first query if not already set
      if (!entry.label) {
        entry.label = prompt.slice(0, 80);
      }

      // Open the user→assistant turn pair on the transcript. Anchor fields
      // (line range, file scope, selected code) live on the user turn so
      // snapshot rehydration re-renders the question with its chip/badge.
      // `clientQuestionId` is stored opaquely so rehydration can match the
      // restored entry back to the client's local state.
      const userContent: UserTurnContent = {
        prompt,
        ...anchor,
        ...(clientQuestionId && { clientQuestionId }),
      };
      const assistantTurnId = sessionManager.startUserTurn(
        sessionId,
        userContent,
      );
      if (!assistantTurnId) {
        // Race: session evicted between `get` and `startUserTurn`.
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      // Stream the response using Server-Sent Events (SSE).
      //
      // Two channels receive every message now:
      //  1. This request's response body (kept for backward compat; the new
      //     client connects to /stream instead and may ignore this body).
      //  2. The session's transcript broadcast via appendMessage — feeds
      //     all /api/ai/session/:id/stream subscribers for this session.
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          let finalStatus: TurnStatus = "complete";
          let legacyBodyOpen = true;
          const legacyEnqueue = (frame: Uint8Array): void => {
            // The legacy response body may be cancelled by the client long
            // before the provider stream finishes (user closes the tab that
            // initiated the POST while other tabs are still subscribed to
            // the session stream). Ignore the throw so appendMessage keeps
            // feeding the canonical transcript for everyone else.
            if (!legacyBodyOpen) return;
            try {
              controller.enqueue(frame);
            } catch {
              legacyBodyOpen = false;
            }
          };
          try {
            for await (const message of entry.session.query(effectivePrompt)) {
              // Broadcast to session-stream subscribers first (new path).
              // Pass our own `assistantTurnId` so the message lands on THIS
              // request's turn even if another tab opened a newer turn in
              // the meantime (multi-tab same-session concurrency).
              sessionManager.appendMessage(sessionId, assistantTurnId, message);
              // Mirror into this request's response body (legacy path).
              const data = JSON.stringify(message);
              legacyEnqueue(encoder.encode(`data: ${data}\n\n`));
              // Track terminal status so finalizeTurn below respects
              // `result: { success: false }` (the accumulator already sets
              // turn.status = "error" in that case, but finalizeTurn's
              // full-turn broadcast would otherwise overwrite it).
              if (message.type === "error") {
                finalStatus = "error";
              } else if (
                message.type === "result" &&
                message.success === false
              ) {
                finalStatus = "error";
              }
            }
            legacyEnqueue(encoder.encode("data: [DONE]\n\n"));
          } catch (err) {
            finalStatus = "error";
            const errorMsg: AIMessage = {
              type: "error",
              error: err instanceof Error ? err.message : String(err),
              code: "stream_error",
            };
            // Broadcast into the transcript too so reconnecting clients
            // see the error. Same turn-scoped addressing as above.
            sessionManager.appendMessage(sessionId, assistantTurnId, errorMsg);
            legacyEnqueue(
              encoder.encode(`data: ${JSON.stringify(errorMsg)}\n\n`),
            );
          } finally {
            // Abort surfaces three ways depending on provider:
            //   1. Clean generator return (no error thrown, no error msg) —
            //      finalStatus still "complete" when we arrive here.
            //   2. AbortError (or similar) thrown mid-iteration — finalStatus
            //      was flipped to "error" by the catch above.
            //   3. Provider emits an error message — same as (2).
            // In all three, the user's abort is the authoritative truth, so
            // prefer "aborted" whenever the abort endpoint flipped the flag.
            // The error message (when present) stays on the transcript via
            // appendMessage above, so no context is lost.
            const refreshed = sessionManager.get(sessionId);
            const effectiveStatus: TurnStatus = refreshed?.abortRequested
              ? "aborted"
              : finalStatus;
            sessionManager.finalizeTurn(
              sessionId,
              assistantTurnId,
              effectiveStatus,
            );
            try {
              controller.close();
            } catch {
              /* already closed by client cancel */
            }
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },

    "/api/ai/abort": async (req: Request) => {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const body = (await req.json()) as AbortRequest;
      const entry = sessionManager.get(body.sessionId);
      if (!entry) {
        return Response.json(
          { error: "Session not found" },
          { status: 404 }
        );
      }

      // Record the abort intent on the session entry so the query handler's
      // finally can tag the turn as status="aborted" even if the provider's
      // generator returns cleanly (no thrown error, no error message).
      sessionManager.markAbortRequested(body.sessionId);
      entry.session.abort();
      return Response.json({ ok: true });
    },

    "/api/ai/permission": async (req: Request) => {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const body = (await req.json()) as {
        sessionId: string;
        requestId: string;
        allow: boolean;
        message?: string;
      };

      if (!body.sessionId || !body.requestId) {
        return Response.json(
          { error: "Missing sessionId or requestId" },
          { status: 400 }
        );
      }

      const entry = sessionManager.get(body.sessionId);
      if (!entry) {
        return Response.json(
          { error: "Session not found" },
          { status: 404 }
        );
      }

      entry.session.respondToPermission?.(
        body.requestId,
        body.allow,
        body.message,
      );

      // Single call to `appendMessage`: it both folds the resolution into
      // the active assistant turn (so snapshots reflect it) AND broadcasts
      // a `{type: "delta", turnId, message}` event to all connected
      // subscribers (so live clients update immediately).
      // `accumulateTurn`'s `permission_resolved` branch flips the
      // `resolved`/`allowed` fields on the matching permission request.
      //
      // Contract: `permission_request` messages are emitted only while a
      // query is active (BaseSession serializes queries), so `entry
      // .activeAssistantTurnId` is the turn that owns this request.
      // If nothing is active (late permission response arriving after
      // the turn was already finalized), skip the append — the request
      // has no surviving home.
      if (entry.activeAssistantTurnId) {
        sessionManager.appendMessage(body.sessionId, entry.activeAssistantTurnId, {
          type: "permission_resolved",
          requestId: body.requestId,
          allowed: body.allow,
        });
      }

      return Response.json({ ok: true });
    },

    "/api/ai/sessions": async (_req: Request) => {
      const entries = sessionManager.list();
      return Response.json(
        entries.map((e) => ({
          sessionId: e.session.id,
          mode: e.mode,
          parentSessionId: e.parentSessionId,
          createdAt: e.createdAt,
          lastActiveAt: e.lastActiveAt,
          isActive: e.session.isActive,
          label: e.label,
        }))
      );
    },

    /**
     * List fork/resume candidates for the Context picker. Query params:
     *   - cwd:        absolute path to the user's working directory
     *   - providerId: instance id from the provider registry
     * Returns `{ providerName, candidates }` — providerName is returned so
     * the client can skip rendering stale results if the user switched
     * provider while the request was in flight.
     */
    "/api/ai/fork-candidates": async (req: Request) => {
      if (req.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      const url = new URL(req.url);
      const cwd = url.searchParams.get("cwd") ?? getCwd?.() ?? "";
      const providerId = url.searchParams.get("providerId");
      const provider = providerId
        ? registry.get(providerId)
        : registry.getDefault()?.provider;
      if (!provider) {
        return Response.json(
          { error: "Provider not found", providerName: null, candidates: [] },
          { status: 404 },
        );
      }
      if (!provider.listForkCandidates) {
        return Response.json({ providerName: provider.name, candidates: [] });
      }
      try {
        const candidates = await provider.listForkCandidates(cwd, 5);
        return Response.json({ providerName: provider.name, candidates });
      } catch (err) {
        return Response.json(
          {
            providerName: provider.name,
            candidates: [],
            error: err instanceof Error ? err.message : String(err),
          },
          { status: 200 },
        );
      }
    },
  } as const;

  // -------------------------------------------------------------------------
  // Parameterized handlers — dispatched by the server's request loop after
  // the path-map misses. `handleDynamic` returns null for non-AI paths so
  // the caller can fall through to the 404 it already has.
  // -------------------------------------------------------------------------

  const SESSION_STREAM_RE = /^\/api\/ai\/session\/([^/]+)\/stream$/;
  const SESSION_EXISTS_RE = /^\/api\/ai\/session\/([^/]+)\/exists$/;

  async function handleDynamic(
    req: Request,
    url: URL,
  ): Promise<Response | null> {
    // /api/ai/session/:id/exists — lightweight probe for the client to
    // decide reconnect vs fresh.
    const existsMatch = url.pathname.match(SESSION_EXISTS_RE);
    if (existsMatch) {
      if (req.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      const sessionId = decodeURIComponent(existsMatch[1]!);
      const entry = sessionManager.get(sessionId);
      return entry
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 404 });
    }

    // /api/ai/session/:id/stream — persistent SSE. On connect, emits a
    // `snapshot` event carrying the full transcript + resolved strategy,
    // then tails `turn`/`delta` events as the session evolves. Heartbeat
    // every 30s keeps the connection alive through proxies.
    const streamMatch = url.pathname.match(SESSION_STREAM_RE);
    if (streamMatch) {
      if (req.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      const sessionId = decodeURIComponent(streamMatch[1]!);
      const entry = sessionManager.get(sessionId);
      if (!entry) {
        return new Response(null, { status: 404 });
      }

      const encoder = new TextEncoder();
      let unsubscribe: (() => void) | null = null;
      let stopHeartbeat: (() => void) | null = null;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Emit snapshot immediately so the client can rehydrate before
          // any tail event arrives.
          const snapshot = {
            type: "snapshot",
            turns: entry.transcript,
            strategy: entry.strategy,
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`),
          );

          unsubscribe = sessionManager.subscribe(sessionId, controller);

          // Race: the session could have been evicted between the initial
          // `get(sessionId)` above and this subscribe. `subscribe` on a
          // missing session returns a no-op unsubscribe, so the controller
          // would never receive further events — the client would hang
          // until it disconnected on its own. Close explicitly so the
          // client's EventSource errors out and flows through the
          // `/exists` 404 → cookie-clear → fresh-session path.
          if (!sessionManager.get(sessionId)) {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            return;
          }

          // Prefer the injected helper (packages/server/sse-utils) so dead
          // controllers get evicted via onFailure. Fall back to a local
          // interval if no helper was provided (e.g. test harnesses).
          if (startHeartbeat) {
            stopHeartbeat = startHeartbeat(controller, {
              intervalMs: SSE_HEARTBEAT_INTERVAL_MS,
              onFailure: () => {
                unsubscribe?.();
              },
            });
          } else {
            const timer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(SSE_HEARTBEAT_COMMENT));
              } catch {
                clearInterval(timer);
                unsubscribe?.();
              }
            }, SSE_HEARTBEAT_INTERVAL_MS);
            stopHeartbeat = () => clearInterval(timer);
          }

          // If the client disconnects, the ReadableStream's cancel hook
          // fires. Abort signal handles mid-snapshot disconnects too.
          req.signal.addEventListener(
            "abort",
            () => {
              unsubscribe?.();
              stopHeartbeat?.();
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            },
            { once: true },
          );
        },
        cancel() {
          unsubscribe?.();
          stopHeartbeat?.();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return null;
  }

  return { ...routes, handleDynamic } as const;
}

export type AIEndpoints = ReturnType<typeof createAIEndpoints>;

// ---------------------------------------------------------------------------
// Harness → provider mapping
// ---------------------------------------------------------------------------

const HARNESS_TO_PROVIDER: Record<string, string> = {
  "claude-code": "claude-agent-sdk",
  opencode: "opencode-sdk",
  codex: "codex-sdk",
  pi: "pi-sdk",
};

/** Inverse of HARNESS_TO_PROVIDER — used to stamp the harness on a
 *  strategy synthesized from a picker-driven fork/resume (no launch). */
const PROVIDER_TO_HARNESS: Record<string, string> = Object.fromEntries(
  Object.entries(HARNESS_TO_PROVIDER).map(([h, p]) => [p, h]),
);

function resolveProviderForHarness(
  registry: ProviderRegistry,
  harness: string,
): ReturnType<ProviderRegistry["get"]> {
  const name = HARNESS_TO_PROVIDER[harness];
  if (!name) return undefined;
  return registry.getByType(name)[0];
}

/**
 * Derive a provider-appropriate resume id from the user-picked parent
 * payload. Codex uses `threadId`; Pi uses `sessionPath`. Claude and
 * OpenCode don't take this path (they fork via `context.parent`), but
 * falling back to `sessionId` keeps the helper total.
 */
function deriveResumeIdFromParent(
  parent: { sessionId?: string; sessionPath?: string; threadId?: string } | undefined,
): string | undefined {
  if (!parent) return undefined;
  // Codex carries threadId; Pi resume carries sessionPath; Claude/OpenCode
  // sessionId is a last-resort fallback (not typically taken — those
  // providers support fork and would've handled the parent there).
  return parent.threadId ?? parent.sessionPath ?? parent.sessionId;
}
