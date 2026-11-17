import React from 'react';
import { Clock, Trash2, X } from 'lucide-react';
import type { SavedDiffEntry } from '../types/diff';

interface SavedHistoryDrawerProps {
  open: boolean;
  entries: SavedDiffEntry[];
  onClose: () => void;
  onSelect: (entry: SavedDiffEntry) => void;
  onDelete: (id: string) => void;
}

export const SavedHistoryDrawer: React.FC<SavedHistoryDrawerProps> = ({
  open,
  entries,
  onClose,
  onSelect,
  onDelete,
}) => {
  if (!open) return null;

  return (
    <aside className="fixed inset-x-0 bottom-0 h-[62dvh] z-40 lg:static lg:h-auto lg:w-[clamp(18rem,24vw,23rem)] shrink-0 border-t lg:border-t-0 lg:border-l border-[var(--border-hairline)] bg-[var(--bg-surface)] flex flex-col min-h-0 shadow-2xl lg:shadow-none">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border-hairline)]">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-[var(--text-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            Saved Diffs
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-colors cursor-pointer"
          aria-label="Close saved diffs"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="diff-scroll flex-1 overflow-y-auto divide-y divide-[var(--border-hairline)]">
        {entries.length === 0 ? (
          <div className="p-6 text-center text-xs text-[var(--text-muted)] leading-relaxed">
            No saved snapshots yet. Use Actions &gt; Save snapshot while viewing a diff to keep a local copy.
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors"
            >
              <button
                type="button"
                onClick={() => onSelect(entry)}
                className="flex-1 min-w-0 text-left cursor-pointer"
              >
                <div className="text-xs font-medium text-[var(--text-primary)] truncate">
                  {entry.title || 'Untitled diff'}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs font-mono tabular-nums text-[var(--text-muted)]">
                  <span className="text-[var(--add-fg)]">+{entry.added}</span>
                  <span className="text-[var(--remove-fg)]">-{entry.removed}</span>
                  <span aria-hidden="true">·</span>
                  <span>{new Date(entry.updatedAt).toLocaleDateString()}</span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => onDelete(entry.id)}
                className="p-1.5 rounded text-[var(--text-faint)] hover:text-[var(--remove-fg)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                title="Delete saved diff"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
};
