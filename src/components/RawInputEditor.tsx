import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, FileUp, Trash2 } from 'lucide-react';

interface RawInputEditorProps {
  leftText: string;
  rightText: string;
  fontSizeRem: number;
  onApply: (left: string, right: string) => void;
  onSwap: (left: string, right: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function countLinesFast(str: string): number {
  if (!str) return 0;
  let count = 1;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) count++;
  }
  return count;
}

export const RawInputEditor: React.FC<RawInputEditorProps> = ({
  leftText,
  rightText,
  fontSizeRem,
  onApply,
  onSwap,
}) => {
  const leftRef = useRef<HTMLTextAreaElement>(null);
  const rightRef = useRef<HTMLTextAreaElement>(null);
  const leftFileInputRef = useRef<HTMLInputElement>(null);
  const rightFileInputRef = useRef<HTMLInputElement>(null);

  const [leftMeta, setLeftMeta] = useState({
    lines: countLinesFast(leftText),
    bytes: leftText.length,
  });
  const [rightMeta, setRightMeta] = useState({
    lines: countLinesFast(rightText),
    bytes: rightText.length,
  });
  const [dragTarget, setDragTarget] = useState<'left' | 'right' | null>(null);

  useEffect(() => {
    if (leftRef.current && leftRef.current.value !== leftText) {
      leftRef.current.value = leftText;
      setLeftMeta({ lines: countLinesFast(leftText), bytes: leftText.length });
    }
  }, [leftText]);

  useEffect(() => {
    if (rightRef.current && rightRef.current.value !== rightText) {
      rightRef.current.value = rightText;
      setRightMeta({ lines: countLinesFast(rightText), bytes: rightText.length });
    }
  }, [rightText]);

  const metaTimerRef = useRef<number | null>(null);

  const syncMeta = useCallback((side: 'left' | 'right') => {
    const el = side === 'left' ? leftRef.current : rightRef.current;
    if (!el) return;
    const len = el.value.length;
    if (len > 100_000) {
      if (metaTimerRef.current) window.clearTimeout(metaTimerRef.current);
      metaTimerRef.current = window.setTimeout(() => {
        const val = el.value;
        const next = { lines: countLinesFast(val), bytes: val.length };
        if (side === 'left') setLeftMeta(next);
        else setRightMeta(next);
      }, 150);
      return;
    }
    const next = { lines: countLinesFast(el.value), bytes: len };
    if (side === 'left') setLeftMeta(next);
    else setRightMeta(next);
  }, []);

  const handleFileLoad = useCallback(
    async (side: 'left' | 'right', file: File) => {
      const content = await file.text();
      const el = side === 'left' ? leftRef.current : rightRef.current;
      if (el) {
        el.value = content;
        syncMeta(side);
      }
      const nextLeft = side === 'left' ? content : leftRef.current?.value ?? leftText;
      const nextRight = side === 'right' ? content : rightRef.current?.value ?? rightText;
      onApply(nextLeft, nextRight);
    },
    [leftText, rightText, onApply, syncMeta]
  );

  const handleClearSide = useCallback(
    (side: 'left' | 'right') => {
      const el = side === 'left' ? leftRef.current : rightRef.current;
      if (!el) return;
      el.value = '';
      syncMeta(side);
    },
    [syncMeta]
  );

  const triggerCompare = useCallback(() => {
    onApply(leftRef.current?.value ?? '', rightRef.current?.value ?? '');
  }, [onApply]);

  const renderPane = (
    side: 'left' | 'right',
    label: string,
    meta: { lines: number; bytes: number },
    textareaRef: React.RefObject<HTMLTextAreaElement | null>,
    fileInputRef: React.RefObject<HTMLInputElement | null>,
    initialValue: string
  ) => {
    const isDragging = dragTarget === side;
    return (
      <section
        className={`flex-1 flex flex-col min-h-0 min-w-0 rounded-lg border transition-colors overflow-hidden ${
          isDragging
            ? 'border-[var(--accent)] bg-[var(--bg-hover)]'
            : 'border-[var(--border-hairline)] bg-[var(--bg-surface)]'
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragTarget(side);
        }}
        onDragLeave={() => setDragTarget(null)}
        onDrop={(e) => {
          e.preventDefault();
          setDragTarget(null);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFileLoad(side, file);
        }}
      >
        <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 sm:px-3.5 sm:py-2 border-b border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-semibold tracking-wide text-[var(--text-primary)] truncate">
              {label}
            </span>
            <span className="text-xs font-mono tabular-nums text-[var(--text-muted)] whitespace-nowrap">
              {meta.lines.toLocaleString()}L · {formatBytes(meta.bytes)}
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileLoad(side, file);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer whitespace-nowrap"
              title="Load local file"
            >
              <FileUp className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Upload</span>
            </button>
            {meta.bytes > 0 && (
              <button
                type="button"
                onClick={() => handleClearSide(side)}
                className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--remove-fg)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                title="Clear text"
                aria-label={`Clear ${label}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <textarea
          ref={textareaRef}
          defaultValue={initialValue}
          onInput={() => syncMeta(side)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={{ fontSize: `${fontSizeRem}rem` }}
          placeholder="Paste text, code, logs, or drop any file here..."
          className="diff-scroll flex-1 w-full h-full min-h-0 p-3 sm:p-4 bg-transparent font-mono leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-faint)] resize-none focus:outline-none"
        />
      </section>
    );
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 p-2.5 sm:p-4 gap-2.5 sm:gap-3 bg-[var(--bg-canvas)]">
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 grid-rows-2 md:grid-rows-1 gap-2.5 sm:gap-3 min-h-0">
        {renderPane('left', 'Original', leftMeta, leftRef, leftFileInputRef, leftText)}
        {renderPane('right', 'Modified', rightMeta, rightRef, rightFileInputRef, rightText)}
      </div>

      <div className="shrink-0 flex items-center justify-between gap-2 pt-0.5">
        <p className="hidden sm:block text-xs text-[var(--text-faint)]">
          Any format or size · Drop files into either panel
        </p>
        <div className="flex items-center gap-2 ml-auto w-full sm:w-auto justify-end">
          <button
            type="button"
            onClick={() => {
              const l = leftRef.current?.value ?? '';
              const r = rightRef.current?.value ?? '';
              onSwap(r, l);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors cursor-pointer whitespace-nowrap"
          >
            <ArrowLeftRight className="w-3.5 h-3.5" />
            <span>Swap</span>
          </button>
          <button
            type="button"
            onClick={triggerCompare}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center px-4 py-1.5 text-xs font-semibold rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)] shadow-sm transition-colors cursor-pointer whitespace-nowrap"
          >
            Find Difference
          </button>
        </div>
      </div>
    </div>
  );
};
