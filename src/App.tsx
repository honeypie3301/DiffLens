import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Columns2,
  Download,
  Link2,
  MoreHorizontal,
  Palette,
  PenSquare,
  Rows3,
  Search,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import type {
  AppThemeId,
  DensityMode,
  DiffResult,
  DiffViewMode,
  DiffWorkerRequest,
  DiffWorkerResponse,
  SavedDiffEntry,
} from './types/diff';
import { detectLanguage, SUPPORTED_LANGUAGES } from './utils/syntaxHighlight';
import { decodeShareHash, encodeShareHash, SAMPLE_PRESETS } from './utils/sampleDiff';
import {
  compactDiffForLocalAi,
  generateInstantLocalSummary,
  runInBrowserLocalAI,
} from './utils/localBrowserAi';
import { VirtualDiffViewer } from './components/VirtualDiffViewer';
import { RawInputEditor } from './components/RawInputEditor';
import { ExplainDrawer } from './components/ExplainDrawer';
import { SavedHistoryDrawer } from './components/SavedHistoryDrawer';

const STORAGE_KEY_SAVED = 'difflens.saved.v1';
const STORAGE_KEY_PREFS = 'difflens.prefs.v3';
const STORAGE_KEY_EXPLAIN = 'difflens.explain.v1';
const API_BASE = ((import.meta as unknown as { env?: { VITE_API_BASE_URL?: string } }).env
  ?.VITE_API_BASE_URL || '').replace(/\/+$/, '');

interface CachedExplainEntry {
  key: string;
  summary: string;
  modelUsed: string;
  chunkCount: number;
  updatedAt: number;
}

