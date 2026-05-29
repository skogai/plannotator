# Performance Findings — Multi-Session Frontend

Comprehensive sweep of performance killers in the multi-session keep-alive architecture. The app feels generally slow with 3+ sessions open — not during specific actions, but during normal use: scrolling, clicking files, hovering, navigating.

> [!NOTE]
> **Status — re-inventoried 2026-05-28 against HEAD `6e65aa37` (post main-merge): 8 fixed · 2 partial · 29 open.**
> The cross-session-interference tier (hidden sessions corrupting the active one) is largely resolved; the heavy *structural* work remains and is the biggest lever left on perceived speed.
>
> - **Fixed (8):** #1 SessionSurface memoized · #6 StickyHeaderLane scoped to container · #7 CSS-property writes scoped to session root · #10 PlanCleanDiffView scoped · #11 TableOfContents scoped · #12 `document.title` visibility-guarded · #24 + #30 configStore → Zustand selectors (PR #808).
> - **Partial (2):** #8 ThemeProvider still writes global `document` theme classes · #18 split-drag has a ref cache but still `setState`s per pointermove.
> - **Open (29):** #2 #3 #4 #5 #9 #13 #14 #15 #16 #17 #19 #20 #21 #22 #23 #25 #26 #27 #28 #29 #31 #32 #33 #34 #35 #36 #37 #38 #39.
>   Headliners: **#31** zero code-splitting (18MB single-file), **#5** sessions never evicted, **#3/#4/#39** App.tsx monolith + `ReviewSidebar` memo still commented out + no memo boundaries, **#16** Pierre diffs never unmount, **#32** mermaid/viz.js eagerly imported, **#33/#34** inlined fonts + all-themes CSS, **#26–#29** unpurged Maps / uncancelled rAF / per-hidden-session pollers, **#36** two WebSocket connections.
>
> Per-finding detail below is the original sweep (kept as the reference). The global-keyboard-registry item (`backlog/global-keyboard-registry.md`) folds into this work.

## Tier 1 — Causes general sluggishness during normal use

### 1. SessionSurface is not memoized

`apps/frontend/src/components/sessions/SessionSurface.tsx` is a plain function component with no `React.memo` wrapper. It's rendered inside `Layout.tsx`'s `Object.values(visitedSessions).map(...)`.

Every time Layout re-renders — sidebar toggle, session switch, dialog open/close, `addProjectOpen` changing — React walks the ENTIRE component tree of EVERY mounted session. Layout re-renders frequently because it subscribes to `activeSessionId`, `visitedSessions`, `addProjectOpen`, and `useSidebar()` (context).

With 3 sessions mounted: every sidebar toggle triggers 3 full code-review tree reconciliations.

### 2. DOM weight with visibility:hidden

Each code review session produces 20,000–40,000 DOM nodes (header, file tree, dockview, Pierre diffs, sidebar, modals). Pierre diffs mount lazily but never unmount — `LazyFileDiff` sets `mounted = true` but never resets to `false`. Once a user scrolls through 50 files, all 50 diff trees stay in the DOM permanently.

With 3 sessions: 60,000–120,000 nodes in the layout tree.

`visibility: hidden` hides pixels but the browser still computes layout for every hidden node on every style recalculation. The global `* { transition-property: ... }` rule in `theme.css` forces CSS selector matching against all 100k+ nodes on every style invalidation, even though `transition-duration: 0s` is applied to hidden subtrees.

`content-visibility: hidden` would tell the browser to skip layout AND style recalculation entirely on hidden subtrees. Currently not used.

### 3. 57 useState in App.tsx — the monolith re-renders on every interaction

`packages/plannotator-code-review/App.tsx` has 57 `useState` calls. ANY state change re-renders the entire 2500-line component. This includes:
- `allFilesVisibleFile` — set on file-boundary crossings while scrolling diffs (line 1425)
- `splitRatio` — set on every pointer pixel during split handle drag
- `isAllFilesActive` / `isDiffPanelActive` — set on every dockview panel focus change

Every one of these state changes cascades to the unmemoized `ReviewSidebar` and all other children.

### 4. ReviewSidebar has React.memo explicitly commented out

