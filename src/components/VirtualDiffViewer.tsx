import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsUpDown, Copy, Check } from 'lucide-react';
import type {
  DensityMode,
  DiffResult,
  DiffViewMode,
  SplitRow,
  UnifiedRow,
} from '../types/diff';
import { DiffLineContent } from './DiffLineContent';

interface VirtualDiffViewerProps {
  diff: DiffResult;
  viewMode: DiffViewMode;
  language: string;
  wordWrap: boolean;
  collapseUnchanged: boolean;
  syncScroll: boolean;
  density: DensityMode;
  fontSizeRem: number;
  searchQuery: string;
  activeHunkIndex: number | null;
  scrollTrigger: number;
  onEditInputs: () => void;
}

type DisplayItem<T> =
  | { type: 'row'; row: T; originalIndex: number }
  | { type: 'fold'; id: string; count: number; startIndex: number; endIndex: number };

const FOLD_CONTEXT = 3;
const MIN_FOLD_GAP = 8;
const OVERSCAN_ROWS = 6;

function buildFoldedItems<T extends { kind: string }>(
  rows: T[],
  collapseUnchanged: boolean,
  expandedFolds: Set<string>
): DisplayItem<T>[] {
  if (!collapseUnchanged || rows.length === 0) {
    return rows.map((row, idx) => ({ type: 'row', row, originalIndex: idx }));
  }

  const items: DisplayItem<T>[] = [];
  let i = 0;

  while (i < rows.length) {
    if (rows[i].kind !== 'context') {
      items.push({ type: 'row', row: rows[i], originalIndex: i });
      i++;
      continue;
    }

    let j = i;
    while (j < rows.length && rows[j].kind === 'context') {
      j++;
    }

    const runLen = j - i;
    const isLeading = i === 0;
    const isTrailing = j === rows.length;
    const keepStart = isLeading ? 0 : FOLD_CONTEXT;
    const keepEnd = isTrailing ? 0 : FOLD_CONTEXT;
    const foldableCount = runLen - keepStart - keepEnd;

    if (foldableCount >= MIN_FOLD_GAP) {
      const foldStart = i + keepStart;
      const foldEnd = j - keepEnd - 1;
      const foldId = `fold-${foldStart}-${foldEnd}`;

      for (let k = i; k < foldStart; k++) {
        items.push({ type: 'row', row: rows[k], originalIndex: k });
      }

      if (expandedFolds.has(foldId)) {
        for (let k = foldStart; k <= foldEnd; k++) {
          items.push({ type: 'row', row: rows[k], originalIndex: k });
        }
      } else {
        items.push({
          type: 'fold',
          id: foldId,
          count: foldableCount,
          startIndex: foldStart,
          endIndex: foldEnd,
        });
      }

      for (let k = foldEnd + 1; k < j; k++) {
        items.push({ type: 'row', row: rows[k], originalIndex: k });
      }
    } else {
      for (let k = i; k < j; k++) {
        items.push({ type: 'row', row: rows[k], originalIndex: k });
      }
    }

    i = j;
  }

  return items;
}

function findWindowBounds(
  offsets: Float64Array,
  count: number,
  scrollTop: number,
  viewportHeight: number
): { startIdx: number; endIdx: number } {
  if (count === 0) return { startIdx: 0, endIdx: -1 };

  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid + 1] <= scrollTop) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const start = Math.max(0, lo - OVERSCAN_ROWS);

  const bottomTarget = scrollTop + viewportHeight;
  let lo2 = start;
  let hi2 = count - 1;
  while (lo2 < hi2) {
    const mid = (lo2 + hi2) >>> 1;
    if (offsets[mid] < bottomTarget) {
      lo2 = mid + 1;
    } else {
      hi2 = mid;
    }
  }
  const end = Math.min(count - 1, lo2 + OVERSCAN_ROWS);
  return { startIdx: start, endIdx: end };
}

