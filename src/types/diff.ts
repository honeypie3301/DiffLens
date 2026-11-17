export type DiffViewMode = 'split' | 'unified';
export type AppThemeId = 'midnight' | 'sage' | 'twilight' | 'golden' | 'alabaster';
export type DensityMode = 'compact' | 'comfortable';

export interface InlineSegment {
  text: string;
  changed: boolean;
}

export interface SplitRow {
  kind: 'context' | 'modify' | 'add' | 'remove';
  leftNum: number | null;
  rightNum: number | null;
  leftText: string;
  rightText: string;
  leftSegments?: InlineSegment[];
  rightSegments?: InlineSegment[];
  hunkIndex: number | null;
}

export interface UnifiedRow {
  kind: 'context' | 'add' | 'remove';
  leftNum: number | null;
  rightNum: number | null;
  text: string;
  segments?: InlineSegment[];
  hunkIndex: number | null;
}

export interface HunkAnchor {
  index: number;
  splitStartRow: number;
  splitEndRow: number;
  unifiedStartRow: number;
  unifiedEndRow: number;
  leftStartLine: number;
  rightStartLine: number;
}

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
  totalLeftLines: number;
  totalRightLines: number;
  hunkCount: number;
  computeMs: number;
}

export interface DiffResult {
  splitRows: SplitRow[];
  unifiedRows: UnifiedRow[];
  hunks: HunkAnchor[];
  stats: DiffStats;
  hunksPatch: string;
}

export interface DiffWorkerRequest {
  id: number;
  leftText: string;
  rightText: string;
  ignoreWhitespace: boolean;
  ignoreCase: boolean;
  intralineMode: 'word' | 'char';
}

export interface DiffWorkerResponse {
  id: number;
  result: DiffResult;
}

export interface SavedDiffEntry {
  id: string;
  title: string;
  language: string;
  leftText: string;
  rightText: string;
  updatedAt: number;
  added: number;
  removed: number;
}
