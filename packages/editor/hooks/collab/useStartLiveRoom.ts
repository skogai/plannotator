/**
 * useStartLiveRoom — creator-side "start a live room" flow.
 *
 * Lives under packages/editor/hooks/collab/ (not packages/ui/) because:
 *   - The flow is editor-shell workflow, not generic reusable UI.
 *   - It depends on `import.meta.env.VITE_ROOM_BASE_URL` whose ambient
 *     typing lives in packages/editor/env.d.ts. Placing this hook under
 *     packages/ui would either leak editor env typing into the UI
 *     package or require a base-URL injection parameter from App,
 *     both of which are worse than the straightforward editor-local
 *     home.
 *
 * Invariants this hook MUST preserve (do not "clean up" away):
 *   - Dynamic imports inside `handleConfirmStartRoom` stay dynamic.
 *     Four `await import(...)` calls exist specifically to code-split
 *     the collab client off the editor main bundle. A well-meaning
 *     lint autofix that hoists them to static imports is a bundle-
 *     size regression.
 *   - The `window.open('', '_blank')` placeholder MUST run
 *     synchronously in the click path, before any `await`. Browsers
 *     only honor the popup-blocker user-activation grant for
 *     synchronous work; placing this after an await would make every
 *     Start click look blocked on strict browsers.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';
import { stripRoomAnnotationImages } from '@plannotator/shared/collab';
import {
  getIdentity,
  setCustomIdentity,
  getPresenceColor,
  setPresenceColor,
} from '@plannotator/ui/utils/identity';
import type { StartRoomSubmit } from '@plannotator/ui/components/collab/StartRoomModal';

/**
 * Resolve the room-service base URL for `createRoom()`. Precedence:
 *
 *   1. `window.__ROOM_BASE_URL` — runtime escape hatch. Set via
 *      DevTools console for ad-hoc redirection without restarting
 *      the dev server.
 *   2. `import.meta.env.VITE_ROOM_BASE_URL` — build/dev-time env
 *      var, the standard Vite pattern. `scripts/dev-live-room-local.sh`
 *      sets this so the editor at :3000 targets the local wrangler
 *      dev at :8787 instead of production.
 *   3. `https://room.plannotator.ai` — production default; what
 *      every shipped build should resolve to when neither override
 *      is present.
 */
function getRoomBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const explicit = (window as { __ROOM_BASE_URL?: string }).__ROOM_BASE_URL;
    if (explicit) return explicit;
  }
  const viteBase = import.meta.env?.VITE_ROOM_BASE_URL;
  if (viteBase) return viteBase;
  return 'https://room.plannotator.ai';
}

export interface UseStartLiveRoomOptions {
  annotations: Annotation[];
  markdown: string;
  globalAttachments: ImageAttachment[];
  /**
   * True when the creator is in a shell that CAN host a live room
   * (local isApiMode editor, not room mode already). The hook uses
   * this as a defensive guard inside `handleStartLiveRoom`; App also
   * gates the surfacing UI on the same value so a blocked click is
   * theoretically unreachable.
   */
  canStartLiveRoom: boolean;
}

export interface UseStartLiveRoomReturn {
  showStartRoomModal: boolean;
  startRoomInFlight: boolean;
  startRoomError: string;
  imageAnnotationsToStrip: number;
  handleStartLiveRoom: () => void;
  handleCancelStartRoom: () => void;
  handleConfirmStartRoom: (submit: StartRoomSubmit) => Promise<void>;
}

