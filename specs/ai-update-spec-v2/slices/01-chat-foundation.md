# Slice 1 — Chat Foundation

> **Implementation:** this slice ships as four PRs. See [`01-chat-foundation/README.md`](./01-chat-foundation/README.md) for the PR breakdown and how each item below maps to a landing PR.

## Goal

Make the integrated AI chat as reliable as the rest of Plannotator's SSE-driven surfaces (agent jobs, external annotations). Today, refreshing the browser during a chat loses the entire conversation. This slice fixes that and lays the groundwork for plan-mode Ask AI in Slice 2.

## What this slice ships

Eight concrete changes, each independently testable:

### 1. The `resolveChatContext()` resolver

A pure function that takes launch metadata and returns a context strategy. No I/O, no file system calls — just a decision table.

```ts
type ChatContextStrategy =
  | { kind: "fork_by_id"; harness: string; sessionId: string }
  | { kind: "fork_by_heuristic"; harness: string; cwd: string }
  | { kind: "resume_by_id"; harness: string; threadId: string }
  | { kind: "fresh"; harness: string | null; reason: string };

function resolveChatContext(launch: LaunchMetadata): ChatContextStrategy;
```

The heuristic lookup (`findSessionLogsForCwd()`) happens downstream when the strategy is *executed*, not when it's resolved. The resolver emits a structured debug log (`{ strategy, harness, id?, cwd?, ts }`) that feeds the context badge in the UI.

To make this work, each invocation path needs to actually capture and pass through the session context it already has but currently ignores:

