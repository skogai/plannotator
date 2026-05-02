# Slice 2 PR — Fork Picker (opt-in context inheritance)

> Followup to Slice 1. Replaces the auto-heuristic fork that was disabled in the aiv2 debug pass with an explicit, per-harness opt-in UI.

## Thesis

Auto-forking by cwd-guessing was a bad default: it gave users a slow first turn (30–60s cache-miss prefill on large sessions), a surprise "context inherited" behavior, and a cliff where forking from a still-active Claude Code session hangs. We turned it off. But the feature — resuming a prior conversation's context into a plannotator chat — is still valuable when the user asks for it.

The replacement is an explicit picker. Default state: fresh. Users who want to inherit context click a picker and choose the specific session to fork from. Each harness has different fork semantics; the UI honors that.

## Non-goals

- Automated "best guess" picking. If the user doesn't choose, they get fresh.
- Cross-harness forking (e.g. forking a Codex thread into a Claude chat). Pick-candidates list only candidates compatible with the selected provider.
- Browsing sessions across cwds. Scope to the current working directory.
- Editing or previewing the forked session itself.

## Per-harness semantics (the spec's heart)

The picker isn't one thing — each harness has different inheritance primitives. The UI must match the primitive available.

| Harness | Parent unit | Mechanism | SDK call | Behavior |
|---|---|---|---|---|
| **Claude Code** | `.jsonl` session file | `--resume <id> --fork-session` | `provider.forkSession({context.parent.sessionId})` | Branches; original untouched. Safe. |
| **Codex** | Thread ID | `codex.resumeThread(id)` | `provider.resumeSession(threadId)` | **Mutates original thread.** User's terminal Codex sees our messages interleaved. Explicit warning required. |
| **OpenCode** | Session ID | Create new session with `parentID` | `provider.forkSession({context.parent.sessionId})` | Branches; inherits full subagent tree via parent walk. |
| **Pi** | `{sessionPath, entryId}` | RPC `switch_session` + `fork <entryId>` | `provider.forkSession({context.parent.sessionPath, context.parent.entryId})` | Branches at a specific user-message anchor. |
| **Standalone / VS Code** | none | n/a | n/a | Picker shows "No fork available — fresh chat only". |

The existing `AIProvider.capabilities.{fork,resume}` already encodes which mechanism each supports. We build on that.

## UX design

### Entry point — AIConfigBar dropdown

The picker lives alongside the existing provider/model/effort/thinking dropdowns in `AIConfigBar.tsx`, at the bottom of the chat panel. Pre-chat config belongs here; the `ContextBadge` stays read-only and post-chat as a status indicator.

The new control is labeled **"Context"** and shows:
- `New chat` (default)
- `Fork: <harness> · <age>` when a candidate is selected

Clicking opens a menu reusing the existing `ai-config-menu` styling (same as provider/model dropdowns) with:
- **`New chat`** option at top, always present, auto-selected initially
- Up to 5 candidate rows for the current provider + cwd, most recent first
- A `No prior sessions` empty-state row when nothing is available for this provider

Session reset behaves exactly like provider/model changes today: the "New chat session" amber flash shows if there's an active session, `resetSession()` fires, and the next user prompt creates a new server session with `context.parent` populated from the selection.

### Candidate row anatomy

Each row is compact — matches the existing menu's tight density:

```
  Sonnet 4.6 · 2h ago · ~180K tok
  "Updated the review endpoint to handle..."
```

- Title line: model (if known) · age · approximate token count
- Subtitle: last user-visible text from that session, one line, truncated
- Right-side: check mark when active; warning icon for Codex (mutates thread)

### States to support

