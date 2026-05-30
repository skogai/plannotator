/**
 * Integration tests for project resolution against REAL filesystems and REAL git.
 *
 * Each scenario builds an actual directory tree (git repos, linked worktrees,
 * detached worktrees, nested repos, non-git workspaces of sibling repos, declared
 * roots), runs the real resolver (`resolveProject`, which shells out to git) and the
 * real registry I/O (`registerResolvedProject` / `addProject` writing a temp
 * projects.json), and asserts the owning project / worktree tag / registry rows.
 *
 * Everything lives under one temp root that is realpath'd (macOS /var → /private/var)
 * and removed in afterAll.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveProject } from "./project-resolver";
import {
  registerResolvedProject,
  addProject,
  getDeclaredRoots,
  readProjectRegistry,
} from "./project-registry";

const GIT_ID = "-c user.email=t@t.dev -c user.name=Test -c commit.gpgsign=false";
const sh = (cmd: string, cwd: string) =>
  execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();

let ROOT = "";
let regCounter = 0;

/** A fresh empty registry dir (so resolve() sees no declared roots unless we add). */
function freshReg(): string {
  const dir = join(ROOT, "reg", String(regCounter++));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  sh("git init -q", dir);
  writeFileSync(join(dir, "README.md"), "init\n");
  sh(`git ${GIT_ID} add -A`, dir);
  sh(`git ${GIT_ID} commit -q -m init`, dir);
  return dir;
}

function mkdir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Shared layout (built once).
let solo = "";
let soloSub = "";
let soloWtFeat = "";
let soloWtFeatDeep = "";
let soloWtDetached = "";
let workspace = "";
let wsA = "";
let wsB = "";
let wsNotes = "";
let wsADeep = "";
let wsAWtInside = "";
let wsAWtInsideDeep = "";
let wsAWtOutside = "";
let outer = "";
let inner = "";
let innerDeep = "";
let plain = "";

beforeAll(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), "pl-res-")));

  // solo git repo + nested subdir
  solo = initRepo(join(ROOT, "solo"));
  soloSub = mkdir(join(solo, "packages", "ui"));

  // linked worktree on a branch (sibling of solo) + a deep subdir inside it
  soloWtFeat = join(ROOT, "solo-wt-feat");
  sh(`git ${GIT_ID} worktree add -b feat/x ${soloWtFeat}`, solo);
  soloWtFeatDeep = mkdir(join(soloWtFeat, "src", "deep"));

  // detached-HEAD worktree
  soloWtDetached = join(ROOT, "solo-wt-detached");
  sh(`git ${GIT_ID} worktree add --detach ${soloWtDetached}`, solo);

  // non-git workspace of sibling repos + a non-git subdir
  workspace = mkdir(join(ROOT, "workspace"));
  wsA = initRepo(join(workspace, "a"));
  wsB = initRepo(join(workspace, "b"));
  wsNotes = mkdir(join(workspace, "notes"));
  wsADeep = mkdir(join(wsA, "packages", "x")); // deep cwd inside a sub-repo

  // worktree of sub-repo wsA, located INSIDE the workspace, + a deep subdir in it
  wsAWtInside = join(workspace, "a-wt");
  sh(`git ${GIT_ID} worktree add -b feat/a-in ${wsAWtInside}`, wsA);
  wsAWtInsideDeep = mkdir(join(wsAWtInside, "src", "deep"));

  // worktree of sub-repo wsA, located OUTSIDE the workspace
  wsAWtOutside = join(ROOT, "ws-a-wt");
  sh(`git ${GIT_ID} worktree add -b feat/a-out ${wsAWtOutside}`, wsA);

  // nested repos: outer repo containing an independent inner repo + deep subdir
  outer = initRepo(join(ROOT, "outer"));
  inner = initRepo(join(outer, "inner"));
  innerDeep = mkdir(join(inner, "src", "deep"));

  // plain non-git standalone dir
  plain = mkdir(join(ROOT, "plain", "nested"));
});

afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe("plain git repo (no declared roots)", () => {
  test("launched at repo root → project is the repo", () => {
    const r = resolveProject(solo, { baseDir: freshReg() });
    expect(r.projectCwd).toBe(solo);
    expect(r.projectName).toBe("solo");
    expect(r.worktree).toBeUndefined();
  });

  test("launched in a nested subdir → project is the repo root (VC8)", () => {
    const r = resolveProject(soloSub, { baseDir: freshReg() });
    expect(r.projectCwd).toBe(solo); // not solo/packages/ui
    expect(r.projectName).toBe("solo");
    expect(r.worktree).toBeUndefined();
  });

  test("trailing slash on cwd is normalized", () => {
    const r = resolveProject(solo + "/", { baseDir: freshReg() });
    expect(r.projectCwd).toBe(solo);
  });
});

