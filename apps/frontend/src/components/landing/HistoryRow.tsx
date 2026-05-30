import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FileClock } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { daemonApiClient } from "../../daemon/api/client";
import type { HistoryIndexEntry } from "../../daemon/contracts";
import { ROW, pad } from "../sidebar/row-style";
import { formatRelativeTime } from "./git-dashboard/use-git-dashboard";

/**
 * Turn a history slug (`my-plan-2026-05-29`) into a readable title by stripping
 * the trailing date stamp and de-kebabing.
 */
export function prettySlug(slug: string): string {
  const withoutDate = slug.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return withoutDate.replace(/-/g, " ") || slug;
}

/**
 * Derive the directory portion of an absolute file path. History markdown files
 * always live in an existing directory, so this yields a valid cwd the daemon
 * can resolve a project against even when the live project registry has no
 * matching entry (project removed, or added under a custom name).
 */
function dirnameOf(filePath: string): string {
  const sep = filePath.includes("\\") && !filePath.includes("/") ? "\\" : "/";
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) return trimmed.slice(0, idx + 1) || sep;
  return trimmed.slice(0, idx);
}

interface HistoryRowProps {
  entry: HistoryIndexEntry;
  /** Owning project cwd (name→cwd lookup). Empty string when unknown. */
  cwd: string;
  density: "compact" | "full";
}

export function HistoryRow({ entry, cwd, density }: HistoryRowProps) {
  const [launching, setLaunching] = useState(false);
  const navigate = useNavigate();

  const handleOpen = useCallback(async () => {
    if (!entry.latestVersionPath) {
      toast.error("This history entry has no readable plan file");
      return;
    }
    setLaunching(true);
    // `cwd` is empty when the live project registry has no entry for this
    // history project (project removed, or registered under a custom name).
    // Fall back to the directory of the (absolute) history file so the daemon
    // always receives a resolvable cwd instead of throwing on an empty one.
    const sessionCwd = cwd || dirnameOf(entry.latestVersionPath);
    const result = await daemonApiClient.createAnnotateSession(sessionCwd, entry.latestVersionPath);
    setLaunching(false);
    if (result.ok) {
      void navigate({ to: "/s/$sessionId", params: { sessionId: result.data.session.id } });
    } else {
      toast.error("Failed to open plan", { description: result.error.message });
    }
  }, [cwd, entry.latestVersionPath, navigate]);

  const title = prettySlug(entry.slug);

  if (density === "compact") {
    return (
      <button
        type="button"
        onClick={handleOpen}
        disabled={launching}
        style={pad(0)}
        title={title}
        className={cn(ROW, launching && "opacity-60")}
      >
        <span className="size-3.5 shrink-0" aria-hidden />
        <FileClock className="size-3 shrink-0 text-muted-foreground/55" />
        <span className="truncate">{title}</span>
        <span className="ml-auto shrink-0 pl-1 text-[10px] tabular-nums text-muted-foreground/45">
          {entry.latest ? formatRelativeTime(entry.latest) : ""}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40">
          v{entry.versionCount}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      disabled={launching}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left transition-colors hover:bg-surface-1",
        launching && "opacity-60",
      )}
    >
      <FileClock className="size-4 shrink-0 text-muted-foreground/60" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {entry.project}
          {entry.worktree && (
            <>
              {" / "}
              {entry.worktree}
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {entry.latest && (
          <span className="text-[11px] text-muted-foreground">
            {formatRelativeTime(entry.latest)}
          </span>
        )}
        <span className="rounded-full bg-surface-1 px-1.5 py-px text-[10px] tabular-nums text-muted-foreground">
          v{entry.versionCount}
        </span>
      </div>
    </button>
  );
}