1. **Loading** — menu shows a subtle "Loading…" row while candidates fetch
2. **No candidates** — single disabled row: "No prior sessions in this directory"
3. **Candidates available** — `New chat` + candidates, user picks one
4. **Codex resume warning** — Codex candidates show a secondary line: "Writes into your terminal's thread"
5. **Provider without fork/resume capability** — hide the picker entirely (don't show a disabled control)

### Persistence

- Cookie key: `plannotator-chat-fork-review-<port>` carrying `{providerId, parent}`
- Invalidated on: provider change, model change, explicit `New chat` selection, session eviction

### Interaction with other config

- `handleAIConfigChange` already triggers `aiChat.resetSession()` on any config change. Context picker selection flows through the same handler.
- When provider changes, the picker re-fetches candidates for the new provider. Any previous `parent` selection is cleared (parents are provider-specific).
- When the user has no session yet (no first message sent), no amber flash — the selection just updates silently.

### Why not the badge

The `ContextBadge` is a post-chat status indicator — it renders only when `strategy !== null`, which requires a created session, which requires a sent message. For the opt-in case (pre-chat), there's nothing to show. The AIConfigBar is always visible. It's also where users already expect to find "which AI, which model, which knobs" — context inheritance is the same kind of decision.

## Backend shape

### New endpoint

```
GET /api/ai/fork-candidates?cwd=<path>&providerId=<id>
```

Response:

```ts
{
  providerName: "claude-agent-sdk" | "codex-sdk" | "opencode-sdk" | "pi-sdk";
  candidates: ForkCandidate[];
}

interface ForkCandidate {
  /** Opaque ID — the POST /api/ai/session body passes this back as context.parent. */
  id: string;
  /** Display-only. */
  label: string;
  /** Relative age string ("2m ago", "3h ago", "yesterday"). */
  age: string;
  /** UNIX ms for sorting and debug. */
  lastActiveAt: number;
  /** Optional — shown when available. */
  model?: string;
  /** Rough token count for cost-hint UX. */
  tokenEstimate?: number;
  /** Last user-visible line, truncated to 120 chars. */
  preview?: string;
  /** Provider-specific fields — client passes through untouched on select. */
  parentFields: Record<string, unknown>;
}
```

### New provider interface method

```ts
// packages/ai/types.ts (addition to AIProvider)
listForkCandidates?(cwd: string, limit?: number): Promise<ForkCandidate[]>;
```

Optional so `standalone` / `vscode` providers (if any get added) can omit.

### Per-provider implementation sketches

**Claude (`claude-agent-sdk.ts`):**
- Wrap existing `findSessionLogsForCwd(cwd)` from `session-log.ts`.
- For each matched `.jsonl` path, read first + last JSONL line (cheap — no full parse) to extract model, last user message, and summary. Use `mtimeMs` for age. Use file size / ~4 for rough token estimate.
- Return up to `limit` (default 5), most recent first.
- **Do not include sessions that are actively being written to** (mtime within ~10s) — keeps the "this is your live Claude Code parent" hang from coming back.

**Codex (`codex-sdk.ts`):**
- SDK check: does `@openai/codex-sdk@0.118.0` expose a thread listing? Audit during implementation — if not, fall back to just the `CODEX_THREAD_ID` env var as the single candidate.
- Candidates are just `{threadId}`. Preview comes from... TBD — may need SDK research.

**OpenCode (`opencode-sdk.ts`):**
- OpenCode's HTTP API exposes `GET /sessions` (confirm during impl). Filter by cwd metadata if available.
- Preview from the session's last assistant message.

**Pi (`pi-sdk.ts` / `pi-sdk-node.ts`):**
- Use Pi RPC's session-list facility (already typed in `pi/packages/coding-agent/src/modes/rpc/rpc-client.ts`).
- Preview from the entry history.

### Session creation changes

`POST /api/ai/session` already accepts `context.parent` with arbitrary fields. Client passes `candidate.parentFields` verbatim. The endpoint routes to `provider.forkSession` / `resumeSession` based on capability (same logic that runs today for hook-provided session IDs). **No new routing logic needed** — this is by design.

### Heuristic scanner

Keep `resolveClaudeSessionIdByCwd` in `packages/server/session-log.ts` but only call it from the fork-candidates endpoint now, not from session creation. Session creation is strictly what the client asks for.

## Files

**New:**
- `specs/ai-update-spec-v2/slices/02-fork-picker.md` (this file)

**Modified — backend:**
- `packages/ai/types.ts` — add `ForkCandidate` type + optional `listForkCandidates` on `AIProvider`
- `packages/ai/endpoints.ts` — add `GET /api/ai/fork-candidates` handler
- `packages/ai/providers/claude-agent-sdk.ts` — implement `listForkCandidates`
- `packages/ai/providers/codex-sdk.ts` — implement (scope: minimum viable)
- `packages/ai/providers/opencode-sdk.ts` — implement
- `packages/ai/providers/pi-sdk.ts` + `pi-sdk-node.ts` — implement

**Modified — client:**
- `packages/review-editor/components/AIConfigBar.tsx` — add `Context` dropdown alongside existing provider/model/effort/thinking menus
- `packages/review-editor/components/AITab.tsx` + `ReviewSidebar.tsx` — thread new `selectedParent`/`onParentChange` props through, same pattern as `selectedThinking`
- `packages/review-editor/hooks/useAIChat.ts` — accept `parent` in options, include in POST `/api/ai/session` body under `context.parent`
- `packages/review-editor/App.tsx` — extend `aiConfig` state with `parent` field, persist via cookie, handle provider-change invalidation
- `packages/review-editor/components/ContextBadge.tsx` — unchanged (stays read-only status display)

**Modified — server wiring:**
- `packages/server/review.ts` — inject `listForkCandidates` call through `createAIEndpoints` deps
- `apps/pi-extension/server/serverReview.ts` — same on the Pi side

## Execution plan

### Phase 1 — Backend types + endpoint (2–3h)

- Add `ForkCandidate` type + optional `AIProvider.listForkCandidates(cwd)` method
- `GET /api/ai/fork-candidates` handler
- Unit test shape

### Phase 2 — Per-provider `listForkCandidates` (half-day)

All four adapters implement the method. Land in the single PR:

- **Claude** (`claude-agent-sdk.ts`) — wrap existing `findSessionLogsForCwd`; read first+last JSONL line per match for preview. Size/4 → token estimate. Age from `mtimeMs`.
- **Codex** (`codex-sdk.ts`) — single candidate from `CODEX_THREAD_ID` env var if present; empty array otherwise.
- **OpenCode** (`opencode-sdk.ts`) — hit OpenCode's session list API, filter by cwd.
- **Pi** (`pi-sdk.ts` + `pi-sdk-node.ts`) — use Pi RPC session list.

Each adapter's list method is independent — implement in parallel.

### Phase 3 — UI in `AIConfigBar` (half-day)

- Add `Context` dropdown using the existing `ai-config-menu` pattern
- Fetch candidates lazily on menu open
- `New chat` default + candidates + empty-state handling
- Provider-change clears current selection (re-fetch)
- Cookie persistence
- Wire `parent` through `AITab` → `ReviewSidebar` → `App` → `useAIChat` → POST `/api/ai/session` body

### Phase 4 — Warnings + polish (2–3h)

- Codex candidate renders "Writes into your terminal thread" subtitle
- Cost hint for Claude candidates >100K tokens ("~30s to first response")
- Loading and empty states
- Build + tests green

## Acceptance criteria

- [ ] Default chat is `fresh` for all four providers
- [ ] ContextBadge opens picker showing Claude fork candidates in the current cwd
- [ ] Selecting a candidate creates a forked chat, badge updates to "Forked from …"
- [ ] "Fresh chat" action resets picker state
- [ ] Candidate list excludes Claude sessions modified within the last 10s
- [ ] Codex candidates show a "mutates original thread" note
- [ ] OpenCode candidates surface from the OpenCode API
- [ ] Pi candidates surface from Pi RPC
- [ ] Choice persists across browser refresh via cookie
- [ ] Unit tests for Claude `listForkCandidates` (cwd filter, age filter, preview read)

## Resolved design decisions

All open questions resolved before implementation:

- **Q1 fetch timing** — Lazy. Fetch on menu open, not page load.
- **Q2 live-session filter** — Dropped. Was based on a rejected hypothesis (H6 in the debug session); the actual hang was `idleTimeout`, fixed separately. No filter needed.
- **Q3 Codex exposure** — Only the user's current `CODEX_THREAD_ID` appears as a candidate (they already know this thread). Row carries a "writes into your terminal thread" warning. No other Codex threads surfaced.
- **Q4 v1 scope** — All four providers (Claude, Codex, OpenCode, Pi). Feature ships complete, not in phases.
- **Q5 placement** — `AIConfigBar` dropdown alongside provider/model/effort/thinking.
- **Q6 auto-preselect** — No. Every chat starts at `New chat`.
- **Q7 clear to fresh** — Select `New chat` from the same picker.

## Risk surface

- **Reading 12MB JSONL for preview**: first+last line only; use `readline` with a seek to EOF for the last line. Don't full-parse.
- **Provider API cost**: OpenCode's list endpoint may be slow or paginated. Default limit = 5, expose with pagination if needed.
- **Live-session filter**: 10s is arbitrary; monitor for false negatives (user legitimately wants a session they just closed).
- **Codex concurrent-writer**: if user picks their active Codex terminal thread, our query will collide with their terminal. Adapter's existing `CodexBusyError` path surfaces the collision. Inline warning in the picker reduces user confusion.

## Out of scope for this PR

- Cross-cwd session browsing (power-user feature; add when someone asks)
- Manual thread ID paste input (cover 99% of cases with the picker; niche case not worth UI)
- Fork preview diff (show user what turns they'd inherit — nice but expensive)
- Per-harness coloring / icons in the picker (comes free once harness is in the row)
