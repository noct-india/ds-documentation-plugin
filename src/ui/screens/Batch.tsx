// Writing one note to every selected component at once.
//
// Strictly additive: each component gets its own appended entries, and nothing
// already written to any of them is read back, rewritten or overwritten. A
// component that already has notes simply gains more.

import { useCallback, useEffect, useState } from 'react'
import type { BatchTarget, EntityKind, SharedNote } from '../../shared/types'
import { SECTION_LABELS } from '../../shared/types'

import { call } from '../rpc'
import { Composer, type ComposerEntry } from '../Composer'
import { Diamond } from '../icons'

/** Plural nouns for the banner, so it never says "8 selected components" about styles. */
const LABELS: Record<EntityKind, string> = {
  folder: 'folders',
  page: 'pages',
  section: 'sections',
  variable: 'variables',
  collection: 'collections',
  paintStyle: 'color styles',
  textStyle: 'text styles',
  effectStyle: 'effect styles',
  component: 'components',
  componentSet: 'components',
  project: 'items',
}

interface Props {
  targets: BatchTarget[]
  onOpenOne: (target: BatchTarget) => void
  onSaved: () => void
  onError: (message: string) => void
  onDone: (message: string) => void
}

export function Batch({ targets, onOpenOne, onSaved, onError, onDone }: Props) {
  const [written, setWritten] = useState(0)
  const [shared, setShared] = useState<SharedNote[] | null>(null)
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const ids = targets.map((t) => ({ entityId: t.entityId, entityKind: t.entityKind }))
  const idKey = targets.map((t) => t.entityId).join(',')

  const loadShared = useCallback(() => {
    call({ type: 'getSharedNotes', targets: ids })
      .then(setShared)
      .catch(() => setShared([]))
    // `idKey` stands in for the target list, which is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey])

  useEffect(loadShared, [loadShared])

  const submit = async (entries: ComposerEntry[]) => {
    try {
      const result = await call({
        type: 'addNotesBatch',
        targets: targets.map((t) => ({
          entityId: t.entityId,
          entityKind: t.entityKind,
          name: t.name,
        })),
        entries,
      })

      setWritten((n) => n + result.notes)
      loadShared()
      onSaved()

      const noun = result.notes === 1 ? 'note' : 'notes'
      const where = `${result.applied} component${result.applied === 1 ? '' : 's'}`
      onDone(
        result.skipped.length > 0
          ? `Added ${result.notes} ${noun} to ${where}. Skipped ${result.skipped.length} that no longer exist.`
          : `Added ${result.notes} ${noun} to ${where}.`
      )
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const saveEdit = async (note: SharedNote) => {
    if (!editing || busy) return
    const next = editing.text.trim()
    if (!next || next === note.text) {
      setEditing(null)
      return
    }
    setBusy(true)
    try {
      setShared(
        await call({
          type: 'editSharedNote',
          targets: ids,
          section: note.section,
          from: note.text,
          to: next,
        })
      )
      setEditing(null)
      onSaved()
      onDone(`Reworded on ${note.count} component${note.count === 1 ? '' : 's'}.`)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const removeShared = async (note: SharedNote) => {
    setBusy(true)
    try {
      setShared(
        await call({
          type: 'removeSharedNote',
          targets: ids,
          section: note.section,
          text: note.text,
        })
      )
      setEditing(null)
      onSaved()
      onDone(`Hidden on ${note.count} component${note.count === 1 ? '' : 's'}.`)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const documented = targets.filter((t) => t.noteCount > 0).length

  // A selection is either all components or all styles/variables. Where the
  // kinds agree, offer that kind's categories; where they don't, fall back to
  // `variable` — the core set, which is valid for every kind.
  const kinds = new Set(targets.map((t) => t.entityKind))
  const composerKind: EntityKind = kinds.size === 1 ? targets[0].entityKind : 'variable'
  const noun = kinds.size === 1 ? LABELS[composerKind] : 'items'

  return (
    <>
      <div className="body">
        <div className="banner">
          Anything written here is appended to <strong>all {targets.length}</strong> selected{' '}
          {noun}. Existing notes are untouched.
          {documented > 0 && (
            <>
              {' '}
              {documented} of them {documented === 1 ? 'has' : 'have'} notes already.
            </>
          )}
        </div>

        {shared && shared.length > 0 && (
          <div className="history">
            <div className="history-title">Notes already on these components</div>
            {shared.map((note) => {
              const key = `${note.section} ${note.text}`
              const isEditing = editing?.key === key
              return (
                <div key={key} className="entry">
                  <div className="entry-main">
                    {isEditing ? (
                      <>
                        <textarea
                          className="entry-editor"
                          value={editing.text}
                          autoFocus
                          rows={2}
                          onChange={(e) => setEditing({ key, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              saveEdit(note)
                            }
                            if (e.key === 'Escape') setEditing(null)
                          }}
                        />
                        <div className="edit-actions inline">
                          <button className="btn primary" disabled={busy} onClick={() => saveEdit(note)}>
                            Save on {note.count}
                          </button>
                          <button className="btn" disabled={busy} onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="entry-text">{note.text}</div>
                        <div className="entry-meta">
                          {SECTION_LABELS[note.section]} ·{' '}
                          {note.count === note.total ? (
                            `on all ${note.total}`
                          ) : (
                            <span className="partial">
                              on {note.count} of {note.total}
                            </span>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  {!isEditing && (
                    <>
                      <button
                        className="entry-remove"
                        onClick={() => setEditing({ key, text: note.text })}
                        title="Reword this note on every component that has it"
                      >
                        edit
                      </button>
                      <button
                        className="entry-remove"
                        onClick={() => removeShared(note)}
                        title="Hide it everywhere. The original wording is kept."
                      >
                        hide
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {targets.map((target) => (
          <button key={target.entityId} className="row" onClick={() => onOpenOne(target)}>
            <span className="row-icon">
              <Diamond />
            </span>
            <span className="row-main">
              <span className="row-name">{target.name}</span>
              <span className="row-detail">
                {target.noteCount > 0
                  ? `${target.noteCount} note${target.noteCount === 1 ? '' : 's'}`
                  : 'not documented yet'}
              </span>
            </span>
            <span className={`dot${target.noteCount > 0 ? ' on' : ''}`} />
          </button>
        ))}

        {written > 0 && (
          <div className="state">
            {written} note{written === 1 ? '' : 's'} added to each component this session.
          </div>
        )}
      </div>

      <Composer
        entityKind={composerKind}
        onSubmit={submit}
        placeholder={`Write a rule for all ${targets.length} — it files itself…`}
      />
    </>
  )
}
