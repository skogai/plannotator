import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { type Origin, getAgentName } from '@plannotator/shared/agents';
import { parseMarkdownToBlocks, exportAnnotations, exportLinkedDocAnnotations, exportEditorAnnotations, extractFrontmatter, wrapFeedbackForAgent, Frontmatter } from '@plannotator/ui/utils/parser';
import { Viewer, ViewerHandle } from '@plannotator/ui/components/Viewer';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { ExportModal } from '@plannotator/ui/components/ExportModal';
import { ImportModal } from '@plannotator/ui/components/ImportModal';
import { ConfirmDialog } from '@plannotator/ui/components/ConfirmDialog';
import { Annotation, Block, EditorMode, type InputMethod, type ImageAttachment, type ActionsLabelMode } from '@plannotator/ui/types';
import { AnnotationToolstrip } from '@plannotator/ui/components/AnnotationToolstrip';
import { StickyHeaderLane } from '@plannotator/ui/components/StickyHeaderLane';
import { TaterSpriteRunning } from '@plannotator/ui/components/TaterSpriteRunning';
import { TaterSpritePullup } from '@plannotator/ui/components/TaterSpritePullup';
import { Settings } from '@plannotator/ui/components/Settings';
import { FeedbackButton, ApproveButton, ExitButton } from '@plannotator/ui/components/ToolbarButtons';
import { useSharing } from '@plannotator/ui/hooks/useSharing';
import { getCallbackConfig, CallbackAction, executeCallback, type ToastPayload } from '@plannotator/ui/utils/callback';
import { useAgents } from '@plannotator/ui/hooks/useAgents';
import { useActiveSection } from '@plannotator/ui/hooks/useActiveSection';
import { storage } from '@plannotator/ui/utils/storage';
import {
  getIdentity,
  getPresenceColor,
} from '@plannotator/ui/utils/identity';
import { configStore } from '@plannotator/ui/config';
import { CompletionOverlay } from '@plannotator/ui/components/CompletionOverlay';
import { UpdateBanner } from '@plannotator/ui/components/UpdateBanner';
import { getObsidianSettings, getEffectiveVaultPath, isObsidianConfigured, CUSTOM_PATH_SENTINEL } from '@plannotator/ui/utils/obsidian';
import { getBearSettings } from '@plannotator/ui/utils/bear';
import { getOctarineSettings, isOctarineConfigured } from '@plannotator/ui/utils/octarine';
import { getDefaultNotesApp } from '@plannotator/ui/utils/defaultNotesApp';
import { getAgentSwitchSettings, getEffectiveAgentName } from '@plannotator/ui/utils/agentSwitch';
import { getPlanSaveSettings } from '@plannotator/ui/utils/planSave';
import { getUIPreferences, type UIPreferences, type PlanWidth } from '@plannotator/ui/utils/uiPreferences';
import { getEditorMode, saveEditorMode } from '@plannotator/ui/utils/editorMode';
import { getInputMethod, saveInputMethod } from '@plannotator/ui/utils/inputMethod';
import { useInputMethodSwitch } from '@plannotator/ui/hooks/useInputMethodSwitch';
import { usePrintMode } from '@plannotator/ui/hooks/usePrintMode';
import { useResizablePanel } from '@plannotator/ui/hooks/useResizablePanel';
import { ResizeHandle } from '@plannotator/ui/components/ResizeHandle';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { ScrollViewportContext } from '@plannotator/ui/hooks/useScrollViewport';
import { useOverlayViewport } from '@plannotator/ui/hooks/useOverlayViewport';
import { PlanHeaderMenu } from '@plannotator/ui/components/PlanHeaderMenu';
import {
  getPermissionModeSettings,
  needsPermissionModeSetup,
  type PermissionMode,
} from '@plannotator/ui/utils/permissionMode';
import { PermissionModeSetup } from '@plannotator/ui/components/PermissionModeSetup';
import { ImageAnnotator } from '@plannotator/ui/components/ImageAnnotator';
import { deriveImageName } from '@plannotator/ui/components/AttachmentsButton';
import { useSidebar } from '@plannotator/ui/hooks/useSidebar';
import { usePlanDiff, type VersionInfo } from '@plannotator/ui/hooks/usePlanDiff';
import { useLinkedDoc } from '@plannotator/ui/hooks/useLinkedDoc';
import { useAnnotationDraft } from '@plannotator/ui/hooks/useAnnotationDraft';
import { useArchive } from '@plannotator/ui/hooks/useArchive';
import { useEditorAnnotations } from '@plannotator/ui/hooks/useEditorAnnotations';
import { useExternalAnnotations } from '@plannotator/ui/hooks/useExternalAnnotations';
import { useExternalAnnotationHighlights } from '@plannotator/ui/hooks/useExternalAnnotationHighlights';
import { useAnnotationHighlightReconciler } from '@plannotator/ui/hooks/useAnnotationHighlightReconciler';
import { useRoomAdminActions } from '@plannotator/ui/hooks/collab/useRoomAdminActions';
import { RoomHeaderControls } from '@plannotator/ui/components/collab/RoomHeaderControls';
import { RoomAdminErrorToast } from '@plannotator/ui/components/collab/RoomAdminErrorToast';
import { ImageStripNotice } from '@plannotator/ui/components/collab/ImageStripNotice';
import { buildPlanAgentInstructions } from '@plannotator/ui/utils/planAgentInstructions';
import { buildRoomAgentInstructions } from '@plannotator/ui/utils/roomAgentInstructions';
import { hasNewSettings, markNewSettingsSeen } from '@plannotator/ui/utils/newSettingsHint';
import { useFileBrowser } from '@plannotator/ui/hooks/useFileBrowser';
import { isVaultBrowserEnabled } from '@plannotator/ui/utils/obsidian';
import { isFileBrowserEnabled, getFileBrowserSettings } from '@plannotator/ui/utils/fileBrowser';
import { SidebarTabs } from '@plannotator/ui/components/sidebar/SidebarTabs';
import { SidebarContainer } from '@plannotator/ui/components/sidebar/SidebarContainer';
import type { ArchivedPlan } from '@plannotator/ui/components/sidebar/ArchiveBrowser';
import { PlanDiffViewer } from '@plannotator/ui/components/plan-diff/PlanDiffViewer';
import type { PlanDiffMode } from '@plannotator/ui/components/plan-diff/PlanDiffModeSwitcher';
import { DEMO_PLAN_CONTENT } from './demoPlan';
import { useCheckboxOverrides, derivePendingCheckboxBlockIds } from './hooks/useCheckboxOverrides';
import { useAnnotationController } from '@plannotator/ui/hooks/useAnnotationController';
import { StartRoomModal } from '@plannotator/ui/components/collab/StartRoomModal';
import { useStartLiveRoom } from './hooks/collab/useStartLiveRoom';

type NoteAutoSaveResults = {
  obsidian?: boolean;
  bear?: boolean;
  octarine?: boolean;
};

export interface AppProps {
  /**
   * When provided, the editor runs in room mode: annotation mutations
   * route through the room client and the `/api/plan` fetch is
   * skipped (the plan arrives from the encrypted room snapshot
   * instead). Approve and Deny are local-only — they are never
   * offered in room mode — so passing this prop does not change the
   * approve/deny flow.
   *
   * AppRoot is the only caller that should pass this; plain
   * consumers mounting `<App />` get local mode unchanged.
   */
  roomSession?: import('@plannotator/ui/hooks/collab/useCollabRoomSession').UseCollabRoomSessionReturn;
}

