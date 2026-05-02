# PR 1 — Reliability Foundation

> Part of Slice 1 — Chat Foundation. See [`../01-chat-foundation.md`](../01-chat-foundation.md) for full design context.

## Thesis

Chat survives browser refresh. Agent job logs survive browser refresh. The model knows what the user was just working on before Plannotator opened.

Today none of this is true:

- `useAIChat` initializes `sessionIdRef` to `null` on every mount and creates a fresh server-side session, even though the old one is still alive
- The SSE stream for `/api/ai/query` dies with the HTTP request — no reconnect, no snapshot
- Agent jobs buffer only the last 500 chars of stderr, so refresh leaves the log panel empty
- Session IDs are captured at every invocation path (hook JSON, OpenCode event, Pi extension, Codex env) and then silently thrown away

This PR inverts the canonical store from browser to server, adds the industry-standard snapshot+tail SSE pattern, threads launch metadata through every invocation path, and fixes the agent-job log-loss bug on the same shape.

## Scope

The full plan at [`/Users/ramos/.claude/plans/deep-crafting-plum.md`](/Users/ramos/.claude/plans/deep-crafting-plum.md) describes the work in 15 numbered units. This PR ships Units 1-9:

| Unit | Work |
|------|------|
| 1 | `resolveChatContext()` pure resolver + `LaunchMetadata` / `ChatContextStrategy` types + table-driven test |
| 2 | Capture launch metadata at every invocation path (Claude hook, OpenCode plugin, Pi extension, Codex env, slash command heuristic). Extend `ServerOptions` / `ReviewServerOptions` / `AnnotateServerOptions` with `launch?: LaunchMetadata`. |
| 3 | Per-harness adapter strategy execution: Claude already supports fork/resume; Codex supports resume (SDK has no fork; fork exists in Rust core but out of scope); Pi gains fork + switch_session via confirmed RPC (see "Pi extension specifics" below for the full 6-step contract); OpenCode already supports both. **Remove `--ephemeral` from Codex chat path** — hard requirement, ephemeral threads cannot be resumed (see "Codex specifics" below). |
| 4 | `SessionManager` grows `transcript: AIMessage[]` and `strategy: ChatContextStrategy` per entry. `appendMessage` / `getTranscript` methods. `/api/ai/query` writes into transcript on every message. |
| 5 | New endpoint `GET /api/ai/session/:id/stream` — on connect emits `snapshot` with full transcript + strategy, then tails new messages; `: ping\n\n` every 30s. `/api/ai/query` keeps receiving prompts but its SSE body becomes unused. |
| 6 | New endpoint `GET /api/ai/session/:id/exists` — 200/404 for cookie-reconnect check |
| 7 | `useAIChat` reads/writes cookie `plannotator-chat-session-review` (per-mode scoping — Slice 2 will add `-plan`). On mount: check cookie, check exists, reuse if valid. |
| 8 | `useAIChat` opens `EventSource` to the session stream on mount; handles `snapshot` (rehydrate) + `tail` (append); reconnect with exponential backoff; shows "Reconnecting…" pill if slow |
| 9 | `AgentJobInfo` grows `output?: string` (alongside existing `engine?`/`model?` from Code Tour branch). `spawnJob` accumulates formatted log stream into `job.info.output`. SSE snapshot includes `output`. `useAgentJobs` seeds `jobLogs` from snapshot on connect. |

## Files

**New:**
- `packages/ai/resolve-context.ts` + `packages/ai/resolve-context.test.ts`

