// The detail screen: structured markdown on top, note composer at the bottom.
//
// Composing is type-first. The note is categorised automatically from how it
// reads, with the guess shown live above the field — picking a category by hand
// is an override, not a prerequisite.

import { useEffect, useRef, useState } from 'react'
import type { EntityDetail, EntityKind, HistoryEntry, SectionKey } from '../../shared/types'
import type { PolishState } from '../bridge'
import { SECTION_LABELS, migrateSection, sectionsFor } from '../../shared/types'
import { call } from '../rpc'
import { Composer, type ComposerEntry, type SendMode } from '../Composer'
import { ComponentViewer, type WriteTarget } from '../ComponentViewer'
import { describeScope, scopeApplies, scopeDepth, scopeReach } from '../../shared/variants'
import { HistoryList } from '../HistoryList'
import { Drafts } from '../Drafts'
import { Swatch } from '../Swatch'
import { Target } from '../icons'

interface Props {
  entityId: string
  entityKind: EntityKind
  /** Name of the opened entity, used as the default write target's label. */
  name: string
  /** Variant selected on canvas, if any — opens the viewer on that combination. */
  initialVariantId?: string
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
  /**
   * Reports the combination the composer is currently writing about, so a draft
   * request made from the detail header can be about the same scope. Null when
   * nothing is scoped.
   */
  onScope?: (scope: Record<string, string> | null) => void
  /** This entity's slice of the edit history, and controls to reverse it. */
  history?: HistoryEntry[]
  onHistoryDirection?: (id: string, direction: 'undo' | 'redo') => void
  onHistoryUndoAll?: () => void
  /** Ask Claude to draft this entity — the AI-drafts tab's button. */
  onDraft?: () => void
}

/** The opened entity, as the target notes go to until someone says otherwise. */
function asTarget(entityId: string, entityKind: EntityKind, name: string): WriteTarget {
  return { entityId, entityKind, name }
}

