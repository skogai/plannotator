import { describe, test, expect } from "bun:test";
import {
  resolveChatContext,
  type LaunchMetadata,
  type ChatContextStrategy,
} from "./resolve-context.ts";

// ---------------------------------------------------------------------------
// Matrix 3 — table-driven coverage of every documented invocation path
// ---------------------------------------------------------------------------

interface Row {
  name: string;
  launch: LaunchMetadata;
  expected: Partial<ChatContextStrategy> & { kind: ChatContextStrategy["kind"] };
}

const rows: Row[] = [
  {
    name: "Claude Code hook with session_id → fork_by_id",
    launch: {
      harness: "claude-code",
      invocation: "hook",
      cwd: "/repo",
      sessionId: "claude-abc123",
    },
    expected: {
      kind: "fork_by_id",
      harness: "claude-code",
      sessionId: "claude-abc123",
    },
  },
  {
    name: "Claude Code slash command without session_id → fork_by_heuristic",
    launch: {
      harness: "claude-code",
      invocation: "slash",
      cwd: "/repo",
    },
    expected: {
      kind: "fork_by_heuristic",
      harness: "claude-code",
      cwd: "/repo",
    },
  },
  {
    name: "OpenCode event with session_id → fork_by_id",
    launch: {
      harness: "opencode",
      invocation: "event",
      cwd: "/repo",
      sessionId: "oc-root-xyz",
    },
    expected: {
      kind: "fork_by_id",
      harness: "opencode",
      sessionId: "oc-root-xyz",
    },
  },
  {
    name: "Pi extension with sessionPath + entryId → fork_by_id",
    launch: {
      harness: "pi",
      invocation: "extension",
      cwd: "/repo",
      sessionId: "pi-sess-001",
      sessionPath: "/home/user/.pi/sessions/2026-04-15.jsonl",
      entryId: "msg-42",
    },
    expected: {
      kind: "fork_by_id",
      harness: "pi",
      sessionId: "pi-sess-001",
      sessionPath: "/home/user/.pi/sessions/2026-04-15.jsonl",
      entryId: "msg-42",
    },
  },
  {
    name: "Pi extension with sessionPath but no entryId → resume_by_id",
    launch: {
      harness: "pi",
      invocation: "extension",
      cwd: "/repo",
      sessionId: "pi-sess-002",
      sessionPath: "/home/user/.pi/sessions/2026-04-15.jsonl",
    },
    expected: {
      kind: "resume_by_id",
      harness: "pi",
      threadId: "pi-sess-002",
      sessionPath: "/home/user/.pi/sessions/2026-04-15.jsonl",
    },
  },
  {
    name: "Pi extension without sessionPath → fresh",
    launch: {
      harness: "pi",
      invocation: "extension",
      cwd: "/repo",
    },
    expected: {
      kind: "fresh",
      harness: "pi",
    },
  },
  {
    name: "Codex shell-out with CODEX_THREAD_ID → resume_by_id",
    launch: {
      harness: "codex",
      invocation: "shell-out",
      cwd: "/repo",
      sessionId: "018f00aa-1234-7abc-89de-cafebabe0000",
    },
    expected: {
      kind: "resume_by_id",
      harness: "codex",
      threadId: "018f00aa-1234-7abc-89de-cafebabe0000",
    },
  },
  {
    name: "Codex without CODEX_THREAD_ID → fresh",
    launch: {
      harness: "codex",
      invocation: "shell-out",
      cwd: "/repo",
    },
    expected: {
      kind: "fresh",
      harness: "codex",
    },
  },
  {
    name: "VS Code extension → fresh",
    launch: {
      harness: "vscode",
      invocation: "cli",
      cwd: "/repo",
    },
    expected: {
      kind: "fresh",
      harness: "vscode",
    },
  },
  {
    name: "Standalone CLI → fresh",
    launch: {
      harness: "standalone",
      invocation: "cli",
      cwd: "/repo",
    },
    expected: {
      kind: "fresh",
      harness: "standalone",
    },
  },
  {
    name: "OpenCode event without session_id → fresh (defensive fallback)",
    launch: {
      harness: "opencode",
      invocation: "event",
      cwd: "/repo",
    },
    expected: {
      kind: "fresh",
      harness: "opencode",
    },
  },
];

describe("resolveChatContext — Matrix 3", () => {
  for (const row of rows) {
    test(row.name, () => {
      const actual = resolveChatContext(row.launch);
      expect(actual.kind).toBe(row.expected.kind);
      expect(actual.harness).toBe(row.expected.harness);
      // Narrow by kind to assert the additional fields each variant carries.
      if (actual.kind === "fork_by_id" && row.expected.kind === "fork_by_id") {
        expect(actual.sessionId).toBe(row.expected.sessionId!);
        if (row.expected.sessionPath) {
          expect(actual.sessionPath).toBe(row.expected.sessionPath);
        }
        if (row.expected.entryId) {
          expect(actual.entryId).toBe(row.expected.entryId);
        }
      }
      if (
        actual.kind === "fork_by_heuristic" &&
        row.expected.kind === "fork_by_heuristic"
      ) {
        expect(actual.cwd).toBe(row.expected.cwd!);
      }
      if (
        actual.kind === "resume_by_id" &&
        row.expected.kind === "resume_by_id"
      ) {
        expect(actual.threadId).toBe(row.expected.threadId!);
        if (row.expected.sessionPath) {
          expect(actual.sessionPath).toBe(row.expected.sessionPath);
        }
      }
      if (actual.kind === "fresh") {
        expect(typeof actual.reason).toBe("string");
        expect(actual.reason.length).toBeGreaterThan(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Purity check — same input produces same output, no I/O side effects
// ---------------------------------------------------------------------------

describe("resolveChatContext — purity", () => {
  test("is deterministic for identical inputs", () => {
    const launch: LaunchMetadata = {
      harness: "claude-code",
      invocation: "hook",
      cwd: "/repo",
      sessionId: "sess-stable",
    };
    const a = resolveChatContext(launch);
    const b = resolveChatContext(launch);
    expect(a).toEqual(b);
  });

  test("does not mutate its input", () => {
    const launch: LaunchMetadata = {
      harness: "pi",
      invocation: "extension",
      cwd: "/repo",
      sessionId: "pi-001",
      sessionPath: "/tmp/session.jsonl",
      entryId: "entry-1",
    };
    const snapshot = JSON.stringify(launch);
    resolveChatContext(launch);
    expect(JSON.stringify(launch)).toBe(snapshot);
  });
});
