import type {
  DaemonProjectEntry,
  DaemonSessionSummary,
} from "@plannotator/shared/daemon-protocol";

/**
 * A worktree (or sub-repo) node under a project. Holds the sessions scoped to
 * that worktree's working directory.
 */
export interface SessionTreeWorktree {
  cwd: string;
  branch?: string;
  name: string;
  sessions: DaemonSessionSummary[];
}

/**
 * A top-level project node. `directSessions` are sessions anchored to the
 * project root with no worktree scope; `worktrees` collect everything else.
 */
export interface SessionTreeProject {
  cwd: string;
  name: string;
  declared?: boolean;
  /** Sessions in the project root (no worktree). */
  directSessions: DaemonSessionSummary[];
  worktrees: SessionTreeWorktree[];
}

/** Owning-project key for a session, with cwd fallback for pre-migration rows. */
function owningProjectKey(session: DaemonSessionSummary): string | undefined {
  return session.projectCwd ?? session.cwd;
}

/** Derive a stable, human-readable name for a worktree from its cwd/branch. */
function worktreeName(cwd: string, branch?: string): string {
  if (branch && branch.length > 0) return branch;
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : cwd;
}

/** Derive a stable, human-readable name for an orphan/synthesized project. */
function projectNameFromCwd(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : cwd;
}

/** createdAt descending (newest first); session id breaks ties for full determinism. */
function byCreatedAtDesc(a: DaemonSessionSummary, b: DaemonSessionSummary): number {
  if (a.createdAt < b.createdAt) return 1;
  if (a.createdAt > b.createdAt) return -1;
  return byNameAsc(a.id, b.id);
}

function byNameAsc(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * A mutable accumulator mirroring SessionTreeProject. Worktrees are keyed by
 * cwd while building so sessions can find their node in O(1); the final shape
 * flattens the map into a sorted array.
 */
interface ProjectAccumulator {
  cwd: string;
  name: string;
  declared?: boolean;
  directSessions: DaemonSessionSummary[];
  worktrees: Map<string, SessionTreeWorktree>;
}

/**
 * Build an immutable session tree from the daemon's live projects + sessions.
 *
 * Grouping rules:
 * - Owning-project key for a session = `projectCwd ?? cwd` (fallback so
 *   pre-migration sessions without `projectCwd` still attach somewhere).
 * - Top-level projects are entries with NO `parentCwd`. Worktree rows are
 *   entries WITH `parentCwd` (which points at the owning project's cwd).
 * - Each top-level project seeds its worktrees from registry worktree rows
 *   whose `parentCwd === project.cwd` (worktrees appear even with zero sessions).
 * - A session with `worktree.cwd` lands under the matching worktree node in its
 *   owning project; a missing node is synthesized from the session's worktree.
 *   A session with no worktree is a `directSession` of its owning project.
 * - Orphan safety: a session whose owning-project key matches no top-level
 *   project node gets a minimal synthesized project node (sessions are never
 *   dropped).
 * - Determinism: projects and worktrees sort by name; sessions by createdAt
 *   desc. Input order is never relied upon.
 */
export function buildSessionTree(
  projects: DaemonProjectEntry[],
  sessions: DaemonSessionSummary[],
): SessionTreeProject[] {
  // 1. Seed top-level project nodes and stash worktree rows by parent.
  const nodes = new Map<string, ProjectAccumulator>();
  const worktreeRowsByParent = new Map<string, DaemonProjectEntry[]>();

  for (const entry of projects) {
    if (entry.parentCwd) {
      const list = worktreeRowsByParent.get(entry.parentCwd);
      if (list) list.push(entry);
      else worktreeRowsByParent.set(entry.parentCwd, [entry]);
      continue;
    }
    // Top-level project. Last-writer-wins on duplicate cwd.
    nodes.set(entry.cwd, {
      cwd: entry.cwd,
      name: entry.name,
      declared: entry.declared,
      directSessions: [],
      worktrees: new Map<string, SessionTreeWorktree>(),
    });
  }

  // 2. Seed declared worktree nodes from registry rows (zero-session worktrees
  //    still show). Worktree rows whose parent has no top-level node are
  //    ignored here; if a session references them they'll be synthesized below.
  for (const [parentCwd, rows] of worktreeRowsByParent) {
    const parent = nodes.get(parentCwd);
    if (!parent) continue;
    for (const row of rows) {
      if (parent.worktrees.has(row.cwd)) continue;
      parent.worktrees.set(row.cwd, {
        cwd: row.cwd,
        branch: row.branch,
        name: row.name || worktreeName(row.cwd, row.branch),
        sessions: [],
      });
    }
  }

  // Synthesize a minimal top-level project node for an orphan session.
  function ensureProjectNode(cwd: string): ProjectAccumulator {
    let node = nodes.get(cwd);
    if (!node) {
      node = {
        cwd,
        name: projectNameFromCwd(cwd),
        declared: undefined,
        directSessions: [],
        worktrees: new Map<string, SessionTreeWorktree>(),
      };
      nodes.set(cwd, node);
    }
    return node;
  }

  // 3. Place each session.
  for (const session of sessions) {
    const key = owningProjectKey(session);
    if (!key) {
      // No projectCwd and no cwd: anchor under a stable synthetic key so the
      // session is never dropped.
      const node = ensureProjectNode("");
      placeSession(node, session);
      continue;
    }
    const node = ensureProjectNode(key);
    placeSession(node, session);
  }

  // 4. Freeze into sorted output.
  const result: SessionTreeProject[] = [];
  for (const node of nodes.values()) {
    const worktrees = Array.from(node.worktrees.values());
    for (const wt of worktrees) {
      wt.sessions.sort(byCreatedAtDesc);
    }
    worktrees.sort((a, b) => byNameAsc(a.name, b.name) || byNameAsc(a.cwd, b.cwd));
    node.directSessions.sort(byCreatedAtDesc);
    result.push({
      cwd: node.cwd,
      name: node.name,
      declared: node.declared,
      directSessions: node.directSessions,
      worktrees,
    });
  }
  // cwd is the unique Map key, so it is a stable tiebreaker when two projects
  // share a name (e.g. the same repo basename checked out in two locations).
  // Without it, equal names fall back to Map iteration order, which is not
  // deterministic across input orderings.
  result.sort((a, b) => byNameAsc(a.name, b.name) || byNameAsc(a.cwd, b.cwd));
  return result;
}

/** Route a session into the correct worktree node or directSessions. */
function placeSession(node: ProjectAccumulator, session: DaemonSessionSummary): void {
  const wt = session.worktree;
  if (wt && wt.cwd) {
    let wtNode = node.worktrees.get(wt.cwd);
    if (!wtNode) {
      wtNode = {
        cwd: wt.cwd,
        branch: wt.branch,
        name: worktreeName(wt.cwd, wt.branch),
        sessions: [],
      };
      node.worktrees.set(wt.cwd, wtNode);
    } else if (!wtNode.branch && wt.branch) {
      // Backfill branch onto a registry-seeded node that lacked one.
      wtNode.branch = wt.branch;
    }
    wtNode.sessions.push(session);
    return;
  }
  node.directSessions.push(session);
}