function hashPatchKey(patch: string, focus: string): string {
  let h = 2166136261;
  for (let i = 0; i < patch.length; i++) {
    h ^= patch.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${focus}:${patch.length}:${h >>> 0}`;
}

function loadExplainCache(): CachedExplainEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_EXPLAIN);
    if (raw) return JSON.parse(raw) as CachedExplainEntry[];
  } catch {
    // Ignore storage read error
  }
  return [];
}

function saveExplainCacheEntry(entry: CachedExplainEntry): void {
  try {
    const existing = loadExplainCache().filter((e) => e.key !== entry.key);
    const next = [entry, ...existing].slice(0, 20);
    localStorage.setItem(STORAGE_KEY_EXPLAIN, JSON.stringify(next));
  } catch {
    // Ignore storage quota error
  }
}

const VALID_THEMES: AppThemeId[] = ['midnight', 'sage', 'twilight', 'golden', 'alabaster'];

const THEME_OPTIONS: Array<{
  id: AppThemeId;
  label: string;
  swatches: [string, string, string];
}> = [
  { id: 'midnight', label: 'Midnight Mist', swatches: ['#0d1117', '#4c6f8c', '#e6edf3'] },
  { id: 'sage', label: 'Sage & Moss', swatches: ['#0e1411', '#4b7760', '#e3eae4'] },
  { id: 'twilight', label: 'Twilight Lavender', swatches: ['#111018', '#686094', '#eae7f2'] },
  { id: 'golden', label: 'Golden Luxe', swatches: ['#200e01', '#5b0202', '#ede7c7'] },
  { id: 'alabaster', label: 'Warm Alabaster', swatches: ['#f6f3ec', '#455c6e', '#24211c'] },
];

const EMPTY_DIFF: DiffResult = {
  splitRows: [],
  unifiedRows: [],
  hunks: [],
  stats: {
    added: 0,
    removed: 0,
    unchanged: 0,
    totalLeftLines: 0,
    totalRightLines: 0,
    hunkCount: 0,
    computeMs: 0,
  },
  hunksPatch: '',
};

interface SavedPrefs {
  theme: AppThemeId;
  density: DensityMode;
  viewMode: DiffViewMode;
  wordWrap: boolean;
  collapseUnchanged: boolean;
  syncScroll: boolean;
  fontSizeRem: number;
}

const DEFAULT_PREFS: SavedPrefs = {
  theme: 'midnight',
  density: 'compact',
  viewMode: 'split',
  wordWrap: false,
  collapseUnchanged: false,
  syncScroll: true,
  fontSizeRem: 0.8125,
};

function loadPrefs(): SavedPrefs {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY_PREFS) || localStorage.getItem('difflens.prefs.v2');
    if (raw) {
      const parsed = JSON.parse(raw) as Omit<Partial<SavedPrefs>, 'theme'> & { theme?: string };
      const validFont =
        typeof parsed.fontSizeRem === 'number' &&
        parsed.fontSizeRem >= 0.6875 &&
        parsed.fontSizeRem <= 1.25
          ? parsed.fontSizeRem
          : DEFAULT_PREFS.fontSizeRem;
      const validTheme: AppThemeId = VALID_THEMES.includes(parsed.theme as AppThemeId)
        ? (parsed.theme as AppThemeId)
        : parsed.theme === 'light'
        ? 'alabaster'
        : DEFAULT_PREFS.theme;
      return {
        ...DEFAULT_PREFS,
        ...parsed,
        theme: validTheme,
        fontSizeRem: validFont,
      };
    }
  } catch {
    // Ignore storage read error
  }
  return DEFAULT_PREFS;
}

function savePrefs(prefs: SavedPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota error
  }
}

function loadSavedDiffs(): SavedDiffEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SAVED);
    if (raw) return JSON.parse(raw) as SavedDiffEntry[];
  } catch {
    // Ignore
  }
  return [];
}

async function tryChromeBuiltInAI(prompt: string): Promise<string | null> {
  const g = globalThis as unknown as {
    LanguageModel?: {
      availability?: () => Promise<string>;
      create?: (opts?: { systemPrompt?: string }) => Promise<{
        prompt: (input: string) => Promise<string>;
        destroy?: () => void;
      }>;
    };
    ai?: {
      languageModel?: {
        create?: (opts?: { systemPrompt?: string }) => Promise<{
          prompt: (input: string) => Promise<string>;
          destroy?: () => void;
        }>;
      };
    };
  };

  const factory = g.LanguageModel ?? g.ai?.languageModel;
  if (!factory?.create) return null;

  if (g.LanguageModel?.availability) {
    const avail = await g.LanguageModel.availability().catch(() => 'no');
    if (avail === 'no' || avail === 'unavailable') return null;
  }

  const session = await factory.create({
    systemPrompt:
      'You are a senior software engineer reviewing a diff. Explain what changed concisely using bullet points and exact symbol names.',
  });
  try {
    const result = await session.prompt(prompt.slice(0, 24000));
    return result?.trim() || null;
  } finally {
    session.destroy?.();
  }
}

export default function App() {
  const initialPrefs = useMemo(() => loadPrefs(), []);

  const [title, setTitle] = useState<string>('Untitled diff');
  const [leftText, setLeftText] = useState<string>('');
  const [rightText, setRightText] = useState<string>('');
  const [selectedLanguage, setSelectedLanguage] = useState<string>('auto');

  const [workspaceMode, setWorkspaceMode] = useState<'diff' | 'edit'>('edit');
  const [viewMode, setViewMode] = useState<DiffViewMode>(initialPrefs.viewMode);
  const [theme, setTheme] = useState<AppThemeId>(initialPrefs.theme);
  const [density, setDensity] = useState<DensityMode>(initialPrefs.density);
  const [fontSizeRem, setFontSizeRem] = useState<number>(initialPrefs.fontSizeRem);

  const [wordWrap, setWordWrap] = useState<boolean>(initialPrefs.wordWrap);
  const [collapseUnchanged, setCollapseUnchanged] = useState<boolean>(
    initialPrefs.collapseUnchanged
  );
  const [syncScroll, setSyncScroll] = useState<boolean>(initialPrefs.syncScroll);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState<boolean>(false);
  const [ignoreCase, setIgnoreCase] = useState<boolean>(false);
  const [intralineMode, setIntralineMode] = useState<'word' | 'char'>('word');

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [mobileSearchOpen, setMobileSearchOpen] = useState<boolean>(false);
  const [activeHunkIndex, setActiveHunkIndex] = useState<number | null>(null);
  const [scrollTrigger, setScrollTrigger] = useState<number>(0);

  const [diffResult, setDiffResult] = useState<DiffResult>(EMPTY_DIFF);
  const [isComputing, setIsComputing] = useState<boolean>(false);

  const [savedEntries, setSavedEntries] = useState<SavedDiffEntry[]>(() => loadSavedDiffs());
  const [savedOpen, setSavedOpen] = useState<boolean>(false);
  const [optionsOpen, setOptionsOpen] = useState<boolean>(false);
  const [themePickerOpen, setThemePickerOpen] = useState<boolean>(false);
  const [syntaxPickerOpen, setSyntaxPickerOpen] = useState<boolean>(false);
  const [actionsOpen, setActionsOpen] = useState<boolean>(false);
  const [shareCopied, setShareCopied] = useState<boolean>(false);
  const [saveFeedback, setSaveFeedback] = useState<boolean>(false);

  const [explainOpen, setExplainOpen] = useState<boolean>(false);
  const [explainLoading, setExplainLoading] = useState<boolean>(false);
  const [explainStatus, setExplainStatus] = useState<string | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [explainSummary, setExplainSummary] = useState<string | null>(null);
  const [explainModel, setExplainModel] = useState<string | null>(null);
  const [explainChunks, setExplainChunks] = useState<number>(1);
  const [explainFocus, setExplainFocus] = useState<'concise' | 'detailed' | 'risks'>('concise');

  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef<number>(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const optionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.classList.toggle('dark', theme !== 'alabaster');
  }, [theme]);

  useEffect(() => {
    savePrefs({
      theme,
      density,
      viewMode,
      wordWrap,
      collapseUnchanged,
      syncScroll,
      fontSizeRem,
    });
  }, [theme, density, viewMode, wordWrap, collapseUnchanged, syncScroll, fontSizeRem]);

  const updateFontSize = useCallback(
    (delta: number) => {
      setFontSizeRem((prev) => {
        const next = Math.round(Math.min(1.25, Math.max(0.6875, prev + delta)) * 10000) / 10000;
        savePrefs({
          theme,
          density,
          viewMode,
          wordWrap,
          collapseUnchanged,
          syncScroll,
          fontSizeRem: next,
        });
        return next;
      });
    },
    [theme, density, viewMode, wordWrap, collapseUnchanged, syncScroll]
  );

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (optionsMenuRef.current && !optionsMenuRef.current.contains(e.target as Node)) {
        setOptionsOpen(false);
      }
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, []);

  useEffect(() => {
    if (window.location.hash.startsWith('#diff=')) {
      decodeShareHash(window.location.hash).then((decoded) => {
        if (decoded) {
          setTitle(decoded.title || 'Shared diff');
          setSelectedLanguage(decoded.language || 'auto');
          setLeftText(decoded.leftText || '');
          setRightText(decoded.rightText || '');
          setWorkspaceMode('diff');
        }
      });
    }
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL('./workers/diff.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<DiffWorkerResponse>) => {
      if (event.data.id === requestIdRef.current) {
        setDiffResult(event.data.result);
        setIsComputing(false);
        setActiveHunkIndex(event.data.result.hunks.length > 0 ? 0 : null);
      }
    };
    workerRef.current = worker;

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    if (!leftText && !rightText) {
      setDiffResult(EMPTY_DIFF);
      setIsComputing(false);
      setActiveHunkIndex(null);
      return;
    }

    const nextId = ++requestIdRef.current;
    setIsComputing(true);

    const payload: DiffWorkerRequest = {
      id: nextId,
      leftText,
      rightText,
      ignoreWhitespace,
      ignoreCase,
      intralineMode,
    };
    worker.postMessage(payload);
  }, [leftText, rightText, ignoreWhitespace, ignoreCase, intralineMode]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && workspaceMode === 'diff') {
        e.preventDefault();
        if (window.innerWidth < 640) {
          setMobileSearchOpen(true);
          requestAnimationFrame(() => mobileSearchInputRef.current?.focus());
        } else {
          searchInputRef.current?.focus();
        }
      } else if (e.altKey && e.key === 'ArrowDown' && diffResult.hunks.length > 0) {
        e.preventDefault();
        setActiveHunkIndex((prev) =>
          prev === null ? 0 : (prev + 1) % diffResult.hunks.length
        );
        setScrollTrigger((n) => n + 1);
      } else if (e.altKey && e.key === 'ArrowUp' && diffResult.hunks.length > 0) {
        e.preventDefault();
        setActiveHunkIndex((prev) =>
          prev === null
            ? 0
            : (prev - 1 + diffResult.hunks.length) % diffResult.hunks.length
        );
        setScrollTrigger((n) => n + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [workspaceMode, diffResult.hunks.length]);

  const effectiveLanguage = useMemo(() => {
    if (selectedLanguage !== 'auto') return selectedLanguage;
    return detectLanguage(rightText || leftText);
  }, [selectedLanguage, leftText, rightText]);

  const jumpHunk = useCallback(
    (delta: number) => {
      if (diffResult.hunks.length === 0) return;
      setActiveHunkIndex((prev) => {
        if (prev === null) return 0;
        return (prev + delta + diffResult.hunks.length) % diffResult.hunks.length;
      });
      setScrollTrigger((n) => n + 1);
    },
    [diffResult.hunks.length]
  );

  const handleClear = useCallback(() => {
    setTitle('Untitled diff');
    setLeftText('');
    setRightText('');
    setExplainSummary(null);
    setExplainError(null);
    setExplainOpen(false);
    setActionsOpen(false);
    setWorkspaceMode('edit');
  }, []);

  const handleExportPatch = useCallback(() => {
    const header = `--- a/${title || 'original'}\n+++ b/${title || 'modified'}\n`;
    const content = header + (diffResult.hunksPatch || '');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(title || 'diff').replace(/[^\w.-]+/g, '_')}.patch`;
    a.click();
    URL.revokeObjectURL(url);
    setActionsOpen(false);
  }, [title, diffResult.hunksPatch]);

  const handleSave = useCallback(() => {
    const entry: SavedDiffEntry = {
      id: `${Date.now()}`,
      title: title || 'Untitled diff',
      language: effectiveLanguage,
      leftText: leftText.slice(0, 500_000),
      rightText: rightText.slice(0, 500_000),
      updatedAt: Date.now(),
      added: diffResult.stats.added,
      removed: diffResult.stats.removed,
    };
    setSavedEntries((prev) => {
      const next = [entry, ...prev].slice(0, 25);
      try {
        localStorage.setItem(STORAGE_KEY_SAVED, JSON.stringify(next));
      } catch {
        // Ignore quota exceeded
      }
      return next;
    });
    setSaveFeedback(true);
    setTimeout(() => setSaveFeedback(false), 1400);
  }, [
    title,
    effectiveLanguage,
    leftText,
    rightText,
    diffResult.stats.added,
    diffResult.stats.removed,
  ]);

  const handleDeleteSaved = useCallback((id: string) => {
    setSavedEntries((prev) => {
      const next = prev.filter((item) => item.id !== id);
      try {
        localStorage.setItem(STORAGE_KEY_SAVED, JSON.stringify(next));
      } catch {
        // Ignore
      }
      return next;
    });
  }, []);

  const handleShare = useCallback(async () => {
    try {
      const token = await encodeShareHash({
        title,
        language: selectedLanguage,
        leftText,
        rightText,
      });
      const shareUrl = `${window.location.origin}${window.location.pathname}#diff=${token}`;
      window.history.replaceState(null, '', `#diff=${token}`);
      await navigator.clipboard?.writeText(shareUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  }, [title, selectedLanguage, leftText, rightText]);

  const currentExplainKey = useMemo(
    () => (diffResult.hunksPatch ? hashPatchKey(diffResult.hunksPatch, explainFocus) : null),
    [diffResult.hunksPatch, explainFocus]
  );

  // Sync displayed summary cleanly when diff changes
  useEffect(() => {
    if (!currentExplainKey) {
      setExplainSummary(null);
      setExplainModel(null);
      setExplainError(null);
      return;
    }
    const hit = loadExplainCache().find((e) => e.key === currentExplainKey);
    if (hit) {
      setExplainSummary(hit.summary);
      setExplainModel(hit.modelUsed);
      setExplainChunks(hit.chunkCount);
      setExplainError(null);
    } else {
      setExplainSummary(null);
      setExplainModel(null);
    }
  }, [currentExplainKey]);

  const runExplain = useCallback(
    async (focusOverride?: 'concise' | 'detailed' | 'risks', forceRefresh = false) => {
      if (!diffResult.hunksPatch) {
        setExplainOpen(true);
        setExplainError('Compare two non-identical inputs first to generate an AI summary.');
        return;
      }
      const activeFocus = focusOverride ?? explainFocus;
      const cacheKey = hashPatchKey(diffResult.hunksPatch, activeFocus);

      setExplainOpen(true);
      setSavedOpen(false);

      if (!forceRefresh) {
        const hit = loadExplainCache().find((e) => e.key === cacheKey);
        if (hit) {
          setExplainSummary(hit.summary);
          setExplainModel(hit.modelUsed);
          setExplainChunks(hit.chunkCount);
          setExplainError(null);
          return;
        }
      }

      setExplainLoading(true);
      setExplainStatus(null);
      setExplainError(null);

      try {
        const res = await fetch(`${API_BASE}/api/explain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            language: effectiveLanguage,
            hunksPatch: diffResult.hunksPatch,
            stats: diffResult.stats,
            focus: activeFocus,
          }),
        });

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          throw new Error(
            'GitHub Pages serves static files only (no /api/explain route). You can run the in-browser AI model locally below, connect a Vercel backend via VITE_API_BASE_URL, or copy the hunk prompt.'
          );
        }

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Request failed (${res.status})`);
        }

        const chunks = data.chunkCount ?? 1;
        setExplainSummary(data.summary);
        setExplainModel(data.modelUsed);
        setExplainChunks(chunks);
        saveExplainCacheEntry({
          key: cacheKey,
          summary: data.summary,
          modelUsed: data.modelUsed,
          chunkCount: chunks,
          updatedAt: Date.now(),
        });
      } catch (err: unknown) {
        const { compacted } = compactDiffForLocalAi(diffResult.hunksPatch, 12000);
        const localSummary = await tryChromeBuiltInAI(
          `Focus: ${activeFocus}\nTitle: ${title}\nLanguage: ${effectiveLanguage}\n\n${compacted}`
        ).catch(() => null);

        if (localSummary) {
          setExplainSummary(localSummary);
          setExplainModel('chrome-built-in-ai');
          setExplainChunks(1);
          setExplainError(null);
          saveExplainCacheEntry({
            key: cacheKey,
            summary: localSummary,
            modelUsed: 'chrome-built-in-ai',
            chunkCount: 1,
            updatedAt: Date.now(),
          });
        } else {
          const msg = err instanceof Error ? err.message : 'Unable to reach AI explainer.';
          setExplainError(msg);
        }
      } finally {
        setExplainLoading(false);
        setExplainStatus(null);
      }
    },
    [explainFocus, title, effectiveLanguage, diffResult.hunksPatch, diffResult.stats]
  );

  const runLocalBrowserAiFallback = useCallback(async () => {
    if (!diffResult.hunksPatch) return;
    const cacheKey = hashPatchKey(diffResult.hunksPatch, explainFocus);
    setExplainLoading(true);
    setExplainError(null);
    setExplainSummary(null);
    setExplainStatus('Initializing in-browser AI worker...');
    try {
      const res = await runInBrowserLocalAI(
        diffResult.hunksPatch,
        explainFocus,
        title,
        effectiveLanguage,
        (statusText) => setExplainStatus(statusText),
        (partialText) => setExplainSummary(partialText)
      );
      setExplainSummary(res.summary);
      setExplainModel(res.modelUsed);
      setExplainChunks(1);
      setExplainError(null);
      saveExplainCacheEntry({
        key: cacheKey,
        summary: res.summary,
        modelUsed: res.modelUsed,
        chunkCount: 1,
        updatedAt: Date.now(),
      });
    } catch (err: unknown) {
      setExplainSummary(null);
      setExplainError(
        err instanceof Error
          ? `In-browser AI failed to initialize: ${err.message}`
          : 'In-browser AI failed to initialize.'
      );
    } finally {
      setExplainLoading(false);
      setExplainStatus(null);
    }
  }, [diffResult.hunksPatch, explainFocus, title, effectiveLanguage]);

  const runInstantOfflineSummary = useCallback(() => {
    if (!diffResult.hunksPatch) return;
    const cacheKey = hashPatchKey(diffResult.hunksPatch, explainFocus);
    const res = generateInstantLocalSummary({
      hunksPatch: diffResult.hunksPatch,
      stats: diffResult.stats,
      focus: explainFocus,
      title,
      language: effectiveLanguage,
    });
    setExplainError(null);
    setExplainLoading(false);
    setExplainStatus(null);
    setExplainSummary(res.summary);
    setExplainModel(res.modelUsed);
    setExplainChunks(res.chunkCount);
    saveExplainCacheEntry({
      key: cacheKey,
      summary: res.summary,
      modelUsed: res.modelUsed,
      chunkCount: res.chunkCount,
      updatedAt: Date.now(),
    });
  }, [diffResult.hunksPatch, diffResult.stats, explainFocus, title, effectiveLanguage]);

  const loadSample = useCallback(() => {
    const preset = SAMPLE_PRESETS[0];
    setTitle(preset.title);
    setSelectedLanguage('auto');
    setLeftText(preset.leftText);
    setRightText(preset.rightText);
    setExplainSummary(null);
    setOptionsOpen(false);
    setWorkspaceMode('diff');
  }, []);

  const currentThemeObj = useMemo(
    () => THEME_OPTIONS.find((t) => t.id === theme) ?? THEME_OPTIONS[0],
    [theme]
  );

  const renderToggleRow = (
    label: string,
    checked: boolean,
    onToggle: () => void
  ) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-4 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-colors cursor-pointer"
    >
      <span>{label}</span>
      <span
        className={`w-7 h-4 rounded-full p-0.5 transition-colors flex items-center ${
          checked ? 'bg-[var(--accent)] justify-end' : 'bg-[var(--border-strong)] justify-start'
        }`}
      >
        <span className="w-3 h-3 rounded-full bg-[var(--accent-fg)] shadow-xs" />
      </span>
    </button>
  );

  return (
    <div className="h-dvh w-full flex flex-col overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {/* Compact Single-Row Header */}
      <header className="shrink-0 px-2.5 sm:px-5 py-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] flex flex-nowrap items-center justify-between gap-1.5 sm:gap-3">
        {/* Left: Brand + Desktop Editable Title */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm sm:text-base font-semibold tracking-tight text-[var(--text-primary)] whitespace-nowrap shrink-0">
            DiffLens
          </span>
          <span
            className="hidden sm:inline text-[var(--text-faint)] select-none"
            aria-hidden="true"
          >
            /
          </span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Diff title"
            className="hidden sm:block min-w-0 w-[clamp(7rem,18vw,16rem)] px-2 py-1 text-xs sm:text-sm font-medium rounded bg-transparent hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)] text-[var(--text-primary)] focus:outline-none truncate"
          />
        </div>

        {/* Right: Single-Row Controls */}
        <div className="flex flex-nowrap items-center gap-1 sm:gap-2 ml-auto shrink-0">
          {workspaceMode === 'diff' && (
            <>
              <button
                type="button"
                onClick={() => setWorkspaceMode('edit')}
                aria-label="Edit inputs"
                title="Edit inputs"
                className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 text-xs font-medium rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer whitespace-nowrap"
              >
                <PenSquare className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Edit</span>
              </button>

              {/* Mobile: single compact Split/Unified toggle */}
              <button
                type="button"
                onClick={() => setViewMode((v) => (v === 'split' ? 'unified' : 'split'))}
                title={`View: ${viewMode === 'split' ? 'Split' : 'Unified'}`}
                className="sm:hidden inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)] cursor-pointer whitespace-nowrap"
              >
                {viewMode === 'split' ? (
                  <Columns2 className="w-3.5 h-3.5" />
                ) : (
                  <Rows3 className="w-3.5 h-3.5" />
                )}
                <span>{viewMode === 'split' ? 'Split' : 'Unified'}</span>
              </button>

              {/* Desktop: Split | Unified segmented control */}
              <div className="hidden sm:flex items-center gap-0.5 p-0.5 rounded-md bg-[var(--bg-subtle)] border border-[var(--border-hairline)]">
                <button
                  type="button"
                  onClick={() => setViewMode('split')}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                    viewMode === 'split'
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-xs'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  Split
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('unified')}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                    viewMode === 'unified'
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-xs'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  Unified
                </button>
              </div>
            </>
          )}

          {/* Options Popover */}
          <div className="relative" ref={optionsMenuRef}>
            <button
              type="button"
              onClick={() => {
                setOptionsOpen((o) => !o);
                setActionsOpen(false);
              }}
              aria-label="Options"
              className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 text-xs font-medium rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer whitespace-nowrap"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Options</span>
            </button>

            {optionsOpen && (
              <div className="diff-scroll absolute right-0 mt-2 w-[min(18.5rem,92vw)] max-h-[80dvh] overflow-y-auto rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl p-2 z-50 space-y-1">
                {renderToggleRow('Ignore whitespace', ignoreWhitespace, () =>
                  setIgnoreWhitespace((v) => !v)
                )}
                {renderToggleRow('Ignore case', ignoreCase, () => setIgnoreCase((v) => !v))}
                {renderToggleRow('Word wrap', wordWrap, () => setWordWrap((v) => !v))}
                {renderToggleRow('Collapse unchanged', collapseUnchanged, () =>
                  setCollapseUnchanged((v) => !v)
                )}

                <button
                  type="button"
                  role="switch"
                  aria-checked={syncScroll}
                  onClick={() => setSyncScroll((v) => !v)}
                  className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-colors cursor-pointer"
                  title="Bind vertical and horizontal scroll positions between left and right split panes"
                >
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    {syncScroll ? (
                      <Link2 className="w-3.5 h-3.5 text-[var(--accent-hover)] shrink-0" />
                    ) : (
                      <Unlink className="w-3.5 h-3.5 text-[var(--text-faint)] shrink-0" />
                    )}
                    <span className="truncate">Sync scroll</span>
                  </span>
                  <span className="inline-flex items-center gap-2 shrink-0">
                    <span
                      className={`text-[0.6875rem] font-mono ${
                        syncScroll ? 'text-[var(--text-primary)]' : 'text-[var(--text-faint)]'
                      }`}
                    >
                      {syncScroll ? 'Bound' : 'Free'}
                    </span>
                    <span
                      className={`w-7 h-4 rounded-full p-0.5 transition-colors flex items-center ${
                        syncScroll
                          ? 'bg-[var(--accent)] justify-end'
                          : 'bg-[var(--border-strong)] justify-start'
                      }`}
                    >
                      <span className="w-3 h-3 rounded-full bg-[var(--accent-fg)] shadow-xs" />
                    </span>
                  </span>
                </button>

                <div className="my-1 border-t border-[var(--border-hairline)]" />

                <div className="px-3 py-1.5 flex items-center justify-between gap-2 text-xs text-[var(--text-primary)]">
                  <span>Inline detail</span>
                  <div className="flex items-center gap-0.5 p-0.5 rounded bg-[var(--bg-subtle)] border border-[var(--border-hairline)]">
                    {(['word', 'char'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setIntralineMode(m)}
                        className={`px-2 py-0.5 rounded capitalize cursor-pointer ${
                          intralineMode === m
                            ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="px-3 py-1.5 flex items-center justify-between gap-2 text-xs text-[var(--text-primary)]">
                  <span>Row spacing</span>
                  <div className="flex items-center gap-0.5 p-0.5 rounded bg-[var(--bg-subtle)] border border-[var(--border-hairline)]">
                    {(['compact', 'comfortable'] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setDensity(d)}
                        className={`px-2 py-0.5 rounded cursor-pointer ${
                          density === d
                            ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {d === 'compact' ? 'Tight' : 'Airy'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="px-3 py-1.5 flex items-center justify-between gap-2 text-xs text-[var(--text-primary)]">
                  <span>Text size</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => updateFontSize(-0.0625)}
                      className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)] border border-[var(--border-hairline)] cursor-pointer"
                    >
                      -
                    </button>
                    <span className="font-mono tabular-nums w-9 text-center">
                      {Math.round(fontSizeRem * 16)}
                    </span>
                    <button
                      type="button"
                      onClick={() => updateFontSize(0.0625)}
                      className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)] border border-[var(--border-hairline)] cursor-pointer"
                    >
                      +
                    </button>
                  </div>
                </div>

                {/* Theme Picker */}
                <div className="px-3 py-1.5 text-xs text-[var(--text-primary)]">
                  <button
                    type="button"
                    onClick={() => {
                      setThemePickerOpen((o) => !o);
                      setSyntaxPickerOpen(false);
                    }}
                    className="w-full flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Palette className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      <span>Theme</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                      <span
                        className="w-2.5 h-2.5 rounded-full border border-[var(--border-strong)]"
                        style={{ backgroundColor: currentThemeObj.swatches[1] }}
                      />
                      <span>{currentThemeObj.label}</span>
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform ${
                          themePickerOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </span>
                  </button>
                  {themePickerOpen && (
                    <div className="mt-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-subtle)] p-1 space-y-0.5">
                      {THEME_OPTIONS.map((item) => {
                        const active = theme === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setTheme(item.id);
                              setThemePickerOpen(false);
                            }}
                            className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-left cursor-pointer transition-colors ${
                              active
                                ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                                : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                            }`}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="flex items-center -space-x-1 shrink-0">
                                {item.swatches.map((hex, i) => (
                                  <span
                                    key={i}
                                    className="w-3 h-3 rounded-full border border-white/20"
                                    style={{ backgroundColor: hex }}
                                  />
                                ))}
                              </span>
                              <span className="truncate">{item.label}</span>
                            </span>
                            {active && <Check className="w-3 h-3 shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Syntax Picker */}
                <div className="px-3 py-1.5 text-xs text-[var(--text-primary)]">
                  <button
                    type="button"
                    onClick={() => {
                      setSyntaxPickerOpen((s) => !s);
                      setThemePickerOpen(false);
                    }}
                    className="w-full flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <span>Syntax</span>
                    <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
                      <span>
                        {selectedLanguage === 'auto'
                          ? `Auto (${effectiveLanguage})`
                          : SUPPORTED_LANGUAGES.find((l) => l.id === selectedLanguage)?.label ??
                            selectedLanguage}
                      </span>
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform ${
                          syntaxPickerOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </span>
                  </button>
                  {syntaxPickerOpen && (
                    <div className="diff-scroll mt-2 max-h-40 overflow-y-auto rounded border border-[var(--border-hairline)] bg-[var(--bg-subtle)] p-1 space-y-0.5">
                      {SUPPORTED_LANGUAGES.map((lang) => {
                        const active = selectedLanguage === lang.id;
                        return (
                          <button
                            key={lang.id}
                            type="button"
                            onClick={() => {
                              setSelectedLanguage(lang.id);
                              setSyntaxPickerOpen(false);
                            }}
                            className={`w-full flex items-center justify-between px-2 py-1 rounded text-left cursor-pointer transition-colors ${
                              active
                                ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                                : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                            }`}
                          >
                            <span>
                              {lang.id === 'auto' ? `Auto (${effectiveLanguage})` : lang.label}
                            </span>
                            {active && <Check className="w-3 h-3" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="my-1 border-t border-[var(--border-hairline)]" />

                <button
                  type="button"
                  onClick={() => {
                    setSavedOpen((o) => !o);
                    setExplainOpen(false);
                    setOptionsOpen(false);
                  }}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-colors cursor-pointer"
                >
                  <span className="inline-flex items-center gap-2">
                    <Clock className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                    <span>Saved diffs</span>
                  </span>
                  <span className="font-mono tabular-nums text-[var(--text-muted)]">
                    {savedEntries.length}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={loadSample}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-colors cursor-pointer"
                >
                  <span>Load example diff</span>
                </button>
              </div>
            )}
          </div>

          {workspaceMode === 'diff' && (
            <>
              <div className="relative" ref={actionsMenuRef}>
                <button
                  type="button"
                  onClick={() => {
                    setActionsOpen((o) => !o);
                    setOptionsOpen(false);
                  }}
                  aria-label="Diff actions"
                  className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 text-xs font-medium rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer whitespace-nowrap"
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Actions</span>
                </button>

                {actionsOpen && (
                  <div className="absolute right-0 mt-2 w-52 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl p-1.5 z-50 space-y-0.5">
                    <div className="sm:hidden px-2 py-1 border-b border-[var(--border-hairline)] mb-1">
                      <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        aria-label="Diff title"
                        placeholder="Diff title"
                        className="w-full px-2 py-1 text-xs rounded border border-[var(--border-hairline)] bg-[var(--bg-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={handleShare}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-colors cursor-pointer"
                    >
                      {shareCopied ? (
                        <Check className="w-3.5 h-3.5 text-[var(--add-fg)]" />
                      ) : (
                        <Share2 className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      )}
                      <span>{shareCopied ? 'Link copied' : 'Copy share link'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleSave}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-colors cursor-pointer"
                    >
                      {saveFeedback ? (
                        <Check className="w-3.5 h-3.5 text-[var(--add-fg)]" />
                      ) : (
                        <Clock className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      )}
                      <span>{saveFeedback ? 'Saved locally' : 'Save snapshot'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleExportPatch}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-colors cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      <span>Export .patch</span>
                    </button>

                    <div className="my-1 border-t border-[var(--border-hairline)]" />

                    <button
                      type="button"
                      onClick={handleClear}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--remove-fg)] hover:bg-[var(--bg-hover)] rounded transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Clear all</span>
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  if (explainOpen) {
                    setExplainOpen(false);
                  } else if (explainSummary) {
                    setSavedOpen(false);
                    setExplainOpen(true);
                  } else {
                    void runExplain();
                  }
                }}
                aria-label="Explain diff with AI"
                className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-semibold rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)] transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Explain</span>
              </button>
            </>
          )}
        </div>
      </header>

      {/* Single-Row Context Bar */}
      {workspaceMode === 'diff' && (
        <div className="shrink-0 px-2.5 sm:px-5 py-1.5 bg-[var(--bg-subtle)] border-b border-[var(--border-hairline)] flex flex-col gap-1.5">
          <div className="flex flex-nowrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-mono tabular-nums whitespace-nowrap min-w-0">
              <span className="text-[var(--add-fg)] font-medium">
                +{diffResult.stats.added.toLocaleString()}
              </span>
              <span className="text-[var(--remove-fg)] font-medium">
                -{diffResult.stats.removed.toLocaleString()}
              </span>
              <span className="hidden sm:inline text-[var(--text-faint)]" aria-hidden="true">
                ·
              </span>
              <span className="text-[var(--text-muted)] truncate">
                {diffResult.stats.hunkCount}{' '}
                <span className="hidden sm:inline">
                  {diffResult.stats.hunkCount === 1 ? 'change' : 'changes'}
                </span>
              </span>
              {isComputing && <span className="text-[var(--text-faint)]">· Diffing</span>}
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2 ml-auto shrink-0">
              {diffResult.hunks.length > 0 && (
                <div className="flex items-center gap-0.5 border border-[var(--border-hairline)] rounded bg-[var(--bg-surface)]">
                  <button
                    type="button"
                    onClick={() => jumpHunk(-1)}
                    title="Previous change (Alt+Up)"
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                  <span className="px-1.5 text-xs font-mono tabular-nums text-[var(--text-muted)]">
                    {activeHunkIndex !== null ? activeHunkIndex + 1 : 0}/{diffResult.hunks.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => jumpHunk(1)}
                    title="Next change (Alt+Down)"
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Mobile collapsible search toggle */}
              <button
                type="button"
                onClick={() => {
                  setMobileSearchOpen((o) => !o);
                  if (!mobileSearchOpen) {
                    requestAnimationFrame(() => mobileSearchInputRef.current?.focus());
                  }
                }}
                aria-label="Toggle search"
                className={`sm:hidden p-1.5 rounded border cursor-pointer transition-colors ${
                  mobileSearchOpen || searchQuery
                    ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]'
                    : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-muted)]'
                }`}
              >
                <Search className="w-3.5 h-3.5" />
              </button>

              {/* Desktop inline search */}
              <div className="hidden sm:flex relative items-center">
                <Search className="w-3.5 h-3.5 text-[var(--text-faint)] absolute left-2 pointer-events-none" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Find..."
                  className="w-[clamp(7rem,18vw,13rem)] pl-7 pr-2 py-1 text-xs rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
            </div>
          </div>

          {mobileSearchOpen && (
            <div className="sm:hidden flex items-center gap-1.5">
              <div className="relative flex-1 flex items-center">
                <Search className="w-3.5 h-3.5 text-[var(--text-faint)] absolute left-2.5 pointer-events-none" />
                <input
                  ref={mobileSearchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Find in diff..."
                  className="w-full pl-8 pr-2 py-1 text-xs rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setMobileSearchOpen(false);
                }}
                aria-label="Close search"
                className="p-1.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-muted)] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main Viewport + Drawers */}
      <main className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden relative">
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {workspaceMode === 'diff' ? (
            <VirtualDiffViewer
              diff={diffResult}
              viewMode={viewMode}
              language={effectiveLanguage}
              wordWrap={wordWrap}
              collapseUnchanged={collapseUnchanged}
              syncScroll={syncScroll}
              density={density}
              fontSizeRem={fontSizeRem}
              searchQuery={searchQuery}
              activeHunkIndex={activeHunkIndex}
              scrollTrigger={scrollTrigger}
              onEditInputs={() => setWorkspaceMode('edit')}
            />
          ) : (
            <RawInputEditor
              leftText={leftText}
              rightText={rightText}
              fontSizeRem={fontSizeRem}
              onApply={(l, r) => {
                setLeftText(l);
                setRightText(r);
                setWorkspaceMode('diff');
              }}
              onSwap={(l, r) => {
                setLeftText(l);
                setRightText(r);
              }}
            />
          )}
        </div>

        <ExplainDrawer
          open={explainOpen}
          onClose={() => setExplainOpen(false)}
          loading={explainLoading}
          loadingStatus={explainStatus}
          error={explainError}
          summary={explainSummary}
          modelUsed={explainModel}
          chunkCount={explainChunks}
          focus={explainFocus}
          onFocusChange={setExplainFocus}
          onRunExplain={runExplain}
          onRunLocalBrowserAI={runLocalBrowserAiFallback}
          onRunInstantSummary={runInstantOfflineSummary}
          hunksPatch={diffResult.hunksPatch}
        />

        <SavedHistoryDrawer
          open={savedOpen}
          entries={savedEntries}
          onClose={() => setSavedOpen(false)}
          onSelect={(entry) => {
            setTitle(entry.title);
            setSelectedLanguage(entry.language);
            setLeftText(entry.leftText);
            setRightText(entry.rightText);
            setSavedOpen(false);
            setWorkspaceMode('diff');
          }}
          onDelete={handleDeleteSaved}
        />
      </main>
    </div>
  );
}
