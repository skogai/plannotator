import { useEffect } from "react";
import { useHistoryStore } from "../../stores/history-store";

const STALE_MS = 30_000;

/**
 * Fetch history into `historyStore` whenever the conjoined view needs the "All"
 * data. Mirrors `use-git-dashboard`'s staleness effect: refetch when active and
 * either the data is stale or the project filter (by NAME) changed.
 *
 * @param active   Whether the surface currently needs history (i.e. "All" mode
 *                 and the view is visible).
 * @param projectName  The project-name filter (null/undefined = all projects).
 */
export function useConjoinedHistory(active: boolean, projectName: string | null) {
  const loading = useHistoryStore((s) => s.loading);
  const lastFetchedAt = useHistoryStore((s) => s.lastFetchedAt);
  const lastProjectKey = useHistoryStore((s) => s.lastProjectKey);
  const fetchHistory = useHistoryStore((s) => s.fetchHistory);

  useEffect(() => {
    if (!active) return;
    const key = projectName ?? "";
    const stale =
      !lastFetchedAt || Date.now() - lastFetchedAt > STALE_MS || key !== lastProjectKey;
    if (stale && !loading) {
      void fetchHistory(projectName ?? undefined);
    }
  }, [active, projectName, lastFetchedAt, lastProjectKey, loading, fetchHistory]);
}
