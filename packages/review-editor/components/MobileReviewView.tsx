import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeAnnotation, CodeAnnotationType } from '@plannotator/ui/types';
import type { PRMetadata } from '@plannotator/shared/pr-provider';
import { getMRNumberLabel, getDisplayRepo } from '@plannotator/shared/pr-provider';
import type { Origin } from '@plannotator/shared/agents';
import { GitHubIcon } from '@plannotator/ui/components/GitHubIcon';
import { GitLabIcon } from '@plannotator/ui/components/GitLabIcon';
import { RepoIcon } from '@plannotator/ui/components/RepoIcon';
import { Settings } from '@plannotator/ui/components/Settings';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import type { DiffFile } from '../types';

/**
 * Mobile shell for the code review app, swapped in below the
 * `useIsMobile` breakpoint. Replaces the desktop 3-pane Dockview layout
 * with a single-column flow:
 *   - identity bar with Theme / Settings / Close
 *   - file cards (tap to expand) rendering tappable unified-diff lines
 *   - tap a changed line to start a selection, tap another to extend
 *   - sticky action bar offers Annotate / Send Feedback / Approve
 *   - bottom sheet composes the annotation; another sheet wraps Settings
 *
 * Annotation creation flows back into the existing factory via
 * `onAddAnnotation`, which `App.tsx` wires through `withPRContext` and
 * `setAnnotations` so the rest of the app (drafts, sidebar, exports)
 * sees mobile-created annotations the same as desktop ones.
 */

interface MobileReviewViewProps {
  files: DiffFile[];
  annotations: CodeAnnotation[];
  prMetadata: PRMetadata | null;
  repoInfo: { display: string; branch?: string } | null;
  origin: Origin | null;
  gitUser?: string;
  aiProviders: { id: string; name: string; capabilities: Record<string, boolean> }[];
  totalAnnotationCount: number;
  isExiting: boolean;
  isSendingFeedback: boolean;
  isApproving: boolean;
  onExit: () => void;
  onSendFeedback: () => void;
  onApprove: () => void;
  onAddAnnotation: (
    filePath: string,
    side: 'old' | 'new',
    lineStart: number,
    lineEnd: number,
    type: CodeAnnotationType,
    text: string,
  ) => void;
  onDeleteAnnotation: (id: string) => void;
  onIdentityChange: (oldIdentity: string, newIdentity: string) => void;
}

type DiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'meta';

interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNum?: number;
  newNum?: number;
}

interface MobileSelection {
  fileIdx: number;
  side: 'old' | 'new';
  start: number;
  end: number;
}

