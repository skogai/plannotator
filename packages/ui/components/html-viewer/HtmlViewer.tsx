import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Annotation, EditorMode, ImageAttachment } from "../../types";
import { AnnotationType } from "../../types";
import { getIdentity } from "../../utils/identity";
import { AnnotationToolbar } from "../AnnotationToolbar";
import { CommentPopover } from "../CommentPopover";
import { FloatingQuickLabelPicker } from "../FloatingQuickLabelPicker";
import type { ViewerHandle } from "../Viewer";
import { useHtmlAnnotation } from "./useHtmlAnnotation";
import { ANNOTATION_HIGHLIGHT_CSS, BRIDGE_SCRIPT } from "./bridge-script";

const PREFIX = "plannotator-bridge-";

const THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--success",
  "--success-foreground",
  "--warning",
  "--warning-foreground",
  "--border",
  "--input",
  "--ring",
  "--code-bg",
  "--focus-highlight",
  "--font-sans",
  "--font-mono",
  "--radius",
] as const;

function readThemeTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const key of THEME_TOKENS) {
    const val = style.getPropertyValue(key).trim();
    if (val) tokens[key] = val;
  }
  return tokens;
}

function isLightTheme(): boolean {
  return document.documentElement.classList.contains("light");
}

export interface HtmlViewerProps {
  rawHtml: string;
  annotations: Annotation[];
  onAddAnnotation: (ann: Annotation) => void;
  onSelectAnnotation: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: EditorMode;
  globalAttachments?: ImageAttachment[];
  onAddGlobalAttachment?: (image: ImageAttachment) => void;
  onRemoveGlobalAttachment?: (path: string) => void;
  sourceInfo?: string;
}

export const HtmlViewer = forwardRef<ViewerHandle, HtmlViewerProps>(
  (
    {
      rawHtml,
      annotations,
      onAddAnnotation,
      onSelectAnnotation,
      selectedAnnotationId,
      mode,
    },
    ref,
  ) => {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [iframeHeight, setIframeHeight] = useState(600);
    const [iframeReady, setIframeReady] = useState(false);

    const srcdoc = useMemo(() => {
      const tokens = readThemeTokens();
      let themeCSS = ":root {\n";
      for (const [key, val] of Object.entries(tokens)) {
        themeCSS += `  ${key}: ${val};\n`;
      }
      themeCSS += "}\n";
      if (isLightTheme()) themeCSS += ":root { color-scheme: light; }\n:root.light, :root { }\n";

      const injection = `<style>${themeCSS}${ANNOTATION_HIGHLIGHT_CSS}</style><script>${BRIDGE_SCRIPT}</script>`;
      const headClose = rawHtml.indexOf("</head>");
      if (headClose !== -1) {
        return rawHtml.slice(0, headClose) + injection + rawHtml.slice(headClose);
      }
      return injection + rawHtml;
    }, [rawHtml]);

    const handleResize = useCallback((height: number) => {
      setIframeHeight(height + 32);
    }, []);

    const hook = useHtmlAnnotation({
      iframeRef,
      annotations,
      onAddAnnotation,
      onSelectAnnotation,
      selectedAnnotationId,
      mode,
      onResize: handleResize,
    });

    useEffect(() => {
      function handler(e: MessageEvent) {
        if (e.data?.type === `${PREFIX}ready`) {
          setIframeReady(true);
        }
      }
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    }, []);

    useEffect(() => {
      if (!iframeReady) return;
      if (annotations.length > 0) {
        hook.applyAnnotations(annotations);
      }
    }, [iframeReady]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
      if (!iframeReady) return;
      function sendTheme() {
        const tokens = readThemeTokens();
        iframeRef.current?.contentWindow?.postMessage(
          { type: `${PREFIX}theme`, tokens, isLight: isLightTheme() },
          "*",
        );
      }
      sendTheme();
      const observer = new MutationObserver(sendTheme);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      return () => observer.disconnect();
    }, [iframeReady]);

    useImperativeHandle(ref, () => ({
      removeHighlight: hook.removeHighlight,
      clearAllHighlights: hook.clearAllHighlights,
      applySharedAnnotations: hook.applyAnnotations,
    }));

    const handleGlobalComment = useCallback(() => {
      onAddAnnotation({
        id: `html-ann-${Date.now()}`,
        blockId: "",
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.GLOBAL_COMMENT,
        text: "",
        originalText: "",
        author: getIdentity(),
        createdA: Date.now(),
      });
    }, [onAddAnnotation]);

    return (
      <>
        <article
          data-print-region="article"
          className="relative bg-card rounded-xl shadow-xl overflow-hidden"
        >
          {/* Global comment action bar */}
          <div className="flex items-center justify-end gap-2 px-4 py-2 border-b border-border/50">
            <button
              type="button"
              onClick={handleGlobalComment}
              className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              + Global Comment
            </button>
          </div>

          <iframe
            ref={iframeRef}
            srcDoc={srcdoc}
            sandbox="allow-scripts allow-same-origin"
            style={{
              width: "100%",
              height: `${iframeHeight}px`,
              border: "none",
              display: "block",
              colorScheme: "auto",
            }}
            title="HTML Plan Viewer"
          />
        </article>

        {/* Toolbar portal */}
        {hook.toolbarState &&
          createPortal(
            <AnnotationToolbar
              mode="center-above"
              anchorEl={hook.toolbarState.element}
              onAnnotate={hook.handleAnnotate}
              onRequestComment={hook.handleRequestComment}
              onQuickLabel={hook.handleQuickLabel}
              onClose={hook.handleToolbarClose}
            />,
            document.body,
          )}

        {/* Comment popover portal */}
        {hook.commentPopover &&
          createPortal(
            <CommentPopover
              anchorEl={hook.commentPopover.anchorEl}
              contextText={hook.commentPopover.contextText}
              initialText={hook.commentPopover.initialText}
              onSubmit={hook.handleCommentSubmit}
              onClose={hook.handleCommentClose}
            />,
            document.body,
          )}

        {/* Quick label picker portal */}
        {hook.quickLabelPicker &&
          createPortal(
            <FloatingQuickLabelPicker
              anchorEl={hook.quickLabelPicker.anchorEl}
              cursorHint={hook.quickLabelPicker.cursorHint}
              onSelect={hook.handleFloatingQuickLabel}
              onDismiss={hook.handleQuickLabelPickerDismiss}
            />,
            document.body,
          )}
      </>
    );
  },
);

HtmlViewer.displayName = "HtmlViewer";
