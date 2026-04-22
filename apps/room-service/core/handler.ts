/**
 * HTTP route dispatch for room.plannotator.ai.
 *
 * Routes requests to the appropriate Durable Object or returns
 * static responses. Does NOT apply CORS to WebSocket upgrades.
 */

import type { Env } from './types';
import { isRoomId, validateCreateRoomRequest, isValidationError } from './validation';
import { safeLog } from './log';

const ROOM_PATH_RE = /^\/c\/([^/]+)$/;
const WS_PATH_RE = /^\/ws\/([^/]+)$/;

export async function handleRequest(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // Health check
  if (pathname === '/health' && method === 'GET') {
    return Response.json({ ok: true }, { headers: cors });
  }

  // Room creation
  if (pathname === '/api/rooms' && method === 'POST') {
    return handleCreateRoom(request, env, cors);
  }

  // WebSocket upgrade — matched before asset/SPA routes so a stray ws/*
  // under the asset binding can't be mistaken for a file fetch.
  const wsMatch = pathname.match(WS_PATH_RE);
  if (wsMatch && method === 'GET') {
    return handleWebSocket(request, env, wsMatch[1], cors);
  }

  // Hashed static assets — produced by `vite build` into ./public/assets/.
  // Filenames include a content hash, so we set far-future immutable
  // Cache-Control: chunks invalidate by name, never by TTL. Headers from
  // the asset response (Content-Type, ETag, Content-Encoding) are
  // preserved; we only override CORS + Cache-Control.
  // Static root-level assets (favicon.svg). Vite copies these from
  // the publicDir into the build output root alongside index.html.
  // Served with a 1-day cache — they're not hashed so immutable isn't
  // safe, but they change very rarely.
  if (pathname === '/favicon.svg' && method === 'GET') {
    if (!env.ASSETS) {
      return new Response('Not Found', { status: 404, headers: cors });
    }
    const assetRes = await env.ASSETS.fetch(request);
    // Pass a real miss through as 404, but let 304 Not Modified
    // responses flow through — `fetch.ok` treats 304 as "not ok"
    // (it's outside 200-299), so returning 404 on 304 would force
    // the browser to abandon its cached favicon and re-download
    // on every revalidation.
    if (!assetRes.ok && assetRes.status !== 304) {
      return new Response('Not Found', { status: 404, headers: cors });
    }
    const headers = new Headers(assetRes.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set('Cache-Control', 'public, max-age=86400');
    return new Response(assetRes.body, { status: assetRes.status, headers });
  }

  if (pathname.startsWith('/assets/') && method === 'GET') {
    if (!env.ASSETS) {
      return new Response('Not Found', { status: 404, headers: cors });
    }
    const assetRes = await env.ASSETS.fetch(request);
    if (!assetRes.ok) {
      // Surface the real status (404/403/etc.) rather than pretending
      // everything is fine. CORS still attached so the browser exposes
      // the response to the page's fetch logic.
      const headers = new Headers(assetRes.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(assetRes.body, { status: assetRes.status, headers });
    }
    const headers = new Headers(assetRes.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    return new Response(assetRes.body, { status: assetRes.status, headers });
  }

  // Room SPA shell — /c/:roomId rewrites to /index.html so the chunked
  // Vite bundle can boot with the original path still visible to the
  // client JS (useRoomMode reads window.location.pathname to extract
  // roomId, and parseRoomUrl reads the fragment for the room secret).
  //
  // Cache-Control: no-store — index.html references hashed chunk URLs
  // that change on every deploy. Caching it would pin clients to stale
  // chunk references and break after the next release. The immutable
  // caching for /assets/* is what preserves the warm-visit performance;
  // this HTML is tiny.
  //
  // Referrer-Policy: no-referrer strips the path (which contains the
  // roomId) from Referer on any outbound subresource fetch. Fragments
  // are never in Referer in any browser, so this is defense-in-depth
  // for the path, not the secret itself.
  const roomMatch = pathname.match(ROOM_PATH_RE);
  if (roomMatch && method === 'GET') {
    const roomId = roomMatch[1];
    if (!isRoomId(roomId)) {
      return new Response('Not Found', { status: 404, headers: cors });
    }
    return serveIndexHtml(request, env, cors);
  }

  // No broad SPA fallback. This is a room-only origin — the only valid
  // browser route is /c/:roomId (matched above). Serving index.html for
  // `/`, `/about`, or other non-room paths would boot the local editor
  // via AppRoot's local-mode branch, contradicting the room-only
  // boundary. If future routes are added (e.g. /rooms index, admin
  // recovery page), add explicit path matches here; don't open a
  // catch-all that silently renders local mode.
  return Response.json(
    { error: 'Not found. Valid paths: GET /health, GET /c/:id, POST /api/rooms, GET /ws/:id, GET /assets/*' },
    { status: 404, headers: cors },
  );
}

/**
 * Content Security Policy for the room HTML shell.
 *
 * Applied ONLY to the document response (/index.html), not to API or
 * asset responses. The browser evaluates CSP from the document.
 *
 * Rationale for each directive:
 *   default-src 'self'            — lockdown baseline
 *   script-src 'self' 'wasm-unsafe-eval'
 *                                 — Vite chunks + Graphviz WASM
 *   style-src 'self' 'unsafe-inline' https://fonts.googleapis.com
 *                                 — app CSS + Google Fonts + inline styles
 *   font-src 'self' https://fonts.gstatic.com
 *                                 — Google font files
 *   img-src 'self' https: data: blob:
 *                                 — icons, blob previews, and remote
 *                                   markdown document images (e.g.
 *                                   `![diagram](https://example/a.png)`)
 *                                   which Viewer renders as plain <img>.
 *   connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*
 *                                 — same-origin Worker API/WebSocket
 *                                   + cross-port localhost dev WS
 *   worker-src 'self' blob:       — defensive for libs using blob workers
 *   object-src 'none'             — no plugins/objects
 *   base-uri 'none'               — prevent <base> tag injection
 *   frame-ancestors 'none'        — no clickjacking/embedding
 *   form-action 'none'            — no form submissions expected
 */
export const ROOM_CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' needed for @viz-js/viz (Graphviz WASM build).
  // NOT 'unsafe-eval' — only WebAssembly compilation is allowed.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  // Remote markdown document images (e.g. `![diagram](https://example/a.png)`)
  // are a supported plan-content feature — Viewer renders them as plain
  // `<img src="https://...">`. Allowing blanket `https:` here is a known
  // tradeoff: an injected script could beacon via image URLs. Accepted
  // because the product supports remote plan images, and the more
  // exfil-capable channels (fetch / WebSocket) stay locked down via
  // `connect-src 'self' + scoped localhost`.
  // Annotation image attachments remain stripped before sending to the
  // room (stripRoomAnnotationImages), so only document-level markdown
  // images exercise this allowance.
  "img-src 'self' https: data: blob:",
  // Production: `'self'` covers the same-origin WebSocket
  // (wss://room.plannotator.ai/ws/<id>) per the CSP spec.
  //
  // Development: wrangler dev serves both the room shell and the
  // WebSocket on the same localhost port, so `'self'` covers that
  // too. Cross-port local dev (shell on one port, WebSocket on
  // another) still needs explicit ws:// localhost entries.
  //
  // Blanket https: / ws: / wss: are intentionally omitted —
  // widening the scheme would give any post-XSS injection an
  // unrestricted exfiltration surface.
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  // upgrade-insecure-requests is intentionally omitted because
  // wrangler dev serves the shell + WebSocket over `ws://localhost`,
  // and this directive rewrites ws:// → wss:// (which breaks local
  // development). Production only makes same-origin wss://
  // connections, so the directive would be a no-op there anyway.
].join('; ');

/**
 * Fetch and serve /index.html from the Wrangler asset binding with the
 * headers the room shell needs: CSP, CORS, no-store cache,
 * Referrer-Policy, and an HTML content type. Falls back to a minimal
 * inline HTML when ASSETS is unbound (local test environments that
 * don't run Wrangler).
 */
async function serveIndexHtml(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (env.ASSETS) {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = '/index.html';
    const assetReq = new Request(assetUrl, { method: 'GET', headers: request.headers });
    const assetRes = await env.ASSETS.fetch(assetReq);
    const headers = new Headers(assetRes.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set('Content-Security-Policy', ROOM_CSP);
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    return new Response(assetRes.body, { status: assetRes.status, headers });
  }
  // Fallback for local/test environments without an ASSETS binding.
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Plannotator Room</title></head><body><p>Room shell (test fallback; ASSETS binding unavailable)</p></body></html>`,
    {
      status: 200,
      headers: {
        ...cors,
        'Content-Security-Policy': ROOM_CSP,
        'Content-Type': 'text/html; charset=utf-8',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Room Creation
//
// PRODUCTION HARDENING (required before public deployment, not in V1 scope):
// `POST /api/rooms` is intentionally unauthenticated in the V1 protocol. A
// room is a capability-token pair (roomSecret + adminSecret) the creator
// generates locally; this endpoint only asserts existence on the server, not
// identity. That means anyone who can reach the Worker can create rooms —
// fine for local dev and gated staging, NOT fine for the open internet.
//
// Before this Worker is exposed publicly it MUST be gated by one of:
//   - Cloudflare rate limiting / WAF rule keyed on source IP + path
//   - application-level throttle at the Worker entry (shared Durable Object
//     counter or KV-based token bucket)
//   - authenticated proxy (plannotator.ai app calls on behalf of signed-in users)
//
// CORS is NOT abuse protection — it's a browser same-origin policy and does
// nothing to a direct HTTP client. Any future reviewer flagging "this
// endpoint is unauthenticated" should be pointed HERE. Production hardening
// (rate-limit POST /api/rooms) is the intended gate; the protocol design
// accommodates adding it without client changes.
// ---------------------------------------------------------------------------

async function handleCreateRoom(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const result = validateCreateRoomRequest(body);
  if (isValidationError(result)) {
    return Response.json({ error: result.error }, { status: result.status, headers: cors });
  }

  safeLog('handler:create-room', { roomId: result.roomId });

  // Forward to the Durable Object
  const id = env.ROOM.idFromName(result.roomId);
  const stub = env.ROOM.get(id);
  const doResponse = await stub.fetch(
    new Request('http://do/create', {
      method: 'POST',
      body: JSON.stringify(result),
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  // Re-wrap DO response with CORS headers
  const responseBody = await doResponse.text();
  return new Response(responseBody, {
    status: doResponse.status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// WebSocket Upgrade
// ---------------------------------------------------------------------------

async function handleWebSocket(
  request: Request,
  env: Env,
  roomId: string,
  cors: Record<string, string>,
): Promise<Response> {
  // Verify WebSocket upgrade header. RFC 6455 specifies the token
  // is case-insensitive; browsers send lowercase but standards-
  // conformant non-browser clients may send `WebSocket` or `WEBSOCKET`.
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json(
      { error: 'Expected WebSocket upgrade' },
      { status: 426, headers: cors },
    );
  }

  // Validate roomId BEFORE idFromName(). idFromName on arbitrary attacker
  // input would instantiate a fresh DO and hit storage on every request —
  // a cheap abuse surface. Reject malformed IDs up front.
  if (!isRoomId(roomId)) {
    return Response.json(
      { error: 'Invalid roomId' },
      { status: 400, headers: cors },
    );
  }

  // Forward to the Durable Object — no CORS on WebSocket upgrade
  const id = env.ROOM.idFromName(roomId);
  const stub = env.ROOM.get(id);
  return stub.fetch(request);
}
