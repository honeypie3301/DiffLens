import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DensityMode,
  DiffResult,
  DiffViewMode,
  SplitRow,
  UnifiedRow,
} from '../types/diff';
import { copyTextToClipboard } from '../utils/clipboard';
import { renderDiffLineHtml } from '../utils/diffLineRenderer';

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
const OVERSCAN_ROWS = 10;

const CHEVRONS_UP_DOWN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>';
const COPY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 text-[var(--add-fg)]"><path d="M20 6 9 17l-5-5"/></svg>';

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

interface SplitRowSlot {
  kind: 'row';
  el: HTMLDivElement;
  gutterEl: HTMLDivElement;
  codeWrapEl: HTMLDivElement;
  codeEl: HTMLSpanElement;
  copyBtnEl: HTMLButtonElement;
}

interface UnifiedRowSlot {
  kind: 'row';
  el: HTMLDivElement;
  leftGutterEl: HTMLDivElement;
  rightGutterEl: HTMLDivElement;
  signEl: HTMLDivElement;
  codeWrapEl: HTMLDivElement;
  codeEl: HTMLSpanElement;
  copyBtnEl: HTMLButtonElement;
}

interface FoldSlot {
  kind: 'fold';
  el: HTMLDivElement;
  btnEl: HTMLButtonElement;
  labelEl: HTMLSpanElement;
}

type AnySlot = SplitRowSlot | UnifiedRowSlot | FoldSlot;

interface RenderContext {
  mode: 'left' | 'right' | 'unified';
  displayItems: DisplayItem<SplitRow | UnifiedRow>[];
  offsets: Float64Array;
  language: string;
  wordWrap: boolean;
  fontSizeRem: number;
  lineHeightPx: number;
  searchQuery: string;
  activeHunkIndex: number | null;
  expandedLongLines: Set<string>;
  epoch: number;
}

class DomRowPool {
  private container: HTMLDivElement | null = null;
  private active = new Map<number, AnySlot>();
  private freeRows: Array<SplitRowSlot | UnifiedRowSlot> = [];
  private freeFolds: FoldSlot[] = [];
  private lastStart = -1;
  private lastEnd = -1;
  private lastEpoch = -1;

  attach(container: HTMLDivElement | null) {
    if (this.container === container) return;
    this.clearAll();
    this.container = container;
  }

  clearAll() {
    for (const slot of this.active.values()) {
      slot.el.remove();
    }
    for (const slot of this.freeRows) {
      slot.el.remove();
    }
    for (const slot of this.freeFolds) {
      slot.el.remove();
    }
    this.active.clear();
    this.freeRows.length = 0;
    this.freeFolds.length = 0;
    this.lastStart = -1;
    this.lastEnd = -1;
    this.lastEpoch = -1;
  }

  private releaseAllActive() {
    for (const slot of this.active.values()) {
      slot.el.style.display = 'none';
      if (slot.kind === 'fold') {
        this.freeFolds.push(slot);
      } else {
        this.freeRows.push(slot);
      }
    }
    this.active.clear();
  }

  private acquireFoldSlot(): FoldSlot {
    const recycled = this.freeFolds.pop();
    if (recycled) return recycled;

    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.top = '0';
    el.style.left = '0';
    el.style.right = '0';
    el.className =
      'diff-row-contain flex items-center justify-center bg-[var(--bg-subtle)] border-y border-[var(--border-hairline)] text-xs';

    const btnEl = document.createElement('button');
    btnEl.type = 'button';
    btnEl.className =
      'inline-flex items-center gap-1.5 px-3 py-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer whitespace-nowrap';
    btnEl.innerHTML = CHEVRONS_UP_DOWN_SVG;

    const labelEl = document.createElement('span');
    labelEl.className = 'font-mono tabular-nums';
    btnEl.appendChild(labelEl);
    el.appendChild(btnEl);

    this.container?.appendChild(el);
    return { kind: 'fold', el, btnEl, labelEl };
  }

