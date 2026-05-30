/**
 * Plan Storage Utility
 *
 * Saves plans and annotations to ~/.plannotator/plans/
 * Cross-platform: works on Windows, macOS, and Linux.
 *
 * Runtime-agnostic: uses only node:fs, node:path, node:os.
 */

import { join, resolve, sep } from "path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "fs";
import { sanitizeTag } from "./project";
import { resolveUserPath } from "./resolve-file";
import { getPlannotatorDataDir } from "./data-dir";

const DATA_DIR = getPlannotatorDataDir();

/**
 * Get the plan storage directory, creating it if needed.
 * Cross-platform: uses os.homedir() for Windows/macOS/Linux compatibility.
 * @param customPath Optional custom path. Supports ~ for home directory.
 */
export function getPlanDir(customPath?: string | null): string {
  let planDir: string;

  if (customPath?.trim()) {
    planDir = resolveUserPath(customPath);
  } else {
    planDir = join(DATA_DIR, "plans");
  }

  mkdirSync(planDir, { recursive: true });
  return planDir;
}

/**
 * Extract the first heading from markdown content.
 */
function extractFirstHeading(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (!match) return null;
  return match[1].trim();
}

/**
 * Generate a slug from plan content.
 * Format: {sanitized-heading}-YYYY-MM-DD
 */
export function generateSlug(plan: string): string {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const heading = extractFirstHeading(plan);
  const slug = heading ? sanitizeTag(heading) : null;

  return slug ? `${slug}-${date}` : `plan-${date}`;
}

/**
 * Save the plan markdown to disk.
 * Returns the full path to the saved file.
 */
