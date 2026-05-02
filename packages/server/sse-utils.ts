/**
 * SSE helpers shared across server-side streams.
 *
 * Three places hold long-lived SSE streams (agent jobs, external annotations,
 * and — after Slice 1 PR 1 — chat). All three need the same 30-second heartbeat
 * comment pattern to keep corporate proxies and dev-tunnel services from killing
 * idle TCP sockets after 60 seconds. This module is the one place that shape lives.
 */

/** Heartbeat comment to keep SSE connections alive. A comment line starts with `:`. */
export const SSE_HEARTBEAT_COMMENT = ":\n\n";

/** Interval in ms between heartbeat comments. Safely under common proxy idle timeouts. */
export const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Start a heartbeat loop on an SSE controller. Returns a cleanup function that
 * MUST be called when the stream cancels or the subscriber disconnects,
 * otherwise the interval leaks.
 *
 * The heartbeat itself is best-effort: if `controller.enqueue` throws (stream
 * already closed), the interval clears itself and the optional `onFailure`
 * callback fires so the caller can drop the dead controller from whatever
 * subscriber set it maintains. The callback is only invoked on the first
 * failure — subsequent ticks can't fire because the interval is cleared.
 *
 * Usage:
 *   const stop = startHeartbeat(controller, { onFailure: () => subscribers.delete(controller) });
 *   // later, on explicit disconnect:
 *   stop();
 */
export function startHeartbeat(
  controller: ReadableStreamDefaultController<Uint8Array>,
  intervalOrOptions?:
    | number
    | { intervalMs?: number; onFailure?: () => void },
): () => void {
  const intervalMs =
    typeof intervalOrOptions === "number"
      ? intervalOrOptions
      : intervalOrOptions?.intervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const onFailure =
    typeof intervalOrOptions === "object"
      ? intervalOrOptions?.onFailure
      : undefined;

  const encoder = new TextEncoder();
  const timer = setInterval(() => {
    try {
      controller.enqueue(encoder.encode(SSE_HEARTBEAT_COMMENT));
    } catch {
      clearInterval(timer);
      onFailure?.();
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