| Path | Current state | Change needed |
|---|---|---|
| Claude hook | `session_id` in stdin JSON, **not parsed** (`apps/hook/server/index.ts:910-914`) | Parse `session_id` and `transcript_path`, pass to server launch options |
| OpenCode plugin | `event.properties.sessionID` extracted at `apps/opencode-plugin/commands.ts:107-108` but **not retained** past feedback delivery. Can also be a **child session ID** when the event originates from a Task-tool subagent. | Retain the id. Walk up via `client.session.get({path: {id}}).parentID` until `parentID` is null to find the root user-facing session. Pass the root id to the server. See [`01-chat-foundation/01-reliability.md`](./01-chat-foundation/01-reliability.md#opencode-plugin-specifics). |
| Pi extension | `ctx.sessionManager` available but **never accessed** | Read `getSessionId()`, `getSessionFile()`, and `getBranch()`. Reverse-find the last user-message entry. Pass `{ sessionId, sessionPath, entryId, cwd }` via `--launch-context <base64-json>` CLI arg on the spawned plannotator binary. No JSONL file parsing — use the branch API. See [`01-chat-foundation/01-reliability.md`](./01-chat-foundation/01-reliability.md#pi-extension-specifics) for the full 6-step flow. |
| Codex shell-out | `CODEX_THREAD_ID` env var present | Read from `process.env` at server start |
| Claude slash command | No direct mechanism | Use `findSessionLogsForCwd()` (already exists, used by `annotate-last`) |

**Key files:**
- New: `packages/ai/resolve-context.ts` (the resolver function + types)
- Modified: `apps/hook/server/index.ts` (parse `session_id` from hook payload)
- Modified: `apps/opencode-plugin/commands.ts` (retain session id past feedback)
- Modified: `apps/pi-extension/index.ts` (pass `getSessionId()` through)
- Modified: `packages/server/review.ts` (accept and store launch context)
- Modified: `packages/server/index.ts` (same for plan server)

**Unit tests:** Table-driven. Each row is a `LaunchMetadata` input and an expected `ChatContextStrategy` output. No mocking needed because the function is pure.

### 2. Cookie-persisted session id (chat survives refresh)

Today, `useAIChat.ts:48` initializes `sessionIdRef` to `null` on mount. On first ask, it creates a new server-side session. On refresh, the ref is gone — a new session is created even though the old one is still alive in the server's `SessionManager`.

**Fix:** Store the session id in a cookie (same mechanism `packages/ui/utils/storage.ts` already uses for identity, plan-save, and agent-switch settings). On mount, check for an existing cookie. If found and the server confirms the session exists (a lightweight GET), reconnect instead of creating.

**Key files:**
- Modified: `packages/review-editor/hooks/useAIChat.ts` (cookie read/write, session existence check on mount)
- Modified: `packages/ai/endpoints.ts` (new GET endpoint: `/api/ai/session/:id/exists` or similar — returns 200/404)
- Existing: `packages/ui/utils/storage.ts` (cookie helpers already here)

### 3. Snapshot + tail SSE reconnect with full transcript

Today, `/api/ai/query` opens an SSE stream *in its response body*. That stream dies when the HTTP request dies — i.e., on every browser refresh. No reconnect, no snapshot. This is the fundamental reason chat doesn't survive refresh.

**Change:** Split "send a prompt" from "watch the session." Add a **new** long-lived SSE endpoint `GET /api/ai/session/:id/stream` that mirrors the jobs/external-annotations pattern. On connect:
1. A `snapshot` event containing the full transcript for the session — every prior Q&A pair, including any in-progress streaming response.
2. Then live-tails new events as they arrive.

`/api/ai/query` keeps receiving prompts, but its SSE response body is no longer consumed by the client — all UI rendering flows through the new persistent stream. This is the industry-standard shape (ChatGPT, Claude.ai, Cursor, Vercel AI SDK resumable-streams).

**The client** (`useAIChat.ts`) opens an `EventSource` to the new endpoint on mount, replaces its local state with the snapshot on reconnect, then appends live events. No duplicate rendering.

**Key files:**
- Modified: `packages/ai/endpoints.ts` (new `GET /api/ai/session/:id/stream` handler; `/api/ai/query` writes into session transcript on each message)
- Modified: `packages/ai/session-manager.ts` (expose a `getTranscript(sessionId)` method, `appendMessage(sessionId, msg)`, and per-session subscriber list for broadcasting tail events)
- Modified: `packages/review-editor/hooks/useAIChat.ts` (open EventSource on mount, handle `snapshot` and `tail` events, reconnect with backoff)

### 4. Jobs log-loss fix

**The bug:** When you refresh the browser during a running agent job, the historical log output is gone. The server-side snapshot (`agent-jobs.ts:357-360`) only includes job metadata (status, timing), not accumulated log lines. The server never stores log history — it broadcasts deltas live and buffers only the last 500 chars of stderr (`agent-jobs.ts:184`).

**Fix:** Add an `output: string` field to `AgentJobInfo`. Accumulate log lines in the job's in-memory state during streaming. Include `output` in the snapshot event. Same shape as the chat transcript snapshot in item 3.

**Active parallel work:** Code Tour and engine/model selection are already developing on a separate branch. `AgentJobInfo` already has `engine?: string` and `model?: string` fields there, and `buildCommand`'s signature is `(provider, config)`. Our `output?: string` addition must sit alongside those fields without restructuring the type. The log accumulation must work for all providers including `tour`, which streams stderr logs the same way as claude/codex but stores results in a `tourResults` map rather than `externalAnnotations` — don't assume all jobs produce external annotations. See the Roadmap's "Active parallel work" section for the full intersection matrix.

**Key files:**
- Modified: `packages/shared/agent-jobs.ts` (add `output?: string` to `AgentJobInfo` alongside the existing `engine?` and `model?` fields from the tour branch)
- Modified: `packages/server/agent-jobs.ts` (accumulate output in job state, include in snapshot — use the `(provider, config)` buildCommand signature already in use on the tour branch)
- Modified: `packages/ui/hooks/useAgentJobs.ts` (initialize `jobLogs` from snapshot on reconnect instead of starting empty — the tour branch adds auto-open handling here; add snapshot logic without disrupting it)

### 5. SSE heartbeats on `/api/ai/session/:id/stream`

Add a 30-second heartbeat comment (`: ping\n\n`) to the new persistent session stream (item 3). Matches the cadence in `agent-jobs.ts:104-114` and `external-annotations.ts`. Keeps the connection alive through corporate proxies and dev-tunnel services that kill idle TCP sockets after 60s.

**Why 30 seconds:** It's what our other SSE streams already use. Consistent cadence across the codebase, safely under common proxy idle-timeout thresholds. Does not interact with prompt caching — it's an SSE comment, not a model invocation.

**Key files:**
- Modified: `packages/ai/endpoints.ts` (heartbeat interval in the new session-stream handler)

### 6. Context badge in the chat header

An always-visible small badge at the top of the AI tab showing the resolved context strategy. Examples:
- "Forked from Claude session abc1234 - 2m ago"
- "Resumed Codex thread ef5678"
- "Fresh chat - no prior context"

Clickable: expands a popover with the full strategy name (`fork_by_id`, `fork_by_heuristic`, `resume_by_id`, `fresh`), the matched session id, the cwd, and the timestamp. Debuggable by users who wonder "why doesn't the model remember X?"

**Key files:**
- Modified: `packages/review-editor/components/AITab.tsx` (badge component at the top of the chat area)
- New data flow: the server includes the resolved `ChatContextStrategy` in the session creation response, which the client stores and renders.

### 7. Fix #406 — thinking vs answer separation

**The bug:** The AI chat renders the model's "thinking" content (reasoning tokens) and the final answer in one undifferentiated blob. Users can't tell where the answer starts. Reported in [#406](https://github.com/backnotprop/plannotator/issues/406).

**Root cause:** In `AITab.tsx:382-387`, the entire `response.text` is rendered through one markdown pipeline. There is no branching on content type. The only "thinking" treatment is a placeholder shown *before* any text arrives (line 390-393); once tokens flow, thinking and answer are indistinguishable.

**Fix:** Two changes:
1. **Adapter layer:** Each provider's event mapper distinguishes thinking tokens from answer tokens. Claude's SDK already emits them as separate event types. Add a `thinking_delta` kind to the chat envelope alongside the existing `text_delta`. Other adapters that don't distinguish thinking (Codex, Pi, OpenCode) continue emitting only `text_delta`.
2. **UI layer:** `AITab.tsx` renders `thinking_delta` and `text_delta` in separate DOM containers with distinct styles. Thinking blocks are collapsible (collapsed by default, expandable for debugging). Answer blocks render normally.

This is a minimal envelope addition — one new event kind — not a blanket expansion.

**Key files:**
- Modified: `packages/ai/types.ts` (add `thinking_delta` to the message type union)
- Modified: `packages/ai/providers/claude-agent-sdk.ts` (emit `thinking_delta` for reasoning events)
- Modified: `packages/review-editor/components/AITab.tsx` (separate render paths for thinking vs answer)

### 8. Fix #514 — OpenCode empty bubbles

**The bug:** OpenCode AI chat responses render as empty bubbles. Reported in [#514](https://github.com/backnotprop/plannotator/issues/514).

**Root cause (verified against OpenCode source):** The original field-name mismatch hypothesis was **wrong**. `message.part.delta` events arrive with `properties.field === "text"` and `properties.delta` (see `packages/opencode/src/session/message-v2.ts:489`), which is exactly what our current check at line 348 matches. The real cause is event-ordering: OpenCode emits `message.part.updated` with an empty `text` field when a part starts, then `message.part.delta` events populate it, then a final `part.updated` arrives with complete text (`packages/opencode/src/session/processor.ts:406`). If the UI/accumulator consumes the initial empty `part.updated` as the final state, or doesn't correlate deltas to the part by `partID`, text goes missing. See [`01-chat-foundation/04-empty-bubbles-fix.md`](./01-chat-foundation/04-empty-bubbles-fix.md) for the diagnosis walkthrough.

**Fix:**
1. Add logging at the adapter boundary: raw events in, translated events out. In dev mode, log a warning when a raw event produces zero translated events (a silent drop). Diagnostic, not the fix.
2. Capture a real OpenCode event sequence as a test fixture — include the full ordering (`part.updated` empty → `part.delta`* → `part.updated` final).
3. Root-cause from the fixture. If PR 1's `accumulateTurn` is partID-aware (D9 in the plan / Slice 1 implementation), this slice may collapse to just fixture + regression test. Otherwise fix in the accumulator or the mapper based on what the fixture reveals.

**Key files:**
- Modified: `packages/ai/providers/opencode-sdk.ts` (`mapOpenCodeEvent` function — the fix itself)
- New: `packages/ai/ai.test.ts` or similar (regression test with captured OpenCode event fixture)
- Investigate: `packages/ai/providers/claude-agent-sdk.ts` (similar silent-drop check)

## Per-harness adapter changes for the resolver

Each harness adapter needs to execute the resolved strategy. Here's what each adapter gains:

| Adapter | Fork | Resume | Fresh |
|---|---|---|---|
| `claude-agent-sdk.ts` | Already passes `resume: sessionId` on turn 2 (line 283). Add `fork_session: true` in the session options when strategy is `fork_by_id` or `fork_by_heuristic`. | Same as fork but without `fork_session: true` (continues the original). | Already the default behavior — no change. |
| `codex-sdk.ts` | N/A in SDK. Fork exists in Codex's Rust core + app-server protocol (`thread/fork`) but is not exposed via the TypeScript SDK — would require raw JSON-RPC. Out of scope for Slice 1; revisit if SDK adds `forkThread()`. | SDK `codex.resumeThread(id)`. **Hard requirement:** chat path must not pass `--ephemeral` (or its SDK equivalent) — ephemeral threads write no rollout file and can't be resumed. Must retry on "thread {id} is closing" error (concurrent writer race — Codex rejects second writers during active turns); exponential backoff with UI messaging after retries exhausted. No `thread.started` event on resume — adapter must not gate on it. `model`, `modelReasoningEffort`, `sandboxMode` are per-turn only (not persisted on thread) — re-specify every call. Shell output from `!plannotator review` is already in the thread as a tool result — do not re-inject review findings. See [`01-chat-foundation/01-reliability.md`](./01-chat-foundation/01-reliability.md#codex-specifics) for the full contract. | Already the default behavior. |
| `pi-sdk.ts` | `switchSession(sessionPath)` then `fork(entryId)`. `entryId` **must be a user-message entry** (validated at `agent-session-runtime.ts:181`); passing an assistant/tool-result leaf fails. Pi's fork branches from the selected user message's parent — the user text is returned but not already-run context, which is what we want. `sessionPath` is the source of truth; `sessionId` is for diagnostics only. Resolver returns `fresh` if `sessionPath` is absent; `resume_by_id` if path present but no user-message `entryId`. RPC commands confirmed at `pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:58`. See [`01-chat-foundation/01-reliability.md`](./01-chat-foundation/01-reliability.md#pi-extension-specifics) for the full implementation contract. | `switchSession(sessionPath)` only. Path-based, not id-based. | Already the default behavior. |
| `opencode-sdk.ts` | Use `client.session.fork({id})` on the attached client. | Use `client.session.get({id})` to reattach. | Already the default behavior (create new session). |

## Acceptance criteria

- [ ] `resolveChatContext()` has a table-driven unit test covering every row of Matrix 3 (7 invocation paths x expected strategy).
- [ ] Browser refresh during an active chat reconnects to the same session and re-renders the full transcript. No duplicate messages, no lost messages.
- [ ] Browser refresh during a running agent job shows accumulated log output from before the refresh.
- [ ] `/api/ai/session/:id/stream` SSE endpoint emits heartbeat comments every 30 seconds.
- [ ] The context badge is visible in the AI tab and correctly reflects the resolved strategy.
- [ ] Claude chat renders thinking blocks collapsed and separate from the final answer.
- [ ] An OpenCode event replay fixture produces non-empty `text_delta` events when run through `mapOpenCodeEvent`.
- [ ] `resolveChatContext()` emits a structured debug log that is visible in the server console.
- [ ] Prompt cache is not broken by any of the above: the same provider subprocess serves both pre-refresh and post-refresh turns.

## Decisions locked

- **SSE shape:** new persistent `GET /api/ai/session/:id/stream`; `/api/ai/query` keeps receiving prompts but its SSE body is no longer consumed. Matches ChatGPT/Claude.ai/Cursor/Vercel AI SDK resumable-streams pattern.
- **Cookie scoping:** per-mode. `plannotator-chat-session-review` for Slice 1's code review chat; Slice 2 adds `plannotator-chat-session-plan`.
- **Pi fork/resume:** confirmed supported via RPC (`switch_session`, `fork`). Fork uses the last user-message `entryId`, same semantics as Claude's `--fork-session` with `--resume` (forks at the current head).
- **Claude slash command heuristic:** when two Claude sessions are live in the same repo, pick the most recent, log a warning, and surface "matched session X - 2m ago" in the context badge so users can tell if the heuristic picked wrong.
- **#406 thinking fix:** Claude only (Slice 3). OpenCode reasoning tokens arrive via `message.part.updated` with `part.type === "reasoning"` + same-partID deltas — routing to the `thinking_delta` envelope is possible but can land in a follow-up. Codex/Pi continue emitting `text_delta` only.
- **#514 empty bubbles (Slice 4):** OpenCode only. Original field-name hypothesis was wrong — real shape matches our current check. Root cause is almost certainly ordering (`part.updated` with empty text arriving before deltas). Fixture-first diagnosis.
- **Codex chat path must not use `--ephemeral`:** hard requirement. Ephemeral threads write no rollout file and cannot be resumed (`codex.rs:1713-1724`). Audit and remove during Slice 1 implementation. Review jobs keep `--ephemeral` (they don't resume).
- **Codex concurrent writer handling:** adapter retries `thread/resume` with exponential backoff on "thread {id} is closing" error (app-server rejects second writers during active turns). After retries exhausted, surface UI messaging. See [`01-chat-foundation/01-reliability.md`](./01-chat-foundation/01-reliability.md#codex-specifics).
- **Prompt caching enablement is a Slice 1 concern, not Slice 2.** Claude adapter opts in with top-level `cache_control: {type: "ephemeral"}`. Codex adapter passes stable `prompt_cache_key` per Plannotator chat session. Pi + OpenCode inherit from stable session IDs. Anchor injection goes in the per-turn suffix, never mutating the stable prefix. Slice 2's #417 keepalive is a no-op without this enablement. See [`01-chat-foundation/01-reliability.md`](./01-chat-foundation/01-reliability.md#prompt-caching-enablement).
