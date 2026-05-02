# Slice 2 — Features

## Goal

Ship three user-facing features on top of the foundation from Slice 1: Ask AI in plan review, the OpenCode double-spawn fix (#513), and prompt cache keepalive (#417).

Each feature depends on Slice 1's infrastructure (the resolver, the snapshot+tail SSE pattern, the cookie-persisted session, the context badge). None depend on each other — they can land in any order within Slice 2, or even in parallel.

## What this slice ships

### 1. Plan-mode Ask AI

Bring the same chat experience from code review to plan review. The server-side infrastructure is already partially in place — `packages/ai/types.ts:31-40` defines a `plan-review` context mode and `packages/ai/context.ts` can build plan-review system prompts. The plan review server (`packages/server/index.ts`) does not include the AI endpoints today — only the code review server does. And the plan editor has no chat UI entry point.

**Changes:**
1. **Server:** Wire the same AI endpoint handlers (`/api/ai/session`, `/api/ai/query`, `/api/ai/abort`, `/api/ai/permission`, `/api/ai/sessions`, `/api/ai/capabilities`) into the plan review server at `packages/server/index.ts`. Same handler functions, different server instance.
2. **UI:** Add a right-side AI panel to the plan editor, mirroring the code review `AITab`. Same components: chat area, model/provider picker, context badge, collapsed maintenance rows. The panel opens from a button in the toolbar, collapsible.
3. **Resolver integration:** The plan review server receives the same launch context (Claude session id from hook, OpenCode session id, Pi session id, etc.) and runs the same `resolveChatContext()` function. All resolver behavior is shared.
4. **System prompt:** `context.ts` already builds plan-mode prompts with the plan content. Verify it includes enough context (the full plan markdown, annotation anchors if the user is annotating) and adjust if needed.
5. **Single session per plan review:** Same decision as code review — one conversation for the entire plan review surface. Users asking about specific sections have their selection injected as per-turn context ("the user is asking about this section: ...").

**Key files:**
- Modified: `packages/server/index.ts` (wire AI endpoints into plan server)
- New: `packages/editor/components/AIPanel.tsx` or similar (right-side panel, reuses `useAIChat` hook)
- Modified: `packages/editor/App.tsx` (layout change to accommodate the right-side panel, toolbar button)
- Existing: `packages/ai/context.ts` (plan-review system prompt — verify and adjust)
- Existing: `packages/ai/endpoints.ts` (no change needed — same handlers)

**Acceptance criteria:**
- [ ] Plan review has an AI chat panel in a right-side panel, visually consistent with code review.
- [ ] The chat works with every provider that works in code review (Claude, Codex, Pi, OpenCode).
- [ ] The context badge shows the correct resolved strategy (same Matrix 3 logic).
- [ ] Chat survives browser refresh in plan review (same cookie + snapshot mechanism).
- [ ] Plan content is included in the system prompt context.

### 2. OpenCode #513 — probe and attach instead of double-spawning

**The bug:** When the user already has an `opencode serve` or `opencode --port` process running, Plannotator's OpenCode adapter (`packages/ai/providers/opencode-sdk.ts:78`) always calls `createOpencodeServer()` and spawns a second server. This wastes memory and can cause port conflicts.

**How OpenCode works:** OpenCode is the only harness that optionally runs as an HTTP server. A single server holds many sessions. The canonical persistent server command is `opencode serve --hostname 127.0.0.1 --port <port>` (`packages/opencode/src/cli/cmd/serve.ts:9`); `opencode --port` / TUI with network flags also exposes a server when the user is actively using the TUI. The server exposes a full session API (list, get, fork, message).

**Fix:**
1. Before spawning, probe the configured port (default 4096, configurable via a provider setting stored in cookies alongside the model preference).
2. Probe endpoint: `GET /global/health` → returns `{ healthy: true, version }` on success (`packages/opencode/src/server/instance/global.ts:74`). Do not probe `/session` or other resource endpoints.
3. If the probe succeeds, attach via `createOpencodeClient({ baseUrl, directory })`. Pass the `directory` (or `experimental_workspaceID`) explicitly; otherwise the server may run operations under the request's default instance context (`packages/opencode/src/server/instance/middleware.ts:54`).
4. If `OPENCODE_SERVER_PASSWORD` is set in the user's environment, the server requires Basic auth on every request (`packages/opencode/src/server/middleware.ts:39`). Read the env var and pass the credential to `createOpencodeClient`. If the env var is unset, no auth needed.
5. If the probe fails (connection refused, timeout, non-2xx), fall back to `createOpencodeServer()` as today.
6. No new UI. The chat just uses the attached server as its provider. Any session we create lives in the user's existing server, so they can see it in their OpenCode TUI too.

**Key files:**
- Modified: `packages/ai/providers/opencode-sdk.ts` (probe logic before `createOpencodeServer()`, ~30-40 lines)
- Existing: `packages/ui/utils/storage.ts` (port config stored in cookies, similar to model preference)

**Acceptance criteria:**
- [ ] With an OpenCode server already running on the configured port, Plannotator attaches to it without spawning a second process.
- [ ] `GET /global/health` probe succeeds against a running `opencode serve` and a running `opencode --port` TUI instance.
- [ ] If `OPENCODE_SERVER_PASSWORD` is set, Plannotator authenticates successfully against the running server.
- [ ] Without a running server, Plannotator spawns one as today (no regression).
- [ ] The probe has a short timeout (1-2 seconds) so users without OpenCode don't experience a startup delay.
- [ ] Chat sessions created via the attached client are visible in the user's OpenCode TUI.

### 3. Prompt cache keepalive (#417)

**Prerequisite:** Slice 1 must enable prompt caching on chat requests (top-level `cache_control: {type: "ephemeral"}` on Claude, stable `prompt_cache_key` on Codex). Without Slice 1's caching enablement, a keepalive turn refreshes nothing — it's just an extra billed API call. See [`01-chat-foundation/01-reliability.md`](./01-chat-foundation/01-reliability.md#prompt-caching-enablement).

**The problem:** Provider-side prompt caches (Anthropic and OpenAI both cite ~5-minute TTL) expire when the user goes idle. In a long review session (the kind that can last hours), coming back after 10 minutes means the next turn reprocesses the entire conversation prefix — slower and more expensive.

**The fix:** A server-side idle timer per chat session that sends a visible "keep warm" turn before the cache expires.

**How it works:**
1. **Idle tracking:** The server tracks `lastActiveAt` per session (this field already exists in `packages/ai/session-manager.ts` for eviction bookkeeping — lines ~22, ~65, ~113, ~175). When `now - lastActiveAt` exceeds `ttlSeconds`, the keepalive fires.
2. **The keepalive turn:** A real user message (`"(keepalive)"`) sent through the normal provider query path. The provider processes it, the cache is renewed, and a normal assistant response comes back. Both the user message and assistant response are marked `maintenance: true` in the transcript.
3. **UI rendering:** Maintenance turns are collapsed into a single expandable row: "Kept cache warm - $0.002". Clicking expands to show the actual messages. The user can always see what happened, but it doesn't clutter the conversation.
4. **Cost meter:** A per-session visible count: "3 keepalive turns, ~$0.006 total." Surfaces the economic cost directly.
5. **Safety caps:**
   - `maxRenewals = 11` by default (the crossover point where keepalive cost exceeds the cold-cache savings, per #417 analysis).
   - Global off switch in config (disables all keepalive behavior).
   - When `maxRenewals` is hit, the server fires a `keepalive.skipped` log event and stops renewing. The UI shows "cache keepalive paused — renewal limit reached."

**Policy shape:**
```ts
interface KeepalivePolicy {
  enabled: boolean;                  // default true
  ttlSeconds: number;                // default ~270 (under 5-minute provider TTL)
  maintenanceMessage: string;        // default "(keepalive)"
  maxRenewals: number | null;        // default 11
}
```

**Key files:**
- Modified: `packages/ai/session-manager.ts` (idle tracking timer, keepalive trigger per session)
- Modified: `packages/ai/endpoints.ts` (keepalive maintenance turn goes through normal query path)
- Modified: `packages/ai/types.ts` (`maintenance: boolean` flag on message types)
- Modified: `packages/review-editor/hooks/useAIChat.ts` (recognize maintenance-flagged turns)
- Modified: `packages/review-editor/components/AITab.tsx` (collapsed maintenance row rendering, cost meter)

**Acceptance criteria:**
- [ ] A chat session left idle past `ttlSeconds` receives a visible keepalive turn that renews the provider's prompt cache.
- [ ] Maintenance turns are collapsed in the UI with an expandable detail view showing the cost.
- [ ] `maxRenewals` cap is honored; a `keepalive.skipped` event fires when the cap is reached.
- [ ] The cost meter shows cumulative keepalive cost per session.
- [ ] The off switch disables all keepalive behavior globally.
- [ ] The keepalive timer runs on the server (not the browser), so it survives browser refresh within the server's lifetime.
- [ ] Next real user turn after a keepalive is measurably cheaper than an equivalent cold-cache turn (validate via the `costUsd` or `cached_tokens` field on the provider response if available).
- [ ] Verified against Slice 1's caching enablement: `cache_read_input_tokens` is non-zero on the turn immediately following a keepalive (proves the keepalive actually wrote to cache, not just billed for a no-op turn).

## External references

- **Anthropic prompt caching docs:** 5-minute default TTL, refreshed on reuse.
- **OpenAI prompt caching docs:** 5-10 minutes of inactivity, cached prefixes active.
- **#417 discussion:** The crossover point where keepalive cost exceeds cold-cache savings is ~11 consecutive renewals.

## Open questions

- **Keepalive default: `visible_inject` or `warn_only`?** We chose `visible_inject` as the default (automatic maintenance turns). The alternative is `warn_only` (UI banner with manual button, no automatic spend). Recommendation: keep `visible_inject` as default — the whole point of #417 is that users *want* automatic cache renewal. The cost meter + `maxRenewals` cap give sufficient cost control.
- **Keepalive `ttlSeconds` per provider:** Anthropic cites 5 minutes, OpenAI cites 5-10 minutes. Should we use a single default (270s, comfortably under 5 min) or per-provider defaults? Recommendation: single default for v1. If a provider has a longer TTL, the user just gets extra headroom — no harm.
- **Plan-mode AI right-side panel layout:** The plan editor currently has a left sidebar (TOC/Versions/Archive) and a main content area. Adding a right panel changes the layout. Should it be a fixed split (like code review), or a flyout overlay that doesn't reduce the plan content width? Recommendation: fixed split, same as code review — consistency over density.
