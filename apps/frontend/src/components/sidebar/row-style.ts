/**
 * Shared sidebar row styling. Lifted out of `AppSidebar.tsx` so the conjoined
 * sessions+history surface can render Active rows with the exact same look
 * without coupling to the sidebar's tree-row component (which depends on
 * `useMatchRoute` and `DaemonSessionSummary`).
 */

/** One disclosure-width per nesting level; depth-based left pad is the only indent. */
export const INDENT = 14;
export const pad = (depth: number) => ({ paddingLeft: `${8 + depth * INDENT}px` });

/** Shared compact row. ~26px tall, single-line, truncating. */
export const ROW =
  "group/row flex h-[26px] w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs " +
  "text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent/50";