`packages/plannotator-code-review/components/ReviewSidebar.tsx` line 108 — `/* React.memo */` is commented out. ReviewSidebar is a child of the 2500-line App.tsx. Every one of App's 57 state changes triggers a ReviewSidebar reconciliation.

### 5. Sessions are never evicted from visitedSessions

`apps/frontend/src/stores/app-store.ts` — `removeSession` is defined but never called anywhere in the codebase. Sessions only accumulate. A user who opens 10 sessions over a working day has 10 full React trees mounted with ~200,000+ DOM nodes.

## Tier 2 — Cross-session interference (hidden sessions degrading active session)

### 6. StickyHeaderLane uses unscoped document.querySelector

`packages/ui/components/StickyHeaderLane.tsx` line 148 — queries `document.querySelector('[data-sticky-actions]')` with no container scoping. With 3 sessions, each StickyHeaderLane finds the FIRST matching element in the document — which belongs to a DIFFERENT session. It then attaches a ResizeObserver to that foreign element. Hidden sessions observe the active session's DOM nodes, firing N-1 extra ResizeObserver callbacks on every layout change.

### 7. CSS custom property stomping from hidden sessions

`packages/plannotator-code-review/App.tsx` line 170 — sets `document.documentElement.style.setProperty('--diffs-font-family', ...)` etc. when config changes. All sessions write to the same `:root` element. Each `setProperty` invalidates every CSS rule referencing those variables — full global style recalculation across the entire 60k-120k node document.

### 8. ThemeProvider race on document.documentElement.classList

`packages/ui/components/ThemeProvider.tsx` lines 44-57 — every session mounts its own ThemeProvider that strips and re-adds `theme-*` classes on `document.documentElement`. Three ThemeProviders racing to control the document class list. Each write triggers a full-document style recalculation.

### 9. Hidden session paste handlers eat clipboard events

`packages/editor/App.tsx` line 930 — unguarded `document.addEventListener('paste')` in every session. Hidden sessions call `e.preventDefault()` on image pastes, which suppresses the paste from reaching the active session. User's paste gets silently eaten.

### 10. PlanCleanDiffView uses unscoped querySelector + scrollIntoView

`packages/ui/components/plan-diff/PlanCleanDiffView.tsx` lines 103-107 — `document.querySelector('[data-diff-block-index]')` finds elements from ANY session. A hidden session's annotation event can add highlight classes and call `scrollIntoView` on the ACTIVE session's DOM — causing phantom scroll jumps.

### 11. TableOfContents uses unscoped querySelector

`packages/ui/components/TableOfContents.tsx` line 175 — `document.querySelector('[data-block-id="..."]')` finds the first matching element globally. Hidden session TOC clicks scroll the active session's content.

### 12. Hidden session document.title mutation

`packages/plannotator-code-review/App.tsx` line 225 — `useEffect` sets `document.title` on `repoInfo` change with no visibility guard. Hidden sessions overwrite the visible session's title.

### 13. useAnnotationHighlighter capture-phase mouseup in every session

`packages/ui/hooks/useAnnotationHighlighter.ts` line 99 — `document.addEventListener('mouseup', track, true)` with capture phase. All sessions register. Every click fires N capture-phase callbacks. Low per-call cost but adds up.

## Tier 3 — Component-level inefficiencies (within a single session)

### 14. ScrollFade double setState on every scroll tick

`packages/plannotator-code-review/components/ScrollFade.tsx` — calls `setShowTop` and `setShowBottom` on its scroll handler with no equality guard. Every scroll event triggers 2 state updates, re-rendering the file tree panel ~60 times per second while scrolling.

### 15. FileHeader ResizeObserver per file

`packages/plannotator-code-review/components/FileHeader.tsx` line 71 — each file header creates its own `ResizeObserver` that calls `setHeaderWidth`. During window resize, N observers fire N `setState` calls simultaneously. No quantization.

### 16. Pierre diffs never unmount

`packages/plannotator-code-review/components/LazyFileDiff.tsx` — `mounted` state is only ever set to `true`, never back to `false`. Once a file diff is mounted by IntersectionObserver, it stays in the DOM permanently. Node count is monotonically increasing per session throughout its lifetime.

### 17. allFilesVisibleFile scroll handler re-renders entire App

`packages/plannotator-code-review/App.tsx` line 1425 — `setAllFilesVisibleFile` called from scroll handler on file-boundary crossings. Each call re-renders the entire 2500-line App component.

