// The detail screen: structured markdown on top, note composer at the bottom.
//
// Composing is type-first. The note is categorised automatically from how it
// reads, with the guess shown live above the field — picking a category by hand
// is an override, not a prerequisite.

import { useEffect, useRef, useState } from 'react'
import type { EntityDetail, EntityKind, SectionKey } from '../../shared/types'
import type { PolishState } from '../bridge'
import { SECTION_LABELS, migrateSection, sectionsFor } from '../../shared/types'
import { call } from '../rpc'
import { Composer, type ComposerEntry, type SendMode } from '../Composer'
import { Drafts } from '../Drafts'
import { Swatch } from '../Swatch'
import { Target } from '../icons'

interface Props {
  entityId: string
  entityKind: EntityKind
  onSaved: () => void
  onError: (message: string) => void
  /** Hands freshly saved notes to the bridge for tidying, if one is running. */
  onPolish: (
    notes: Array<{ id: string; text: string; section: string; subject: string; kind: string }>
  ) => void
  polish: PolishState
  /** Sends a question to the Claude session rather than storing a note. */
  onAsk: (text: string) => void
  bridgeReady: boolean
  /** The session's last reply about this entity, if any. */
  answer: { text: string; pending: boolean; error?: string } | null
  onDismissAnswer: () => void
}

