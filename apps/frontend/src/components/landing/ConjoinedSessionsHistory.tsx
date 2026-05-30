import { useMemo, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDaemonEventStore } from "../../daemon/events/event-store";
import { useProjectStore } from "../../stores/project-store";
import { useHistoryStore } from "../../stores/history-store";
import { useConjoinedHistory } from "./use-conjoined-history";
import { ActiveSessionRow } from "./ActiveSessionRow";
import { HistoryRow } from "./HistoryRow";

interface ConjoinedSessionsHistoryProps {
  onFullView: () => void;
}

/**
 * Compact conjoined Sessions + History surface. Sits under the project selector
 * on the landing page, replacing the old flat "Active sessions" list. An
 * Active⇄All toggle (default Active) switches between live sessions and history;
 * a project filter narrows both. A "Full view →" button expands to the
 * full-screen carousel slide.
 */
export function ConjoinedSessionsHistory({ onFullView }: ConjoinedSessionsHistoryProps) {
  const sessions = useDaemonEventStore((s) => s.sessions);
  const projects = useProjectStore((s) => s.projects);
  const entries = useHistoryStore((s) => s.entries);
  const historyLoading = useHistoryStore((s) => s.loading);

  const [activeOrAll, setActiveOrAll] = useState<"active" | "all">("active");
  // Stores a project NAME (history is keyed by name); null = all projects.
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  // Only fetch history when "All" is selected.
  useConjoinedHistory(activeOrAll === "all", projectFilter);

  const topLevel = useMemo(() => projects.filter((p) => !p.parentCwd), [projects]);
  const nameToCwd = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of topLevel) map[p.name] = p.cwd;
    return map;
  }, [topLevel]);

  const filteredSessions = useMemo(() => {
    if (!projectFilter) return sessions;
    const cwd = nameToCwd[projectFilter];
    return sessions.filter((s) => (s.projectCwd ?? s.cwd) === cwd);
  }, [sessions, projectFilter, nameToCwd]);

  const filteredEntries = useMemo(() => {
    if (!projectFilter) return entries;
    return entries.filter((e) => e.project === projectFilter);
  }, [entries, projectFilter]);

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <Tabs value={activeOrAll} onValueChange={(v) => setActiveOrAll(v as "active" | "all")}>
          <TabsList className="h-6 gap-1">
            <TabsTrigger value="active" className="px-2 py-0.5 text-[11px]">
              Active
            </TabsTrigger>
            <TabsTrigger value="all" className="px-2 py-0.5 text-[11px]">
              All
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <select
          value={projectFilter ?? ""}
          onChange={(e) => setProjectFilter(e.target.value || null)}
          className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground"
        >
          <option value="">All projects</option>
          {topLevel.map((p) => (
            <option key={p.cwd} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onFullView}
          className="ml-auto text-[12px] text-muted-foreground hover:text-foreground"
        >
          Full view →
        </button>
      </div>

      <div className="max-h-[300px] overflow-y-auto px-1 py-1">
        {activeOrAll === "active" ? (
          filteredSessions.length > 0 ? (
            filteredSessions.map((session) => (
              <ActiveSessionRow key={session.id} session={session} />
            ))
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">No active sessions</div>
          )
        ) : filteredEntries.length > 0 ? (
          filteredEntries.map((entry) => (
            <HistoryRow
              key={`${entry.project}/${entry.worktree ?? ""}/${entry.slug}`}
              entry={entry}
              cwd={nameToCwd[entry.project] ?? ""}
              density="compact"
            />
          ))
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {historyLoading ? "Loading history…" : "No history"}
          </div>
        )}
      </div>
    </div>
  );
}