export const VirtualDiffViewer: React.FC<VirtualDiffViewerProps> = ({
  diff,
  viewMode,
  language,
  wordWrap,
  collapseUnchanged,
  syncScroll,
  density,
  fontSizeRem,
  searchQuery,
  activeHunkIndex,
  scrollTrigger,
  onEditInputs,
}) => {
  const unifiedScrollRef = useRef<HTMLDivElement>(null);
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  const syncDriverRef = useRef<'left' | 'right' | null>(null);
  const syncUnlockRafRef = useRef<number | null>(null);
  const leftScrollRafRef = useRef<number | null>(null);
  const rightScrollRafRef = useRef<number | null>(null);
  const pendingLeftTopRef = useRef(0);
  const pendingRightTopRef = useRef(0);

  const [leftScrollTop, setLeftScrollTop] = useState(0);
  const [rightScrollTop, setRightScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(720);
  const [paneWidth, setPaneWidth] = useState(600);
  const [rootFontPx, setRootFontPx] = useState(16);
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(() => new Set());
  const [copiedLineKey, setCopiedLineKey] = useState<string | null>(null);
  const [isDraggingMinimap, setIsDraggingMinimap] = useState(false);

  useEffect(() => {
    setExpandedFolds(new Set());
  }, [diff]);

  useEffect(() => {
    const computed = parseFloat(getComputedStyle(document.documentElement).fontSize);
    if (computed > 0) setRootFontPx(computed);
  }, []);

  const fontSizePx = fontSizeRem * rootFontPx;
  const lineHeightPx = Math.round(fontSizePx * (density === 'compact' ? 1.55 : 1.75));
  const foldRowHeight = Math.round(rootFontPx * 1.75);

  const displayItems = useMemo(() => {
    if (viewMode === 'split') {
      return buildFoldedItems<SplitRow>(diff.splitRows, collapseUnchanged, expandedFolds);
    }
    return buildFoldedItems<UnifiedRow>(diff.unifiedRows, collapseUnchanged, expandedFolds);
  }, [diff, viewMode, collapseUnchanged, expandedFolds]);

  const { offsets, totalHeight, maxLeftChars, maxRightChars } = useMemo(() => {
    const count = displayItems.length;
    const arr = new Float64Array(count + 1);
    const charWidth = fontSizePx * 0.61;
    const gutterPx = rootFontPx * (viewMode === 'split' ? 3.0 : 6.2);
    const availCodePx = Math.max(110, paneWidth - gutterPx - rootFontPx * 1.2);
    const charsPerLine = Math.max(12, Math.floor(availCodePx / charWidth));
    let longestLeft = 0;
    let longestRight = 0;

    for (let i = 0; i < count; i++) {
      const item = displayItems[i];
      let h = lineHeightPx;

      if (item.type === 'fold') {
        h = foldRowHeight;
      } else if (viewMode === 'split') {
        const r = item.row as SplitRow;
        const lLen = Math.min(r.leftText.length, 12000);
        const rLen = Math.min(r.rightText.length, 12000);
        if (lLen > longestLeft) longestLeft = lLen;
        if (rLen > longestRight) longestRight = rLen;
        const maxLen = Math.max(lLen, rLen);
        if (wordWrap && maxLen > charsPerLine) {
          h = Math.ceil(maxLen / charsPerLine) * lineHeightPx;
        }
      } else {
        const r = item.row as UnifiedRow;
        const len = Math.min(r.text.length, 12000);
        if (len > longestLeft) longestLeft = len;
        if (wordWrap && len > charsPerLine) {
          h = Math.ceil(len / charsPerLine) * lineHeightPx;
        }
      }

      arr[i + 1] = arr[i] + h;
    }

    return {
      offsets: arr,
      totalHeight: arr[count] || 0,
      maxLeftChars: longestLeft,
      maxRightChars: longestRight,
    };
  }, [
    displayItems,
    lineHeightPx,
    foldRowHeight,
    fontSizePx,
    rootFontPx,
    viewMode,
    paneWidth,
    wordWrap,
  ]);

  const updateThumbDom = useCallback(
    (topPx: number) => {
      if (!thumbRef.current || totalHeight <= 0) return;
      const thumbH = Math.max(
        20,
        Math.min(viewportHeight, (viewportHeight / totalHeight) * viewportHeight)
      );
      const maxTop = Math.max(0, viewportHeight - thumbH);
      const ratio = totalHeight > viewportHeight ? topPx / (totalHeight - viewportHeight) : 0;
      const thumbY = Math.max(0, Math.min(maxTop, ratio * maxTop));
      thumbRef.current.style.height = `${thumbH}px`;
      thumbRef.current.style.transform = `translate3d(0, ${thumbY}px, 0)`;
    },
    [totalHeight, viewportHeight]
  );

  useEffect(() => {
    updateThumbDom(leftScrollTop);
  }, [leftScrollTop, updateThumbDom]);

  useEffect(() => {
    const target = viewMode === 'split' ? leftScrollRef.current : unifiedScrollRef.current;
    if (!target) return;

    const updateSize = () => {
      setViewportHeight(target.clientHeight);
      setPaneWidth(target.clientWidth);
    };
    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(target);
    return () => observer.disconnect();
  }, [viewMode]);

  useEffect(() => {
    if (viewMode === 'split' && syncScroll && leftScrollRef.current && rightScrollRef.current) {
      rightScrollRef.current.scrollTop = leftScrollRef.current.scrollTop;
      rightScrollRef.current.scrollLeft = leftScrollRef.current.scrollLeft;
      setRightScrollTop(leftScrollRef.current.scrollTop);
    }
  }, [syncScroll, viewMode]);

  const scheduleScrollStateUpdate = useCallback((side: 'left' | 'right', nextTop: number) => {
    if (side === 'left') {
      pendingLeftTopRef.current = nextTop;
      if (leftScrollRafRef.current === null) {
        leftScrollRafRef.current = requestAnimationFrame(() => {
          leftScrollRafRef.current = null;
          setLeftScrollTop(pendingLeftTopRef.current);
        });
      }
    } else {
      pendingRightTopRef.current = nextTop;
      if (rightScrollRafRef.current === null) {
        rightScrollRafRef.current = requestAnimationFrame(() => {
          rightScrollRafRef.current = null;
          setRightScrollTop(pendingRightTopRef.current);
        });
      }
    }
  }, []);

  const handlePaneScroll = useCallback(
    (side: 'left' | 'right', el: HTMLDivElement) => {
      const nextTop = el.scrollTop;
      const nextLeft = el.scrollLeft;

      if (side === 'left' || syncScroll) {
        updateThumbDom(nextTop);
      }

      scheduleScrollStateUpdate(side, nextTop);

      if (!syncScroll || viewMode !== 'split') return;
      if (syncDriverRef.current && syncDriverRef.current !== side) return;

      syncDriverRef.current = side;
      const partner = side === 'left' ? rightScrollRef.current : leftScrollRef.current;
      if (partner) {
        if (partner.scrollTop !== nextTop) {
          partner.scrollTop = nextTop;
          scheduleScrollStateUpdate(side === 'left' ? 'right' : 'left', nextTop);
        }
        if (!wordWrap && partner.scrollLeft !== nextLeft) {
          partner.scrollLeft = nextLeft;
        }
      }

      if (syncUnlockRafRef.current) cancelAnimationFrame(syncUnlockRafRef.current);
      syncUnlockRafRef.current = requestAnimationFrame(() => {
        syncDriverRef.current = null;
      });
    },
    [syncScroll, viewMode, wordWrap, updateThumbDom, scheduleScrollStateUpdate]
  );

  useEffect(() => {
    if (activeHunkIndex === null) return;
    const hunk = diff.hunks[activeHunkIndex];
    if (!hunk) return;

    const targetOriginalIdx =
      viewMode === 'split' ? hunk.splitStartRow : hunk.unifiedStartRow;
    let targetDisplayIdx = 0;
    for (let i = 0; i < displayItems.length; i++) {
      const item = displayItems[i];
      if (item.type === 'row' && item.originalIndex >= targetOriginalIdx) {
        targetDisplayIdx = i;
        break;
      }
      if (item.type === 'fold' && item.endIndex >= targetOriginalIdx) {
        targetDisplayIdx = i;
        break;
      }
    }

    const targetY = Math.max(0, (offsets[targetDisplayIdx] ?? 0) - viewportHeight * 0.2);

    if (viewMode === 'split') {
      leftScrollRef.current?.scrollTo({ top: targetY, behavior: 'smooth' });
      rightScrollRef.current?.scrollTo({ top: targetY, behavior: 'smooth' });
    } else {
      unifiedScrollRef.current?.scrollTo({ top: targetY, behavior: 'smooth' });
    }
  }, [activeHunkIndex, scrollTrigger, diff.hunks, viewMode, displayItems, offsets, viewportHeight]);

  const leftWindow = useMemo(
    () => findWindowBounds(offsets, displayItems.length, leftScrollTop, viewportHeight),
    [offsets, displayItems.length, leftScrollTop, viewportHeight]
  );

  const rightWindow = useMemo(
    () =>
      findWindowBounds(
        offsets,
        displayItems.length,
        syncScroll ? leftScrollTop : rightScrollTop,
        viewportHeight
      ),
    [offsets, displayItems.length, syncScroll, leftScrollTop, rightScrollTop, viewportHeight]
  );

  useEffect(() => {
    const canvas = minimapCanvasRef.current;
    if (!canvas) return;
    const cssWidth = canvas.clientWidth || 12;
    const height = Math.max(100, viewportHeight);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssWidth * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, height);

    const total = displayItems.length;
    if (total === 0) return;

    const scale = height / total;
    const halfW = Math.floor((cssWidth - 3) / 2);

    for (let i = 0; i < total; i++) {
      const item = displayItems[i];
      if (item.type !== 'row') continue;
      const kind = item.row.kind;
      if (kind === 'context') continue;

      const y = Math.floor(i * scale);
      const h = Math.max(2, Math.ceil(scale));

      if (kind === 'remove') {
        ctx.fillStyle = 'rgba(205, 92, 108, 0.85)';
        ctx.fillRect(1, y, halfW, h);
      } else if (kind === 'add') {
        ctx.fillStyle = 'rgba(72, 172, 128, 0.85)';
        ctx.fillRect(cssWidth - halfW - 1, y, halfW, h);
      } else if (kind === 'modify') {
        ctx.fillStyle = 'rgba(205, 92, 108, 0.85)';
        ctx.fillRect(1, y, halfW, h);
        ctx.fillStyle = 'rgba(72, 172, 128, 0.85)';
        ctx.fillRect(cssWidth - halfW - 1, y, halfW, h);
      }
    }
  }, [displayItems, viewportHeight]);

  const handleMinimapJump = useCallback(
    (clientY: number) => {
      const canvas = minimapCanvasRef.current;
      if (!canvas || totalHeight <= 0) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const nextTop = ratio * Math.max(0, totalHeight - viewportHeight);

      if (viewMode === 'split') {
        if (leftScrollRef.current) leftScrollRef.current.scrollTop = nextTop;
        if (syncScroll && rightScrollRef.current) rightScrollRef.current.scrollTop = nextTop;
      } else if (unifiedScrollRef.current) {
        unifiedScrollRef.current.scrollTop = nextTop;
      }
      updateThumbDom(nextTop);
    },
    [totalHeight, viewportHeight, viewMode, syncScroll, updateThumbDom]
  );

  useEffect(() => {
    if (!isDraggingMinimap) return;
    const onMove = (e: MouseEvent) => handleMinimapJump(e.clientY);
    const onUp = () => setIsDraggingMinimap(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDraggingMinimap, handleMinimapJump]);

  const handleCopyLine = useCallback((key: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedLineKey(key);
    setTimeout(() => setCopiedLineKey((prev) => (prev === key ? null : prev)), 1200);
  }, []);

  const expandFold = useCallback((foldId: string) => {
    setExpandedFolds((prev) => {
      const next = new Set(prev);
      next.add(foldId);
      return next;
    });
  }, []);

  const leftMinWidth = useMemo(() => {
    if (wordWrap) return undefined;
    return Math.max(180, Math.ceil(maxLeftChars * fontSizePx * 0.62) + rootFontPx * 5);
  }, [wordWrap, maxLeftChars, fontSizePx, rootFontPx]);

  const rightMinWidth = useMemo(() => {
    if (wordWrap) return undefined;
    return Math.max(180, Math.ceil(maxRightChars * fontSizePx * 0.62) + rootFontPx * 5);
  }, [wordWrap, maxRightChars, fontSizePx, rootFontPx]);

  if (displayItems.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-[var(--bg-canvas)] p-8 text-center">
        <p className="text-sm font-medium text-[var(--text-primary)]">
          Nothing to compare yet
        </p>
        <p className="mt-1.5 text-xs text-[var(--text-muted)] max-w-md">
          Paste text or drop files into the Original and Modified panels to inspect differences.
        </p>
        <button
          type="button"
          onClick={onEditInputs}
          className="mt-4 px-4 py-1.5 text-xs font-semibold rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)] transition-colors cursor-pointer"
        >
          Open Input Panels
        </button>
      </div>
    );
  }

  const useSingleUnifiedScrollbar = viewMode === 'unified' || syncScroll;

  const renderSplitSide = (
    side: 'left' | 'right',
    paneRef: React.RefObject<HTMLDivElement | null>,
    bounds: { startIdx: number; endIdx: number },
    minWidthPx: number | undefined
  ) => (
    <div
      ref={paneRef}
      onScroll={(e) => handlePaneScroll(side, e.currentTarget)}
      className={`flex-1 min-w-0 overflow-auto relative select-text ${
        useSingleUnifiedScrollbar ? 'hide-vertical-scrollbar diff-scroll' : 'diff-scroll'
      } ${side === 'left' ? 'border-r border-[var(--border-hairline)]' : ''}`}
    >
      <div
        style={{
          height: `${totalHeight}px`,
          minWidth: minWidthPx ? `${minWidthPx}px` : '100%',
          position: 'relative',
        }}
      >
        {Array.from({ length: Math.max(0, bounds.endIdx - bounds.startIdx + 1) }, (_, idx) => {
          const itemIndex = bounds.startIdx + idx;
          const item = displayItems[itemIndex];
          if (!item) return null;

          const top = offsets[itemIndex];
          const rowHeight = offsets[itemIndex + 1] - top;

          if (item.type === 'fold') {
            return (
              <div
                key={`${side}-${item.id}`}
                style={{
                  position: 'absolute',
                  top: `${top}px`,
                  left: 0,
                  right: 0,
                  height: `${rowHeight}px`,
                }}
                className="diff-row-contain flex items-center justify-center bg-[var(--bg-subtle)] border-y border-[var(--border-hairline)] text-xs"
              >
                <button
                  type="button"
                  onClick={() => expandFold(item.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer whitespace-nowrap"
                >
                  <ChevronsUpDown className="w-3.5 h-3.5" />
                  <span className="font-mono tabular-nums">
                    Show {item.count.toLocaleString()} lines
                  </span>
                </button>
              </div>
            );
          }

          const row = item.row as SplitRow;
          const isActiveHunk = activeHunkIndex !== null && row.hunkIndex === activeHunkIndex;
          const isLeft = side === 'left';
          const lineNum = isLeft ? row.leftNum : row.rightNum;
          const text = isLeft ? row.leftText : row.rightText;
          const segments = isLeft ? row.leftSegments : row.rightSegments;

          const paneBgStyle: React.CSSProperties | undefined = isLeft
            ? row.kind === 'remove' || row.kind === 'modify'
              ? { backgroundColor: 'var(--remove-bg)' }
              : row.kind === 'add'
              ? { backgroundColor: 'var(--bg-subtle)' }
              : undefined
            : row.kind === 'add' || row.kind === 'modify'
            ? { backgroundColor: 'var(--add-bg)' }
            : row.kind === 'remove'
            ? { backgroundColor: 'var(--bg-subtle)' }
            : undefined;

          const gutterStyle: React.CSSProperties = isLeft
            ? row.kind === 'remove' || row.kind === 'modify'
              ? { backgroundColor: 'var(--remove-gutter)', color: 'var(--remove-fg)' }
              : { backgroundColor: 'var(--bg-subtle)', color: 'var(--text-faint)' }
            : row.kind === 'add' || row.kind === 'modify'
            ? { backgroundColor: 'var(--add-gutter)', color: 'var(--add-fg)' }
            : { backgroundColor: 'var(--bg-subtle)', color: 'var(--text-faint)' };

          return (
            <div
              key={`${side}-${item.originalIndex}`}
              style={{
                position: 'absolute',
                top: `${top}px`,
                left: 0,
                right: 0,
                height: `${rowHeight}px`,
                fontSize: `${fontSizeRem}rem`,
                lineHeight: `${lineHeightPx}px`,
                ...paneBgStyle,
              }}
              className={`diff-row-contain flex font-mono group ${
                isActiveHunk ? 'ring-1 ring-inset ring-[var(--border-strong)]' : ''
              }`}
            >
              <div
                style={gutterStyle}
                className="w-[2.25rem] sm:w-[3.25rem] shrink-0 px-1.5 sm:px-2 text-right select-none tabular-nums border-r border-[var(--border-hairline)]"
              >
                {lineNum ?? ''}
              </div>
              <div
                className={`flex-1 min-w-0 px-2 sm:px-3 relative ${
                  wordWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
                }`}
              >
                {lineNum !== null ? (
                  <DiffLineContent
                    text={text}
                    language={language}
                    segments={segments}
                    changeKind={row.kind}
                    side={side}
                    searchQuery={searchQuery}
                  />
                ) : null}
                {text && (
                  <button
                    type="button"
                    onClick={() => handleCopyLine(`${side}-${item.originalIndex}`, text)}
                    title="Copy line"
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 absolute right-1.5 top-0.5 p-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] transition-opacity"
                  >
                    {copiedLineKey === `${side}-${item.originalIndex}` ? (
                      <Check className="w-3 h-3 text-[var(--add-fg)]" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="relative flex-1 flex min-h-0 overflow-hidden bg-[var(--bg-canvas)]">
      {viewMode === 'split' ? (
        <div className="flex-1 grid grid-cols-2 min-w-0 min-h-0 overflow-hidden">
          {renderSplitSide('left', leftScrollRef, leftWindow, leftMinWidth)}
          {renderSplitSide('right', rightScrollRef, rightWindow, rightMinWidth)}
        </div>
      ) : (
        <div
          ref={unifiedScrollRef}
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop;
            updateThumbDom(top);
            scheduleScrollStateUpdate('left', top);
          }}
          className="diff-scroll hide-vertical-scrollbar flex-1 overflow-auto relative select-text"
        >
          <div
            style={{
              height: `${totalHeight}px`,
              minWidth: leftMinWidth ? `${leftMinWidth + rootFontPx * 2.5}px` : '100%',
              position: 'relative',
            }}
          >
            {Array.from(
              { length: Math.max(0, leftWindow.endIdx - leftWindow.startIdx + 1) },
              (_, idx) => {
                const itemIndex = leftWindow.startIdx + idx;
                const item = displayItems[itemIndex];
                if (!item) return null;

                const top = offsets[itemIndex];
                const rowHeight = offsets[itemIndex + 1] - top;

                if (item.type === 'fold') {
                  return (
                    <div
                      key={item.id}
                      style={{
                        position: 'absolute',
                        top: `${top}px`,
                        left: 0,
                        right: 0,
                        height: `${rowHeight}px`,
                      }}
                      className="diff-row-contain flex items-center justify-center bg-[var(--bg-subtle)] border-y border-[var(--border-hairline)] text-xs"
                    >
                      <button
                        type="button"
                        onClick={() => expandFold(item.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer whitespace-nowrap"
                      >
                        <ChevronsUpDown className="w-3.5 h-3.5" />
                        <span className="font-mono tabular-nums">
                          Show {item.count.toLocaleString()} unchanged lines
                        </span>
                      </button>
                    </div>
                  );
                }

                const row = item.row as UnifiedRow;
                const isActiveHunk =
                  activeHunkIndex !== null && row.hunkIndex === activeHunkIndex;
                const rowBgStyle: React.CSSProperties | undefined =
                  row.kind === 'remove'
                    ? { backgroundColor: 'var(--remove-bg)' }
                    : row.kind === 'add'
                    ? { backgroundColor: 'var(--add-bg)' }
                    : undefined;

                return (
                  <div
                    key={`u-${item.originalIndex}`}
                    style={{
                      position: 'absolute',
                      top: `${top}px`,
                      left: 0,
                      right: 0,
                      height: `${rowHeight}px`,
                      fontSize: `${fontSizeRem}rem`,
                      lineHeight: `${lineHeightPx}px`,
                      ...rowBgStyle,
                    }}
                    className={`diff-row-contain flex font-mono group ${
                      isActiveHunk ? 'ring-1 ring-inset ring-[var(--border-strong)]' : ''
                    }`}
                  >
                    <div className="w-[2.25rem] sm:w-[2.85rem] shrink-0 px-1.5 sm:px-2 text-right select-none tabular-nums border-r border-[var(--border-hairline)] bg-[var(--bg-subtle)] text-[var(--text-faint)]">
                      {row.leftNum ?? ''}
                    </div>
                    <div className="w-[2.25rem] sm:w-[2.85rem] shrink-0 px-1.5 sm:px-2 text-right select-none tabular-nums border-r border-[var(--border-hairline)] bg-[var(--bg-subtle)] text-[var(--text-faint)]">
                      {row.rightNum ?? ''}
                    </div>
                    <div
                      style={{
                        color:
                          row.kind === 'remove'
                            ? 'var(--remove-fg)'
                            : row.kind === 'add'
                            ? 'var(--add-fg)'
                            : 'var(--text-faint)',
                      }}
                      className="w-[1.25rem] sm:w-[1.5rem] shrink-0 text-center select-none font-semibold"
                    >
                      {row.kind === 'remove' ? '-' : row.kind === 'add' ? '+' : ' '}
                    </div>
                    <div
                      className={`flex-1 min-w-0 pr-5 relative ${
                        wordWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
                      }`}
                    >
                      <DiffLineContent
                        text={row.text}
                        language={language}
                        segments={row.segments}
                        changeKind={row.kind}
                        searchQuery={searchQuery}
                      />
                      {row.text && (
                        <button
                          type="button"
                          onClick={() => handleCopyLine(`U-${item.originalIndex}`, row.text)}
                          title="Copy line"
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 absolute right-2 top-0.5 p-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] transition-opacity"
                        >
                          {copiedLineKey === `U-${item.originalIndex}` ? (
                            <Check className="w-3 h-3 text-[var(--add-fg)]" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                );
              }
            )}
          </div>
        </div>
      )}

      {/* Single Unified Minimap Scroll Track */}
      <div
        className="w-[0.75rem] sm:w-[0.875rem] shrink-0 relative border-l border-[var(--border-hairline)] bg-[var(--bg-subtle)] cursor-pointer select-none"
        onMouseDown={(e) => {
          setIsDraggingMinimap(true);
          handleMinimapJump(e.clientY);
        }}
        title="Scrollbar & Diff Overview — click or drag to jump"
      >
        <canvas ref={minimapCanvasRef} className="w-full h-full block" />
        {useSingleUnifiedScrollbar && (
          <div
            ref={thumbRef}
            style={{
              top: 0,
              height: '24px',
              backgroundColor: 'var(--thumb-bg)',
              borderColor: 'var(--thumb-border)',
            }}
            className="absolute left-0 right-0 border-y pointer-events-none will-change-transform"
          />
        )}
      </div>
    </div>
  );
};
