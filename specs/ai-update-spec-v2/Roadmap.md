# AI Update Spec v2 — Roadmap

How we're improving Plannotator's integrated AI chat across code review and plan review, in two dependency-ordered slices.

## The problem

Plannotator has two separate AI features built at different times:

- **Agent jobs** — the "run Claude/Codex review" button that kicks off a background process, waits for structured output, and dumps annotations into the diff. Solid: heartbeats, log streaming, proper lifecycle. Lives in `packages/server/agent-jobs.ts`.
- **Embedded chat** — the "Ask AI" tab in code review where you type a question and an AI answers. Fragile: in-memory only, no heartbeats, no reconnect, no surviving browser refresh. Lives in `packages/ai/` and `packages/review-editor/hooks/useAIChat.ts`.

They talk to the same providers (Claude, Codex, Pi, OpenCode) but through different plumbing. Chat is flimsy, jobs are reliable. We want chat to be as reliable as jobs — and then we want to bring Ask AI to plan review too.

## What we're shipping

Two slices, in order:

| # | Slice | Ships |
|---|---|---|
| 1 | [Chat Foundation](./slices/01-chat-foundation.md) | Chat survives refresh. Full transcript in SSE snapshots. Heartbeats. Context badge. The `resolveChatContext()` resolver. Prompt caching enablement per provider (Claude `cache_control`, Codex `prompt_cache_key`, Pi/OpenCode pass-through). #406 fix (thinking vs answer). #514 fix (OpenCode mapper). Jobs log-loss fix (same shape). |
| 2 | [Features](./slices/02-features.md) | Plan-mode Ask AI (right-side panel). OpenCode #513 probe-and-attach. Prompt cache keepalive (#417). |

Slice 1 lands first and proves the foundation. Slice 2 builds on top.

Slice 1 itself ships as four PRs — see [`slices/01-chat-foundation/README.md`](./slices/01-chat-foundation/README.md) for the breakdown.

## Context strategy: how the chat gets its prior knowledge

The defining UX question for integrated chat is: **does the model know what the user was just working on?** That depends on how Plannotator was launched.

Every provider-harness has different capabilities for session forking, resumption, and live-session injection. And Plannotator itself gets launched via different paths (Claude Code hook, slash command, OpenCode plugin, Pi extension, standalone CLI) that carry different amounts of session context. The combination creates a matrix.

### Harness capabilities