export function Detail({
  entityId,
  entityKind,
  onSaved,
  onError,
  onPolish,
  polish,
  onAsk,
  bridgeReady,
  answer,
  onDismissAnswer,
}: Props) {
  const [detail, setDetail] = useState<EntityDetail | null>(null)
  const [saving, setSaving] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [refiling, setRefiling] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editingNote, setEditingNote] = useState<{ id: string; text: string } | null>(null)
  const docRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setRefiling(null)
    setEditing(null)
    call({ type: 'getEntity', entityId, entityKind })
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((err: Error) => {
        if (!cancelled) onError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [entityId, entityKind])

  const submit = async (entries: ComposerEntry[], mode: SendMode) => {
    // A question is not a note — it never touches storage.
    if (mode === 'ask') {
      onAsk(entries[0]?.text ?? '')
      return
    }

    try {
      const updated = await call({ type: 'addNotes', entityId, entityKind, entries })
      setDetail(updated)
      requestAnimationFrame(() => docRef.current?.scrollIntoView({ block: 'end' }))
      onSaved()

      // Only when asked for. The note is already saved either way, so tidying
      // is an improvement on something safe rather than a step in the path.
      if (mode === 'tidy') {
        const fresh = updated.log.filter((e) => !e.deleted).slice(-entries.length)
        onPolish(
          fresh.map((e) => ({
            id: e.id,
            text: e.text,
            section: e.section,
            subject: updated.name,
            kind: entityKind,
          }))
        )
      }
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const saveNoteEdit = async () => {
    if (!editingNote) return
    const text = editingNote.text.trim()
    setEditingNote(null)
    if (!text) return
    try {
      setDetail(await call({ type: 'editNote', entityId, entityKind, noteId: editingNote.id, text }))
      onSaved()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const review = async (noteIds: string[] | null, action: 'approve' | 'reject') => {
    setSaving(true)
    try {
      setDetail(await call({ type: 'reviewDrafts', entityId, entityKind, noteIds, action }))
      onSaved()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  /** Editing a suggestion rewrites it in place; it stays a draft until approved. */
  const editDraft = async (noteId: string, text: string) => {
    try {
      setDetail(await call({ type: 'editNote', entityId, entityKind, noteId, text }))
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const remove = async (noteId: string) => {
    try {
      setDetail(await call({ type: 'deleteNote', entityId, entityKind, noteId }))
      onSaved()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const saveBody = async () => {
    if (editing === null || saving) return
    setSaving(true)
    try {
      setDetail(await call({ type: 'saveBody', entityId, entityKind, body: editing }))
      setEditing(null)
      onSaved()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const resetBody = async () => {
    setSaving(true)
    try {
      setDetail(await call({ type: 'resetBody', entityId, entityKind }))
      setEditing(null)
      onSaved()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const refile = async (noteId: string, section: SectionKey) => {
    setRefiling(null)
    try {
      setDetail(await call({ type: 'recategorizeNote', entityId, entityKind, noteId, section }))
      onSaved()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  if (!detail) return <div className="state">Loading…</div>

  if (detail.missing) {
    return (
      <div className="banner danger">
        This item no longer exists in the file. Its notes were stored on the item itself and were
        deleted with it — recover from Figma version history, or from your last export.
      </div>
    )
  }

  // Every write stamps the host with the kind and name it was written as. A
  // disagreement means notes landed on something other than what they describe.
  // Renaming the item in Figma is not a mismatch, so only the kind is compared
  // when the names differ but the kind still matches.
  const mismatch =
    detail.log.length > 0 &&
    detail.storedAs !== undefined &&
    detail.storedAs.kind !== entityKind

  const canReveal = entityKind === 'component' || entityKind === 'componentSet'
  const liveEntries = detail.log.filter((e) => !e.deleted)
  const filled = new Set(liveEntries.map((e) => migrateSection(e.section)))
  const sections = sectionsFor(entityKind)

  return (
    <>
      <div className="body">
        {editing === null && (
          <Drafts
            drafts={detail.log.filter((e) => e.draft && !e.deleted)}
            entityKind={entityKind}
            busy={saving}
            onApprove={(ids) => review(ids, 'approve')}
            onReject={(ids) => review(ids, 'reject')}
            onEdit={editDraft}
          />
        )}
        {editing !== null ? (
          <>
            {/* Only the authored half is editable. The tables above it are
                regenerated from Figma on every open, so an edit there would be
                overwritten the moment a variant changed. */}
            <div className="doc locked">{highlight(detail.structureMarkdown)}</div>
            <div className="edit-note">
              Pulled from Figma automatically — edit the written guidance below.
            </div>
            <textarea
              className="doc editor"
              value={editing}
              spellCheck
              onChange={(e) => setEditing(e.target.value)}
              placeholder="## Purpose&#10;&#10;- …"
            />
            <div className="edit-actions">
              <button className="btn primary" onClick={saveBody} disabled={saving}>
                Save
              </button>
              <button className="btn" onClick={() => setEditing(null)} disabled={saving}>
                Cancel
              </button>
              {detail.bodyEdited && (
                <button className="btn" onClick={resetBody} disabled={saving} title="Discard manual edits and rebuild from the notes below">
                  Rebuild from notes
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            {mismatch && (
              <div className="banner warn">
                These notes were written as <strong>{detail.storedAs?.name}</strong> (
                {detail.storedAs?.kind}) but are stored on <strong>{detail.name}</strong> (
                {entityKind}). Nothing is lost — hide them here and re-add them on the right
                item. Please report this: it means a note was saved against the wrong thing.
              </div>
            )}
            {detail.structure.preview && (
              <div className="preview-strip">
                <Swatch preview={detail.structure.preview} size="lg" />
              </div>
            )}
            <div className="doc" ref={docRef}>
              {highlight(detail.markdown)}
            </div>
            <div className="doc-actions">
              <button className="link-btn" onClick={() => setEditing(detail.bodyMarkdown)}>
                Edit markdown
              </button>
              {detail.bodyEdited && (
                <span className="doc-flag">
                  hand-edited — new notes are appended, not regenerated
                </span>
              )}
            </div>
          </>
        )}

        {detail.log.length > 0 && (
          <div className="history">
            <button className="history-title" onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? '▾' : '▸'} {liveEntries.length} note
              {liveEntries.length === 1 ? '' : 's'} — original wording
            </button>
            {showHistory &&
              detail.log.map((entry) => {
                const section = migrateSection(entry.section)
                return (
                  <div key={entry.id} className={`entry${entry.deleted ? ' gone' : ''}`}>
                    <div className="entry-main">
                      {editingNote?.id === entry.id ? (
                        <>
                          <textarea
                            className="entry-editor"
                            value={editingNote.text}
                            autoFocus
                            rows={2}
                            onChange={(e) => setEditingNote({ id: entry.id, text: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                saveNoteEdit()
                              }
                              if (e.key === 'Escape') setEditingNote(null)
                            }}
                            onBlur={saveNoteEdit}
                          />
                          <div className="entry-meta">Enter to save · Esc to cancel</div>
                        </>
                      ) : (
                        <div className="entry-text">{entry.text}</div>
                      )}
                      <div className="entry-meta">
                        {entry.deleted ? (
                          <span>{SECTION_LABELS[section]}</span>
                        ) : (
                          <button
                            className="entry-section"
                            onClick={() => setRefiling(refiling === entry.id ? null : entry.id)}
                            title="Filed here automatically — click to move it"
                          >
                            {SECTION_LABELS[section]} ▾
                          </button>
                        )}
                        {' · '}
                        {entry.author} · {new Date(entry.ts).toLocaleDateString()}
                        {entry.deleted ? ' · hidden' : ''}
                      </div>
                      {refiling === entry.id && (
                        <div className="sections refile">
                          {sections
                            .filter((key) => key !== section)
                            .map((key) => (
                              <button
                                key={key}
                                className="chip"
                                onClick={() => refile(entry.id, key)}
                              >
                                {SECTION_LABELS[key]}
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                    {!entry.deleted && editingNote?.id !== entry.id && (
                      <>
                        <button
                          className="entry-remove"
                          onClick={() => setEditingNote({ id: entry.id, text: entry.text })}
                          title="Reword this note. The previous wording is kept."
                        >
                          edit
                        </button>
                        <button
                          className="entry-remove"
                          onClick={() => remove(entry.id)}
                          title="Hide from the document. The original wording is kept."
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
      </div>

      {polish.phase !== 'idle' && (
        <div className={`polish ${polish.phase}`}>
          {polish.phase === 'working' && (
            <>
              <span className="polish-spinner" />
              Tidying {polish.count} note{polish.count === 1 ? '' : 's'} — yours is already saved
            </>
          )}
          {polish.phase === 'done' &&
            (polish.changed > 0
              ? `Tidied ${polish.changed} note${polish.changed === 1 ? '' : 's'} — your original wording is kept in the notes list`
              : 'Nothing to tidy — your wording was already clean')}
          {polish.phase === 'failed' && (
            <>
              Could not tidy: {polish.error} — your wording is saved and unchanged.
            </>
          )}
        </div>
      )}

      {answer && (
        <div className={`answer${answer.error ? ' failed' : ''}`}>
          <div className="answer-head">
            <span>{answer.pending ? 'Claude is thinking…' : 'Claude'}</span>
            <button className="link-btn" onClick={onDismissAnswer}>
              dismiss
            </button>
          </div>
          <div className="answer-body">
            {answer.error ?? answer.text ?? ''}
            {answer.pending && !answer.text && <span className="polish-spinner" />}
          </div>
        </div>
      )}

      <Composer
        entityKind={entityKind}
        bridgeReady={bridgeReady}
        filled={filled}
        onSubmit={submit}
        trailing={
          canReveal ? (
            <button
              className="chip"
              onClick={() => call({ type: 'revealEntity', entityId, entityKind })}
              title="Select this component on the canvas"
              style={{ marginLeft: 'auto' }}
            >
              <Target />
            </button>
          ) : null
        }
      />
    </>
  )
}

/**
 * Light syntax colouring for the markdown pane.
 *
 * Raw markdown is shown deliberately rather than rendered HTML — what the
 * designer sees here is exactly what lands in the exported file.
 */
function highlight(markdown: string) {
  return markdown.split('\n').map((line, i) => {
    let className = ''
    if (line.startsWith('#')) className = 'h'
    else if (line.startsWith('> ⚠️')) className = 'warn'
    else if (line.startsWith('>')) className = 'quote'
    else if (line.startsWith('_') && line.endsWith('_')) className = 'empty'
    else if (line.startsWith('- ') || line.startsWith('|')) className = 'bullet'

    return (
      <span key={i} className={className}>
        {line}
        {'\n'}
      </span>
    )
  })
}
