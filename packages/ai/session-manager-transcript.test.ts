import { describe, test, expect } from "bun:test";
import { SessionManager } from "./session-manager.ts";
import type { AISession, AIMessage } from "./types.ts";
import type { ChatContextStrategy } from "./resolve-context.ts";
import type { AssistantTurnContent } from "@plannotator/shared/chat-transcript";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockSession(id: string): AISession {
  return {
    get id() {
      return id;
    },
    parentSessionId: null,
    get isActive() {
      return false;
    },
    async *query() {
      /* never called */
    },
    abort() {
      /* noop */
    },
  };
}

function decodeSSELine(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  // Strip `data: ` prefix and trailing `\n\n`
  const body = text.replace(/^data: /, "").replace(/\n\n$/, "");
  return JSON.parse(body);
}

function collectingController(): {
  controller: ReadableStreamDefaultController<Uint8Array>;
  events: unknown[];
  closed: boolean;
} {
  const events: unknown[] = [];
  let closed = false;
  const controller: ReadableStreamDefaultController<Uint8Array> = {
    desiredSize: 1,
    enqueue(chunk: Uint8Array) {
      if (closed) throw new Error("Controller closed");
      events.push(decodeSSELine(chunk));
    },
    close() {
      closed = true;
    },
    error() {
      closed = true;
    },
  };
  return {
    controller,
    events,
    get closed() {
      return closed;
    },
  };
}

// ---------------------------------------------------------------------------
// track() strategy + transcript wiring
// ---------------------------------------------------------------------------

describe("SessionManager.track — transcript wiring", () => {
  test("new entries start with empty transcript and null strategy by default", () => {
    const sm = new SessionManager();
    const entry = sm.track(mockSession("s1"), "code-review");
    expect(entry.transcript).toEqual([]);
    expect(entry.strategy).toBeNull();
    expect(entry.streamSubscribers.size).toBe(0);
  });

  test("track stores the resolved strategy when provided", () => {
    const sm = new SessionManager();
    const strategy: ChatContextStrategy = {
      kind: "fork_by_id",
      harness: "claude-code",
      sessionId: "claude-abc",
    };
    const entry = sm.track(mockSession("s1"), "code-review", { strategy });
    expect(entry.strategy).toEqual(strategy);
  });

  test("label option still works alongside strategy", () => {
    const sm = new SessionManager();
    const entry = sm.track(mockSession("s1"), "code-review", {
      label: "first question",
    });
    expect(entry.label).toBe("first question");
  });
});

// ---------------------------------------------------------------------------
// startUserTurn
// ---------------------------------------------------------------------------

describe("SessionManager.startUserTurn", () => {
  test("pushes user + streaming assistant turn, returns assistant turn id", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");

    const assistantId = sm.startUserTurn("s1", {
      prompt: "explain this",
      scope: "line",
      lineStart: 10,
      lineEnd: 20,
    });

    expect(assistantId).toMatch(/^a-/);
    const transcript = sm.getTranscript("s1");
    expect(transcript).toHaveLength(2);
    expect(transcript[0].role).toBe("user");
    expect(transcript[0].status).toBe("complete");
    expect(transcript[0].content).toMatchObject({
      prompt: "explain this",
      scope: "line",
      lineStart: 10,
      lineEnd: 20,
    });
    expect(transcript[1].role).toBe("assistant");
    expect(transcript[1].status).toBe("streaming");
    expect(transcript[1].id).toBe(assistantId);
  });

  test("returns null for unknown session", () => {
    const sm = new SessionManager();
    const result = sm.startUserTurn("missing", { prompt: "hi" });
    expect(result).toBeNull();
  });

  test("broadcasts both turns to active subscribers", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");
    const sub = collectingController();
    sm.subscribe("s1", sub.controller);

    sm.startUserTurn("s1", { prompt: "hi" });

    expect(sub.events).toHaveLength(2);
    expect(sub.events[0]).toMatchObject({
      type: "turn",
      turn: { role: "user", status: "complete" },
    });
    expect(sub.events[1]).toMatchObject({
      type: "turn",
      turn: { role: "assistant", status: "streaming" },
    });
  });
});

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