**Modified:**
- `packages/ai/types.ts`, `packages/ai/endpoints.ts`, `packages/ai/session-manager.ts`
- `packages/ai/providers/claude-agent-sdk.ts`, `packages/ai/providers/codex-sdk.ts`, `packages/ai/providers/pi-sdk.ts`, `packages/ai/providers/opencode-sdk.ts`
- `packages/server/index.ts`, `packages/server/review.ts`, `packages/server/annotate.ts`
- `packages/shared/agent-jobs.ts`, `packages/server/agent-jobs.ts`
- `apps/hook/server/index.ts`, `apps/opencode-plugin/commands.ts`, `apps/pi-extension/index.ts`
- `packages/review-editor/hooks/useAIChat.ts`, `packages/ui/hooks/useAgentJobs.ts`

## Acceptance criteria

- [ ] `resolveChatContext()` unit test passes for all 7 Matrix 3 invocation paths
- [ ] Browser refresh mid-stream in code review reconnects and re-renders the full transcript with no duplicates or lost messages
- [ ] Browser refresh during a running agent job repopulates the log panel from before the refresh
- [ ] `curl -N /api/ai/session/:id/stream` shows `: ping` comments every 30s
- [ ] Structured debug log (`{ strategy, harness, id?, cwd?, ts }`) appears in server console for every chat session creation
- [ ] Pre-refresh and post-refresh turns are served by the same provider subprocess (prompt cache not invalidated)
- [ ] Pi adapter implements fork and resume via RPC (`switch_session`, `fork`); confirmed RPC surface per `pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:58`
- [ ] Tour branch integration: `AgentJobInfo` still has `engine?`/`model?`; `buildCommand(provider, config)` signature preserved; log accumulation works for `tour` provider jobs

## Pi extension specifics

Pi is the only harness that needs new RPC integration on our side. Claude and OpenCode already have fork/resume surfaces we call; Codex is `resume_by_id` only. Pi's integration has enough detail to warrant its own section.

### RPC commands (confirmed supported today)

```
{"type":"switch_session","sessionPath":"/path/to/session.jsonl"}
{"type":"fork","entryId":"user-message-entry-id"}
```

Both exist in Pi's RPC types and are implemented (`pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:58`, `rpc-mode.ts:524`). Slice 1 does **not** fall back to `fresh` because Pi capability is missing — the capability is present.

### `fork(entryId)` semantics — explicit

- `entryId` **must be a user-message entry**. Passing a leaf after an assistant turn or tool result will fail at the runtime validator (`agent-session-runtime.ts:181`).
- Pi's fork creates a new session branched from the selected user message's **parent**. The selected user text is returned by the fork but is not already-run context. This is the right behavior for "ask a new question from this point."
- `sessionPath` is the source of truth for RPC — `sessionId` is useful for diagnostics and badge display, but RPC switching is path-based.

### Extension-side capture (no JSONL parsing)

The Pi extension gets a `ctx.sessionManager` object. We do **not** parse session JSONL files ourselves. The extension reads:

```ts
const cwd = ctx.cwd;
const sessionId = ctx.sessionManager.getSessionId();
const sessionPath = ctx.sessionManager.getSessionFile();
const branch = ctx.sessionManager.getBranch();

const lastUserEntry = [...branch]
  .reverse()
  .find((entry) => entry.type === "message" && entry.message.role === "user");

const entryId = lastUserEntry?.id;
```

No new Pi helper needed.

### Resolver decision for Pi — missing data branches

The resolver returns one of three outcomes for Pi based on what the extension provided:

| `sessionPath` | `entryId` | Resolver output |
|---------------|-----------|-----------------|
| present | present | `fork_by_id` |
| present | absent   | `resume_by_id` (switch-session only) |
| absent  | — | `fresh` |

The extension must not attempt `switch_session` or `fork` without a real path and user-message entry ID. Cases where data is absent:

- `--no-session` mode
- Brand-new session before persistence exists
- Extension invoked before any normal user message
- Session file unavailable or deleted

### Adapter-side execution (plannotator server)

When the resolver returns `fork_by_id` for Pi, the `pi-sdk.ts` adapter runs:

```ts
await client.switchSession(sessionPath);
await client.fork(entryId);
```

