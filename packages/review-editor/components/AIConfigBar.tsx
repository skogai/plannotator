import type React from 'react';
import { useState, useEffect, useRef } from 'react';
import { getProviderMeta } from '@plannotator/ui/components/ProviderIcons';
import { isAdaptiveThinkingDefault } from '@plannotator/shared/claude-models';

interface AIProviderModel {
  id: string;
  label: string;
  default?: boolean;
}

interface AIProviderInfo {
  id: string;
  name: string;
  models?: AIProviderModel[];
}

const REASONING_EFFORTS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Max' },
] as const;

type ThinkingMode = 'adaptive' | 'disabled';

const THINKING_OPTIONS: Array<{ id: ThinkingMode; label: string; description: string }> = [
  { id: 'adaptive', label: 'On', description: "Claude decides when to think" },
  { id: 'disabled', label: 'Off', description: "No extended thinking" },
];

/**
 * Minimal shape of a fork/resume candidate shown in the Context picker.
 * The server serializes this from provider.listForkCandidates; the client
 * echoes `parentFields` back on session creation.
 */
export interface ForkCandidateSummary {
  id: string;
  label: string;
  lastActiveAt: number;
  model?: string;
  preview?: string;
  tokenEstimate?: number;
  parentFields: Record<string, unknown>;
  inheritance: 'fork' | 'resume';
}

/** The selection the user made in the Context picker; null = New chat. */
export type SelectedContext =
  | null
  | {
      candidateId: string;
      inheritance: 'fork' | 'resume';
      parentFields: Record<string, unknown>;
      label: string;
    };

interface AIConfigBarProps {
  providers: AIProviderInfo[];
  selectedProviderId: string | null;
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  selectedThinking: ThinkingMode | null;
  selectedContext: SelectedContext;
  onProviderChange: (providerId: string) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: string | null) => void;
  onThinkingChange: (thinking: ThinkingMode | null) => void;
  onContextChange: (context: SelectedContext) => void;
  /**
   * Lazy fetch candidates for the currently-selected provider. The component
   * calls this when the Context menu opens and caches the result until the
   * provider changes.
   */
  fetchContextCandidates: () => Promise<ForkCandidateSummary[]>;
  hasSession: boolean;
}