export function useStartLiveRoom({
  annotations,
  markdown,
  globalAttachments,
  canStartLiveRoom,
}: UseStartLiveRoomOptions): UseStartLiveRoomReturn {
  // Start-live-room modal state. The modal is the sole entry to the creator
  // flow — replaces the earlier inline hardcoded path (name/color/expiry
  // defaults). Abort during in-flight creation runs through an
  // AbortController passed to createRoom().
  const [showStartRoomModal, setShowStartRoomModal] = useState(false);
  const [startRoomInFlight, setStartRoomInFlight] = useState(false);
  const [startRoomError, setStartRoomError] = useState<string>('');
  const startRoomAbortRef = useRef<AbortController | null>(null);

  // Single source of truth for "how many local items won't travel to
  // the room" — matches the value used at actual room-create time
  // (stripRoomAnnotationImages inside handleConfirmStartRoom) so the
  // modal notice and the URL `&stripped=N` handoff can never drift.
  // stripRoomAnnotationImages is synchronous and O(annotations +
  // globals); running it per render on a typical small annotation list
  // is cheap.
  const imageAnnotationsToStrip = useMemo(() => {
    const { strippedCount } = stripRoomAnnotationImages(annotations, globalAttachments);
    return strippedCount;
  }, [annotations, globalAttachments]);

  const handleStartLiveRoom = useCallback(() => {
    if (!canStartLiveRoom) return;  // belt-and-braces with prop-level gating
    setStartRoomError('');
    setShowStartRoomModal(true);
  }, [canStartLiveRoom]);

  const handleCancelStartRoom = useCallback(() => {
    // Abort the in-flight createRoom if any; modal closes either way.
    startRoomAbortRef.current?.abort();
    startRoomAbortRef.current = null;
    setShowStartRoomModal(false);
    setStartRoomInFlight(false);
  }, []);

  const handleConfirmStartRoom = useCallback(async (submit: StartRoomSubmit) => {
    setStartRoomInFlight(true);
    setStartRoomError('');

    const ctrl = new AbortController();
    startRoomAbortRef.current = ctrl;

    // Persist any edits the user made in the modal. Identity is a
    // Plannotator-wide preference — what they pick here also becomes
    // the default for the next room and feeds Settings. Writes are
    // no-ops when the submitted values already match ConfigStore.
    if (submit.displayName && submit.displayName !== getIdentity()) {
      setCustomIdentity(submit.displayName);
    }
    if (submit.color && submit.color !== getPresenceColor()) {
      setPresenceColor(submit.color);
    }

    // Pre-open a placeholder tab SYNCHRONOUSLY — inside the user-
    // activation window from the click that landed us here. Browsers
    // only honor user activation for synchronous work (or a very short
    // task chain); a bare window.open after the awaits below would
    // typically be blocked. We sever `.opener` now while the new
    // window is still a same-origin about:blank so the subsequent
    // cross-origin `location.replace` doesn't inherit the opener
    // reference. Do NOT pass `noopener`/`noreferrer` in the features
    // string — those make window.open return null EVEN ON SUCCESS,
    // which would make every opened tab look blocked.
    const newWindow: Window | null =
      typeof window !== 'undefined' ? window.open('', '_blank') : null;
    if (newWindow) {
      newWindow.opener = null;
    }

    const abortPlaceholder = () => {
      if (newWindow) {
        try { newWindow.close(); } catch { /* already closed */ }
      }
    };

    try {
      const { createRoom } = await import('@plannotator/shared/collab/client');
      const { bytesToBase64url } = await import('@plannotator/shared/collab');
      const { storeAdminSecret } = await import('@plannotator/ui/utils/adminSecretStorage');

      // `stripRoomAnnotationImages` returns a generic `Omit<T, 'images'>[]`.
      // RoomAnnotation is defined as Annotation-without-images in the
      // protocol, so the shape is compatible; we narrow explicitly instead
      // of `as never` so future protocol drift surfaces as a type error.
      // Pass globalAttachments so the helper's strippedCount matches the
      // memoized imageAnnotationsToStrip used for the modal notice and
      // `&stripped=N` URL handoff (single source of truth). `clean` is
      // still annotation-shaped — globals are dropped entirely from
      // room snapshots.
      const { clean } = stripRoomAnnotationImages(annotations, globalAttachments);
      const roomAnnotations: import('@plannotator/shared/collab').RoomAnnotation[] =
        clean as unknown as import('@plannotator/shared/collab').RoomAnnotation[];

      const baseUrl = getRoomBaseUrl();

      const result = await createRoom({
        baseUrl,
        expiresInDays: submit.expiresInDays,
        signal: ctrl.signal,
        initialSnapshot: {
          versionId: 'v1',  // RoomSnapshot contract pins versionId to 'v1' in V1
          planMarkdown: markdown,
          annotations: roomAnnotations,
        },
        user: {
          id: crypto.randomUUID(),
          name: submit.displayName,
          color: submit.color,
        },
      });

      if (ctrl.signal.aborted) {
        // User hit Cancel while the create call was in flight; the request
        // still landed and a room was created on the server, but we must
        // not navigate. Close the pre-opened placeholder so it doesn't
        // linger as an empty tab the user can't explain.
        abortPlaceholder();
        return;
      }

      // sessionStorage is per-origin — the value we set here lives only in
      // the creator's local editor origin and is NOT visible on
      // room.plannotator.ai. We still write it so same-origin test/dev
      // scenarios (everything on localhost) keep working; cross-origin
      // cases rely on the admin fragment in the URL.
      storeAdminSecret(result.roomId, bytesToBase64url(result.adminSecret));

      // Auto-copy the PARTICIPANT URL (safe default share target).
      try {
        await navigator.clipboard.writeText(result.joinUrl);
      } catch { /* ignore */ }

      // Creator's destination URL: adminUrl (which already carries
      // `#key=<roomSecret>&admin=<adminSecret>` in its fragment) plus
      // an optional `&stripped=N` and an identity handoff. The admin
      // fragment stays in the URL because useCollabRoom parses it on
      // every connect; stripping it would force a separate admin-
      // secret-override injection path.
      //
      // Identity handoff (name + color) bridges the cross-origin gap:
      // localhost ConfigStore cookies are not visible on
      // room.plannotator.ai, so the creator's confirmed identity
      // rides along in the URL fragment and is consumed + stripped
      // by `AppRoot` on arrival. `&admin=` stays (it's the session
      // credential); `&name=&color=` get stripped after AppRoot
      // writes them into the room-origin ConfigStore.
      const appendFragmentParam = (url: string, param: string): string =>
        `${url}${url.includes('#') ? '&' : '#'}${param}`;
      let creatorUrl = result.adminUrl;
      if (imageAnnotationsToStrip > 0) {
        creatorUrl = appendFragmentParam(
          creatorUrl,
          `stripped=${imageAnnotationsToStrip}`,
        );
      }
      if (submit.displayName) {
        creatorUrl = appendFragmentParam(
          creatorUrl,
          `name=${encodeURIComponent(submit.displayName)}`,
        );
      }
      if (submit.color) {
        creatorUrl = appendFragmentParam(
          creatorUrl,
          `color=${encodeURIComponent(submit.color)}`,
        );
      }

      // Navigate the pre-opened placeholder tab to the room URL. The
      // creator's current tab stays on localhost so the blocked hook
      // has an approval surface. `location.replace` (not `=`) so the
      // about:blank intermediate doesn't sit in the new tab's back
      // history. If the browser blocked the synchronous pre-open
      // above, surface the URL as a copy-able fallback in the modal
      // rather than silently reassigning the current tab (which would
      // strand the local hook).
      if (newWindow) {
        // Success: new tab takes over the room session. Close the
        // modal so the localhost tab returns to the editor.
        newWindow.location.replace(creatorUrl);
        setStartRoomInFlight(false);
        setShowStartRoomModal(false);
      } else {
        // Popup blocked: KEEP the modal open so the user can copy
        // the surfaced URL and open the room themselves.
        setStartRoomError(
          `Your browser blocked opening the room in a new tab. ` +
          `Copy this URL and open it yourself: ${creatorUrl}`,
        );
        setStartRoomInFlight(false);
      }
    } catch (err) {
      abortPlaceholder();
      if (ctrl.signal.aborted) return;  // user cancelled; no error
      const { redactRoomSecrets } = await import('@plannotator/shared/collab');
      const msg = err instanceof Error ? err.message : String(err);
      setStartRoomError(redactRoomSecrets(msg) || 'Failed to start live room');
      setStartRoomInFlight(false);
    } finally {
      if (startRoomAbortRef.current === ctrl) startRoomAbortRef.current = null;
    }
  }, [annotations, markdown, imageAnnotationsToStrip, globalAttachments]);

  return {
    showStartRoomModal,
    startRoomInFlight,
    startRoomError,
    imageAnnotationsToStrip,
    handleStartLiveRoom,
    handleCancelStartRoom,
    handleConfirmStartRoom,
  };
}