For `resume_by_id` (path only, no entry), only `switchSession` runs.

### RPC client import — decision needed

`RpcClient` lives at `pi/packages/coding-agent/src/modes/rpc/rpc-client.ts:331` but **is not a stable public export** of `@mariozechner/pi-coding-agent`. Importing from the source path is brittle. Three options:

1. Ask Pi to add a public export/subpath for `RpcClient`
2. Vendor/copy a tiny JSONL client into Plannotator (for only `switch_session` and `fork`, this is ~30 lines)
3. Construct the two RPC payloads directly against the existing `pi --mode rpc` subprocess transport Plannotator already uses

Recommendation during implementation: option 2 or 3. Option 2 is self-contained; option 3 reuses the existing Pi subprocess plumbing. Only escalate to option 1 if the command surface grows beyond these two calls.

### CLI arg payload (minimal)

Pi extension passes `--launch-context <base64-json>` where the decoded JSON is:

```json
{
  "harness": "pi",
  "invocation": "extension",
  "cwd": "...",
  "sessionId": "...",
  "sessionPath": "/path/to/session.jsonl",
  "entryId": "user-message-entry-id"
}
```

Nothing else. Pi reports facts. Server resolver decides strategy.

### Async spawn, not `spawnSync`

If the Pi extension uses `spawnSync` to launch plannotator, the Pi TUI blocks until plannotator exits. For integrated chat (the core Slice 1 feature — session lives as long as the browser is open), this is wrong. Use async spawn so Pi stays usable while plannotator runs.

### The full Pi flow, end to end

1. User runs Pi command that invokes plannotator
2. Pi extension reads `ctx.cwd`, `ctx.sessionManager.getSessionId()`, `getSessionFile()`, `getBranch()`
3. Extension finds the last user-message entry from the branch (reverse find)
4. Extension builds the minimal JSON payload, base64-encodes, passes as `--launch-context`
5. Plannotator server resolves Pi launch: path + entry → `fork_by_id`; path only → `resume_by_id`; neither → `fresh`
6. Pi provider starts the `pi --mode rpc` subprocess
7. Pi provider sends `switch_session(sessionPath)` then `fork(entryId)` (or just `switch_session` for resume)
8. Chat proceeds against the forked/switched Pi session

## OpenCode plugin specifics

OpenCode runs our plugin in-process — no subprocess boundary. Four OpenCode-specific considerations:

### Parent-walk to find the root session

`event.properties.sessionID` is the session that **emitted** the event, not guaranteed to be the user-facing root session. Subagents (Task tool) create child sessions with `parentID: ctx.sessionID` and emit their own events (`packages/opencode/src/tool/task.ts:68, 132`). If we fork on a child session ID, we fork the subagent, not what the user sees.

Before passing the session ID to `LaunchMetadata`, walk up:

```ts
let id = event.properties.sessionID;
while (id) {
  const info = await client.session.get({ path: { id } });
  if (!info?.parentID) break;
  id = info.parentID;
}
// `id` is now the root user-facing session
```

### Mid-stream fork caveat

`session.fork` is copy-on-fork. It clones **persisted** messages and parts at fork time. Text/reasoning deltas are bus-only events (`packages/opencode/src/session/index.ts:548, 658`) — they aren't persisted until the turn completes. If the user launches Plannotator while their OpenCode agent is actively generating, the fork will include the in-flight assistant message but not the streamed-but-unpersisted text.

Not a bug. Document as a known constraint. A follow-up could surface a muted banner ("parent session was still generating — some context may be missing") but not required for Slice 1.

### `messageID` fork cutoff is exclusive

`session.fork({ path: { id }, body: { messageID } })` clones messages strictly **before** `messageID`. If omitted, it clones all current messages. For Slice 1, we omit `messageID` — we want the full prior conversation as context. Not "fork from the last user message" (which would require finding that ID first and passing it).

### Plugin lifecycle cleanup

