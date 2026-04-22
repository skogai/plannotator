/**
 * Trailing-throttle presence updates to a send function.
 *
 * Motivation: remote cursor presence is produced by pointermove/selection
 * events that fire far faster than we should transmit. Policy is a
 * 50ms trailing throttle (≈20Hz). Presence is lossy — the runtime swallows
 * disconnect errors inside `sendPresence`, so latest-cursor-wins is fine.
 *
 * Contract:
 * - When `state` changes, schedule `send(state)`.
 *   - If the last send was > `ms` ago, schedule it for next tick (so the
 *     trailing debouncer collapses rapid bursts to at most one send per
 *     `ms` window).
 *   - Otherwise push out the trailing timer so the eventual send carries
 *     the freshest state.
 * - `state: null` cancels any pending send without emitting.
 * - `send: undefined` is a no-op (not yet connected; wait for reconnect).
 * - On unmount / dep change, cancel any pending timer — no leaked sends.
 */

import { useEffect, useRef } from 'react';

export function usePresenceThrottle<T>(
  state: T | null,
  send: ((value: T) => unknown) | undefined,
  ms: number = 50,
): void {
  const lastSentAtRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef<T | null>(null);
  const sendRef = useRef(send);

  // Keep sendRef current so the trailing timer uses the latest send fn
  // without resetting the throttle window when the callback identity changes
  // (parents often pass inline lambdas).
  sendRef.current = send;

  useEffect(() => {
    latestRef.current = state;

    if (state === null) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    if (!sendRef.current) return;

    const now = Date.now();
    const elapsed = now - lastSentAtRef.current;
    const delay = elapsed >= ms ? 0 : ms - elapsed;

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const value = latestRef.current;
      const fn = sendRef.current;
      if (value === null || !fn) return;
      lastSentAtRef.current = Date.now();
      try {
        fn(value);
      } catch {
        // Sends are lossy by contract; swallow errors so a throwing send
        // doesn't wedge the throttle.
      }
    }, delay);
  }, [state, ms]);

  // Cleanup on unmount: cancel any pending timer so an already-scheduled
  // send cannot fire against a detached component.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);
}
