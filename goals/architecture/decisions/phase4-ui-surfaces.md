# Decision Fact: Phase 4 UI Surfaces (launcher / sidebar / sessions+history)

**Status:** Decided (normative) · **Date:** 2026-05-29 · **Owner:** Michael Ramos
**Scope:** How the project → worktree → session data model surfaces in the UI. Builds
on `./project-worktree-session-hierarchy.md` (the model), `./core-model-and-project-ux.md`
(the UX goals), and the Phase 2/3 primitives: `buildSessionTree` (packages/ui/utils)
and `GET /daemon/history`.

---

## The facts

1. **The launcher does not change.** The front-page "Select project → launch" flow
   (select a project, start Code Review / plan / etc.) stays exactly as it is today.
   Selecting projects to start new work is untouched.

2. **The sidebar groups by project, not by type.** It changes from today's grouping
   by session type (plan / review / annotate, in `AppSidebar.tsx`) to
   **project → worktree → session**, rendered from `buildSessionTree`.

3. **The sidebar shows live sessions only.** No history in the sidebar — it is the
   at-a-glance "what's running where."

4. **The sidebar lists ALL projects, but only the active one is expanded.** Every
   project appears; the active project is auto-expanded; the rest are collapsed but
   expandable to reveal their live sessions.

5. **The active project is the owning project of the current session.** Whatever
   session is open determines which project is expanded.

6. **History is browsable and filterable by project** — both per-project ("this
   project's past plans") and global ("everything"). New; does not exist today.

7. **Active sessions and history are conjoined into one surface.** A single view with
   an **Active ⇄ All** filter (All surfaces history) plus a **project filter**. A
   **full-page "full history" view** — modeled on the Git Dashboard's full-screen
   carousel-slide-with-Back pattern (`LandingPage` `viewIndex` carousel + `GitDashboard`
   `onBack`) — shows the complete history browse.

---

## Surfaces → primitives

| Surface | Renders | Powered by |
|---|---|---|
| Launcher | unchanged | existing `ProjectTable` / selection |
| Sidebar (`AppSidebar.tsx`) | all projects → worktrees → live sessions; active expanded | `buildSessionTree(projects, sessions)` — needs `projectStore` as a 2nd input |
| Sessions + History (conjoined) | live sessions + history, Active⇄All + project filter; full-page mode | live sessions (`useDaemonEventStore`) + `GET /daemon/history`; full-page via the carousel/full-screen pattern |

---

## Verification criteria

- [ ] **VC1 — Launcher untouched.** Select-project → launch behaves identically to before.
- [ ] **VC2 — Sidebar tree.** Sidebar renders `project → worktree → session` from
      `buildSessionTree` (closes hierarchy VC6).
- [ ] **VC3 — Sidebar state.** All projects listed; active project auto-expanded;
      others collapsed but expandable; live sessions only.
- [ ] **VC4 — Active project.** The expanded project equals the owning project of the
      currently-open session.
- [ ] **VC5 — Counts reconcile.** Every live session appears exactly once in the
      sidebar under its project/worktree (closes hierarchy VC7).
- [ ] **VC6 — Conjoined view.** One surface with Active⇄All + project filter; "All"
      includes history (from `/daemon/history`).
- [ ] **VC7 — Full history page.** A full-page history browse exists, following the
      Git Dashboard full-screen pattern.

---

## State plan (frontend)

Audited against the live stores. Owner intent (reuse what's in state; add only what's
missing) holds — almost everything is already there.

**Reuse as-is:** live sessions (`useDaemonEventStore.sessions`, already carry
`projectCwd`/`worktree`), `projectStore.projects`, `appStore.activeSessionId`.

**Derive (not stored):**
- Session tree → `useMemo(buildSessionTree(projects, sessions))`. Signature is exactly
  `(projects, sessions)` — both already in stores; no third input.
- Active project → selector `activeSessionId → session → projectCwd ?? cwd` (same
  owning-key fallback as `sessionTree.ts`). Derived, never stored (single source of truth).

**New (the whole added surface):**
1. `appStore`: `expandedProjects: Set<string>` + `toggleProjectExpand(cwd)` /
   `setProjectExpanded(cwd, open)`. **Immer: yes** (Set mutation). In `appStore` so it
   survives sidebar remounts.
2. New `stores/history-store.ts` — clone of `git-dashboard-store` (`entries`, `loading`,
   `error`, `lastFetchedAt`, `lastProjectKey`; `fetchHistory(projectCwd?)`, `clear()`).
   **Immer: yes**.
3. `daemonApiClient.getHistory(projectCwd?)` + `HistoryListResponse` type/guard
   (mirror the PR-detailed list). Route exists; client method doesn't.

**Local `useState` (no store):** conjoined-view `activeOrAll`, `projectFilter`,
`fullHistoryViewIndex` — flat, view-local scalars (no Immer).

Net for the sidebar slice specifically: extend `appStore` (expand state + active-project
selector) + rewrite `AppSidebar.tsx` to render `buildSessionTree`. The history store +
client method belong to the conjoined-view slice (later).

## Out of scope (this phase)

The plan/review/annotate session screens themselves; the resolver/registry/history
backend (done in Phases 1–3); any redesign beyond the three surfaces above.
