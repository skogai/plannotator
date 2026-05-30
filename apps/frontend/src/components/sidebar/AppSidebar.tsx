import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight, Folder, GitBranch, Moon, Settings, Sun } from "lucide-react";
import { TaterSpriteSidebar } from "./TaterSpriteSidebar";
import { useActiveProjectCwd } from "./useActiveProjectCwd";
import { ROW, pad } from "./row-style";
import { appStore, useAppStore } from "../../stores/app-store";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useTheme } from "@plannotator/ui/components/ThemeProvider";
import { buildSessionTree } from "@plannotator/ui/utils/sessionTree";
import type {
  SessionTreeProject,
  SessionTreeWorktree,
} from "@plannotator/ui/utils/sessionTree";
import type { DaemonSessionSummary } from "@plannotator/shared/daemon-protocol";
import { useDaemonEventStore } from "../../daemon/events/event-store";
import { useProjectStore } from "../../stores/project-store";
import type { SessionSummary } from "../../daemon/contracts";
import { formatSessionLabel, getSessionModeMeta } from "../../shared/session-meta";

/** Non-terminal session statuses — the only ones the sidebar surfaces. */
const LIVE_STATUSES = new Set<string>(["active", "idle", "awaiting-resubmission"]);

const CHEVRON =
  "size-3.5 shrink-0 text-muted-foreground/45 transition-transform duration-150 " +
  "group-data-[state=open]/disc:rotate-90";

function SessionRow({
  session,
  depth,
  matchRoute,
}: {
  session: DaemonSessionSummary;
  depth: number;
  matchRoute: ReturnType<typeof useMatchRoute>;
}) {
  const isActive = !!matchRoute({
    to: "/s/$sessionId",
    params: { sessionId: session.id },
  });
  const Icon = getSessionModeMeta(session.mode).icon;
  return (
    <Link
      to="/s/$sessionId"
      params={{ sessionId: session.id }}
      style={pad(depth)}
      className={cn(
        ROW,
        isActive &&
          "bg-sidebar-accent font-medium text-sidebar-accent-foreground hover:bg-sidebar-accent",
      )}
      title={formatSessionLabel(session.label, session.mode)}
    >
      {/* spacer where a chevron would sit, so the mode icon aligns under sibling icons */}
      <span className="size-3.5 shrink-0" aria-hidden />
      <Icon className="size-3 shrink-0 text-muted-foreground/55" />
      <span className="truncate">{formatSessionLabel(session.label, session.mode)}</span>
    </Link>
  );
}

