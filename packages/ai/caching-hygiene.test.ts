/**
 * Caching hygiene tests — Slice 1 PR 1, Step 9.
 *
 * Prompt caching across providers relies on three invariants:
 *
 *   1. The system prompt (stable prefix) is deterministic — same context in,
 *      same bytes out, across every turn. Any nondeterminism (timestamps,
 *      sorted-by-insertion-order maps, etc.) destroys cache-hit eligibility.
 *
 *   2. `buildEffectivePrompt` does NOT re-prepend the system preamble on
 *      subsequent turns. Turn 1 carries the preamble; turn 2+ sends only
 *      the user prompt so the server-side session resume produces identical
 *      prefix bytes to turn 1 minus the final user message.
 *
 *   3. The transcript accumulator never mutates prior turns. Cache keys on
 *      the server-side hash the serialized conversation prefix; any
 *      retroactive change invalidates downstream caches (this is what the
 *      OpenClaw PRs 58036/8/8 fixed in their own harness).
 *
 * These unit tests lock the invariants so regressions show up in `bun test`
 * rather than as a live-cache-miss surprise in the acceptance pass.
 *
 * Live end-to-end verification (cache_creation_input_tokens > 0 on turn 1,
 * cache_read_input_tokens > 0 on turn 2) requires a real provider and lives
 * in the manual acceptance section of the plan — not automatable here.
 */

import { describe, test, expect } from "bun:test";
import {
  buildSystemPrompt,
  buildEffectivePrompt,
  buildForkPreamble,
} from "./context.ts";
import { accumulateTurn, createAssistantTurn } from "@plannotator/shared/chat-transcript";
import type { AIContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const codeReviewCtx: AIContext = {
  mode: "code-review",
  review: {
    patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    filePath: "src/x.ts",
    lineRange: { start: 10, end: 20, side: "new" },
    selectedCode: "function foo() { return 1; }",
    annotations: "[no annotations yet]",
  },
};

const planReviewCtx: AIContext = {
  mode: "plan-review",
  plan: {
    plan: "# Plan\n\nDo the thing.",
    annotations: "[no annotations yet]",
  },
};

// ---------------------------------------------------------------------------
// Invariant 1 — system prompt determinism
// ---------------------------------------------------------------------------

describe("caching hygiene: buildSystemPrompt is deterministic", () => {
  test("code-review context produces identical output on repeat calls", () => {
    const a = buildSystemPrompt(codeReviewCtx);
    const b = buildSystemPrompt(codeReviewCtx);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  test("plan-review context produces identical output on repeat calls", () => {
    const a = buildSystemPrompt(planReviewCtx);
    const b = buildSystemPrompt(planReviewCtx);
    expect(a).toBe(b);
  });

  test("distinct contexts produce distinct prompts (sanity)", () => {
    expect(buildSystemPrompt(codeReviewCtx)).not.toBe(
      buildSystemPrompt(planReviewCtx),
    );
  });

  test("buildForkPreamble is also deterministic", () => {
    const parented: AIContext = {
      ...codeReviewCtx,
      parent: { sessionId: "claude-abc", cwd: "/repo" },
    };
    const a = buildForkPreamble(parented);
    const b = buildForkPreamble(parented);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 — effective prompt doesn't re-prepend on subsequent turns
// ---------------------------------------------------------------------------

describe("caching hygiene: buildEffectivePrompt skips preamble on turn 2+", () => {
  test("first query prepends the preamble once", () => {
    const preamble = "SYSTEM CONTEXT HERE";
    const out = buildEffectivePrompt("hello", preamble, /* firstQuerySent */ false);
    expect(out).toContain(preamble);
    expect(out).toContain("hello");
  });

  test("subsequent query returns prompt unchanged (cache prefix stable)", () => {
    const preamble = "SYSTEM CONTEXT HERE";
    const out = buildEffectivePrompt("hello", preamble, /* firstQuerySent */ true);
    expect(out).toBe("hello");
    expect(out).not.toContain(preamble);
  });

  test("null preamble is a no-op even on first query", () => {
    expect(buildEffectivePrompt("hi", null, false)).toBe("hi");
  });

  test("anchor text in the user prompt doesn't pollute the preamble", () => {
    // The client prepends anchor text to the USER prompt, not the system.
    // Verify that a prompt containing anchor text still passes through
    // unchanged on turn 2+ — i.e., the anchor is properly on the varying
    // suffix side of the cache boundary.
    const anchoredPrompt = "Re: src/x.ts, lines 10-20 (new side)\n\nis this right?";
    expect(buildEffectivePrompt(anchoredPrompt, "PREAMBLE", true)).toBe(
      anchoredPrompt,
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 — accumulator doesn't mutate prior turns
// ---------------------------------------------------------------------------

describe("caching hygiene: accumulator preserves prior turn immutability", () => {
  test("accumulateTurn returns a new object, old turn unchanged", () => {
    const t0 = createAssistantTurn("a1", 1000);
    const snapshot = JSON.stringify(t0);
    const t1 = accumulateTurn(t0, { type: "text_delta", delta: "hi" }, 1001);
    // Old turn must match its snapshot byte-for-byte.
    expect(JSON.stringify(t0)).toBe(snapshot);
    // New turn must be a distinct object with updated content.
    expect(t1).not.toBe(t0);
    expect(t1.updatedAt).not.toBe(t0.updatedAt);
  });

  test("repeated deltas never mutate intermediate turns", () => {
    const turns = [createAssistantTurn("a1", 1000)];
    const deltas = ["A", "B", "C", "D"];
    for (const d of deltas) {
      turns.push(accumulateTurn(turns[turns.length - 1]!, { type: "text_delta", delta: d }));
    }
    // Walk back through the history and verify each intermediate still has
    // the cumulative text it had when it was produced.
    // turns[0]: "", turns[1]: "A", turns[2]: "AB", turns[3]: "ABC", turns[4]: "ABCD"
    const expectedTexts = ["", "A", "AB", "ABC", "ABCD"];
    for (let i = 0; i < turns.length; i++) {
      const content = turns[i]!.content as { text: string };
      expect(content.text).toBe(expectedTexts[i]!);
    }
  });
});
