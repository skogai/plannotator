import { useMemo } from "react";
import { useAppStore } from "../../stores/app-store";
import { useDaemonEventStore } from "../../daemon/events/event-store";
import type { SessionSummary } from "../../daemon/contracts";

/**
 * Owning-project key for a session, with cwd fallback for pre-migration rows.
 * MUST match `owningProjectKey` in packages/ui/utils/sessionTree.ts so the
 * sidebar's "active project" lines up with the tree node a session lands under.
 */
export function activeProjectCwdOf(
  sessions: SessionSummary[],
  activeSessionId: string | null,
): string | null {
  if (!activeSessionId) return null;
  const session = sessions.find((s) => s.id === activeSessionId);
  if (!session) return null;
  return session.projectCwd ?? session.cwd ?? null;
}

/**
 * Derive the cwd of the project that owns the currently-active session.
 * Never stored — single source of truth is `activeSessionId` + live sessions.
 */
export function useActiveProjectCwd(): string | null {
  const sessions = useDaemonEventStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  return useMemo(
    () => activeProjectCwdOf(sessions, activeSessionId),
    [sessions, activeSessionId],
  );
}
