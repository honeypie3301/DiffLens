import type { InlineSegment } from '../types/diff';
import { highlightLineTokens, type TokenRun } from './syntaxHighlight';

const MAX_INLINE_RENDER_CHARS = 12000;

interface CombinedSpan {
  text: string;
  className: string;
  changed: boolean;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function intersectRunsAndSegments(runs: TokenRun[], segments: InlineSegment[]): CombinedSpan[] {
  const result: CombinedSpan[] = [];
  let rIdx = 0;
  let sIdx = 0;
  let rOffset = 0;
  let sOffset = 0;

  while (rIdx < runs.length && sIdx < segments.length) {
    const run = runs[rIdx];
    const seg = segments[sIdx];
    const rRem = run.text.length - rOffset;
    const sRem = seg.text.length - sOffset;
    const take = Math.min(rRem, sRem);

    if (take > 0) {
      result.push({
        text: run.text.slice(rOffset, rOffset + take),
        className: run.className,
        changed: seg.changed,
      });
    }

    rOffset += take;
    sOffset += take;

    if (rOffset >= run.text.length) {
      rIdx++;
      rOffset = 0;
    }
    if (sOffset >= seg.text.length) {
      sIdx++;
      sOffset = 0;
    }
  }

  return result;
}

export function renderDiffLineHtml(opts: {
  text: string;
  language: string;
  segments?: InlineSegment[];
  changeKind: 'context' | 'add' | 'remove' | 'modify';
  side?: 'left' | 'right';
  searchQuery?: string;
  expanded?: boolean;
  rowKey: string;
}): string {
  const { text, language, segments, changeKind, side, searchQuery, expanded, rowKey } = opts;

  if (!text) {
    return '<span>&nbsp;</span>';
  }

  const isTruncated = !expanded && text.length > MAX_INLINE_RENDER_CHARS;
  const displayText = isTruncated ? text.slice(0, MAX_INLINE_RENDER_CHARS) : text;

  const runs = highlightLineTokens(displayText, language);

  const isRemovalHighlight =
    changeKind === 'remove' || (changeKind === 'modify' && side === 'left');
  const changedClass = isRemovalHighlight
    ? 'bg-[var(--remove-inline)] text-[var(--text-primary)] rounded-[2px]'
    : 'bg-[var(--add-inline)] text-[var(--text-primary)] rounded-[2px]';

  const spans: CombinedSpan[] =
    !isTruncated && segments && segments.length > 0
      ? intersectRunsAndSegments(runs, segments)
      : runs.map((r) => ({ text: r.text, className: r.className, changed: false }));

  const queryLower = searchQuery ? searchQuery.toLowerCase() : '';
  const htmlParts: string[] = [];

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const cls = span.changed
      ? span.className
        ? `${span.className} ${changedClass}`
        : changedClass
      : span.className;

    let innerHtml: string;
    if (queryLower && span.text.toLowerCase().includes(queryLower)) {
      const lower = span.text.toLowerCase();
      const chunks: string[] = [];
      let cursor = 0;
      let pos = lower.indexOf(queryLower, cursor);
      while (pos !== -1) {
        if (pos > cursor) {
          chunks.push(escapeHtml(span.text.slice(cursor, pos)));
        }
        chunks.push(
          `<mark class="bg-amber-400/40 text-inherit rounded-[2px] ring-1 ring-amber-400/70">${escapeHtml(
            span.text.slice(pos, pos + queryLower.length)
          )}</mark>`
        );
        cursor = pos + queryLower.length;
        pos = lower.indexOf(queryLower, cursor);
      }
      if (cursor < span.text.length) {
        chunks.push(escapeHtml(span.text.slice(cursor)));
      }
      innerHtml = chunks.join('');
    } else {
      innerHtml = escapeHtml(span.text);
    }

    if (cls) {
      htmlParts.push(`<span class="${escapeHtml(cls)}">${innerHtml}</span>`);
    } else {
      htmlParts.push(innerHtml);
    }
  }

  if (isTruncated) {
    const rem = (text.length - MAX_INLINE_RENDER_CHARS).toLocaleString();
    htmlParts.push(
      `<button type="button" data-expand-line="${escapeHtml(
        rowKey
      )}" class="ml-2 px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-primary)] text-[0.7rem] cursor-pointer">+${rem} chars</button>`
    );
  }

  return htmlParts.join('');
}
