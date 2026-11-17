import { diffChars, diffLines, diffWordsWithSpace, type Change } from 'diff';
import wasmUrl from '../wasm/diff_core.wasm?url';
import type {
  DiffResult,
  DiffWorkerRequest,
  DiffWorkerResponse,
  HunkAnchor,
  InlineSegment,
  SplitRow,
  UnifiedRow,
} from '../types/diff';

interface RustWasmExports {
  memory: WebAssembly.Memory;
  alloc: (len: number) => number;
  dealloc: (ptr: number, len: number) => void;
  result_ptr: () => number;
  result_len: () => number;
  compute_diff: (
    leftPtr: number,
    leftLen: number,
    rightPtr: number,
    rightLen: number,
    flags: number
  ) => number;
  compute_intraline: (
    leftPtr: number,
    leftLen: number,
    rightPtr: number,
    rightLen: number,
    charMode: number
  ) => number;
}

const textEncoder = new TextEncoder();
let wasmExports: RustWasmExports | null = null;
let wasmInitPromise: Promise<RustWasmExports | null> | null = null;

function ensureWasm(): Promise<RustWasmExports | null> {
  if (wasmExports) return Promise.resolve(wasmExports);
  if (wasmInitPromise) return wasmInitPromise;

  wasmInitPromise = (async () => {
    try {
      const response = await fetch(wasmUrl);
      if (!response.ok) return null;
      let instance: WebAssembly.Instance;
      if ('instantiateStreaming' in WebAssembly) {
        try {
          const streamed = await WebAssembly.instantiateStreaming(response.clone());
          instance = streamed.instance;
        } catch {
          const bytes = await response.arrayBuffer();
          const instantiated = await WebAssembly.instantiate(bytes);
          instance = instantiated.instance;
        }
      } else {
        const bytes = await response.arrayBuffer();
        const instantiated = await WebAssembly.instantiate(bytes);
        instance = instantiated.instance;
      }
      wasmExports = instance.exports as unknown as RustWasmExports;
      return wasmExports;
    } catch {
      return null;
    }
  })();

  return wasmInitPromise;
}

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

function runWasmIntraline(
  wasm: RustWasmExports,
  leftLine: string,
  rightLine: string,
  mode: 'word' | 'char'
): { leftSegments: InlineSegment[]; rightSegments: InlineSegment[] } {
  const leftBytes = textEncoder.encode(leftLine);
  const rightBytes = textEncoder.encode(rightLine);

  const leftPtr = wasm.alloc(leftBytes.length);
  const rightPtr = wasm.alloc(rightBytes.length);

  try {
    if (leftBytes.length > 0) {
      new Uint8Array(wasm.memory.buffer, leftPtr, leftBytes.length).set(leftBytes);
    }
    if (rightBytes.length > 0) {
      new Uint8Array(wasm.memory.buffer, rightPtr, rightBytes.length).set(rightBytes);
    }

    const opLen = wasm.compute_intraline(
      leftPtr,
      leftBytes.length,
      rightPtr,
      rightBytes.length,
      mode === 'char' ? 1 : 0
    );
    const outPtr = wasm.result_ptr();
    const view = new Uint32Array(wasm.memory.buffer, outPtr, opLen);

    const leftSegments: InlineSegment[] = [];
    const rightSegments: InlineSegment[] = [];
    let li = 0;
    let ri = 0;

    for (let i = 0; i < opLen; i += 2) {
      const kind = view[i];
      const utf16Count = view[i + 1];
      if (kind === 0) {
        leftSegments.push({ text: leftLine.slice(li, li + utf16Count), changed: false });
        rightSegments.push({ text: rightLine.slice(ri, ri + utf16Count), changed: false });
        li += utf16Count;
        ri += utf16Count;
      } else if (kind === 1) {
        leftSegments.push({ text: leftLine.slice(li, li + utf16Count), changed: true });
        li += utf16Count;
      } else {
        rightSegments.push({ text: rightLine.slice(ri, ri + utf16Count), changed: true });
        ri += utf16Count;
      }
    }

    return { leftSegments, rightSegments };
  } finally {
    wasm.dealloc(leftPtr, leftBytes.length);
    wasm.dealloc(rightPtr, rightBytes.length);
  }
}