### 18. splitRatio setState on every pointer move

`packages/plannotator-code-review/components/DiffViewer.tsx` — `setSplitRatio` fires on every `pointermove` while dragging the split handle. DiffViewer is not wrapped in `React.memo`.

### 19. AllFilesDiffView: getBoundingClientRect loop on every scroll tick

`packages/plannotator-code-review/components/AllFilesDiffView.tsx` lines 203-226 — the scroll handler loops through ALL expanded files calling `header.getBoundingClientRect()` on each one, synchronously, on every scroll event. With 50 files expanded, that's 50 forced layout reads per scroll tick. Each `getBoundingClientRect()` forces the browser to flush pending layout. This is layout thrashing — reading layout, potentially writing, reading again — at 60fps scroll rate.

### 20. reviewStateValue context invalidates on every line click

`packages/plannotator-code-review/App.tsx` line 1371 — `pendingSelection` is in the `reviewStateValue` useMemo dependency array. `pendingSelection` changes on every diff line click. Since `reviewStateValue` is the `ReviewStateContext.Provider` value, every line click invalidates the context and re-renders ALL dock panels (all-files, code-nav, PR comments, agents) — even panels that don't use `pendingSelection`.

### 21. getComputedStyle called 4-5 times per keypress across sessions

`packages/plannotator-code-review/App.tsx` lines 645, 712, 1085, 1688, 1721 — `isVisible()` calls `getComputedStyle(rootRef.current).visibility` as a guard. Each `getComputedStyle()` forces synchronous style recalculation. With 3 sessions × 4 handlers = 12 forced style recalcs per keystroke. Especially bad when typing in annotation inputs.

### 22. useActiveSection quad-threshold IntersectionObserver

`packages/ui/hooks/useActiveSection.ts` — configured with `threshold: [0, 0.1, 0.5, 1.0]`. Each heading fires up to 4 callbacks per scroll crossing, each calling `setActiveId` with no equality guard.

### 23. ToolbarHost global mousemove

`packages/plannotator-code-review/components/ToolbarHost.tsx` line 92 — `window.addEventListener('mousemove', handleMouseMove)` with no visibility guard. Every mouse movement fires a callback in every mounted session. Handler only writes to a ref (no re-render), but N function calls per mouse move.

## Tier 4 — Fires intermittently (settings/theme changes only)

### 24. configStore broadcasts to all subscribers

`packages/ui/config/configStore.ts` — `notify()` calls every listener on ANY setting change. 14 `useConfigValue` calls per session × N sessions. Only fires when user changes a setting — not during normal use.

### 25. ThemeProvider context re-renders all useTheme consumers

Only fires on theme change. Per session: `usePierreTheme`, `DiffHunkPreview`, `ReviewHeaderMenu` — 3 components × N sessions.

## Tier 5 — Memory leaks and unbounded growth

### 26. Module-level draft Maps never purged

`packages/plannotator-code-review/hooks/useAnnotationToolbar.ts` lines 47-48 — `draftStore` and `restoreDraftKeyByFilePath` are module-level `Map` singletons. Keyed by `"filePath:side:start-end"`. Entries are only removed on explicit submit/cancel — never on file abandon or session hide. With large PRs and repeated sessions, both Maps grow without bound across the page lifetime.

### 27. usePierreTheme fires uncancelled requestAnimationFrame

`packages/plannotator-code-review/hooks/usePierreTheme.ts` lines 177-283 — `useEffect` schedules `requestAnimationFrame` with no cleanup return. The rAF ID is not stored, so it cannot be cancelled on unmount or dep change. Each dep change (theme toggle, font change) fires a new rAF without cancelling the previous. With N sessions, N rAF callbacks are in-flight simultaneously on every theme change.

### 28. WebSocket subscriptions and pollers accumulate per hidden session

`packages/ui/hooks/useExternalAnnotations.ts` and `packages/ui/hooks/useAgentJobs.ts` — each delegates to `useDaemonSessionTransport`, which subscribes to the WebSocket hub and starts a 2-second polling fallback when disconnected. Cleanup only fires on unmount. Since hidden sessions never unmount, N sessions = N active subscriptions + up to N concurrent `setInterval` timers if WebSocket drops.

