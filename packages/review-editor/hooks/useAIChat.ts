import { useState, useCallback, useRef, useEffect } from 'react';
import type { AIQuestion, AIResponse } from '@plannotator/ui/types';
import { generateId } from '../utils/generateId';
import { getItem, setItem, removeItem } from '@plannotator/ui/utils/storage';
import type {
  ChatTurn,
  UserTurnContent,
  AssistantTurnContent,
} from '@plannotator/shared/chat-transcript';

// Canonical strategy type lives in @plannotator/shared/chat-context — the
// same shape the server writes into the session snapshot. Re-exported here
// so existing `from '../hooks/useAIChat'` imports keep working.
export type { ChatContextStrategy } from '@plannotator/shared/chat-context';
import type { ChatContextStrategy } from '@plannotator/shared/chat-context';

/**
 * Cookie key for the code-review chat session ID, scoped by port so two
 * review servers on the same host don't overwrite each other's session.
 * (Cookies are host+path scoped, NOT port-scoped — RFC 6265.)
 */
const CHAT_SESSION_COOKIE = `plannotator-chat-session-review-${typeof location !== 'undefined' ? location.port : '0'}`;

// ---------------------------------------------------------------------------
// Transcript → entries mapping
//
// The server-canonical transcript uses `ChatTurn[]` (user + assistant pairs);
// the UI consumes `AIChatEntry[]` (pairs flattened into a single entry each).
// Below are two pure helpers used by the EventSource handlers.
// ---------------------------------------------------------------------------

/**
 * Convert a ChatTurn array (the server snapshot) into AIChatEntry rows.
 *
 * Entry IDs prefer `userContent.clientQuestionId` if present (the client
 * stamp that survived the round-trip) so a rehydrated snapshot reuses the
 * same local IDs the client had before refresh. Falls back to the server's
 * turn id when no clientQuestionId was sent (e.g., legacy request bodies).
 */
function turnsToEntries(turns: ChatTurn[]): AIChatEntry[] {
  const entries: AIChatEntry[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.role !== 'user') continue;
    const userContent = turn.content as UserTurnContent;
    const entryId = userContent.clientQuestionId ?? turn.id;
    const question: AIQuestion = {
      id: entryId,
      prompt: userContent.displayPrompt ?? userContent.prompt,
      filePath: userContent.filePath,
      lineStart: userContent.lineStart,
      lineEnd: userContent.lineEnd,
      side: userContent.side,
      selectedCode: userContent.selectedCode,
      createdAt: turn.createdAt,
    };
    // Pair with the next assistant turn if present.
    const next = turns[i + 1];
    const assistantContent =
      next && next.role === 'assistant'
        ? (next.content as AssistantTurnContent)
        : null;
    const response: AIResponse = {
      questionId: entryId,
      text: assistantContent?.text ?? '',
      thinking: assistantContent?.thinking || undefined,
      isStreaming: next?.status === 'streaming',
      error: assistantContent?.error,
      createdAt: next?.createdAt ?? turn.createdAt,
    };
    entries.push({ question, response });
    if (next && next.role === 'assistant') i++;
  }
  return entries;
}

/**
 * Extract unresolved permission requests from the transcript's assistant
 * turns so a reconnecting tab can render pending-permission UI. Filters out
 * resolved requests — they're cosmetic-only after the fact.
 */
function unresolvedPermissionsFromTurns(turns: ChatTurn[]): PendingPermission[] {
  const out: PendingPermission[] = [];
  for (const turn of turns) {
    if (turn.role !== 'assistant') continue;
    const c = turn.content as AssistantTurnContent;
    for (const pr of c.permissionRequests ?? []) {
      if (pr.resolved) continue;
      out.push({
        requestId: pr.id,
        toolName: pr.toolName,
        toolInput: pr.toolInput,
        title: pr.title,
        displayName: pr.displayName,
        description: pr.description,
        toolUseId: pr.id, // server-only requests don't re-expose toolUseId
      });
    }
  }
  return out;
}

