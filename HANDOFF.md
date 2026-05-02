# AI Chat v2 — Handoff Notes

**Branch:** `feat/aiv2`
**Last worked:** ~2026-04-18
**Status:** In progress — core infrastructure done, blocked on a streaming bug

## What this branch does

Implements "Slice 1 PR 1 — Reliability Foundation" from `specs/ai-update-spec-v2/slices/01-chat-foundation/01-reliability.md`. The goals:

1. **Server-canonical transcript** — chat state lives on the server (SessionManager), not the client. Clients connect via SSE (`GET /api/ai/session/:id/stream`), receive a snapshot on connect, then tail deltas.
2. **Fork picker** — UI (AIConfigBar) lets users pick a prior agent session to fork/resume from. Context flows through `resolveChatContext()` → strategy → provider `forkSession`/`resumeSession`.
3. **Launch metadata** — each invocation path (Claude hook, OpenCode event, Pi extension, Codex shell-out) captures session info so the server can auto-resolve context without user intervention.
4. **Prompt caching** — enabled per provider so Slice 2's keepalive feature has a cache to refresh.
5. **Agent job log persistence** — `output` field on `AgentJobInfo` survives browser refresh.

## What's done and working

- `packages/shared/chat-transcript.ts` — `ChatTurn`, `accumulateTurn`, `abortTurn`, `createUserTurn`, `createAssistantTurn`
- `packages/shared/chat-transcript.test.ts` — accumulator unit tests
- `packages/ai/resolve-context.ts` — `resolveChatContext()` decision table, types (`Harness`, `Invocation`, `LaunchMetadata`, `ChatContextStrategy`)
- `packages/ai/resolve-context.test.ts` — table-driven tests for all Matrix 3 rows
- `packages/ai/session-manager.ts` — full rewrite with transcript, SSE subscribers, `startUserTurn`, `appendMessage` (turn-scoped), `finalizeTurn`, `markAbortRequested`, `broadcast`
- `packages/ai/session-manager-transcript.test.ts` — comprehensive tests including multi-tab concurrent writer regression
- `packages/ai/endpoints.ts` — new SSE stream endpoint, exists probe, fork/resume routing, turn-scoped message accumulation
- `packages/server/sse-utils.ts` — shared heartbeat helper
- `packages/review-editor/components/AIConfigBar.tsx` — fork picker dropdown with provider/model/context selection
- `packages/review-editor/components/ContextBadge.tsx` — shows resolved strategy (e.g. "Forked from Claude session abc123")
- `packages/review-editor/hooks/useAIChat.ts` — SSE-based chat with snapshot rehydration, lazy session creation
- Provider adapters updated: `claude-agent-sdk.ts`, `codex-sdk.ts`, `opencode-sdk.ts`, `pi-sdk.ts`

## Where it's blocked

### The "both tabs hang on Thinking" bug

After building the binary and testing multi-tab:
1. Open Tab A, send a question — starts streaming normally
2. Open Tab B (same session via cookie), send a question — Tab B should get `session_busy` error
3. **Actual:** Both tabs freeze on "Thinking..." indefinitely

This was the last thing tested. Single-tab behavior was NOT explicitly verified in this testing round, so the first diagnostic step is:

**Does single-tab chat work at all?**
- If yes → the bug is specific to the multi-tab/concurrent-write path
- If no → the bug is in the streaming pipeline itself (likely the SSE stream endpoint or the query→appendMessage→broadcast chain)

### How to reproduce

```bash
bun run --cwd apps/review build && bun run build:hook && \
  bun build apps/hook/server/index.ts --compile --outfile ~/.local/bin/plannotator
```

Then run `plannotator review` from a Claude Code session with AI providers configured. Open the review UI, go to the AI tab, ask a question.

### Debugging approach

1. Check browser devtools Network tab — is the SSE stream (`/api/ai/session/:id/stream`) connected? Are frames arriving?
2. Check server console for errors
3. Add a `console.log` before `sessionManager.appendMessage(...)` in the query loop (endpoints.ts ~line 555) to confirm the provider stream is yielding messages
4. Verify `startUserTurn` returns a non-null `assistantTurnId` (if null, the session was evicted between lookup and turn creation)

## Outstanding fixes (not started)

These were identified in code review but not yet implemented:

| ID | Issue | Severity | File(s) |
|----|-------|----------|---------|
| F1 | `harnessProvider` preference in default provider path causes mismatch for OpenCode/Codex launches | Medium | `packages/ai/endpoints.ts` ~line 245 |
| F2 | `fetchContextCandidates` early-returns on null `providerId` — fork picker always empty for first-time users until they explicitly select a provider | Medium | `packages/review-editor/App.tsx` |
| F3 | Claude `forkSession` trusts client-supplied `cwd` over server config (`parent.cwd ?? options.cwd ?? this.config.cwd`) | Low/Security | `packages/ai/providers/claude-agent-sdk.ts` |
| F4 | Dead import `resolveClaudeSessionIdByCwd` in review.ts | Low/Cleanup | `packages/server/review.ts` |
| F5 | Pi extension captures launch metadata but doesn't thread it to `startReviewServer` | Low | `apps/pi-extension/plannotator-browser.ts` |
| F6 | `/api/ai/fork-candidates` endpoint not documented in CLAUDE.md/AGENTS.md | Low/Docs | Root docs |

## Key architectural decisions

- **Turn-scoped appendMessage**: Messages target a specific assistant turn by ID, not "the last turn in the array." This prevents multi-tab contamination where two concurrent streams could write into each other's turns.
- **Lazy session creation**: Session is created on first `POST /api/ai/query`, not on page load. Cookie (`plannotator-chat-session-review-${port}`) stores the session ID for reconnection.
- **Snapshot + tail SSE pattern**: On connect, client gets full `ChatTurn[]` snapshot, then incremental `delta` and `turn` events. Reconnect probes `/api/ai/session/:id/exists` first — 404 means start fresh, 200 means retry with backoff.
- **Strategy resolution**: `resolveChatContext(launch)` is a pure function. Server calls it once at session creation time, stores result on `SessionEntry.strategy`, and emits it in the snapshot so the client can render the ContextBadge.

## Specs and plan

- Full spec: `specs/ai-update-spec-v2/slices/01-chat-foundation/01-reliability.md`
- Execution plan: `~/.claude/plans/deep-crafting-plum.md` (also in the system context above)

## Tests

```bash
bun test packages/ai/session-manager-transcript.test.ts  # transcript/SSE tests
bun test packages/ai/resolve-context.test.ts             # context resolution
bun test packages/shared/chat-transcript.test.ts         # accumulator
bun test packages/ai/ai.test.ts                          # general AI tests
```

All pass as of last run.
