/**
 * Plan Storage Tests
 *
 * Run: bun test packages/server/storage.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { generateSlug, getPlanDir, savePlan, saveToHistory, getPlanVersion, getPlanVersionPath, getVersionCount, listVersions } from "./storage";
import { sanitizeTag } from "./project";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-storage-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("generateSlug", () => {
  test("uses first heading and date", () => {
    const slug = generateSlug("# My Plan\n\nSome content");
    const date = new Date().toISOString().split("T")[0];
    expect(slug).toMatch(/^my-plan-\d{4}-\d{2}-\d{2}$/);
    expect(slug).toEndWith(date);
  });

  test("falls back to 'plan' when no heading", () => {
    const slug = generateSlug("No heading here");
    expect(slug).toMatch(/^plan-\d{4}-\d{2}-\d{2}$/);
  });

  test("same heading on same day produces same slug", () => {
    const a = generateSlug("# Deploy Strategy\nVersion A");
    const b = generateSlug("# Deploy Strategy\nVersion B");
    expect(a).toBe(b);
  });

  test("different headings produce different slugs", () => {
    const a = generateSlug("# Plan A");
    const b = generateSlug("# Plan B");
    expect(a).not.toBe(b);
  });
});

describe("getPlanDir", () => {
  test("creates directory at custom path", () => {
    const dir = makeTempDir();
    const customPath = join(dir, "custom", "plans");
    const result = getPlanDir(customPath);
    expect(result).toBe(customPath);
    // Directory should exist
    expect(readdirSync(customPath)).toBeDefined();
  });

  test("expands tilde in custom path", () => {
    const result = getPlanDir("~/.plannotator/test-plans");
    expect(result).not.toContain("~");
    expect(result).toMatch(/\.plannotator\/test-plans$/);
  });

  test("uses default when no custom path", () => {
    const result = getPlanDir();
    expect(result).toMatch(/plans$/);
    expect(result).toBe(getPlanDir(null));
  });

  test("uses default for null", () => {
    const result = getPlanDir(null);
    expect(result).toMatch(/plans$/);
  });

  test("uses default for whitespace-only custom path", () => {
    const result = getPlanDir("   ");
    expect(result).toMatch(/plans$/);
    expect(result).not.toBe(process.cwd());
  });
});

describe("savePlan", () => {
  test("writes markdown file to disk", () => {
    const dir = makeTempDir();
    const path = savePlan("test-slug", "# Content", dir);
    expect(path).toBe(join(dir, "test-slug.md"));
    expect(readFileSync(path, "utf-8")).toBe("# Content");
  });
});

describe("saveToHistory", () => {
  test("creates first version as 001.md", () => {
    const slug = `first-version-${Date.now()}`;
    const result = saveToHistory("test-project", slug, "# V1");
    expect(result.version).toBe(1);
    expect(result.path).toEndWith("001.md");
    expect(result.isNew).toBe(true);
    expect(readFileSync(result.path, "utf-8")).toBe("# V1");
  });

  test("increments version number", () => {
    const slug = `inc-test-${Date.now()}`;
    const v1 = saveToHistory("test-project", slug, "# V1");
    const v2 = saveToHistory("test-project", slug, "# V2");
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.path).toEndWith("002.md");
  });

  test("deduplicates identical content", () => {
    const slug = `dedup-test-${Date.now()}`;
    const v1 = saveToHistory("test-project", slug, "# Same");
    const v2 = saveToHistory("test-project", slug, "# Same");
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(1);
    expect(v2.isNew).toBe(false);
  });

  test("saves when content differs", () => {
    const slug = `diff-test-${Date.now()}`;
    const v1 = saveToHistory("test-project", slug, "# V1");
    const v2 = saveToHistory("test-project", slug, "# V2");
    expect(v2.isNew).toBe(true);
    expect(v2.version).toBe(2);
  });
});

describe("getPlanVersion", () => {
  test("reads saved version content", () => {
    const slug = `read-test-${Date.now()}`;
    saveToHistory("test-project", slug, "# Read Me");
    const content = getPlanVersion("test-project", slug, 1);
    expect(content).toBe("# Read Me");
  });

  test("returns null for nonexistent version", () => {
    const content = getPlanVersion("test-project", "nonexistent", 99);
    expect(content).toBeNull();
  });
});

describe("getVersionCount", () => {
  test("returns 0 for nonexistent project", () => {
    expect(getVersionCount("nope", "nope")).toBe(0);
  });

  test("counts versions correctly", () => {
    const slug = `count-test-${Date.now()}`;
    saveToHistory("test-project", slug, "# V1");
    saveToHistory("test-project", slug, "# V2");
    saveToHistory("test-project", slug, "# V3");
    expect(getVersionCount("test-project", slug)).toBe(3);
  });
});

describe("listVersions", () => {
  test("returns empty for nonexistent project", () => {
    expect(listVersions("nope", "nope")).toEqual([]);
  });

  test("lists versions in ascending order", () => {
    const slug = `list-test-${Date.now()}`;
    saveToHistory("test-project", slug, "# V1");
    saveToHistory("test-project", slug, "# V2");
    const versions = listVersions("test-project", slug);
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(1);
    expect(versions[1].version).toBe(2);
    expect(versions[0].timestamp).toBeTruthy();
  });
});

describe("history with worktreeSeg", () => {
  test("nests history under the worktree segment when present", () => {
    const slug = `wt-present-${Date.now()}`;
    const result = saveToHistory("proj", slug, "# V1", "feature-branch");
    expect(result.version).toBe(1);
    expect(result.path).toContain(`history${sep}proj${sep}feature-branch${sep}${slug}`);
  });

  test("writes flat layout when worktreeSeg is absent (back-compat)", () => {
    const slug = `flat-absent-${Date.now()}`;
    const result = saveToHistory("flatproj", slug, "# C");
    expect(result.version).toBe(1);
    // No extra segment between project and slug — path ends in proj/slug/001.md directly.
    expect(result.path).toEndWith(`history${sep}flatproj${sep}${slug}${sep}001.md`);
    expect(getPlanVersion("flatproj", slug, 1)).toBe("# C");
    expect(getVersionCount("flatproj", slug)).toBe(1);
  });

  test("isolates segments so reader==writer never crosses worktrees", () => {
    const slug = `wt-iso-${Date.now()}`;
    // branch-a gets 2 versions, branch-b gets 1, flat layout gets none.
    saveToHistory("proj", slug, "# A1", "branch-a");
    saveToHistory("proj", slug, "# A2", "branch-a");
    saveToHistory("proj", slug, "# B1", "branch-b");

    expect(getVersionCount("proj", slug, "branch-a")).toBe(2);
    expect(getVersionCount("proj", slug, "branch-b")).toBe(1);
    expect(getVersionCount("proj", slug)).toBe(0);

    expect(getPlanVersion("proj", slug, 1, "branch-a")).toBe("# A1");
    expect(getPlanVersion("proj", slug, 1, "branch-b")).toBe("# B1");
    expect(getPlanVersion("proj", slug, 1)).toBeNull();

    const aVersions = listVersions("proj", slug, "branch-a");
    expect(aVersions).toHaveLength(2);
    expect(aVersions[0].version).toBe(1);
    expect(aVersions[1].version).toBe(2);

    const bVersions = listVersions("proj", slug, "branch-b");
    expect(bVersions).toHaveLength(1);
    expect(bVersions[0].version).toBe(1);

    expect(listVersions("proj", slug)).toEqual([]);
  });

  test("getPlanVersionPath returns the segmented path or null", () => {
    const slug = `wt-path-${Date.now()}`;
    saveToHistory("proj", slug, "# V1", "branch-x");
    const path = getPlanVersionPath("proj", slug, 1, "branch-x");
    expect(path).not.toBeNull();
    expect(path!).toContain(`history${sep}proj${sep}branch-x${sep}${slug}`);
    expect(path!).toEndWith(`001.md`);
    // Missing version → null.
    expect(getPlanVersionPath("proj", slug, 99, "branch-x")).toBeNull();
    // Wrong segment → null (no shadowing).
    expect(getPlanVersionPath("proj", slug, 1, "branch-y")).toBeNull();
  });

  test("detached worktree → segment derived from basename", () => {
    const slug = `wt-detached-${Date.now()}`;
    // Mirror session-factory: no branch → sanitizeTag(basename(worktree.cwd)).
    const seg = sanitizeTag("my-wt-dir") ?? undefined;
    expect(seg).toBe("my-wt-dir");
    const result = saveToHistory("proj", slug, "# V1", seg);
    expect(result.path).toContain(`history${sep}proj${sep}my-wt-dir${sep}${slug}`);
  });

  test("branch with slashes collapses to a single dir level", () => {
    const slug = `wt-slash-${Date.now()}`;
    const seg = sanitizeTag("feature/foo") ?? undefined;
    expect(seg).toBe("featurefoo");
    const result = saveToHistory("proj", slug, "# V1", seg);
    expect(result.path).toContain(`history${sep}proj${sep}featurefoo${sep}${slug}`);
    // Never a nested feature/foo directory tree.
    expect(result.path).not.toContain(`history${sep}proj${sep}feature${sep}foo`);
  });

  test("no worktree → undefined segment → flat layout", () => {
    const slug = `wt-none-${Date.now()}`;
    const worktree: { branch?: string; cwd: string } | undefined = undefined;
    const seg = worktree ? sanitizeTag((worktree as any).branch || "") ?? undefined : undefined;
    expect(seg).toBeUndefined();
    const result = saveToHistory("proj", slug, "# V1", seg);
    expect(result.path).toContain(`history${sep}proj${sep}${slug}`);
  });
});

describe("worktreeSeg formula (sanitizeTag)", () => {
  test("strips slashes from branch names", () => {
    expect(sanitizeTag("feature/foo")).toBe("featurefoo");
  });

  test("preserves 2-char segments (does not coalesce to null)", () => {
    expect(sanitizeTag("ab")).toBe("ab");
  });
});
