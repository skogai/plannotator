# AI Update — Team Briefing

## Overview

We're making the integrated AI chat in Plannotator as reliable as the agent-job system that powers the "run Claude/Codex review" button. Today the chat is fragile: a browser refresh wipes the conversation, the model has no idea what the user was just working on in their coding agent, and we have three open bugs affecting production. We're shipping the reliability work as four small PRs under "Slice 1 — Chat Foundation," then three feature PRs under "Slice 2 — Features."

All authoritative detail lives in `specs/ai-update-spec-v2/`. This doc is a flyover.

## Current state

**What works:** Chat UI exists. Asking a question in code review gets a streaming answer from any of four providers — Claude (via `@anthropic-ai/claude-agent-sdk`), Codex (via OpenAI Codex SDK), Pi (via `pi --mode rpc` subprocess), OpenCode (via in-process HTTP client to OpenCode's server). The Ask-AI tab works end-to-end for a single turn.

**What's broken:**

- **Browser refresh wipes the chat.** Client holds all state; server holds none. `useAIChat` initializes `sessionIdRef` to `null` on every mount, so a refresh creates a new server-side session even though the old one is still alive and a new conversation starts from scratch.
- **Session IDs from invoking agents are silently discarded.** Every entry point already captures a session ID — Claude Code hook JSON, OpenCode `event.properties.sessionID`, Pi `ctx.sessionManager.getSessionId()`, Codex `CODEX_THREAD_ID` env var — and then throws it away before it reaches the AI layer. So the model never knows what the user was just discussing with their agent.
- **Agent job logs disappear on refresh.** The server buffers only the last 500 chars of stderr on snapshots; live log deltas are broadcast-and-forget.
- **Three production bugs:**
  - **#406** — Claude reasoning tokens render in one undifferentiated blob with the final answer.
  - **#514** — OpenCode responses render as empty bubbles.
  - **#513** — OpenCode spawns a second `opencode serve` process even when one is already running.
- **Long review sessions blow past Anthropic's 5-min prompt-cache TTL.** Next turn reprocesses the full prefix — slow and expensive.

**Parallel work you should know about:** A separate feature branch is actively developing **Code Tour** (a third agent-job provider alongside Claude review and Codex review) and **engine/model selection** UI. That branch has already extended `AgentJobInfo` with `engine?` and `model?` fields and changed `buildCommand`'s signature to `(provider, config)`. Our Slice 1 changes add `output?` alongside those fields and preserve the new signature.

## What we outlined

Two slices in the spec. Slice 1 lands first and proves the reliability foundation. Slice 2 builds features on top.

- **Slice 1 — Chat Foundation.** Four PRs. Chat survives refresh, model knows prior context, two rendering bugs fixed, prompt caching enabled.
- **Slice 2 — Features.** Three independent PRs. Plan-mode chat, OpenCode double-spawn fix, cache keepalive.

## What each slice/PR does

### Slice 1, PR 1 — Reliability Foundation

The heavy one. Inverts the chat state model from client-canonical to server-canonical.

- **Pure resolver `resolveChatContext(launch)`** — decision table mapping launch metadata to one of four strategies: `fork_by_id`, `fork_by_heuristic`, `resume_by_id`, `fresh`. Unit-testable.
- **Launch-metadata plumbing through every entry point.** Hook JSON, OpenCode events (with parent-walk to find the root user-facing session when events originate from subagents), Pi via new `--launch-context <base64-json>` CLI arg on the spawned binary (confirmed Pi RPC supports `switch_session` + `fork(entryId)`), Codex via `CODEX_THREAD_ID` env var.
- **Per-harness adapter execution of each strategy.** Claude already has fork and resume. OpenCode already has fork and resume via its HTTP client. Pi gains fork + switch_session via the existing RPC surface. Codex gets concurrent-writer retry with backoff (the app-server rejects second writers during active user turns), adapter changes to not rely on `thread.started` (doesn't fire on resume), per-turn re-specification of `model`/`sandboxMode`/`reasoningEffort` (not persisted on threads), and the **hard removal of `--ephemeral` from the chat path** — ephemeral threads can't be resumed.
- **Server-held transcript.** Session manager accumulates every message per session.
- **New persistent SSE endpoint `GET /api/ai/session/:id/stream`.** On connect emits a snapshot of the full transcript + resolved strategy, then tails new events. Heartbeat every 30 seconds. Matches ChatGPT, Claude.ai, Cursor, Vercel AI SDK's resumable-streams pattern. `/api/ai/query` still receives prompts; its SSE response body becomes unused.
- **New `GET /api/ai/session/:id/exists`** — 200/404 probe for reconnect decisions.
- **Cookie-persisted session ID** (`plannotator-chat-session-review`). On mount: read cookie, check exists, rehydrate from snapshot. On EventSource error: check exists first, retry with exponential backoff if alive, clear cookie and create fresh if 404.
- **Jobs log-loss fix.** `AgentJobInfo.output?` accumulates stderr + formatted stdout. Snapshot includes `output`. `useAgentJobs` seeds its log map from snapshot on reconnect. Preserves the Code Tour branch's `engine?`/`model?` fields and `buildCommand(provider, config)` signature.
- **Prompt caching enablement per provider.** Claude: top-level `cache_control: {type: "ephemeral"}` (automatic mode, walks the breakpoint forward as conversation grows). Codex: stable `prompt_cache_key: <plannotator-session-id>` per chat session (improves OpenAI's cache-affinity routing, following the pattern from Pi's own upstream work). Pi: no adapter change — Pi handles affinity server-side. OpenCode: verify during implementation. Plus implicit-prefix hygiene: anchor injection goes in the per-turn suffix, transcript is append-only, tools sorted if ever added.

### Slice 1, PR 2 — Context Badge

Depends on PR 1. A small always-visible badge at the top of the chat area:

- "Forked from Claude session abc1234 · 2m ago"
- "Resumed Codex thread ef5678"
- "Fresh chat — no prior context"

Clickable popover shows full details (strategy kind, session ID, cwd, timestamp, heuristic match warnings). Reuses the existing scope-badge styling.

### Slice 1, PR 3 — Thinking vs Answer (#406)

Claude-only scope. Claude's SDK already emits reasoning and answer as distinct content blocks; our adapter currently collapses them into one text stream. We add `AIThinkingDeltaMessage` to the message envelope, branch the Claude adapter, and render thinking in a collapsible block (collapsed by default) above the answer. OpenCode also surfaces reasoning (via `part.type === "reasoning"` + same-partID deltas) but routing that to `thinking_delta` requires partID correlation in the accumulator — deferred to a follow-up slice.

### Slice 1, PR 4 — OpenCode Empty Bubbles (#514)

OpenCode-only scope. The original hypothesis (field-name mismatch) turned out to be **wrong** — we verified against OpenCode source that the adapter's current check at `mapOpenCodeEvent` line 348 matches OpenCode's actual event shape. The real cause is almost certainly event ordering: `message.part.updated` arrives with empty text first, then delta events populate it, then a final update arrives with complete text. If our accumulator isn't partID-aware, deltas land on the wrong part or the UI treats the empty update as the final state. Fix is fixture capture + diagnosis + partID-aware accumulator. If PR 1 lands with a partID-aware accumulator from the start, this PR may collapse to just the regression test.

### Slice 2 — Features

Three independent landings, each builds on Slice 1's infrastructure.

1. **Plan-mode Ask AI.** Same `useAIChat` hook, same endpoints, added to the plan-review server (today only the code-review server has AI endpoints). Adds a right-side AI panel to the plan editor. Cookie scoped to `plannotator-chat-session-plan` so it doesn't collide with code-review chat.
2. **OpenCode #513 probe-and-attach.** Before calling `createOpencodeServer()`, probe `GET /global/health` at the configured port (default 4096). Returns `{healthy: true, version}` on a running server. If alive, attach via `createOpencodeClient({baseUrl, directory})`. Handle `OPENCODE_SERVER_PASSWORD` Basic auth if set. If not alive, spawn as today. Short probe timeout so users without OpenCode don't feel the delay.
3. **Prompt cache keepalive #417.** Server-side idle timer per chat session. Fires a visible maintenance turn (`"(keepalive)"`) before Anthropic's 5-min TTL expires. Conservative defaults: `ttlSeconds ≈ 270`, `maxRenewals = 11`, per-session cost meter, global off switch. Maintenance turns marked `maintenance: true` collapse into an expandable row. **Prerequisite: Slice 1's caching enablement** — without `cache_control` on chat requests, keepalive refreshes nothing and is a no-op.

## Where to dig in

- `specs/ai-update-spec-v2/Roadmap.md` — two-slice structure, harness capabilities matrix, decision log
- `specs/ai-update-spec-v2/slices/01-chat-foundation.md` — Slice 1 overview and decisions locked
- `specs/ai-update-spec-v2/slices/01-chat-foundation/README.md` — PR-by-PR breakdown
- `specs/ai-update-spec-v2/slices/01-chat-foundation/01-reliability.md` — PR 1 full detail, including per-harness (Pi/OpenCode/Codex) specifics sections and prompt caching enablement
- `specs/ai-update-spec-v2/slices/01-chat-foundation/02-context-badge.md`, `03-thinking-fix.md`, `04-empty-bubbles-fix.md` — PRs 2, 3, 4
- `specs/ai-update-spec-v2/slices/02-features.md` — plan-mode chat, #513, #417

## The one-line pitch for each PR

| PR | One line |
|----|----------|
| Slice 1 PR 1 | Chat survives refresh, model knows prior context, jobs keep their logs, prompt caching enabled |
| Slice 1 PR 2 | Small badge so users know whether chat knows their prior context |
| Slice 1 PR 3 | Claude reasoning renders in a collapsible block instead of mixed into the answer |
| Slice 1 PR 4 | OpenCode responses actually render text instead of empty bubbles |
| Slice 2 #1 | Same chat experience works in plan review, not just code review |
| Slice 2 #2 | Stop spawning a second OpenCode server when one is already running |
| Slice 2 #3 | Keep the prompt cache warm during long idle review sessions |
