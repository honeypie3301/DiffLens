import React, { useMemo, useState } from 'react';
import type { InlineSegment } from '../types/diff';
import { highlightLineTokens, type TokenRun } from '../utils/syntaxHighlight';

const MAX_INLINE_RENDER_CHARS = 12000;

interface CombinedSpan {
  text: string;
  className: string;
  changed: boolean;
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

interface DiffLineContentProps {
  text: string;
  language: string;
  segments?: InlineSegment[];
  changeKind: 'context' | 'add' | 'remove' | 'modify';
  side?: 'left' | 'right';
  searchQuery?: string;
}

export const DiffLineContent: React.FC<DiffLineContentProps> = React.memo(
  ({ text, language, segments, changeKind, side, searchQuery }) => {
    const [expandedLongLine, setExpandedLongLine] = useState(false);

    const isTruncated = !expandedLongLine && text.length > MAX_INLINE_RENDER_CHARS;
    const displayText = isTruncated ? text.slice(0, MAX_INLINE_RENDER_CHARS) : text;

    const rendered = useMemo(() => {
      if (!displayText) {
        return <span>{'\u00A0'}</span>;
      }

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

      return spans.map((span, idx) => {
        if (queryLower && span.text.toLowerCase().includes(queryLower)) {
          const parts: React.ReactNode[] = [];
          const lower = span.text.toLowerCase();
          let cursor = 0;
          let pos = lower.indexOf(queryLower, cursor);
          while (pos !== -1) {
            if (pos > cursor) {
              parts.push(span.text.slice(cursor, pos));
            }
            parts.push(
              <mark
                key={`${idx}-${pos}`}
                className="bg-amber-400/40 text-inherit rounded-[2px] ring-1 ring-amber-400/70"
              >
                {span.text.slice(pos, pos + queryLower.length)}
              </mark>
            );
            cursor = pos + queryLower.length;
            pos = lower.indexOf(queryLower, cursor);
          }
          if (cursor < span.text.length) {
            parts.push(span.text.slice(cursor));
          }
          return (
            <span
              key={idx}
              className={`${span.className} ${span.changed ? changedClass : ''}`}
            >
              {parts}
            </span>
          );
        }

        return (
          <span
            key={idx}
            className={`${span.className} ${span.changed ? changedClass : ''}`}
          >
            {span.text}
          </span>
        );
      });
    }, [displayText, isTruncated, language, segments, changeKind, side, searchQuery]);

    return (
      <>
        {rendered}
        {isTruncated && (
          <button
            type="button"
            onClick={() => setExpandedLongLine(true)}
            className="ml-2 px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-primary)] text-[0.7rem] cursor-pointer"
          >
            +{(text.length - MAX_INLINE_RENDER_CHARS).toLocaleString()} chars
          </button>
        )}
      </>
    );
  }
);

DiffLineContent.displayName = 'DiffLineContent';
