# Projects & Sessions: Data Model, State, Persistence

> Architecture reference for how **projects** and **sessions** are modeled, stored,
> related, mutated, and reflected in frontend state across the single-server-runtime
> daemon. Synthesized from a read-only sweep of the backend disk layer, the daemon
> runtime, and the frontend (2026-05-29, branch `feat/single-server-runtime`).

## The one-sentence mental model

A "project" is a directory the daemon has seen (keyed by absolute `cwd`); a "session" is one live plan/review/annotate interaction. They're stored in completely separate places and connected by exactly one thing: the `cwd` string copied onto a session when it's created. Everything else — history, drafts, decision snapshots — is its own independent store keyed by something else entirely.

---

## 1. Projects

**What they are:** entries in a flat registry of directories you've opened Plannotator in.

**Where stored:** `~/.plannotator/projects.json` (data dir resolved by `getPlannotatorDataDir()` in `packages/shared/data-dir.ts`; override with `PLANNOTATOR_DATA_DIR`). Read/written only in `packages/server/daemon/project-registry.ts`.

**Shape** (`DaemonProjectEntry`, `daemon-protocol.ts:133`):

```ts
interface DaemonProjectEntry {
  name: string;        // git repo name, else dir name, else "_unknown"
  cwd: string;         // absolute path — THE identity key
  lastSeen: string;    // ISO
  parentCwd?: string;  // set only on git-worktree children → points at main repo's cwd
  branch?: string;     // set only on worktree children
}
```

- **Identity is `cwd`.** Every add/update/remove matches on `e.cwd === cwd`.
- **Worktrees:** when you open a linked git worktree, `detectWorktree()` registers two rows — the worktree (with `parentCwd`+`branch`) and, if missing, its parent repo (plain row). That's how the dashboard groups worktrees under their parent.
- **When it's written:** automatically on every session creation — `session-factory.ts` calls `addProject(cwd, project)` (skipped for temp dirs, so throwaway PR-review worktrees don't pollute it). That `lastSeen` bump is the only automatic write tying sessions to the registry.
- **Also via HTTP:** `GET/POST/DELETE /daemon/projects`.

This file is purely on disk — it is not part of the in-memory session store.

---

## 2. Sessions

### Runtime record (in memory — the source of truth)

The daemon holds sessions in a `Map<string, DaemonSessionRecord>` inside `DaemonSessionStore` (`packages/server/daemon/session-store.ts`). The record is rich and never serialized as-is:

```ts
interface DaemonSessionRecord {
  id; mode;            // "plan" | "review" | "annotate" | "goal-setup"
  status;              // see state machine below
  url;                 // the /s/<id> browser URL
  project; cwd?;       // denormalized from cwd at create time
  label; origin?;
  matchKey?;           // how a resubmission re-finds this session
  createdAt; updatedAt; expiresAt?;
  result?; error?;
  handleRequest?;      // the per-session HTTP handler (plan/review/annotate server)
  dispose?; snapshot?; // lifecycle hooks
}
```

### Lifecycle — "sessions never die," confirmed

Statuses: `active | idle | awaiting-resubmission | completed | cancelled | expired | failed`.

```
PLAN / ANNOTATE:   active ⇄ awaiting-resubmission   (suspend → reactivate, repeating)
CODE REVIEW:       active ⇄ idle                    (idle → reactivate, repeating)
```

- On any decision (approve / deny / feedback), the session does not complete. `registerPersistentDecision` calls `store.suspend()`; `registerReviewDecision` calls `store.idle()` (both in `session-factory.ts`). Both run an infinite decision loop (`registerDecisionLoop`) that re-arms a new decision cycle for agent origins — so the HTTP handler stays alive and the tab keeps working.
- `store.complete()` is only hit by goal-setup, errors, or explicit cancel/shutdown.
- **Expiry:** suspend/idle/reactivate delete `expiresAt`, so persistent sessions are never reaped. A 60 s interval sweeper only removes terminal sessions (after a 60 s grace) or sessions that still carry a past `expiresAt`. Default TTL is 96 h, and the frontend origin disables the idle timeout entirely.

### matchKey & reactivation (how a resubmit reuses the same tab)

When the agent resubmits via `POST /daemon/sessions`, the factory matches the new request to a live suspended/idle session by `matchKey`:

