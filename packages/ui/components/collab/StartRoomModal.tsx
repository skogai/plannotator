import React, { useState } from 'react';
import { PRESENCE_SWATCHES } from '@plannotator/ui/utils/presenceColor';

/**
 * Pure create-room dialog. Collects display name, color, expiry, and
 * confirms the image-strip consequence when relevant. Emits one callback
 * (`onStart`) with the settled options; the parent (`App.tsx`'s
 * `handleConfirmStartRoom`) calls `createRoom()` directly because the
 * flow needs a synchronous `window.open()` inside the click handler's
 * user-activation window — a React hook boundary between click and open
 * would get the popup blocked in most browsers.
 *
 * Identity is a confirmation step, not a setup step: callers pass
 * `initialDisplayName` and `initialColor` from the user's existing
 * Plannotator preferences (`getIdentity()` / `getPresenceColor()`), and
 * the parent persists any edits back via `setCustomIdentity` /
 * `setPresenceColor` after submit. Peers see the submitted color via
 * presence.
 *
 * Not a controlled modal — parent decides when to mount. Dismiss via the
 * Cancel button (not Esc-only) so the caller can abort an in-flight
 * createRoom via AbortController.
 */

export interface StartRoomSubmit {
  displayName: string;
  color: string;
  expiresInDays: 0 | 1 | 7 | 30;
}

export interface StartRoomModalProps {
  initialDisplayName?: string;
  initialColor?: string;
  imageAnnotationsToStrip?: number;
  inFlight?: boolean;
  errorMessage?: string;
  onStart(submit: StartRoomSubmit): void;
  onCancel(): void;
}

export function StartRoomModal({
  initialDisplayName = '',
  initialColor = PRESENCE_SWATCHES[0],
  imageAnnotationsToStrip = 0,
  inFlight = false,
  errorMessage,
  onStart,
  onCancel,
}: StartRoomModalProps): React.ReactElement {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [color, setColor] = useState(initialColor);
  const [expiresInDays, setExpiresInDays] = useState<0 | 1 | 7 | 30>(7);

  const strips = imageAnnotationsToStrip > 0;
  const ctaLabel = inFlight
    ? 'Creating…'
    : strips ? 'Strip images and start' : 'Start room';

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight) return;
    const trimmed = displayName.trim();
    if (!trimmed) return;
    onStart({ displayName: trimmed, color, expiresInDays });
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
      data-testid="start-room-modal"
    >
      <form
        onSubmit={handleSubmit}
        className="bg-card border border-border rounded-xl shadow-2xl w-[420px] max-w-[90vw] p-5 space-y-4"
      >
        <div>
          <h2 className="text-base font-semibold">Start a live review session</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Share a link. Collaborators see your plan and annotations in real time.
            Their changes sync to you.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase text-muted-foreground">Display name</label>
          <input
            type="text"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            disabled={inFlight}
            className="w-full px-2 py-1 border rounded text-sm"
            placeholder="Your name"
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase text-muted-foreground">Color</label>
          <div className="flex items-center gap-1">
            {PRESENCE_SWATCHES.map(s => (
              <button
                key={s}
                type="button"
                disabled={inFlight}
                onClick={() => setColor(s)}
                className={`w-6 h-6 rounded-full border-2 ${color === s ? 'border-foreground' : 'border-transparent'}`}
                style={{ backgroundColor: s }}
                aria-label={`Color ${s}`}
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase text-muted-foreground">Expires</label>
          <select
            value={expiresInDays}
            onChange={e => setExpiresInDays(Number(e.target.value) as 0 | 1 | 7 | 30)}
            disabled={inFlight}
            className="w-full px-2 py-1 border rounded text-sm"
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days (default)</option>
            <option value={30}>30 days</option>
            <option value={0}>Never</option>
          </select>
        </div>

        {strips && (
          <div className="text-xs bg-amber-50 text-amber-900 dark:bg-amber-900/20 dark:text-amber-200 p-2 rounded">
            <strong>Images won't travel.</strong>{' '}
            {imageAnnotationsToStrip} item{imageAnnotationsToStrip === 1 ? '' : 's'} with image attachments will be stripped before sharing. Your local copies stay intact.
          </div>
        )}

        {errorMessage && (
          <div className="text-xs bg-destructive/10 text-destructive p-2 rounded" role="alert">
            {errorMessage}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            // Cancel must remain enabled during in-flight so the user can
            // abort createRoom via the AbortController the parent wired.
            className="px-3 py-1.5 text-sm rounded hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={inFlight || !displayName.trim()}
            className="px-3 py-1.5 text-sm rounded bg-foreground text-background disabled:opacity-50"
          >
            {ctaLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