function WorktreeNode({
  worktree,
  depth,
  matchRoute,
}: {
  worktree: SessionTreeWorktree;
  depth: number;
  matchRoute: ReturnType<typeof useMatchRoute>;
}) {
  const collapsed = useAppStore((s) => s.collapsedWorktrees.has(worktree.cwd));
  const toggle = useAppStore((s) => s.toggleWorktreeCollapse);
  if (worktree.sessions.length === 0) return null;
  return (
    <Collapsible.Root open={!collapsed} onOpenChange={() => toggle(worktree.cwd)}>
      <Collapsible.Trigger
        style={pad(depth)}
        className={cn(ROW, "group/disc text-sidebar-foreground/70")}
        title={worktree.name}
      >
        <ChevronRight className={CHEVRON} />
        <GitBranch className="size-3 shrink-0 text-muted-foreground/55" />
        <span className="truncate">{worktree.name}</span>
        <span className="ml-auto pl-1 text-[10px] tabular-nums text-muted-foreground/45">
          {worktree.sessions.length}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content>
        {worktree.sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            depth={depth + 1}
            matchRoute={matchRoute}
          />
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function ProjectNode({
  project,
  isOpen,
  onToggle,
  matchRoute,
}: {
  project: SessionTreeProject;
  isOpen: boolean;
  onToggle: () => void;
  matchRoute: ReturnType<typeof useMatchRoute>;
}) {
  const liveCount =
    project.directSessions.length +
    project.worktrees.reduce((sum, wt) => sum + wt.sessions.length, 0);

  return (
    <Collapsible.Root open={isOpen} onOpenChange={onToggle}>
      <Collapsible.Trigger
        style={pad(0)}
        className={cn(ROW, "group/disc font-medium text-sidebar-foreground/90")}
        title={project.name}
      >
        <ChevronRight className={CHEVRON} />
        <Folder className="size-3.5 shrink-0 text-muted-foreground/60" />
        <span className="truncate">{project.name}</span>
        {liveCount > 0 && (
          <span className="ml-auto pl-1 text-[10px] tabular-nums text-muted-foreground/45">
            {liveCount}
          </span>
        )}
      </Collapsible.Trigger>
      <Collapsible.Content>
        {project.directSessions.map((session) => (
          <SessionRow key={session.id} session={session} depth={1} matchRoute={matchRoute} />
        ))}
        {project.worktrees.map((worktree) => (
          <WorktreeNode
            key={worktree.cwd}
            worktree={worktree}
            depth={1}
            matchRoute={matchRoute}
          />
        ))}
        {liveCount === 0 && (
          <div
            style={pad(1)}
            className="flex h-6 items-center text-[11px] text-muted-foreground/40"
          >
            No live sessions
          </div>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function AppSidebarContent() {
  const sessions = useDaemonEventStore((s) => s.sessions);
  const projects = useProjectStore((p) => p.projects);
  const expandedProjects = useAppStore((s) => s.expandedProjects);
  const toggleProjectExpand = useAppStore((s) => s.toggleProjectExpand);
  const activeProjectCwd = useActiveProjectCwd();
  const { resolvedMode, setMode } = useTheme();
  const matchRoute = useMatchRoute();

  // Live-only: exclude terminal sessions (completed/cancelled/expired/failed).
  const liveSessions = useMemo<SessionSummary[]>(
    () => sessions.filter((s) => LIVE_STATUSES.has(s.status)),
    [sessions],
  );

  // buildSessionTree only reads project/worktree placement fields, never `mode`,
  // so the (widened) SessionSummary.mode is safe to narrow at this boundary.
  const tree = useMemo(
    () => buildSessionTree(projects, liveSessions as DaemonSessionSummary[]),
    [projects, liveSessions],
  );

  // Active project is open by default — seed it into expandedProjects exactly once
  // per cwd (one-shot guard) so a later explicit collapse isn't re-opened. Effect
  // depends only on activeProjectCwd, never on expandedProjects.
  const seededProjects = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (activeProjectCwd && !seededProjects.current.has(activeProjectCwd)) {
      seededProjects.current.add(activeProjectCwd);
      appStore.getState().setProjectExpanded(activeProjectCwd, true);
    }
  }, [activeProjectCwd]);

  const toggleTheme = useCallback(() => {
    setMode(resolvedMode === "dark" ? "light" : "dark");
  }, [resolvedMode, setMode]);

  return (
    <>
      <SidebarHeader>
        <Link to="/" className="flex items-end gap-2 px-3 pt-2">
          <TaterSpriteSidebar />
          <div className="flex flex-col">
            <span
              className="text-base font-semibold tracking-tight leading-tight"
              style={{
                fontFamily: "'Instrument Sans Variable', 'Instrument Sans', system-ui, sans-serif",
              }}
            >
              Plannotator
            </span>
            <span className="text-[10px] text-muted-foreground">
              v{__APP_VERSION__} ·{" "}
              <a
                href="https://github.com/backnotprop/plannotator/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
              >
                Send feedback
              </a>
            </span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent className="gap-0 px-1 py-2">
        {tree.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground/50">
            No projects yet
          </div>
        ) : (
          tree.map((project) => (
            <ProjectNode
              key={project.cwd}
              project={project}
              isOpen={expandedProjects.has(project.cwd)}
              onToggle={() => toggleProjectExpand(project.cwd)}
              matchRoute={matchRoute}
            />
          ))
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => appStore.getState().setSettingsOpen(true)}
              tooltip="Settings"
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={toggleTheme} tooltip="Toggle theme">
              {resolvedMode === "dark" ? <Sun /> : <Moon />}
              <span>Toggle theme</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

export function AppSidebar() {
  return (
    <Sidebar collapsible="offcanvas">
      <AppSidebarContent />
    </Sidebar>
  );
}