describe("worktrees roll up to the main repo (VC2/VC3)", () => {
  test("worktree on a branch → owns main repo, tagged {cwd, branch}", () => {
    const r = resolveProject(soloWtFeat, { baseDir: freshReg() });
    expect(r.projectCwd).toBe(solo);
    expect(r.projectName).toBe("solo");
    expect(r.worktree).toEqual({ cwd: soloWtFeat, branch: "feat/x" });
  });

  test("subdir inside a worktree → still owns main repo, scope is the worktree root", () => {
    const r = resolveProject(soloWtFeatDeep, { baseDir: freshReg() });
    expect(r.projectCwd).toBe(solo);
    expect(r.worktree).toEqual({ cwd: soloWtFeat, branch: "feat/x" });
  });

  test("detached-HEAD worktree → tagged with no branch", () => {
    const r = resolveProject(soloWtDetached, { baseDir: freshReg() });
    expect(r.projectCwd).toBe(solo);
    expect(r.worktree?.cwd).toBe(soloWtDetached);
    expect(r.worktree?.branch).toBeUndefined();
  });

  test("two worktrees of one repo → same owning project, distinct scopes", () => {
    const reg = freshReg();
    const a = resolveProject(soloWtFeat, { baseDir: reg });
    const b = resolveProject(soloWtDetached, { baseDir: reg });
    expect(a.projectCwd).toBe(solo);
    expect(b.projectCwd).toBe(solo);
    expect(a.worktree?.cwd).not.toBe(b.worktree?.cwd);
  });
});

describe("non-git directories", () => {
  test("plain non-git dir → the directory itself is the project", () => {
    const r = resolveProject(plain, { baseDir: freshReg() });
    expect(r.projectCwd).toBe(plain);
    expect(r.projectName).toBe("nested");
    expect(r.worktree).toBeUndefined();
  });

  test("non-git workspace root (not declared) → resolves to itself, sibling repos do NOT roll up", () => {
    const reg = freshReg();
    expect(resolveProject(workspace, { baseDir: reg }).projectCwd).toBe(workspace);
    // a sub-repo with no declaration is its own project (git toplevel)
    const a = resolveProject(wsA, { baseDir: reg });
    expect(a.projectCwd).toBe(wsA);
    expect(a.worktree).toBeUndefined();
  });
});

describe("nested repos", () => {
  test("inner repo wins over outer (git toplevel is innermost)", () => {
    const r = resolveProject(inner, { baseDir: freshReg() });
    expect(r.projectCwd).toBe(inner);
    expect(r.projectName).toBe("inner");
  });

  test("outer repo root → outer", () => {
    const r = resolveProject(outer, { baseDir: freshReg() });
    expect(r.projectCwd).toBe(outer);
  });
});

describe("declared workspace roots (mygroup/ case)", () => {
  function declared(...roots: Array<{ cwd: string; name: string }>): string {
    const reg = freshReg();
    for (const r of roots) addProject(r.cwd, r.name, { baseDir: reg }, true);
    return reg;
  }

  test("session in a sub-repo → owns the declared workspace, sub-repo is the worktree tier", () => {
    const reg = declared({ cwd: workspace, name: "workspace" });
    const r = resolveProject(wsA, { baseDir: reg });
    expect(r.projectCwd).toBe(workspace); // declared root supersedes git toplevel wsA
    expect(r.projectName).toBe("workspace");
    expect(r.worktree?.cwd).toBe(wsA);
    expect(r.worktree?.branch).toBeTruthy(); // wsA is a real repo on its default branch
  });

  test("session directly in the declared non-git workspace → no sub-scope", () => {
    const reg = declared({ cwd: workspace, name: "workspace" });
    const r = resolveProject(workspace, { baseDir: reg });
    expect(r.projectCwd).toBe(workspace);
    expect(r.worktree).toBeUndefined();
  });

  test("session in a non-git subdir of a declared workspace → no sub-scope", () => {
    const reg = declared({ cwd: workspace, name: "workspace" });
    const r = resolveProject(wsNotes, { baseDir: reg });
    expect(r.projectCwd).toBe(workspace);
    expect(r.worktree).toBeUndefined();
  });

  test("nearest (deepest) declared root wins", () => {
    const reg = declared(
      { cwd: ROOT, name: "root" },
      { cwd: workspace, name: "workspace" },
    );
    const r = resolveProject(wsA, { baseDir: reg });
    expect(r.projectCwd).toBe(workspace); // not ROOT
  });

  test("a declared root that is NOT an ancestor is ignored → falls through to git", () => {
    const reg = declared({ cwd: mkdir(join(ROOT, "elsewhere")), name: "elsewhere" });
    const r = resolveProject(solo, { baseDir: reg });
    expect(r.projectCwd).toBe(solo); // git toplevel; declared root irrelevant
  });

  test("declared root supersedes git even when cwd IS a sub-repo root", () => {
    const reg = declared({ cwd: workspace, name: "workspace" });
    const r = resolveProject(wsB, { baseDir: reg });
    expect(r.projectCwd).toBe(workspace);
    expect(r.worktree?.cwd).toBe(wsB);
  });
});

