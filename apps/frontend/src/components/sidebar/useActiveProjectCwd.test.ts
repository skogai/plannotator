import { describe, expect, test } from "vitest";
import { activeProjectCwdOf } from "./useActiveProjectCwd";
import type { SessionSummary } from "../../daemon/contracts";

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    mode: "plan",
    status: "active",
    url: "http://localhost/s/x",
    project: "proj",
    label: "plugin-plan-claude-code-proj-main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("activeProjectCwdOf", () => {
  test("returns null when no active session id", () => {
    const sessions = [session({ id: "a", projectCwd: "/p" })];
    expect(activeProjectCwdOf(sessions, null)).toBeNull();
  });

  test("returns null when active id matches no session", () => {
    const sessions = [session({ id: "a", projectCwd: "/p" })];
    expect(activeProjectCwdOf(sessions, "missing")).toBeNull();
  });

  test("prefers projectCwd of the active session", () => {
    const sessions = [
      session({ id: "a", projectCwd: "/owner", cwd: "/worktree" }),
      session({ id: "b", projectCwd: "/other" }),
    ];
    expect(activeProjectCwdOf(sessions, "a")).toBe("/owner");
  });

  test("falls back to cwd when projectCwd is absent (pre-migration row)", () => {
    const sessions = [session({ id: "a", cwd: "/legacy-cwd" })];
    expect(activeProjectCwdOf(sessions, "a")).toBe("/legacy-cwd");
  });

  test("returns null when active session has neither projectCwd nor cwd", () => {
    const sessions = [session({ id: "a" })];
    expect(activeProjectCwdOf(sessions, "a")).toBeNull();
  });

  test("selects the active session, not the first", () => {
    const sessions = [
      session({ id: "a", projectCwd: "/a" }),
      session({ id: "b", projectCwd: "/b" }),
    ];
    expect(activeProjectCwdOf(sessions, "b")).toBe("/b");
  });
});