  private acquireRowSlot(mode: 'left' | 'right' | 'unified'): SplitRowSlot | UnifiedRowSlot {
    const recycled = this.freeRows.pop();
    if (recycled) return recycled;

    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.top = '0';
    el.style.left = '0';
    el.style.right = '0';

    if (mode === 'unified') {
      const leftGutterEl = document.createElement('div');
      leftGutterEl.className =
        'w-[2.25rem] sm:w-[2.85rem] shrink-0 px-1.5 sm:px-2 text-right select-none tabular-nums border-r border-[var(--border-hairline)] bg-[var(--bg-subtle)] text-[var(--text-faint)]';

      const rightGutterEl = document.createElement('div');
      rightGutterEl.className =
        'w-[2.25rem] sm:w-[2.85rem] shrink-0 px-1.5 sm:px-2 text-right select-none tabular-nums border-r border-[var(--border-hairline)] bg-[var(--bg-subtle)] text-[var(--text-faint)]';

      const signEl = document.createElement('div');
      signEl.className =
        'w-[1.25rem] sm:w-[1.5rem] shrink-0 text-center select-none font-semibold';

      const codeWrapEl = document.createElement('div');
      const codeEl = document.createElement('span');

      const copyBtnEl = document.createElement('button');
      copyBtnEl.type = 'button';
      copyBtnEl.title = 'Copy line';
      copyBtnEl.className =
        'opacity-0 group-hover:opacity-100 focus:opacity-100 absolute right-2 top-0.5 p-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] transition-opacity cursor-pointer';
      copyBtnEl.innerHTML = COPY_SVG;

      codeWrapEl.appendChild(codeEl);
      codeWrapEl.appendChild(copyBtnEl);
      el.appendChild(leftGutterEl);
      el.appendChild(rightGutterEl);
      el.appendChild(signEl);
      el.appendChild(codeWrapEl);

      this.container?.appendChild(el);
      return {
        kind: 'row',
        el,
        leftGutterEl,
        rightGutterEl,
        signEl,
        codeWrapEl,
        codeEl,
        copyBtnEl,
      };
    }

    const gutterEl = document.createElement('div');
    gutterEl.className =
      'w-[2.25rem] sm:w-[3.25rem] shrink-0 px-1.5 sm:px-2 text-right select-none tabular-nums border-r border-[var(--border-hairline)]';

    const codeWrapEl = document.createElement('div');
    const codeEl = document.createElement('span');

    const copyBtnEl = document.createElement('button');
    copyBtnEl.type = 'button';
    copyBtnEl.title = 'Copy line';
    copyBtnEl.className =
      'opacity-0 group-hover:opacity-100 focus:opacity-100 absolute right-1.5 top-0.5 p-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] transition-opacity cursor-pointer';
    copyBtnEl.innerHTML = COPY_SVG;

    codeWrapEl.appendChild(codeEl);
    codeWrapEl.appendChild(copyBtnEl);
    el.appendChild(gutterEl);
    el.appendChild(codeWrapEl);

    this.container?.appendChild(el);
    return { kind: 'row', el, gutterEl, codeWrapEl, codeEl, copyBtnEl };
  }

