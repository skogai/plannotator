import * as Popover from '@radix-ui/react-popover';
import type { ChatContextStrategy } from '../hooks/useAIChat';

interface ContextBadgeProps {
  strategy: ChatContextStrategy | null;
  isReconnecting: boolean;
}

const BADGE_CLASSES =
  'text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/15 transition-colors cursor-pointer';

const PILL_CLASSES =
  'text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground opacity-60';

const POPOVER_CLASSES =
  'z-50 rounded-md border border-border bg-popover text-popover-foreground p-3 text-xs shadow-md min-w-[260px] max-w-[360px]';

function shortId(id: string | undefined, len = 7): string {
  if (!id) return '';
  if (id.length <= len) return id;
  return id.slice(0, len);
}

function labelFor(strategy: ChatContextStrategy | null): string {
  if (!strategy) return 'Fresh chat';
  switch (strategy.kind) {
    case 'fork_by_id': {
      const id = shortId(strategy.sessionId);
      const harness = harnessLabel(strategy.harness);
      return id ? `Forked from ${harness} session ${id}` : `Forked from ${harness}`;
    }
    case 'fork_by_heuristic': {
      const harness = harnessLabel(strategy.harness);
      return `Forked from ${harness} (matched by cwd)`;
    }
    case 'resume_by_id': {
      const id = shortId(strategy.threadId);
      const harness = harnessLabel(strategy.harness);
      return id ? `Resumed ${harness} thread ${id}` : `Resumed ${harness}`;
    }
    case 'fresh':
      return 'Fresh chat — no prior context';
    default:
      return `Chat (${(strategy as { kind: string }).kind})`;
  }
}

function harnessLabel(harness: string | undefined): string {
  switch (harness) {
    case 'claude-code':
      return 'Claude';
    case 'opencode':
      return 'OpenCode';
    case 'codex':
      return 'Codex';
    case 'pi':
      return 'Pi';
    case 'vscode':
      return 'VS Code';
    case 'standalone':
      return 'standalone';
    default:
      return harness ?? 'agent';
  }
}

export function ContextBadge({ strategy, isReconnecting }: ContextBadgeProps) {
  const label = labelFor(strategy);

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button type="button" className={BADGE_CLASSES} aria-label="Chat context details">
            {label}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className={POPOVER_CLASSES}
            side="bottom"
            align="start"
            sideOffset={4}
          >
            <ContextDetails strategy={strategy} />
            <Popover.Arrow className="fill-border" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {isReconnecting && <span className={PILL_CLASSES}>Reconnecting…</span>}
    </div>
  );
}

function ContextDetails({ strategy }: { strategy: ChatContextStrategy | null }) {
  if (!strategy) {
    return (
      <div className="space-y-1.5">
        <div className="font-semibold text-[11px] uppercase tracking-wider">Context</div>
        <div>No strategy resolved. The chat started fresh.</div>
      </div>
    );
  }

  const rows: Array<[string, string | undefined]> = [
    ['Strategy', strategy.kind],
    ['Harness', strategy.harness],
  ];
  if (strategy.kind === 'fork_by_id') {
    rows.push(['Session id', strategy.sessionId]);
  } else if (strategy.kind === 'fork_by_heuristic') {
    rows.push(['Matched cwd', strategy.cwd]);
  } else if (strategy.kind === 'resume_by_id') {
    rows.push(['Thread id', strategy.threadId]);
  } else if (strategy.kind === 'fresh') {
    rows.push(['Reason', strategy.reason]);
  }

  return (
    <div className="space-y-1">
      <div className="font-semibold text-[11px] uppercase tracking-wider mb-2">
        Chat context
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <span className="text-muted-foreground min-w-[74px]">{k}</span>
          <span className="font-mono break-all">{v || '—'}</span>
        </div>
      ))}
    </div>
  );
}
