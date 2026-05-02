import { describe, test, expect } from "bun:test";
import {
  accumulateTurn,
  abortTurn,
  createAssistantTurn,
  createUserTurn,
  type ChatTurn,
  type AssistantTurnContent,
} from "./chat-transcript.ts";
import type { AIMessage } from "../ai/types.ts";

function makeAssistant(id: string = "a1"): ChatTurn {
  return createAssistantTurn(id, 1000);
}

function content(turn: ChatTurn): AssistantTurnContent {
  return turn.content as AssistantTurnContent;
}

describe("accumulateTurn — text deltas", () => {
  test("merges consecutive text_delta into content.text", () => {
    let t = makeAssistant();
    t = accumulateTurn(t, { type: "text_delta", delta: "Hello, " }, 1001);
    t = accumulateTurn(t, { type: "text_delta", delta: "world!" }, 1002);
    expect(content(t).text).toBe("Hello, world!");
    expect(t.status).toBe("streaming");
    expect(t.updatedAt).toBe(1002);
  });

  test("terminal `text` message overwrites partial deltas", () => {
    let t = makeAssistant();
    t = accumulateTurn(t, { type: "text_delta", delta: "Partial" }, 1001);
    t = accumulateTurn(t, { type: "text", text: "Full answer" }, 1002);
    expect(content(t).text).toBe("Full answer");
  });
});

describe("accumulateTurn — thinking deltas", () => {
  test("merges thinking_delta into content.thinking separately from text", () => {
    let t = makeAssistant();
    t = accumulateTurn(t, { type: "thinking_delta", delta: "Let me think…" }, 1001);
    t = accumulateTurn(t, { type: "text_delta", delta: "Answer: 42" }, 1002);
    expect(content(t).thinking).toBe("Let me think…");
    expect(content(t).text).toBe("Answer: 42");
  });
});

describe("accumulateTurn — tool correlation", () => {
  test("tool_use then tool_result correlates by toolUseId", () => {
    let t = makeAssistant();
    t = accumulateTurn(
      t,
      {
        type: "tool_use",
        toolName: "Read",
        toolInput: { path: "/tmp/x" },
        toolUseId: "tu-1",
      },
      1001,
    );
    t = accumulateTurn(
      t,
      { type: "tool_result", toolUseId: "tu-1", result: "file contents" },
      1002,
    );
    expect(content(t).toolCalls).toHaveLength(1);
    expect(content(t).toolCalls[0]).toEqual({
      id: "tu-1",
      name: "Read",
      input: { path: "/tmp/x" },
      result: "file contents",
    });
  });

  test("tool_result without toolUseId attaches to the last unresolved call", () => {
    let t = makeAssistant();
    t = accumulateTurn(
      t,
      { type: "tool_use", toolName: "A", toolInput: {}, toolUseId: "tu-1" },
      1001,
    );
    t = accumulateTurn(
      t,
      { type: "tool_use", toolName: "B", toolInput: {}, toolUseId: "tu-2" },
      1002,
    );
    t = accumulateTurn(t, { type: "tool_result", result: "for B" }, 1003);
    const calls = content(t).toolCalls;
    expect(calls[0].result).toBeUndefined();
    expect(calls[1].result).toBe("for B");
  });
});

describe("accumulateTurn — permissions", () => {
  test("permission_request then permission_resolved updates the entry", () => {
    let t = makeAssistant();
    t = accumulateTurn(
      t,
      {
        type: "permission_request",
        requestId: "pr-1",
        toolName: "Bash",
        toolInput: { command: "ls" },
        toolUseId: "tu-x",
      },
      1001,
    );
    t = accumulateTurn(
      t,
      { type: "permission_resolved", requestId: "pr-1", allowed: true },
      1002,
    );
    expect(content(t).permissionRequests).toHaveLength(1);
    expect(content(t).permissionRequests[0]).toMatchObject({
      id: "pr-1",
      resolved: true,
      allowed: true,
    });
  });

  test("permission_request preserves UI-display fields for rehydration", () => {
    let t = makeAssistant();
    t = accumulateTurn(
      t,
      {
        type: "permission_request",
        requestId: "pr-2",
        toolName: "Bash",
        toolInput: { command: "rm -rf /" },
        toolUseId: "tu-y",
        title: "Allow Bash execution?",
        displayName: "Bash",
        description: "Claude wants to run a shell command in your workspace",
      },
      1001,
    );
    const pr = content(t).permissionRequests[0];
    expect(pr).toMatchObject({
      id: "pr-2",
      toolName: "Bash",
      title: "Allow Bash execution?",
      displayName: "Bash",
      description: "Claude wants to run a shell command in your workspace",
    });
    expect(pr.resolved).toBeUndefined();
  });

  test("permission_resolved for an unknown id is a no-op", () => {
    let t = makeAssistant();
    t = accumulateTurn(
      t,
      { type: "permission_resolved", requestId: "nope", allowed: false },
      1001,
    );
    expect(content(t).permissionRequests).toHaveLength(0);
  });
});