  private renderSlot(itemIndex: number, ctx: RenderContext): AnySlot {
    const item = ctx.displayItems[itemIndex];
    const top = ctx.offsets[itemIndex];
    const rowHeight = ctx.offsets[itemIndex + 1] - top;

    if (item.type === 'fold') {
      const slot = this.acquireFoldSlot();
      slot.el.style.transform = `translate3d(0, ${top}px, 0)`;
      slot.el.style.height = `${rowHeight}px`;
      slot.el.style.display = 'flex';
      slot.btnEl.dataset.foldId = item.id;
      slot.labelEl.textContent =
        ctx.mode === 'unified'
          ? `Show ${item.count.toLocaleString()} unchanged lines`
          : `Show ${item.count.toLocaleString()} lines`;
      return slot;
    }

    const slot = this.acquireRowSlot(ctx.mode);
    slot.el.style.transform = `translate3d(0, ${top}px, 0)`;
    slot.el.style.height = `${rowHeight}px`;
    slot.el.style.fontSize = `${ctx.fontSizeRem}rem`;
    slot.el.style.lineHeight = `${ctx.lineHeightPx}px`;
    slot.el.style.display = 'flex';

    if (ctx.mode === 'unified') {
      const uSlot = slot as UnifiedRowSlot;
      const row = item.row as UnifiedRow;
      const isActiveHunk = ctx.activeHunkIndex !== null && row.hunkIndex === ctx.activeHunkIndex;

      uSlot.el.className = isActiveHunk
        ? 'diff-row-contain flex font-mono group ring-1 ring-inset ring-[var(--border-strong)]'
        : 'diff-row-contain flex font-mono group';
      uSlot.el.style.backgroundColor =
        row.kind === 'remove'
          ? 'var(--remove-bg)'
          : row.kind === 'add'
          ? 'var(--add-bg)'
          : '';

      uSlot.leftGutterEl.textContent = row.leftNum !== null ? String(row.leftNum) : '';
      uSlot.rightGutterEl.textContent = row.rightNum !== null ? String(row.rightNum) : '';

      uSlot.signEl.style.color =
        row.kind === 'remove'
          ? 'var(--remove-fg)'
          : row.kind === 'add'
          ? 'var(--add-fg)'
          : 'var(--text-faint)';
      uSlot.signEl.textContent = row.kind === 'remove' ? '-' : row.kind === 'add' ? '+' : ' ';

      uSlot.codeWrapEl.className = ctx.wordWrap
        ? 'flex-1 min-w-0 pr-5 relative whitespace-pre-wrap break-all'
        : 'flex-1 min-w-0 pr-5 relative whitespace-pre';

      const rowKey = `U-${item.originalIndex}`;
      uSlot.codeEl.innerHTML = renderDiffLineHtml({
        text: row.text,
        language: ctx.language,
        segments: row.segments,
        changeKind: row.kind,
        searchQuery: ctx.searchQuery,
        expanded: ctx.expandedLongLines.has(rowKey),
        rowKey,
      });

      if (row.text) {
        uSlot.copyBtnEl.style.display = '';
        uSlot.copyBtnEl.dataset.copyIdx = String(itemIndex);
        uSlot.copyBtnEl.innerHTML = COPY_SVG;
      } else {
        uSlot.copyBtnEl.style.display = 'none';
        delete uSlot.copyBtnEl.dataset.copyIdx;
      }
      return uSlot;
    }

    const sSlot = slot as SplitRowSlot;
    const row = item.row as SplitRow;
    const isLeft = ctx.mode === 'left';
    const isActiveHunk = ctx.activeHunkIndex !== null && row.hunkIndex === ctx.activeHunkIndex;
    const lineNum = isLeft ? row.leftNum : row.rightNum;
    const text = isLeft ? row.leftText : row.rightText;
    const segments = isLeft ? row.leftSegments : row.rightSegments;

    sSlot.el.className = isActiveHunk
      ? 'diff-row-contain flex font-mono group ring-1 ring-inset ring-[var(--border-strong)]'
      : 'diff-row-contain flex font-mono group';

    sSlot.el.style.backgroundColor = isLeft
      ? row.kind === 'remove' || row.kind === 'modify'
        ? 'var(--remove-bg)'
        : row.kind === 'add'
        ? 'var(--bg-subtle)'
        : ''
      : row.kind === 'add' || row.kind === 'modify'
      ? 'var(--add-bg)'
      : row.kind === 'remove'
      ? 'var(--bg-subtle)'
      : '';

    if (
      (isLeft && (row.kind === 'remove' || row.kind === 'modify')) ||
      (!isLeft && (row.kind === 'add' || row.kind === 'modify'))
    ) {
      sSlot.gutterEl.style.backgroundColor = isLeft
        ? 'var(--remove-gutter)'
        : 'var(--add-gutter)';
      sSlot.gutterEl.style.color = isLeft ? 'var(--remove-fg)' : 'var(--add-fg)';
    } else {
      sSlot.gutterEl.style.backgroundColor = 'var(--bg-subtle)';
      sSlot.gutterEl.style.color = 'var(--text-faint)';
    }
    sSlot.gutterEl.textContent = lineNum !== null ? String(lineNum) : '';

    sSlot.codeWrapEl.className = ctx.wordWrap
      ? 'flex-1 min-w-0 px-2 sm:px-3 relative whitespace-pre-wrap break-all'
      : 'flex-1 min-w-0 px-2 sm:px-3 relative whitespace-pre';

    if (lineNum !== null) {
      const rowKey = `${ctx.mode}-${item.originalIndex}`;
      sSlot.codeEl.innerHTML = renderDiffLineHtml({
        text,
        language: ctx.language,
        segments,
        changeKind: row.kind,
        side: ctx.mode,
        searchQuery: ctx.searchQuery,
        expanded: ctx.expandedLongLines.has(rowKey),
        rowKey,
      });
    } else {
      sSlot.codeEl.innerHTML = '';
    }

    if (text) {
      sSlot.copyBtnEl.style.display = '';
      sSlot.copyBtnEl.dataset.copyIdx = String(itemIndex);
      sSlot.copyBtnEl.innerHTML = COPY_SVG;
    } else {
      sSlot.copyBtnEl.style.display = 'none';
      delete sSlot.copyBtnEl.dataset.copyIdx;
    }

    return sSlot;
  }

