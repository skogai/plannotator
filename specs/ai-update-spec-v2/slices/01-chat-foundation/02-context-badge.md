# PR 2 — Context Badge

> Part of Slice 1 — Chat Foundation. See [`../01-chat-foundation.md`](../01-chat-foundation.md) (item 6) for full design context. Depends on [PR 1](./01-reliability.md).

## Thesis

Users can't tell whether the chat model knows what they were just working on before Plannotator opened. When the context includes prior conversation (via `fork_by_id` / `fork_by_heuristic` / `resume_by_id`), the chat feels psychic. When it doesn't (`fresh`), users wonder "why doesn't the model remember X?" A small always-visible badge in the chat header surfaces this directly.

## Scope

Unit 10 from the plan.

**New component:** `<ContextBadge>` rendered at the top of `AITab.tsx`, above the message list.

**Reads:** `strategy: ChatContextStrategy | null` from `useAIChat` (which got it from the session creation response or the snapshot event — both pathways exist after PR 1).

**Renders:** one-line human-readable summary:
- `fork_by_id` → "Forked from Claude session abc1234 · 2m ago"
- `fork_by_heuristic` → "Forked from Claude session (matched by cwd) · 2m ago"
- `resume_by_id` → "Resumed Codex thread ef5678"
- `fresh` → "Fresh chat — no prior context"

**Clickable:** expands a popover with full debug details — strategy kind, session ID, cwd, timestamp, any warnings from the resolver debug log.

**Styling:** reuses the existing `"file"` scope badge pattern from `AITab.tsx:365-369` — `text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary`.

## Files

**Modified:**
- `packages/review-editor/components/AITab.tsx` (add `<ContextBadge>` component at top of chat area, plus popover)
- `packages/review-editor/hooks/useAIChat.ts` (expose `strategy` in return value alongside existing fields at lines 314-326)

**Reuses from PR 1:**
- `ChatContextStrategy` type from `packages/ai/resolve-context.ts`
- Session creation response shape and snapshot event shape

## Acceptance criteria

- [ ] Badge visible in code review chat header in all four strategy states
- [ ] Correct summary text per strategy kind
- [ ] Clicking the badge opens a popover with strategy kind, session ID, cwd, timestamp
- [ ] Styling matches the existing "file" scope badge visually
- [ ] Badge updates correctly on session reset (strategy changes accordingly)
- [ ] For `fork_by_heuristic` with a stale match, badge surfaces "matched session X · Ym ago" so users can tell if the heuristic picked wrong