### 29. useEditorAnnotations 500ms poller per hidden session (VS Code only)

`packages/ui/hooks/useEditorAnnotations.ts` line 45 — when `IS_VSCODE` is true, every mounted session starts a `setInterval(..., 500)` fetching `/api/editor-annotations`. Hidden sessions keep polling. N sessions = N separate 500ms pollers.

### 30. configStore.listeners grows with hidden sessions

`packages/ui/config/configStore.ts` — `useSyncExternalStore` subscribers are only removed on unmount. Hidden sessions never unmount. With ~15 `useConfigValue` calls per session × N sessions, the listener Set grows to O(15N) and never shrinks during the page lifetime.

## Tier 6 — Build and architecture (affects every user, every load)

### 31. Zero code splitting — 18.4MB single-file bundle

`apps/frontend/vite.config.ts` — `vite-plugin-singlefile` + `inlineDynamicImports: true` forces the entire app into one file. Both full App components (~4800 lines combined), `@pierre/diffs`, `highlight.js`, `motion`, `dockview-react`, mermaid, viz.js, all Radix primitives, all CSS — everything loads on first page load. No lazy loading of any kind. The browser parses and JIT-compiles the entire bundle before anything renders.

### 32. Mermaid and viz.js statically imported at module level

`packages/ui/components/MermaidBlock.tsx` line 6 — `mermaid.initialize({...})` runs at module import time. `packages/ui/components/GraphvizBlock.tsx` line 3 — `@viz-js/viz` (1.4MB, contains WASM Graphviz) is statically imported. Both load for every user even if they never see a diagram. These could be `React.lazy()` + dynamic `import()`.

### 33. 361KB of base64-inlined fonts (all unicode ranges)

`apps/frontend/src/styles.css` — `@fontsource-variable/inter` loads 7 unicode-range `@font-face` rules (Cyrillic, Greek, Vietnamese, Latin-ext, Latin, etc.). With `viteSingleFile`, all 10 woff2 files are base64-inlined. 361KB of font data that the browser can't skip. Using Latin-only would eliminate ~300KB.

### 34. 198KB of theme CSS loaded for all 50+ themes

All theme definitions load at startup even though only one is active. No per-theme splitting.

### 35. Persistent backdrop-blur on always-visible panels

`AnnotationPanel`, `AnnotationSidebar`, `TableOfContents`, `StickyHeaderLane` all have `backdrop-blur-sm`. This triggers GPU compositing on the blur filter, which is expensive whenever anything behind those panels changes (scrolling, animations). These are not overlays — they're permanent UI panels.

### 36. Two separate WebSocket connections to /daemon/ws

`UiDaemonHubClient` (packages/ui/utils/daemonHub.ts) and `DaemonHubClient` (apps/frontend/src/daemon/events/hub-client.ts) are completely independent clients connecting to the same endpoint. Two TCP connections with separate reconnect timers. Could be one multiplexed connection.

### 37. 29+ OverlayScrollbars instances with ResizeObserver each

Used in FileTree, DiffViewer, ReviewSidebar, AITab, PRCommentsTab, LiveLogViewer, TourDialog, Settings, AnnotationPanel, Viewer, TableOfContents, and more. Each instance has its own ResizeObserver. With keep-alive sessions, all instances across all sessions stay alive.

### 38. getComputedStyle in useState initializer blocks first render

`packages/plannotator-code-review/hooks/usePierreTheme.ts` line 160 — `getComputedStyle(document.documentElement)` in a `useState` lazy initializer forces synchronous style recalculation during the first render of every code review session mount.

### 39. Monolithic App components (~2500 lines) with no memo boundaries

Both `plannotator-code-review/App.tsx` and `plannotator-plan-review/App.tsx` are single giant components. All state, hooks, and render logic in one function. Any state update — even minor ones like `setCopyFeedback` — triggers reconciliation over the entire tree. No `React.memo` boundaries to stop propagation. Dockview, file tree, diff viewer, sidebar, AI chat all re-check props on every update.

## What's NOT Causing It

- **Polling/transport hooks** — WebSocket is connected, no timers running when idle
- **Keyboard handlers** — already guarded with `isVisible()`, microsecond no-ops per keystroke
- **requestAnimationFrame loops** — none exist, all one-shot
- **Agent job processing** — only fires when jobs are actually running
