import React, { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense } from 'react';
import { PRESENCE_SWATCHES } from '@plannotator/ui/utils/presenceColor';
import { getIdentity, getPresenceColor } from '@plannotator/ui/utils/identity';
import { useLandingCreateRoom } from '@plannotator/ui/hooks/collab/useLandingCreateRoom';
import type { LandingCreateRoomSubmit } from '@plannotator/ui/hooks/collab/useLandingCreateRoom';

const MarkdownPreview = lazy(() => import('./LandingPreview'));

// Sprite: 59x96 native, 24 frames
const SPRITE_NATIVE_W = 59;
const SPRITE_NATIVE_H = 96;
const SPRITE_DISPLAY_H = 96;
const SPRITE_SCALE = SPRITE_DISPLAY_H / SPRITE_NATIVE_H;
const SPRITE_DISPLAY_W = SPRITE_NATIVE_W * SPRITE_SCALE;
const SPRITE_TOTAL_FRAMES = 24;
const SPRITE_SKIP_FRAMES = 4;
const SPRITE_PLAY_FRAMES = SPRITE_TOTAL_FRAMES - SPRITE_SKIP_FRAMES;
const SPRITE_FRAME_DURATION = 2;
const SPRITE_SHEET_W = SPRITE_NATIVE_W * SPRITE_TOTAL_FRAMES * SPRITE_SCALE;
const SPRITE_OFFSET = SPRITE_NATIVE_W * SPRITE_SKIP_FRAMES * SPRITE_SCALE;
const SPRITE_PLAY_W = SPRITE_NATIVE_W * SPRITE_PLAY_FRAMES * SPRITE_SCALE;
const SPRITE_RISE_DURATION = 8;

function FloatingSprite({ side, delay }: { side: 'left' | 'right'; delay: number }) {
  const [visible, setVisible] = useState(false);
  const x = useMemo(() => {
    const min = side === 'left' ? 5 : 55;
    const max = side === 'left' ? 40 : 90;
    return min + Math.random() * (max - min);
  }, [side]);

  useEffect(() => {
    const show = setTimeout(() => setVisible(true), delay);
    const hide = setTimeout(() => setVisible(false), delay + SPRITE_RISE_DURATION * 1000);
    return () => { clearTimeout(show); clearTimeout(hide); };
  }, [delay]);

  if (!visible) return null;

  return (
    <div
      className="fixed pointer-events-none z-50 hidden md:block"
      style={{
        left: `${x}%`,
        bottom: -SPRITE_DISPLAY_H,
        width: SPRITE_DISPLAY_W,
        height: SPRITE_DISPLAY_H,
        backgroundImage: 'url(/sprite.png)',
        backgroundSize: `${SPRITE_SHEET_W}px ${SPRITE_DISPLAY_H}px`,
        backgroundPosition: `-${SPRITE_OFFSET}px center`,
        imageRendering: 'pixelated',
        transform: side === 'right' ? 'scaleX(-1)' : undefined,
        animation: `landing-sprite-play ${SPRITE_FRAME_DURATION}s steps(${SPRITE_PLAY_FRAMES}) infinite, landing-sprite-rise ${SPRITE_RISE_DURATION}s linear forwards`,
      }}
    />
  );
}

const MAX_FILE_SIZE = 500 * 1024;
const ALLOWED_EXTENSIONS = new Set(['md', 'txt', 'markdown', 'html', 'htm']);
const HTML_EXTENSIONS = new Set(['html', 'htm']);

const DEMOS: readonly { label: string; url?: string; staticPath?: string }[] = [
  { label: 'Attention is all you need', staticPath: '/demo-aiayn.md' },
  { label: 'Kimi Paper', staticPath: '/demo-kimi.md' },
  { label: 'Cloudflare Artifacts', url: 'https://developers.cloudflare.com/artifacts/get-started/workers/index.md' },
];

type InputMode = 'upload' | 'paste' | 'url';

