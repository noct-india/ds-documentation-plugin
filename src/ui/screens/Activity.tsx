// Everything Claude is working on, in one place.
//
// Drafting runs and questions queue independently but share one process pool,
// so a combined list is the only honest picture — and firing three bulk drafts
// without waiting is exactly the case this exists for.

import { useState } from 'react'
import type { HistoryEntry, PendingDraft } from '../../shared/types'
import type { ActivityItem, PoolState } from '../bridge'
import { HistoryList } from '../HistoryList'

interface Props {
  items: ActivityItem[]
  pool: PoolState | null
  pending: PendingDraft[]
  onCancel: (id: string) => void
  onOpen: (draft: PendingDraft) => void
  onRefreshPending: () => void
  history: HistoryEntry[]
  onHistoryDirection: (id: string, direction: 'undo' | 'redo') => void
  onHistoryUndoAll: () => void
  onRefreshHistory: () => void
}

const STATUS_LABEL: Record<string, string> = {
  running: 'Working',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export function Activity({
  items,
  pool,
  pending,
  onCancel,
  onOpen,
  onRefreshPending,
  history,
  onHistoryDirection,
  onHistoryUndoAll,
  onRefreshHistory,
}: Props) {
  const busy = items.filter((i) => i.status === 'running')
  const waiting = pending.reduce((n, p) => n + p.draftCount, 0)
  // Land on whichever half has something in it — usually the drafts, since
  // running work finishes and leaves suggestions behind.
  const [tab, setTab] = useState<'running' | 'waiting' | 'history'>(
    busy.length === 0 && waiting > 0 ? 'waiting' : 'running'
  )

  return (
    <div className="activity">
      <div className="activity-tabs">
        <button
          className={`activity-tab${tab === 'running' ? ' on' : ''}`}
          onClick={() => setTab('running')}
        >
          In flight{busy.length > 0 ? ` · ${busy.length}` : ''}
        </button>
        <button
          className={`activity-tab${tab === 'waiting' ? ' on' : ''}`}
          onClick={() => {
            setTab('waiting')
            onRefreshPending()
          }}
        >
          Waiting approval{waiting > 0 ? ` · ${waiting}` : ''}
        </button>
        <button
          className={`activity-tab${tab === 'history' ? ' on' : ''}`}
          onClick={() => {
            setTab('history')
            onRefreshHistory()
          }}
        >
          History{history.length > 0 ? ` · ${history.length}` : ''}
        </button>
      </div>

      {tab === 'history' ? (
        <HistoryList
          entries={history}
          onDirection={onHistoryDirection}
          onUndoAll={onHistoryUndoAll}
          showEntity
          emptyLabel="No edits yet. Every change you make is recorded here to undo."
        />
      ) : tab === 'waiting' ? (
        <Waiting pending={pending} onOpen={onOpen} />
      ) : (
        <Running items={items} pool={pool} busy={busy} onCancel={onCancel} />
      )}
    </div>
  )
}

/** Everything drafted but not yet accepted, wherever it lives in the system. */
function Waiting({
  pending,
  onOpen,
}: {
  pending: PendingDraft[]
  onOpen: (draft: PendingDraft) => void
}) {
  if (pending.length === 0) {
    return (
      <div className="state">
        Nothing waiting.
        <br />
        Suggestions land here until you keep or drop them.
      </div>
    )
  }

  const total = pending.reduce((n, p) => n + p.draftCount, 0)

  return (
    <>
      <div className="activity-head">
        <div className="activity-title">
          {total} suggestion{total === 1 ? '' : 's'} across {pending.length} item
          {pending.length === 1 ? '' : 's'}
        </div>
        <div className="activity-pool">
          None of these count as documented, and none are exported, until approved.
        </div>
      </div>

      {pending.map((draft) => (
        <button key={draft.entityId} className="row" onClick={() => onOpen(draft)}>
          <span className="row-main">
            <span className="row-name">{draft.name}</span>
            <span className="row-detail">{draft.entityKind}</span>
          </span>
          <span className="folder-note on">{draft.draftCount}</span>
          <span className="row-chevron">›</span>
        </button>
      ))}
    </>
  )
}

function Running({
  items,
  pool,
  busy,
  onCancel,
}: {
  items: ActivityItem[]
  pool: PoolState | null
  busy: ActivityItem[]
  onCancel: (id: string) => void
}) {
  return (
    <>
      <div className="activity-head">
        <div className="activity-title">
          {busy.length > 0 ? `${busy.length} running` : 'Nothing running'}
        </div>
        {pool && (
          <div className="activity-pool">
            {pool.active} of {pool.max} slots busy
            {pool.queued > 0 && ` · ${pool.queued} batch${pool.queued === 1 ? '' : 'es'} waiting`}
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <div className="state">
          Send a collection or a page to Claude and it shows up here.
          <br />
          You can queue several — they share {pool?.max ?? 4} slots and run in turn.
        </div>
      ) : (
        items.map((item) => {
          const pct =
            item.total && item.total > 0
              ? Math.round(((item.done ?? 0) / item.total) * 100)
              : null

          return (
            <div key={item.id} className={`activity-row ${item.status}`}>
              <div className="activity-main">
                <div className="activity-label">
                  <span className={`activity-kind ${item.kind}`}>
                    {item.kind === 'draft' ? 'Draft' : item.kind === 'tidy' ? 'Tidy' : 'Ask'}
                  </span>
                  {item.label}
                </div>

                <div className="activity-detail">
                  {item.error
                    ? item.error
                    : item.kind === 'tidy' && item.status === 'done'
                      ? `Reworded ${item.drafted ?? 0} of ${item.label}`
                      : item.kind === 'draft' && item.total
                      ? `${STATUS_LABEL[item.status] ?? item.status} · ${item.done ?? 0} of ${item.total}` +
                        (item.drafted ? ` · ${item.drafted} suggestions` : '')
                      : (STATUS_LABEL[item.status] ?? item.status)}
                </div>

                {item.status === 'running' && pct !== null && (
                  <div className="meter">
                    <div className="meter-fill" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>

              {item.status === 'running' && (
                <button
                  className="btn small"
                  onClick={() => onCancel(item.id)}
                  title="Stop this run. Anything already drafted is kept."
                >
                  Stop
                </button>
              )}
            </div>
          )
        })
      )}
    </>
  )
}
