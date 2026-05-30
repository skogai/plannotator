/**
 * Tests for listAllHistory() / latestVersionPath.
 *
 * DATA_DIR is captured once at storage-module load, and other suites in the same
 * bun process may import storage before this file's hooks run — so we do NOT try
 * to override the data dir. Instead we anchor onto the REAL history root via
 * saveToHistory() (which returns the absolute path it wrote), craft the
 * gap/worktree fixtures under that same root, and clean up only our own dirs.
 *
 * Run: bun test packages/shared/list-history.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { listAllHistory, saveToHistory } from "./storage";

const GAP_PROJECT = `lh-gap-${process.pid}-${Date.now()}`;
const WT_PROJECT = `lh-wt-${process.pid}-${Date.now()}`;

// saveToHistory writes history/<project>/<slug>/001.md — its dirname's dirname's
// dirname is the history root.
const anchor = saveToHistory(GAP_PROJECT, "anchor-slug", "# anchor");
const historyRoot = dirname(dirname(dirname(anchor.path)));

function writeVersion(parts: string[], name: string, content: string, mtimeSec: number): string {
  const dir = join(historyRoot, ...parts);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  utimesSync(filePath, mtimeSec, mtimeSec);
  return filePath;
}

afterAll(() => {
  rmSync(join(historyRoot, GAP_PROJECT), { recursive: true, force: true });
  rmSync(join(historyRoot, WT_PROJECT), { recursive: true, force: true });
});

describe("listAllHistory latestVersionPath", () => {
  test("latestVersionPath points at the highest-mtime file under a version gap (001,003 — no 002)", () => {
    writeVersion([GAP_PROJECT, "gap-slug"], "001.md", "# v1", 1_000);
    const newest = writeVersion([GAP_PROJECT, "gap-slug"], "003.md", "# v3", 3_000);

    const history = listAllHistory();
    const entry = history.find((e) => e.project === GAP_PROJECT && e.slug === "gap-slug");
    expect(entry).toBeDefined();
    // Count is 2 (001 + 003). The latest path must be 003.md (newest mtime),
    // NOT the path reconstructed from versionCount=2 (which would be 002.md).
    expect(entry!.versionCount).toBe(2);
    expect(entry!.latestVersionPath).toBe(newest);
    expect(entry!.latestVersionPath.endsWith("003.md")).toBe(true);
    expect(entry!.worktree).toBeUndefined();
  });

  test("worktree-layout entry populates worktree and latestVersionPath", () => {
    writeVersion([WT_PROJECT, "branch-x", "wt-slug"], "001.md", "# a", 1_000);
    const newest = writeVersion([WT_PROJECT, "branch-x", "wt-slug"], "002.md", "# b", 5_000);

    const history = listAllHistory();
    const entry = history.find(
      (e) => e.project === WT_PROJECT && e.worktree === "branch-x" && e.slug === "wt-slug",
    );
    expect(entry).toBeDefined();
    expect(entry!.versionCount).toBe(2);
    expect(entry!.worktree).toBe("branch-x");
    expect(entry!.latestVersionPath).toBe(newest);
    expect(entry!.latestVersionPath.endsWith("002.md")).toBe(true);
  });
});