/**
 * Upsert an entry from a single turn event. User turns create/replace
 * a question; assistant turns merge into the trailing entry's response.
 * Unmatched assistant turns (no preceding user entry) are ignored — they
 * shouldn't happen under current server logic but we stay defensive.
 */
function upsertEntryFromTurn(
  prev: AIChatEntry[],
  turn: ChatTurn,
): AIChatEntry[] {
  if (turn.role === 'user') {
    const userContent = turn.content as UserTurnContent;
    const entryId = userContent.clientQuestionId ?? turn.id;
    const existing = prev.findIndex((m) => m.question.id === entryId);
    const question: AIQuestion = {
      id: entryId,
      prompt: userContent.displayPrompt ?? userContent.prompt,
      filePath: userContent.filePath,
      lineStart: userContent.lineStart,
      lineEnd: userContent.lineEnd,
      side: userContent.side,
      selectedCode: userContent.selectedCode,
      createdAt: turn.createdAt,
    };
    if (existing >= 0) {
      return prev.map((m, i) => (i === existing ? { ...m, question } : m));
    }
    // New user turn — push a placeholder response; the matching assistant
    // turn arrives in a separate broadcast.
    return [
      ...prev,
      {
        question,
        response: {
          questionId: entryId,
          text: '',
          isStreaming: true,
          createdAt: turn.createdAt,
        },
      },
    ];
  }

  // Assistant turn: find the entry that's still streaming and update it.
  // Queries are sequential (one at a time per session), so there's at most
  // one streaming entry. Falls back to the last entry if none are streaming.
  if (turn.role === 'assistant') {
    const assistantContent = turn.content as AssistantTurnContent;
    if (prev.length === 0) return prev;
    let targetIdx = prev.findIndex((m) => m.response.isStreaming);
    if (targetIdx < 0) targetIdx = prev.length - 1;
    const target = prev[targetIdx]!;
    const response: AIResponse = {
      questionId: target.question.id,
      text: assistantContent.text,
      thinking: assistantContent.thinking || undefined,
      isStreaming: turn.status === 'streaming',
      error: assistantContent.error,
      createdAt: turn.createdAt,
    };
    return prev.map((m, i) =>
      i === targetIdx ? { ...m, response } : m,
    );
  }

  return prev;
}

export interface AIChatEntry {
  question: AIQuestion;
  response: AIResponse;
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseId: string;
  decided?: 'allow' | 'deny';
}

interface UseAIChatOptions {
  patch: string;
  providerId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  thinking?: 'adaptive' | 'disabled' | null;
  /**
   * Provider-specific fork/resume parent fields from the Context picker.
   * When present, sent as `context.parent` on POST /api/ai/session so the
   * endpoint's existing fork/resume routing takes over.
   */
  contextParent?: Record<string, unknown> | null;
}

interface AskParams {
  prompt: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  side?: 'old' | 'new';
  selectedCode?: string;
}

