import type { DaemonProjectEntry } from "@plannotator/shared/daemon-protocol";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join, resolve, dirname, basename } from "path";

export interface ProjectRegistryOptions {
  baseDir?: string;
}

function registryPath(options: ProjectRegistryOptions = {}): string {
  const dir = options.baseDir ?? getPlannotatorDataDir();
  return join(dir, "projects.json");
}

function isProjectEntry(value: unknown): value is DaemonProjectEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.cwd === "string" &&
    typeof v.lastSeen === "string"
  );
}

export function readProjectRegistry(options: ProjectRegistryOptions = {}): DaemonProjectEntry[] {
  const path = registryPath(options);
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProjectEntry);
  } catch {
    return [];
  }
}

export function writeProjectRegistry(
  entries: DaemonProjectEntry[],
  options: ProjectRegistryOptions = {},
): void {
  const path = registryPath(options);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2), "utf-8");
}

export function registerProject(
  name: string,
  cwd: string,
  options: ProjectRegistryOptions = {},
  declared = false,
): DaemonProjectEntry {
  const entries = readProjectRegistry(options);
  const now = new Date().toISOString();
  const existing = entries.find((e) => e.cwd === cwd);
  if (existing) {
    existing.name = name;
    existing.lastSeen = now;
    if (declared) existing.declared = true; // sticky: never auto-unset a declared root
    writeProjectRegistry(entries, options);
    return existing;
  }
  const entry: DaemonProjectEntry = { name, cwd, lastSeen: now, ...(declared && { declared: true }) };
  entries.push(entry);
  writeProjectRegistry(entries, options);
  return entry;
}

export function removeProject(
  cwd: string,
  options: ProjectRegistryOptions = {},
): boolean {
  const entries = readProjectRegistry(options);
  const filtered = entries.filter((e) => e.cwd !== cwd);
  if (filtered.length === entries.length) return false;
  writeProjectRegistry(filtered, options);
  return true;
}

export function listProjects(options: ProjectRegistryOptions = {}): DaemonProjectEntry[] {
  const entries = readProjectRegistry(options);
  return entries.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export interface WorktreeDetection {
  isWorktree: boolean;
  parentCwd?: string;
  branch?: string;
}

export function detectWorktree(cwd: string): WorktreeDetection {
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" }).trim();
    const commonDir = execSync("git rev-parse --git-common-dir", { cwd, encoding: "utf-8" }).trim();
    const resolvedCommon = resolve(cwd, commonDir);
    const mainRepoGitDir = resolve(toplevel, ".git");

    if (resolvedCommon !== mainRepoGitDir) {
      const parentCwd = dirname(resolvedCommon);
      let branch: string | undefined;
      try {
        branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim();
        if (branch === "HEAD") branch = undefined;
      } catch {}
      return { isWorktree: true, parentCwd, branch };
    }
  } catch {}
  return { isWorktree: false };
}

export function addProject(
  cwd: string,
  name: string | undefined,
  options: ProjectRegistryOptions = {},
  declared = false,
): DaemonProjectEntry {
  const resolved = cwd.startsWith("~/")
    ? join(homedir(), cwd.slice(2))
    : cwd === "~"
      ? homedir()
      : cwd;
  if (!existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }

  const wt = detectWorktree(resolved);
  const projectName = name ?? resolved.split("/").filter(Boolean).pop() ?? "unknown";

  if (wt.isWorktree && wt.parentCwd) {
    const parentName = wt.parentCwd.split("/").filter(Boolean).pop() ?? "unknown";
    const parentEntries = readProjectRegistry(options);
    if (!parentEntries.some((e) => e.cwd === wt.parentCwd)) {
      const now = new Date().toISOString();
      parentEntries.push({ name: parentName, cwd: wt.parentCwd, lastSeen: now });
      writeProjectRegistry(parentEntries, options);
    }

    const entries = readProjectRegistry(options);
    const now = new Date().toISOString();
    const existing = entries.find((e) => e.cwd === resolved);
    if (existing) {
      existing.name = projectName;
      existing.lastSeen = now;
      existing.parentCwd = wt.parentCwd;
      existing.branch = wt.branch;
      if (declared) existing.declared = true;
      writeProjectRegistry(entries, options);
      return existing;
    }
    const entry: DaemonProjectEntry = {
      name: projectName,
      cwd: resolved,
      lastSeen: now,
      parentCwd: wt.parentCwd,
      branch: wt.branch,
      ...(declared && { declared: true }),
    };
    entries.push(entry);
    writeProjectRegistry(entries, options);
    return entry;
  }

  return registerProject(projectName, resolved, options, declared);
}

/** User-declared project roots (registry entries flagged `declared`). */
export function getDeclaredRoots(
  options: ProjectRegistryOptions = {},
): Array<{ cwd: string; name: string }> {
  return readProjectRegistry(options)
    .filter((e) => e.declared === true)
    .map((e) => ({ cwd: e.cwd, name: e.name }));
}

/**
 * Persist a resolved project (the owning root, plus its worktree/sub-repo child when
 * present). Used by auto-add at session-create time. Never sets `declared` — declared
 * roots are created only via the explicit add path.
 */
export function registerResolvedProject(
  resolved: { projectCwd: string; projectName: string; worktree?: { cwd: string; branch?: string } },
  options: ProjectRegistryOptions = {},
): void {
  // Owning project (preserves an existing `declared` flag).
  registerProject(resolved.projectName, resolved.projectCwd, options);

  // Sub-scope (worktree or sub-repo) as a child row under the project.
  if (resolved.worktree && resolved.worktree.cwd !== resolved.projectCwd) {
    const entries = readProjectRegistry(options);
    const now = new Date().toISOString();
    const childCwd = resolved.worktree.cwd;
    const childName = basename(childCwd) || resolved.projectName;
    const existing = entries.find((e) => e.cwd === childCwd);
    if (existing) {
      existing.name = childName;
      existing.lastSeen = now;
      existing.parentCwd = resolved.projectCwd;
      existing.branch = resolved.worktree.branch;
    } else {
      entries.push({
        name: childName,
        cwd: childCwd,
        lastSeen: now,
        parentCwd: resolved.projectCwd,
        branch: resolved.worktree.branch,
      });
    }
    writeProjectRegistry(entries, options);
  }
}