OpenCode plugins have no `dispose` hook on the public `Hooks` type (`packages/plugin/src/index.ts:222`). Our plugin currently starts Plannotator server instances via direct imports and holds handles. On OpenCode server shutdown, those handles would leak.

Audit `apps/opencode-plugin/` during Slice 1 implementation: ensure cleanup on `server.instance.disposed` or process exit. Servers spawned during a review/plan/annotate command should be stopped when their command completes (already the case for subprocess spawns — verify for in-process handles).

### Permission resolution — use existing event

OpenCode already emits `permission.replied` when a permission decision is posted (`packages/opencode/src/permission/index.ts:203`). This is exactly our D7 `permission_resolved` broadcast target. No new OpenCode-side work — the adapter maps `permission.replied` → `AIPermissionResolvedMessage` and the server broadcasts to session stream subscribers.

### Transcript accumulator must be partID-aware

OpenCode's event stream does **not** guarantee strict delta-before-update ordering. `message.part.updated` with an empty `text` field is emitted when a part starts, then `message.part.delta` events follow, then a final `part.updated` with the complete text (`packages/opencode/src/session/processor.ts:406`). The `accumulateTurn` function must:

- Keep a `partID → partState` map inside the assistant turn
- On `message.part.updated`: create or replace the part entry keyed by `partID`. Do **not** treat an empty-text update as "complete turn."
- On `message.part.delta`: append `delta` to the matching `partID`'s buffer
- Reasoning parts (finding #11 — `part.type === "reasoning"`) are tracked the same way but routed to the turn's `thinking` field instead of `text`. Slice 3 (Claude thinking) defines the envelope; OpenCode reasoning routing can land in Slice 3 or a follow-up.

## Codex specifics

Codex is `resume_by_id` only — no fork exists in the SDK. The integration is narrower than Pi or OpenCode, but several non-obvious constraints affect correctness.

### `CODEX_THREAD_ID` is the thread ID, unconditionally set

`CODEX_THREAD_ID` is injected into every child process Codex spawns for shell tools, user shell commands, unified exec, and JS REPL (`core/src/tools/handlers/shell.rs`, `tasks/user_shell.rs`, `unified_exec/process_manager.rs`, `tools/js_repl/mod.rs`). It is explicitly "injected even when include_only is set" (`config/src/shell_environment.rs:109-112`). Only MCP server child processes bypass it (different environment setup, not our concern).

Thread ID == session ID == UUID-v7 string, no prefix, same value for `CODEX_THREAD_ID` / `codex exec resume <id>` / SDK `resumeThread(id)`. All three paths POST `thread/resume` to the same app-server handler.

### Concurrent writer race (must handle)

If the user is actively generating in Codex when Plannotator chat tries to send a turn, the app-server rejects with:

> thread {thread_id} is closing; retry thread/resume after the thread is closed

(`codex_message_processor.rs:4160-4173`.) Only one writer holds a thread at a time.

**Required behavior in the Codex adapter:**
- On `thread/resume` failure matching this error message, retry with exponential backoff (500ms, 1s, 2s, 4s, cap 10s)
- After N retries (recommend 5 attempts over ~15 seconds), surface a user-facing error in the chat UI: "Codex is busy — wait for the current turn in your terminal to complete, then try again."
- Do not block the UI during retry — show the "Reconnecting…" pill pattern (same visual vocabulary as EventSource reconnect).

### No `thread.started` event on resume

On resume, the thread ID is already known and the SDK skips the ID-capture block (`sdk/typescript/src/thread.ts:104-106`). The first event is `turn.started` (or the first content/tool event).

**Adapter fix:** our current `mapCodexEvent` resets text-offset tracking on `thread.started`. On resume, that event never arrives. Initialize tracking state when the session is constructed, not on first event receipt. No code relies on `thread.started` as a gate.

### Reasoning effort and model are per-turn, not persistent

Options passed to `resumeThread(id, { model, workingDirectory, sandboxMode, modelReasoningEffort })` apply **only to the current turn**. They are consumed and not written back to the rollout file. Subsequent resumes start from the original stored state.

**Adapter fix:** the adapter must re-specify `model`, `modelReasoningEffort`, and `sandboxMode` on every turn, not just the first resume. Don't cache these at session construction and assume they persist.

Caveat: if the thread is already running when we submit options, the app-server ignores the override and warns. Belt-and-suspenders with the concurrent-writer handling above.

### `--ephemeral` must not appear in the chat path

An ephemeral thread writes no rollout file (`codex.rs:1713-1724`, recorder set to `None`). Resuming an ephemeral thread fails because there is nothing on disk. If any chat-path code passes `--ephemeral`, resume will silently fail.

**Required action:** audit the Codex adapter for any `--ephemeral` flag or equivalent SDK option on the chat path. Remove if present. Review jobs keep `--ephemeral` — they don't resume. The open question from the parent slice is now closed: this is a hard requirement, not an audit-if-time-permits.

### Sandbox mode freely downgradable

`ThreadResumeParams.sandbox` is applied by the app-server without validating against the original thread's mode. Safe to resume a `workspace-write` thread in `read-only` mode for chat. The user's original mode remains in the rollout; our turn runs read-only.

### Shell output is already in the model's context

When `!plannotator review` runs from inside Codex, Plannotator's stdout is captured as a tool result (`FunctionToolOutput` / `UserShellOutput`) and included in the Codex thread. When Plannotator's chat sidebar resumes that thread, the model inherits that context automatically.

**Implication:** do not re-inject Plannotator review findings into the first resumed turn. The model already has them. Starting the Plannotator chat with "Here is what Plannotator found…" would be redundant. The user's first chat prompt is enough.

This is documentation, not a code change — but future contributors might assume context injection is needed. It isn't.

### Fork exists in Rust core but not in SDK

`thread/fork` is implemented in `core/src/thread_manager.rs:661` and defined in `app-server-protocol/src/protocol/v2.rs:2850-2898`. The TypeScript SDK does not expose it (`sdk/typescript/src/codex.ts` only has `startThread` and `resumeThread`).

Accessing fork would require speaking raw JSON-RPC to the app-server socket. Out of scope for Slice 1. If Codex's SDK later adds `forkThread()`, revisit the `resume_by_id` strategy — `fork_by_id` would be preferable (doesn't mutate the user's main thread). Track as a future enhancement.

### Thread history access via `thread/read`

`ThreadReadParams { thread_id, include_turns }` exists in `app-server-protocol/src/protocol/common.rs` and `v2.rs`. Returns thread history without creating a new turn. TypeScript SDK does not expose it. Out of scope for Slice 1 — we start our chat transcript fresh from the first Plannotator-sent turn. If we wanted to pre-populate the Plannotator transcript with the user's prior Codex history, this is the mechanism.

## Prompt caching enablement

Caching doesn't happen automatically across all providers — each harness needs a specific opt-in or stable key. Slice 1 must enable caching as part of adapter wiring, or the Slice 2 keepalive (#417) has nothing to refresh. Small changes per adapter, all additive.

### Per-provider requirements

**Claude (Anthropic SDK, `claude-agent-sdk.ts`):**
- Pass top-level `cache_control: { type: "ephemeral" }` on every chat request. Use automatic caching (not block-level breakpoints) — the SDK walks the cache point forward as conversation grows, no manual breakpoint management.
- Minimum cacheable prompt length: 2048 tokens for Sonnet 4.6, 4096 for Opus 4.6 / Haiku 4.5. Below threshold, caching is a silent no-op. Our chat system prompt + diff/plan context typically exceeds 2048 tokens — verify during implementation.
- Default 5-min TTL (refreshed on every cache hit). The 1-hour TTL costs 2x write; not needed for Slice 1.

**Codex (OpenAI SDK, `codex-sdk.ts`):**
- Pass `prompt_cache_key: <plannotator-session-id>` on every turn. This improves cache-affinity routing (OpenAI routes same-key requests to the same backend node). Mirrors the pattern in upstream Pi PR #3018 (`badlogic/pi-mono#3018`) which aligns `prompt_cache_key` + `session_id` + `x-client-request-id` headers for the same reason.
- Use our Plannotator session ID, not the Codex thread ID — a fresh Plannotator session implies a fresh cache lineage.
- Automatic at ≥1024 tokens, no opt-in needed beyond the key.
- Default retention is in-memory (~5-10 min). Do not set `prompt_cache_retention: "24h"` for Slice 1 — the 24h mode is useful for long-idle review sessions but adds GPU-local storage costs; defer.

**Pi (RPC, `pi-sdk.ts`):**
- No adapter change. Pi handles cache affinity server-side against its upstream OpenAI Responses calls (per `pi-mono#3018`).
- **Documentation only:** do not rotate Pi session IDs within a single Plannotator chat conversation. Slice 1's cookie persistence + `switch_session` + `fork(entryId)` already ensures a stable Pi session ID across browser refreshes — preserve that invariant.

**OpenCode (`opencode-sdk.ts`):**
- No direct adapter change in Slice 1. OpenCode proxies to upstream Anthropic/OpenAI — caching is handled at the OpenCode server's layer.
- Verify during implementation: if OpenCode exposes a `prompt_cache_key` equivalent or a top-level `cache_control` pass-through, use it with our Plannotator session ID. If not, rely on stable session ID → stable upstream prefix.

### Implicit-prefix hygiene (all providers)

The Pi-mono PRs `openclaw#58036-58038` document three ways a harness silently busts its own upstream cache. Our current plan already avoids all three passively; these are confirmations, not new work:

1. **Anchor injection goes in the per-turn suffix, not the prefix.** When a user asks about a specific line or block, the anchor text ("user is asking about line 42: …") is appended to the user's prompt **after** the stable system prompt context. Do not prepend anchor text into the system prompt or a per-turn system mutation — the prefix must remain identical across turns, or the cache prefix hash changes every turn and never hits.
2. **Server transcript is append-only.** Unit 4 specifies we never mutate old turns — this is a cache-hygiene property too. Compaction, summarization, and image stripping (if ever added) must mutate the tail, not the head.
3. **No tools passed from the chat surface today.** If we ever add tools to chat (not planned for Slice 1), sort them deterministically by name before serialization — the tools block sits at the prefix root, and any ordering churn busts the cache for the full request.

### Dependency: Slice 2 #417 keepalive

The keepalive feature refreshes the Anthropic prompt cache before its 5-minute TTL expires. **It only works if `cache_control` is enabled on chat requests** (the Claude change above). Without that, a keepalive turn is just an extra Anthropic API call that caches nothing and saves nothing. Slice 2 must cross-reference this prerequisite.

### Acceptance addition for Slice 1

Add to the acceptance criteria:

- [ ] First Claude chat turn produces a non-zero `cache_creation_input_tokens` in the response `usage` field
- [ ] Second turn (same session, <5 min later) produces a non-zero `cache_read_input_tokens`, indicating a cache hit
- [ ] Post-refresh Claude turn produces a cache hit (same process, same session, cache still warm)
- [ ] Codex chat turns all pass the same `prompt_cache_key` value for a given Plannotator chat session

## Parallel work coordination

Code Tour feature branch is already developing. This PR adds `output?: string` to `AgentJobInfo` alongside the Tour branch's `engine?` and `model?` — additive only. Uses `buildCommand(provider, config)` signature already in use on Tour. Does not touch `onJobComplete` or `useAgentJobs`'s tour auto-open watcher — our snapshot seeding is additive.
