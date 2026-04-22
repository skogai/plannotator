/**
 * useCollabRoomSession — join-intent wrapper around useCollabRoom.
 *
 * useCollabRoom supports the WebSocket join flow (parse URL →
 * authenticate → subscribe). This wrapper adds URL parsing + admin URL
 * reconstruction on top so RoomApp can render the participant/admin
 * share links without re-implementing that logic.
 *
 * The create flow (createRoom → persist adminSecret → redirect) is NOT
 * hosted here. It lives inline in `packages/editor/App.tsx`'s
 * `handleConfirmStartRoom` because the browser requires
 * `window.open('', '_blank')` to run synchronously inside the click
 * handler's user-activation window; wrapping that in a hook would add
 * an unavoidable React render boundary between click and open, which
 * most browsers classify as untrusted and block. If the create flow
 * ever needs to live elsewhere, it needs its own plan for the popup
 * timing — do not move it back here as-is.
 *
 * Phases:
 *   'ready'    — client constructed; useCollabRoom mounted. Not
 *                necessarily authenticated yet — consumers watch
 *                `room.connectionStatus`.
 *   'error'    — URL failed to parse; `error` populated.
 *
 * Admin recovery: the caller may pass `adminSecretOverride` (base64url,
 * typically read from sessionStorage via `loadAdminSecret`) when the
 * URL fragment no longer carries `&admin=`. This lets a tab refresh
 * re-enter as admin without re-including the admin secret in the
 * address bar.
 */

import { useMemo } from 'react';
import { useCollabRoom, type UseCollabRoomReturn } from './useCollabRoom';
import {
  parseRoomUrl,
  buildRoomJoinUrl,
  buildAdminRoomUrl,
  type CollabRoomUser,
} from '@plannotator/shared/collab/client';
import { base64urlToBytes, ADMIN_SECRET_LENGTH_BYTES } from '@plannotator/shared/collab';

export type CollabRoomSessionPhase = 'ready' | 'error';

export interface UseCollabRoomSessionOptions {
  intent: 'join';
  url: string;
  user: CollabRoomUser;
  /** Default true. */
  enabled?: boolean;
  /** base64url; passed through to useCollabRoom if not already in the URL fragment. */
  adminSecretOverride?: string;
}

export interface UseCollabRoomSessionReturn {
  phase: CollabRoomSessionPhase;
  room?: UseCollabRoomReturn;
  /** Participant URL, rebuilt without any admin fragment. Safe to share. */
  joinUrl?: string;
  /** Present when the caller holds admin capability (URL or override). */
  adminUrl?: string;
  /** Resolved roomId. */
  roomId?: string;
  /**
   * The room identity the caller passed in — mirrored here so the editor
   * can stamp annotation `author` from the joined room display name
   * instead of the local `getIdentity()` cookie, which may be stale or
   * unset on room.plannotator.ai.
   */
  user?: CollabRoomUser;
  /** Populated when phase === 'error'. */
  error?: { code: string; message: string };
}

export function useCollabRoomSession(
  options: UseCollabRoomSessionOptions,
): UseCollabRoomSessionReturn {
  const enabled = options.enabled ?? true;

  const room = useCollabRoom({
    url: options.url,
    adminSecret: options.adminSecretOverride,
    user: options.user,
    enabled,
  });

  return useMemo<UseCollabRoomSessionReturn>(() => {
    // `joinUrl` MUST be a participant-only URL — never the raw input URL,
    // which may include `&admin=...`. We rebuild from the parsed roomId +
    // roomSecret. When the parsed URL also carries an admin secret (the
    // creator arrived via their admin URL), we rebuild the admin URL too
    // so the RoomPanel's "Show admin recovery link" disclosure has
    // something concrete to copy. Participants without admin capability
    // see `adminUrl: undefined`.
    //
    // If parsing fails we surface the error phase rather than leak
    // whatever the user pasted.
    const parsed = parseRoomUrl(options.url);
    if (!parsed) {
      return { phase: 'error', error: { code: 'invalid_room_url', message: 'Invalid room URL' } };
    }
    const origin = safeOrigin(options.url);
    const participantUrl = buildRoomJoinUrl(parsed.roomId, parsed.roomSecret, origin);
    // Rebuild the admin URL from whichever source carries the admin
    // secret: the URL fragment (creator's first visit) OR the
    // adminSecretOverride prop (sessionStorage recovery on refresh).
    // Without this fallback, a recovered admin can lock/unlock/delete
    // but the RoomPanel's "Show admin recovery link" disclosure has
    // nothing to copy — confusing because the admin controls work fine.
    let adminSecretBytes: Uint8Array | undefined = parsed.adminSecret;
    if (!adminSecretBytes && options.adminSecretOverride) {
      try {
        const decoded = base64urlToBytes(options.adminSecretOverride);
        if (decoded.length === ADMIN_SECRET_LENGTH_BYTES) adminSecretBytes = decoded;
      } catch { /* invalid override — ignore, admin URL stays undefined */ }
    }
    const adminUrl = adminSecretBytes
      ? buildAdminRoomUrl(parsed.roomId, parsed.roomSecret, adminSecretBytes, origin)
      : undefined;
    return {
      phase: 'ready',
      room,
      joinUrl: participantUrl,
      adminUrl,
      roomId: parsed.roomId,
      user: options.user,
    };
  // Deps use stable individual values — NOT `options` (unstable object
  // identity from inline JSX). Without this, cursor presence updates
  // (~20Hz) would re-render RoomApp → fresh options → useMemo churn →
  // new roomSession prop into App → full editor tree reconciliation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    room,
    options.url,
    options.adminSecretOverride ?? '',
    // Track user name/color changes so the `user` field we expose
    // on the return reflects mid-session rename (unlikely but cheap).
    options.user.id, options.user.name, options.user.color, enabled,
  ]);
}

/**
 * Extract `origin` (scheme + host + port) from a URL without throwing.
 * Used so `buildRoomJoinUrl` produces a URL on the same host the user
 * is currently on, not the default `https://room.plannotator.ai` hardcoded
 * in `DEFAULT_BASE_URL`.
 */
function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
