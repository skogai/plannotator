import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import type { SessionSummary } from "../../daemon/contracts";
import { getSessionModeMeta, formatSessionLabel } from "../../shared/session-meta";
import { ROW, pad } from "../sidebar/row-style";

/**
 * Flat (depth-0) live-session row reusing the sidebar row look. Unlike the
 * sidebar's `SessionRow`, this is not tied to a tree depth or `useMatchRoute`;
 * the conjoined view renders a flat list of sessions.
 */
export function ActiveSessionRow({ session }: { session: SessionSummary }) {
  const meta = getSessionModeMeta(session.mode);
  const Icon = meta.icon;
  const label = formatSessionLabel(session.label, session.mode);
  return (
    <Link
      to="/s/$sessionId"
      params={{ sessionId: session.id }}
      style={pad(0)}
      title={label}
      className={cn(ROW)}
    >
      <span className="size-3.5 shrink-0" aria-hidden />
      <Icon className="size-3 shrink-0 text-muted-foreground/55" />
      <span className="truncate">{label}</span>
      <span className="ml-auto shrink-0 pl-1 text-[10px] text-muted-foreground/45">
        {meta.label}
      </span>
    </Link>
  );
}
