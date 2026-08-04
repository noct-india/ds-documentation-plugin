// Reviewing Claude's suggestions.
//
// Drafts are held apart from authored notes and never reach the export until
// someone approves one. Approval is the moment a person takes responsibility
// for the claim, so it is deliberately a decision rather than a default.

import { useState } from 'react'
import type { EntityKind, NoteEntry } from '../shared/types'
import { SECTION_LABELS, migrateSection } from '../shared/types'

interface Props {
  drafts: NoteEntry[]
  entityKind: EntityKind
  busy: boolean
  onApprove: (noteIds: string[] | null) => void
  onReject: (noteIds: string[] | null) => void
  onEdit: (noteId: string, text: string) => void
}

export function Drafts({ drafts, busy, onApprove, onReject, onEdit }: Props) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  if (drafts.length === 0) return null

  const commit = () => {
    if (!editing) return
    const text = editing.text.trim()
    setEditing(null)
    if (text) onEdit(editing.id, text)
  }

  return (
    <div className="drafts">
      <div className="drafts-head">
        <span className="drafts-title">
          {drafts.length} suggestion{drafts.length === 1 ? '' : 's'} from Claude
        </span>
        <span className="drafts-actions">
          <button className="btn small" disabled={busy} onClick={() => onApprove(null)}>
            Approve all
          </button>
          <button className="btn small" disabled={busy} onClick={() => onReject(null)}>
            Reject all
          </button>
        </span>
      </div>

      <div className="drafts-note">
        Not counted as documented and not exported until approved.
      </div>

      {drafts.map((draft) => {
        const section = migrateSection(draft.section)
        const isEditing = editing?.id === draft.id
        return (
          <div key={draft.id} className="draft">
            <div className="draft-main">
              <div className="draft-section">{SECTION_LABELS[section]}</div>
              {isEditing ? (
                <textarea
                  className="entry-editor"
                  value={editing.text}
                  autoFocus
                  rows={3}
                  onChange={(e) => setEditing({ id: draft.id, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      commit()
                    }
                    if (e.key === 'Escape') setEditing(null)
                  }}
                  onBlur={commit}
                />
              ) : (
                <div className="draft-text">{draft.text}</div>
              )}
            </div>
            {!isEditing && (
              <div className="draft-buttons">
                <button
                  className="btn small primary"
                  disabled={busy}
                  onClick={() => onApprove([draft.id])}
                  title="Accept this as a real note"
                >
                  Keep
                </button>
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => setEditing({ id: draft.id, text: draft.text })}
                >
                  Edit
                </button>
                <button className="btn small" disabled={busy} onClick={() => onReject([draft.id])}>
                  Drop
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