export function useAIChat({ patch, providerId, model, reasoningEffort, thinking, contextParent }: UseAIChatOptions) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AIChatEntry[]>([]);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionRequests, setPermissionRequests] = useState<PendingPermission[]>([]);
  /**
   * Resolved chat-context strategy. Populated from the session-creation
   * response and the session stream's snapshot event. Consumed by Slice 1
   * PR 2's context badge. Null until the server has resolved a strategy.
   */
  const [strategy, setStrategy] = useState<ChatContextStrategy | null>(null);
  /**
   * True while the session stream is reconnecting after a transient failure.
   * The UI shows a muted "Reconnecting…" pill when this is true and the
   * reconnect takes longer than the fast-path threshold.
   */
  const [isReconnecting, setIsReconnecting] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // Keep ref in sync for use inside async callbacks
  sessionIdRef.current = sessionId;

  const createSession = useCallback(async (signal: AbortSignal): Promise<string> => {
    setIsCreatingSession(true);
    try {
      const res = await fetch('/api/ai/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            mode: 'code-review',
            review: { patch },
            // Only spread parent when the user explicitly picked a fork/resume
            // candidate from the Context dropdown. Absence means "fresh chat".
            ...(contextParent && { parent: contextParent }),
          },
          ...(providerId && { providerId }),
          ...(model && { model }),
          ...(reasoningEffort && { reasoningEffort }),
          ...(thinking && { thinking: { type: thinking } }),
        }),
        signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to create AI session' }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = await res.json() as {
        sessionId: string;
        strategy?: ChatContextStrategy | null;
      };
      setSessionId(data.sessionId);
      if (data.strategy) setStrategy(data.strategy);
      // Persist so a browser refresh can reconnect to the same server-side
      // session. The next mount's cookie-probe effect reads this back.
      setItem(CHAT_SESSION_COOKIE, data.sessionId);
      return data.sessionId;
    } finally {
      setIsCreatingSession(false);
    }
  }, [patch, providerId, model, reasoningEffort, thinking, contextParent]);

  const ask = useCallback(async (params: AskParams) => {
    // Abort any in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);

    const questionId = generateId();
    const question: AIQuestion = {
      id: questionId,
      prompt: params.prompt,
      filePath: params.filePath,
      lineStart: params.lineStart,
      lineEnd: params.lineEnd,
      side: params.side,
      selectedCode: params.selectedCode,
      createdAt: Date.now(),
    };

    const response: AIResponse = {
      questionId,
      text: '',
      thinking: undefined,
      isStreaming: true,
      createdAt: Date.now(),
    };

    // Add the message pair immediately so the UI shows the question
    setMessages(prev => [...prev, { question, response }]);
    setIsStreaming(true);

    try {
      // Lazy session creation
      let sid = sessionIdRef.current;
      if (!sid) {
        sid = await createSession(controller.signal);
      }

      // Build the prompt with context based on scope
      let fullPrompt = params.prompt;
      if (params.filePath && params.lineStart != null && params.lineEnd != null) {
        // Line-scoped
        const lineRef = params.lineStart === params.lineEnd
          ? `line ${params.lineStart}`
          : `lines ${params.lineStart}-${params.lineEnd}`;
        const sideLabel = params.side === 'new' ? 'new (added)' : 'old (removed)';
        const codeBlock = params.selectedCode
          ? `\n\`\`\`\n${params.selectedCode}\n\`\`\`\n`
          : '';
        fullPrompt = `Re: ${params.filePath}, ${lineRef} (${sideLabel} side)${codeBlock}\n${params.prompt}`;
      } else if (params.filePath) {
        // File-scoped
        fullPrompt = `Re: ${params.filePath} (entire file)\n\n${params.prompt}`;
      }
      // else: general — use prompt as-is

      // Anchor metadata alongside the prose-formatted prompt. The `prompt`
      // field above already carries the "Re: file, lines N-M..." prefix
      // for the model; this structured anchor survives through the
      // transcript so snapshot rehydration after a refresh can re-render
      // the line-range chip + file badge on the user's question bubble
      // (otherwise the UI would only see the raw prose blob).
      const anchor = params.filePath
        ? {
            displayPrompt: params.prompt,
            scope: (params.lineStart != null && params.lineEnd != null
              ? 'line'
              : 'file') as 'line' | 'file',
            filePath: params.filePath,
            lineStart: params.lineStart,
            lineEnd: params.lineEnd,
            side: params.side,
            selectedCode: params.selectedCode,
          }
        : undefined;

      // Start SSE stream. `clientQuestionId` is our local ID for the
      // optimistic entry we already added to state above; sending it so
      // the server can round-trip it on the user turn. Snapshot
      // rehydration after a refresh uses this to match the restored entry
      // back to the same `question.id` we created locally — without it,
      // the snapshot creates a new entry with the server turn id and
      // clobbers any in-flight optimistic state.
      const res = await fetch('/api/ai/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sid,
          prompt: fullPrompt,
          clientQuestionId: questionId,
          ...(anchor && { anchor }),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({ error: 'Query failed' }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // Parse SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const msg = JSON.parse(data);

            if (msg.type === 'text_delta') {
              setMessages(prev =>
                prev.map(m =>
                  // Skip if the session-stream already finalized this turn
                  // (turn=complete event applied isStreaming=false). Late
                  // POST-body deltas would otherwise append onto the final
                  // text, duplicating its tail.
                  m.question.id === questionId && m.response.isStreaming
                    ? { ...m, response: { ...m.response, text: m.response.text + msg.delta } }
                    : m
                )
              );
            } else if (msg.type === 'thinking_delta') {
              setMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId && m.response.isStreaming
                    ? { ...m, response: { ...m.response, thinking: (m.response.thinking ?? '') + msg.delta } }
                    : m
                )
              );
            } else if (msg.type === 'text') {
              // Complete text from assistant message — only use if we have no
              // streaming content yet (deltas already accumulated the same text).
              setMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId && !m.response.text
                    ? { ...m, response: { ...m.response, text: msg.text } }
                    : m
                )
              );
            } else if (msg.type === 'permission_request') {
              // Dedup by requestId: the EventSource session stream also
              // delivers this event (via appendMessage's broadcast), and
              // either channel can win the race to the client. Without
              // this guard, duplicate permission cards appear.
              setPermissionRequests(prev => {
                if (prev.some(p => p.requestId === msg.requestId)) return prev;
                return [...prev, {
                  requestId: msg.requestId,
                  toolName: msg.toolName,
                  toolInput: msg.toolInput,
                  title: msg.title,
                  displayName: msg.displayName,
                  description: msg.description,
                  toolUseId: msg.toolUseId,
                }];
              });
            } else if (msg.type === 'error') {
              setMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId
                    ? { ...m, response: { ...m.response, error: msg.error, isStreaming: false } }
                    : m
                )
              );
              setError(msg.error);
            } else if (msg.type === 'result') {
              setMessages(prev =>
                prev.map(m => {
                  if (m.question.id !== questionId) return m;
                  const resultText = msg.result ?? '';
                  return {
                    ...m,
                    response: {
                      ...m.response,
                      text: m.response.text || resultText,
                      isStreaming: false,
                    },
                  };
                })
              );
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }

      // Finalize if not already done
      setMessages(prev =>
        prev.map(m =>
          m.question.id === questionId && m.response.isStreaming
            ? { ...m, response: { ...m.response, isStreaming: false } }
            : m
        )
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;

      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setMessages(prev =>
        prev.map(m =>
          m.question.id === questionId
            ? { ...m, response: { ...m.response, error: message, isStreaming: false } }
            : m
        )
      );
    } finally {
      if (abortRef.current === controller) {
        setIsStreaming(false);
        abortRef.current = null;
      }
    }
  }, [createSession]);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setIsStreaming(false);
    }
    // Also tell the server to abort
    if (sessionIdRef.current) {
      fetch('/api/ai/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionIdRef.current }),
      }).catch(() => {});
    }
  }, []);

  const respondToPermission = useCallback((requestId: string, allow: boolean) => {
    if (!sessionIdRef.current) return;

    // Update the permission request state
    setPermissionRequests(prev =>
      prev.map(p => p.requestId === requestId ? { ...p, decided: allow ? 'allow' : 'deny' } : p)
    );

    // Send the decision to the server
    fetch('/api/ai/permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionIdRef.current,
        requestId,
        allow,
      }),
    }).catch(() => {});
  }, []);

  const resetSession = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setSessionId(null);
    setStrategy(null);
    setIsStreaming(false);
    setIsReconnecting(false);
    // Drop the persisted id so the next mount (or next ask) creates fresh.
    removeItem(CHAT_SESSION_COOKIE);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Session stream subscription: receives snapshot + tail events from the
  // server's persistent SSE endpoint so refresh survives and cross-tab
  // activity appears here.
  //
  // The POST /api/ai/query response body remains the primary update channel
  // for this tab's own queries — that's where deltas arrive first and fastest.
  // This EventSource provides:
  //   - `snapshot` on connect: merges with local state so optimistic
  //     entries survive an early-arrival race and completed server turns
  //     override local streaming state when the POST body has died
  //   - `delta` events with permission_request / permission_resolved:
  //     create/clear pending-permission cards (both dedup by requestId)
  //
  // Text/thinking delta events on the session stream are intentional no-ops
  // for entries already owned by this tab's own POST body fetch — the POST
  // body is first-hand and faster. Cross-tab live text sync is deliberately
  // not delivered here; snapshot-on-reconnect covers the reload case.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!sessionId) return;

    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectPillTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffAttempt = 0;
    let cancelled = false;

    // Backoff schedule per Slice 1 PR 1 plan: 1s, 2s, 4s, 8s, cap 30s.
    const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 30_000] as const;
    // Only show "Reconnecting…" in the UI if reconnect takes longer than
    // this threshold — fast transient reconnects shouldn't flash the pill.
    const SLOW_RECONNECT_MS = 500;

    const connect = (): void => {
      if (cancelled) return;
      const url = `/api/ai/session/${encodeURIComponent(sessionId)}/stream`;
      eventSource = new EventSource(url);

      eventSource.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          handleStreamEvent(data);
          // First successful message → reset backoff and clear reconnecting state
          backoffAttempt = 0;
          if (reconnectPillTimer) {
            clearTimeout(reconnectPillTimer);
            reconnectPillTimer = null;
          }
          setIsReconnecting(false);
        } catch {
          // Unparseable event — ignore. Heartbeats (`:\n\n`) don't hit this
          // handler because EventSource strips comments.
        }
      };

      eventSource.onerror = () => {
        // EventSource auto-reconnects on network errors, but we also want
        // to distinguish "session evicted (404)" from "transient blip".
        // Close our own instance and run an exists-probe to decide.
        eventSource?.close();
        eventSource = null;
        if (cancelled) return;

        // Show the pill if reconnect stretches past the fast-path threshold.
        // `reconnectPillTimer` is the authoritative dedup — only schedule a
        // new timer when no pending one is armed. (A prior version also
        // checked `isReconnecting`, but that value was captured by the
        // effect's initial render and never updated, so it provided no
        // extra safety.)
        if (!reconnectPillTimer) {
          reconnectPillTimer = setTimeout(() => {
            setIsReconnecting(true);
            reconnectPillTimer = null;
          }, SLOW_RECONNECT_MS);
        }

        // /exists probe — 404 → fresh session, anything else → retry
        fetch(`/api/ai/session/${encodeURIComponent(sessionId)}/exists`)
          .then((res) => {
            if (cancelled) return;
            if (res.status === 404) {
              // Session is gone. Clear local state so the next ask() creates
              // fresh, and drop the cookie so future mounts don't probe it.
              removeItem(CHAT_SESSION_COOKIE);
              setSessionId(null);
              setMessages([]);
              setStrategy(null);
              setIsReconnecting(false);
              if (reconnectPillTimer) clearTimeout(reconnectPillTimer);
              return;
            }
            // Either 200 OK (session alive) or transient failure —
            // retry with backoff either way.
            const delay =
              BACKOFF_MS[Math.min(backoffAttempt, BACKOFF_MS.length - 1)];
            backoffAttempt++;
            reconnectTimer = setTimeout(connect, delay);
          })
          .catch(() => {
            if (cancelled) return;
            // Network-level failure of the probe itself — retry the stream
            // with backoff. Eventually the network comes back or the user
            // refreshes.
            const delay =
              BACKOFF_MS[Math.min(backoffAttempt, BACKOFF_MS.length - 1)];
            backoffAttempt++;
            reconnectTimer = setTimeout(connect, delay);
          });
      };
    };

    connect();

    return () => {
      cancelled = true;
      eventSource?.close();
      eventSource = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (reconnectPillTimer) clearTimeout(reconnectPillTimer);
      setIsReconnecting(false);
    };

    function handleStreamEvent(evt: unknown): void {
      if (!evt || typeof evt !== 'object') return;
      const e = evt as { type: string; [k: string]: unknown };

      switch (e.type) {
        case 'snapshot': {
          const turns = (e.turns as ChatTurn[] | undefined) ?? [];
          const snapshotStrategy = (e.strategy as ChatContextStrategy | null) ?? null;
          const serverEntries = turnsToEntries(turns);
          // Merge-not-replace. Two races we have to survive:
          //   1. The EventSource connects before the POST /api/ai/query
          //      handler has called `startUserTurn` on the server, so the
          //      snapshot is empty while the client has an optimistic
          //      entry. Wholesale replace would wipe that entry and
          //      subsequent POST-body deltas would fall on the floor.
          //   2. The snapshot is taken mid-query with partial text, but
          //      the POST body has already delivered later deltas to the
          //      client first-hand. Wholesale replace would roll text
          //      back to the snapshot's view and the next POST-body
          //      delta would append onto the wrong base, losing content.
          // Policy: for entries present in both sides, keep the local
          // one if it's still streaming (POST body owns it). Otherwise
          // adopt the server's version. Local-only entries (not yet
          // acknowledged by the server) are appended so they survive.
          setMessages((prev) => {
            const serverIds = new Set(serverEntries.map((e) => e.question.id));
            const merged = serverEntries.map((se) => {
              const local = prev.find((l) => l.question.id === se.question.id);
              if (!local) return se;
              // Server says the turn is done (complete / error / aborted).
              // Trust that over local streaming state — the POST body may
              // have died before delivering the result, leaving local
              // stuck with a spinner it will never clear on its own.
              if (!se.response.isStreaming) return se;
              // Both streaming: POST body is the authoritative delta
              // channel for this tab's own queries (first-hand, faster
              // than the session stream round-trip). Keep local so we
              // don't roll text back to the snapshot's view.
              if (local.response.isStreaming) return local;
              return se;
            });
            const localOnly = prev.filter((l) => !serverIds.has(l.question.id));
            return [...merged, ...localOnly];
          });
          // Merge-not-replace so an optimistic `decided` flag (set in
          // respondToPermission the instant the user clicks Allow/Deny)
          // survives a snapshot that arrives before the server has
          // processed the POST and broadcast `permission_resolved`.
          // Without this the card briefly reverts to undecided and a
          // double-click can fire the same decision twice.
          setPermissionRequests((prev) => {
            const serverPending = unresolvedPermissionsFromTurns(turns);
            const prevById = new Map(prev.map((p) => [p.requestId, p]));
            return serverPending.map((p) => {
              const local = prevById.get(p.requestId);
              return local?.decided ? { ...p, decided: local.decided } : p;
            });
          });
          if (snapshotStrategy) setStrategy(snapshotStrategy);
          break;
        }

        case 'turn': {
          const turn = e.turn as ChatTurn | undefined;
          if (!turn) break;
          // For streaming turns, the POST body is the authoritative
          // delta channel — no-op to avoid rolling back text.
          // For finalized turns (complete/error/aborted), apply them:
          // after a refresh the POST body is gone and this EventSource
          // is the only live channel, so finalizeTurn's broadcast is
          // the only way to clear isStreaming and deliver the final text.
          if (turn.status !== 'streaming') {
            setMessages((prev) => upsertEntryFromTurn(prev, turn));
          }
          break;
        }

        case 'delta': {
          const turnId = e.turnId as string | undefined;
          const msg = e.message as { type: string; [k: string]: unknown } | undefined;
          if (!msg) return;
          // permission_resolved clears the pending permission UI for all tabs.
          if (msg.type === 'permission_resolved') {
            const requestId = msg.requestId as string | undefined;
            if (!requestId) return;
            setPermissionRequests((prev) =>
              prev.map((p) =>
                p.requestId === requestId
                  ? { ...p, decided: (msg.allowed as boolean) ? 'allow' : 'deny' }
                  : p,
              ),
            );
            return;
          }
          // permission_request adds a pending card. Needed for reconnected
          // tabs where the POST body is gone and the EventSource is the
          // only live channel. Dedup by requestId in case the POST body
          // already added it for this tab's own query.
          if (msg.type === 'permission_request') {
            const requestId = msg.requestId as string | undefined;
            if (!requestId) return;
            setPermissionRequests((prev) => {
              if (prev.some((p) => p.requestId === requestId)) return prev;
              return [
                ...prev,
                {
                  requestId,
                  toolName: (msg.toolName as string) ?? 'unknown',
                  toolInput: (msg.toolInput as Record<string, unknown>) ?? {},
                  title: msg.title as string | undefined,
                  displayName: msg.displayName as string | undefined,
                  description: msg.description as string | undefined,
                  toolUseId: (msg.toolUseId as string) ?? requestId,
                },
              ];
            });
            return;
          }
          // Other delta types are handled by the POST body fetch for this
          // tab's own queries. For cross-tab activity, the `turn` events
          // (which arrive paired with deltas server-side via appendMessage
          // → broadcast) upsert the assistant turn's final state.
          void turnId;
          break;
        }

        default:
          // Unknown event kinds — ignore forward-compatibly.
          break;
      }
    }
  }, [sessionId]);

  // ---------------------------------------------------------------------------
  // Mount-time cookie probe: reconnect to a surviving session across refresh.
  //
  // Reads `plannotator-chat-session-review` from cookies, calls the server's
  // `/api/ai/session/:id/exists` probe, and adopts the id if the server
  // confirms the session is still alive. Cookie-hit → 404 means the server
  // restarted or the session was evicted (LRU capacity); we clear the
  // cookie so the next `ask()` creates a fresh session cleanly.
  //
  // Race-safe against a user who clicks "ask" before the probe returns:
  // `setSessionId` uses the updater form and only adopts the cookie id if
  // state is still null. If `ask()` raced ahead and created a session,
  // that wins; the stale cookie id becomes an orphaned server-side entry
  // that will age out via the SessionManager's LRU eviction.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const cookieId = getItem(CHAT_SESSION_COOKIE);
    if (!cookieId) return;

    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/ai/session/${encodeURIComponent(cookieId)}/exists`,
          { signal: controller.signal },
        );
        if (res.ok) {
          // Only adopt if nothing else has set a session (e.g. a racing
          // user-initiated ask() already created one).
          setSessionId(prev => prev ?? cookieId);
        } else if (res.status === 404) {
          // Definitive miss — the session is gone (server restarted or LRU
          // evicted it). Drop the cookie so subsequent ask() goes fresh.
          removeItem(CHAT_SESSION_COOKIE);
        }
        // Any other non-OK status (500, 502, 503, etc.) is treated as a
        // transient failure. Leave the cookie in place so the next mount
        // can retry — clearing on a server hiccup would force a fresh
        // session for no real reason.
      } catch {
        // Network error / unmount abort — leave cookie in place.
        // Retrying on next mount is fine; clearing prematurely would force
        // a fresh session on a transient blip.
      }
    })();

    return () => controller.abort();
  }, []);

  return {
    messages,
    isCreatingSession,
    isStreaming,
    error,
    permissionRequests,
    respondToPermission,
    ask,
    abort,
    resetSession,
    sessionId,
    /** Resolved chat-context strategy; consumed by PR 2's context badge. */
    strategy,
    /** True when the session stream reconnect is taking >500ms. UI pill state. */
    isReconnecting,
  };
}
