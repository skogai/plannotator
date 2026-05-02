# PR 3 — Thinking vs Answer Separation (#406)

> Part of Slice 1 — Chat Foundation. See [`../01-chat-foundation.md`](../01-chat-foundation.md) (item 7) for full design context. Fixes [#406](https://github.com/backnotprop/plannotator/issues/406). Claude-only scope.

## Thesis

The AI chat renders Claude's reasoning tokens ("thinking") and the final answer in one undifferentiated blob. Users can't tell where the answer starts. The only existing "thinking" treatment is a placeholder shown *before* any text arrives (`AITab.tsx:390-393`); once tokens flow, thinking and answer are indistinguishable.

Claude's SDK already emits reasoning tokens as distinct stream events. We're not losing the signal at the SDK boundary — we're collapsing it in the adapter. The fix is to thread that distinction through the envelope and branch the UI render.

## Scope

Unit 11 from the plan. **Claude only in this slice.** Codex and Pi don't distinguish reasoning tokens — they continue emitting `text_delta` only. OpenCode **does** surface reasoning, but via a different shape than Claude: `message.part.updated` with `part.type === "reasoning"` followed by `message.part.delta` events sharing the same `partID` (`packages/opencode/src/session/message-v2.ts:130`, `processor.ts:223`). Routing OpenCode reasoning to the `thinking_delta` envelope requires partID correlation in the accumulator — deferred to a follow-up slice, not part of this PR. The `thinking_delta` envelope kind landed in PR 1 reserves the slot; Slice 3 wires the Claude side; OpenCode reasoning coverage is separate work.

**Three changes:**

1. **Envelope:** add `AIThinkingDeltaMessage { type: "thinking_delta"; delta: string }` to the `AIMessage` union at `packages/ai/types.ts:142-150`.
2. **Adapter:** in `claude-agent-sdk.ts`'s message mapper (around lines 212-220), branch on content block type — `thinking` → emit `thinking_delta`; `text` → emit `text_delta` as today.
3. **UI:** in `AITab.tsx`'s response render (lines 378-395), maintain two buffers (`response.thinking`, `response.text`). Render thinking in a collapsible section (collapsed by default, muted styling), answer below in the normal markdown renderer. Replace the current "Thinking..." placeholder at lines 390-393 with: if `response.thinking && !response.text`, show thinking expanded; once `response.text` arrives, collapse automatically.

## Files

**Modified:**
- `packages/ai/types.ts` (add `AIThinkingDeltaMessage` to `AIMessage` union)
- `packages/ai/providers/claude-agent-sdk.ts` (branch on content block type in message mapper)
- `packages/review-editor/components/AITab.tsx` (separate render paths for thinking vs answer)
- `packages/review-editor/hooks/useAIChat.ts` (extend `AIChatEntry.response` shape with `thinking: string`; handle `thinking_delta` in SSE parsing loop adjacent to existing `text_delta` handling at line 177)

## Dependencies

Can land independently of PRs 2 and 4. Technically independent of PR 1 too, but the `thinking_delta` events flow through the same SSE pipeline PR 1 introduces — simpler to land after PR 1 so the envelope change is consumed by the new persistent stream from the start.

## Acceptance criteria

- [ ] Asking Claude a reasoning-heavy question renders thinking in a collapsed section, answer below, visually distinct
- [ ] Thinking can be expanded by clicking
- [ ] Before any text arrives, thinking (if present) shows expanded; once answer starts streaming, thinking auto-collapses
- [ ] Codex and Pi chat responses are unchanged (no thinking section rendered)
- [ ] OpenCode chat responses also unchanged in this slice — reasoning continues to render inline with text (deferred to a follow-up slice that wires partID correlation)
- [ ] No regression in the "Thinking..." placeholder for providers that have no reasoning tokens — they still get the streaming cursor + "Thinking..." text

## Related silent-drop audit

While in the Claude adapter, apply the same dev-mode silent-drop warning pattern that PR 4 adds to the OpenCode adapter. Checks whether any raw Claude events produce zero translated events. Not a blocker for this PR — purely additive diagnostics.