  paint(scrollTop: number, viewportHeight: number, ctx: RenderContext) {
    if (!this.container) return;
    const { startIdx, endIdx } = findWindowBounds(
      ctx.offsets,
      ctx.displayItems.length,
      scrollTop,
      viewportHeight
    );

    const epochChanged = ctx.epoch !== this.lastEpoch;
    if (!epochChanged && startIdx === this.lastStart && endIdx === this.lastEnd) {
      return;
    }

    if (epochChanged) {
      this.releaseAllActive();
    } else {
      for (const [idx, slot] of this.active.entries()) {
        if (idx < startIdx || idx > endIdx) {
          slot.el.style.display = 'none';
          if (slot.kind === 'fold') {
            this.freeFolds.push(slot);
          } else {
            this.freeRows.push(slot);
          }
          this.active.delete(idx);
        }
      }
    }

    for (let idx = startIdx; idx <= endIdx; idx++) {
      if (!this.active.has(idx)) {
        const slot = this.renderSlot(idx, ctx);
        this.active.set(idx, slot);
      }
    }

    this.lastStart = startIdx;
    this.lastEnd = endIdx;
    this.lastEpoch = ctx.epoch;
  }

  repaintSingle(itemIndex: number, ctx: RenderContext) {
    const existing = this.active.get(itemIndex);
    if (!existing) return;
    existing.el.style.display = 'none';
    if (existing.kind === 'fold') {
      this.freeFolds.push(existing);
    } else {
      this.freeRows.push(existing);
    }
    this.active.delete(itemIndex);
    const updated = this.renderSlot(itemIndex, ctx);
    this.active.set(itemIndex, updated);
  }
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
  const leftInnerRef = useRef<HTMLDivElement>(null);
  const rightInnerRef = useRef<HTMLDivElement>(null);
  const unifiedInnerRef = useRef<HTMLDivElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  const leftPoolRef = useRef<DomRowPool>(new DomRowPool());
  const rightPoolRef = useRef<DomRowPool>(new DomRowPool());
  const unifiedPoolRef = useRef<DomRowPool>(new DomRowPool());

  const suppressScrollRef = useRef<{
    left: { top: number; left: number | null; until: number } | null;
    right: { top: number; left: number | null; until: number } | null;
  }>({ left: null, right: null });

  const expandedLongLinesRef = useRef<Set<string>>(new Set());
  const renderEpochRef = useRef<number>(0);

  const [viewportHeight, setViewportHeight] = useState(720);
  const [paneWidth, setPaneWidth] = useState(600);
  const [rootFontPx, setRootFontPx] = useState(16);
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(() => new Set());
  const [isDraggingMinimap, setIsDraggingMinimap] = useState(false);

