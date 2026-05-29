# Plan Version History — Usage Map (current state)

> Where/who/how plan version history is used today, traced before any restructure.
> Read-only audit, 2026-05-29, branch `feat/project-resolution`. This is the
> reference for moving history onto the project → worktree → session data model and
> for adding a global (cross-project) history view.

## What history is

Every plan you submit is auto-saved to disk as a numbered version, so you can see
how it changed over time (the version browser + plan diff). On-disk layout:

```
~/.plannotator/history/{project}/{slug}/NNN.md     (001.md, 002.md, …)
```
- `slug` = first `# heading` of the plan, sanitized, + `-YYYY-MM-DD` (same heading,
  same day → same slug → same folder). `generateSlug`, `storage.ts:49`.
- Only **two** path segments today: `{project}` and `{slug}`. **No worktree level.**
- Storage fns live in `packages/shared/storage.ts` (re-exported by
  `packages/server/storage.ts`): `getHistoryDir`, `saveToHistory`,
  `getPlanVersion`, `getPlanVersionPath`, `getVersionCount`, `listVersions`,
  `generateSlug`. All hard-code the 2-segment `history/{project}/{slug}` path.

## Writers (who saves history)

| Session type | Writes history? | Where |
|---|---|---|
| **plan** | ✅ | `packages/server/index.ts:151` (init), `:427` (resubmit) |
| **annotate** (single file) | ✅ | `packages/server/annotate.ts:146` (init), `:345` (resubmit) |
| annotate (folder / last-message) | ❌ | gated by `isFileBased` |
| **review** | ❌ | no history calls at all |

**Key fact / the divergence:** both writers compute the `{project}` segment with
`detectProjectName(cwd)` on the **operational cwd**, *inside the per-session servers*
— NOT via the new `resolveProject`. `session-factory` resolves the owning project
for the session record + registry, but it delegates plan/annotate creation to
`createPlannotatorSession`/`createAnnotateSession`, which re-derive project from cwd
themselves (`index.ts:150`, `annotate.ts:140`). So **history is still keyed by the
launch folder, not the resolved owning project** — a plan run in a worktree files
under the worktree's name.

The `slug` is fixed at session init (from the first plan's heading) and reused for
every resubmit.

## Readers (who shows history)

- **Plan server** (`index.ts`): `GET /api/plan/version?v=N`, `GET /api/plan/versions`,
  `POST /api/plan/vscode-diff` (uses `getPlanVersionPath`), and `GET /api/plan`
  returns inline `previousPlan` + `versionInfo {version, totalVersions, project}`.
- **Annotate server** (`annotate.ts`): `GET /api/plan/version`, `GET /api/plan/versions`
  (gated by `isFileBased`).
- **Frontend**: `usePlanDiff.ts` (`selectBaseVersion` → `/api/plan/version`,
  `fetchVersions` → `/api/plan/versions`); `VersionBrowser.tsx` sidebar; the plan
  diff engine; `session-revision` updates on resubmit; `previousPlan`/`project` fed
  into Ask-AI context (`packages/ai/context.ts:162,169`).
- Reads are **session-scoped**: the `project`+`slug` set at init are threaded through
  the session closure; nothing re-derives them, and nothing reads across sessions.

## Global / cross-project history

**Does not exist.** Every read needs an explicit `{project, slug}`; nothing
enumerates the `history/` root to list across projects. The only root-level touch is
**deletion**: `DELETE /daemon/projects` does `rm -rf history/{projectName}/`
(`server.ts:565`), triggered by the dashboard "Remove project" action. No "recent
plans", search, or cross-project listing anywhere.

## Coupling: write key vs read key

- **Write**: `{project}` = `sanitizeTag(detectProjectName(cwd))` (operational cwd).
- **Read**: same `{project}`/`{slug}` reused within the session; no normalization
  layer between writer and reader.
- **Risk**: if the `{project}` key ever changes for the same plan (repo rename,
  worktree, or the `resolveProject` vs `detectProjectName` divergence), old versions
  become invisible — readers only find what writers wrote under that exact key.

## Restructure implications

**To make history follow project → worktree → session** (`history/{project}/{worktree?}/{slug}/`):
1. Add a `worktree?` segment to all 6 storage fns (signature change).
2. Update all 4 `saveToHistory` call sites to pass it.
3. Decide the project-delete cleanup scope (`server.ts:571`) — delete whole project,
   or per-worktree.
4. Switch the writers from `detectProjectName(cwd)` to the resolver's owning project
   (thread `resolved.projectName` + worktree into the per-session servers) so the
   on-disk key matches the data model. (This also fixes the divergence above.)
5. Keep `session-factory`'s `matchKey` (`scopeKey`-based, already worktree-aware)
   consistent with the on-disk key if they're meant to correlate.

**To add a global (cross-project) view** — net-new:
- A function enumerating `history/` → project → (worktree?) → slug → versions.
- A new unscoped daemon endpoint (e.g. `GET /daemon/history`) — the existing
  `/api/plan/*` endpoints are session-bound and can't serve this.

**Desired end state (from the owner):** per-project history that mirrors the data
model, plus a global view that simply queries across all projects.
