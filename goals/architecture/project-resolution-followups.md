# Project Resolution — Follow-ups / Backlog

> Open items after the project-resolution backend landed (branch
> `feat/project-resolution`, 2026-05-29). The resolver + registry + session
> attribution + 40 tests are done; these are the not-yet-migrated edges and the
> next layers. Context: `./decisions/project-worktree-session-hierarchy.md`,
> `./decisions/cwd-worktree-collection-contract.md`, `./plan-history-usage-map.md`.

## 1. Migrate history onto the resolver (NOT a regression — unmigrated)

**Why:** the resolver is new; the plan/annotate servers still compute the history
`{project}` segment via `detectProjectName(cwd)` on the operational cwd, independent
of `resolveProject`. So the registry/live session attribute a worktree plan to the
main repo, but its **history files quietly land under the worktree's folder**. Two
attribution systems disagree.

**Fix:**
- Thread the resolved owning project (`resolved.projectName`, + worktree) from
  `session-factory` into `createPlannotatorSession` / `createAnnotateSession` instead
  of re-deriving from cwd (`packages/server/index.ts:150`, `annotate.ts:140`).
- Move history layout to mirror the data model: `history/{project}/{worktree?}/{slug}/`
  — add a `worktree?` segment to the 6 storage fns in `packages/shared/storage.ts`
  and the 4 `saveToHistory` call sites.
- Reconcile the project-delete cleanup (`server.ts:571`, `rm -rf history/{name}`)
  with the new layout.
- Keep consistent with `session-factory`'s `scopeKey` matchKey (already
  worktree-aware).

**Size:** ~4 backend files. **Risk:** low. **Note:** old history written under the
pre-migration key becomes invisible to new sessions unless we add a fallback/migration
read — decide whether to migrate existing folders or just start fresh.

## 2. Session snapshot meta missing the new keys

The disk snapshot (`sessions/{id}.json`, written only on `complete()`) has
`meta: { project, origin, cwd, label }` — no `projectCwd`/`worktree`
(`session-store.ts:84`). The live record/summary carry them; the snapshot doesn't.
Add them to `SessionSnapshot.meta` + `writeSnapshot`, and rehydrate on startup
(`runtime.ts`). Small. Low priority (snapshots are rare).

## 3. Global (cross-project) history view — net-new

No cross-project history query exists today; every read needs an explicit
`{project, slug}`. Desired end state (owner): per-project history that mirrors the
model, plus a **global** view that queries across all projects.
- New fn enumerating `history/` → project → (worktree?) → slug → versions.
- New unscoped endpoint (e.g. `GET /daemon/history`) — the `/api/plan/*` endpoints
  are session-bound and can't serve this.

## 4. Aggregation layer + UI tree (`project → worktree → session`)

Membership (forward edges) is done; the reverse/aggregate edges (project has many
sessions/worktrees, worktree has many sessions) are not materialized.
- A pure **tree builder**: `(declared roots + worktree rows, sessions[]) → tree`,
  grouping the live session list by the `projectCwd`/`worktree.cwd` keys the resolver
  now stamps. Unit-testable like the resolver.
- Landing-page UI to render the tree (today projects + sessions are separate regions;
  worktrees are a display-time filter). This is the larger piece.

## 5. Frontend "add project" → declared path

The manual `POST /daemon/projects` now marks entries `declared: true` (enables the
non-git workspace / `mygroup/` case). The landing "add project" button works through
that path but hasn't been wired/verified for declaring a workspace root explicitly.

## 6. Doc drift

`CLAUDE.md` documents plan/review matchKeys as `plan:project:slug` /
`review:project:branch`; they're now keyed on the operational scope
(`scopeKey`-based) to keep worktrees distinct. Update the doc.
