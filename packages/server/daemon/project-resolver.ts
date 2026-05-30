import { basename } from "path";
import { execSync } from "child_process";
import {
  detectWorktree,
  getDeclaredRoots,
  type ProjectRegistryOptions,
  type WorktreeDetection,
} from "./project-registry";

/**
 * Resolves which PROJECT a session belongs to from the directory it launched in.
 *
 * Implements the decision fact in
 * goals/architecture/decisions/{project-worktree-session-hierarchy,
 * cwd-worktree-collection-contract}.md:
 *
 *   resolve(cwd):
 *     1. nearest DECLARED project root at/above cwd  → use it  (read-only)
 *     2. else git toplevel                           → use it
 *     3. else cwd
 *
 * A session always belongs to exactly one project (its `projectCwd`). It may also
 * belong to one sub-scope under that project — a git worktree, or (under a declared
 * non-git workspace root) the specific sub-repo it sits in — reported as `worktree`.
 *
 * The git calls are injected (`GitProbe`) so the walk-up / rollup logic is unit
 * testable without real repositories.
 */

/** A registry entry the user explicitly declared as a project root. */
export interface DeclaredRoot {
  cwd: string;
  name: string;
}

export interface ResolvedProject {
  /** Owning project root — always set. The session belongs to exactly this project. */
  projectCwd: string;
  projectName: string;
  /**
   * Optional sub-scope the session sits in: a git worktree, or a sub-repo under a
   * declared workspace root. Absent for a session launched directly in the project.
   */
  worktree?: { cwd: string; branch?: string };
}

export interface GitProbe {
  /** `git rev-parse --show-toplevel`, or null when cwd is not in a git repo. */
  toplevel(cwd: string): string | null;
  /** Worktree detection (main-repo rollup + branch). */
  worktree(cwd: string): WorktreeDetection;
  /** `git rev-parse --abbrev-ref HEAD`, or undefined when detached/unavailable. */
  branch(cwd: string): string | undefined;
}

/**
 * Normalize a path for comparison: convert backslashes to forward slashes, then
 * strip trailing slashes (but keep root "/").
 *
 * Every path the resolver compares (input cwd, declared roots, git toplevel) flows
 * through here, so normalizing separators once makes `isAtOrUnder` correct on Windows
 * too — without this, a declared root `C:\work\group` never prefix-matches a session
 * at `C:\work\group\repo` because the ancestor check appends `/`. Git's
 * `--show-toplevel` already emits forward slashes on every platform, so after this
 * the three sources agree. (A literal backslash in a POSIX directory name is not a
 * real project root, so collapsing it is an acceptable trade.)
 */
function norm(p: string): string {
  const trimmed = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** Is `child` the same as, or nested under, `ancestor`? (path-segment aware) */
function isAtOrUnder(child: string, ancestor: string): boolean {
  if (child === ancestor) return true;
  const base = ancestor === "/" ? "/" : ancestor + "/";
  return child.startsWith(base);
}

function nameOf(cwd: string): string {
  return basename(norm(cwd)) || "unknown";
}

/**
 * Pure resolution core. `declaredRoots` are the user-declared project roots from the
 * registry; `git` performs the (injected) git probes.
 */
export function resolveProjectCore(
  cwd: string,
  declaredRoots: DeclaredRoot[],
  git: GitProbe,
): ResolvedProject {
  const c = norm(cwd);

  // 1. Nearest declared root at/above cwd wins (deepest match).
  const ancestors = declaredRoots
    .map((d) => ({ name: d.name, cwd: norm(d.cwd) }))
    .filter((d) => isAtOrUnder(c, d.cwd))
    .sort((a, b) => b.cwd.length - a.cwd.length);

  if (ancestors.length > 0) {
    const root = ancestors[0];
    // Sub-scope under a declared root: the git repo/worktree the session sits in,
    // when it is deeper than the declared root itself.
    const top = git.toplevel(c);
    let worktree: ResolvedProject["worktree"];
    if (top) {
      const t = norm(top);
      if (t !== root.cwd && isAtOrUnder(t, root.cwd)) {
        worktree = { cwd: t, branch: git.branch(c) };
      }
    }
    return { projectCwd: root.cwd, projectName: root.name, worktree };
  }

  // 2. Git toplevel.
  const top = git.toplevel(c);
  if (top) {
    const wt = git.worktree(c);
    if (wt.isWorktree && wt.parentCwd) {
      const parent = norm(wt.parentCwd);
      return {
        projectCwd: parent,
        projectName: nameOf(parent),
        worktree: { cwd: norm(top), branch: wt.branch },
      };
    }
    const t = norm(top);
    return { projectCwd: t, projectName: nameOf(t) };
  }

  // 3. Non-git: the directory itself is the project.
  return { projectCwd: c, projectName: nameOf(c) };
}

/**
 * Resolve the owning project for `cwd` using the registry's declared roots and real
 * git. This is the production entry point used at session-create time.
 */
export function resolveProject(
  cwd: string,
  options: ProjectRegistryOptions = {},
): ResolvedProject {
  return resolveProjectCore(cwd, getDeclaredRoots(options), defaultGitProbe);
}

/** Default git probe backed by `git` via execSync. */
export const defaultGitProbe: GitProbe = {
  toplevel(cwd: string): string | null {
    try {
      const out = execSync("git rev-parse --show-toplevel", {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  },
  worktree(cwd: string): WorktreeDetection {
    return detectWorktree(cwd);
  },
  branch(cwd: string): string | undefined {
    try {
      const b = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return b && b !== "HEAD" ? b : undefined;
    } catch {
      return undefined;
    }
  },
};