function formatAge(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function formatTokens(n: number | undefined): string | null {
  if (n === undefined) return null;
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K tok`;
  return `${(n / 1_000_000).toFixed(1)}M tok`;
}

export const AIConfigBar: React.FC<AIConfigBarProps> = ({
  providers,
  selectedProviderId,
  selectedModel,
  selectedReasoningEffort,
  selectedThinking,
  selectedContext,
  onProviderChange,
  onModelChange,
  onReasoningEffortChange,
  onThinkingChange,
  onContextChange,
  fetchContextCandidates,
  hasSession,
}) => {
  const [showSessionNote, setShowSessionNote] = useState(false);
  const [openMenu, setOpenMenu] = useState<'provider' | 'model' | 'effort' | 'thinking' | 'context' | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [contextCandidates, setContextCandidates] = useState<ForkCandidateSummary[] | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // When the Context menu opens, fetch candidates lazily. Re-fetch whenever
  // the provider changes (candidates are provider-specific).
  useEffect(() => {
    if (openMenu !== 'context') return;
    let cancelled = false;
    setContextLoading(true);
    fetchContextCandidates()
      .then((list) => { if (!cancelled) setContextCandidates(list); })
      .catch(() => { if (!cancelled) setContextCandidates([]); })
      .finally(() => { if (!cancelled) setContextLoading(false); });
    return () => { cancelled = true; };
  }, [openMenu, fetchContextCandidates]);

  // Clear cached candidates when provider changes — the next menu open
  // will re-fetch for the new provider.
  useEffect(() => {
    setContextCandidates(null);
  }, [selectedProviderId]);

  // Flash "New chat session" briefly when config changes while a session exists
  useEffect(() => {
    if (showSessionNote) {
      const t = setTimeout(() => setShowSessionNote(false), 2000);
      return () => clearTimeout(t);
    }
  }, [showSessionNote]);

  // Close menu on click outside
  useEffect(() => {
    if (!openMenu) return;
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
        setModelSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openMenu]);

  if (providers.length === 0) {
    return (
      <div className="border-t border-border/50 px-2 py-1.5 text-[11px] text-muted-foreground/50">
        No AI providers available
      </div>
    );
  }

  const effectiveProviderId = selectedProviderId ?? providers[0]?.id;
  const currentProvider = providers.find(p => p.id === effectiveProviderId) ?? providers[0];
  if (!currentProvider) return null;

  const meta = getProviderMeta(currentProvider.name);
  const Icon = meta.icon;
  const models = currentProvider.models ?? [];
  const defaultModel = models.find(m => m.default) ?? models[0];
  const effectiveModel = selectedModel ?? defaultModel?.id;
  const currentModelLabel = models.find(m => m.id === effectiveModel)?.label ?? defaultModel?.label;

  const handleProviderSelect = (id: string) => {
    if (hasSession) setShowSessionNote(true);
    onProviderChange(id);
    setOpenMenu(null);
  };

  const handleModelSelect = (id: string) => {
    if (hasSession) setShowSessionNote(true);
    onModelChange(id);
    setOpenMenu(null);
    setModelSearch('');
  };

  const handleEffortSelect = (id: string) => {
    if (hasSession) setShowSessionNote(true);
    onReasoningEffortChange(id);
    setOpenMenu(null);
  };

  const chevron = (
    <svg className="w-2.5 h-2.5 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );

  return (
    <div ref={barRef} className="relative border-t border-border/50 px-2 py-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {/* Provider selector */}
      {providers.length > 1 ? (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenMenu(openMenu === 'provider' ? null : 'provider')}
            className="flex items-center gap-1.5 px-1 py-0.5 -mx-1 rounded hover:bg-muted/50 transition-colors"
          >
            <Icon className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{meta.label}</span>
            {chevron}
          </button>

          {openMenu === 'provider' && (
            <div className="ai-config-menu">
              {providers.map(p => {
                const m = getProviderMeta(p.name);
                const ProvIcon = m.icon;
                const isActive = p.id === effectiveProviderId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleProviderSelect(p.id)}
                    className={`ai-config-menu-item ${isActive ? 'ai-config-menu-item-active' : ''}`}
                  >
                    <ProvIcon className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>{m.label}</span>
                    {isActive && (
                      <svg className="w-3 h-3 ml-auto text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <span className="flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{meta.label}</span>
        </span>
      )}

      {/* Model selector */}
      {models.length > 1 ? (
        <>
          <span className="text-border/60">·</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === 'model' ? null : 'model')}
              className="flex items-center gap-1 px-1 py-0.5 -mx-1 rounded hover:bg-muted/50 transition-colors"
            >
              <span>{currentModelLabel}</span>
              {chevron}
            </button>

            {openMenu === 'model' && (
              <div className="ai-config-menu">
                {models.length > 8 && (
                  <div className="ai-config-menu-search">
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder="Filter models…"
                      value={modelSearch}
                      onChange={e => setModelSearch(e.target.value)}
                      autoFocus
                    />
                  </div>
                )}
                <div className={models.length > 8 ? 'ai-config-menu-scroll' : ''}>
                  {models
                    .filter(m => !modelSearch || m.label.toLowerCase().includes(modelSearch.toLowerCase()))
                    .map(m => {
                      const isActive = m.id === effectiveModel;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => handleModelSelect(m.id)}
                          className={`ai-config-menu-item ${isActive ? 'ai-config-menu-item-active' : ''}`}
                        >
                          <span>{m.label}</span>
                          {isActive && (
                            <svg className="w-3 h-3 ml-auto text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        </>
      ) : currentModelLabel ? (
        <>
          <span className="text-border/60">·</span>
          <span>{currentModelLabel}</span>
        </>
      ) : null}

      {/* Reasoning effort — Claude + Codex */}
      {(currentProvider.name === 'codex-sdk' || currentProvider.name === 'claude-agent-sdk') && (
        <>
          <span className="text-border/60">·</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === 'effort' ? null : 'effort')}
              className="flex items-center gap-1 px-1 py-0.5 -mx-1 rounded hover:bg-muted/50 transition-colors"
              title="Effort"
            >
              <span>{REASONING_EFFORTS.find(e => e.id === (selectedReasoningEffort ?? 'high'))?.label ?? 'High'}</span>
              {chevron}
            </button>

            {openMenu === 'effort' && (
              <div className="ai-config-menu">
                {REASONING_EFFORTS.map(e => {
                  const isActive = e.id === (selectedReasoningEffort ?? 'high');
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => handleEffortSelect(e.id)}
                      className={`ai-config-menu-item ${isActive ? 'ai-config-menu-item-active' : ''}`}
                    >
                      <span>{e.label}</span>
                      {isActive && (
                        <svg className="w-3 h-3 ml-auto text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* Thinking — Claude only, hidden when the selected model auto-defaults
          to adaptive (Opus 4.7+). On older models the user can opt out. */}
      {currentProvider.name === 'claude-agent-sdk' && !isAdaptiveThinkingDefault(effectiveModel) && (
        <>
          <span className="text-border/60">·</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === 'thinking' ? null : 'thinking')}
              className="flex items-center gap-1 px-1 py-0.5 -mx-1 rounded hover:bg-muted/50 transition-colors"
              title="Extended thinking"
            >
              <span>Thinking: {THINKING_OPTIONS.find(t => t.id === (selectedThinking ?? 'adaptive'))?.label ?? 'On'}</span>
              {chevron}
            </button>

            {openMenu === 'thinking' && (
              <div className="ai-config-menu">
                {THINKING_OPTIONS.map(t => {
                  const isActive = t.id === (selectedThinking ?? 'adaptive');
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        if (hasSession) setShowSessionNote(true);
                        onThinkingChange(t.id);
                        setOpenMenu(null);
                      }}
                      className={`ai-config-menu-item ${isActive ? 'ai-config-menu-item-active' : ''}`}
                    >
                      <div className="flex flex-col items-start">
                        <span>{t.label}</span>
                        <span className="text-[10px] text-muted-foreground/60">{t.description}</span>
                      </div>
                      {isActive && (
                        <svg className="w-3 h-3 ml-auto text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* Context picker — always shown. Defaults to "New chat"; opt-in fork/resume. */}
      <span className="text-border/60">·</span>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'context' ? null : 'context')}
          className="flex items-center gap-1 px-1 py-0.5 -mx-1 rounded hover:bg-muted/50 transition-colors"
          title="Chat context"
        >
          <span>{selectedContext
            ? `${selectedContext.inheritance === 'resume' ? 'Resume' : 'Fork'}: ${selectedContext.label}`
            : 'New chat'}</span>
          {chevron}
        </button>
        {openMenu === 'context' && (
          <div className="ai-config-menu ai-config-menu-context">
            <button
              type="button"
              onClick={() => {
                if (hasSession) setShowSessionNote(true);
                onContextChange(null);
                setOpenMenu(null);
              }}
              className={`ai-config-menu-item ${selectedContext === null ? 'ai-config-menu-item-active' : ''}`}
            >
              <div className="flex flex-col items-start">
                <span>New chat</span>
                <span className="text-[10px] text-muted-foreground/60">No prior context</span>
              </div>
              {selectedContext === null && (
                <svg className="w-3 h-3 ml-auto text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
            {contextLoading && (
              <div className="ai-config-menu-item text-muted-foreground/60 cursor-default">
                Loading…
              </div>
            )}
            {!contextLoading && contextCandidates !== null && contextCandidates.length === 0 && (
              <div className="ai-config-menu-item text-muted-foreground/60 cursor-default">
                No prior sessions in this directory
              </div>
            )}
            {!contextLoading && contextCandidates !== null && contextCandidates.length > 0 && (
              <div className="ai-config-menu-section-label">Inherit from</div>
            )}
            {!contextLoading && contextCandidates?.map((c) => {
              const isActive = selectedContext?.candidateId === c.id;
              const metaParts: string[] = [];
              if (c.model) metaParts.push(c.model);
              metaParts.push(formatAge(c.lastActiveAt));
              const tokLabel = formatTokens(c.tokenEstimate);
              if (tokLabel) metaParts.push(tokLabel);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    if (hasSession) setShowSessionNote(true);
                    onContextChange({
                      candidateId: c.id,
                      inheritance: c.inheritance,
                      parentFields: c.parentFields,
                      label: c.label,
                    });
                    setOpenMenu(null);
                  }}
                  className={`ai-config-menu-item ${isActive ? 'ai-config-menu-item-active' : ''}`}
                >
                  <div className="flex flex-col items-start min-w-0 flex-1">
                    <span className="truncate w-full">{c.label}</span>
                    <span className="text-[10px] text-muted-foreground/60 truncate w-full">
                      {metaParts.join(' · ')}
                    </span>
                    {c.inheritance === 'resume' && (
                      <span className="text-[10px] text-amber-500 truncate w-full">
                        ⚠ Writes into original thread
                      </span>
                    )}
                    {c.preview && (
                      <span className="text-[10px] text-muted-foreground/50 truncate w-full italic">
                        “{c.preview}”
                      </span>
                    )}
                  </div>
                  {isActive && (
                    <svg className="w-3 h-3 ml-1 flex-shrink-0 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Session reset note */}
      {showSessionNote && (
        <span className="text-[10px] text-amber-500 animate-pulse">New chat session</span>
      )}
    </div>
  );
};
