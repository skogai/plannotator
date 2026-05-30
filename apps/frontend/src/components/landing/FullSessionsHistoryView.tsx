import { useMemo, useState } from "react";
import { Folder } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDaemonEventStore } from "../../daemon/events/event-store";
import { useProjectStore } from "../../stores/project-store";
import { useHistoryStore } from "../../stores/history-store";
import { useConjoinedHistory } from "./use-conjoined-history";
import { ActiveSessionRow } from "./ActiveSessionRow";
import { HistoryRow } from "./HistoryRow";
import { PRGroup } from "./git-dashboard/PRGroup";

interface FullSessionsHistoryViewProps {
  active: boolean;
  onBack: () => void;
}

/**
 * Full-screen conjoined Sessions + History browse. Carousel slide 2, mirroring
 * the Git Dashboard full-page pattern (container, Back button, grouped rows).
 */
export function FullSessionsHistoryView({ active, onBack }: FullSessionsHistoryViewProps) {
  const sessions = useDaemonEventStore((s) => s.sessions);
  const projects = useProjectStore((s) => s.projects);
  const entries = useHistoryStore((s) => s.entries);
  const historyLoading = useHistoryStore((s) => s.loading);

  const [activeOrAll, setActiveOrAll] = useState<"active" | "all">("active");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  useConjoinedHistory(active && activeOrAll === "all", projectFilter);

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

  // Group entries / sessions by project name for PRGroup-style sections.
  const entryGroups = useMemo(() => groupBy(filteredEntries, (e) => e.project), [filteredEntries]);
  const sessionGroups = useMemo(
    () => groupBy(filteredSessions, (s) => s.project),
    [filteredSessions],
  );

  const isAll = activeOrAll === "all";
  const isEmpty = isAll ? filteredEntries.length === 0 : filteredSessions.length === 0;

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-10 md:py-14">
        <div className="mb-8">
          <button
            type="button"
            onClick={onBack}
            className="text-[12px] text-muted-foreground hover:text-foreground"
          >
            ← Back
          </button>
        </div>

        <div className="sticky top-0 z-10 mb-6 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <Tabs value={activeOrAll} onValueChange={(v) => setActiveOrAll(v as "active" | "all")}>
            <TabsList className="h-7 gap-1">
              <TabsTrigger value="active" className="px-2.5 py-0.5 text-xs">
                Active
              </TabsTrigger>
              <TabsTrigger value="all" className="px-2.5 py-0.5 text-xs">
                All
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <select
            value={projectFilter ?? ""}
            onChange={(e) => setProjectFilter(e.target.value || null)}
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            <option value="">All projects</option>
            {topLevel.map((p) => (
              <option key={p.cwd} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {isAll && historyLoading && isEmpty && (
          <div className="py-20 text-center text-sm text-muted-foreground">Loading history…</div>
        )}

        {isEmpty && !(isAll && historyLoading) && (
          <div className="py-20 text-center text-sm text-muted-foreground">
            {isAll ? "No history found across your projects" : "No active sessions"}
          </div>
        )}

        {!isEmpty && isAll && (
          <section className="flex flex-col gap-2">
            {Object.entries(entryGroups).map(([project, groupEntries]) => (
              <PRGroup key={project} title={project} icon={Folder} count={groupEntries.length}>
                {groupEntries.map((entry) => (
                  <HistoryRow
                    key={`${entry.project}/${entry.worktree ?? ""}/${entry.slug}`}
                    entry={entry}
                    cwd={nameToCwd[entry.project] ?? ""}
                    density="full"
                  />
                ))}
              </PRGroup>
            ))}
          </section>
        )}

        {!isEmpty && !isAll && (
          <section className="flex flex-col gap-2">
            {Object.entries(sessionGroups).map(([project, groupSessions]) => (
              <PRGroup key={project} title={project} icon={Folder} count={groupSessions.length}>
                {groupSessions.map((session) => (
                  <ActiveSessionRow key={session.id} session={session} />
                ))}
              </PRGroup>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}
