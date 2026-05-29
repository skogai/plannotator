# Decision Fact: Project → Worktree → Session Hierarchy

**Status:** Decided (normative) · **Date:** 2026-05-29 · **Owner:** Michael Ramos
**Scope:** The canonical ownership model for projects, worktrees, and sessions.
This is a **fact**, not a proposal. It is the verification criteria all future
project/session/worktree work is checked against.

---

## The fact (canonical statement)

```
project -> session
project -> worktree -> session
```

- A project has many sessions.
- A project may have many worktrees, and a worktree may have many sessions.
- A session can only belong to one project. It may also belong to a project's worktree.

---

## Normative rules (derived, must hold)

1. **Every session belongs to exactly one project.** No session is orphaned; no
   session has zero projects; no session has more than one project.
2. **A session may belong to at most one worktree** (zero-or-one). The worktree is
   optional.
3. **If a session belongs to a worktree, that worktree must belong to the same
   project the session belongs to.** A session can never reference a worktree of a
   different project.
4. **A worktree belongs to exactly one project** (its root/main repository). A
   worktree never floats free and is never itself a project.
5. **Resolution at launch time:**
   - Launched in a normal repo/directory → `project = that repo`, `worktree = none`.
   - Launched in a git worktree → `project = the root/main repo`, `worktree = that
     worktree`. The session rolls up to the root project and is *tagged* with the
     worktree it came from.

---

## Verification criteria (checkable, moving forward)

Any implementation, refactor, or change is correct **only if all of these hold**:

- [ ] **VC1 — Session always has a project.** Given any session, in any state, in
      memory or persisted, `session.project` resolves to exactly one project.
      Orphaned / `_unknown` / null project is a defect.
- [ ] **VC2 — Worktree session rolls up to root.** A session launched inside a git
      worktree reports its owning project as the **root repository**, not the
      worktree directory.
- [ ] **VC3 — Worktree tag is preserved.** That same worktree-launched session
      still records *which* worktree (path + branch) it originated from, distinct
      from its owning project.
- [ ] **VC4 — Worktree ⊆ project.** Any session whose worktree is set has that
      worktree owned by the *same* project the session is owned by. No
      cross-project worktree references.
- [ ] **VC5 — Worktree is not a project.** A worktree is never represented as, or
      counted as, a top-level project. (Distinct entity tier under a project.)
- [ ] **VC6 — Cardinality holds in the UI.** The landing page renders the data as
      `project → (worktree?) → session`: a project lists its direct sessions and
      its worktrees; a worktree lists its sessions. Sessions are reachable under
      their owning project (and under their worktree when they have one).
- [ ] **VC7 — Counts reconcile.** A project's session count equals its direct
      sessions plus the sessions of all its worktrees. No session is double-counted
      and none is dropped.

---

## Notes on current state (informational — not the fact)

As of this decision, the **project ↔ worktree** relationship already exists at the
*display* layer (landing page groups worktree rows under a parent via `parentCwd`,
plus a live `git worktree list` resolver on expand). What does **not** yet satisfy
the fact:

- Worktrees are stored as flat sibling rows in `projects.json` with a `parentCwd`
  back-pointer; nesting is reconstructed by a component `.filter()`, not modeled.
  (Violates the spirit of VC5; nesting is display-time, not structural.)
- Sessions launched in a worktree currently take the **worktree** as their
  `project` via `detectProjectName(cwd)`. (Violates **VC2/VC3**.)
- Sessions are not rendered under the project/worktree tree at all — the project
  tree and the session list are separate UI regions. (Violates **VC6**.)

These gaps are the target of the upcoming implementation; this document is the bar
that implementation must clear.
