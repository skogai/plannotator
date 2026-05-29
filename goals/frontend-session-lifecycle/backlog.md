# Frontend Session Lifecycle — Backlog

Tracked issues and feature requests for the daemon frontend app.

---

## TODO — Post-merge human verification (deferred from PR #813 & #814)

These two changes were code-reviewed (interrogate, 4 models each) and typecheck/build/unit-test clean, but could not be verified visually/interactively in the agent environment (no browser automation; `glab` not installed). Verify by hand:

**Add-Project dialog → Radix (PR #813):**
- [ ] Open the landing page → "Add project". Dialog opens **anchored near the top** (~15vh), ~512px wide — not centered or full-width.
- [ ] Search input is **focused on open** (can type without clicking).
- [ ] Keyboard nav works: ↑/↓ move selection (Recent + Directories), Tab navigates into a dir, Enter selects, Esc closes.
- [ ] Backdrop click closes; the single X button closes; there is **only one** close button.
- [ ] Footer hint row is visible; on a short window the list scrolls rather than clipping.
- [ ] No Radix "Missing Description" console warning in dev.

**GitLab dashboard (PR #814)** — requires `glab` installed + authenticated and a GitLab remote:
- [ ] gitlab.com repo: dashboard **lists open MRs** (not blank, not "coming soon").
- [ ] Self-hosted GitLab on a **custom domain** (e.g. `code.company.com`) is detected as GitLab and lists MRs (not misrouted to `gh`).
- [ ] MR rows show title/author/state/draft; additions/deletions render as **"—"** (not `+0 −0`).
- [ ] Force a fetch failure (revoke token / bad permission) → dashboard shows a **"Failed to load"** message, not a silent blank.
- [ ] Regression: GitHub repos still list PRs and stacks exactly as before.

---

## 1. ~~Completion overlay blocks the frontend~~ DONE

Fixed in `7d2a626a`. Embedded surfaces now show a `CompletionBanner` (inline bar below the header) instead of the full-screen overlay. Action buttons hide after submission. Standalone mode unchanged.

---

## ~~2. Tab mode config (open new tabs + auto-close)~~ DONE

Implemented and wired end to end as `legacyTabMode` in `~/.plannotator/config.json` (default `false`):
- **Setting persists:** the Settings → General toggle (`packages/ui/components/settings/GeneralTab.tsx:109-114`) is wired in `apps/frontend/src/components/settings/AppSettingsDialog.tsx:223-228`, which POSTs `{ legacyTabMode }` to `/daemon/config`; the daemon allowlists and saves it (`packages/server/daemon/server.ts:732`).
- **Daemon behavior:** `presentSession()` (`packages/server/daemon/runtime.ts:103`) skips the WebSocket `session-notify` path and always calls `openBrowser()` when `legacyTabMode` is set.
- **Frontend UI:** code review renders the full-screen `CompletionOverlay` (countdown + close) instead of the inline `CompletionBanner` when in legacy tab mode (`packages/plannotator-code-review/App.tsx:2204` / `:2518`).
- Documented in `CLAUDE.md` under config-only settings.

Verified by reading all five call sites; no remaining work.

---

## ~~3. Live plan updates across deny/replan cycles~~ DONE

Implemented in `feat/session-persistence`. Sessions enter `awaiting-resubmission` status on deny. Agent resubmission is matched by `plan:project:slug` and the session reactivates in place. Frontend receives `session-revision` WebSocket event with updated content.

---

## ~~4. Session persistence after completion~~ DONE

Implemented in `feat/session-persistence`. Denied sessions stay alive (handler not disposed) in `awaiting-resubmission` state with no expiry. Sessions persist until daemon restart.

**Required behavior:**
- Completed sessions stay in the sidebar with a status badge (approved/denied)
- Session content remains viewable (read-only) after a decision
- Sessions do NOT disappear — they move to a "completed" visual state
- If the plan comes back (#3), the session reactivates from this state

**Implementation options:**
- Cache the last plan content before disposal so completed sessions can serve read-only responses
- Or make sessions truly persistent (longer-term, tied to #3)

---

## 5. ~~No browser opens on session creation~~ DONE

Fixed in `99d1aec6`. The daemon now serves the production frontend HTML at `/s/:id`. The CLI's existing `openBrowser()` call opens the daemon URL, which renders the full app. No separate Vite server needed in production.

---

## ~~6. Smart session opening (daemon-driven)~~ DONE

Already implemented: `presentSession()` in `packages/server/daemon/runtime.ts` decides browser-open vs WebSocket notify based on frontend connection state. Toast notifications via `sonner`, TanStack Router navigation, visibility-gated queuing all in place.

Move browser-opening logic from CLI to daemon. The daemon decides what to do based on frontend connection state.

### Three states

| Frontend state | Daemon action |
|---|---|
| No frontend connected | Call `openBrowser("/s/:id")` — new tab, bootstraps the app |
| Frontend connected, on landing page or idle | Send WebSocket navigate event — same tab switches to the session |
| Frontend connected, user is in an active session | Send WebSocket notify event — toast appears, user clicks when ready |

### Notification rules

- **Toast:** Auto-dismissing (5-10s) with a "Go to plan" button
- **Only show when tab is focused:** Check `document.visibilityState`. If tab is backgrounded, queue the notification and show on return to tab
- **Sidebar badge:** Always update, regardless of tab focus. User sees the count when they look

### What needs building

1. **Daemon tracks frontend connections** — WebSocket hub already knows subscribers. Add a `hasFrontendClient()` check.
2. **Frontend reports active session** — Send `{ type: "focus", sessionId }` on navigation changes. Daemon stores this.
3. **Browser opening moves to daemon** — `POST /daemon/sessions` response includes `{ browserAction: "opened" | "navigated" | "notified" }`. CLI removes its `openBrowser()` call.
4. **New WebSocket event types:**
   - `session-navigate` → frontend does `router.navigate("/s/:id")`
   - `session-notify` → frontend shows auto-dismissing toast with action button
5. **Visibility-gated toasts** — Frontend checks `document.hidden` before showing. Queues if backgrounded.

### What we can't do

- Focus an existing browser tab from the server (OS limitation)
- Prevent `open` command from creating a new tab (but we avoid this by not calling `open` when frontend is connected)
- Know if user is looking at the browser vs another app (but `document.visibilityState` covers tab-level focus)

---

## Notify the user when a session updates live

**Priority:** Medium
**Size:** Small

When the agent resubmits (new diff for a review, revised plan, edited file), the content swaps in place via the `session-revision` WebSocket event and the submit buttons reappear — but there's **no visible signal** that the version changed under the user. If they're not staring at the screen, they can miss that the agent pushed a new version.

Add an affordance when a `session-revision` arrives in an already-open session: e.g. a toast ("Agent pushed a new version"), a brief highlight/pulse on the diff, and/or a "what changed" marker. Applies to all three surfaces (code review, plan, annotate). Should respect tab focus (queue/badge if backgrounded) — overlaps with the smart-session-opening notification rules.

---

## Sidebar design (open question)

The sidebar session hierarchy needs rethinking. Currently grouped by mode (plan, review, annotate). Might make more sense grouped by project. Completed sessions should be visually distinct but present — not removed.

**Current issues:**
- Sessions disappear from sidebar after completion (broken)
- Mode-based grouping may get chaotic with many sessions
- No visual distinction between active and completed sessions

**Needs design exploration before implementation.** Tied to #3 and #4.

---

## ~~Migrate AddProjectDialog to Radix Dialog primitive~~ DONE

**Priority:** Low — cosmetic consistency
**Size:** Small

The `AddProjectDialog` hand-rolls its own modal with `fixed inset-0 z-50`, manual backdrop click, and manual Escape handling. Once the shadcn Dialog component exists (created for the unified settings dialog), this should be migrated to use it. The search/typeahead content stays the same — just swap the outer modal wrapper. Eliminates having two different modal implementations in the app.

---

## GitLab custom domain detection — DONE

**Priority:** Medium
**Size:** Medium

DONE: Added `detectPlatformCore(runtime, host)` (`packages/shared/pr-provider.ts`), bound as `detectPlatform(host)` in `packages/server/pr.ts`, mirroring the `checkAuthCore`→`checkPRAuth` pattern. Layered cheap→expensive: host-name fast path (`gitlab`/`github` substrings, no I/O), then for ambiguous custom domains a single `glab auth status --hostname <host>` probe whose success means GitLab. `glab`-absent (ENOENT) and `glab`-unauthed both fall through to the historical github default (no regression). The daemon endpoint (`server.ts`) now calls `await detectPlatform(host)` instead of `host.includes("gitlab")`; the probe runs at most once per 30s per project thanks to the existing per-cwd cache.

The daemon's PR listing endpoint (`packages/server/daemon/server.ts:671`) determines GitHub vs GitLab by checking `host.toLowerCase().includes("gitlab")`. Self-hosted GitLab instances on custom domains (e.g. `code.company.com`) are misidentified as GitHub, so `gh` is invoked instead of `glab`, and PR listing fails silently.

Needs a more robust detection strategy — either try `glab auth status` first, examine the remote URL structure, or let the user configure platform per-project.

---

## ~~PR stack splitting is order-dependent~~ DONE

**Priority:** Low
**Size:** Medium

Fixed by extracting `buildStacks` into a pure module (`apps/frontend/src/components/landing/buildStacks.ts`) and rooting every chain from a leaf (a PR whose head branch is not any other PR's base branch), then walking down toward its base. A leaf-rooted walk captures the full chain in one pass regardless of input order, so multi-PR stacks no longer split into loose PRs depending on API return order.

The grouping is now fully order-independent — every tiebreak is deterministic rather than left to input order: candidate leaves are visited in ascending PR-number order, `byHead` collisions (two PRs on the same head branch, e.g. a merged + open pair from `state=all`) resolve to the open PR then the lower number, and the returned `stacks`/`loose` arrays are sorted (by base PR number and PR number respectively) so independent stacks never swap positions between 30s polls. Forks (two PRs sharing a base) are handled by a deterministic "one child wins" policy rather than full fork collapse: the shared ancestor joins the chain rooted at the lowest-numbered leaf and the sibling leaf falls through to `loose` — the *choice* of which child wins is order-independent, but it is not a merged fork view.

Pinned by a table-driven vitest suite (`buildStacks.test.ts`) asserting that every permutation of the same input yields identical grouping *and* identical output ordering, including 2-cycle, leaf-into-cycle, fork, and duplicate-head edge cases.

The original bug: `buildStacks` walked only downward and marked PRs consumed as it went, so a descendant discovered after its parent chain was built could not attach and was dumped into `loose`. Multi-PR stacks (3+) displayed as loose PRs depending on the order PRs arrived in.

---

## GitLab detailed PRs returns empty — DONE

**Priority:** Medium
**Size:** Medium

DONE: Implemented `fetchGlMRList` and `fetchGlMRDetailedList` (`packages/shared/pr-gitlab.ts`) against the GitLab MR-list API (`projects/:id/merge_requests?per_page=30&state=all`) via the existing `apiArgs`/`parsePaginatedArray` helpers, with exported pure mappers `mapGlMrToListItem`/`mapGlMrToDetailedItem` (unit-tested). `pr-provider.ts` now dispatches GitLab to these instead of returning `[]`. Limitation: GitLab's MR-list endpoint does not return per-MR `additions`/`deletions` (would require ~30 extra API calls), so detailed items set `additions: 0, deletions: 0` and `reviewDecision: ""` (approvals are a separate endpoint, out of scope for v1); everything else (commentCount via `user_notes_count`, updatedAt, isDraft via `draft`/`work_in_progress`, branches, state) is populated.

`packages/shared/pr-provider.ts:129` returns an empty array for GitLab in `fetchPRDetailedList()`. The git dashboard shows "No pull requests found" for GitLab repos even when they have open MRs. The `glab mr list --json` command supports the same fields we need — someone just needs to implement `fetchGlMRDetailedList` following the GitHub pattern.

---

## ~~configStore Zustand migration~~ DONE

Shipped in PR #808 (`12d7bd27`). `packages/ui/config/configStore.ts` is now a `zustand/vanilla` store with selector-based subscriptions (only components reading a changed key re-render), replacing the hand-rolled broadcast-to-all pub-sub. `useConfigValue('key')` API unchanged; cookie persistence + 300ms debounced server sync identical. `AnnotationPanel` passes `isMe` as a prop (memo-safe) and `ReviewSidebar` subscribes to `displayName` directly.

Originally scoped in `goals/performance/backlog/configstore-zustand-migration.md`.

---

## Amp plugin: publish bundled dist for standalone (curl) install

**Priority:** Medium (release-pipeline)
**Size:** Small

`apps/amp-plugin/plannotator.ts` was refactored to a thin wrapper that imports `@plannotator/shared/plugin-client` (PR #816 / merge cleanup). That resolves fine inside the workspace, but a **standalone curl install** of the Amp plugin has no workspace and can't resolve `@plannotator/shared`. The release pipeline must build and publish a **bundled** `apps/amp-plugin/dist/plannotator.ts` (deps inlined) — mirroring how the other curl-distributed plugins ship — so Amp works when installed outside the monorepo. Surfaced by the Amp-conformance verdict; not a merge blocker.

---

## Global keyboard registry cleanup

**Priority:** Medium
**Size:** Large

10+ raw `window.addEventListener('keydown', ...)` handlers across both app surfaces bypass the keyboard shortcut registry that was built in PR #652. These should be consolidated into the registry for consistent handling, conflict detection, and the help modal.

Scoped in `goals/performance/backlog/global-keyboard-registry.md`.

---

## ~~14. Daemon starts on install~~ DONE

Install scripts (`scripts/install.sh` and `scripts/install.ps1`) now start the daemon in the background after placing the binary. The CLI's `ensureDaemonClient({ bestEffort: true })` serves as a safety net if the daemon dies.