export function Detail({
  entityId,
  entityKind,
  name,
  initialVariantId,
  onSaved,
  onError,
  onPolish,
  polish,
  onAsk,
  bridgeReady,
  answer,
  onDismissAnswer,
  onScope,
  history,
  onHistoryDirection,
  onHistoryUndoAll,
  onDraft,
}: Props) {
  const [tab, setTab] = useState<'variants' | 'markup' | 'history' | 'drafts'>('markup')
  const [resetArmed, setResetArmed] = useState(false)
  const [detail, setDetail] = useState<EntityDetail | null>(null)
  const [saving, setSaving] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [refiling, setRefiling] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editingNote, setEditingNote] = useState<{ id: string; text: string } | null>(null)
  const docRef = useRef<HTMLDivElement>(null)

  /**
   * What a note gets written to. Starts as whatever was opened and only ever
   * moves because someone clicked the target control — everything below writes
   * here rather than to the opened entity.
   */
  const [target, setTarget] = useState<WriteTarget>(asTarget(entityId, entityKind, name))

  /**
   * The opened component, kept for the viewer's property table.
   *
   * When the target moves to a variant, `detail` follows it and no longer
   * carries the set's variants — but the picker still has to be drawn.
   */
  const [shell, setShell] = useState<EntityDetail | null>(null)

  /**
   * The viewer's picker, held here rather than inside the viewer.
   *
   * Changing the write target reloads the notes, and the viewer unmounts while
   * that happens — so state living inside it was reseeded from the first
   * variant on every remount. Choosing "Tertiary" and then clicking the variant
   * chip snapped straight back to "Primary". Up here it survives a target
   * change and resets only when a different component is opened.
   */
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [overrides, setOverrides] = useState<Record<string, string | boolean>>({})
  /**
   * Which properties the next note is about.
   *
   * Empty means the whole component, which is the default and the common case.
   * Nothing is ever added here without a click, because this is what decides
   * where a note lands.
   */
  const [scoped, setScoped] = useState<string[]>([])

  // A new entity is a fresh start: the target must never survive navigation, or
  // the next component would open still pointed at the last one's variant.
  useEffect(() => {
    setTarget(asTarget(entityId, entityKind, name))
    setShell(null)
    setChosen({})
    setOverrides({})
    setScoped([])
  }, [entityId, entityKind])

  // Seed the picker once the component's variants are known — the one selected
  // on canvas, else the first, which for a set Figma lays out top-left-first is
  // its default. Guarded on being unset so nothing later reseeds it.
  useEffect(() => {
    const variants = shell?.structure.variants
    if (!variants || variants.length === 0) return
    if (Object.keys(chosen).length > 0) return
    const opening = initialVariantId
      ? variants.find((v) => v.id === initialVariantId)
      : variants[0]
    if (opening) setChosen(opening.properties)
  }, [shell])

  // Load the opened entity's notes and structure, and reload when the write
  // target moves to a variant so the notes below follow it. The same first fetch
  // seeds the viewer while the target is still the opened entity, so the picture
  // costs no extra call. Without this the detail pane never leaves "Loading…".
  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setRefiling(null)
    setEditing(null)
    call({ type: 'getEntity', entityId: target.entityId, entityKind: target.entityKind })
      .then((d) => {
        if (cancelled) return
        setDetail(d)
        if (d.entityId === entityId) setShell(d)
      })
      .catch((err: Error) => {
        if (!cancelled) onError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [target.entityId, target.entityKind])

  // The scope the composer will stamp on a note: the ticked properties, at the
  // values currently on screen.
  const scope: Record<string, string> = {}
  for (const property of scoped) {
    if (chosen[property] !== undefined) scope[property] = chosen[property]
  }
  const scoping = Object.keys(scope).length > 0

  // Lift the active scope so a Claude draft request made from the detail header
  // can be about the same combination the composer is. Stringified dependency so
  // it fires only on a real change; reset on unmount so a closed detail leaves
  // nothing stale behind for the next request.
  const scopeSignature = scoping ? JSON.stringify(scope) : ''
  useEffect(() => {
    onScope?.(scoping ? scope : null)
    return () => onScope?.(null)
  }, [scopeSignature, onScope])

  // Every write goes to the target, never to the opened entity. One place to
  // read, so a new call site cannot quietly write to the wrong thing.
  const writeTo = { entityId: target.entityId, entityKind: target.entityKind }

  const submit = async (entries: ComposerEntry[], mode: SendMode) => {
    // A question is not a note — it never touches storage.
    if (mode === 'ask') {
      onAsk(entries[0]?.text ?? '')
      return
    }

    try {
      const updated = await call({
        type: 'addNotes',
        ...writeTo,
        entries,
        scope: scoping ? scope : undefined,
      })
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
            kind: target.entityKind,
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
      setDetail(await call({ type: 'editNote', ...writeTo, noteId: editingNote.id, text }))
      onSaved()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const review = async (noteIds: string[] | null, action: 'approve' | 'reject') => {
    setSaving(true)
    try {
      setDetail(await call({ type: 'reviewDrafts', ...writeTo, noteIds, action }))
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
      setDetail(await call({ type: 'editNote', ...writeTo, noteId, text }))
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const remove = async (noteId: string) => {
    try {
      setDetail(await call({ type: 'deleteNote', ...writeTo, noteId }))
      onSaved()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const saveBody = async () => {
    if (editing === null || saving) return
    setSaving(true)
    try {
      setDetail(await call({ type: 'saveBody', ...writeTo, body: editing }))
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
      setDetail(await call({ type: 'resetBody', ...writeTo }))
      setEditing(null)
      onSaved()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // A full clean slate for this item — every note, edit, and history entry, and
  // any stale markers earlier plugin builds left on the node. Deliberately about
  // the opened entity, never the write target.
  const resetEntity = async () => {
    setSaving(true)
    try {
      setDetail(await call({ type: 'clearEntity', entityId, entityKind }))
      setResetArmed(false)
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
      setDetail(await call({ type: 'recategorizeNote', ...writeTo, noteId, section }))
      onSaved()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  // Built before the loading guard below, because the viewer belongs to the
  // component that was opened — not to whatever the notes are currently being
  // written to. Switching the write target reloads the notes; the picture and
  // the picker have no reason to disappear while that happens, and unmounting
  // them is what used to reset the picker.
  const viewer =
    shell !== null && (entityKind === 'component' || entityKind === 'componentSet') ? (
      <ComponentViewer
        entityId={entityId}
        name={name}
        structure={shell.structure}
        chosen={chosen}
        onChosenChange={setChosen}
        overrides={overrides}
        onOverridesChange={setOverrides}
        scoped={scoped}
        onScopedChange={setScoped}
      />
    ) : null

  if (!detail) {
    return (
      <div className="body">
        {viewer}
        <div className="state">Loading…</div>
      </div>
    )
  }

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
    detail.storedAs.kind !== target.entityKind

  const canReveal =
    target.entityKind === 'component' ||
    target.entityKind === 'componentSet' ||
    target.entityKind === 'variant'
  const liveEntries = detail.log.filter((e) => !e.deleted)
  const filled = new Set(liveEntries.map((e) => migrateSection(e.section)))
  const sections = sectionsFor(target.entityKind)

  const isComponent = entityKind === 'component' || entityKind === 'componentSet'
  const draftItems = detail.log.filter((e) => e.draft && !e.deleted)
  const tabDefs = [
    ...(isComponent ? [{ key: 'variants' as const, label: 'Variants', badge: 0 }] : []),
    { key: 'markup' as const, label: 'Markup', badge: 0 },
    { key: 'history' as const, label: 'History', badge: history?.length ?? 0 },
    { key: 'drafts' as const, label: 'AI drafts', badge: draftItems.length },
  ]
  const activeTab = tabDefs.some((t) => t.key === tab) ? tab : 'markup'

  // Reach of the current scope, for the single "Writing about" strip.
  const allVariants = shell?.structure.variants ?? []
  const reach = scoping ? scopeReach(allVariants, scope) : allVariants.length

  return (
    <>
      <div className="detail-tabs">
        {tabDefs.map((t) => (
          <button
            key={t.key}
            className={`detail-tab${activeTab === t.key ? ' on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.badge ? <span className="detail-tab-badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>

      <div className="body">
        {activeTab === 'variants' && viewer}

        {activeTab === 'drafts' &&
          (draftItems.length > 0 ? (
            <Drafts
              drafts={draftItems}
              entityKind={target.entityKind}
              busy={saving}
              onApprove={(ids) => review(ids, 'approve')}
              onReject={(ids) => review(ids, 'reject')}
              onEdit={editDraft}
            />
          ) : (
            <div className="state">
              No AI drafts yet.
              {onDraft && bridgeReady ? (
                <div style={{ marginTop: 12 }}>
                  <button className="btn primary" onClick={onDraft}>
                    Ask Claude to draft this
                  </button>
                </div>
              ) : (
                <>
                  <br />
                  Start the Claude bridge to draft with AI.
                </>
              )}
            </div>
          ))}

        {activeTab === 'history' && (
          <HistoryList
            entries={history ?? []}
            onDirection={onHistoryDirection ?? (() => undefined)}
            onUndoAll={onHistoryUndoAll}
            emptyLabel="No edits yet on this item. Every change here can be undone."
          />
        )}

        {activeTab === 'markup' && (
          <>
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
              {resetArmed ? (
                <span className="reset-confirm">
                  Wipe every note, edit &amp; history entry for this item?
                  <button className="btn danger small" onClick={resetEntity} disabled={saving}>
                    Reset everything
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setResetArmed(false)}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  className="link-btn danger"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => setResetArmed(true)}
                  title="Clear everything for this item, including stale markers left by earlier plugin builds"
                >
                  Reset
                </button>
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
              [...detail.log]
                // General rules before narrow ones, which is the order they
                // apply in and the order someone would explain them.
                .sort((a, b) => scopeDepth(a.scope) - scopeDepth(b.scope))
                .map((entry) => {
                const section = migrateSection(entry.section)
                // Dimmed when it does not reach the combination on screen —
                // still listed, because it is still a note about this component.
                const reaches = scopeApplies(entry.scope, chosen)
                return (
                  <div
                    key={entry.id}
                    className={`entry${entry.deleted ? ' gone' : ''}${reaches ? '' : ' distant'}`}
                  >
                    <div className="entry-main">
                      {entry.scope && (
                        <span
                          className={`entry-scope${reaches ? ' reaches' : ''}`}
                          title={
                            reaches
                              ? 'Applies to the variant on screen'
                              : 'Written about a different combination'
                          }
                        >
                          {describeScope(entry.scope)}
                        </span>
                      )}
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
          </>
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

      {(entityKind === 'component' || entityKind === 'componentSet') && (
        // Pinned directly above the input so what a note will be about is always
        // in view while typing — the viewer's own strip scrolls away with it.
        <div className="composer-scope">
          <span className="composer-scope-label">Writing about</span>
          <span className="composer-scope-value">
            {scoping ? describeScope(scope) : `${name} — every variant`}
          </span>
          {allVariants.length > 0 && (
            <span className="composer-scope-reach">
              {scoping
                ? `${reach} of ${allVariants.length} variants`
                : `all ${allVariants.length} variants`}
            </span>
          )}
          {scoping && (
            <button className="composer-scope-clear" onClick={() => setScoped([])}>
              clear
            </button>
          )}
        </div>
      )}

      <Composer
        entityKind={target.entityKind}
        bridgeReady={bridgeReady}
        filled={filled}
        onSubmit={submit}
        // Says what it will write to. Only when that is not the thing you
        // opened — otherwise it is stating the obvious in every other screen.
        placeholder={scoping ? `Note about ${describeScope(scope)}…` : undefined}
        trailing={
          canReveal ? (
            <button
              className="chip"
              onClick={() => call({ type: 'revealEntity', ...writeTo })}
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