  useEffect(() => {
    setExpandedFolds(new Set());
    expandedLongLinesRef.current.clear();
  }, [diff]);

  useEffect(() => {
    const computed = parseFloat(getComputedStyle(document.documentElement).fontSize);
    if (computed > 0) setRootFontPx(computed);
  }, []);

  const fontSizePx = fontSizeRem * rootFontPx;
  const lineHeightPx = Math.max(2, Math.round(fontSizePx * (density === 'compact' ? 1.55 : 1.75)));
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

  const leftCtx = useMemo<RenderContext>(
    () => ({
      mode: 'left',
      displayItems: displayItems as DisplayItem<SplitRow | UnifiedRow>[],
      offsets,
      language,
      wordWrap,
      fontSizeRem,
      lineHeightPx,
      searchQuery,
      activeHunkIndex,
      expandedLongLines: expandedLongLinesRef.current,
      epoch: ++renderEpochRef.current,
    }),
    [displayItems, offsets, language, wordWrap, fontSizeRem, lineHeightPx, searchQuery, activeHunkIndex]
  );

  const rightCtx = useMemo<RenderContext>(
    () => ({
      ...leftCtx,
      mode: 'right',
    }),
    [leftCtx]
  );

  const unifiedCtx = useMemo<RenderContext>(
    () => ({
      ...leftCtx,
      mode: 'unified',
    }),
    [leftCtx]
  );

  const latestCtxRef = useRef({ leftCtx, rightCtx, unifiedCtx, viewportHeight });
  latestCtxRef.current = { leftCtx, rightCtx, unifiedCtx, viewportHeight };

  useEffect(() => {
    if (viewMode === 'split') {
      unifiedPoolRef.current.clearAll();
      leftPoolRef.current.attach(leftInnerRef.current);
      rightPoolRef.current.attach(rightInnerRef.current);
      const lTop = leftScrollRef.current?.scrollTop ?? 0;
      const rTop = syncScroll ? lTop : rightScrollRef.current?.scrollTop ?? 0;
      leftPoolRef.current.paint(lTop, viewportHeight, leftCtx);
      rightPoolRef.current.paint(rTop, viewportHeight, rightCtx);
      updateThumbDom(lTop);
    } else {
      leftPoolRef.current.clearAll();
      rightPoolRef.current.clearAll();
      unifiedPoolRef.current.attach(unifiedInnerRef.current);
      const uTop = unifiedScrollRef.current?.scrollTop ?? 0;
      unifiedPoolRef.current.paint(uTop, viewportHeight, unifiedCtx);
      updateThumbDom(uTop);
    }
  }, [viewMode, syncScroll, viewportHeight, leftCtx, rightCtx, unifiedCtx, updateThumbDom]);

  useEffect(() => {
    const leftPool = leftPoolRef.current;
    const rightPool = rightPoolRef.current;
    const unifiedPool = unifiedPoolRef.current;
    return () => {
      leftPool.clearAll();
      rightPool.clearAll();
      unifiedPool.clearAll();
    };
  }, []);

  useEffect(() => {
    const target = viewMode === 'split' ? leftScrollRef.current : unifiedScrollRef.current;
    if (!target) return;

    const updateSize = () => {
      const h = target.clientHeight;
      const w = target.clientWidth;
      setViewportHeight((prev) => (Math.abs(prev - h) > 0.5 ? h : prev));
      setPaneWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
    };
    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(target);
    return () => observer.disconnect();
  }, [viewMode, displayItems.length]);

  useEffect(() => {
    if (viewMode === 'split' && syncScroll && leftScrollRef.current && rightScrollRef.current) {
      const lTop = leftScrollRef.current.scrollTop;
      const lLeft = leftScrollRef.current.scrollLeft;
      suppressScrollRef.current.right = {
        top: lTop,
        left: wordWrap ? null : lLeft,
        until: performance.now() + 80,
      };
      rightScrollRef.current.scrollTop = lTop;
      if (!wordWrap) {
        rightScrollRef.current.scrollLeft = lLeft;
      }
      rightPoolRef.current.paint(
        lTop,
        latestCtxRef.current.viewportHeight,
        latestCtxRef.current.rightCtx
      );
    }
  }, [syncScroll, viewMode, wordWrap]);

