import { diffChars, diffLines, diffWordsWithSpace, type Change } from 'diff';
import type {
  DiffResult,
  DiffWorkerRequest,
  DiffWorkerResponse,
  HunkAnchor,
  InlineSegment,
  SplitRow,
  UnifiedRow,
} from '../types/diff';

function splitLinesPreserve(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function normalizeForCompare(line: string, ignoreWhitespace: boolean, ignoreCase: boolean): string {
  let out = line;
  if (ignoreWhitespace) {
    out = out.trim().replace(/\s+/g, ' ');
  }
  if (ignoreCase) {
    out = out.toLowerCase();
  }
  return out;
}

function computeFastIntraline(
  leftLine: string,
  rightLine: string,
  mode: 'word' | 'char'
): { leftSegments: InlineSegment[]; rightSegments: InlineSegment[] } {
  // Fast path for extremely long minified lines so UI never stalls
  if (leftLine.length > 3500 || rightLine.length > 3500) {
    let prefix = 0;
    const minLen = Math.min(leftLine.length, rightLine.length);
    while (prefix < minLen && leftLine[prefix] === rightLine[prefix]) {
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < minLen - prefix &&
      leftLine[leftLine.length - 1 - suffix] === rightLine[rightLine.length - 1 - suffix]
    ) {
      suffix++;
    }
    const leftMid = leftLine.slice(prefix, leftLine.length - suffix);
    const rightMid = rightLine.slice(prefix, rightLine.length - suffix);
    const leftSegments: InlineSegment[] = [];
    const rightSegments: InlineSegment[] = [];
    if (prefix > 0) {
      leftSegments.push({ text: leftLine.slice(0, prefix), changed: false });
      rightSegments.push({ text: rightLine.slice(0, prefix), changed: false });
    }
    if (leftMid) leftSegments.push({ text: leftMid, changed: true });
    if (rightMid) rightSegments.push({ text: rightMid, changed: true });
    if (suffix > 0) {
      leftSegments.push({ text: leftLine.slice(leftLine.length - suffix), changed: false });
      rightSegments.push({ text: rightLine.slice(rightLine.length - suffix), changed: false });
    }
    return { leftSegments, rightSegments };
  }

  const changes: Change[] =
    mode === 'char'
      ? diffChars(leftLine, rightLine)
      : diffWordsWithSpace(leftLine, rightLine);

  const leftSegments: InlineSegment[] = [];
  const rightSegments: InlineSegment[] = [];

  for (const part of changes) {
    if (part.added) {
      rightSegments.push({ text: part.value, changed: true });
    } else if (part.removed) {
      leftSegments.push({ text: part.value, changed: true });
    } else {
      leftSegments.push({ text: part.value, changed: false });
      rightSegments.push({ text: part.value, changed: false });
    }
  }

  return { leftSegments, rightSegments };
}

function computeDiff(req: DiffWorkerRequest): DiffResult {
  const startTime = performance.now();

  const rawLeft = splitLinesPreserve(req.leftText);
  const rawRight = splitLinesPreserve(req.rightText);

  const totalLeftLines = rawLeft.length;
  const totalRightLines = rawRight.length;

  // O(N) common prefix & suffix trimming so massive files with localized edits finish in milliseconds
  let prefixLen = 0;
  const minLines = Math.min(totalLeftLines, totalRightLines);
  while (
    prefixLen < minLines &&
    normalizeForCompare(rawLeft[prefixLen], req.ignoreWhitespace, req.ignoreCase) ===
      normalizeForCompare(rawRight[prefixLen], req.ignoreWhitespace, req.ignoreCase)
  ) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLines - prefixLen &&
    normalizeForCompare(
      rawLeft[totalLeftLines - 1 - suffixLen],
      req.ignoreWhitespace,
      req.ignoreCase
    ) ===
      normalizeForCompare(
        rawRight[totalRightLines - 1 - suffixLen],
        req.ignoreWhitespace,
        req.ignoreCase
      )
  ) {
    suffixLen++;
  }

  const midLeft = rawLeft.slice(prefixLen, totalLeftLines - suffixLen);
  const midRight = rawRight.slice(prefixLen, totalRightLines - suffixLen);

  type RawOp =
    | { type: 'equal'; count: number }
    | { type: 'remove'; lines: string[] }
    | { type: 'add'; lines: string[] };

  const ops: RawOp[] = [];
  if (prefixLen > 0) {
    ops.push({ type: 'equal', count: prefixLen });
  }

  if (midLeft.length > 0 || midRight.length > 0) {
    // Guard against O(ND) blowup if middle section itself is huge (> 12k lines)
    if (midLeft.length + midRight.length > 12000) {
      const chunkSize = 2500;
      const chunks = Math.max(
        Math.ceil(midLeft.length / chunkSize),
        Math.ceil(midRight.length / chunkSize)
      );
      for (let c = 0; c < chunks; c++) {
        const lSlice = midLeft.slice(c * chunkSize, (c + 1) * chunkSize);
        const rSlice = midRight.slice(c * chunkSize, (c + 1) * chunkSize);
        const cmpL = req.ignoreCase ? lSlice.map((l) => l.toLowerCase()) : lSlice;
        const cmpR = req.ignoreCase ? rSlice.map((l) => l.toLowerCase()) : rSlice;
        const changes = diffLines(
          cmpL.join('\n') + (cmpL.length ? '\n' : ''),
          cmpR.join('\n') + (cmpR.length ? '\n' : ''),
          {
            ignoreWhitespace: req.ignoreWhitespace,
          }
        );
        for (const ch of changes) {
          const lines = splitLinesPreserve(ch.value);
          if (lines.length === 0) continue;
          if (ch.added) ops.push({ type: 'add', lines });
          else if (ch.removed) ops.push({ type: 'remove', lines });
          else ops.push({ type: 'equal', count: lines.length });
        }
      }
    } else {
      const cmpLeft = req.ignoreCase ? midLeft.map((l) => l.toLowerCase()) : midLeft;
      const cmpRight = req.ignoreCase ? midRight.map((l) => l.toLowerCase()) : midRight;
      const leftStr = cmpLeft.length ? cmpLeft.join('\n') + '\n' : '';
      const rightStr = cmpRight.length ? cmpRight.join('\n') + '\n' : '';
      const changes = diffLines(leftStr, rightStr, {
        ignoreWhitespace: req.ignoreWhitespace,
      });

      for (const ch of changes) {
        const lines = splitLinesPreserve(ch.value);
        if (lines.length === 0) continue;
        if (ch.added) {
          ops.push({ type: 'add', lines });
        } else if (ch.removed) {
          ops.push({ type: 'remove', lines });
        } else {
          ops.push({ type: 'equal', count: lines.length });
        }
      }
    }
  }

  if (suffixLen > 0) {
    ops.push({ type: 'equal', count: suffixLen });
  }

  const splitRows: SplitRow[] = [];
  const unifiedRows: UnifiedRow[] = [];
  const hunks: HunkAnchor[] = [];

  let leftCursor = 0;
  let rightCursor = 0;
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  let i = 0;
  while (i < ops.length) {
    const op = ops[i];

    if (op.type === 'equal') {
      for (let k = 0; k < op.count; k++) {
        const lText = rawLeft[leftCursor] ?? '';
        const rText = rawRight[rightCursor] ?? '';
        const leftNum = leftCursor + 1;
        const rightNum = rightCursor + 1;

        splitRows.push({
          kind: 'context',
          leftNum,
          rightNum,
          leftText: lText,
          rightText: rText,
          hunkIndex: null,
        });

        unifiedRows.push({
          kind: 'context',
          leftNum,
          rightNum,
          text: rText,
          hunkIndex: null,
        });

        leftCursor++;
        rightCursor++;
        unchanged++;
      }
      i++;
      continue;
    }

    // Group adjacent remove + add blocks into a single hunk
    const hunkIndex = hunks.length;
    const splitStartRow = splitRows.length;
    const unifiedStartRow = unifiedRows.length;
    const leftStartLine = leftCursor + 1;
    const rightStartLine = rightCursor + 1;

    let removedLines: string[] = [];
    let addedLines: string[] = [];

    while (i < ops.length && ops[i].type !== 'equal') {
      const current = ops[i];
      if (current.type === 'remove') {
        removedLines = removedLines.concat(
          rawLeft.slice(leftCursor, leftCursor + current.lines.length)
        );
        leftCursor += current.lines.length;
      } else if (current.type === 'add') {
        addedLines = addedLines.concat(
          rawRight.slice(rightCursor, rightCursor + current.lines.length)
        );
        rightCursor += current.lines.length;
      }
      i++;
    }

    removed += removedLines.length;
    added += addedLines.length;

    const maxPairs = Math.max(removedLines.length, addedLines.length);
    const minPairs = Math.min(removedLines.length, addedLines.length);

    // Precompute intraline segments for paired lines (up to reasonable batch of 250 paired lines per hunk)
    const pairSegments: Array<{ leftSegments: InlineSegment[]; rightSegments: InlineSegment[] }> = [];
    for (let p = 0; p < minPairs; p++) {
      if (p < 250) {
        pairSegments.push(computeFastIntraline(removedLines[p], addedLines[p], req.intralineMode));
      } else {
        pairSegments.push({
          leftSegments: [{ text: removedLines[p], changed: true }],
          rightSegments: [{ text: addedLines[p], changed: true }],
        });
      }
    }

    for (let p = 0; p < maxPairs; p++) {
      const hasLeft = p < removedLines.length;
      const hasRight = p < addedLines.length;
      const leftNum = hasLeft ? leftStartLine + p : null;
      const rightNum = hasRight ? rightStartLine + p : null;
      const leftText = hasLeft ? removedLines[p] : '';
      const rightText = hasRight ? addedLines[p] : '';

      if (hasLeft && hasRight) {
        splitRows.push({
          kind: 'modify',
          leftNum,
          rightNum,
          leftText,
          rightText,
          leftSegments: pairSegments[p]?.leftSegments,
          rightSegments: pairSegments[p]?.rightSegments,
          hunkIndex,
        });
      } else if (hasLeft) {
        splitRows.push({
          kind: 'remove',
          leftNum,
          rightNum: null,
          leftText,
          rightText: '',
          hunkIndex,
        });
      } else if (hasRight) {
        splitRows.push({
          kind: 'add',
          leftNum: null,
          rightNum,
          leftText: '',
          rightText,
          hunkIndex,
        });
      }
    }

    // Unified ordering: all removed lines first, then all added lines
    for (let p = 0; p < removedLines.length; p++) {
      unifiedRows.push({
        kind: 'remove',
        leftNum: leftStartLine + p,
        rightNum: null,
        text: removedLines[p],
        segments: p < minPairs ? pairSegments[p]?.leftSegments : undefined,
        hunkIndex,
      });
    }
    for (let p = 0; p < addedLines.length; p++) {
      unifiedRows.push({
        kind: 'add',
        leftNum: null,
        rightNum: rightStartLine + p,
        text: addedLines[p],
        segments: p < minPairs ? pairSegments[p]?.rightSegments : undefined,
        hunkIndex,
      });
    }

    hunks.push({
      index: hunkIndex,
      splitStartRow,
      splitEndRow: splitRows.length - 1,
      unifiedStartRow,
      unifiedEndRow: unifiedRows.length - 1,
      leftStartLine,
      rightStartLine,
    });
  }

  // Build compact unified hunk patch with +/-3 context lines (for AI Explain & .patch export)
  const patchLines: string[] = [];
  const contextRadius = 3;
  let hIdx = 0;
  while (hIdx < hunks.length) {
    // Merge nearby hunks if context overlaps
    let groupEnd = hIdx;
    while (
      groupEnd + 1 < hunks.length &&
      hunks[groupEnd + 1].unifiedStartRow - hunks[groupEnd].unifiedEndRow <= contextRadius * 2 + 1
    ) {
      groupEnd++;
    }

    const startRow = Math.max(0, hunks[hIdx].unifiedStartRow - contextRadius);
    const endRow = Math.min(unifiedRows.length - 1, hunks[groupEnd].unifiedEndRow + contextRadius);

    let leftStart = 0;
    let rightStart = 0;
    let leftCount = 0;
    let rightCount = 0;

    for (let r = startRow; r <= endRow; r++) {
      const row = unifiedRows[r];
      if (row.leftNum !== null && leftStart === 0) leftStart = row.leftNum;
      if (row.rightNum !== null && rightStart === 0) rightStart = row.rightNum;
      if (row.kind === 'context') {
        leftCount++;
        rightCount++;
      } else if (row.kind === 'remove') {
        leftCount++;
      } else {
        rightCount++;
      }
    }

    patchLines.push(`@@ -${leftStart},${leftCount} +${rightStart},${rightCount} @@`);
    for (let r = startRow; r <= endRow; r++) {
      const row = unifiedRows[r];
      const prefix = row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' ';
      patchLines.push(`${prefix}${row.text}`);
    }

    hIdx = groupEnd + 1;
  }

  const computeMs = Math.round((performance.now() - startTime) * 10) / 10;

  return {
    splitRows,
    unifiedRows,
    hunks,
    stats: {
      added,
      removed,
      unchanged,
      totalLeftLines,
      totalRightLines,
      hunkCount: hunks.length,
      computeMs,
    },
    hunksPatch: patchLines.join('\n'),
  };
}

self.onmessage = (event: MessageEvent<DiffWorkerRequest>) => {
  const result = computeDiff(event.data);
  const response: DiffWorkerResponse = {
    id: event.data.id,
    result,
  };
  self.postMessage(response);
};