describe("SessionManager.appendMessage", () => {
  test("folds AIMessage into the specified assistant turn and broadcasts delta", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");
    const assistantId = sm.startUserTurn("s1", { prompt: "hi" });
    expect(assistantId).not.toBeNull();

    const sub = collectingController();
    sm.subscribe("s1", sub.controller);

    const msg: AIMessage = { type: "text_delta", delta: "Hello!" };
    sm.appendMessage("s1", assistantId!, msg);

    const transcript = sm.getTranscript("s1");
    const assistant = transcript[1];
    expect((assistant.content as AssistantTurnContent).text).toBe("Hello!");

    expect(sub.events).toHaveLength(1);
    expect(sub.events[0]).toMatchObject({
      type: "delta",
      turnId: assistantId,
      message: { type: "text_delta", delta: "Hello!" },
    });
  });

  test("is a no-op when session is unknown", () => {
    const sm = new SessionManager();
    // Does not throw.
    sm.appendMessage("missing", "any-turn-id", { type: "text_delta", delta: "x" });
  });

  test("is a no-op when turn id is unknown (finalized or evicted)", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");
    sm.startUserTurn("s1", { prompt: "hi" });
    sm.appendMessage("s1", "nonexistent", { type: "text_delta", delta: "x" });
    expect((sm.getTranscript("s1")[1].content as AssistantTurnContent).text).toBe("");
  });

  test("multiple deltas accumulate, broadcast per-delta", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");
    const assistantId = sm.startUserTurn("s1", { prompt: "hi" });
    const sub = collectingController();
    sm.subscribe("s1", sub.controller);

    sm.appendMessage("s1", assistantId!, { type: "text_delta", delta: "Hello " });
    sm.appendMessage("s1", assistantId!, { type: "text_delta", delta: "world" });

    const transcript = sm.getTranscript("s1");
    expect((transcript[1].content as AssistantTurnContent).text).toBe(
      "Hello world",
    );
    expect(sub.events).toHaveLength(2);
  });

  test("concurrent writers do not contaminate each other's turns", () => {
    // Multi-tab scenario: Tab A opened turn-A, began streaming. Tab B
    // opened turn-B on the same session before A finished. Deltas from
    // A's still-unwinding stream must land on turn-A, not on turn-B.
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");
    const turnA = sm.startUserTurn("s1", { prompt: "from tab A" })!;
    const turnB = sm.startUserTurn("s1", { prompt: "from tab B" })!;

    // A's trailing delta arrives after B's turn is already the tail.
    sm.appendMessage("s1", turnA, { type: "text_delta", delta: "A's answer" });
    // B's immediate busy-error lands on its own turn.
    sm.appendMessage("s1", turnB, {
      type: "error",
      error: "busy",
      code: "session_busy",
    });

    const transcript = sm.getTranscript("s1");
    // transcript: [userA, asstA, userB, asstB]
    expect((transcript[1].content as AssistantTurnContent).text).toBe("A's answer");
    expect((transcript[3].content as AssistantTurnContent).text).toBe("");
    expect((transcript[3].content as AssistantTurnContent).error).toBe("busy");
  });
});

// ---------------------------------------------------------------------------
// finalizeTurn
// ---------------------------------------------------------------------------

