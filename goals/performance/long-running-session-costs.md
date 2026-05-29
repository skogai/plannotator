# The Cost of Long-Running Sessions (UI rendering)

> Investigation, 2026-05-29. "Sessions never die" (they suspend/idle and stay alive
> until cancel or daemon restart) — this documents what that costs in the frontend,
> what the current optimizations cover, and where it breaks. Reconciles with
> `./findings.md`. Read-only audit; cites file:line.

## The core model (and its assumption)

Every session you **visit** is added to `appStore.visitedSessions` and rendered as a
**permanently-mounted** panel in `Layout.tsx:67-83` — switching sessions only toggles
`visibility`/`contentVisibility`, it never unmounts. `appStore.removeSession()` exists
but is **never called anywhere** (`s.$sessionId.tsx:22-32` only ever *adds*). There is
**no eviction, LRU, or cap.**

So the frontend was built assuming sessions are **few and transient**. The single-server
"sessions never die" model violates that: open N sessions over a daemon's lifetime → N
heavy surfaces (code-review diff viewers, plan editors) stay mounted simultaneously,
forever, until a page reload.

## What holds up (and to what scale)

These keep the **active** session and **switching** cheap:

- **`SessionSurface` is `React.memo`'d** (`SessionSurface.tsx:21`) + Layout uses
  selector-based Zustand — switching active session doesn't re-render the others.
- **`contentVisibility: hidden` + `containIntrinsicSize`** on inactive panels
  (`Layout.tsx:75`) — the browser skips *paint/layout* for hidden sessions (big win;
  only the active session pays render cost).
- **Code-review Zustand store** (annotations/files/diff-options slices) + selector
  subscriptions + `FileTreeNodeItem` memo — the active code-review surface is the
  optimized one.
- **Daemon-shell stores** (app/project/event/git-dashboard) are selector-based, so
  unrelated updates don't cascade.

**Verdict: fine at 1–2 sessions, OK at 3–5.** Beyond that the structural gaps dominate.

## What fails as sessions accumulate

**1. Memory / DOM grows unbounded (no eviction).**
Each mounted surface is ~5–20 MB and tens of thousands of DOM nodes; nothing tears them
down. Worse, within a code-review session, Pierre diffs **never unmount once viewed**
(`LazyFileDiff` sets `mounted=true`, never false; findings #16) and the file tree isn't
virtualized — so a 50-file review keeps ~50 diff trees in the DOM, per session. N
sessions stack: ~5–10 MB added per session opened, never reclaimed.

**2. Every hidden session keeps doing work (pollers/subscriptions/listeners).**
`contentVisibility` stops *painting* but not *JS*. Each mounted session keeps running,
even when hidden:
- 3–4 daemon WS subscriptions (external-annotations, agent-jobs, session-revision) each
  with a **2s HTTP polling fallback** (`useDaemonSessionTransport.ts`, `useExternalAnnotations.ts:21`, `useAgentJobs.ts:20`);
- a 500ms draft-autosave debounce when there are edits;
- global `keydown` listeners (`code-review App.tsx:734`, `plan App.tsx:842`) — every
  keystroke fires on all K sessions;
- MutationObserver / ResizeObserver / IntersectionObserver per session;
- `configStore.listeners` grows ~O(15·N) and never shrinks.
- The `useSessionVisible()` signal exists but is **only used for `document.title`** — it
  does **not** gate any of the above. So K hidden sessions = K× pollers + listeners
  running. Idle CPU creeps up (~15–25% at 5–10 sessions).

**3. List churn: every session event re-renders everything, unvirtualized.**
`event-store.ts:67-71` replaces the `sessions` array on **every** `session-updated`
(status flips, `updatedAt` bumps). That re-runs the sidebar's `buildSessionTree`
(`AppSidebar.tsx:185`) and re-renders the whole tree + the conjoined sessions/history
lists — **none are virtualized**. With many live sessions emitting events, this is
repeated full-array work per event.

**4. The App monoliths still reconcile on hot paths.**
Code-review `App.tsx` (~2600 lines) keeps hot-path state in `useState` (split-drag,
all-files scroll) that fires ~60×/sec during drag/scroll → full App reconcile;
`ReviewSidebar`'s memo is **commented out**. `contentVisibility` skips *rendering* the
hidden sessions but not React's *reconciliation* of the active monolith. Plan-review is
even less optimized (largely `useState`).

**5. 19 MB single-file bundle, zero code-splitting.**
`vite.config.ts` (`viteSingleFile` + `inlineDynamicImports` + `cssCodeSplit:false`) →
one ~19 MB artifact: both apps, highlight.js, @pierre/diffs, dockview, mermaid, viz.js,
50+ theme CSS, all fonts base64-inlined. No `React.lazy`. Parsed/compiled up front,
resident per tab regardless of how many sessions or which mode is active.

## Survivability estimate

| Sessions | Behavior |
|---|---|
| 1–2 | Fully fine. |
| 3–5 | OK — `contentVisibility` + memo + selectors carry it; active session ~60fps. |
| 5–10 | **Degraded** — ~100–150 MB, idle CPU ~15–25% (pollers), occasional scroll/drag jank. |
| 10+ | **Fails** — 200 MB+, GC pauses (100–200ms), <20fps interaction; user closes tabs or it crashes. |

## Reconciliation with findings.md

This isn't new debt — it's the **same** open items in `findings.md`, **amplified** by the
never-die model (they go from "one session degrades over time" → "N sessions stack"):
- Tier 1: SessionSurface memo (fixed) + contentVisibility (mitigates DOM weight) + the
  App.tsx monolith (#3, **open**).
- Tier 3: scroll/resize re-renders, per-file observers (**open**).
- Tier 5: unbounded growth — Maps never purged, pollers/listeners accumulate (#26–#30,
  **open**) — this is the one the session model makes acute.
- Tier 6: no code-splitting, eager mermaid/viz.js (#31–#37, **open**).

## What would make it survivable (priority order)

1. **Evict / cap mounted sessions** — keep only the active + a small recent set mounted;
   unmount the rest (re-mount on revisit from bootstrap). The single highest-leverage fix
   for the never-die model; directly bounds 1, 2, and the DOM side of 4.
2. **Gate per-session work on visibility** — thread `useSessionVisible()` into the
   subscription/poller hooks so hidden sessions pause (kills the K× pollers/listeners).
3. **Virtualize** the file tree, the diff list, and the session/history lists.
4. **De-monolith the App hot paths** — move split-drag/scroll state into the store with
   selectors; re-enable the `ReviewSidebar` memo.
5. **Code-split** — lazy-load code-review vs plan-review; defer mermaid/viz.js.

Note: the daemon/AI layer already evicts idle sessions server-side
(`packages/ai/session-manager.ts`); the **frontend has no equivalent** — that's the gap.