describe("accumulateTurn — terminal status transitions", () => {
  test("error message sets status=error and captures the message", () => {
    let t = makeAssistant();
    t = accumulateTurn(t, { type: "error", error: "rate limited" }, 1001);
    expect(t.status).toBe("error");
    expect(content(t).error).toBe("rate limited");
  });

  test("result success sets status=complete and captures costUsd", () => {
    let t = makeAssistant();
    t = accumulateTurn(t, { type: "text_delta", delta: "done" }, 1001);
    t = accumulateTurn(
      t,
      { type: "result", sessionId: "s", success: true, costUsd: 0.0042 },
      1002,
    );
    expect(t.status).toBe("complete");
    expect(content(t).costUsd).toBe(0.0042);
    expect(content(t).text).toBe("done");
  });

  test("result with empty existing text backfills from msg.result", () => {
    let t = makeAssistant();
    t = accumulateTurn(
      t,
      {
        type: "result",
        sessionId: "s",
        success: true,
        result: "final text",
      },
      1001,
    );
    expect(content(t).text).toBe("final text");
    expect(t.status).toBe("complete");
  });

  test("result failure sets status=error", () => {
    let t = makeAssistant();
    t = accumulateTurn(
      t,
      { type: "result", sessionId: "s", success: false },
      1001,
    );
    expect(t.status).toBe("error");
  });
});

describe("accumulateTurn — purity and unknowns", () => {
  test("does not mutate the input turn", () => {
    const t0 = makeAssistant();
    const snapshot = JSON.stringify(t0);
    accumulateTurn(t0, { type: "text_delta", delta: "x" }, 1001);
    expect(JSON.stringify(t0)).toBe(snapshot);
  });

  test("unknown messages only bump updatedAt", () => {
    const t0 = makeAssistant();
    const t1 = accumulateTurn(t0, { type: "unknown", raw: {} } as AIMessage, 1050);
    expect(content(t1).text).toBe("");
    expect(content(t1).thinking).toBe("");
    expect(t1.status).toBe("streaming");
    expect(t1.updatedAt).toBe(1050);
  });

  test("applying an AI message to a user turn is a no-op (defensive)", () => {
    const u = createUserTurn("u1", { prompt: "hi" }, 1000);
    const after = accumulateTurn(u, { type: "text_delta", delta: "x" }, 1001);
    expect(after.content).toEqual(u.content);
    expect(after.status).toBe("complete");
    expect(after.updatedAt).toBe(1001);
  });
});

describe("abortTurn", () => {
  test("marks an assistant turn aborted", () => {
    const t = abortTurn(makeAssistant(), 1001);
    expect(t.status).toBe("aborted");
    expect(t.updatedAt).toBe(1001);
  });

  test("is a no-op on a user turn", () => {
    const u = createUserTurn("u1", { prompt: "hi" }, 1000);
    expect(abortTurn(u)).toBe(u);
  });
});

describe("OpenCode empty-update-then-deltas ordering (regression sketch)", () => {
  // OpenCode emits `message.part.updated` with empty text first, then deltas.
  // When the adapter translates that pair into a `text_delta` sequence, the
  // accumulator should preserve the full text even though the first event
  // carries no content.
  test("empty initial delta followed by real deltas produces full text", () => {
    let t = makeAssistant();
    t = accumulateTurn(t, { type: "text_delta", delta: "" }, 1001);
    t = accumulateTurn(t, { type: "text_delta", delta: "Hello " }, 1002);
    t = accumulateTurn(t, { type: "text_delta", delta: "world" }, 1003);
    expect(content(t).text).toBe("Hello world");
  });
});