function computeFastIntraline(
  wasm: RustWasmExports | null,
  leftLine: string,
  rightLine: string,
  mode: 'word' | 'char'
): { leftSegments: InlineSegment[]; rightSegments: InlineSegment[] } {
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

  if (wasm) {
    return runWasmIntraline(wasm, leftLine, rightLine, mode);
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

type RawOp =
  | { type: 'equal'; count: number }
  | { type: 'remove'; count: number }
  | { type: 'add'; count: number };

function runWasmLineDiff(
  wasm: RustWasmExports,
  midLeftText: string,
  midRightText: string,
  ignoreWhitespace: boolean,
  ignoreCase: boolean
): RawOp[] {
  const leftBytes = textEncoder.encode(midLeftText);
  const rightBytes = textEncoder.encode(midRightText);
  const leftPtr = wasm.alloc(leftBytes.length);
  const rightPtr = wasm.alloc(rightBytes.length);

  try {
    if (leftBytes.length > 0) {
      new Uint8Array(wasm.memory.buffer, leftPtr, leftBytes.length).set(leftBytes);
    }
    if (rightBytes.length > 0) {
      new Uint8Array(wasm.memory.buffer, rightPtr, rightBytes.length).set(rightBytes);
    }

    const flags = (ignoreWhitespace ? 1 : 0) | (ignoreCase ? 2 : 0);
    const opLen = wasm.compute_diff(
      leftPtr,
      leftBytes.length,
      rightPtr,
      rightBytes.length,
      flags
    );
    const outPtr = wasm.result_ptr();
    const view = new Uint32Array(wasm.memory.buffer, outPtr, opLen);

    const ops: RawOp[] = [];
    for (let i = 0; i < opLen; i += 2) {
      const kind = view[i];
      const count = view[i + 1];
      if (count === 0) continue;
      if (kind === 0) ops.push({ type: 'equal', count });
      else if (kind === 1) ops.push({ type: 'remove', count });
      else ops.push({ type: 'add', count });
    }
    return ops;
  } finally {
    wasm.dealloc(leftPtr, leftBytes.length);
    wasm.dealloc(rightPtr, rightBytes.length);
  }
}

function computeDiff(req: DiffWorkerRequest, wasm: RustWasmExports | null): DiffResult {
  const startTime = performance.now();

  const rawLeft = splitLinesPreserve(req.leftText);
  const rawRight = splitLinesPreserve(req.rightText);

  const totalLeftLines = rawLeft.length;
  const totalRightLines = rawRight.length;

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

  const ops: RawOp[] = [];
  if (prefixLen > 0) {
    ops.push({ type: 'equal', count: prefixLen });
  }

  if (midLeft.length > 0 || midRight.length > 0) {
    const midLeftText = midLeft.length ? midLeft.join('\n') + '\n' : '';
    const midRightText = midRight.length ? midRight.join('\n') + '\n' : '';

    if (wasm && midLeft.length + midRight.length <= 25000) {
      const wasmOps = runWasmLineDiff(
        wasm,
        midLeftText,
        midRightText,
        req.ignoreWhitespace,
        req.ignoreCase
      );
      for (const op of wasmOps) ops.push(op);
    } else if (midLeft.length + midRight.length > 12000) {
      const chunkSize = 2500;
      const chunks = Math.max(
        Math.ceil(midLeft.length / chunkSize),
        Math.ceil(midRight.length / chunkSize)
      );
      for (let c = 0; c < chunks; c++) {
        const lSlice = midLeft.slice(c * chunkSize, (c + 1) * chunkSize);
        const rSlice = midRight.slice(c * chunkSize, (c + 1) * chunkSize);
        const lText = lSlice.length ? lSlice.join('\n') + '\n' : '';
        const rText = rSlice.length ? rSlice.join('\n') + '\n' : '';

        if (wasm) {
          const wasmOps = runWasmLineDiff(
            wasm,
            lText,
            rText,
            req.ignoreWhitespace,
            req.ignoreCase
          );
          for (const op of wasmOps) ops.push(op);
        } else {
          const cmpL = req.ignoreCase ? lSlice.map((l) => l.toLowerCase()) : lSlice;
          const cmpR = req.ignoreCase ? rSlice.map((l) => l.toLowerCase()) : rSlice;
          const changes = diffLines(
            cmpL.length ? cmpL.join('\n') + '\n' : '',
            cmpR.length ? cmpR.join('\n') + '\n' : '',
            { ignoreWhitespace: req.ignoreWhitespace }
          );
          for (const ch of changes) {
            const lines = splitLinesPreserve(ch.value);
            if (lines.length === 0) continue;
            if (ch.added) ops.push({ type: 'add', count: lines.length });
            else if (ch.removed) ops.push({ type: 'remove', count: lines.length });
            else ops.push({ type: 'equal', count: lines.length });
          }
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
        if (ch.added) ops.push({ type: 'add', count: lines.length });
        else if (ch.removed) ops.push({ type: 'remove', count: lines.length });
        else ops.push({ type: 'equal', count: lines.length });
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
          rawLeft.slice(leftCursor, leftCursor + current.count)
        );
        leftCursor += current.count;
      } else if (current.type === 'add') {
        addedLines = addedLines.concat(
          rawRight.slice(rightCursor, rightCursor + current.count)
        );
        rightCursor += current.count;
      }
      i++;
    }

    removed += removedLines.length;
    added += addedLines.length;

    const maxPairs = Math.max(removedLines.length, addedLines.length);
    const minPairs = Math.min(removedLines.length, addedLines.length);

    const pairSegments: Array<{ leftSegments: InlineSegment[]; rightSegments: InlineSegment[] }> = [];
    for (let p = 0; p < minPairs; p++) {
      if (p < 250) {
        pairSegments.push(
          computeFastIntraline(wasm, removedLines[p], addedLines[p], req.intralineMode)
        );
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

  const patchLines: string[] = [];
  const contextRadius = 3;
  let hIdx = 0;
  while (hIdx < hunks.length) {
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

// Kick off WASM instantiation immediately on worker load
void ensureWasm();

self.onmessage = async (event: MessageEvent<DiffWorkerRequest>) => {
  const wasm = await ensureWasm();
  const result = computeDiff(event.data, wasm);
  const response: DiffWorkerResponse = {
    id: event.data.id,
    result,
  };
  self.postMessage(response);
};
