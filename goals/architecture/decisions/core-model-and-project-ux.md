# Decision Fact: Core Model (resolveProject) & Project-Based UX

**Status:** Decided (normative) · **Date:** 2026-05-29 · **Owner:** Michael Ramos
**Scope:** The one-line core pipeline, and *why* the project/worktree/session model
exists — what UX it must enable. Synthesizes the two companion facts:
`./project-worktree-session-hierarchy.md` (the data model) and
`./cwd-worktree-collection-contract.md` (how cwd/worktree arrive).

---

## The fact (canonical statement)

**Core model:**
```
agent → cli(resolveProject) → daemon
```

- Everything talks to the **CLI**. The CLI's `resolveProject` step is the **single
  point** that turns "wherever the agent is" into the canonical **project (+ optional
  worktree)** a session belongs to. It is the bridge between the cwd contract (how
  cwd/worktree are collected) and the data model (project → worktree → session).
- `resolveProject` is **the core model step** — not an add-on. Project/worktree
  membership is defined here and nowhere else; every downstream consumer (registry,
  session record, history, UI) reads what it stamps.

## Why it exists — the UX this model must enable (normative goals)

The whole point of resolving sessions to a stable project (and optional worktree) is
**project-based UX**:

1. **Group sessions under a single project** — a project shows all its sessions.
2. **Group worktrees (and their sessions) under that project** — `project → worktree
   → session` is navigable in the UI, not a flat list.
3. **Per-project history** — a project's plan/annotate history is viewable scoped to
   that project (and, where relevant, that worktree).
4. **Global history** — history is *also* queryable across all projects (the
   cross-project view; replaces the old "archive" browse use case, which the
   per-plan version browser never covered).

These are the acceptance goals the model is built to serve; the data model and the
cwd contract are the means.

---

## Verification criteria (checkable, moving forward)

- [ ] **VC1 — Single resolution point.** Project/worktree membership for a session is
      produced by `resolveProject` and nothing re-derives it independently. (Today's
      known violation: history writers still call `detectProjectName(cwd)` — see
      `../project-resolution-followups.md` #1.)
- [ ] **VC2 — Grouping is derivable.** Given the live sessions + registry, the UI can
      render `project → worktree → session` purely by grouping on the
      `projectCwd`/`worktree.cwd` keys the resolver stamps (no extra lookups).
- [ ] **VC3 — Per-project history.** History is addressable by project (and worktree
      where applicable), consistent with the resolved owning project.
- [ ] **VC4 — Global history.** A cross-project history query/endpoint exists and
      lists across all projects.

---

## Consistency check (no discrepancy with companion facts)

- **Data model** (`project-worktree-session-hierarchy.md`): unchanged and matched —
  this fact names the pipeline step that *produces* that hierarchy. The middle tier
  ("worktree") is the generalized sub-scope (git worktree **or** sub-repo under a
  declared workspace), per rule 4 there.
- **cwd contract** (`cwd-worktree-collection-contract.md`): unchanged and matched —
  `cli(resolveProject)` is exactly the CLI-authoritative, git-root-normalizing step
  that contract describes; host enrichment remains optional.
- VC3/VC4 here (per-project + global history) are the *goal* statements; the
  *migration work* to reach them is tracked in `../project-resolution-followups.md`
  (#1 history→resolver, #3 global view, #4 aggregation + UI tree).
