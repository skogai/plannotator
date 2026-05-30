import { describe, test, expect } from "bun:test";
import type {
  DaemonProjectEntry,
  DaemonSessionSummary,
} from "@plannotator/shared/daemon-protocol";
import { buildSessionTree } from "./sessionTree";

// --- helpers ---------------------------------------------------------------

function project(
  partial: Partial<DaemonProjectEntry> & { name: string; cwd: string },
): DaemonProjectEntry {
  return {
    lastSeen: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

let sessionCounter = 0;
function session(
  partial: Partial<DaemonSessionSummary> & { project: string },
): DaemonSessionSummary {
  sessionCounter += 1;
  return {
    id: partial.id ?? `s-${sessionCounter}`,
    mode: partial.mode ?? "plan",
    status: partial.status ?? "active",
    url: partial.url ?? "http://localhost/s/x",
    project: partial.project,
    cwd: partial.cwd,
    label: partial.label ?? "label",
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00.000Z",
    projectCwd: partial.projectCwd,
    worktree: partial.worktree,
  } as DaemonSessionSummary;
}

/** Count every session that landed anywhere in the tree. */
function allTreeSessionIds(tree: ReturnType<typeof buildSessionTree>): string[] {
  const ids: string[] = [];
  for (const p of tree) {
    for (const s of p.directSessions) ids.push(s.id);
    for (const w of p.worktrees) for (const s of w.sessions) ids.push(s.id);
  }
  return ids;
}

// --- tests -----------------------------------------------------------------

describe("buildSessionTree", () => {
  test("empty inputs produce an empty tree", () => {
    expect(buildSessionTree([], [])).toEqual([]);
  });

  test("projects with no sessions still appear", () => {
    const tree = buildSessionTree(
      [project({ name: "my-app", cwd: "/work/my-app" })],
      [],
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("my-app");
    expect(tree[0].cwd).toBe("/work/my-app");
    expect(tree[0].directSessions).toEqual([]);
    expect(tree[0].worktrees).toEqual([]);
  });

  test("project with only direct sessions", () => {
    const s1 = session({ project: "my-app", projectCwd: "/work/my-app", id: "a" });
    const s2 = session({ project: "my-app", projectCwd: "/work/my-app", id: "b" });
    const tree = buildSessionTree(
      [project({ name: "my-app", cwd: "/work/my-app" })],
      [s1, s2],
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].directSessions.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(tree[0].worktrees).toEqual([]);
  });

  test("project with worktrees and sessions", () => {
    const direct = session({
      project: "my-app",
      projectCwd: "/work/my-app",
      id: "direct",
    });
    const wtSession = session({
      project: "my-app",
      projectCwd: "/work/my-app",
      id: "wt",
      worktree: { cwd: "/work/my-app/wt-1", branch: "feature-x" },
    });
    const tree = buildSessionTree(
      [
        project({ name: "my-app", cwd: "/work/my-app" }),
        project({
          name: "feature-x",
          cwd: "/work/my-app/wt-1",
          parentCwd: "/work/my-app",
          branch: "feature-x",
        }),
      ],
      [direct, wtSession],
    );
    expect(tree).toHaveLength(1);
    const node = tree[0];
    expect(node.directSessions.map((s) => s.id)).toEqual(["direct"]);
    expect(node.worktrees).toHaveLength(1);
    expect(node.worktrees[0].cwd).toBe("/work/my-app/wt-1");
    expect(node.worktrees[0].name).toBe("feature-x");
    expect(node.worktrees[0].sessions.map((s) => s.id)).toEqual(["wt"]);
  });

  test("registry worktree row with zero sessions still appears", () => {
    const tree = buildSessionTree(
      [
        project({ name: "my-app", cwd: "/work/my-app" }),
        project({
          name: "empty-wt",
          cwd: "/work/my-app/wt-empty",
          parentCwd: "/work/my-app",
        }),
      ],
      [],
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].worktrees).toHaveLength(1);
    expect(tree[0].worktrees[0].name).toBe("empty-wt");
    expect(tree[0].worktrees[0].sessions).toEqual([]);
  });

  test("session with worktree not in registry is synthesized", () => {
    const s = session({
      project: "my-app",
      projectCwd: "/work/my-app",
      id: "synth",
      worktree: { cwd: "/work/my-app/ghost", branch: "ghost-branch" },
    });
    const tree = buildSessionTree(
      [project({ name: "my-app", cwd: "/work/my-app" })],
      [s],
    );
    expect(tree[0].worktrees).toHaveLength(1);
    expect(tree[0].worktrees[0].cwd).toBe("/work/my-app/ghost");
    expect(tree[0].worktrees[0].branch).toBe("ghost-branch");
    // name falls back to branch when synthesized
    expect(tree[0].worktrees[0].name).toBe("ghost-branch");
    expect(tree[0].worktrees[0].sessions.map((x) => x.id)).toEqual(["synth"]);
  });

  test("synthesized worktree without branch names from cwd basename", () => {
    const s = session({
      project: "my-app",
      projectCwd: "/work/my-app",
      id: "nb",
      worktree: { cwd: "/work/my-app/dir-name" },
    });
    const tree = buildSessionTree(
      [project({ name: "my-app", cwd: "/work/my-app" })],
      [s],
    );
    expect(tree[0].worktrees[0].name).toBe("dir-name");
    expect(tree[0].worktrees[0].branch).toBeUndefined();
  });

  test("registry worktree without branch is backfilled from session", () => {
    const s = session({
      project: "my-app",
      projectCwd: "/work/my-app",
      id: "bf",
      worktree: { cwd: "/work/my-app/wt-1", branch: "from-session" },
    });
    const tree = buildSessionTree(
      [
        project({ name: "my-app", cwd: "/work/my-app" }),
        project({
          name: "wt-1",
          cwd: "/work/my-app/wt-1",
          parentCwd: "/work/my-app",
          // no branch on the registry row
        }),
      ],
      [s],
    );
    expect(tree[0].worktrees[0].branch).toBe("from-session");
    // registry name is preserved (not overwritten by branch)
    expect(tree[0].worktrees[0].name).toBe("wt-1");
  });

  test("session with no projectCwd falls back to cwd", () => {
    const s = session({ project: "legacy", cwd: "/work/legacy", id: "leg" });
    const tree = buildSessionTree(
      [project({ name: "legacy", cwd: "/work/legacy" })],
      [s],
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].directSessions.map((x) => x.id)).toEqual(["leg"]);
  });

  test("orphan session with no matching project row gets a synthesized node", () => {
    const s = session({
      project: "ghost-proj",
      projectCwd: "/work/ghost",
      id: "orphan",
    });
    const tree = buildSessionTree([], [s]);
    expect(tree).toHaveLength(1);
    expect(tree[0].cwd).toBe("/work/ghost");
    expect(tree[0].name).toBe("ghost"); // basename of cwd
    expect(tree[0].declared).toBeUndefined();
    expect(tree[0].directSessions.map((x) => x.id)).toEqual(["orphan"]);
  });

  test("session with neither projectCwd nor cwd is anchored, not dropped", () => {
    const s = session({ project: "no-cwd", id: "homeless" });
    const tree = buildSessionTree([], [s]);
    expect(tree).toHaveLength(1);
    expect(allTreeSessionIds(tree)).toEqual(["homeless"]);
  });

  test("multiple projects are sorted by name", () => {
    const tree = buildSessionTree(
      [
        project({ name: "zebra", cwd: "/work/zebra" }),
        project({ name: "alpha", cwd: "/work/alpha" }),
        project({ name: "mango", cwd: "/work/mango" }),
      ],
      [],
    );
    expect(tree.map((p) => p.name)).toEqual(["alpha", "mango", "zebra"]);
  });

  test("worktrees are sorted by name within a project", () => {
    const tree = buildSessionTree(
      [
        project({ name: "app", cwd: "/work/app" }),
        project({ name: "wt-zeta", cwd: "/work/app/z", parentCwd: "/work/app" }),
        project({ name: "wt-alpha", cwd: "/work/app/a", parentCwd: "/work/app" }),
      ],
      [],
    );
    expect(tree[0].worktrees.map((w) => w.name)).toEqual(["wt-alpha", "wt-zeta"]);
  });

  test("duplicate project names sort deterministically by cwd regardless of input order", () => {
    const a = project({ name: "dup", cwd: "/a" });
    const b = project({ name: "dup", cwd: "/b" });
    const forward = buildSessionTree([a, b], []).map((p) => p.cwd);
    const reversed = buildSessionTree([b, a], []).map((p) => p.cwd);
    expect(forward).toEqual(["/a", "/b"]);
    expect(reversed).toEqual(["/a", "/b"]);
  });

  test("duplicate worktree names sort deterministically by cwd regardless of input order", () => {
    const root = project({ name: "app", cwd: "/work/app" });
    const wtA = project({ name: "dup", cwd: "/work/app/a", parentCwd: "/work/app" });
    const wtB = project({ name: "dup", cwd: "/work/app/b", parentCwd: "/work/app" });
    const forward = buildSessionTree([root, wtA, wtB], [])[0].worktrees.map((w) => w.cwd);
    const reversed = buildSessionTree([root, wtB, wtA], [])[0].worktrees.map((w) => w.cwd);
    expect(forward).toEqual(["/work/app/a", "/work/app/b"]);
    expect(reversed).toEqual(["/work/app/a", "/work/app/b"]);
  });

  test("sessions sorted by createdAt descending", () => {
    const older = session({
      project: "app",
      projectCwd: "/work/app",
      id: "older",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = session({
      project: "app",
      projectCwd: "/work/app",
      id: "newer",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    // pass in ascending order to prove sort independence from input order
    const tree = buildSessionTree(
      [project({ name: "app", cwd: "/work/app" })],
      [older, newer],
    );
    expect(tree[0].directSessions.map((s) => s.id)).toEqual(["newer", "older"]);
  });

  test("declared workspace with sub-repos (declared flag preserved)", () => {
    const rootSession = session({
      project: "monorepo",
      projectCwd: "/work/monorepo",
      id: "root",
    });
    const subSession = session({
      project: "monorepo",
      projectCwd: "/work/monorepo",
      id: "sub",
      worktree: { cwd: "/work/monorepo/packages/api", branch: "api-work" },
    });
    const tree = buildSessionTree(
      [
        project({ name: "monorepo", cwd: "/work/monorepo", declared: true }),
        project({
          name: "api",
          cwd: "/work/monorepo/packages/api",
          parentCwd: "/work/monorepo",
        }),
      ],
      [rootSession, subSession],
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].declared).toBe(true);
    expect(tree[0].directSessions.map((s) => s.id)).toEqual(["root"]);
    expect(tree[0].worktrees).toHaveLength(1);
    expect(tree[0].worktrees[0].name).toBe("api");
    expect(tree[0].worktrees[0].sessions.map((s) => s.id)).toEqual(["sub"]);
  });

  test("worktree session whose owning project key has no top-level node", () => {
    // session has projectCwd that matches no top-level project row at all
    const s = session({
      project: "stray",
      projectCwd: "/work/stray",
      id: "stray-wt",
      worktree: { cwd: "/work/stray/wt", branch: "b" },
    });
    const tree = buildSessionTree([], [s]);
    expect(tree).toHaveLength(1);
    expect(tree[0].cwd).toBe("/work/stray");
    expect(tree[0].worktrees).toHaveLength(1);
    expect(tree[0].worktrees[0].sessions.map((x) => x.id)).toEqual(["stray-wt"]);
  });

  test("sessions with equal createdAt sort deterministically by id (tie-break)", () => {
    const ts = "2026-02-02T00:00:00.000Z";
    const s1 = session({ project: "p", cwd: "/work/p", id: "zzz", createdAt: ts });
    const s2 = session({ project: "p", cwd: "/work/p", id: "aaa", createdAt: ts });
    const proj = [project({ name: "p", cwd: "/work/p" })];
    const fwd = buildSessionTree(proj, [s1, s2])[0].directSessions.map((s) => s.id);
    const rev = buildSessionTree(proj, [s2, s1])[0].directSessions.map((s) => s.id);
    expect(fwd).toEqual(["aaa", "zzz"]);
    expect(rev).toEqual(["aaa", "zzz"]);
  });

  test("counts reconcile: every input session appears exactly once", () => {
    const sessions: DaemonSessionSummary[] = [
      session({ project: "a", projectCwd: "/work/a", id: "1" }),
      session({
        project: "a",
        projectCwd: "/work/a",
        id: "2",
        worktree: { cwd: "/work/a/wt1", branch: "x" },
      }),
      session({
        project: "a",
        projectCwd: "/work/a",
        id: "3",
        worktree: { cwd: "/work/a/wt1", branch: "x" },
      }),
      session({ project: "b", projectCwd: "/work/b", id: "4" }),
      session({ project: "legacy", cwd: "/work/legacy", id: "5" }), // cwd fallback
      session({ project: "orphan", projectCwd: "/work/orphan", id: "6" }), // orphan
      session({ project: "none", id: "7" }), // no cwd at all
      session({
        project: "b",
        projectCwd: "/work/b",
        id: "8",
        worktree: { cwd: "/work/b/ghost", branch: "g" },
      }),
    ];
    const projects: DaemonProjectEntry[] = [
      project({ name: "a", cwd: "/work/a" }),
      project({ name: "wt1", cwd: "/work/a/wt1", parentCwd: "/work/a" }),
      project({ name: "b", cwd: "/work/b" }),
      project({ name: "legacy", cwd: "/work/legacy" }),
      // an empty worktree row that should still appear
      project({ name: "empty", cwd: "/work/a/empty", parentCwd: "/work/a" }),
    ];
    const tree = buildSessionTree(projects, sessions);

    const seen = allTreeSessionIds(tree).sort();
    expect(seen).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    // exactly once each
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);

    // empty worktree row still rendered
    const a = tree.find((p) => p.cwd === "/work/a")!;
    expect(a.worktrees.map((w) => w.name).sort()).toEqual(["empty", "wt1"]);
    const wt1 = a.worktrees.find((w) => w.cwd === "/work/a/wt1")!;
    expect(wt1.sessions.map((s) => s.id).sort()).toEqual(["2", "3"]);
    const empty = a.worktrees.find((w) => w.cwd === "/work/a/empty")!;
    expect(empty.sessions).toEqual([]);
  });
});