| Mode | matchKey |
|------|----------|
| plan | `plan:{project}:{slug}` (slug = first heading + date) |
| annotate (file) | `annotate:{project}:{filePath}` |
| review (PR/MR) | `review:{prUrl}` |
| review (local) | `review:{project}:{branch}` |

On a match, instead of a new record it calls `existing.session.updateContent(...)` → `store.reactivate(id)` → emits a `session-revision` WebSocket event. The open browser tab refreshes in place, no reload. (For PR reviews, `updateContent` also refreshes PR metadata + `prSwitchCache` so approve/comment hit the new head SHA — that was the #816 fix.)

### Session persistence on disk (the subtle part)

- **Live state is memory-only.** The `sessions/` dir holds only a terminal snapshot (`SessionSnapshot`, version-tagged JSON, ≤5 MB), and `writeSnapshot` is called only from `complete()`.
- Because plan/review/annotate sessions suspend/idle rather than complete, most sessions never write a snapshot at all.
- On daemon startup, it rehydrates any snapshots it finds into the store as `completed` records (so a refreshed tab can still render a finished session), and the `/s/:id` route falls back to a snapshot when no live handler exists.
- The snapshot references a project only by a denormalized `meta.project` / `meta.cwd` string — no foreign key.

---

## 3. Where projects & sessions relate — and where they don't

**The single link:** the `cwd` string.

- `projects.json` is keyed by `cwd`.
- A live session record carries `cwd` (+ derived `project` name).
- Session-create writes the project (`lastSeen`) using that `cwd`.

That's it. It's a denormalized copy, not a referential link — nothing joins a session back to a registry row at runtime; they just happen to share `cwd`/`project` values.

Three further on-disk stores, each keyed independently — none by session id:

| Store | Path | Keyed by | Notes |
|-------|------|----------|-------|
| History | `history/{project}/{slug}/NNN.md` | project name + slug | always-on auto-versioning; dedupes identical resubmits; independent of the `planSave` setting |
| Plans (decision snapshots) | `plans/{slug}.md` | slug only (flat) | opt-in via `planSave`; redirectable to a custom path |
| Drafts | `drafts/{contentHash}.json` | SHA-256 of the content | survives restarts; zero reference to session/project — same plan text restores the same draft anywhere |

So: history is project-scoped, plans are slug-scoped, drafts are content-scoped. None of them know about sessions, and none hold a pointer back to `projects.json`. (Note: there is no `active/` dir in the daemon model — that's an unrelated OpenCode-plugin path.)

---

## 4. Frontend state — Zustand / Immer / useState

The frontend is a single SPA (TanStack Router). There are six Zustand stores. Five are vanilla stores (`createStore` + a hand-written selector hook); one is a React store. All but one use the Immer middleware (never standalone `produce`).

| Store | File | Kind | Immer | Owns |
|-------|------|------|:---:|------|
| `appStore` | `stores/app-store.ts` | vanilla | ✅ | active session id + visited-session bootstraps + add-project/settings open flags |
| `projectStore` | `stores/project-store.ts` | vanilla | ✅ | the project list |
| `gitDashboardStore` | `stores/git-dashboard-store.ts` | vanilla | ✅ | PR dashboard data |
| `useDaemonEventStore` | `daemon/events/event-store.ts` | React | ✅ | daemon connection + live session list + status |
| `configStore` | `packages/ui/config/configStore.ts` | createStore | ❌ (no Immer) | settings (server > cookie > default) |
| `ReviewStore` | `packages/plannotator-code-review/store/` | vanilla, per-instance | ✅ | code-review hot path (annotations, files, diff options) |

Immer is used purely as the zustand middleware; mutations are in-place draft edits (`state.localAnnotations.push(...)`, `state.sessions[i] = ...`). `configStore` is the lone exception — plain `setState`. (`createStore` is still Zustand — the migration in `12d7bd27` landed; "no Immer" only means the middleware isn't layered on, which is the right call for a flat bag of scalar settings.)

### Projects in the frontend

- Read from `projectStore` via selector (`LandingPage.tsx`).
- Fetched once, in a mount `useEffect` in `Layout.tsx` (`fetchProjects()` → `GET /daemon/projects`). Not a router loader, and not re-fetched on WebSocket events. Add/remove mutate the store directly after the HTTP call (worktree adds trigger a re-list).

### Sessions in the frontend

- Route `s.$sessionId.tsx`: the loader fetches the bootstrap (`getSessionBootstrap`), then the route just calls `appStore.activateSession(id, bootstrap)` and renders `null`.
- Layout renders every visited session as a persistent panel, toggling `visibility/contentVisibility` instead of unmounting — that's why switching sessions never reloads. `appStore.activeSessionId` flips which is visible.
- Each panel is `SessionSurface` → `SessionProvider` → embedded `ReviewAppEmbedded`/`PlanAppEmbedded`. `SessionProvider` supplies a session-scoped `fetch` that rewrites `/api/...` → `/s/<id>/api/...` (`useSessionFetch.tsx`) — the API session boundary from CLAUDE.md.

### The two WebSocket clients (both hit `/daemon/ws`)

1. Daemon-family (`{family:"daemon"}`) → drives `useDaemonEventStore`: snapshot of the session list, then live `session-created/updated/removed`, plus `session-notify` and HTTP-polling fallback. This is how the landing page's session list stays live — note it updates sessions, not the project list.
2. Session-family (`{family, sessionId}`) → used inside the embedded apps for `external-annotations`, `agent-jobs`, and `session-revision`.

### How a session-revision lands (the reactivation path, end to end)

Agent resubmits → daemon matches by matchKey → `updateContent` → emits `session-revision` (session-family) → the embedded App's subscription fires → it updates React `useState` (`setMarkdown`/`setPreviousPlan`… in plan-review; `parseDiffToFiles` + `setDiffData` in code-review). For code-review, that parsed diff then flows into the `ReviewStore.files` slice via an effect.

### useState vs store boundary

- **Zustand owns:** anything shared across the persistent multi-panel tree (active/visited sessions), fed by the daemon socket (session list, status), a network-backed list (projects, PRs), or hot-path-and-widely-read (code-review annotations/files/diff options).
- **useState owns:** everything ephemeral and local to one surface — dialog/menu open flags, in-flight submit booleans, copy-confirmation, and even the raw content blobs themselves (`diffData`, `markdown`, `rawHtml`). Plan-review's App is almost entirely `useState`; its only store touch is `configStore`.
- **Context is just DI:** `SessionContext` carries the scoped `fetch`; `ReviewStoreContext` carries the per-instance store handle. Neither holds mutable state.

One nuance worth flagging: the `ReviewStore` is instance-scoped (created per `ReviewStoreProvider` mount via `useRef`), while the daemon-shell stores (`app`, `project`, `daemonEvent`, `gitDashboard`) are module singletons. That instance-scoping is what lets multiple review panels coexist in the persistent-panel model without clobbering each other.

---

## 5. Mutation cheat-sheet

| Action | Mutates | Persists to | Live signal |
|--------|---------|-------------|-------------|
| Open a plan/review/annotate | new session record (memory) + `addProject` (`lastSeen`) | `projects.json`; history auto-save | `session-created` (daemon family) |
| Agent resubmits | `updateContent` + `reactivate` | history (new version, deduped) | `session-revision` (session family) → `useState` in the App |
| Approve / deny / feedback | `suspend` (plan/annotate) or `idle` (review) — never complete | optional `plans/` snapshot (if `planSave`) | `session-updated` |
| Type an annotation draft | client → `POST /api/draft` | `drafts/{contentHash}.json` | — |
| Add/remove project | `projectStore` + HTTP | `projects.json` | (no WS; store mutated directly) |
| Session completes (rare: goal-setup/error) | `complete` → dispose | `sessions/{id}.json` snapshot | `session-updated` then removed after grace |

---

## Key files

- **Disk:** `packages/shared/data-dir.ts`, `packages/server/daemon/project-registry.ts`, `packages/server/daemon/session-store.ts`, `packages/shared/storage.ts`, `packages/shared/draft.ts`, `packages/shared/daemon-protocol.ts`
- **Runtime:** `packages/server/daemon/session-factory.ts`, `server.ts`, `event-hub.ts`, `runtime.ts`, `packages/server/session-handler.ts`, `packages/server/index.ts` / `review.ts` / `annotate.ts`
- **Frontend:** `apps/frontend/src/stores/{app-store,project-store,git-dashboard-store}.ts`, `apps/frontend/src/daemon/events/*`, `apps/frontend/src/routes/s.$sessionId.tsx`, `apps/frontend/src/app/Layout.tsx`, `apps/frontend/src/components/sessions/SessionSurface.tsx`, `packages/ui/hooks/useSessionFetch.tsx`, `packages/ui/utils/daemonHub.ts`, `packages/ui/config/configStore.ts`, `packages/plannotator-code-review/store/*`
