# Decision Fact: cwd / Worktree Collection Contract

**Status:** Decided (normative) · **Date:** 2026-05-29 · **Owner:** Michael Ramos
**Scope:** Who is responsible for collecting the cwd / worktree information that
identifies a session's project and worktree, and how it flows to the daemon.
This is a **fact** we build around and verify against. It is the *input side* of
the Project → Worktree → Session hierarchy fact
(`./project-worktree-session-hierarchy.md`): it guarantees the correct cwd/worktree
arrive so that VC2/VC3 of that fact (worktree sessions roll up to the root project,
tagged with their worktree) can be satisfied.

---

## The fact (canonical statement)

**Base contract:**
```
agent → cli (MUST collect cwd/worktree info) → daemon
```

**Optional enrichment contract (future, additive — same signature):**
```
agent-plugin (already has cwd/worktree info) → cli (same signature) → daemon
```

- Everything always talks to the **CLI**. The CLI is the single chokepoint and is
  **authoritative** for cwd/worktree.
- It is **primarily the CLI's job** to obtain cwd/worktree. If the agent does not
  supply it, the CLI derives it itself.
- **For now we assume the agent never supplies it.** The agent-supplied path
  (Pi / OpenCode / AMP may be able to pass it) is a capability we leave the door
  open for via the *same signature* — not something the first pass depends on.

---

## Normative rules (derived, must hold)

1. **CLI is authoritative and self-sufficient.** The CLI must produce a correct
   cwd/worktree with **zero cooperation from the agent**. The system never *requires*
   agent-origin cwd/worktree to function.
2. **cwd source = transient process cwd (the only universally-available signal).**
   The CLI's cwd is its process working directory, or an explicit `--cwd`. Empirically
   (see Host signal reality below), this transient cwd is the **only** directory
   signal guaranteed at invocation time across hosts and across the hook-vs-command
   paths. It is unreliable on its own (agents `cd`; launches happen from subdirs).
3. **Normalize transient cwd → git project root (the primary, host-independent
   mechanism).** The CLI resolves the canonical project root from whatever cwd it
   inherits via `git rev-parse --show-toplevel`. This single step neutralizes both
   the agent-`cd` problem and the launched-from-subdir problem, and works the same
   for every host. Worktree identity (root repo + branch + path) is derived from
   there. This git resolution must live in **one** home (today: the daemon's
   `detectWorktree`/`detectProjectName`), not be duplicated.
4. **Host project-dir signals are optional enrichment, not the foundation.** When a
   host offers a stable project-dir signal, the CLI/wrapper may pass it as a hint
   (same signature), but correctness must not depend on it — git-root normalization
   is the floor.
5. **Agent-supplied info is optional enrichment, passed through the same signature.**
   Adding it later must be **additive and non-breaking** — the same request field(s),
   no new code path the daemon depends on.
6. **Precedence.** When valid agent-supplied cwd/worktree is present, it takes
   precedence; otherwise the CLI-derived (git-normalized) value is used. Absence is
   the expected, fully-supported case.

---

## Verification criteria (checkable, moving forward)

Any implementation is correct **only if all of these hold**:

- [ ] **VC1 — Agent-independent.** With an agent that supplies no cwd/worktree
      (the assumed default), the CLI still delivers a correct cwd/worktree to the
      daemon, and the resulting session is attributed to the correct project/worktree.
- [ ] **VC2 — Daemon never requires agent info.** No daemon code path depends on
      cwd/worktree originating from the agent; the CLI-provided value is always
      sufficient.
- [ ] **VC3 — Single signature.** The enrichment path uses the same request
      signature as the base path. Enabling agent-supplied info requires no breaking
      change to the daemon contract.
- [ ] **VC4 — Precedence honored.** When valid agent-supplied cwd/worktree is
      present it is used; when absent or invalid, the CLI-derived value is used.
      Neither case errors.
- [ ] **VC5 — Spawn-cwd correctness.** Every host wrapper (Claude Code hook,
      OpenCode, Pi, AMP, etc.) launches the CLI such that its process cwd (or passed
      `--cwd`) is the agent's working directory. Verified per host.
- [ ] **VC6 — Feeds the hierarchy fact.** The cwd/worktree the CLI collects is
      sufficient for the daemon to satisfy the Project → Worktree → Session
      hierarchy (esp. VC2/VC3 there: worktree sessions roll up to root + retain
      worktree tag).
- [ ] **VC7 — No duplicated git logic.** Worktree resolution from cwd lives in one
      place; it is not reimplemented in both CLI and daemon.
- [ ] **VC8 — Git-root normalization is the floor.** Given only a transient cwd
      anywhere inside a repo (any subdir, after any agent `cd`), the resolved project
      root is the repo's `git rev-parse --show-toplevel`. The system never treats the
      raw transient cwd as the project. (Non-git dirs fall back to the cwd itself.)

---

## Host signal reality (empirical, 2026-05-29)

Researched across Claude Code (docs), Pi (`~/oss-agents/pi`), and OpenCode
(`~/oss-agents/opencode`); the Claude slash-command row was measured live via the
`/plannotator-debug-env` probe.

| Host / path | Stable project-dir signal it offers | Git root? | Notes |
|---|---|---|---|
| **Claude Code — hook** (PermissionRequest) | `CLAUDE_PROJECT_DIR` **env** (docs: stable project root) | ≈ project root | Payload `cwd` is transient (changes on `cd`). |
| **Claude Code — slash command** | **none** | — | **Measured:** `CLAUDE_PROJECT_DIR` is **UNSET** in a command's `!`-bash env. Only `CLAUDE_CODE_{ENTRYPOINT,EXECPATH,SESSION_ID,TMPDIR}` + `CLAUDE_EFFORT` are present — no directory var. Only signal is transient `pwd`. |
| **OpenCode — plugin** | `ctx.worktree` (= `git rev-parse --show-toplevel`) **and** `ctx.directory` (launch dir) | ✅ `ctx.worktree` | Best of the three; both frozen at init, survive agent `cd`. Our plugin currently uses `ctx.directory`. |
| **Pi — extension** | `ctx.cwd` (launch dir) only | ❌ | No worktree/project-root concept. Stable within a session (isolated subshells), but may be a subdir. |

**Conclusion that drives the rules above:** the project-dir signals are
**inconsistent and, for the dominant Claude slash-command path, absent.** The only
thing always present at invocation is the transient cwd. Therefore git-root
normalization in the CLI (Rule 3 / VC8) is the load-bearing mechanism; host signals
(`CLAUDE_PROJECT_DIR` on the hook path, `ctx.worktree` on OpenCode) are enrichment
layered on top, never the foundation.

## Notes on current state (informational — not the fact)

- The plugin-protocol request already carries `cwd`; the CLI/plugin-client
  populates it, and the daemon derives `project` (`detectProjectName`) and worktree
  (`detectWorktree`) from it (`getRequestCwd` in `session-factory.ts`). So the base
  "CLI provides cwd → daemon resolves" flow substantially exists today — but it is
  **not yet git-normalized** to the toplevel, which is the gap VC8 names.
- Our Claude-hook path *could* read `CLAUDE_PROJECT_DIR` (it's set for hooks); our
  command path *cannot* (measured unset). So even within Claude Code, the two paths
  differ — another reason to standardize on CLI git-normalization rather than the
  host env var.
- Our OpenCode plugin uses `ctx.directory` (launch dir); `ctx.worktree` (git root)
  is available and is the stricter signal if we want to pass an enrichment hint.