  const handlePaneScroll = useCallback(
    (side: 'left' | 'right', el: HTMLDivElement) => {
      const nextTop = el.scrollTop;
      const nextLeft = el.scrollLeft;
      const sup = suppressScrollRef.current[side];

      if (
        sup &&
        performance.now() <= sup.until &&
        Math.abs(nextTop - sup.top) <= 1.5 &&
        (sup.left === null || Math.abs(nextLeft - sup.left) <= 1.5)
      ) {
        suppressScrollRef.current[side] = null;
        return;
      }
      suppressScrollRef.current[side] = null;

      const {
        leftCtx: lCtx,
        rightCtx: rCtx,
        viewportHeight: vh,
      } = latestCtxRef.current;

      if (side === 'left') {
        updateThumbDom(nextTop);
        leftPoolRef.current.paint(nextTop, vh, lCtx);
      } else {
        if (syncScroll) updateThumbDom(nextTop);
        rightPoolRef.current.paint(nextTop, vh, rCtx);
      }

      if (!syncScroll || viewMode !== 'split') return;

      const partnerSide = side === 'left' ? 'right' : 'left';
      const partner = side === 'left' ? rightScrollRef.current : leftScrollRef.current;
      if (partner) {
        const topDiff = Math.abs(partner.scrollTop - nextTop) > 0.5;
        const leftDiff = !wordWrap && Math.abs(partner.scrollLeft - nextLeft) > 0.5;
        if (topDiff || leftDiff) {
          suppressScrollRef.current[partnerSide] = {
            top: nextTop,
            left: wordWrap ? null : nextLeft,
            until: performance.now() + 80,
          };
          if (topDiff) partner.scrollTop = nextTop;
          if (leftDiff) partner.scrollLeft = nextLeft;
        }
        if (partnerSide === 'right') {
          rightPoolRef.current.paint(nextTop, vh, rCtx);
        } else {
          leftPoolRef.current.paint(nextTop, vh, lCtx);
        }
      }
    },
    [syncScroll, viewMode, wordWrap, updateThumbDom]
  );