| Harness | Fork a prior session | Resume a prior session | Inject into an actively running session |
|---|---|---|---|
| **Claude Code** | Yes: `claude -p --resume <id> --fork-session` (`cc-docs/cli-ref.md:59`) | Yes: `claude -p --resume <id>` | No |
| **Codex** | Not in SDK. Exists in Rust core (`core/src/thread_manager.rs:661`) and app-server protocol as `thread/fork` (`app-server-protocol/src/protocol/v2.rs:2850-2898`), accessible only via raw JSON-RPC. TypeScript SDK exposes only `startThread` and `resumeThread`. | Yes: `codex exec resume <id>` or `--last` (`codex-docs/non-interactive.md:150-157`), or SDK `codex.resumeThread(id)`. | No |
| **Pi** | Yes: RPC `fork` command (`pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:58`, implemented in `rpc-mode.ts:524`). Forks the currently loaded session at a specific user-message `entryId` (validated at `agent-session-runtime.ts:181`). Distinct from `SessionManager.forkFrom()`, which takes a source path. To fork an external session file: `switch_session` first, then `fork`. | Yes: RPC `switch_session` (`rpc-types.ts:58`) with `sessionPath`. | No (no file locking — two processes can't safely share a session file) |
| **OpenCode** | Yes: `client.session.fork({id, messageID?})`, works on in-progress sessions (`opencode/packages/opencode/src/session/index.ts:511-546`) | Yes: attach via `createOpencodeClient({baseUrl})` | Partial: `POST /session/{id}/message` with no server-side concurrency lock, only works if user started OpenCode with `--port` |

### Invocation paths

| How Plannotator was launched | Session id available? | Mechanism |
|---|---|---|
| Claude Code **hook** (ExitPlanMode / PermissionRequest) | Yes | `session_id` in hook stdin JSON (`cc-docs/sdk.md:982-989`). **Currently ignored** — our hook handler at `apps/hook/server/index.ts:910-914` doesn't parse it. |
| Claude Code **slash command** (`/plannotator-review`, etc.) | No (not in env or stdin) | Fallback: `findSessionLogsForCwd()` heuristic (`apps/hook/server/index.ts:559-699`) — scans `~/.claude/sessions/` for most-recent JSONL matching cwd. Already used by `plannotator annotate-last` today. |
| OpenCode (tool, command, or event) | Yes | `event.properties.sessionID` / `context.sessionID` — already extracted at `apps/opencode-plugin/commands.ts:107-108,185-186,217-218`. Currently not retained past initial use. |
| Pi extension (plan / review / annotate) | Yes | Available via `ctx.sessionManager.getSessionId()` — we maintain the extension code, just need to pass it through. |
| Codex (via `!plannotator review` shell-out) | Yes | `CODEX_THREAD_ID` env var injected into all children (`codex-rs/core/src/exec_env.rs:127-129`). |
| VS Code extension | No | No invoking agent context. |
| Standalone CLI (`plannotator review`) | No | No invoking agent context. |

### Resolution strategy (Matrix 3)

A pure, unit-testable function `resolveChatContext(launch: LaunchMetadata) → ChatContextStrategy` picks the best available context per launch path:

| Launch path | Strategy | Notes |
|---|---|---|
| Claude hook | `fork_by_id` | We have the exact session id from the hook payload. |
| Claude slash command | `fork_by_heuristic` | Uses `findSessionLogsForCwd()` to find the most-recent matching session. Same heuristic `annotate-last` relies on today. |
| OpenCode any path | `fork_by_id` | Session id is already in the event payload; we just need to retain it. |
| Pi extension | `fork_by_id` | Small diff: pass `ctx.sessionManager.getSessionId()` through the Pi extension launch flow. |
| Codex `!plannotator` | `resume_by_id` | Uses `CODEX_THREAD_ID`. Codex SDK has no fork (fork exists in Rust core + app-server as `thread/fork` but requires raw JSON-RPC, out of scope for Slice 1) — resume mutates the main thread. Accepted tradeoff. |
| VS Code / standalone | `fresh` | No agent context available. Chat still has the diff/plan as system prompt context. |

"Fresh" doesn't mean "no context." Every chat always gets the diff or plan as system prompt context. "Fresh" means no prior conversation history — the model doesn't know what you were just discussing with the agent before Plannotator opened.

## GitHub issues covered by this roadmap

| Issue | Title | Lands in |
|---|---|---|
| [#406](https://github.com/backnotprop/plannotator/issues/406) | In-browser AI responses difficult to read | Slice 1. Adapter-level thinking/answer separation + distinct rendering. |
| [#417](https://github.com/backnotprop/plannotator/issues/417) | Automatic configurable cache-keep-alive timer with dummy message injection | Slice 2. Server-side idle timer, `visible_inject` strategy, conservative defaults. |
| [#513](https://github.com/backnotprop/plannotator/issues/513) | OpenCode AI tab: spawns new `opencode serve` instead of reusing existing server | Slice 2. Probe configured port, attach via `createOpencodeClient` if an OpenCode server is running, spawn otherwise. |
| [#514](https://github.com/backnotprop/plannotator/issues/514) | OpenCode AI tab: responses not rendering (empty bubbles) | Slice 1. Localized fix at `mapOpenCodeEvent` in the OpenCode adapter (`packages/ai/providers/opencode-sdk.ts:338-479`). |

## Active parallel work: Code Tour + engine/model selection

A separate feature branch is already in active development, adding **Code Tour** as a third agent job provider alongside Claude and Codex review, plus **engine/model selection** UI for choosing which CLI and model to use. This work plugs into the existing agent job infrastructure — `buildCommand`, `onJobComplete`, capability detection — without changing the generic plumbing.

**Our spec work must not disrupt these in-flight changes.** The intersection points:

| Already in development | What we must respect |
|---|---|
| `AgentJobInfo` gains `engine?: string` and `model?: string` fields (`packages/shared/agent-jobs.ts`) | Slice 1 adds `output?: string` to the same type. Additive — add our field alongside theirs, don't restructure the type. |
| `buildCommand` signature is now `(provider, config)` to pass engine/model through (`packages/server/agent-jobs.ts`) | Assume the expanded `(provider, config)` signature. Don't revert to `(provider)`. |
| `tour` provider in capability detection: `{ id: "tour", available: !!Bun.which("claude") \|\| !!Bun.which("codex") }` | The log-loss fix must work for all providers including tour. Tour jobs stream stderr logs the same way as claude/codex. |
| Tour's `onJobComplete` stores results in a `tourResults` map (not `externalAnnotations`) with dedicated endpoints (`GET /api/tour/:jobId`) | No conflict — the log-loss fix is upstream in `agent-jobs.ts`, provider-specific result ingestion is downstream in `review.ts`. Don't assume all jobs produce externalAnnotations. |
| `useAgentJobs.ts` gains tour-specific handling (auto-open dialog on tour completion) | Slice 1 modifies this hook for log snapshot restoration. Add the snapshot logic without disrupting the tour completion handler. |

## What we are NOT doing

- **Touching agent jobs** beyond the one log-retention fix in Slice 1. Jobs work. We fix the log-loss-on-refresh bug and leave them alone. (Code Tour and engine/model selection are actively developing in parallel — see above. Our changes must be compatible with theirs.)
- **Writing a "shared runtime contract" or "jobs platform."** No new abstractions. Chat adopts the same SSE reliability pattern (heartbeat, snapshot, version counter) that jobs and external-annotations already use, but the code is separate, not a shared abstraction.
- **Writing Plannotator-owned transcripts.** The harnesses own session persistence. We store a session id in a cookie and ask the harness to do its thing. That's the full extent of our transcript involvement.
- **Surviving server restarts.** Chat lifetime is within one Plannotator server process. Server dies = fresh chat. That's acceptable for now (review sessions are ephemeral).
- **A general "hidden context injection" primitive.** The keepalive in Slice 2 uses `visible_inject` — a real user turn marked `maintenance: true` that the UI collapses. No silent injection, no hidden messages.
- **Blanket envelope expansion.** We add `thinking_delta` for #406 and that's it. New event kinds are separate PRs when a real need arises.
- **Provider tier labels.** The per-session context badge (Slice 1) already tells users "forked from X" or "fresh — no prior context," which surfaces the meaningful information. A separate "GA / Beta / Experimental" label system is unnecessary.
- **"Talk to my unrelated OpenCode session" from standalone launch.** The #513 fix (Slice 2) stops double-spawning; it doesn't add a session-picker UI for discovering and forking sessions on a running OpenCode server. That's a future product feature.

## Reference: design decisions from the alignment interview

These 15 decisions were resolved one-by-one during an interview session. They are the authoritative source for "why did we pick X over Y." Numbered for traceability.

| # | Decision | Choice | Notes |
|---|---|---|---|
| 1 | Chat product intent | Ask-AI helper scoped to code review and plan review | Not a standalone chat workspace or full agent surface. |
| 2 | Context strategy per launch path | Matrix 3 (see above) | Fork-by-id where we have the id, fork-by-heuristic for Claude slash commands, resume for Codex, fresh for standalone/VS Code. |
| 3 | Resolver function shape | Pure `resolveChatContext(launch) → strategy`, unit-testable, no I/O | Heuristic lookup happens at execution, not at resolution. Emits structured debug log. |
| 4 | Chat lifetime | Within one server lifetime only | Server-held in-memory session + cookie pointer. No harness resume for crash recovery. No Plannotator-owned transcript files. |
| 5 | Chat scoping | One conversation per review surface | Line-anchored questions, general chat, and plan-anchored questions all share one session. The anchor is injected as per-turn context ("user is asking about line 42: ..."), not a separate session. |
| 6 | SSE reconnect shape | Snapshot + tail | Server sends full transcript on connect, then live-tails. Matches agent-jobs and external-annotations house pattern. Prompt-cache-safe (provider subprocess untouched). |
| 7 | Jobs log-loss bug | Fix in the same pass | Jobs retain accumulated log output in-memory and include it in their snapshot event. Same shape as the chat fix. |
| 8 | Adapter envelope scope | Minimal — add kinds only as needed | `thinking_delta` for #406. #514 is a localized OpenCode mapper fix. No blanket expansion. |
| 9 | Plan-mode Ask AI timing | Ships in v1, sequenced after code-review chat stabilizes | Same endpoints, new right-side panel UI in the plan editor. |
| 10 | OpenCode #513 | Narrow fix: probe port, attach if found, spawn if not | No session-picker UI. No standalone-attach discovery feature. |
| 11 | Keepalive #417 | Ship in v1, conservative defaults | `ttlSeconds ≈ 270`, `visible_inject`, collapsed maintenance rows, per-session cost meter, `maxRenewals = 11`, global off switch. |
| 12 | Context transparency | Always-visible badge in chat header | Shows resolved strategy + clickable popover with full details (session id, strategy name, cwd, timestamp). |
| 13 | Plan-mode chat placement | Right-side panel mirroring code review | New layout region for the plan editor. |
| 14 | Scope completeness | 13 decisions cover it | No additional jobs/chat/review-AI issues to address. |
| 15 | Slice structure | Two slices: Foundation then Features | Slice 1 lands and proves the foundation. Slice 2 builds features on top. |

**Overrides during the interview:**
- **Codex was initially "fresh" in Matrix 3** — changed to `resume_by_id` after confirming that mutating the user's main Codex thread is acceptable. `CODEX_THREAD_ID` env var is available; Codex's `codex exec resume <id>` supports cross-process continuation. No fork exists for Codex.
- **Jobs were initially "don't touch"** — changed to "fix the log-loss bug in the same pass" after confirming the bug is real (server-side snapshot contains no accumulated logs, only metadata). The fix shape is identical to the chat transcript snapshot.
- **#513 was initially scoped with a session-picker UI** — narrowed to just the probe-and-attach fix after clarifying OpenCode's single-server-many-sessions architecture with the user.

## How to use these specs

Each slice doc is a guiding overview — scope, key files, acceptance criteria, open questions. They're not line-level designs. When a slice starts, a kickoff session should produce the concrete design doc for that slice.

All file citations use absolute paths:
- Plannotator: `/Users/ramos/cupcake/cupcake-rego/investigate-ai/...`
- External agent sources: `/Users/ramos/investigate-ai/{cc,codex,opencode,pi}/...`
- External agent docs: `/Users/ramos/investigate-ai/{cc,codex,opencode,pi}-docs/...`
