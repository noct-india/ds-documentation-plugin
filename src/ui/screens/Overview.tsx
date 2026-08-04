// What fills the right pane before anything is selected: coverage, warnings,
// and how the thing works.

import { useEffect, useState } from 'react'
import type { HomeState } from '../../shared/types'

interface Props {
  home: HomeState | null
  error: string | null
  onSaveBrief: (text: string) => void
}

export function Overview({ home, error, onSaveBrief }: Props) {
  const [brief, setBrief] = useState<string | null>(null)

  // Adopt whatever is stored until the designer starts typing, then leave their
  // draft alone — a coverage refresh must not wipe a half-written brief.
  useEffect(() => {
    setBrief((current) => (current === null ? (home?.brief ?? '') : current))
  }, [home?.brief])

  if (error) {
    return (
      <div className="state">
        Could not read this file.
        <br />
        {error}
      </div>
    )
  }
  if (!home) return <div className="state">Reading design system…</div>

  const { counts } = home
  const total = counts.variables + counts.paintStyles + counts.textStyles + counts.effectStyles
  const percent = total > 0 ? Math.round((home.documentedCount / total) * 100) : 0

  return (
    <div className="overview">
      <div className="overview-head">
        <div className="overview-file">{home.fileName}</div>
        <div className="overview-coverage">
          <strong>{home.documentedCount}</strong> of {total} tokens and styles documented
          {percent > 0 && ` · ${percent}%`}
        </div>
        <div className="meter">
          <div className="meter-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>

      {home.orphans.length > 0 && (
        <div className="banner warn">
          {home.orphans.length} documented item{home.orphans.length === 1 ? '' : 's'} no longer
          exist{home.orphans.length === 1 ? 's' : ''} in this file (
          {home.orphans
            .slice(0, 3)
            .map((o) => o.name)
            .join(', ')}
          {home.orphans.length > 3 ? '…' : ''}). Their notes were stored on the item and were
          deleted with it — recover from Figma version history, or from your last export.
        </div>
      )}

      <div className="brief">
        <div className="brief-head">
          <strong>About this project</strong>
          <span>Given to Claude with every draft request, and written into Guidelines.md</span>
        </div>
        <textarea
          className="brief-input"
          value={brief ?? ''}
          placeholder={
            'What is this product, and who uses it?\n' +
            'How should it feel — dense or breathable, restrained or expressive?\n' +
            'Anything a new designer would need told on day one.'
          }
          onChange={(e) => setBrief(e.target.value)}
          onBlur={() => {
            if (brief !== null && brief !== (home.brief ?? '')) onSaveBrief(brief)
          }}
        />
        <div className="brief-note">
          The single highest-leverage thing you can write. Without it, suggestions are
          generic design advice; with it, they are about <em>your</em> product.
        </div>
      </div>

      <div className="overview-help">
        <p>
          Pick anything on the left to document it, or select components on the canvas to write
          one note across all of them.
        </p>
        <p>
          Notes are saved into this Figma file, so they sync to whoever opens it. Nothing you
          type is ever discarded — hiding or rewording a note keeps the original wording.
        </p>
        <p>
          <strong>Export</strong> produces a <code>guidelines/</code> folder shaped for Figma
          Make, mirroring your pages and sections.
        </p>
      </div>
    </div>
  )
}
