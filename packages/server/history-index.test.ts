/**
 * Global History Index Integration Tests
 *
 * Builds a fake history tree under the active history root and verifies
 * listAllHistory() enumerates flat (project/slug) and worktree-segmented
 * (project/worktreeSeg/slug) layouts, skipping stray/empty/malformed dirs.
 *
 * NOTE: storage.ts captures its data dir at module load, and bun shares the
 * module registry across test files in a single run — so we cannot reliably
 * point the module at a temp PLANNOTATOR_DATA_DIR after the fact. Instead, this
 * test writes a uniquely-named project tree under the module's real history root
 * (mirroring storage.test.ts, which writes to the same root under "test-project")
 * and asserts only on its own entries, then removes that project subtree. The
 * unique project names guarantee isolation from any other history on disk.
 *
 * Run: bun test packages/server/history-index.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { listAllHistory, type HistoryIndexEntry } from "./storage";

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const FLAT_PROJECT = `hidx-flat-${STAMP}`;
const WT_PROJECT = `hidx-wt-${STAMP}`;

const historyRoot = join(getPlannotatorDataDir(), "history");
const flatRoot = join(historyRoot, FLAT_PROJECT);
const wtRoot = join(historyRoot, WT_PROJECT);

beforeAll(() => {
  // Flat layout — slug dirs directly under the project.
  // alpha has 2 versions, beta has 1.
  mkdirSync(join(flatRoot, "alpha-slug"), { recursive: true });
  writeFileSync(join(flatRoot, "alpha-slug", "001.md"), "# A v1");
  writeFileSync(join(flatRoot, "alpha-slug", "002.md"), "# A v2");
  mkdirSync(join(flatRoot, "beta-slug"), { recursive: true });
  writeFileSync(join(flatRoot, "beta-slug", "001.md"), "# B v1");

  // Worktree-segmented layout — worktreeSeg dir holds slug subdirs.
  // branch-a/wt-slug has 3 versions; branch-b/wt-slug has 1.
  mkdirSync(join(wtRoot, "branch-a", "wt-slug"), { recursive: true });
  writeFileSync(join(wtRoot, "branch-a", "wt-slug", "001.md"), "# WA v1");
  writeFileSync(join(wtRoot, "branch-a", "wt-slug", "002.md"), "# WA v2");
  writeFileSync(join(wtRoot, "branch-a", "wt-slug", "003.md"), "# WA v3");
  mkdirSync(join(wtRoot, "branch-b", "wt-slug"), { recursive: true });
  writeFileSync(join(wtRoot, "branch-b", "wt-slug", "001.md"), "# WB v1");

  // Stray / malformed entries that must be skipped:
  // - empty slug-shaped dir (no version files) directly under a project
  mkdirSync(join(flatRoot, "empty-slug"), { recursive: true });
  // - a non-version file inside an otherwise-empty dir (still no NNN.md → skip)
  mkdirSync(join(flatRoot, "notes-only"), { recursive: true });
  writeFileSync(join(flatRoot, "notes-only", "readme.md"), "not a version");
  // - a worktreeSeg-shaped dir whose only child slug dir is empty → no entries
  mkdirSync(join(wtRoot, "empty-branch", "no-versions"), { recursive: true });
  // - a stray file at the project-children level (non-dir) → skip
  writeFileSync(join(flatRoot, "stray-file.md"), "junk");
});

afterAll(() => {
  rmSync(flatRoot, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
});

function find(
  entries: HistoryIndexEntry[],
  project: string,
  slug: string,
  worktree?: string,
): HistoryIndexEntry | undefined {
  return entries.find(
    (e) => e.project === project && e.slug === slug && e.worktree === worktree,
  );
}

describe("listAllHistory", () => {
  test("enumerates flat and worktree-segmented layouts", () => {
    const entries = listAllHistory();

    const alpha = find(entries, FLAT_PROJECT, "alpha-slug");
    expect(alpha).toBeDefined();
    expect(alpha!.worktree).toBeUndefined();
    expect(alpha!.versionCount).toBe(2);
    expect(alpha!.latest).toBeTruthy();

    const beta = find(entries, FLAT_PROJECT, "beta-slug");
    expect(beta).toBeDefined();
    expect(beta!.worktree).toBeUndefined();
    expect(beta!.versionCount).toBe(1);

    const wtA = find(entries, WT_PROJECT, "wt-slug", "branch-a");
    expect(wtA).toBeDefined();
    expect(wtA!.worktree).toBe("branch-a");
    expect(wtA!.versionCount).toBe(3);
    expect(wtA!.latest).toBeTruthy();

    const wtB = find(entries, WT_PROJECT, "wt-slug", "branch-b");
    expect(wtB).toBeDefined();
    expect(wtB!.worktree).toBe("branch-b");
    expect(wtB!.versionCount).toBe(1);
  });

  test("emits exactly the expected entries for the seeded projects", () => {
    const entries = listAllHistory();
    const flat = entries.filter((e) => e.project === FLAT_PROJECT);
    const wt = entries.filter((e) => e.project === WT_PROJECT);
    // 2 flat slugs, 2 worktree-segmented slugs. Strays excluded.
    expect(flat).toHaveLength(2);
    expect(wt).toHaveLength(2);
  });

  test("skips stray, empty, and malformed directories", () => {
    const entries = listAllHistory();
    expect(find(entries, FLAT_PROJECT, "empty-slug")).toBeUndefined();
    expect(find(entries, FLAT_PROJECT, "notes-only")).toBeUndefined();
    expect(find(entries, FLAT_PROJECT, "stray-file.md")).toBeUndefined();
    expect(find(entries, WT_PROJECT, "no-versions", "empty-branch")).toBeUndefined();
  });

  test("distinguishes worktree-segmented from flat (no false flat entries)", () => {
    const entries = listAllHistory();
    // A worktreeSeg dir itself must never be reported as a flat slug.
    expect(find(entries, WT_PROJECT, "branch-a")).toBeUndefined();
    expect(find(entries, WT_PROJECT, "branch-b")).toBeUndefined();
    // Every seeded proj-wt entry carries a worktree segment.
    const wtEntries = entries.filter((e) => e.project === WT_PROJECT);
    expect(wtEntries.every((e) => e.worktree !== undefined)).toBe(true);
  });
});
