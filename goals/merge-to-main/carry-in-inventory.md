# Merge `main` → `feat/single-server-runtime`: Carry-In Inventory

The checklist for merging `main` into the stack (PR #733) **without silently dropping main's work**.

## Situation

- **Fork point:** `82636e12` (2026-05-18). Since then: **main +35 commits, our branch +19.**
- The merge has two conflict shapes: (A) files we *deleted* that main *edited*, and (B) files we *both* edited. But the **real risk is invisible** — see the warning below.

> [!CAUTION]
> **The dangerous carry-ins won't show up as merge conflicts.** Three of main's changes (#763, #795, #792) lived in code we **deleted or never had**, so `git merge` will complete "cleanly" and silently leave them out. A green merge ≠ a complete merge. This inventory is the guard against that.

## Do NOT rename folders to ease the merge

The old→new dirs are **replacements, not renames** (`packages/editor` ≠ `packages/plannotator-plan-review` — different code, same job). Renaming our new code into the old paths would convert clean "keep-deleted" resolutions into ~100 file-by-file content conflicts. The conflicts are not a naming problem.

| Only on main | Only on our branch |
|---|---|
| `packages/editor`, `packages/review-editor`, `apps/review` | `apps/frontend`, `packages/plannotator-plan-review`, `packages/plannotator-code-review` |
| `apps/amp-plugin`, `apps/droid-plugin`, `apps/waitlist-service` (additive) | |

---

## Class 1 — fix is in a file we KEPT → take main's hunk (all confirmed missing on our side)

- [ ] **#805 `9b545d12`** — `apps/pi-extension/index.ts` (~L945): replace `setTimeout(() => pi.sendUserMessage("Continue with the approved plan."), 0)` with `pi.sendUserMessage("Continue with the approved plan.", { deliverAs: "followUp" })`.
- [ ] **#756 `42c85f0a`** — `packages/server/browser.ts`: add `NOOP_BROWSER_VALUES` + exported `isNoOpBrowserSentinel()`; rewrite `shouldTryRemoteBrowserFallback()` to treat sentinels (`true`/`false`/`none`/`:`/`0`/`1`) as unset; strip sentinels in `openBrowser()` before using `PLANNOTATOR_BROWSER`/`BROWSER`. + `browser.test.ts`.
- [ ] **#786 `5438f664`** — `apps/hook/server/session-log.ts`: resolve `DEFAULT_SESSIONS_DIR`/`DEFAULT_PROJECTS_DIR` from `CLAUDE_CONFIG_DIR` (fallback `~/.claude`); add `projectsDirOverride?` to `findSessionLogsByAncestorWalk` and thread it through. + test isolation.
- [ ] **#743 `29390c9e`** — `apps/opencode-plugin/index.ts`: `getPlanBackingPath(project)` → `~/.plannotator/active/{project}/_active-plan.md` (was `directory/.opencode/plans/`); add `homedir`/`sanitizeTag`/`unlinkSync` imports; `unlinkSync` the backing file on approval. + tests.
- [ ] **#752 `b3f1deb8`** — `apps/opencode-plugin/index.ts` `validateEdits`: `if (edit.end > lineCount)` → `if (edit.end > lineCount && lineCount > 0)`. + test.
- [ ] **#796 `92efe6fd`** — `packages/ui/utils/permissionMode.ts`: add `'auto'` to the `PermissionMode` union, the `PERMISSION_MODE_OPTIONS` array (label "Auto Mode"), and the comment. (UI iterates the array dynamically — no component changes.)

## Class 2 — code we DELETED/REPLACED → hand-port (WON'T appear as conflicts)

- [ ] **#763 `2a552869` — Ask AI in plan & annotate** *(largest)*. Infra in `packages/ai` is **already present** (`AIContextMode` has `plan-review`/`annotate`; `buildSystemPrompt` has both branches). Missing:
  - **Server:** mount `createAIEndpoints` + `ProviderRegistry` + `SessionManager` and `/api/ai/*` in `packages/server/index.ts` (plan) and `packages/server/annotate.ts`, mirroring `packages/server/review.ts` (~L48, L356-396), with `mode: "plan-review"` / `"annotate"`.
  - **Frontend:** build a shared document AI chat panel + `useAIChat` in `packages/ui` (adapt from `packages/plannotator-code-review/hooks/useAIChat.ts` + `AITab.tsx`); wire into `packages/plannotator-plan-review/App.tsx` + the annotate surface; add "Ask AI" to `packages/ui/components/CommentPopover.tsx` + `Viewer.tsx`; feed `aiProviders` from `/api/ai/capabilities` into `Settings`.
  - Note: `AISetupDialog.tsx`/`AISettingsTab.tsx` on our branch are stale pre-#763 leftovers.
- [ ] **#795 `e0aee745` — `PLANNOTATOR_DATA_DIR`**. Recreate `packages/shared/data-dir.ts` (`getPlannotatorDataDir()` with `~` expansion + relative→absolute) and add `./data-dir` export to `packages/shared/package.json`. Replace hardcoded `join(homedir(), ".plannotator", …)` in:
  - shared: `storage.ts` (6), `config.ts` (1 `CONFIG_DIR`), `draft.ts` (1), `improvement-hooks.ts` (2), `pr-gitlab.ts` (1)
  - server: `browser.ts` (IPC registry), `codex-review.ts` (3), `sessions.ts` (1), `tour/tour-review.ts` (1)
  - **daemon (new files #795 never saw):** `daemon/state.ts:76`, `daemon/session-store.ts:65` (`SNAPSHOT_DIR`), `daemon/project-registry.ts:12`, `daemon/server.ts:570` (`historyRoot`) — wire `getPlannotatorDataDir()` as the daemon `baseDir` default and thread it through.
  - Re-apply the extension/vendor/install-script/docs bits as relevant.
- [ ] **#792 `7db5e9b8` — Windows Pi shim**. Add `packages/ai/providers/command-path.ts` (`resolveWindowsCommandShim`, `buildWindowsCommandScriptSpawnCommand`, `killWindowsProcessTree`, `resolveCommandFromWhichOutput`, `shouldSpawnViaShell`); reapply the `pi-sdk.ts` + `pi-sdk-node.ts` spawn/`handleProcessEnd`/`kill` diffs (both files still exist on our side); add `./providers/command-path` export to `packages/ai/package.json`; wrap the pi path in `packages/server/review.ts` (~L394) with `resolveWindowsCommandShim(Bun.which("pi"))`.
  - `vendor.sh` part: **N/A** (our vendor.sh no longer vendors `packages/ai/providers/*`). CI Windows smoke job: **obsolete** (targeted the deleted Pi server).

## Class 3 — new integrations (merge adds the dir; then adapt)

- [ ] **#787 `4de62e83` — Droid**. Lands cleanly (new dir, never on our branch; thin-wrapper compatible). **DROP** `apps/droid-plugin/commands/plannotator-archive.js` + its references in `.factory-plugin/plugin.json`/README/marketplace (archive subcommand is removed). **TAKE** the droid entries in `packages/shared/agents.ts` / `config.ts` / `prompts.ts` (else the `droid` origin is unrecognized). The other commands (annotate/last/review) map to live subcommands.
- [ ] **#803 `8c947c54` (+ #810/#811/#812) — Amp**. Lands cleanly (new dir) but **won't work as-is**: Amp waits on `PLANNOTATOR_READY_FILE`, which our daemon never writes → local Amp sessions hang/error. Decide: (1) make the daemon write the ready-file on the direct-CLI path, or (2) refactor Amp onto our `plugin-client.ts`/`plugin-protocol.ts`. Verify its edits to `apps/hook/server/index.ts` + `packages/server/shared-handlers.ts` merge cleanly. (Amp treats runs as one-shot — doesn't use the persistent/`awaiting-resubmission` model; acceptable.)

## Class 4 — noise → auto-merge, no action

~18 commits: `/workspaces/` theming, the waitlist service (`apps/waitlist-service`), marketing/Nav/Turnstile/OSS-checkbox/copy tweaks, version bumps. `git merge` handles these; just confirm they land.

---

## Suggested merge sequence

1. **Work on a throwaway branch**, not the shared one: `git checkout -b merge/main-into-ssr feat/single-server-runtime` then `git merge origin/main`.
2. **Old folders** (delete/modify) → keep deleted: `git rm` `packages/editor`, `packages/review-editor`, `apps/pi-extension/server/*`. Their *intent* is captured in Class 2, not by keeping the files.
3. **Class-1 both-modified files** → take main's version / apply the listed hunks.
4. **Config/manifests/lock** (`package.json`, two `plugin.json`, `openpackage.yml`, opencode/pi `package.json`, `.gitignore`, `AGENTS.md`) → union both sides; **regenerate `bun.lock` with `bun install`** (don't hand-merge the lock).
5. **Amp / Droid / waitlist** come in additively → then apply the Droid drop-archive + shared droid entries; park Amp ready-file compat as a follow-up.
6. **Hand-port the three Class-2 items** (#763, #795, #792) — the part a clean merge silently skips.
7. `bun run typecheck` + `bun test` + frontend build. Then **manually verify** Ask-AI-in-plan/annotate, `PLANNOTATOR_DATA_DIR`, and Windows shim actually work.
8. Only after green: merge the reconciled result back and open/refresh PR #733.

## Provenance

Inventory produced by a 10-agent read-only analysis pass (one per substantive main commit), 2026-05-28. Class-1 verified via direct file comparison; Class-2/3 via commit-diff + new-architecture cross-reference.