export function savePlan(slug: string, content: string, customPath?: string | null): string {
  const planDir = getPlanDir(customPath);
  const filePath = join(planDir, `${slug}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/**
 * Save annotations to disk.
 * Returns the full path to the saved file.
 */
export function saveAnnotations(slug: string, annotationsContent: string, customPath?: string | null): string {
  const planDir = getPlanDir(customPath);
  const filePath = join(planDir, `${slug}.annotations.md`);
  writeFileSync(filePath, annotationsContent, "utf-8");
  return filePath;
}

/**
 * Save the final snapshot on approve/deny.
 * Combines plan and annotations into a single file with status suffix.
 * Returns the full path to the saved file.
 */
export function saveFinalSnapshot(
  slug: string,
  status: "approved" | "denied",
  plan: string,
  annotations: string,
  customPath?: string | null
): string {
  const planDir = getPlanDir(customPath);
  const filePath = join(planDir, `${slug}-${status}.md`);

  // Combine plan with annotations appended
  let content = plan;
  if (annotations && annotations !== "No changes detected.") {
    content += "\n\n---\n\n" + annotations;
  }

  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// --- Version History ---

/**
 * Get the history directory for a project/slug combination, creating it if needed.
 * History is stored in ~/.plannotator/history/{project}/{worktreeSeg?}/{slug}/.
 * The optional worktreeSeg segment is present only when the session sits in a
 * worktree, so distinct worktrees of one project never collide.
 * Not affected by the customPath setting (that only affects decision saves).
 */
export function getHistoryDir(project: string, slug: string, worktreeSeg?: string): string {
  const historyDir = join(DATA_DIR, "history", project, ...(worktreeSeg ? [worktreeSeg] : []), slug);
  mkdirSync(historyDir, { recursive: true });
  return historyDir;
}

/**
 * Determine the next version number by scanning existing files.
 * Returns 1 if no versions exist, otherwise max + 1.
 */
function getNextVersionNumber(historyDir: string): number {
  try {
    const entries = readdirSync(historyDir);
    let max = 0;
    for (const entry of entries) {
      const match = entry.match(/^(\d+)\.md$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
    return max + 1;
  } catch {
    return 1;
  }
}

/**
 * Save a plan version to the history directory.
 * Deduplication: if the latest version has identical content, skip saving.
 * Returns the version number, file path, and whether a new file was created.
 */
export function saveToHistory(
  project: string,
  slug: string,
  plan: string,
  worktreeSeg?: string
): { version: number; path: string; isNew: boolean } {
  const historyDir = getHistoryDir(project, slug, worktreeSeg);
  const nextVersion = getNextVersionNumber(historyDir);

  // Deduplicate: check if latest version has identical content
  if (nextVersion > 1) {
    const latestPath = join(historyDir, `${String(nextVersion - 1).padStart(3, "0")}.md`);
    try {
      const existing = readFileSync(latestPath, "utf-8");
      if (existing === plan) {
        return { version: nextVersion - 1, path: latestPath, isNew: false };
      }
    } catch {
      // File read failed, proceed with saving
    }
  }

  const fileName = `${String(nextVersion).padStart(3, "0")}.md`;
  const filePath = join(historyDir, fileName);
  writeFileSync(filePath, plan, "utf-8");
  return { version: nextVersion, path: filePath, isNew: true };
}

/**
 * Read a specific version's content from history.
 * Returns null if the version doesn't exist or on read error.
 */
export function getPlanVersion(
  project: string,
  slug: string,
  version: number,
  worktreeSeg?: string
): string | null {
  const historyDir = join(DATA_DIR, "history", project, ...(worktreeSeg ? [worktreeSeg] : []), slug);
  const fileName = `${String(version).padStart(3, "0")}.md`;
  const filePath = join(historyDir, fileName);

  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Get the file path for a specific version in history.
 * Returns null if the version file doesn't exist.
 */
export function getPlanVersionPath(
  project: string,
  slug: string,
  version: number,
  worktreeSeg?: string
): string | null {
  const historyDir = join(DATA_DIR, "history", project, ...(worktreeSeg ? [worktreeSeg] : []), slug);
  const fileName = `${String(version).padStart(3, "0")}.md`;
  const filePath = join(historyDir, fileName);
  return existsSync(filePath) ? filePath : null;
}

/**
 * Get the number of versions stored for a project/slug.
 * Returns 0 if the directory doesn't exist.
 */
export function getVersionCount(project: string, slug: string, worktreeSeg?: string): number {
  const historyDir = join(DATA_DIR, "history", project, ...(worktreeSeg ? [worktreeSeg] : []), slug);
  try {
    const entries = readdirSync(historyDir);
    return entries.filter((e) => /^\d+\.md$/.test(e)).length;
  } catch {
    return 0;
  }
}

/**
 * List all versions for a project/slug with metadata.
 * Returns versions sorted ascending by version number.
 */
export function listVersions(
  project: string,
  slug: string,
  worktreeSeg?: string
): Array<{ version: number; timestamp: string }> {
  const historyDir = join(DATA_DIR, "history", project, ...(worktreeSeg ? [worktreeSeg] : []), slug);
  try {
    const entries = readdirSync(historyDir);
    const versions: Array<{ version: number; timestamp: string }> = [];
    for (const entry of entries) {
      const match = entry.match(/^(\d+)\.md$/);
      if (match) {
        const version = parseInt(match[1], 10);
        const filePath = join(historyDir, entry);
        try {
          const stat = statSync(filePath);
          versions.push({ version, timestamp: stat.mtime.toISOString() });
        } catch {
          versions.push({ version, timestamp: "" });
        }
      }
    }
    return versions.sort((a, b) => a.version - b.version);
  } catch {
    return [];
  }
}

// --- Global History Index ---

const VERSION_FILE_RE = /^\d+\.md$/;

/**
 * A single entry in the global history index: one row per
 * {project, optional worktree, slug} that has stored versions.
 */
export interface HistoryIndexEntry {
  project: string;
  worktree?: string;
  slug: string;
  versionCount: number;
  /** ISO mtime of the newest version file. Empty string if none readable. */
  latest: string;
  /**
   * Absolute path to the newest (highest-mtime) version file. Empty string if
   * none readable. Derived from the same mtime scan as `latest` — correct under
   * version-number gaps (do not reconstruct from versionCount).
   */
  latestVersionPath: string;
}

/**
 * Whether a directory is a slug dir — i.e. it directly contains at least one
 * version file matching /^\d+\.md$/. Returns false on any read error.
 */
function isSlugDir(dirPath: string): boolean {
  try {
    const entries = readdirSync(dirPath);
    return entries.some((e) => VERSION_FILE_RE.test(e));
  } catch {
    return false;
  }
}

/**
 * Compute version count + newest mtime (ISO) for a slug dir in one pass.
 * Returns null if the directory has no version files.
 */
function summarizeSlugDir(
  slugPath: string
): { versionCount: number; latest: string; latestVersionPath: string } | null {
  let entries: string[];
  try {
    entries = readdirSync(slugPath);
  } catch {
    return null;
  }
  let versionCount = 0;
  let latestMs = -1;
  let latest = "";
  let latestPath = "";
  for (const entry of entries) {
    if (!VERSION_FILE_RE.test(entry)) continue;
    versionCount++;
    try {
      const filePath = join(slugPath, entry);
      const stat = statSync(filePath);
      const ms = stat.mtime.getTime();
      if (ms > latestMs) {
        latestMs = ms;
        latest = stat.mtime.toISOString();
        latestPath = filePath;
      }
    } catch {
      // Unreadable version file: still counts, but contributes no mtime/path.
    }
  }
  return versionCount > 0 ? { versionCount, latest, latestVersionPath: latestPath } : null;
}

/**
 * Enumerate the entire history tree under DATA_DIR/history.
 *
 * Layout: history/{project}/{slug}/NNN.md  OR
 *         history/{project}/{worktreeSeg}/{slug}/NNN.md
 *
 * Disambiguation: a project's direct child dir is treated as a SLUG dir when it
 * directly contains any version file (/^\d+\.md$/). Otherwise it is treated as a
 * worktreeSeg dir and its own children are enumerated as slug dirs. Stray, empty,
 * or malformed directories (no version files anywhere beneath) are skipped.
 *
 * Defensive: a missing history root returns []. Non-directories and unreadable
 * entries are skipped rather than throwing.
 *
 * Returns one entry per {project, worktree?, slug} with versionCount + latest mtime.
 */
export function listAllHistory(): HistoryIndexEntry[] {
  const historyRoot = join(DATA_DIR, "history");
  const results: HistoryIndexEntry[] = [];

  let projects: string[];
  try {
    projects = readdirSync(historyRoot);
  } catch {
    return results;
  }

  for (const project of projects) {
    const projectPath = join(historyRoot, project);
    try {
      if (!statSync(projectPath).isDirectory()) continue;
    } catch {
      continue;
    }

    let children: string[];
    try {
      children = readdirSync(projectPath);
    } catch {
      continue;
    }

    for (const child of children) {
      const childPath = join(projectPath, child);
      try {
        if (!statSync(childPath).isDirectory()) continue;
      } catch {
        continue;
      }

      if (isSlugDir(childPath)) {
        // child is a slug dir directly under the project (flat layout).
        const summary = summarizeSlugDir(childPath);
        if (summary) {
          results.push({ project, slug: child, ...summary });
        }
        continue;
      }

      // Otherwise treat child as a worktreeSeg dir and enumerate its slug dirs.
      let slugDirs: string[];
      try {
        slugDirs = readdirSync(childPath);
      } catch {
        continue;
      }
      for (const slug of slugDirs) {
        const slugPath = join(childPath, slug);
        try {
          if (!statSync(slugPath).isDirectory()) continue;
        } catch {
          continue;
        }
        if (!isSlugDir(slugPath)) continue; // stray/empty/non-slug dir → skip
        const summary = summarizeSlugDir(slugPath);
        if (summary) {
          results.push({ project, worktree: child, slug, ...summary });
        }
      }
    }
  }

  return results;
}