export function LandingPage(): React.ReactElement {
  const [markdown, setMarkdown] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [displayName, setDisplayName] = useState(() => getIdentity() || '');
  const [color, setColor] = useState<string>(() => getPresenceColor() || PRESENCE_SWATCHES[0]);
  const [expiresInDays, setExpiresInDays] = useState<0 | 1 | 7 | 30>(7);
  const [fileError, setFileError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasContent = markdown.trim().length > 0;

  const { inFlight, error, handleCreate, handleCancel } = useLandingCreateRoom({ markdown });

  const [urlInput, setUrlInput] = useState('');
  const [urlLoading, setUrlLoading] = useState(false);
  const [showDemos, setShowDemos] = useState(false);

  const loadFile = useCallback(async (file: File) => {
    setFileError('');
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      setFileError(`Unsupported file type (.${ext}). Use .md, .txt, .html, or .markdown.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setFileError(`File too large (${(file.size / 1024).toFixed(0)} KB). Maximum is 500 KB.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    try {
      const text = await file.text();
      if (HTML_EXTENSIONS.has(ext)) {
        const { htmlToMarkdown } = await import('@plannotator/shared/html-to-markdown');
        setMarkdown(htmlToMarkdown(text));
      } else {
        setMarkdown(text);
      }
      setFileName(file.name);
    } catch {
      setFileError('Could not read file. Try again or paste the content instead.');
    }
  }, []);

  const fetchUrl = useCallback(async (url: string) => {
    setUrlLoading(true);
    setFileError('');
    try {
      const res = await fetch('/api/fetch-markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json() as { markdown?: string; source?: string; error?: string };
      if (!res.ok || !data.markdown) {
        throw new Error(data.error || 'Failed to fetch URL');
      }
      setMarkdown(data.markdown);
      setFileName(url);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Failed to fetch URL');
    } finally {
      setUrlLoading(false);
    }
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
  }, [loadFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  }, [loadFile]);

  const handleUrlSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed || urlLoading) return;
    if (!/^https:\/\//i.test(trimmed)) {
      setFileError('Enter a valid URL starting with https://');
      return;
    }
    fetchUrl(trimmed);
  }, [urlInput, urlLoading, fetchUrl]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight || !displayName.trim()) return;
    const submit: LandingCreateRoomSubmit = {
      displayName: displayName.trim(),
      color,
      expiresInDays,
    };
    handleCreate(submit);
  }, [inFlight, displayName, color, expiresInDays, handleCreate]);

  const clearContent = useCallback(() => {
    setMarkdown('');
    setFileName(null);
    setFileError('');
    setUrlInput('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <style>{`
        @keyframes landing-sprite-play { from { background-position: -${SPRITE_OFFSET}px 0; } to { background-position: -${SPRITE_OFFSET + SPRITE_PLAY_W}px 0; } }
        @keyframes landing-sprite-rise { from { bottom: -${SPRITE_DISPLAY_H}px; } to { bottom: 110vh; } }
      `}</style>
      <FloatingSprite side="left" delay={500} />
      <FloatingSprite side="right" delay={2000} />
      {/* Ghost header bar */}
      <div className="h-12 border-b border-border/30 bg-card/30 backdrop-blur-sm flex items-center px-4 shrink-0">
        <div className="flex items-center gap-2 text-sm text-foreground/60">
          <a href="https://github.com/backnotprop/plannotator" target="_blank" rel="noopener noreferrer" className="font-semibold hover:text-foreground/80 transition-colors">
            Plannotator
          </a>
          <span className="text-foreground/20">|</span>
          <a href="https://github.com/backnotprop/plannotator" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-foreground/80 transition-colors">
            <svg className="w-3.5 h-3.5" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" clipRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z" transform="scale(64)" />
            </svg>
            <span className="text-xs">Open Source</span>
          </a>
          <span className="text-foreground/20">|</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-foreground/10 text-foreground/50 font-medium">Beta</span>
        </div>
      </div>

      {/* Workspace area */}
      <div className="flex-1 min-h-0">
        {/* Grid surface with card + overlay */}
        <div className="h-full bg-grid relative overflow-auto">
          {/* Ghost plan card */}
          <div className="absolute inset-0 flex justify-center pt-16 pointer-events-none">
            <div className="w-full max-w-[832px] mx-8">
              <div className="bg-card/5 border border-border/10 rounded-xl h-[600px]" />
            </div>
          </div>

          {/* Foreground: upload form as floating card */}
          <div className="relative z-10 flex justify-center pt-12 pb-12 px-4">
            <div className="w-full max-w-xl space-y-6">
              {/* Main card */}
              <div className="bg-card border border-border/50 rounded-xl shadow-2xl overflow-hidden backdrop-blur-sm">
                <img src="/banner_lite.webp" alt="" className="w-full h-40 object-cover" />
                <div className="p-6 space-y-5">
                <div className="text-center space-y-1">
                  <h1 className="text-lg font-semibold tracking-tight">Start a live review room</h1>
                  <p className="text-xs text-muted-foreground">
                    Upload a plan, invite collaborators, annotate together
                  </p>
                </div>

                {/* Input mode toggle */}
                <div className="flex items-center justify-center gap-2 flex-wrap">
                  {(['upload', 'paste', 'url'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => { setInputMode(mode); setShowDemos(false); }}
                      className={`px-3 py-1 text-xs rounded-full transition-colors ${
                        inputMode === mode && !showDemos
                          ? 'bg-foreground text-background'
                          : 'bg-muted text-muted-foreground hover:bg-muted/80'
                      }`}
                    >
                      {mode === 'upload' ? 'Upload file' : mode === 'paste' ? 'Paste markdown' : 'From URL'}
                    </button>
                  ))}
                  {!hasContent && (
                    <button
                      type="button"
                      onClick={() => setShowDemos(!showDemos)}
                      className={`px-3 py-1 text-xs rounded-full transition-colors ${
                        showDemos
                          ? 'bg-foreground text-background'
                          : 'bg-muted text-muted-foreground hover:bg-muted/80'
                      }`}
                    >
                      Try a demo
                    </button>
                  )}
                </div>

                {/* Demo options */}
                {showDemos && !hasContent && (
                  <div className="flex items-center justify-center gap-2 flex-wrap">
                    {DEMOS.map(demo => (
                      <button
                        key={demo.label}
                        type="button"
                        onClick={() => {
                          setShowDemos(false);
                          if (demo.staticPath) {
                            setUrlLoading(true);
                            setFileError('');
                            fetch(demo.staticPath).then(r => {
                              if (!r.ok) throw new Error('Failed to load demo');
                              return r.text();
                            }).then(text => {
                              setMarkdown(text);
                              setFileName(demo.label);
                            }).catch(err => {
                              setFileError(err instanceof Error ? err.message : 'Failed to load demo');
                            }).finally(() => setUrlLoading(false));
                          } else if (demo.url) {
                            setInputMode('url');
                            setUrlInput(demo.url);
                            fetchUrl(demo.url);
                          }
                        }}
                        disabled={urlLoading}
                        className="px-2.5 py-1 text-xs rounded-full border border-border/50 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50"
                      >
                        {demo.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* Upload zone */}
                {inputMode === 'upload' && !hasContent && (
                  <div
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                      dragOver
                        ? 'border-foreground/50 bg-muted/50'
                        : 'border-border hover:border-foreground/30'
                    }`}
                  >
                    <p className="text-sm text-muted-foreground">
                      Drop a file here, or click to browse
                    </p>
                    <p className="text-xs text-muted-foreground/60 mt-1">
                      .md, .txt, .html, .markdown
                    </p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".md,.txt,.markdown,.html,.htm"
                      onChange={handleFileInput}
                      className="hidden"
                    />
                  </div>
                )}

                {/* Paste textarea */}
                {inputMode === 'paste' && (
                  <textarea
                    value={markdown}
                    onChange={e => setMarkdown(e.target.value)}
                    placeholder="Paste or type your markdown here..."
                    className="w-full h-32 px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono resize-y focus:outline-none focus:ring-1 focus:ring-foreground/20"
                  />
                )}

                {/* URL input */}
                {inputMode === 'url' && !hasContent && (
                  <form onSubmit={handleUrlSubmit} className="flex gap-2">
                    <input
                      type="text"
                      value={urlInput}
                      onChange={e => setUrlInput(e.target.value)}
                      disabled={urlLoading}
                      placeholder="https://example.com/document"
                      className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-foreground/20"
                    />
                    <button
                      type="submit"
                      disabled={urlLoading || !urlInput.trim()}
                      className="px-4 py-2 text-xs font-medium rounded-lg bg-foreground text-background disabled:opacity-50"
                    >
                      {urlLoading ? 'Fetching...' : 'Fetch'}
                    </button>
                  </form>
                )}

                {fileError && (
                  <div className="text-xs bg-destructive/10 text-destructive p-2 rounded" role="alert">
                    {fileError}
                  </div>
                )}

                {/* Compact preview with fade */}
                {hasContent && (
                  <div className="relative rounded-lg border border-border overflow-y-auto max-h-32">
                    <Suspense fallback={null}>
                      <MarkdownPreview markdown={markdown} fileName={null} onClear={clearContent} />
                    </Suspense>
                    <div
                      className="pointer-events-none absolute bottom-0 left-0 right-0 h-12 bg-background"
                      style={{
                        WebkitMaskImage: 'linear-gradient(to top, white, transparent)',
                        maskImage: 'linear-gradient(to top, white, transparent)',
                      }}
                    />
                  </div>
                )}

                {/* Room settings */}
                <form onSubmit={handleSubmit} className="space-y-3 pt-1">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase text-muted-foreground">Name</label>
                      <input
                        type="text"
                        value={displayName}
                        onChange={e => setDisplayName(e.target.value)}
                        disabled={inFlight}
                        className="w-full px-2.5 py-1.5 bg-background border border-border rounded text-sm focus:outline-none focus:ring-1 focus:ring-foreground/20"
                        placeholder="Your name"
                        autoComplete="off"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase text-muted-foreground">Expires</label>
                      <select
                        value={expiresInDays}
                        onChange={e => setExpiresInDays(Number(e.target.value) as 0 | 1 | 7 | 30)}
                        disabled={inFlight}
                        className="w-full px-2.5 py-1.5 bg-background border border-border rounded text-sm"
                      >
                        <option value={1}>1 day</option>
                        <option value={7}>7 days</option>
                        <option value={30}>30 days</option>
                        <option value={0}>Never</option>
                      </select>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium uppercase text-muted-foreground">Color</label>
                    <div className="flex items-center gap-1.5">
                      {PRESENCE_SWATCHES.map(s => (
                        <button
                          key={s}
                          type="button"
                          disabled={inFlight}
                          onClick={() => setColor(s)}
                          className={`w-5 h-5 rounded-full border-2 transition-all ${
                            color === s ? 'border-foreground scale-110' : 'border-transparent'
                          }`}
                          style={{ backgroundColor: s }}
                          aria-label={`Color ${s}`}
                        />
                      ))}
                    </div>
                  </div>

                  {error && (
                    <div className="text-xs bg-destructive/10 text-destructive p-2 rounded" role="alert">
                      {error}
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <p className="text-xs text-muted-foreground/70">
                      {hasContent ? 'Encrypted end-to-end' : 'Upload or paste a document to get started'}
                    </p>
                    <div className="flex items-center gap-2">
                      {inFlight && (
                        <button
                          type="button"
                          onClick={handleCancel}
                          className="px-3 py-1.5 text-xs rounded hover:bg-muted"
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        type="submit"
                        disabled={inFlight || !displayName.trim() || !hasContent}
                        className="px-4 py-1.5 text-xs font-medium rounded bg-foreground text-background disabled:opacity-50"
                      >
                        {inFlight ? 'Creating...' : 'Create room'}
                      </button>
                    </div>
                  </div>
                </form>
                </div>
              {/* Trust footer */}
              <div className="text-center px-6 pb-4 pt-2 space-y-1">
                <p className="text-xs text-muted-foreground/50">
                  All content is end-to-end encrypted on your device. The server only stores ciphertext.
                  Rooms are deleted after their expiry period, or by the creator at any time.
                </p>
                <a href="https://plannotator.ai/privacy/" target="_blank" rel="noopener noreferrer" className="text-[10px] text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors">
                  Privacy Policy
                </a>
              </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
