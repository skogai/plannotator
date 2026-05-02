# Slice 1 — Chat Foundation PR Breakdown

The parent slice ([`../01-chat-foundation.md`](../01-chat-foundation.md)) describes the full scope and design. This subdirectory breaks that scope into four PR-sized units that land in order.

| PR | File | Ships | Depends on |
|----|------|-------|------------|
| 1 | [`01-reliability.md`](./01-reliability.md) | Resolver + launch-metadata plumbing + adapter strategy execution + server transcript + new SSE stream + cookie + client reconnect + jobs log-loss fix + prompt caching enablement per provider | — |
| 2 | [`02-context-badge.md`](./02-context-badge.md) | Always-visible context badge in the chat header with popover | PR 1 |
| 3 | [`03-thinking-fix.md`](./03-thinking-fix.md) | `thinking_delta` envelope + Claude adapter branching + collapsible thinking render (#406) | PR 1 (for the envelope) |
| 4 | [`04-empty-bubbles-fix.md`](./04-empty-bubbles-fix.md) | OpenCode event-mapper silent-drop fix + regression fixture (#514) | — (independent) |

## Why four PRs and not one

**PR 1 is the coherent reliability story.** Units 1-9 of the plan are interdependent and tell one thesis: chat survives refresh, jobs retain logs, model knows prior context. Splitting them would create interim states where the resolver exists but adapters don't use it, or the new SSE stream exists but the client doesn't connect to it. Ship them together.

**PRs 2-4 are additive polish and targeted bug fixes.** Each is independently reviewable and doesn't gate the rest. Landing them separately keeps PR 1's diff focused on the reliability thesis and lets reviewers evaluate each bug fix on its own merits (especially PR 4, whose scope depends on what the captured OpenCode fixture reveals).

PRs 3 and 4 can land in any order after PR 1 is merged. PR 2 also depends on PR 1 because the context badge consumes the resolved strategy that PR 1 produces.

## Alignment with the parent slice

Each PR file maps back to specific numbered items from the parent `01-chat-foundation.md`:

| Parent slice item | Landing PR |
|---|---|
| 1. `resolveChatContext()` resolver | PR 1 |
| 2. Cookie-persisted session id | PR 1 |
| 3. Snapshot + tail SSE reconnect | PR 1 |
| 4. Jobs log-loss fix | PR 1 |
| 5. SSE heartbeats | PR 1 |
| 6. Context badge | PR 2 |
| 7. Fix #406 (thinking vs answer) | PR 3 |
| 8. Fix #514 (OpenCode empty bubbles) | PR 4 |
| Per-harness adapter changes (resolver execution) | PR 1 |
| Prompt caching enablement (cross-cutting — all four providers) | PR 1 |
