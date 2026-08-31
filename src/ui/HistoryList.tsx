// The edit-history list, shared by the global History tab and a component's own
// edit log. Each row reverses independently; "Undo all" walks back to a clean
// slate. The data comes from the document's separate history store, never the
// notes or the markdown.

import type { HistoryEntry } from '../shared/types'

interface Props {
  entries: HistoryEntry[]
  onDirection: (id: string, direction: 'undo' | 'redo') => void
  /** Shown only when there is something still live to reverse. */
  onUndoAll?: () => void
  /** Whether to show the entity name on each row (off in a per-component view). */
  showEntity?: boolean
  emptyLabel?: string
}

const OP_LABEL: Record<HistoryEntry['op'], string> = {
  add: 'Added',
  edit: 'Edited',
  delete: 'Deleted',
  approve: 'Approved',
  reject: 'Rejected',
  recategorize: 'Moved',
}

function when(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function HistoryList({ entries, onDirection, onUndoAll, showEntity, emptyLabel }: Props) {
  if (entries.length === 0) {
    return <div className="state">{emptyLabel ?? 'No edits yet.'}</div>
  }
  const liveCount = entries.filter((e) => !e.undone).length

  return (
    <div className="editlog">
      {onUndoAll && liveCount > 0 && (
        <div className="history-head">
          <span className="history-count">
            {liveCount} change{liveCount === 1 ? '' : 's'} on record
          </span>
          <button
            className="btn small"
            onClick={onUndoAll}
            title="Reverse every change here back to a clean slate"
          >
            Undo all
          </button>
        </div>
      )}

      {entries.map((e) => (
        <div key={e.id} className={`history-row${e.undone ? ' undone' : ''}`}>
          <span className={`history-op ${e.op}`}>{OP_LABEL[e.op]}</span>
          <span className="history-main">
            <span className="history-summary">{e.summary}</span>
            <span className="history-meta">
              {showEntity ? `${e.entityName} · ` : ''}
              {when(e.ts)}
              {e.undone ? ' · undone' : ''}
            </span>
          </span>
          <button
            className="btn small"
            onClick={() => onDirection(e.id, e.undone ? 'redo' : 'undo')}
            title={e.undone ? 'Re-apply this change' : 'Reverse just this change'}
          >
            {e.undone ? 'Redo' : 'Undo'}
          </button>
        </div>
      ))}
    </div>
  )
}
