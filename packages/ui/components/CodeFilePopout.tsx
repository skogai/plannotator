import React, { useState, useEffect, useMemo } from 'react';
import { File } from '@pierre/diffs/react';
import { PopoutDialog } from './PopoutDialog';
import { useTheme } from './ThemeProvider';

interface CodeFilePopoutProps {
  open: boolean;
  onClose: () => void;
  filepath: string;
  contents: string;
  prerenderedHTML?: string;
  container?: HTMLElement | null;
}

function getThemeColors(): { bg: string; fg: string } {
  try {
    const styles = getComputedStyle(document.documentElement);
    return {
      bg: styles.getPropertyValue('--background').trim(),
      fg: styles.getPropertyValue('--foreground').trim(),
    };
  } catch {
    return { bg: '', fg: '' };
  }
}

function buildPierreCSS(mode: 'dark' | 'light', bg: string, fg: string): string {
  if (!bg || !fg) return '';
  return `
    :host {
      color-scheme: ${mode};
      height: 100% !important;
    }
    :host, [data-diff], [data-file], [data-diffs-header], [data-error-wrapper], [data-virtualizer-buffer] {
      --diffs-bg: ${bg} !important;
      --diffs-fg: ${fg} !important;
      --diffs-dark-bg: ${bg};
      --diffs-light-bg: ${bg};
      --diffs-dark: ${fg};
      --diffs-light: ${fg};
    }
    pre, code { background-color: ${bg} !important; }
    [data-column-number] { background-color: ${bg} !important; }
    [data-file] { height: 100% !important; }
    [data-code] { height: 100% !important; overflow-y: auto !important; }
  `;
}

export const CodeFilePopout: React.FC<CodeFilePopoutProps> = ({
  open,
  onClose,
  filepath,
  contents,
  prerenderedHTML,
  container,
}) => {
  const { resolvedMode } = useTheme();
  const mode = resolvedMode ?? 'dark';
  const colors = getThemeColors();
  const [pierreTheme, setPierreTheme] = useState(() => ({
    type: mode as 'dark' | 'light',
    css: buildPierreCSS(mode, colors.bg, colors.fg),
  }));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => {
      const c = getThemeColors();
      setPierreTheme({
        type: mode,
        css: buildPierreCSS(mode, c.bg, c.fg),
      });
    });
  }, [mode]);

  const displayName = filepath.split('/').pop() || filepath;
  const relativePath = filepath.replace(/.*\/(?=.*\/)/, '');
  const lineCount = useMemo(() => contents.split('\n').length, [contents]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(contents);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <PopoutDialog
      open={open}
      onClose={onClose}
      title={displayName}
      container={container}
      className="w-[calc(100vw-4rem)] max-w-[min(calc(100vw-4rem),1500px)] h-[calc(100vh-4rem)]"
    >
      <div className="flex items-center gap-3 px-5 pt-4 pb-3 pr-12">
        <div className="flex items-center gap-2 min-w-0">
          <svg className="w-4 h-4 flex-shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
          <span className="text-sm font-medium text-foreground truncate" title={filepath}>
            {relativePath}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {lineCount} lines
          </span>
          <button
            onClick={handleCopy}
            title={copied ? 'Copied!' : 'Copy file contents'}
            className={`p-1.5 rounded-md transition-colors ${
              copied ? 'text-success' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {copied ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      <div className="border-t border-border/30" />
      <div className="flex-1 min-h-0">
        <File
          key={filepath}
          file={{ name: displayName, contents }}
          prerenderedHTML={prerenderedHTML}
          className="h-full"
          style={{
            '--diffs-dark-bg': colors.bg,
            '--diffs-light-bg': colors.bg,
            '--diffs-dark': colors.fg,
            '--diffs-light': colors.fg,
          } as React.CSSProperties}
          options={{
            themeType: pierreTheme.type,
            unsafeCSS: pierreTheme.css,
            overflow: 'scroll',
            disableFileHeader: true,
            enableLineSelection: true,
          }}
        />
      </div>
    </PopoutDialog>
  );
};