const App: React.FC<AppProps> = ({ roomSession }) => {
  const roomModeActive = !!roomSession?.room;
  const [markdown, setMarkdown] = useState(
    roomModeActive ? '' : DEMO_PLAN_CONTENT,
  );

  // Room admin actions: lock / unlock / delete. Pending + error state
  // live here (not in `RoomApp`) because the controls render in the
  // editor header alongside everything else App owns. The error slot
  // is surfaced via a toast at the bottom of the layout.
  const roomAdmin = useRoomAdminActions(roomSession?.room);

  // Stripped-image handoff count from the creator-origin fragment
  // (`&stripped=N`). AppRoot reads and strips the fragment param on
  // mount, stashing the number on `window.__PLANNOTATOR_STRIPPED_IMAGES__`.
  // The initializer is PURE; the consume-once effect below clears the
  // global so a later App remount doesn't re-show the notice. Pattern
  // matches the previous RoomApp implementation — see its commit
  // history for the StrictMode double-run trap this avoids.
  const [strippedImagesCount, setStrippedImagesCount] = useState<number>(() => {
    if (!roomModeActive || typeof window === 'undefined') return 0;
    const w = window as { __PLANNOTATOR_STRIPPED_IMAGES__?: number };
    return w.__PLANNOTATOR_STRIPPED_IMAGES__ ?? 0;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as { __PLANNOTATOR_STRIPPED_IMAGES__?: number };
    if (w.__PLANNOTATOR_STRIPPED_IMAGES__ !== undefined) {
      delete w.__PLANNOTATOR_STRIPPED_IMAGES__;
    }
  }, []);
  // Annotation state lives behind a uniform controller. In local mode it
  // wraps useState; in room mode it delegates to useCollabRoom, with
  // `pending` tracking sends awaiting echo and `failed` holding ids whose
  // last send rejected. `setAnnotations` is retained as a name pointing at
  // `controller.setAll` — undefined in room mode, so the few downstream
  // consumers that ATOMIC-replace (useSharing import, draft restore, linked
  // doc switch) degrade to no-ops in room mode. Those flows are not
  // supported inside a live room.
  const annotationController = useAnnotationController({
    initial: [],
    room: roomSession?.room,
  });
  const { annotations } = annotationController;
  const setAnnotations: React.Dispatch<React.SetStateAction<Annotation[]>> =
    annotationController.setAll ??
    ((_: React.SetStateAction<Annotation[]>) => {
      // In room mode the controller has no replace-all primitive. Silently
      // drop — every caller that relies on atomic replace is already
      // guarded upstream (share import is disabled in room mode; draft
      // restore triggers only in local mode; linked doc switch exits room
      // mode first).
    });

  // Sync the plan markdown from the encrypted room snapshot. `room.planMarkdown`
  // is empty string until the snapshot decrypts; we only overwrite local
  // markdown when we have non-empty room plan content, so a late snapshot
  // doesn't clobber the initial empty string render noisily.
  useEffect(() => {
    if (!roomSession?.room) return;
    const plan = roomSession.room.planMarkdown;
    if (plan && plan !== markdown) setMarkdown(plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomSession?.room?.planMarkdown]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [frontmatter, setFrontmatter] = useState<Frontmatter | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFeedbackPrompt, setShowFeedbackPrompt] = useState(false);
  const [showClaudeCodeWarning, setShowClaudeCodeWarning] = useState(false);
  const [showExitWarning, setShowExitWarning] = useState(false);
  const [showAgentWarning, setShowAgentWarning] = useState(false);
  const [agentWarningMessage, setAgentWarningMessage] = useState('');
  const [isPanelOpen, setIsPanelOpen] = useState(() => window.innerWidth >= 768);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [hasNewSettingsHints, setHasNewSettingsHints] = useState(() => hasNewSettings());
  const [editorMode, setEditorMode] = useState<EditorMode>(getEditorMode);
  const [inputMethod, setInputMethod] = useState<InputMethod>(getInputMethod);
  const [taterMode, setTaterMode] = useState(() => {
    const stored = storage.getItem('plannotator-tater-mode');
    return stored === 'true';
  });
  const [uiPrefs, setUiPrefs] = useState(() => getUIPreferences());

  // Plan-area width (inside the OverlayScrollArea, after sidebar/panel
  // shrinkage) drives the action button label compactness. ResizeObserver
  // fires every frame during a resize drag, so we store only the BUCKET
  // ('full' | 'short' | 'icon') in state — App.tsx then re-renders at
  // most twice across an entire drag (once per threshold crossing) instead
  // of on every pixel, which would chug the whole tree.
  //
  //   full  → "Global comment" / "Copy plan"  — fits when planArea >= 800
  //   short → "Comment" / "Copy"              — fits when planArea >= 680
  //   icon  → labels hidden                    — fallback below that
  const planAreaRef = useRef<HTMLDivElement>(null);
  const [actionsLabelMode, setActionsLabelMode] = useState<ActionsLabelMode>('full');
  // useLayoutEffect + synchronous getBoundingClientRect so the initial
  // bucket is set before the browser paints. Otherwise narrow viewports
  // get a one-frame flash of "Global comment"/"Copy plan" labels before
  // the ResizeObserver callback collapses them.
  useLayoutEffect(() => {
    const el = planAreaRef.current;
    if (!el) return;
    const bucket = (w: number): ActionsLabelMode =>
      w >= 800 ? 'full' : w >= 680 ? 'short' : 'icon';
    setActionsLabelMode(bucket(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => {
      const next = bucket(entry.contentRect.width);
      setActionsLabelMode((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [isApiMode, setIsApiMode] = useState(false);
  // Approve / Deny are a LOCAL (same-origin) capability. In room mode
  // the editor is served from room.plannotator.ai, which has no
  // path to the blocked agent hook — so the buttons aren't offered
  // there, even for admins. Decisions are made from the creator's
  // localhost tab; room-side feedback flows back via the existing
  // import paths (share hash / paste short URL / "Copy consolidated
  // feedback" → paste). If a future change wants a room-origin
  // approve path, it has to change THIS line.
  const approveDenyAvailable = isApiMode;
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [gitUser, setGitUser] = useState<string | undefined>();
  const [isWSL, setIsWSL] = useState(false);
  const [globalAttachments, setGlobalAttachments] = useState<ImageAttachment[]>([]);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [annotateSource, setAnnotateSource] = useState<'file' | 'message' | 'folder' | null>(null);
  const [sourceInfo, setSourceInfo] = useState<string | undefined>();
  const [sourceFilePath, setSourceFilePath] = useState<string | undefined>();
  const [imageBaseDir, setImageBaseDir] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [submitted, setSubmitted] = useState<'approved' | 'denied' | 'exited' | null>(null);
  /** Visible error message for failed approve/deny. Cleared on next attempt. */
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingPasteImage, setPendingPasteImage] = useState<{ file: File; blobUrl: string; initialName: string } | null>(null);
  const [showPermissionModeSetup, setShowPermissionModeSetup] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [sharingEnabled, setSharingEnabled] = useState(true);
  const [shareBaseUrl, setShareBaseUrl] = useState<string | undefined>(undefined);
  const [pasteApiUrl, setPasteApiUrl] = useState<string | undefined>(undefined);
  const [repoInfo, setRepoInfo] = useState<{ display: string; branch?: string } | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);

  useEffect(() => {
    document.title = repoInfo ? `${repoInfo.display} · Plannotator` : "Plannotator";
  }, [repoInfo]);

  const [initialExportTab, setInitialExportTab] = useState<'share' | 'annotations' | 'notes'>();
  const [noteSaveToast, setNoteSaveToast] = useState<ToastPayload>(null);
  const [isPlanDiffActive, setIsPlanDiffActive] = useState(false);
  const [planDiffMode, setPlanDiffMode] = useState<PlanDiffMode>('clean');
  const [previousPlan, setPreviousPlan] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);

  const viewerRef = useRef<ViewerHandle>(null);
  // Monotonic generation driven by Viewer's highlight-surface lifecycle
  // (init + `clearAllHighlights`). Reconcilers that track which annotation
  // IDs are already materialized as DOM marks watch this value so they
  // repaint from scratch when the underlying surface is reset out from
  // under them (e.g. share-import wiping the DOM via clearAllHighlights).
  //
  // The counter is parent-owned on purpose: if the Viewer remounts (key
  // change, conditional render) and emitted its own first-mount number
  // again, React's setState bailout would silently drop the update and
  // the reconciler's applied map would stay stale. The Viewer just emits
  // "I reset" and we bump here.
  const [highlightSurfaceGeneration, setHighlightSurfaceGeneration] = useState(0);
  const bumpHighlightSurfaceGeneration = useCallback(() => {
    setHighlightSurfaceGeneration(g => g + 1);
  }, []);
  // containerRef + scrollViewport both point at the OverlayScrollbars
  // viewport element (the node that actually scrolls), not the <main>
  // host. Consumers: useActiveSection (IntersectionObserver root) and
  // everything reading ScrollViewportContext.
  const {
    ref: containerRef,
    viewport: scrollViewport,
    onViewportReady: handleViewportReady,
  } = useOverlayViewport();

  // Expose the scroll viewport to sibling components outside App's
  // React tree (LocalPresenceEmitter, RemoteCursorLayer — both live
  // in RoomApp as React-siblings of App, so they can't consume
  // `ScrollViewportContext`). They use content coordinates for
  // remote cursor presence: "pointer at pixel (x, y) inside the
  // scrolling content" is the one coordinate space that stays
  // consistent across participants regardless of scroll / window
  // size / zoom. Tagging the element with a data attribute lets
  // those components `document.querySelector` for it — ugly
  // coupling, but the alternative (hoisting presence components
  // into App, or threading the ref back up through `renderEditor`)
  // would be a bigger refactor for a localized win. Exactly one
  // element carries the attribute (one App instance per page).
  useEffect(() => {
    if (!scrollViewport) return;
    scrollViewport.dataset.planScrollViewport = '';
    return () => {
      // Clean up on unmount so a later App mount (e.g. HMR) doesn't
      // have two elements briefly claiming the role.
      delete scrollViewport.dataset.planScrollViewport;
    };
  }, [scrollViewport]);

  usePrintMode();

  // Resizable panels
  const panelResize = useResizablePanel({ storageKey: 'plannotator-panel-width' });
  const tocResize = useResizablePanel({
    storageKey: 'plannotator-toc-width',
    defaultWidth: 240, minWidth: 160, maxWidth: 400, side: 'left',
  });
  const isResizing = panelResize.isDragging || tocResize.isDragging;

  // Sidebar (shared TOC + Version Browser)
  const sidebar = useSidebar(getUIPreferences().tocEnabled);

  // Sync sidebar open state when preference changes in Settings
  useEffect(() => {
    if (uiPrefs.tocEnabled) {
      sidebar.open('toc');
    } else {
      sidebar.close();
    }
  }, [uiPrefs.tocEnabled]);

  // Clear diff view when switching away from versions tab
  useEffect(() => {
    if (sidebar.activeTab === 'toc' && isPlanDiffActive) {
      setIsPlanDiffActive(false);
    }
  }, [sidebar.activeTab]);

  // Clear diff view on Escape key
  useEffect(() => {
    if (!isPlanDiffActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPlanDiffActive(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isPlanDiffActive]);

  // Plan diff computation
  const planDiff = usePlanDiff(markdown, previousPlan, versionInfo);

  // Linked document navigation
  const linkedDocHook = useLinkedDoc({
    markdown, annotations, selectedAnnotationId, globalAttachments,
    setMarkdown, setAnnotations, setSelectedAnnotationId, setGlobalAttachments,
    viewerRef, sidebar, sourceFilePath,
  });

  // Archive browser
  const archive = useArchive({
    markdown, viewerRef, linkedDocHook,
    setMarkdown, setAnnotations, setSelectedAnnotationId, setSubmitted,
  });

  // Markdown file browser (also handles vault dirs via isVault flag)
  const fileBrowser = useFileBrowser();
  const vaultPath = useMemo(() => {
    if (!isVaultBrowserEnabled()) return '';
    return getEffectiveVaultPath(getObsidianSettings());
  }, [uiPrefs]);
  const showFilesTab = useMemo(
    () => !!projectRoot || isFileBrowserEnabled() || isVaultBrowserEnabled(),
    [projectRoot, uiPrefs]
  );
  const fileBrowserDirs = useMemo(() => {
    const projectDirs = projectRoot ? [projectRoot] : [];
    const userDirs = isFileBrowserEnabled()
      ? getFileBrowserSettings().directories
      : [];
    return [...new Set([...projectDirs, ...userDirs])];
  }, [projectRoot, uiPrefs]);

  // Clear active file when file browser is disabled
  useEffect(() => {
    if (!showFilesTab) fileBrowser.setActiveFile(null);
  }, [showFilesTab]);

  // When vault is disabled, prune any stale vault dirs immediately
  useEffect(() => {
    if (!vaultPath) fileBrowser.clearVaultDirs();
  }, [vaultPath]);

  useEffect(() => {
    if (sidebar.activeTab === 'files' && showFilesTab) {
      // Load regular dirs
      if (fileBrowserDirs.length > 0) {
        const regularLoaded = fileBrowser.dirs.filter(d => !d.isVault).map(d => d.path);
        const needsRegular = fileBrowserDirs.some(d => !regularLoaded.includes(d))
          || regularLoaded.some(d => !fileBrowserDirs.includes(d));
        if (needsRegular) fileBrowser.fetchAll(fileBrowserDirs);
      }
      // Load vault dir; addVaultDir atomically replaces any existing vault entry so
      // switching vault paths never accumulates stale sections
      if (vaultPath && !fileBrowser.dirs.find(d => d.isVault && d.path === vaultPath && !d.error)) {
        fileBrowser.addVaultDir(vaultPath);
      }
    }
  }, [sidebar.activeTab, showFilesTab, fileBrowserDirs, vaultPath]);

  // File browser file selection: open via linked doc system
  // For vault dirs (isVault), use the Obsidian doc endpoint; otherwise use generic /api/doc
  const handleFileBrowserSelect = React.useCallback((absolutePath: string, dirPath: string) => {
    const dirState = fileBrowser.dirs.find(d => d.path === dirPath);
    const buildUrl = dirState?.isVault
      ? (path: string) => `/api/reference/obsidian/doc?vaultPath=${encodeURIComponent(dirPath)}&path=${encodeURIComponent(path)}`
      : (path: string) => `/api/doc?path=${encodeURIComponent(path)}&base=${encodeURIComponent(dirPath)}`;
    linkedDocHook.open(absolutePath, buildUrl, 'files');
    fileBrowser.setActiveFile(absolutePath);
  }, [linkedDocHook, fileBrowser]);

  // Route linked doc opens through the correct endpoint based on current context
  const handleOpenLinkedDoc = React.useCallback((docPath: string) => {
    const activeDirState = fileBrowser.dirs.find(d => d.path === fileBrowser.activeDirPath);
    if (activeDirState?.isVault && fileBrowser.activeDirPath) {
      linkedDocHook.open(docPath, (path) =>
        `/api/reference/obsidian/doc?vaultPath=${encodeURIComponent(fileBrowser.activeDirPath!)}&path=${encodeURIComponent(path)}`
      );
    } else if (fileBrowser.activeFile && fileBrowser.activeDirPath) {
      // When viewing a file browser doc, resolve links relative to current file's directory
      const baseDir = linkedDocHook.filepath?.replace(/\/[^/]+$/, '') || fileBrowser.activeDirPath;
      linkedDocHook.open(docPath, (path) =>
        `/api/doc?path=${encodeURIComponent(path)}&base=${encodeURIComponent(baseDir)}`
      );
    } else {
      // Pass the current file's directory as base for relative path resolution
      const baseDir = linkedDocHook.filepath
        ? linkedDocHook.filepath.replace(/\/[^/]+$/, '')
        : imageBaseDir;
      if (baseDir) {
        linkedDocHook.open(docPath, (path) =>
          `/api/doc?path=${encodeURIComponent(path)}&base=${encodeURIComponent(baseDir)}`
        );
      } else {
        linkedDocHook.open(docPath);
      }
    }
  }, [fileBrowser.dirs, fileBrowser.activeDirPath, fileBrowser.activeFile, linkedDocHook, imageBaseDir]);

  // Wrap linked doc back to also clear file browser active file
  const handleLinkedDocBack = React.useCallback(() => {
    linkedDocHook.back();
    fileBrowser.setActiveFile(null);
    archive.clearSelection();
  }, [linkedDocHook, fileBrowser, archive]);

  // Derive annotation counts per file from linked doc cache (includes active doc's live state)
  const allAnnotationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [fp, cached] of linkedDocHook.getDocAnnotations()) {
      const count = cached.annotations.length + cached.globalAttachments.length;
      if (count > 0) counts.set(fp, count);
    }
    return counts;
  }, [linkedDocHook.getDocAnnotations, annotations, globalAttachments]);

  // FileBrowser counts: all files under any loaded dir (regular + vault)
  const fileAnnotationCounts = useMemo(() => {
    const allDirPaths = fileBrowser.dirs.map(d => d.path);
    if (allDirPaths.length === 0) return allAnnotationCounts;
    const counts = new Map<string, number>();
    for (const [fp, count] of allAnnotationCounts) {
      if (allDirPaths.some(dir => fp.startsWith(dir + '/'))) {
        counts.set(fp, count);
      }
    }
    return counts;
  }, [allAnnotationCounts, fileBrowser.dirs]);

  const hasFileAnnotations = fileAnnotationCounts.size > 0;

  // Annotations in other files (not the current view) — for the right panel "+N" indicator
  const otherFileAnnotations = useMemo(() => {
    const currentFile = linkedDocHook.filepath;
    let count = 0;
    let files = 0;
    for (const [fp, n] of allAnnotationCounts) {
      if (fp !== currentFile) {
        count += n;
        files++;
      }
    }
    return count > 0 ? { count, files } : undefined;
  }, [allAnnotationCounts, linkedDocHook.filepath]);

  // Flash highlight for annotated files in the sidebar
  const [highlightedFiles, setHighlightedFiles] = useState<Set<string> | undefined>();
  const flashTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleFlashAnnotatedFiles = React.useCallback(() => {
    const filePaths = new Set(allAnnotationCounts.keys());
    if (filePaths.size === 0) return;
    // Open sidebar to the files tab so the flash is visible
    if (!sidebar.isOpen || sidebar.activeTab !== 'files') {
      sidebar.open('files');
    }
    // Cancel any pending clear from a previous flash
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    // Clear first so re-triggering restarts the CSS animation
    setHighlightedFiles(undefined);
    requestAnimationFrame(() => {
      setHighlightedFiles(filePaths);
      flashTimerRef.current = setTimeout(() => setHighlightedFiles(undefined), 1200);
    });
  }, [allAnnotationCounts, sidebar, hasFileAnnotations]);

  // Context-aware back label for linked doc navigation
  const backLabel = annotateSource === 'folder' ? 'file list'
    : annotateSource === 'file' ? 'file'
    : annotateSource === 'message' ? 'message'
    : 'plan';

  // Track active section for TOC highlighting
  const headingCount = useMemo(() => blocks.filter(b => b.type === 'heading').length, [blocks]);
  const activeSection = useActiveSection(containerRef, headingCount, scrollViewport);

  const { editorAnnotations, deleteEditorAnnotation } = useEditorAnnotations();
  const { externalAnnotations, updateExternalAnnotation, deleteExternalAnnotation } = useExternalAnnotations<Annotation>({ enabled: isApiMode });

  // Drive DOM highlights for SSE-delivered external annotations. Disabled
  // while a linked doc overlay is open (Viewer DOM is hidden) and while the
  // plan diff view is active (diff view has its own annotation surface).
  useExternalAnnotationHighlights({
    viewerRef,
    externalAnnotations,
    enabled: isApiMode && !linkedDocHook.isActive && !isPlanDiffActive,
    planKey: markdown,
    surfaceGeneration: highlightSurfaceGeneration,
  });

  // Merge local + SSE annotations, deduping draft-restored externals against
  // live SSE versions. Prefer the SSE version when both exist (same source,
  // type, and originalText). This avoids the timing issues of an effect-based
  // cleanup — draft-restored externals persist until SSE actually re-delivers them.
  //
  // Room-mode exclusion: when a live room is active, external annotations are
  // NOT merged. An SSE-sourced annotation visible only to the creator would
  // diverge from other participants' views and could be accidentally
  // consolidated into approve/deny payloads. A future pass can forward
  // the SSE stream to encrypted room ops so external annotations become
  // shared.
  const allAnnotations = useMemo(() => {
    if (roomSession?.room) return annotations;
    if (externalAnnotations.length === 0) return annotations;

    const local = annotations.filter(a => {
      if (!a.source) return true;
      return !externalAnnotations.some(ext =>
        ext.source === a.source &&
        ext.type === a.type &&
        ext.originalText === a.originalText
      );
    });

    return [...local, ...externalAnnotations];
  }, [annotations, externalAnnotations, roomSession?.room]);

  // Plan diff state — memoize filtered annotation lists to avoid new references per render
  const diffAnnotations = useMemo(() => allAnnotations.filter(a => !!a.diffContext), [allAnnotations]);
  const viewerAnnotations = useMemo(() => allAnnotations.filter(a => !a.diffContext), [allAnnotations]);

  // URL-based sharing
  const {
    isSharedSession,
    isLoadingShared,
    shareUrl,
    shareUrlSize,
    shortShareUrl,
    isGeneratingShortUrl,
    shortUrlError,
    pendingSharedAnnotations,
    sharedGlobalAttachments,
    clearPendingSharedAnnotations,
    generateShortUrl,
    importFromShareUrl,
    shareLoadError,
    clearShareLoadError,
  } = useSharing(
    markdown,
    allAnnotations,
    globalAttachments,
    setMarkdown,
    setAnnotations,
    setGlobalAttachments,
    () => {
      // When loaded from share, mark as loaded
      setIsLoading(false);
    },
    shareBaseUrl,
    pasteApiUrl,
    // Room mode disables static sharing entirely. The URL fragment
    // (#key=<roomSecret>) is a room credential, not a deflated share
    // payload, and must not be interpreted as a static share.
    roomModeActive,
  );

  // Auto-save annotation drafts
  const { draftBanner, restoreDraft, dismissDraft } = useAnnotationDraft({
    annotations: allAnnotations,
    globalAttachments,
    isApiMode,
    isSharedSession,
    submitted: !!submitted,
  });

  const handleRestoreDraft = React.useCallback(() => {
    // Draft restore is a replace-all flow; in room mode the room-backed
    // controller has no replace-all primitive (annotations are
    // server-authoritative). We intentionally skip restore in room mode —
    // the user's local draft is still on disk; they can apply it after
    // leaving the room.
    if (roomModeActive) return;
    const { annotations: restored, globalAttachments: restoredGlobal } = restoreDraft();
    if (restored.length > 0) {
      setAnnotations(restored);
      if (restoredGlobal.length > 0) setGlobalAttachments(restoredGlobal);
      // Apply highlights to DOM after a tick
      setTimeout(() => {
        viewerRef.current?.applySharedAnnotations(restored.filter(a => !a.diffContext));
      }, 100);
    }
  }, [restoreDraft, roomModeActive]);

  // Fetch available agents for OpenCode (for validation on approve)
  const { agents: availableAgents, validateAgent, getAgentWarning } = useAgents(origin);

  // Apply shared annotations to DOM after they're loaded
  useEffect(() => {
    if (pendingSharedAnnotations && pendingSharedAnnotations.length > 0) {
      // Small delay to ensure DOM is rendered
      const timer = setTimeout(() => {
        // Clear existing highlights first (important when loading new share URL).
        // Viewer fires `onHighlightSurfaceReset`, which bumps the parent-owned
        // generation and cascades into both reconcilers (external SSE + room)
        // so their applied maps invalidate and repaint on the next tick.
        viewerRef.current?.clearAllHighlights();
        viewerRef.current?.applySharedAnnotations(pendingSharedAnnotations.filter(a => !a.diffContext));
        clearPendingSharedAnnotations();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [pendingSharedAnnotations, clearPendingSharedAnnotations]);

  // Room-mode annotation → DOM mark reconciliation. Delegates to the
  // shared `useAnnotationHighlightReconciler` (also used by external
  // SSE). Room fingerprint includes comment `text` because peers can
  // edit an annotation's comment without changing `originalText` —
  // that case must trigger a remove+reapply so the mark's visible
  // content matches the canonical annotation.
  useAnnotationHighlightReconciler({
    viewerRef,
    annotations,
    enabled: roomModeActive,
    planKey: markdown,
    surfaceGeneration: highlightSurfaceGeneration,
    eligibleFilter: a => !a.diffContext && !!a.originalText,
    fingerprint: roomAnnFingerprint,
  });

  const handleTaterModeChange = (enabled: boolean) => {
    setTaterMode(enabled);
    storage.setItem('plannotator-tater-mode', String(enabled));
  };

  const handleEditorModeChange = (mode: EditorMode) => {
    setEditorMode(mode);
    saveEditorMode(mode);
  };

  const handleInputMethodChange = (method: InputMethod) => {
    setInputMethod(method);
    saveInputMethod(method);
  };

  // Alt/Option key: hold to temporarily switch, double-tap to toggle
  useInputMethodSwitch(inputMethod, handleInputMethodChange);

  // Check if we're in API mode (served from Bun hook server)
  // Skip if we loaded from a shared URL
  useEffect(() => {
    if (isLoadingShared) return; // Wait for share check to complete
    if (isSharedSession) return; // Already loaded from share
    if (roomModeActive) return; // Room mode loads plan from the encrypted snapshot

    fetch('/api/plan')
      .then(res => {
        if (!res.ok) throw new Error('Not in API mode');
        return res.json();
      })
      .then((data: { plan: string; origin?: Origin; mode?: 'annotate' | 'annotate-last' | 'annotate-folder' | 'archive'; filePath?: string; sourceInfo?: string; sharingEnabled?: boolean; shareBaseUrl?: string; pasteApiUrl?: string; repoInfo?: { display: string; branch?: string }; previousPlan?: string | null; versionInfo?: { version: number; totalVersions: number; project: string }; archivePlans?: ArchivedPlan[]; projectRoot?: string; isWSL?: boolean; serverConfig?: { displayName?: string; gitUser?: string } }) => {
        // Initialize config store with server-provided values (config file > cookie > default)
        configStore.init(data.serverConfig);
        // gitUser drives the "Use git name" button in Settings; stays undefined (button hidden) when unavailable
        setGitUser(data.serverConfig?.gitUser);
        if (data.mode === 'archive') {
          // Archive mode: show first archived plan or clear demo content
          setMarkdown(data.plan || '');
          if (data.archivePlans) archive.init(data.archivePlans);
          archive.fetchPlans();
          setSharingEnabled(false);
          sidebar.open('archive');
        } else if (data.mode === 'annotate-folder') {
          // Folder annotation mode: clear demo content, let user pick a file
          setMarkdown('');
        } else if (data.plan) {
          setMarkdown(data.plan);
        }
        setIsApiMode(true);
        if (data.mode === 'annotate' || data.mode === 'annotate-last' || data.mode === 'annotate-folder') {
          setAnnotateMode(true);
        }
        if (data.mode === 'annotate-folder') {
          sidebar.open('files');
        }
        if (data.mode && data.mode !== 'archive') {
          setAnnotateSource(data.mode === 'annotate-last' ? 'message' : data.mode === 'annotate-folder' ? 'folder' : 'file');
        }
        setSourceInfo(data.sourceInfo ?? undefined);
        if (data.filePath) {
          setImageBaseDir(data.mode === 'annotate-folder' ? data.filePath : data.filePath.replace(/\/[^/]+$/, ''));
          if (data.mode === 'annotate') {
            setSourceFilePath(data.filePath);
          }
        }
        if (data.sharingEnabled !== undefined) {
          setSharingEnabled(data.sharingEnabled);
        }
        if (data.shareBaseUrl) {
          setShareBaseUrl(data.shareBaseUrl);
        }
        if (data.pasteApiUrl) {
          setPasteApiUrl(data.pasteApiUrl);
        }
        if (data.repoInfo) {
          setRepoInfo(data.repoInfo);
        }
        if (data.projectRoot) {
          setProjectRoot(data.projectRoot);
        }
        // Capture plan version history data
        if (data.previousPlan !== undefined) {
          setPreviousPlan(data.previousPlan);
        }
        if (data.versionInfo) {
          setVersionInfo(data.versionInfo);
        }
        if (data.origin) {
          setOrigin(data.origin);
          // For Claude Code, check if user needs to configure permission mode
          if (data.origin === 'claude-code' && needsPermissionModeSetup()) {
            setShowPermissionModeSetup(true);
          }
          // Load saved permission mode preference
          setPermissionMode(getPermissionModeSettings().mode);
        }
        if (data.isWSL) {
          setIsWSL(true);
        }
      })
      .catch(() => {
        // Not in API mode - use default content
        setIsApiMode(false);
      })
      .finally(() => setIsLoading(false));
  }, [isLoadingShared, isSharedSession]);

  useEffect(() => {
    const { frontmatter: fm } = extractFrontmatter(markdown);
    setFrontmatter(fm);
    setBlocks(parseMarkdownToBlocks(markdown));
  }, [markdown]);

  // Auto-save to notes apps on plan arrival (each gated by its autoSave toggle)
  const autoSaveAttempted = useRef(false);
  const autoSaveResultsRef = useRef<NoteAutoSaveResults>({});
  const autoSavePromiseRef = useRef<Promise<NoteAutoSaveResults> | null>(null);

  useEffect(() => {
    autoSaveAttempted.current = false;
    autoSaveResultsRef.current = {};
    autoSavePromiseRef.current = null;
  }, [markdown]);

  useEffect(() => {
    if (!isApiMode || !markdown || isSharedSession || annotateMode || archive.archiveMode) return;
    if (autoSaveAttempted.current) return;

    const body: { obsidian?: object; bear?: object; octarine?: object } = {};
    const targets: string[] = [];

    const obsSettings = getObsidianSettings();
    if (obsSettings.autoSave && obsSettings.enabled) {
      const vaultPath = getEffectiveVaultPath(obsSettings);
      if (vaultPath) {
        body.obsidian = {
          vaultPath,
          folder: obsSettings.folder || 'plannotator',
          plan: markdown,
          ...(obsSettings.filenameFormat && { filenameFormat: obsSettings.filenameFormat }),
          ...(obsSettings.filenameSeparator && obsSettings.filenameSeparator !== 'space' && { filenameSeparator: obsSettings.filenameSeparator }),
        };
        targets.push('Obsidian');
      }
    }

    const bearSettings = getBearSettings();
    if (bearSettings.autoSave && bearSettings.enabled) {
      body.bear = {
        plan: markdown,
        customTags: bearSettings.customTags,
        tagPosition: bearSettings.tagPosition,
      };
      targets.push('Bear');
    }

    const octSettings = getOctarineSettings();
    if (octSettings.autoSave && isOctarineConfigured()) {
      body.octarine = {
        plan: markdown,
        workspace: octSettings.workspace,
        folder: octSettings.folder || 'plannotator',
      };
      targets.push('Octarine');
    }

    if (targets.length === 0) return;
    autoSaveAttempted.current = true;

    const autoSavePromise = fetch('/api/save-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(res => res.json())
      .then(data => {
        const results: NoteAutoSaveResults = {
          ...(body.obsidian ? { obsidian: Boolean(data.results?.obsidian?.success) } : {}),
          ...(body.bear ? { bear: Boolean(data.results?.bear?.success) } : {}),
          ...(body.octarine ? { octarine: Boolean(data.results?.octarine?.success) } : {}),
        };
        autoSaveResultsRef.current = results;

        const failed = targets.filter(t => !data.results?.[t.toLowerCase()]?.success);
        if (failed.length === 0) {
          setNoteSaveToast({ type: 'success', message: `Auto-saved to ${targets.join(' & ')}` });
        } else {
          setNoteSaveToast({ type: 'error', message: `Auto-save failed for ${failed.join(' & ')}` });
        }

        return results;
      })
      .catch(() => {
        autoSaveResultsRef.current = {};
        setNoteSaveToast({ type: 'error', message: 'Auto-save failed' });
        return {};
      })
      .finally(() => setTimeout(() => setNoteSaveToast(null), 3000));
    autoSavePromiseRef.current = autoSavePromise;
  }, [isApiMode, markdown, isSharedSession, annotateMode]);

  // Global paste listener for image attachments
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      // Room mode: images are not supported. Block the paste flow so
      // the user doesn't get an upload modal that silently fails (the
      // room Worker has no /api/upload endpoint).
      if (roomModeActive) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            // Derive name before showing annotator so user sees it immediately
            const initialName = deriveImageName(file.name, globalAttachments.map(g => g.name));
            const blobUrl = URL.createObjectURL(file);
            setPendingPasteImage({ file, blobUrl, initialName });
          }
          break;
        }
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [globalAttachments, roomModeActive]);

  // Handle paste annotator accept — name comes from ImageAnnotator
  const handlePasteAnnotatorAccept = async (blob: Blob, hasDrawings: boolean, name: string) => {
    if (!pendingPasteImage) return;

    try {
      const formData = new FormData();
      const fileToUpload = hasDrawings
        ? new File([blob], 'annotated.png', { type: 'image/png' })
        : pendingPasteImage.file;
      formData.append('file', fileToUpload);

      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      if (res.ok) {
        const data = await res.json();
        setGlobalAttachments(prev => [...prev, { path: data.path, name }]);
      }
    } catch {
      // Upload failed silently
    } finally {
      URL.revokeObjectURL(pendingPasteImage.blobUrl);
      setPendingPasteImage(null);
    }
  };

  const handlePasteAnnotatorClose = () => {
    if (pendingPasteImage) {
      URL.revokeObjectURL(pendingPasteImage.blobUrl);
      setPendingPasteImage(null);
    }
  };

  // API mode handlers
  const handleApprove = async () => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const obsidianSettings = getObsidianSettings();
      const bearSettings = getBearSettings();
      const octarineSettings = getOctarineSettings();
      const agentSwitchSettings = getAgentSwitchSettings();
      const planSaveSettings = getPlanSaveSettings();
      const autoSaveResults = bearSettings.autoSave && autoSavePromiseRef.current
        ? await autoSavePromiseRef.current
        : autoSaveResultsRef.current;

      // Build request body - include integrations if enabled
      const body: { obsidian?: object; bear?: object; octarine?: object; feedback?: string; agentSwitch?: string; planSave?: { enabled: boolean; customPath?: string }; permissionMode?: string } = {};

      // Include permission mode for Claude Code
      if (origin === 'claude-code') {
        body.permissionMode = permissionMode;
      }

      // Include agent switch setting for OpenCode (effective name handles custom agents)
      const effectiveAgent = getEffectiveAgentName(agentSwitchSettings);
      if (effectiveAgent) {
        body.agentSwitch = effectiveAgent;
      }

      // Include plan save settings
      body.planSave = {
        enabled: planSaveSettings.enabled,
        ...(planSaveSettings.customPath && { customPath: planSaveSettings.customPath }),
      };

      const effectiveVaultPath = getEffectiveVaultPath(obsidianSettings);
      if (obsidianSettings.enabled && effectiveVaultPath) {
        body.obsidian = {
          vaultPath: effectiveVaultPath,
          folder: obsidianSettings.folder || 'plannotator',
          plan: markdown,
          ...(obsidianSettings.filenameFormat && { filenameFormat: obsidianSettings.filenameFormat }),
          ...(obsidianSettings.filenameSeparator && obsidianSettings.filenameSeparator !== 'space' && { filenameSeparator: obsidianSettings.filenameSeparator }),
        };
      }

      // Bear creates a new note each time, so don't send it again on approve
      // if the arrival auto-save already succeeded.
      if (bearSettings.enabled && !(bearSettings.autoSave && autoSaveResults.bear)) {
        body.bear = {
          plan: markdown,
          customTags: bearSettings.customTags,
          tagPosition: bearSettings.tagPosition,
        };
      }

      if (isOctarineConfigured()) {
        body.octarine = {
          plan: markdown,
          workspace: octarineSettings.workspace,
          folder: octarineSettings.folder || 'plannotator',
        };
      }

      // Include annotations as feedback if any exist (for OpenCode "approve with notes")
      const hasDocAnnotations = Array.from(linkedDocHook.getDocAnnotations().values()).some(
        (d) => d.annotations.length > 0 || d.globalAttachments.length > 0
      );
      if (allAnnotations.length > 0 || globalAttachments.length > 0 || hasDocAnnotations || editorAnnotations.length > 0) {
        body.feedback = annotationsOutput;
      }

      const approveRes = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!approveRes.ok) {
        throw new Error(`Approve failed: ${approveRes.status}`);
      }

      setSubmitted('approved');
      setSubmitError(null);
    } catch (err) {
      setIsSubmitting(false);
      setSubmitError(err instanceof Error ? err.message : 'Approve failed');
    }
  };

  const handleDeny = async () => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const planSaveSettings = getPlanSaveSettings();
      const denyRes = await fetch('/api/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedback: annotationsOutput,
          planSave: {
            enabled: planSaveSettings.enabled,
            ...(planSaveSettings.customPath && { customPath: planSaveSettings.customPath }),
          },
        })
      });
      if (!denyRes.ok) {
        throw new Error(`Deny failed: ${denyRes.status}`);
      }
      setSubmitted('denied');
      setSubmitError(null);
    } catch (err) {
      setIsSubmitting(false);
      setSubmitError(err instanceof Error ? err.message : 'Deny failed');
    }
  };

  /**
   * Stable `pendingIds` derivation for AnnotationPanel. The controller
   * exposes pending as `Map<id, PendingOp>` but the panel only needs
   * "is this id pending?" — we project to a Set with the controller's
   * pending Map as the memo dependency so a new Set is built ONLY when
   * pending actually changes.
   */
  const pendingAnnotationIds = useMemo<ReadonlySet<string> | undefined>(
    () => (roomModeActive ? new Set(annotationController.pending.keys()) : undefined),
    [roomModeActive, annotationController.pending],
  );

  // Live Rooms is a local-creator-only flow: it needs a running
  // Plannotator hook (isApiMode) to host the creator's original tab so
  // the blocked agent hook has an approve/deny surface after the room
  // opens in a new tab. Hosted portals (share.plannotator.ai, the
  // marketing demo) have no such host, and the room-service CORS policy
  // intentionally doesn't whitelist them — offering the button there
  // would surface an "unreachable room service" error on click. Gate
  // the menu + export-modal affordances on this single flag so both
  // surfaces stay consistent.
  const canStartLiveRoom = isApiMode && !roomModeActive;

  // Creator-side start-room flow. State, handlers, URL construction,
  // placeholder-tab pop-open, and the image-strip memo all live in
  // the hook; App.tsx consumes the return object and renders the
  // modal below.
  const {
    showStartRoomModal,
    startRoomInFlight,
    startRoomError,
    imageAnnotationsToStrip,
    handleStartLiveRoom,
    handleCancelStartRoom,
    handleConfirmStartRoom,
  } = useStartLiveRoom({
    annotations,
    markdown,
    globalAttachments,
    canStartLiveRoom,
  });

  // Note: room admin actions (lock / unlock / delete) intentionally
  // only live in the RoomPanel. The header menu used to
  // duplicate them via a `runHeaderRoomAdmin` wrapper, but that path
  // swallowed errors without a visible surface — RoomPanel owns the
  // `adminActionError` UI and the pending-state chrome, so routing
  // admin clicks through a single focal point gives the user a
  // consistent recovery path. We keep `isRoomAdmin` / `roomIsLocked`
  // props threaded into `PlanHeaderMenu` so other header-level
  // conditionals can still read capability state without offering
  // click targets.

  // Annotate mode handler — sends feedback via /api/feedback
  const handleAnnotateFeedback = async () => {
    setIsSubmitting(true);
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedback: annotationsOutput,
          annotations: allAnnotations,
        }),
      });
      setSubmitted('denied'); // reuse 'denied' state for "feedback sent" overlay
    } catch {
      setIsSubmitting(false);
    }
  };

  // Exit annotation session without sending feedback
  const handleAnnotateExit = useCallback(async () => {
    setIsExiting(true);
    try {
      const res = await fetch('/api/exit', { method: 'POST' });
      if (res.ok) {
        setSubmitted('exited');
      } else {
        throw new Error('Failed to exit');
      }
    } catch {
      setIsExiting(false);
    }
  }, []);

  // Global keyboard shortcuts (Cmd/Ctrl+Enter to submit)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle Cmd/Ctrl+Enter
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;

      // Don't intercept if typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // Don't intercept if any modal is open
      if (showExport || showImport || showFeedbackPrompt || showClaudeCodeWarning ||
          showExitWarning || showAgentWarning || showPermissionModeSetup || pendingPasteImage) return;

      // Don't intercept if already submitted, submitting, or exiting
      if (submitted || isSubmitting || isExiting) return;

      // Don't intercept in demo/share mode (no API)
      if (!isApiMode) return;

      // Don't submit while viewing a linked doc
      if (linkedDocHook.isActive) return;

      e.preventDefault();

      // Annotate mode: always send feedback (empty = "no feedback" message)
      if (annotateMode) {
        handleAnnotateFeedback();
        return;
      }

      // No annotations → Approve, otherwise → Send Feedback
      const docAnnotations = linkedDocHook.getDocAnnotations();
      const hasDocAnnotations = Array.from(docAnnotations.values()).some(
        (d) => d.annotations.length > 0 || d.globalAttachments.length > 0
      );
      if (allAnnotations.length === 0 && editorAnnotations.length === 0 && !hasDocAnnotations) {
        // Check if agent exists for OpenCode users
        if (origin === 'opencode') {
          const warning = getAgentWarning();
          if (warning) {
            setAgentWarningMessage(warning);
            setShowAgentWarning(true);
            return;
          }
        }
        handleApprove();
      } else {
        handleDeny();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    showExport, showImport, showFeedbackPrompt, showClaudeCodeWarning, showExitWarning, showAgentWarning,
    showPermissionModeSetup, pendingPasteImage,
    submitted, isSubmitting, isExiting, isApiMode, linkedDocHook.isActive, annotations.length, externalAnnotations.length, annotateMode,
    origin, getAgentWarning,
  ]);

  // Room-mode lock: when the admin has locked the room, mutation
  // affordances must disable at the source instead of letting the user
  // submit and get a rejected op. Short-circuits add/remove/edit to
  // no-ops; Viewer/AnnotationPanel also receive `roomIsLocked` to hide
  // selection toolbars and per-row edit/delete controls.
  const roomIsLocked = !!annotationController.isLocked;

  const handleAddAnnotation = (ann: Annotation) => {
    if (roomIsLocked) return;
    annotationController.add(ann);
    setSelectedAnnotationId(ann.id);
    setIsPanelOpen(true);
  };

  // Stable reference — the Viewer's highlighter useEffect depends on this
  const handleSelectAnnotation = React.useCallback((id: string | null) => {
    setSelectedAnnotationId(id);
    if (id && window.innerWidth < 768) setIsPanelOpen(true);
  }, []);

  // Core annotation removal — highlight cleanup + controller filter + selection clear.
  //
  // Local mode: remove the highlight immediately (optimistic). The user
  // sees instant feedback and there's no server to reject.
  //
  // Room mode: do NOT remove the highlight before the server echo. The
  // room annotation reconciliation effect (above) removes marks when
  // they disappear from canonical state. Removing early would desync
  // the DOM if the server rejects (e.g. locked room race): the
  // annotation would stay canonical but lose its visible mark.
  const removeAnnotation = (id: string) => {
    if (roomIsLocked) return;
    if (!roomModeActive) {
      viewerRef.current?.removeHighlight(id);
    }
    annotationController.remove(id);
    if (selectedAnnotationId === id) setSelectedAnnotationId(null);
  };

  // Room-mode only. Delegates to `derivePendingCheckboxBlockIds`
  // (same file as `useCheckboxOverrides`) — busy-gate + revert-gate
  // semantics documented on the helper.
  const pendingCheckboxBlockIds = useMemo<ReadonlySet<string> | undefined>(
    () => (roomModeActive ? derivePendingCheckboxBlockIds(annotationController) : undefined),
    [
      roomModeActive,
      annotationController.pending,
      annotationController.failed,
      annotationController.pendingAdditions,
      annotationController.annotations,
    ],
  );

  // Interactive checkbox toggling with annotation tracking
  const checkbox = useCheckboxOverrides({
    blocks,
    annotations,
    addAnnotation: handleAddAnnotation,
    removeAnnotation,
    pendingBlockIds: pendingCheckboxBlockIds,
  });

  const handleDeleteAnnotation = (id: string) => {
    const ann = allAnnotations.find(a => a.id === id);
    // External annotations (live in SSE hook) route to the SSE hook, not local state.
    // Check membership by ID — source alone is insufficient because share-imported
    // and draft-restored annotations also carry source but live in local state.
    if (ann?.source && externalAnnotations.some(e => e.id === id)) {
      deleteExternalAnnotation(id);
      if (selectedAnnotationId === id) setSelectedAnnotationId(null);
      return;
    }
    // If this is a checkbox annotation, clear the visual override.
    //
    // Local mode: synchronous — there's no server to reject the remove,
    // so revert optimistically in lockstep with the annotation removal.
    //
    // Room mode: DO NOT revert here. The override must stay until the
    // canonical checkbox annotation actually disappears from the room
    // state (echoed remove). Otherwise a remove that later fails
    // (disconnect, lock race, server rejection) leaves the annotation
    // canonical but the checkbox visually reverted — inconsistent.
    // `useCheckboxOverrides` runs a reconciliation effect that clears
    // overrides once the backing annotation is gone from BOTH canonical
    // and pending/failed state, which is exactly when it's safe to
    // revert in room mode.
    if (id.startsWith('ann-checkbox-') && !roomModeActive) {
      if (ann) {
        checkbox.revertOverride(ann.blockId);
      }
    }
    removeAnnotation(id);
  };

  const handleEditAnnotation = (id: string, updates: Partial<Annotation>) => {
    if (roomIsLocked) return;
    const ann = allAnnotations.find(a => a.id === id);
    if (ann?.source && externalAnnotations.some(e => e.id === id)) {
      updateExternalAnnotation(id, updates);
      return;
    }
    annotationController.update(id, updates);
  };

  const handleIdentityChange = (oldIdentity: string, newIdentity: string) => {
    // In room mode the joined identity — which stamps new annotations,
    // labels remote cursors, and keyed presence — is owned by `RoomApp`
    // and was confirmed at the join gate. Rewriting old annotations
    // from here while that live identity stays on the prior name
    // produces a "split" participant: old rows now say "Alice" but
    // future rows / the cursor flag still say "Bob." Skip rewrites
    // inside a room. Updating the Settings display name still takes
    // effect locally and on subsequent rooms; a deliberate live
    // rename feature (update presence + rename server-side) would be
    // a RoomApp-owned feature, not a half-rewrite from here.
    if (roomModeActive) return;
    // Identity-rename is a bulk update across all matching annotations.
    for (const ann of annotations) {
      if (ann.author === oldIdentity) {
        annotationController.update(ann.id, { author: newIdentity });
      }
    }
  };

  const handleAddGlobalAttachment = (image: ImageAttachment) => {
    setGlobalAttachments(prev => [...prev, image]);
  };

  const handleRemoveGlobalAttachment = (path: string) => {
    setGlobalAttachments(prev => prev.filter(p => p.path !== path));
  };


  const handleTocNavigate = (blockId: string) => {
    // Navigation handled by TableOfContents component
    // This is just a placeholder for future custom logic
  };

  const annotationsOutput = useMemo(() => {
    const docAnnotations = linkedDocHook.getDocAnnotations();
    const hasDocAnnotations = Array.from(docAnnotations.values()).some(
      (d) => d.annotations.length > 0 || d.globalAttachments.length > 0
    );
    // Room mode: global attachments are local-only (rooms carry no
    // image payloads), so they must NOT be included in consolidated
    // feedback — approving with local-only image refs would ship paths
    // collaborators never saw. Out-of-room keeps existing behavior.
    const effectiveGlobalAttachments = roomModeActive ? [] : globalAttachments;
    const hasPlanAnnotations = allAnnotations.length > 0 || effectiveGlobalAttachments.length > 0;
    const hasEditorAnnotations = editorAnnotations.length > 0;

    if (!hasPlanAnnotations && !hasDocAnnotations && !hasEditorAnnotations) {
      return 'User reviewed the document and has no feedback.';
    }

    let output = hasPlanAnnotations
      ? exportAnnotations(blocks, allAnnotations, effectiveGlobalAttachments, annotateSource === 'message' ? 'Message Feedback' : annotateSource === 'folder' ? 'Folder Feedback' : annotateSource === 'file' ? 'File Feedback' : 'Plan Feedback', annotateSource ?? 'plan')
      : '';

    if (hasDocAnnotations) {
      output += exportLinkedDocAnnotations(docAnnotations);
    }

    if (hasEditorAnnotations) {
      output += exportEditorAnnotations(editorAnnotations);
    }

    return output;
  }, [blocks, allAnnotations, globalAttachments, roomModeActive, linkedDocHook.getDocAnnotations, editorAnnotations]);

  // Bot callback config — read once from URL search params (?cb=&ct=)
  const callbackConfig = React.useMemo(() => getCallbackConfig(), []);

  const callCallback = React.useCallback(async (action: CallbackAction) => {
    if (!callbackConfig || isSubmitting || !shareUrl) return;
    setIsSubmitting(true);
    try {
      const toast = await executeCallback(action, callbackConfig, shareUrl);
      if (toast) {
        setNoteSaveToast(toast);
        setTimeout(() => setNoteSaveToast(null), 4000);
        if (toast.type === 'success') {
          setSubmitted(action === CallbackAction.Approve ? 'approved' : 'denied');
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [callbackConfig, isSubmitting, shareUrl]);

  const handleCallbackApprove = React.useCallback(() => callCallback(CallbackAction.Approve), [callCallback]);
  const handleCallbackFeedback = React.useCallback(() => callCallback(CallbackAction.Feedback), [callCallback]);

  // Quick-save handlers for export dropdown and keyboard shortcut
  const handleDownloadAnnotations = () => {
    const blob = new Blob([annotationsOutput], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'annotations.md';
    a.click();
    URL.revokeObjectURL(url);
    setNoteSaveToast({ type: 'success', message: 'Downloaded annotations' });
    setTimeout(() => setNoteSaveToast(null), 3000);
  };

  const handleQuickSaveToNotes = async (target: 'obsidian' | 'bear' | 'octarine') => {
    const body: { obsidian?: object; bear?: object; octarine?: object } = {};

    if (target === 'obsidian') {
      const s = getObsidianSettings();
      const vaultPath = getEffectiveVaultPath(s);
      if (vaultPath) {
        body.obsidian = {
          vaultPath,
          folder: s.folder || 'plannotator',
          plan: markdown,
          ...(s.filenameFormat && { filenameFormat: s.filenameFormat }),
          ...(s.filenameSeparator && s.filenameSeparator !== 'space' && { filenameSeparator: s.filenameSeparator }),
        };
      }
    }
    if (target === 'bear') {
      const bs = getBearSettings();
      body.bear = {
        plan: markdown,
        customTags: bs.customTags,
        tagPosition: bs.tagPosition,
      };
    }
    if (target === 'octarine') {
      const os = getOctarineSettings();
      body.octarine = {
        plan: markdown,
        workspace: os.workspace,
        folder: os.folder || 'plannotator',
      };
    }

    const targetName = target === 'obsidian' ? 'Obsidian' : target === 'bear' ? 'Bear' : 'Octarine';
    try {
      const res = await fetch('/api/save-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      const result = data.results?.[target];
      if (result?.success) {
        setNoteSaveToast({ type: 'success', message: `Saved to ${targetName}` });
      } else {
        setNoteSaveToast({ type: 'error', message: result?.error || 'Save failed' });
      }
    } catch {
      setNoteSaveToast({ type: 'error', message: 'Save failed' });
    }
    setTimeout(() => setNoteSaveToast(null), 3000);
  };

  // Agent Instructions — copy a clipboard payload teaching external agents
  // (Claude Code, Codex, etc.) how to POST annotations into this session via
  // /api/external-annotations. The instruction body lives in a separate module
  // (utils/agentInstructions.ts) so it's easy to edit independently of UI code.
  const handleCopyAgentInstructions = async () => {
    const payload = buildPlanAgentInstructions(window.location.origin);
    try {
      await navigator.clipboard.writeText(payload);
      setNoteSaveToast({ type: 'success', message: 'Agent instructions copied' });
    } catch {
      setNoteSaveToast({ type: 'error', message: 'Failed to copy' });
    }
    setTimeout(() => setNoteSaveToast(null), 3000);
  };

  const handleCopyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setNoteSaveToast({ type: 'success', message: 'Share link copied' });
    } catch {
      setNoteSaveToast({ type: 'error', message: 'Failed to copy' });
    }
    setTimeout(() => setNoteSaveToast(null), 3000);
  };

  // Room-mode copy handlers. Share a single clipboard + toast helper so
  // the three call sites can't drift (success-vs-error copy, timeout,
  // toast slot reuse). The `noteSaveToast` slot is reused for both
  // flows — small grief that two kinds of message share one slot, but
  // avoids a second toast system for a handful of rare clicks.
  const copyToClipboardWithToast = React.useCallback(
    async (text: string, successMessage: string, errorMessage: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setNoteSaveToast({ type: 'success', message: successMessage });
      } catch {
        setNoteSaveToast({ type: 'error', message: errorMessage });
      }
      setTimeout(() => setNoteSaveToast(null), 2500);
    },
    [],
  );
  const handleCopyParticipantUrl = React.useCallback(async () => {
    const url = roomSession?.joinUrl;
    if (!url) return;
    await copyToClipboardWithToast(
      url,
      'Participant link copied',
      'Failed to copy link',
    );
  }, [roomSession?.joinUrl, copyToClipboardWithToast]);
  const handleCopyAdminUrl = React.useCallback(async () => {
    const url = roomSession?.adminUrl;
    if (!url) return;
    await copyToClipboardWithToast(
      url,
      'Admin link copied',
      'Failed to copy admin link',
    );
  }, [roomSession?.adminUrl, copyToClipboardWithToast]);
  const handleCopyConsolidatedFeedback = React.useCallback(async () => {
    // Exclude diff-context annotations from exported feedback — same
    // filter the prior RoomPanel path used. Global attachments are
    // empty inside a room (images are stripped at create time).
    const text = exportAnnotations(
      blocks,
      allAnnotations.filter(a => !a.diffContext),
      [],
    );
    await copyToClipboardWithToast(
      text,
      'Feedback copied',
      'Failed to copy feedback',
    );
  }, [blocks, allAnnotations, copyToClipboardWithToast]);

  const handleCopyRoomAgentInstructions = React.useCallback(async () => {
    // Prefer the participant URL (joinUrl) so an agent dropped into
    // the clipboard payload doesn't accidentally end up with admin
    // capability. The CLI also strips `#admin=` defensively, but
    // pairing the strip with a deliberate participant-URL copy here
    // makes the guard layered rather than single-point.
    const joinUrl = roomSession?.joinUrl;
    if (!joinUrl) return;
    const payload = buildRoomAgentInstructions({
      joinUrl,
      userIdentity: getIdentity(),
    });
    await copyToClipboardWithToast(
      payload,
      'Agent instructions copied',
      'Failed to copy instructions',
    );
  }, [roomSession?.joinUrl, copyToClipboardWithToast]);

  // Cmd/Ctrl+S keyboard shortcut — save to default notes app
  useEffect(() => {
    const handleSaveShortcut = (e: KeyboardEvent) => {
      if (e.key !== 's' || !(e.metaKey || e.ctrlKey)) return;

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (showExport || showFeedbackPrompt || showClaudeCodeWarning ||
          showExitWarning || showAgentWarning || showPermissionModeSetup || pendingPasteImage) return;

      if (submitted || !isApiMode) return;

      e.preventDefault();

      const defaultApp = getDefaultNotesApp();
      const obsOk = isObsidianConfigured();
      const bearOk = getBearSettings().enabled;
      const octOk = isOctarineConfigured();

      if (defaultApp === 'download') {
        handleDownloadAnnotations();
      } else if (defaultApp === 'obsidian' && obsOk) {
        handleQuickSaveToNotes('obsidian');
      } else if (defaultApp === 'bear' && bearOk) {
        handleQuickSaveToNotes('bear');
      } else if (defaultApp === 'octarine' && octOk) {
        handleQuickSaveToNotes('octarine');
      } else {
        setInitialExportTab('notes');
        setShowExport(true);
      }
    };

    window.addEventListener('keydown', handleSaveShortcut);
    return () => window.removeEventListener('keydown', handleSaveShortcut);
  }, [
    showExport, showFeedbackPrompt, showClaudeCodeWarning, showExitWarning, showAgentWarning,
    showPermissionModeSetup, pendingPasteImage,
    submitted, isApiMode, markdown, annotationsOutput,
  ]);

  // Cmd/Ctrl+P keyboard shortcut — print plan
  useEffect(() => {
    const handlePrintShortcut = (e: KeyboardEvent) => {
      if (e.key !== 'p' || !(e.metaKey || e.ctrlKey)) return;

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (showExport || showFeedbackPrompt || showClaudeCodeWarning ||
          showExitWarning || showAgentWarning || showPermissionModeSetup || pendingPasteImage) return;

      if (submitted) return;

      e.preventDefault();
      window.print();
    };

    window.addEventListener('keydown', handlePrintShortcut);
    return () => window.removeEventListener('keydown', handlePrintShortcut);
  }, [
    showExport, showFeedbackPrompt, showClaudeCodeWarning, showExitWarning, showAgentWarning,
    showPermissionModeSetup, pendingPasteImage, submitted,
  ]);

  const agentName = useMemo(() => getAgentName(origin), [origin]);

  const planMaxWidth = useMemo(() => {
    const widths: Record<PlanWidth, number> = { compact: 832, default: 1040, wide: 1280 };
    return widths[uiPrefs.planWidth] ?? 832;
  }, [uiPrefs.planWidth]);


  return (
    <div data-print-region="root" className="h-screen flex flex-col bg-background overflow-hidden">
        {/* Minimal Header */}
        <header className="h-12 flex items-center justify-between px-2 md:px-4 border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-[50]">
          <div className="flex items-center gap-2 md:gap-3">
            <a
              href="https://plannotator.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 md:gap-2 hover:opacity-80 transition-opacity"
            >
              <span className="text-sm font-semibold tracking-tight">Plannotator</span>
            </a>
          </div>

          <div className="flex items-center gap-1 md:gap-2">
            {/* Bot callback buttons — only shown when ?cb=&ct= params are present */}
            {callbackConfig && !isApiMode && isSharedSession && (
              <>
                <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
                <FeedbackButton
                  onClick={handleCallbackFeedback}
                  disabled={isSubmitting || !shareUrl}
                  isLoading={isSubmitting}
                  title="Send feedback to bot"
                />
                <ApproveButton
                  onClick={handleCallbackApprove}
                  disabled={isSubmitting || !shareUrl}
                  isLoading={isSubmitting}
                  title="Approve design and notify bot"
                />
              </>
            )}

            {isApiMode && !linkedDocHook.isActive && archive.archiveMode && (
              <>
                <button
                  onClick={archive.copy}
                  className="px-2.5 py-1 rounded-md text-xs font-medium transition-all bg-muted text-foreground hover:bg-muted/80 border border-border"
                  title="Copy plan content"
                >
                  <span className="hidden md:inline">Copy</span>
                  <svg className="w-4 h-4 md:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
                <button
                  onClick={archive.done}
                  className="px-2.5 py-1 rounded-md text-xs font-medium transition-all bg-success text-success-foreground hover:opacity-90"
                  title="Close archive"
                >
                  Done
                </button>
              </>
            )}

            {submitError && (
              <div className="text-xs text-destructive max-w-[260px] truncate" title={submitError}>
                {submitError}
              </div>
            )}

            {approveDenyAvailable && (!linkedDocHook.isActive || annotateMode) && !archive.archiveMode && (
              <>
                {annotateMode ? (
                  // Annotate mode: Close always visible, Send Annotations when annotations exist
                  <>
                    <ExitButton
                      onClick={() => (allAnnotations.length > 0 || editorAnnotations.length > 0 || linkedDocHook.docAnnotationCount > 0 || globalAttachments.length > 0) ? setShowExitWarning(true) : handleAnnotateExit()}
                      disabled={isSubmitting || isExiting}
                      isLoading={isExiting}
                    />
                    {(allAnnotations.length > 0 || editorAnnotations.length > 0 || linkedDocHook.docAnnotationCount > 0 || globalAttachments.length > 0) && (
                      <FeedbackButton
                        onClick={handleAnnotateFeedback}
                        disabled={isSubmitting || isExiting}
                        isLoading={isSubmitting}
                        label="Send Annotations"
                        title="Send Annotations"
                      />
                    )}
                  </>
                ) : (
                  // Plan mode: Send Feedback
                  <FeedbackButton
                    onClick={() => {
                      const docAnnotations = linkedDocHook.getDocAnnotations();
                      const hasDocAnnotations = Array.from(docAnnotations.values()).some(
                        (d) => d.annotations.length > 0 || d.globalAttachments.length > 0
                      );
                      if (allAnnotations.length === 0 && editorAnnotations.length === 0 && !hasDocAnnotations) {
                        setShowFeedbackPrompt(true);
                      } else {
                        handleDeny();
                      }
                    }}
                    disabled={isSubmitting}
                    isLoading={isSubmitting}
                    label="Send Feedback"
                    title="Send Feedback"
                  />
                )}

                {!annotateMode && <div className="relative group/approve">
                  <ApproveButton
                    onClick={() => {
                      if (origin === 'claude-code' && allAnnotations.length > 0) {
                        setShowClaudeCodeWarning(true);
                        return;
                      }
                      if (origin === 'opencode') {
                        const warning = getAgentWarning();
                        if (warning) {
                          setAgentWarningMessage(warning);
                          setShowAgentWarning(true);
                          return;
                        }
                      }
                      handleApprove();
                    }}
                    disabled={isSubmitting}
                    isLoading={isSubmitting}
                    dimmed={(origin === 'claude-code' || origin === 'gemini-cli') && allAnnotations.length > 0}
                  />
                  {(origin === 'claude-code' || origin === 'gemini-cli') && allAnnotations.length > 0 && (
                    <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-popover border border-border rounded-lg shadow-xl text-xs text-foreground w-56 text-center opacity-0 invisible group-hover/approve:opacity-100 group-hover/approve:visible transition-all pointer-events-none z-50">
                      <div className="absolute bottom-full right-4 border-4 border-transparent border-b-border" />
                      <div className="absolute bottom-full right-4 mt-px border-4 border-transparent border-b-popover" />
                      {agentName} doesn't support feedback on approval. Your annotations won't be seen.
                    </div>
                  )}
                </div>}

                <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
              </>
            )}

            {/*
              Room mode cluster: conditional status pill (only when
              state is non-default — locked / reconnecting / offline),
              peer avatar bubbles, and a Room actions dropdown. Sits
              between the approve/deny area (hidden in room mode) and
              the annotations-panel toggle. Replaces the previous
              floating `RoomPanel` aside — one visually-grouped
              header cluster instead of a separate fixed card.
            */}
            {roomModeActive && roomSession?.room && (
              <RoomHeaderControls
                connectionStatus={roomSession.room.connectionStatus}
                roomStatus={roomSession.room.roomStatus}
                remotePresence={roomSession.room.remotePresence}
                isAdmin={roomSession.room.hasAdminCapability}
                adminUrl={roomSession.adminUrl}
                pendingAdminAction={roomAdmin.pending}
                onCopyParticipantUrl={handleCopyParticipantUrl}
                onCopyAdminUrl={handleCopyAdminUrl}
                onCopyConsolidatedFeedback={handleCopyConsolidatedFeedback}
                onCopyAgentInstructions={handleCopyRoomAgentInstructions}
                onLock={() => void roomAdmin.run('lock')}
                onUnlock={() => void roomAdmin.run('unlock')}
                onDelete={() => void roomAdmin.run('delete')}
              />
            )}

            {/* Annotations panel toggle — top-level header button */}
            <button
              onClick={() => setIsPanelOpen(!isPanelOpen)}
              className={`p-1.5 rounded-md text-xs font-medium transition-all ${
                isPanelOpen
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
              title={isPanelOpen ? 'Hide annotations' : 'Show annotations'}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
            </button>

            {/* Settings dialog (controlled, button hidden — opened from PlanHeaderMenu) */}
            <div className="hidden">
              <Settings
                taterMode={taterMode}
                onTaterModeChange={handleTaterModeChange}
                onIdentityChange={handleIdentityChange}
                origin={origin}
                onUIPreferencesChange={setUiPrefs}
                externalOpen={mobileSettingsOpen}
                onExternalClose={() => setMobileSettingsOpen(false)}
                gitUser={gitUser}
              />
            </div>

            <PlanHeaderMenu
              appVersion={typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'}
              hasNewSettingsHints={hasNewSettingsHints}
              onOpenSettings={() => {
                if (hasNewSettingsHints) {
                  markNewSettingsSeen();
                  setHasNewSettingsHints(false);
                }
                setMobileSettingsOpen(true);
              }}
              onOpenExport={() => { setInitialExportTab(undefined); setShowExport(true); }}
              onCopyAgentInstructions={handleCopyAgentInstructions}
              onDownloadAnnotations={handleDownloadAnnotations}
              onPrint={() => window.print()}
              onCopyShareLink={handleCopyShareLink}
              onOpenImport={() => setShowImport(true)}
              onStartLiveRoom={canStartLiveRoom ? handleStartLiveRoom : undefined}
              isRoomAdmin={roomSession?.room?.hasAdminCapability ?? false}
              roomIsLocked={roomSession?.room?.roomStatus === 'locked'}
              // Admin actions live only in the RoomPanel.
              // Passing undefined here hides the header-menu duplicate
              // so failures can't silently disappear in the catch
              // block that used to live behind these callbacks.
              onRoomLock={undefined}
              onRoomUnlock={undefined}
              onRoomDelete={undefined}
              onSaveToObsidian={() => handleQuickSaveToNotes('obsidian')}
              onSaveToBear={() => handleQuickSaveToNotes('bear')}
              onSaveToOctarine={() => handleQuickSaveToNotes('octarine')}
              // Static share/import is mutually exclusive with room mode.
              // When joined to a live room, the "Copy Share Link" and
              // "Import Review" menu items are hidden; "Start live room"
              // is also hidden since we're already in one.
              sharingEnabled={sharingEnabled && !roomModeActive}
              isApiMode={isApiMode}
              agentInstructionsEnabled={isApiMode && !archive.archiveMode && !annotateMode}
              obsidianConfigured={isObsidianConfigured()}
              bearConfigured={getBearSettings().enabled}
              octarineConfigured={isOctarineConfigured()}
            />
          </div>
        </header>

        {/*
          Room-mode stripped-images banner. Moved here from the old
          floating RoomPanel so it sits directly under the header as
          a one-line callout the first time the creator lands in a
          room; dismissing it (or refreshing, which clears the
          window global) removes it for the session.
        */}
        {roomModeActive && strippedImagesCount > 0 && (
          <div className="px-4 pt-3 flex-shrink-0">
            <ImageStripNotice
              strippedCount={strippedImagesCount}
              onDismiss={() => setStrippedImagesCount(0)}
            />
          </div>
        )}

        {/* Linked document error banner */}
        {linkedDocHook.error && (
          <div className="bg-destructive/10 border-b border-destructive/20 px-4 py-2 flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-destructive">{linkedDocHook.error}</span>
            <button
              onClick={linkedDocHook.dismissError}
              className="ml-auto text-xs text-destructive/60 hover:text-destructive"
            >
              dismiss
            </button>
          </div>
        )}

        {/* Main Content */}
        <ScrollViewportContext.Provider value={scrollViewport}>
        <div data-print-region="content" className={`flex-1 flex overflow-hidden relative z-0 ${isResizing ? 'select-none' : ''}`}>
          {/* Tater sprites — inside content wrapper so z-0 stacking context applies */}
          {taterMode && <TaterSpriteRunning />}
          {/* Left Sidebar: collapsed tab flags (when sidebar is closed) */}
          {!sidebar.isOpen && (
            <SidebarTabs
              activeTab={sidebar.activeTab}
              onToggleTab={sidebar.toggleTab}
              hasDiff={planDiff.hasPreviousVersion}
              showVersionsTab={versionInfo !== null && versionInfo.totalVersions > 1}
              showFilesTab={showFilesTab && !archive.archiveMode}
              hasFileAnnotations={hasFileAnnotations}
              className="hidden lg:flex absolute left-0 top-0 z-10"
            />
          )}

          {/* Left Sidebar: open state (TOC or Version Browser) */}
          {sidebar.isOpen && (
            <>
              <SidebarContainer
                activeTab={sidebar.activeTab}
                onTabChange={(tab) => {
                  sidebar.toggleTab(tab);
                  if (tab === 'archive' && !archive.archiveMode) archive.fetchPlans();
                }}
                onClose={sidebar.close}
                width={tocResize.width}
                blocks={blocks}
                annotations={annotations}
                activeSection={activeSection}
                onTocNavigate={handleTocNavigate}
                linkedDocFilepath={linkedDocHook.filepath}
                onLinkedDocBack={linkedDocHook.isActive ? handleLinkedDocBack : undefined}
                backLabel={backLabel}
                showFilesTab={showFilesTab && !archive.archiveMode}
                fileAnnotationCounts={fileAnnotationCounts}
                highlightedFiles={highlightedFiles}
                fileBrowser={fileBrowser}
                onFilesSelectFile={handleFileBrowserSelect}
                onFilesFetchAll={() => fileBrowser.fetchAll(fileBrowserDirs)}
                onFilesRetryVaultDir={(vaultPath) => fileBrowser.addVaultDir(vaultPath)}
                hasFileAnnotations={hasFileAnnotations}
                showVersionsTab={versionInfo !== null && versionInfo.totalVersions > 1}
                versionInfo={versionInfo}
                versions={planDiff.versions}
                selectedBaseVersion={planDiff.diffBaseVersion}
                onSelectBaseVersion={planDiff.selectBaseVersion}
                isPlanDiffActive={isPlanDiffActive}
                hasPreviousVersion={planDiff.hasPreviousVersion}
                onActivatePlanDiff={() => setIsPlanDiffActive(true)}
                isLoadingVersions={planDiff.isLoadingVersions}
                isSelectingVersion={planDiff.isSelectingVersion}
                fetchingVersion={planDiff.fetchingVersion}
                onFetchVersions={planDiff.fetchVersions}
                showArchiveTab={isApiMode && !annotateMode}
                archivePlans={archive.plans}
                selectedArchiveFile={archive.selectedFile}
                onArchiveSelect={archive.select}
                isLoadingArchive={archive.isLoading}
              />
              <ResizeHandle {...tocResize.handleProps} className="hidden lg:block" side="left" />
            </>
          )}

          {/* Document Area */}
          <OverlayScrollArea
            element="main"
            className={`flex-1 min-w-0 bg-grid ${!sidebar.isOpen ? 'lg:pl-[30px]' : ''}`}
            data-print-region="document"
            onViewportReady={handleViewportReady}
          >
            <ConfirmDialog
              isOpen={!!draftBanner}
              onClose={dismissDraft}
              onConfirm={handleRestoreDraft}
              title="Draft Recovered"
              message={draftBanner ? `Found ${draftBanner.count} annotation${draftBanner.count !== 1 ? 's' : ''} from ${draftBanner.timeAgo}. Would you like to restore them?` : ''}
              confirmText="Restore"
              cancelText="Dismiss"
              showCancel
            />
            <div ref={planAreaRef} className="min-h-full flex flex-col items-center px-2 py-3 md:px-10 md:py-8 xl:px-16 relative z-10">
              {/* Sticky header lane — ghost bar that pins the toolstrip +
                  badges at top: 12px once the user scrolls. Invisible at top
                  of doc; original toolstrip/badges remain the source of
                  truth there. Hidden in plan diff or archive mode, or when
                  sticky actions are disabled. remountToken re-anchors the
                  ResizeObserver when Viewer swaps content (linked docs). */}
              {!isPlanDiffActive && !archive.archiveMode && uiPrefs.stickyActionsEnabled && (
                <StickyHeaderLane
                  inputMethod={inputMethod}
                  onInputMethodChange={handleInputMethodChange}
                  mode={editorMode}
                  onModeChange={handleEditorModeChange}
                  taterMode={taterMode}
                  repoInfo={repoInfo}
                  planDiffStats={planDiff.diffStats}
                  isPlanDiffActive={isPlanDiffActive}
                  hasPreviousVersion={planDiff.hasPreviousVersion}
                  onPlanDiffToggle={() => setIsPlanDiffActive(!isPlanDiffActive)}
                  archiveInfo={archive.currentInfo}
                  maxWidth={planMaxWidth}
                  remountToken={linkedDocHook.isActive ? `doc:${linkedDocHook.filepath}` : 'plan'}
                />
              )}

              {/* Annotation Toolstrip (hidden during plan diff and archive mode) */}
              {!isPlanDiffActive && !archive.archiveMode && (
                <div data-print-hide className="w-full mb-3 md:mb-4 flex items-center justify-start" style={{ maxWidth: planMaxWidth }}>
                  <AnnotationToolstrip
                    inputMethod={inputMethod}
                    onInputMethodChange={handleInputMethodChange}
                    mode={editorMode}
                    onModeChange={handleEditorModeChange}
                    taterMode={taterMode}
                  />
                </div>
              )}

              {/* Plan Diff View — rendered when diff data exists, hidden when inactive */}
              {planDiff.diffBlocks && planDiff.diffStats && (
                <div className="w-full flex justify-center" style={{ display: isPlanDiffActive ? undefined : 'none' }}>
                  <PlanDiffViewer
                    diffBlocks={planDiff.diffBlocks}
                    diffStats={planDiff.diffStats}
                    diffMode={planDiffMode}
                    onDiffModeChange={setPlanDiffMode}
                    onPlanDiffToggle={() => setIsPlanDiffActive(false)}
                    repoInfo={repoInfo}
                    baseVersionLabel={planDiff.diffBaseVersion != null ? `v${planDiff.diffBaseVersion}` : undefined}
                    baseVersion={planDiff.diffBaseVersion ?? undefined}
                    maxWidth={planMaxWidth}
                    annotations={diffAnnotations}
                    onAddAnnotation={handleAddAnnotation}
                    onSelectAnnotation={handleSelectAnnotation}
                    selectedAnnotationId={selectedAnnotationId}
                    mode={editorMode}
                  />
                </div>
              )}
              {/* Folder annotation empty state — shown before user picks a file */}
              {annotateSource === 'folder' && !markdown && !linkedDocHook.isActive && (
                <div className="w-full flex justify-center">
                  <div className="w-full max-w-3xl p-12 text-center text-muted-foreground">
                    <p className="text-lg font-medium mb-2">Select a file to annotate</p>
                    <p className="text-sm">Pick a markdown file from the sidebar to begin.</p>
                  </div>
                </div>
              )}
              {/* Normal Plan View — always mounted, hidden during diff mode */}
              <div className="w-full flex justify-center" style={{ display: (isPlanDiffActive && planDiff.diffBlocks) || (annotateSource === 'folder' && !markdown && !linkedDocHook.isActive) ? 'none' : undefined }}>
                <Viewer
                  key={linkedDocHook.isActive ? `doc:${linkedDocHook.filepath}` : 'plan'}
                  ref={viewerRef}
                  blocks={blocks}
                  markdown={markdown}
                  frontmatter={frontmatter}
                  annotations={viewerAnnotations}
                  onAddAnnotation={handleAddAnnotation}
                  onSelectAnnotation={handleSelectAnnotation}
                  selectedAnnotationId={selectedAnnotationId}
                  mode={editorMode}
                  inputMethod={inputMethod}
                  taterMode={taterMode}
                  readOnly={roomIsLocked}
                  // Room mode: stamp new annotations with the joined
                  // display name instead of the cookie-backed Tater
                  // identity. The Tater cookie lives per-origin; on
                  // room.plannotator.ai it's either unset or stale,
                  // so without this override a participant's annotation
                  // author would not match the name on their cursor.
                  authorOverride={roomSession?.user?.name}
                  // Room mode: hide local-only global attachments from the
                  // Viewer so the creator doesn't see material participants
                  // don't have. Same motivation as excluding them from
                  // consolidated feedback. Also strip the attachment
                  // callbacks in room mode so the add-attachment button
                  // doesn't render an affordance that would no-op.
                  globalAttachments={roomModeActive ? [] : globalAttachments}
                  // Room mode: omit attachment callbacks so Viewer's
                  // AttachmentsButton gate (`onAdd && onRemove`) yields
                  // false and the affordance doesn't render at all.
                  onAddGlobalAttachment={roomModeActive ? undefined : handleAddGlobalAttachment}
                  onRemoveGlobalAttachment={roomModeActive ? undefined : handleRemoveGlobalAttachment}
                  // Room mode: hide the per-annotation CommentPopover
                  // attachments UI too. Live Rooms V1 strips image
                  // attachments at room-create time and doesn't carry
                  // new attachments over the wire, so the popover's
                  // AttachmentsButton would silently drop whatever the
                  // user added.
                  attachmentsEnabled={!roomModeActive}
                  repoInfo={repoInfo}
                  stickyActions={uiPrefs.stickyActionsEnabled}
                  planDiffStats={linkedDocHook.isActive ? null : planDiff.diffStats}
                  isPlanDiffActive={isPlanDiffActive}
                  onPlanDiffToggle={() => setIsPlanDiffActive(!isPlanDiffActive)}
                  hasPreviousVersion={!linkedDocHook.isActive && planDiff.hasPreviousVersion}
                  showDemoBadge={!isApiMode && !isLoadingShared && !isSharedSession && !roomModeActive}
                  maxWidth={planMaxWidth}
                  // Room mode: disable navigation into local documents.
                  // The room origin (room.plannotator.ai) has no file
                  // server, so wikilinks and local `.md` markdown
                  // links would either 404 on the room origin or
                  // attempt a broken `/api/doc` fetch. `Viewer`
                  // renders them as plain text when the flag is false.
                  onOpenLinkedDoc={roomModeActive ? undefined : handleOpenLinkedDoc}
                  localDocLinksEnabled={!roomModeActive}
                  linkedDocInfo={linkedDocHook.isActive ? { filepath: linkedDocHook.filepath!, onBack: handleLinkedDocBack, label: fileBrowser.dirs.find(d => d.path === fileBrowser.activeDirPath)?.isVault ? 'Vault File' : fileBrowser.activeFile ? 'File' : undefined, backLabel } : null}
                  imageBaseDir={imageBaseDir}
                  copyLabel={annotateSource === 'message' ? 'Copy message' : annotateSource === 'file' || annotateSource === 'folder' ? 'Copy file' : undefined}
                  archiveInfo={archive.currentInfo}
                  sourceInfo={sourceInfo}
                  // Locked rooms: checkbox clicks mutate local override
                  // state before calling addAnnotation. Even though
                  // addAnnotation is a no-op in room-locked, setOverrides
                  // still runs and the checkbox would visually toggle
                  // locally without a server-backed annotation. Omit the
                  // callback entirely so the checkbox is non-interactive.
                  onToggleCheckbox={roomIsLocked ? undefined : checkbox.toggle}
                  checkboxOverrides={checkbox.overrides}
                  actionsLabelMode={actionsLabelMode}
                  onHighlightSurfaceReset={bumpHighlightSurfaceGeneration}
                />
              </div>
            </div>
          </OverlayScrollArea>

          {/* Resize Handle */}
          {isPanelOpen && <ResizeHandle {...panelResize.handleProps} className="hidden md:block" side="right" />}

          {/* Annotation Panel */}
          <AnnotationPanel
            isOpen={isPanelOpen}
            blocks={blocks}
            annotations={allAnnotations}
            selectedId={selectedAnnotationId}
            onSelect={setSelectedAnnotationId}
            onDelete={handleDeleteAnnotation}
            onEdit={handleEditAnnotation}
            sharingEnabled={sharingEnabled}
            width={panelResize.width}
            editorAnnotations={editorAnnotations}
            onDeleteEditorAnnotation={deleteEditorAnnotation}
            onClose={() => setIsPanelOpen(false)}
            onQuickCopy={async () => {
              await navigator.clipboard.writeText(wrapFeedbackForAgent(annotationsOutput));
            }}
            onShare={shareUrl ? () => { setIsPanelOpen(false); setInitialExportTab('share'); setShowExport(true); } : undefined}
            otherFileAnnotations={otherFileAnnotations}
            onOtherFileAnnotationsClick={handleFlashAnnotatedFiles}
            // Room-mode pending/failed surface. Local mode provides undefined
            // Maps/callbacks so AnnotationPanel skips the UI.
            pendingIds={pendingAnnotationIds}
            failedIds={roomModeActive ? annotationController.failed : undefined}
            pendingAdditions={roomModeActive ? annotationController.pendingAdditions : undefined}
            onRetry={roomModeActive ? annotationController.retry : undefined}
            onDiscard={roomModeActive ? (id: string) => {
              // For failed adds, the selection-highlighter may have
              // created a local <mark> before the op failed. The
              // controller's discard clears state but not DOM.
              // removeHighlight is safe to call on ids that don't have
              // a mark (no-ops internally).
              const failedOp = annotationController.failed.get(id);
              if (failedOp?.kind === 'add') {
                viewerRef.current?.removeHighlight(id);
              }
              annotationController.discard?.(id);
            } : undefined}
            roomIsLocked={roomIsLocked}
            // Room mode: "(me)" compares against the joined display
            // name instead of the per-origin Tater cookie, matching
            // the override Viewer uses to stamp new annotations.
            authorOverride={roomSession?.user?.name}
          />
        </div>
        </ScrollViewportContext.Provider>

        {/* Export Modal */}
        <ExportModal
          isOpen={showExport}
          onClose={() => { setShowExport(false); setInitialExportTab(undefined); }}
          shareUrl={shareUrl}
          shareUrlSize={shareUrlSize}
          shortShareUrl={shortShareUrl}
          isGeneratingShortUrl={isGeneratingShortUrl}
          shortUrlError={shortUrlError}
          onGenerateShortUrl={generateShortUrl}
          annotationsOutput={annotationsOutput}
          annotationCount={allAnnotations.length}
          taterSprite={taterMode ? <TaterSpritePullup /> : undefined}
          // Static sharing is mutually exclusive with room mode. Also
          // flip sharingEnabled on the modal so the Share tab doesn't
          // default-open with empty/stale hash data.
          sharingEnabled={sharingEnabled && !roomModeActive}
          markdown={markdown}
          isApiMode={isApiMode}
          initialTab={initialExportTab}
          onStartLiveRoom={canStartLiveRoom ? handleStartLiveRoom : undefined}
        />

        {/* Import Modal */}
        <ImportModal
          isOpen={showImport}
          onClose={() => setShowImport(false)}
          onImport={importFromShareUrl}
          shareBaseUrl={shareBaseUrl}
        />

        {/* Start-live-room modal (local mode only; hidden in room mode).
            Prefills come from the local-origin ConfigStore — the same
            identity + color Settings reads/writes. Room creation is a
            confirmation step, not setup, so a creator who already
            configured their name/color sees those values preselected
            and can confirm or tweak per room. */}
        {showStartRoomModal && !roomModeActive && (
          <StartRoomModal
            initialDisplayName={getIdentity()}
            initialColor={getPresenceColor()}
            imageAnnotationsToStrip={imageAnnotationsToStrip}
            inFlight={startRoomInFlight}
            errorMessage={startRoomError || undefined}
            onStart={handleConfirmStartRoom}
            onCancel={handleCancelStartRoom}
          />
        )}

        {/* Feedback prompt dialog */}
        <ConfirmDialog
          isOpen={showFeedbackPrompt}
          onClose={() => setShowFeedbackPrompt(false)}
          title="Add Annotations First"
          message={`To provide feedback, select text in the plan and add annotations. ${agentName} will use your annotations to revise the plan.`}
          variant="info"
        />

        {/* Claude Code annotation warning dialog */}
        <ConfirmDialog
          isOpen={showClaudeCodeWarning}
          onClose={() => setShowClaudeCodeWarning(false)}
          onConfirm={() => {
            setShowClaudeCodeWarning(false);
            handleApprove();
          }}
          title="Annotations Won't Be Sent"
          message={<>{agentName} doesn't yet support feedback on approval. Your {allAnnotations.length} annotation{allAnnotations.length !== 1 ? 's' : ''} will be lost.</>}
          subMessage={
            <>
              To send feedback, use <strong>Send Feedback</strong> instead.
              <br /><br />
              Want this feature? Upvote these issues:
              <br />
              <a href="https://github.com/anthropics/claude-code/issues/16001" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">#16001</a>
              {' · '}
              <a href="https://github.com/anthropics/claude-code/issues/15755" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">#15755</a>
            </>
          }
          confirmText="Approve Anyway"
          cancelText="Cancel"
          variant="warning"
          showCancel
        />

        {/* Exit with annotations warning dialog */}
        <ConfirmDialog
          isOpen={showExitWarning}
          onClose={() => setShowExitWarning(false)}
          onConfirm={() => {
            setShowExitWarning(false);
            handleAnnotateExit();
          }}
          title="Annotations Won't Be Sent"
          message={<>You have {allAnnotations.length + editorAnnotations.length + linkedDocHook.docAnnotationCount + globalAttachments.length} annotation{(allAnnotations.length + editorAnnotations.length + linkedDocHook.docAnnotationCount + globalAttachments.length) !== 1 ? 's' : ''} that will be lost if you close.</>}
          subMessage="To send your annotations, use Send Annotations instead."
          confirmText="Close Anyway"
          cancelText="Cancel"
          variant="warning"
          showCancel
        />

        {/* OpenCode agent not found warning dialog */}
        <ConfirmDialog
          isOpen={showAgentWarning}
          onClose={() => setShowAgentWarning(false)}
          onConfirm={() => {
            setShowAgentWarning(false);
            handleApprove();
          }}
          title="Agent Not Found"
          message={agentWarningMessage}
          subMessage={
            <>
              You can change the agent in <strong>Settings</strong>, or approve anyway and OpenCode will use the default agent.
            </>
          }
          confirmText="Approve Anyway"
          cancelText="Cancel"
          variant="warning"
          showCancel
        />

        {/* Shared URL load failure warning */}
        <ConfirmDialog
          isOpen={!!shareLoadError && !isApiMode}
          onClose={clearShareLoadError}
          title="Shared Plan Could Not Be Loaded"
          message={shareLoadError}
          subMessage="You are viewing a demo plan. This is sample content — it is not your data or anyone else's."
          variant="warning"
        />

        {/*
          Room admin error toast — bottom-right, separated from the
          top-right `noteSaveToast` slot so a transient "link copied"
          success doesn't stomp a "Lock failed" that still needs the
          user's eyes. Provides a Dismiss button; auto-dismisses
          after 8s so it doesn't stick around indefinitely.
        */}
        {roomAdmin.error && (
          <RoomAdminErrorToast
            action={roomAdmin.error.action}
            message={roomAdmin.error.message}
            onDismiss={roomAdmin.dismissError}
          />
        )}

        {/* Save-to-notes toast */}
        {noteSaveToast && (
          <div className={`fixed top-16 right-4 z-50 px-3 py-2 rounded-lg text-xs font-medium shadow-lg transition-opacity ${
            noteSaveToast.type === 'success'
              ? 'bg-success/15 text-success border border-success/30'
              : 'bg-destructive/15 text-destructive border border-destructive/30'
          }`}>
            {noteSaveToast.message}
          </div>
        )}

        {/* Completion overlay - shown after approve/deny */}
        <CompletionOverlay
          submitted={submitted}
          title={
            archive.archiveMode ? 'Archive Closed'
            : submitted === 'exited' ? 'Session Closed'
            : submitted === 'approved' ? 'Plan Approved'
            : annotateMode ? 'Annotations Sent'
            : 'Feedback Sent'
          }
          subtitle={
            submitted === 'exited'
              ? 'Annotation session closed without feedback.'
              : archive.archiveMode
                ? 'You can reopen with plannotator archive.'
                : submitted === 'approved'
                  ? `${agentName} will proceed with the implementation.`
                  : annotateMode
                    ? `${agentName} will address your annotations on the ${annotateSource === 'message' ? 'message' : annotateSource === 'folder' ? 'files' : 'file'}.`
                    : `${agentName} will revise the plan based on your annotations.`
          }
          agentLabel={agentName}
        />

        {/* Update notification */}
        <UpdateBanner origin={origin} isWSL={isWSL} />

        {/* Image Annotator for pasted images — not rendered in room mode
            because rooms don't support image uploads. The paste handler
            already short-circuits, but not rendering the component at all
            prevents any edge case where pendingPasteImage was set before
            room mode activated. */}
        {!roomModeActive && (
          <ImageAnnotator
            isOpen={!!pendingPasteImage}
            imageSrc={pendingPasteImage?.blobUrl ?? ''}
            initialName={pendingPasteImage?.initialName}
            onAccept={handlePasteAnnotatorAccept}
            onClose={handlePasteAnnotatorClose}
          />
        )}

        {/* Permission Mode Setup (Claude Code first-time) */}
        <PermissionModeSetup
          isOpen={showPermissionModeSetup}
          onComplete={(mode) => {
            setPermissionMode(mode);
            setShowPermissionModeSetup(false);
          }}
        />
    </div>
  );
};

export default App;

/** Stable fingerprint for room annotation reconciliation. If any
 *  display-relevant field changes, the old mark is removed and a
 *  fresh one applied. */
function roomAnnFingerprint(a: { id: string; type: string; originalText: string; text?: string }): string {
  return `${a.type}\0${a.originalText}\0${a.text ?? ''}`;
}