// ---------------------------------------------------------------------------
describe("registry persistence (registerResolvedProject)", () => {
  test("worktree session writes owning repo + child worktree row", () => {
    const reg = freshReg();
    registerResolvedProject(resolveProject(soloWtFeat, { baseDir: reg }), { baseDir: reg });
    const entries = readProjectRegistry({ baseDir: reg });

    const owner = entries.find((e) => e.cwd === solo);
    const child = entries.find((e) => e.cwd === soloWtFeat);
    expect(owner).toBeTruthy();
    expect(owner?.parentCwd).toBeUndefined();
    expect(owner?.declared).toBeUndefined(); // auto-add never declares
    expect(child).toBeTruthy();
    expect(child?.parentCwd).toBe(solo);
    expect(child?.branch).toBe("feat/x");
  });

  test("plain repo session writes a single owning row, no child", () => {
    const reg = freshReg();
    registerResolvedProject(resolveProject(soloSub, { baseDir: reg }), { baseDir: reg });
    const entries = readProjectRegistry({ baseDir: reg });
    expect(entries.map((e) => e.cwd)).toEqual([solo]);
    expect(entries[0].declared).toBeUndefined();
  });

  test("declared workspace: declaration is sticky, sub-repo registers as a child", () => {
    const reg = freshReg();
    addProject(workspace, "workspace", { baseDir: reg }, true);
    // a session under it auto-registers; must NOT clear the declared flag
    registerResolvedProject(resolveProject(wsA, { baseDir: reg }), { baseDir: reg });
    const entries = readProjectRegistry({ baseDir: reg });

    const ws = entries.find((e) => e.cwd === workspace);
    const a = entries.find((e) => e.cwd === wsA);
    expect(ws?.declared).toBe(true); // sticky
    expect(a?.parentCwd).toBe(workspace);
  });

  test("getDeclaredRoots returns only declared entries", () => {
    const reg = freshReg();
    addProject(workspace, "workspace", { baseDir: reg }, true); // declared
    registerResolvedProject(resolveProject(solo, { baseDir: reg }), { baseDir: reg }); // auto
    const roots = getDeclaredRoots({ baseDir: reg });
    expect(roots.map((r) => r.cwd)).toEqual([workspace]);
  });

  test("re-declaring an auto-added project promotes it to declared (sticky upgrade)", () => {
    const reg = freshReg();
    registerResolvedProject(resolveProject(solo, { baseDir: reg }), { baseDir: reg }); // auto
    expect(readProjectRegistry({ baseDir: reg }).find((e) => e.cwd === solo)?.declared).toBeUndefined();
    addProject(solo, "solo", { baseDir: reg }, true); // manual declare
    expect(readProjectRegistry({ baseDir: reg }).find((e) => e.cwd === solo)?.declared).toBe(true);
  });

  test("idempotent: registering the same worktree session twice keeps one row each", () => {
    const reg = freshReg();
    const resolved = resolveProject(soloWtFeat, { baseDir: reg });
    registerResolvedProject(resolved, { baseDir: reg });
    registerResolvedProject(resolved, { baseDir: reg });
    const entries = readProjectRegistry({ baseDir: reg });
    expect(entries.filter((e) => e.cwd === solo)).toHaveLength(1);
    expect(entries.filter((e) => e.cwd === soloWtFeat)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("context crossings (deep cwd × declared × worktree)", () => {
  function declareWorkspace(): string {
    const reg = freshReg();
    addProject(workspace, "workspace", { baseDir: reg }, true);
    return reg;
  }

  test("deep cwd inside a sub-repo of a declared workspace → owns workspace, sub-scope is the sub-repo", () => {
    const r = resolveProject(wsADeep, { baseDir: declareWorkspace() });
    expect(r.projectCwd).toBe(workspace); // declared root wins
    expect(r.worktree?.cwd).toBe(wsA); // sub-scope = the git repo it sits in, not the deep dir
    expect(r.worktree?.branch).toBeTruthy();
  });

  test("deep cwd inside a nested repo (no declared) → innermost repo root", () => {
    const r = resolveProject(innerDeep, { baseDir: freshReg() });
    expect(r.projectCwd).toBe(inner); // not outer, not innerDeep
    expect(r.worktree).toBeUndefined();
  });

  test("worktree INSIDE a declared workspace → owns workspace, sub-scope is the worktree dir (does not roll up to the sub-repo)", () => {
    const r = resolveProject(wsAWtInside, { baseDir: declareWorkspace() });
    expect(r.projectCwd).toBe(workspace); // declared root governs
    expect(r.worktree?.cwd).toBe(wsAWtInside); // the worktree dir itself, NOT wsA
  });

  test("deep cwd inside a worktree inside a declared workspace → same workspace + worktree sub-scope", () => {
    const r = resolveProject(wsAWtInsideDeep, { baseDir: declareWorkspace() });
    expect(r.projectCwd).toBe(workspace);
    expect(r.worktree?.cwd).toBe(wsAWtInside);
  });

  test("worktree OUTSIDE the declared workspace → ignores the declaration, rolls up to its own main repo", () => {
    const r = resolveProject(wsAWtOutside, { baseDir: declareWorkspace() });
    expect(r.projectCwd).toBe(wsA); // not workspace (worktree dir isn't under it), not wsAWtOutside
    expect(r.worktree).toEqual({ cwd: wsAWtOutside, branch: "feat/a-out" });
  });
});