function classifyDiffLines(patch: string): DiffLine[] {
  const result: DiffLine[] = [];
  const rawLines = patch.split('\n');
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  for (const line of rawLines) {
    if (line.startsWith('@@')) {
      result.push({ kind: 'hunk', text: line });
      // Parse `@@ -oldStart,oldCount +newStart,newCount @@`.
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      result.push({ kind: 'add', text: line.slice(1), newNum: newLine });
      newLine += 1;
    } else if (line.startsWith('-')) {
      result.push({ kind: 'del', text: line.slice(1), oldNum: oldLine });
      oldLine += 1;
    } else if (line.startsWith('\\')) {
      result.push({ kind: 'meta', text: line });
    } else {
      const text = line.startsWith(' ') ? line.slice(1) : line;
      result.push({ kind: 'context', text, oldNum: oldLine, newNum: newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return result;
}

const lineClass: Record<DiffLineKind, string> = {
  add: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  del: 'bg-red-500/10 text-red-700 dark:text-red-300',
  context: 'text-foreground/80',
  hunk: 'bg-muted/40 text-muted-foreground italic',
  meta: 'text-muted-foreground/60 italic',
};

const linePrefix: Record<DiffLineKind, string> = {
  add: '+',
  del: '−',
  context: ' ',
  hunk: ' ',
  meta: ' ',
};

const TYPE_OPTIONS: { value: CodeAnnotationType; label: string; color: string }[] = [
  { value: 'comment', label: 'Comment', color: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40' },
  { value: 'suggestion', label: 'Suggestion', color: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/40' },
  { value: 'concern', label: 'Concern', color: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40' },
];

const typeBadge: Record<string, string> = {
  comment: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  suggestion: 'bg-purple-500/10 text-purple-700 dark:text-purple-300',
  concern: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
};

// ---------------------------------------------------------------------------
// File card — the per-file expandable diff with tappable lines.
// ---------------------------------------------------------------------------

interface FileCardProps {
  file: DiffFile;
  fileIdx: number;
  annotations: CodeAnnotation[];
  defaultOpen: boolean;
  selection: MobileSelection | null;
  onTapLine: (fileIdx: number, side: 'old' | 'new', lineNumber: number) => void;
  onDeleteAnnotation: (id: string) => void;
}

const FileCard: React.FC<FileCardProps> = ({
  file,
  fileIdx,
  annotations,
  defaultOpen,
  selection,
  onTapLine,
  onDeleteAnnotation,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const lines = useMemo(() => (isOpen ? classifyDiffLines(file.patch) : []), [isOpen, file.patch]);

  const fileAnnotations = useMemo(
    () => annotations.filter(a => a.filePath === file.path).sort((a, b) => a.lineStart - b.lineStart),
    [annotations, file.path],
  );

  const renamed = !!file.oldPath && file.oldPath !== file.path;

  // Auto-expand when this file is the active selection target.
  useEffect(() => {
    if (selection && selection.fileIdx === fileIdx && !isOpen) setIsOpen(true);
  }, [selection, fileIdx, isOpen]);

  const isLineSelected = useCallback(
    (side: 'old' | 'new', num: number | undefined): boolean => {
      if (!selection || num == null) return false;
      if (selection.fileIdx !== fileIdx || selection.side !== side) return false;
      return num >= selection.start && num <= selection.end;
    },
    [selection, fileIdx],
  );

  return (
    <section className="border border-border/60 rounded-lg bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        className="w-full flex items-start gap-2 p-3 text-left active:bg-muted/40 transition-colors"
      >
        <svg
          className={`w-4 h-4 flex-shrink-0 mt-0.5 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xs text-foreground break-all leading-snug">{file.path}</div>
          {renamed && (
            <div className="font-mono text-[10px] text-muted-foreground/70 break-all mt-0.5">
              renamed from {file.oldPath}
            </div>
          )}
          <div className="flex items-center gap-3 mt-1.5 text-[11px]">
            <span className="text-emerald-600 dark:text-emerald-400 font-mono">+{file.additions}</span>
            <span className="text-red-600 dark:text-red-400 font-mono">−{file.deletions}</span>
            {fileAnnotations.length > 0 && (
              <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium">
                {fileAnnotations.length} note{fileAnnotations.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
      </button>

      {isOpen && (
        <div className="border-t border-border/40">
          <div className="overflow-x-auto">
            <pre className="text-[11px] leading-relaxed font-mono py-1 min-w-fit">
              {lines.map((line, i) => {
                const tappable = line.kind === 'add' || line.kind === 'del';
                const side: 'old' | 'new' | null = line.kind === 'add' ? 'new' : line.kind === 'del' ? 'old' : null;
                const lineNum = line.kind === 'add' ? line.newNum : line.kind === 'del' ? line.oldNum : undefined;
                const selected = side ? isLineSelected(side, lineNum) : false;
                const Inner = (
                  <>
                    <span className="select-none w-8 flex-shrink-0 text-right pr-2 opacity-50 text-[10px] tabular-nums">
                      {line.kind === 'add' && line.newNum ? line.newNum : line.kind === 'del' && line.oldNum ? line.oldNum : ''}
                    </span>
                    <span className="select-none w-3 flex-shrink-0 opacity-60">{linePrefix[line.kind]}</span>
                    <span className="whitespace-pre flex-1">{line.text || ' '}</span>
                  </>
                );
                if (tappable && side && lineNum != null) {
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => onTapLine(fileIdx, side, lineNum)}
                      className={`flex w-full text-left px-1 border-l-2 ${lineClass[line.kind]} ${
                        selected ? 'border-primary ring-1 ring-primary/40' : 'border-transparent'
                      } active:opacity-70`}
                    >
                      {Inner}
                    </button>
                  );
                }
                return (
                  <div key={i} className={`flex px-1 border-l-2 border-transparent ${lineClass[line.kind]}`}>
                    {Inner}
                  </div>
                );
              })}
            </pre>
          </div>

          {fileAnnotations.length > 0 && (
            <div className="border-t border-border/40 p-3 space-y-2 bg-muted/20">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Annotations
              </div>
              {fileAnnotations.map(ann => (
                <AnnotationCard key={ann.id} annotation={ann} onDelete={onDeleteAnnotation} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

const AnnotationCard: React.FC<{
  annotation: CodeAnnotation;
  onDelete: (id: string) => void;
}> = ({ annotation, onDelete }) => {
  const range =
    annotation.lineStart === annotation.lineEnd
      ? `L${annotation.lineStart}`
      : `L${annotation.lineStart}–${annotation.lineEnd}`;
  const sideLabel = annotation.side === 'old' ? 'old' : 'new';
  const badge = typeBadge[annotation.type] ?? 'bg-muted text-muted-foreground';
  const isExternal = !!annotation.source;

  return (
    <div className="border border-border/40 rounded-md p-2.5 bg-card">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className={`text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded ${badge}`}>
          {annotation.type}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          {range} ({sideLabel})
        </span>
        <div className="ml-auto flex items-center gap-2">
          {annotation.author && <span className="text-[10px] text-muted-foreground/70">{annotation.author}</span>}
          {annotation.source && !annotation.author && (
            <span className="text-[10px] text-muted-foreground/70">{annotation.source}</span>
          )}
          {!isExternal && (
            <button
              type="button"
              onClick={() => onDelete(annotation.id)}
              aria-label="Delete annotation"
              className="text-muted-foreground/60 hover:text-destructive p-0.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 3h6a1 1 0 011 1v3H8V4a1 1 0 011-1z" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {annotation.text && (
        <div className="text-xs text-foreground/90 whitespace-pre-wrap break-words leading-relaxed">
          {annotation.text}
        </div>
      )}
      {annotation.suggestedCode && (
        <pre className="mt-2 text-[10px] font-mono bg-muted/40 rounded px-2 py-1 overflow-x-auto whitespace-pre">
          {annotation.suggestedCode}
        </pre>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Bottom sheet (annotation compose).
// ---------------------------------------------------------------------------

interface AnnotationSheetProps {
  selection: MobileSelection;
  filePath: string;
  onCancel: () => void;
  onSave: (type: CodeAnnotationType, text: string) => void;
}

const AnnotationSheet: React.FC<AnnotationSheetProps> = ({ selection, filePath, onCancel, onSave }) => {
  const [type, setType] = useState<CodeAnnotationType>('comment');
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Defer focus by a tick so the slide-in animation doesn't fight the keyboard.
    const t = setTimeout(() => textareaRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, []);

  const range =
    selection.start === selection.end
      ? `Line ${selection.start}`
      : `Lines ${selection.start}–${selection.end}`;
  const sideLabel = selection.side === 'new' ? 'additions' : 'deletions';

  const canSave = text.trim().length > 0 || type === 'concern';

  return (
    <div className="fixed inset-0 z-50 flex flex-col">
      <button
        type="button"
        aria-label="Cancel annotation"
        className="flex-1 bg-background/60 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div className="bg-card border-t border-border/60 rounded-t-xl shadow-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">New annotation</div>
            <div className="text-[11px] text-muted-foreground font-mono truncate">
              {filePath} · {range} ({sideLabel})
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-2 rounded-md text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 overflow-y-auto">
          <div className="grid grid-cols-3 gap-1.5">
            {TYPE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setType(opt.value)}
                className={`px-3 py-2 text-xs font-medium rounded-md border transition-colors ${
                  type === opt.value
                    ? opt.color
                    : 'bg-muted/40 text-muted-foreground border-border/40 active:bg-muted/60'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Write your feedback…"
            rows={5}
            className="w-full px-3 py-2 rounded-md bg-muted/40 border border-border/40 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/60 resize-none"
          />
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-border/40 bg-card/80">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-md text-sm font-medium bg-muted text-foreground active:bg-muted/70"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(type, text.trim())}
            disabled={!canSave}
            className="flex-1 py-2.5 rounded-md text-sm font-medium bg-primary text-primary-foreground active:bg-primary/90 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Theme cycle button.
// ---------------------------------------------------------------------------

const ThemeToggle: React.FC = () => {
  const { mode, setMode, resolvedMode } = useTheme();
  const next = mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system';
  const labelFor = (m: typeof mode) => (m === 'system' ? 'System' : m === 'light' ? 'Light' : 'Dark');
  return (
    <button
      type="button"
      onClick={() => setMode(next)}
      className="p-2 rounded-md text-muted-foreground active:bg-muted/60"
      aria-label={`Theme: ${labelFor(mode)} (tap for ${labelFor(next)})`}
      title={`Theme: ${labelFor(mode)}`}
    >
      {resolvedMode === 'dark' ? (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.36-6.36l-1.42 1.42M6.05 17.95l-1.41 1.41m0-13.78l1.41 1.41m11.31 11.31l1.42 1.42M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      )}
    </button>
  );
};

// ---------------------------------------------------------------------------
// Main shell.
// ---------------------------------------------------------------------------

export const MobileReviewView: React.FC<MobileReviewViewProps> = ({
  files,
  annotations,
  prMetadata,
  repoInfo,
  origin,
  gitUser,
  aiProviders,
  totalAnnotationCount,
  isExiting,
  isSendingFeedback,
  isApproving,
  onExit,
  onSendFeedback,
  onApprove,
  onAddAnnotation,
  onDeleteAnnotation,
  onIdentityChange,
}) => {
  const [selection, setSelection] = useState<MobileSelection | null>(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const mrNumberLabel = prMetadata ? getMRNumberLabel(prMetadata) : null;
  const PlatformIcon = prMetadata?.platform === 'gitlab' ? GitLabIcon : GitHubIcon;

  const handleTapLine = useCallback((fileIdx: number, side: 'old' | 'new', lineNumber: number) => {
    setSelection(prev => {
      if (!prev || prev.fileIdx !== fileIdx || prev.side !== side) {
        return { fileIdx, side, start: lineNumber, end: lineNumber };
      }
      // Same file & side. Tapping the only-selected line toggles off.
      if (prev.start === prev.end && prev.start === lineNumber) return null;
      // Inside an existing range — collapse to that single line.
      if (lineNumber >= prev.start && lineNumber <= prev.end) {
        return { ...prev, start: lineNumber, end: lineNumber };
      }
      // Otherwise extend the range to include the tapped line.
      return {
        fileIdx,
        side,
        start: Math.min(prev.start, lineNumber),
        end: Math.max(prev.end, lineNumber),
      };
    });
  }, []);

  const handleSaveAnnotation = useCallback(
    (type: CodeAnnotationType, text: string) => {
      if (!selection) return;
      const filePath = files[selection.fileIdx]?.path;
      if (!filePath) return;
      onAddAnnotation(filePath, selection.side, selection.start, selection.end, type, text);
      setSelection(null);
      setIsSheetOpen(false);
    },
    [selection, files, onAddAnnotation],
  );

  const selectionFilePath = selection ? files[selection.fileIdx]?.path : undefined;

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* ---------- Header ---------- */}
      <header className="px-3 py-2 border-b border-border/50 bg-card/80 backdrop-blur-xl flex items-center gap-1 z-10">
        <div className="min-w-0 flex-1">
          {prMetadata ? (
            <>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
                <PlatformIcon className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">
                  {getDisplayRepo(prMetadata)}
                  {mrNumberLabel && <span className="ml-1 text-muted-foreground/70">{mrNumberLabel}</span>}
                </span>
              </div>
              <div className="text-sm font-medium text-foreground truncate mt-0.5">
                {prMetadata.title}
              </div>
            </>
          ) : repoInfo ? (
            <>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
                <RepoIcon className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{repoInfo.display}</span>
              </div>
              {repoInfo.branch && (
                <div className="text-sm font-mono text-foreground truncate mt-0.5">{repoInfo.branch}</div>
              )}
            </>
          ) : (
            <div className="text-sm font-medium text-foreground">Review</div>
          )}
        </div>
        <ThemeToggle />
        <button
          type="button"
          onClick={() => setIsSettingsOpen(true)}
          className="p-2 rounded-md text-muted-foreground active:bg-muted/60"
          aria-label="Settings"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onExit}
          disabled={isExiting}
          className="ml-1 px-3 py-2 rounded-md text-xs font-medium bg-muted text-foreground active:bg-muted/70 disabled:opacity-50"
        >
          {isExiting ? '…' : 'Close'}
        </button>
      </header>

      <main className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-3 pb-24">
        {files.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-xs text-muted-foreground py-12">No changes to review.</div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 px-1 text-[11px]">
              <span className="text-muted-foreground">
                {files.length} file{files.length === 1 ? '' : 's'}
              </span>
              <span className="text-emerald-600 dark:text-emerald-400 font-mono">+{totalAdditions}</span>
              <span className="text-red-600 dark:text-red-400 font-mono">−{totalDeletions}</span>
              {totalAnnotationCount > 0 && (
                <span className="ml-auto text-primary">
                  {totalAnnotationCount} annotation{totalAnnotationCount === 1 ? '' : 's'}
                </span>
              )}
            </div>

            <div className="text-[11px] text-muted-foreground px-1">
              Tap any added or removed line to start a selection. Tap a second line to extend.
            </div>

            {files.map((file, idx) => (
              <FileCard
                key={file.path}
                file={file}
                fileIdx={idx}
                annotations={annotations}
                defaultOpen={files.length === 1 || (files.length <= 3 && idx === 0)}
                selection={selection}
                onTapLine={handleTapLine}
                onDeleteAnnotation={onDeleteAnnotation}
              />
            ))}
          </>
        )}
      </main>

      {/* ---------- Sticky bottom bar ---------- */}
      <div className="border-t border-border/50 bg-card/90 backdrop-blur-xl px-3 py-2.5 flex items-center gap-2 z-20">
        {selection ? (
          <>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-muted-foreground">
                {selection.start === selection.end
                  ? `Line ${selection.start}`
                  : `Lines ${selection.start}–${selection.end}`}{' '}
                <span className="opacity-70">({selection.side === 'new' ? 'additions' : 'deletions'})</span>
              </div>
              <div className="text-[11px] font-mono text-foreground truncate">{selectionFilePath}</div>
            </div>
            <button
              type="button"
              onClick={() => setSelection(null)}
              className="px-3 py-2 rounded-md text-xs font-medium bg-muted text-foreground active:bg-muted/70"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => setIsSheetOpen(true)}
              className="px-3 py-2 rounded-md text-xs font-medium bg-primary text-primary-foreground active:bg-primary/90"
            >
              Annotate
            </button>
          </>
        ) : (
          <>
            <div className="text-[11px] text-muted-foreground flex-1 truncate">
              {totalAnnotationCount > 0
                ? `${totalAnnotationCount} annotation${totalAnnotationCount === 1 ? '' : 's'} ready to send`
                : 'Tap a line to add an annotation'}
            </div>
            {totalAnnotationCount > 0 && (
              <button
                type="button"
                onClick={onSendFeedback}
                disabled={isSendingFeedback || isApproving || isExiting}
                className="px-3 py-2 rounded-md text-xs font-medium bg-primary text-primary-foreground active:bg-primary/90 disabled:opacity-50"
              >
                {isSendingFeedback ? 'Sending…' : `Send (${totalAnnotationCount})`}
              </button>
            )}
            <button
              type="button"
              onClick={onApprove}
              disabled={isSendingFeedback || isApproving || isExiting}
              className="px-3 py-2 rounded-md text-xs font-medium bg-emerald-600 text-white active:bg-emerald-700 disabled:opacity-50"
            >
              {isApproving ? 'Approving…' : 'Approve'}
            </button>
          </>
        )}
      </div>

      {/* ---------- Bottom sheet (annotation compose) ---------- */}
      {isSheetOpen && selection && selectionFilePath && (
        <AnnotationSheet
          selection={selection}
          filePath={selectionFilePath}
          onCancel={() => setIsSheetOpen(false)}
          onSave={handleSaveAnnotation}
        />
      )}

      {/* ---------- Settings (renders its own modal when externalOpen is true) ---------- */}
      <Settings
        taterMode={false}
        onTaterModeChange={() => {}}
        onIdentityChange={onIdentityChange}
        origin={origin}
        mode="review"
        aiProviders={aiProviders}
        gitUser={gitUser}
        externalOpen={isSettingsOpen}
        onExternalClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
};