describe("SessionManager.finalizeTurn", () => {
  test("sets status to complete and broadcasts final turn", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");
    const assistantId = sm.startUserTurn("s1", { prompt: "hi" });
    expect(assistantId).not.toBeNull();
    sm.appendMessage("s1", assistantId!, { type: "text_delta", delta: "done" });

    const sub = collectingController();
    sm.subscribe("s1", sub.controller);

    sm.finalizeTurn("s1", assistantId!, "complete");

    const transcript = sm.getTranscript("s1");
    expect(transcript[1].status).toBe("complete");

    expect(sub.events).toHaveLength(1);
    expect(sub.events[0]).toMatchObject({
      type: "turn",
      turn: { id: assistantId, status: "complete" },
    });
  });

  test("aborted transition uses abortTurn (sets status, bumps updatedAt)", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");
    const assistantId = sm.startUserTurn("s1", { prompt: "hi" });
    sm.finalizeTurn("s1", assistantId!, "aborted");
    const transcript = sm.getTranscript("s1");
    expect(transcript[1].status).toBe("aborted");
  });

  test("is a no-op for unknown turn id", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");
    sm.startUserTurn("s1", { prompt: "hi" });
    // Does not throw.
    sm.finalizeTurn("s1", "missing-turn", "complete");
    const transcript = sm.getTranscript("s1");
    expect(transcript[1].status).toBe("streaming");
  });
});

// ---------------------------------------------------------------------------
// subscribe / broadcast lifecycle
// ---------------------------------------------------------------------------

describe("SessionManager.subscribe + broadcast", () => {
  test("unsubscribe removes the controller from future broadcasts", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");
    const sub = collectingController();
    const unsubscribe = sm.subscribe("s1", sub.controller);

    sm.broadcast("s1", { type: "custom", payload: 1 });
    expect(sub.events).toHaveLength(1);

    unsubscribe();
    sm.broadcast("s1", { type: "custom", payload: 2 });
    expect(sub.events).toHaveLength(1);
  });

  test("subscribe on missing session returns a no-op unsubscribe", () => {
    const sm = new SessionManager();
    const sub = collectingController();
    const unsubscribe = sm.subscribe("missing", sub.controller);
    expect(typeof unsubscribe).toBe("function");
    // Calling the no-op unsubscribe does not throw.
    unsubscribe();
  });

  test("broadcast survives a controller that throws on enqueue", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");

    const good = collectingController();
    const bad: ReadableStreamDefaultController<Uint8Array> = {
      desiredSize: 1,
      enqueue() {
        throw new Error("stream closed");
      },
      close() {},
      error() {},
    };

    sm.subscribe("s1", good.controller);
    sm.subscribe("s1", bad);

    sm.broadcast("s1", { type: "custom" });

    expect(good.events).toHaveLength(1);
    // The broken controller should be evicted after its throw.
    const entry = sm.get("s1");
    expect(entry?.streamSubscribers.size).toBe(1);
    expect(entry?.streamSubscribers.has(good.controller)).toBe(true);
  });

  test("remove() closes subscribers and drops the session", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");
    const sub = collectingController();
    sm.subscribe("s1", sub.controller);

    sm.remove("s1");
    expect(sub.closed).toBe(true);
    expect(sm.get("s1")).toBeUndefined();
  });

  test("disposeAll closes subscribers across every session", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "code-review");
    sm.track(mockSession("s2"), "code-review");
    const a = collectingController();
    const b = collectingController();
    sm.subscribe("s1", a.controller);
    sm.subscribe("s2", b.controller);

    sm.disposeAll();

    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(sm.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Eviction closes subscribers
// ---------------------------------------------------------------------------

describe("SessionManager eviction + subscribers", () => {
  test("evicting an idle session closes its subscribers", () => {
    const sm = new SessionManager({ maxSessions: 2 });
    sm.track(mockSession("s1"), "code-review");
    sm.track(mockSession("s2"), "code-review");

    const sub1 = collectingController();
    sm.subscribe("s1", sub1.controller);

    // Touch s2 so s1 becomes the oldest-idle, then add a third session to
    // trigger eviction.
    sm.touch("s2");
    sm.track(mockSession("s3"), "code-review");

    expect(sm.get("s1")).toBeUndefined();
    expect(sub1.closed).toBe(true);
  });
});
