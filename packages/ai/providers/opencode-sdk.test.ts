import { describe, test, expect } from "bun:test";
import { mapOpenCodeEvent } from "./opencode-sdk";
import { accumulateTurn, createAssistantTurn } from "../../shared/chat-transcript";
import type { AssistantTurnContent } from "../../shared/chat-transcript";

const SESSION = "test-session-001";

function content(t: { content: unknown }): AssistantTurnContent {
  return t.content as AssistantTurnContent;
}

// ---------------------------------------------------------------------------
// Synthetic fixture: replays the event ordering OpenCode actually produces
// for a single assistant text response.
//
// Sequence (from OpenCode source: session/processor.ts + message-v2.ts):
//   1. message.part.updated  — part created, text is ""
//   2. message.part.delta    — field: "text", delta: "Hello "
//   3. message.part.delta    — field: "text", delta: "world"
//   4. message.part.updated  — part finalized, text is "Hello world"
//   5. session.status         — idle (query complete)
// ---------------------------------------------------------------------------
const TEXT_RESPONSE_FIXTURE = [
  {
    type: "message.part.updated",
    properties: {
      sessionID: SESSION,
      messageID: "msg-1",
      part: { id: "part-1", type: "text", text: "" },
    },
  },
  {
    type: "message.part.delta",
    properties: {
      sessionID: SESSION,
      messageID: "msg-1",
      partID: "part-1",
      field: "text",
      delta: "Hello ",
    },
  },
  {
    type: "message.part.delta",
    properties: {
      sessionID: SESSION,
      messageID: "msg-1",
      partID: "part-1",
      field: "text",
      delta: "world",
    },
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: SESSION,
      messageID: "msg-1",
      part: { id: "part-1", type: "text", text: "Hello world" },
    },
  },
  {
    type: "session.status",
    properties: {
      sessionID: SESSION,
      status: { type: "idle" },
    },
  },
];

// Tool use + result sequence
const TOOL_RESPONSE_FIXTURE = [
  {
    type: "message.part.updated",
    properties: {
      sessionID: SESSION,
      part: {
        id: "part-2",
        type: "tool",
        tool: "Read",
        callID: "call-1",
        state: { status: "running", input: { path: "/tmp/test.ts" } },
      },
    },
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: SESSION,
      part: {
        id: "part-2",
        type: "tool",
        tool: "Read",
        callID: "call-1",
        state: { status: "completed", output: "file contents here" },
      },
    },
  },
];

describe("mapOpenCodeEvent — text response", () => {
  test("text deltas produce text_delta messages", () => {
    const msgs = mapOpenCodeEvent(
      "message.part.delta",
      TEXT_RESPONSE_FIXTURE[1].properties,
      SESSION,
    );
    expect(msgs).toEqual([{ type: "text_delta", delta: "Hello " }]);
  });

  test("initial empty part.updated is a silent drop (no empty text emitted)", () => {
    const msgs = mapOpenCodeEvent(
      "message.part.updated",
      TEXT_RESPONSE_FIXTURE[0].properties,
      SESSION,
    );
    expect(msgs).toEqual([]);
  });

  test("final part.updated with text emits a text message", () => {
    const msgs = mapOpenCodeEvent(
      "message.part.updated",
      TEXT_RESPONSE_FIXTURE[3].properties,
      SESSION,
    );
    expect(msgs).toEqual([{ type: "text", text: "Hello world" }]);
  });

  test("session.status idle emits result", () => {
    const msgs = mapOpenCodeEvent(
      "session.status",
      TEXT_RESPONSE_FIXTURE[4].properties,
      SESSION,
    );
    expect(msgs).toEqual([{ type: "result", sessionId: SESSION, success: true }]);
  });
});

describe("mapOpenCodeEvent — tool lifecycle", () => {
  test("running tool emits tool_use", () => {
    const msgs = mapOpenCodeEvent(
      "message.part.updated",
      TOOL_RESPONSE_FIXTURE[0].properties,
      SESSION,
    );
    expect(msgs).toEqual([
      {
        type: "tool_use",
        toolName: "Read",
        toolInput: { path: "/tmp/test.ts" },
        toolUseId: "call-1",
      },
    ]);
  });

  test("completed tool emits tool_result", () => {
    const msgs = mapOpenCodeEvent(
      "message.part.updated",
      TOOL_RESPONSE_FIXTURE[1].properties,
      SESSION,
    );
    expect(msgs).toEqual([
      {
        type: "tool_result",
        toolUseId: "call-1",
        result: "file contents here",
      },
    ]);
  });
});

describe("end-to-end fixture replay — empty bubbles regression (#514)", () => {
  test("full text response fixture produces non-empty text", () => {
    let turn = createAssistantTurn("a1", 1000);
    let ts = 1001;

    for (const event of TEXT_RESPONSE_FIXTURE) {
      const mapped = mapOpenCodeEvent(
        event.type,
        event.properties,
        SESSION,
      );
      for (const msg of mapped) {
        turn = accumulateTurn(turn, msg, ts++);
      }
    }

    expect(content(turn).text).toBe("Hello world");
    expect(turn.status).toBe("complete");
  });

  test("text survives even if deltas are missed (only part.updated arrives)", () => {
    let turn = createAssistantTurn("a1", 1000);

    // Simulate: only the final part.updated arrives (deltas were lost)
    const finalUpdate = TEXT_RESPONSE_FIXTURE[3];
    const mapped = mapOpenCodeEvent(
      finalUpdate.type,
      finalUpdate.properties,
      SESSION,
    );
    for (const msg of mapped) {
      turn = accumulateTurn(turn, msg, 1001);
    }

    expect(content(turn).text).toBe("Hello world");
  });

  test("tool use + result accumulates correctly through fixture", () => {
    let turn = createAssistantTurn("a1", 1000);
    let ts = 1001;

    for (const event of TOOL_RESPONSE_FIXTURE) {
      const mapped = mapOpenCodeEvent(
        event.type,
        event.properties,
        SESSION,
      );
      for (const msg of mapped) {
        turn = accumulateTurn(turn, msg, ts++);
      }
    }

    expect(content(turn).toolCalls).toHaveLength(1);
    expect(content(turn).toolCalls[0].name).toBe("Read");
    expect(content(turn).toolCalls[0].result).toBe("file contents here");
  });
});