  const handleUnifiedScroll = useCallback(
    (el: HTMLDivElement) => {
      const top = el.scrollTop;
      updateThumbDom(top);
      unifiedPoolRef.current.paint(
        top,
        latestCtxRef.current.viewportHeight,
        latestCtxRef.current.unifiedCtx
      );
    },
    [updateThumbDom]
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
      const {
        leftCtx: lCtx,
        rightCtx: rCtx,
        unifiedCtx: uCtx,
        viewportHeight: vh,
      } = latestCtxRef.current;

      if (viewMode === 'split') {
        if (leftScrollRef.current) {
          leftScrollRef.current.scrollTop = nextTop;
          leftPoolRef.current.paint(nextTop, vh, lCtx);
        }
        if (syncScroll && rightScrollRef.current) {
          suppressScrollRef.current.right = {
            top: nextTop,
            left: null,
            until: performance.now() + 80,
          };
          rightScrollRef.current.scrollTop = nextTop;
          rightPoolRef.current.paint(nextTop, vh, rCtx);
        }
      } else if (unifiedScrollRef.current) {
        unifiedScrollRef.current.scrollTop = nextTop;
        unifiedPoolRef.current.paint(nextTop, vh, uCtx);
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

  const expandFold = useCallback((foldId: string) => {
    setExpandedFolds((prev) => {
      const next = new Set(prev);
      next.add(foldId);
      return next;
    });
  }, []);

  const handleContainerClick = useCallback(
    (mode: 'left' | 'right' | 'unified', e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const foldBtn = target.closest<HTMLElement>('[data-fold-id]');
      if (foldBtn?.dataset.foldId) {
        expandFold(foldBtn.dataset.foldId);
        return;
      }

      const expandBtn = target.closest<HTMLElement>('[data-expand-line]');
      if (expandBtn?.dataset.expandLine) {
        const key = expandBtn.dataset.expandLine;
        expandedLongLinesRef.current.add(key);
        const rawIdx = key.split('-')[1];
        const origIdx = Number(rawIdx);
        const list = latestCtxRef.current.leftCtx.displayItems;
        const itemIndex = list.findIndex(
          (it) => it.type === 'row' && it.originalIndex === origIdx
        );
        if (itemIndex !== -1) {
          if (mode === 'left') {
            leftPoolRef.current.repaintSingle(itemIndex, latestCtxRef.current.leftCtx);
          } else if (mode === 'right') {
            rightPoolRef.current.repaintSingle(itemIndex, latestCtxRef.current.rightCtx);
          } else {
            unifiedPoolRef.current.repaintSingle(itemIndex, latestCtxRef.current.unifiedCtx);
          }
        }
        return;
      }

      const copyBtn = target.closest<HTMLButtonElement>('[data-copy-idx]');
      if (copyBtn?.dataset.copyIdx) {
        const itemIndex = Number(copyBtn.dataset.copyIdx);
        const item = latestCtxRef.current.leftCtx.displayItems[itemIndex];
        if (!item || item.type !== 'row') return;
        const text =
          mode === 'unified'
            ? (item.row as UnifiedRow).text
            : mode === 'left'
            ? (item.row as SplitRow).leftText
            : (item.row as SplitRow).rightText;
        void copyTextToClipboard(text).then((ok) => {
          if (!ok) return;
          copyBtn.innerHTML = CHECK_SVG;
          window.setTimeout(() => {
            if (copyBtn.isConnected) copyBtn.innerHTML = COPY_SVG;
          }, 1200);
        });
      }
    },
    [expandFold]
  );

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

  return (
    <div className="relative flex-1 flex min-h-0 overflow-hidden bg-[var(--bg-canvas)]">
      {viewMode === 'split' ? (
        <div className="flex-1 grid grid-cols-2 min-w-0 min-h-0 overflow-hidden">
          <div
            ref={leftScrollRef}
            onScroll={(e) => handlePaneScroll('left', e.currentTarget)}
            onClick={(e) => handleContainerClick('left', e)}
            className={`flex-1 min-w-0 overflow-auto overscroll-contain relative select-text border-r border-[var(--border-hairline)] ${
              useSingleUnifiedScrollbar ? 'hide-vertical-scrollbar diff-scroll' : 'diff-scroll'
            }`}
          >
            <div
              ref={leftInnerRef}
              style={{
                height: `${totalHeight}px`,
                minWidth: leftMinWidth ? `${leftMinWidth}px` : '100%',
                position: 'relative',
              }}
            />
          </div>

          <div
            ref={rightScrollRef}
            onScroll={(e) => handlePaneScroll('right', e.currentTarget)}
            onClick={(e) => handleContainerClick('right', e)}
            className={`flex-1 min-w-0 overflow-auto overscroll-contain relative select-text ${
              useSingleUnifiedScrollbar ? 'hide-vertical-scrollbar diff-scroll' : 'diff-scroll'
            }`}
          >
            <div
              ref={rightInnerRef}
              style={{
                height: `${totalHeight}px`,
                minWidth: rightMinWidth ? `${rightMinWidth}px` : '100%',
                position: 'relative',
              }}
            />
          </div>
        </div>
      ) : (
        <div
          ref={unifiedScrollRef}
          onScroll={(e) => handleUnifiedScroll(e.currentTarget)}
          onClick={(e) => handleContainerClick('unified', e)}
          className="diff-scroll hide-vertical-scrollbar flex-1 overflow-auto overscroll-contain relative select-text"
        >
          <div
            ref={unifiedInnerRef}
            style={{
              height: `${totalHeight}px`,
              minWidth: leftMinWidth ? `${leftMinWidth + rootFontPx * 2.5}px` : '100%',
              position: 'relative',
            }}
          />
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
