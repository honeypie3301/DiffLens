import React, { useState } from 'react';
import { Sparkles, X, RefreshCw, Copy, Check, AlertCircle, Cpu } from 'lucide-react';

interface ExplainDrawerProps {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  loadingStatus?: string | null;
  error: string | null;
  summary: string | null;
  modelUsed: string | null;
  chunkCount: number;
  focus: 'concise' | 'detailed' | 'risks';
  onFocusChange: (focus: 'concise' | 'detailed' | 'risks') => void;
  onRunExplain: (focusOverride?: 'concise' | 'detailed' | 'risks') => void;
  onRunLocalBrowserAI?: () => void;
  hunksPatch: string;
}

function renderInlineCode(line: string): React.ReactNode {
  const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={idx}
          className="px-1.5 py-0.5 mx-0.5 rounded bg-[var(--bg-hover)] font-mono text-xs text-[var(--text-primary)]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-[var(--text-primary)]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export const ExplainDrawer: React.FC<ExplainDrawerProps> = ({
  open,
  onClose,
  loading,
  loadingStatus,
  error,
  summary,
  modelUsed,
  chunkCount,
  focus,
  onFocusChange,
  onRunExplain,
  onRunLocalBrowserAI,
  hunksPatch,
}) => {
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  if (!open) return null;

  const handleCopyPrompt = () => {
    const prompt = `Explain the following diff hunks concisely:\n\n${hunksPatch}`;
    navigator.clipboard?.writeText(prompt).catch(() => {});
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 1600);
  };

  return (
    <aside className="fixed inset-x-0 bottom-0 h-[64dvh] z-40 lg:static lg:h-auto lg:w-[clamp(19rem,28vw,27rem)] shrink-0 border-t lg:border-t-0 lg:border-l border-[var(--border-hairline)] bg-[var(--bg-surface)] flex flex-col min-h-0 shadow-2xl lg:shadow-none">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border-hairline)]">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
          <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">
            AI Summary
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-colors cursor-pointer"
          aria-label="Close AI summary"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-4 py-2.5 border-b border-[var(--border-hairline)] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 p-0.5 rounded-md bg-[var(--bg-subtle)] border border-[var(--border-hairline)]">
          {(['concise', 'detailed', 'risks'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                onFocusChange(mode);
                onRunExplain(mode);
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap capitalize ${
                focus === mode
                  ? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-xs'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {mode === 'risks' ? 'Risks' : mode}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => onRunExplain()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border border-[var(--border-hairline)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      <div className="diff-scroll flex-1 overflow-y-auto p-4 space-y-3 text-sm leading-relaxed text-[var(--text-primary)]/90">
        {loading && (
          <div className="space-y-2.5 py-2">
            {loadingStatus && (
              <p className="text-xs font-mono text-[var(--text-muted)]">{loadingStatus}</p>
            )}
            <div className="h-3.5 w-3/4 rounded bg-[var(--bg-hover)] animate-pulse" />
            <div className="h-3.5 w-full rounded bg-[var(--bg-hover)] animate-pulse" />
            <div className="h-3.5 w-5/6 rounded bg-[var(--bg-hover)] animate-pulse" />
            <div className="h-3.5 w-2/3 rounded bg-[var(--bg-hover)] animate-pulse" />
          </div>
        )}

        {!loading && error && (
          <div className="p-3.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-xs text-[var(--text-primary)] space-y-2.5">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--text-muted)]" />
              <div className="space-y-1 min-w-0">
                <p className="font-medium">AI provider unavailable</p>
                <p className="text-[var(--text-muted)] leading-relaxed break-words">
                  {error}
                </p>
              </div>
            </div>
            {hunksPatch && (
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {onRunLocalBrowserAI && (
                  <button
                    type="button"
                    onClick={onRunLocalBrowserAI}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)] font-medium cursor-pointer"
                  >
                    <Cpu className="w-3.5 h-3.5" />
                    <span>Run In-Browser AI</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleCopyPrompt}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium cursor-pointer"
                >
                  {copiedPrompt ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedPrompt ? 'Copied Hunk Prompt' : 'Copy Hunk Prompt'}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {!loading && !error && summary && (
          <div className="space-y-2">
            {summary.split('\n').map((rawLine, idx) => {
              const line = rawLine.trim();
              if (!line) return <div key={idx} className="h-1" />;

              if (line.startsWith('### ') || line.startsWith('## ') || line.startsWith('# ')) {
                const heading = line.replace(/^#+\s*/, '');
                return (
                  <h3
                    key={idx}
                    className="pt-2 text-xs font-semibold tracking-wide text-[var(--text-primary)]"
                  >
                    {renderInlineCode(heading)}
                  </h3>
                );
              }

              if (line.startsWith('- ') || line.startsWith('* ')) {
                return (
                  <div key={idx} className="flex items-start gap-2 pl-1">
                    <span className="mt-2 w-1 h-1 rounded-full bg-[var(--text-muted)] shrink-0" />
                    <p className="text-xs sm:text-[0.8125rem] leading-relaxed">
                      {renderInlineCode(line.slice(2))}
                    </p>
                  </div>
                );
              }

              return (
                <p key={idx} className="text-xs sm:text-[0.8125rem] leading-relaxed">
                  {renderInlineCode(line)}
                </p>
              );
            })}
          </div>
        )}
      </div>

      {modelUsed && !loading && !error && (
        <div className="px-4 py-2 border-t border-[var(--border-hairline)] flex items-center justify-between text-xs font-mono tabular-nums text-[var(--text-muted)]">
          <span className="truncate">{modelUsed}</span>
          <span className="shrink-0">
            {chunkCount > 1 ? `${chunkCount} chunks` : 'Hunk context'}
          </span>
        </div>
      )}
    </aside>
  );
};
