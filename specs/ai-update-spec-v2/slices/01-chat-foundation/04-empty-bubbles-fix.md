# PR 4 — OpenCode Empty Bubbles (#514)

> Part of Slice 1 — Chat Foundation. See [`../01-chat-foundation.md`](../01-chat-foundation.md) (item 8) for full design context. Fixes [#514](https://github.com/backnotprop/plannotator/issues/514). OpenCode-only scope.

## Thesis

OpenCode AI chat responses render as empty bubbles. Our original hypothesis was a field-name mismatch in `mapOpenCodeEvent` at `packages/ai/providers/opencode-sdk.ts:338-479`. **That hypothesis was wrong.**

Verified against OpenCode source (`packages/opencode/src/session/message-v2.ts:489`): text deltas arrive as

```json
{
  "type": "message.part.delta",
  "properties": { "sessionID": "...", "messageID": "...", "partID": "...", "field": "text", "delta": "..." }
}
```

Our current check at line 348 — `if (field === "text" && delta) return [{ type: "text_delta", delta }]` — **already matches this shape**. The field-name path is correct.

The real bug is almost certainly ordering and empty-state rendering. OpenCode emits `message.part.updated` with an empty `text` field when a part starts, then `message.part.delta` events populate it, then a final `part.updated` arrives with complete text (`packages/opencode/src/session/processor.ts:406`). If the UI consumes the initial empty `part.updated` as the final state, or if the accumulator doesn't correlate deltas to the part by `partID`, text goes missing.

Fix direction: run the fixture capture first, then root-cause from the real event sequence. Do not assume the hypothesis until verified.

## Scope

Unit 12 from the plan. OpenCode only.

**Four steps:**

1. **Add dev-mode silent-drop logging** at the top of `mapOpenCodeEvent` (line 338): log `{ eventType, props }`. At the end, if the translated array is empty, log a warning with the raw event. Run for diagnostic signal, not as the fix.
2. **Capture a real OpenCode event sequence** as a test fixture. Run a live OpenCode chat with the dev logging enabled, save a complete event sequence — including `message.part.updated` before, during, and after delta flow — to a JSON file in the test directory.
3. **Root-cause from the fixture.** Likely causes:
   - The accumulator is storing each `message.part.updated` as a fresh assistant message instead of merging into the existing part by `partID`, so deltas land on the wrong part.
   - The UI treats an empty-text `part.updated` as "final state" and stops listening.
   - A combination: the adapter emits a synthetic `text` event with empty content when `part.updated` arrives, pre-empting later deltas.
4. **Fix based on findings**, then write a regression test that replays the fixture through `mapOpenCodeEvent` and the accumulator end-to-end, asserting final assistant text is non-empty.

Alignment with Slice 1 PR 1: Slice 1's `accumulateTurn` (per D9, updated with OpenCode-aware partID correlation) is probably the right place for the real fix. This slice may collapse into a test + small adapter tweak if PR 1 lands first with the partID-aware accumulator.

## Files

**Modified:**
- `packages/ai/providers/opencode-sdk.ts` (`mapOpenCodeEvent` at lines 338-479 — the actual fix, plus dev-mode logging)

**New:**
- `packages/ai/providers/opencode-sdk.test.ts` (fixture replay regression test)
- Test fixture file (captured real event sequence)

## Dependencies

Fully independent — can land before, after, or in parallel with PRs 1, 2, 3. Does not touch any shared types, endpoints, or hooks. The only cross-PR consideration is that PR 3 adds a similar dev-mode silent-drop warning to the Claude adapter; the pattern can be copied in either direction.

## Acceptance criteria

- [ ] OpenCode chat responses render text content correctly — no empty bubbles
- [ ] Regression test passes: fixture replay through `mapOpenCodeEvent` yields at least one non-empty `text_delta`
- [ ] Dev-mode silent-drop warning fires in the console when any raw event produces zero translated events (caught once, noisy thereafter if the adapter regresses)
- [ ] Tool use / tool result / permission request events continue to work (fixture covers these too, or separate assertions)

## Open risk

The real root cause is diagnosed from the captured fixture, not assumed. The original field-name mismatch hypothesis was wrong. If the fixture reveals a cause we haven't enumerated here (provider-specific variations, streaming vs non-streaming providers, subagent-child events leaking into the main stream), the scope of this slice may expand. The dev-mode silent-drop warning is the safety net — it fires for every raw event that produces zero translated events, so any missed shape surfaces immediately during testing.

If PR 1 lands first with the partID-aware `accumulateTurn`, this slice may reduce to just the fixture + regression test (no adapter change needed). Confirm during implementation.
