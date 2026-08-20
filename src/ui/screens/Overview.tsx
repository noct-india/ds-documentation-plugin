// What fills the right pane before anything is selected: coverage, warnings,
// and how the thing works.

import { useEffect, useState } from 'react'
import type { HomeState, SectionKey } from '../../shared/types'
import { SECTION_LABELS, sectionsFor } from '../../shared/types'

interface Props {
  home: HomeState | null
  error: string | null
  onSaveBrief: (text: string) => void
  /** Walks every page for the component total. Resolves when the number is in. */
  onCountComponents: () => Promise<void>
}

/**
 * Which project-wide rules exist, as a checklist rather than a count.
 *
 * "3 notes" does not tell you whether anyone has written down how the product
 * lays out — and that is exactly the gap nobody notices until Figma Make
 * invents a grid of its own. An empty one is worth showing precisely because it
 * is empty.
 */
function ProjectGuidelines({ filled }: { filled: SectionKey[] }) {
  const sections = sectionsFor('project')
  const done = sections.filter((key) => filled.indexOf(key) !== -1).length

  return (
    <div className="guidelines">
      <div className="guidelines-head">
        <strong>Project guidelines</strong>
        <span>
          {done === 0
            ? 'None written — Figma Make will guess at all of it'
            : `${done} of ${sections.length} written`}
        </span>
      </div>
      <div className="guidelines-row">
        {sections.map((key) => {
          const has = filled.indexOf(key) !== -1
          return (
            <span
              key={key}
              className={`guidelines-chip${has ? ' on' : ''}`}
              title={
                has
                  ? `${SECTION_LABELS[key]} — written`
                  : `${SECTION_LABELS[key]} — nothing written, so it will be inferred`
              }
            >
              {SECTION_LABELS[key]}
            </span>
          )
        })}
      </div>
    </div>
  )
}

export function Overview({ home, error, onSaveBrief, onCountComponents }: Props) {
  const [brief, setBrief] = useState<string | null>(null)
  const [counting, setCounting] = useState(false)

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

  const { counts, documented } = home
  const total = counts.variables + counts.paintStyles + counts.textStyles + counts.effectStyles
  const percent = total > 0 ? Math.round((home.documentedCount / total) * 100) : 0

  // Components have no denominator until the user has opened that section —
  // finding one means loading every page. The documented count is known either
  // way, from the index, so it is shown on its own rather than withheld.
  const rows: Array<{ label: string; done: number; total: number | null }> = [
    { label: 'Variables', done: documented.variables, total: counts.variables },
    { label: 'Collections', done: documented.collections, total: counts.collections },
    { label: 'Color styles', done: documented.paintStyles, total: counts.paintStyles },
    { label: 'Text styles', done: documented.textStyles, total: counts.textStyles },
    { label: 'Effect styles', done: documented.effectStyles, total: counts.effectStyles },
    { label: 'Components', done: documented.components, total: counts.components },
  ]

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

      <div className="stats">
        {rows.map((row) => {
          const none = row.done === 0
          return (
            <div key={row.label} className={`stat${none ? ' none' : ''}`}>
              <span className="stat-label">{row.label}</span>
              <span className="stat-value">
                <strong>{row.done}</strong>
                {row.total === null ? (
                  <span className="stat-of"> documented</span>
                ) : (
                  <span className="stat-of"> of {row.total}</span>
                )}
              </span>
            </div>
          )
        })}
        {documented.variants > 0 && (
          <div className="stat">
            <span className="stat-label">Individual variants</span>
            <span className="stat-value">
              <strong>{documented.variants}</strong>
              <span className="stat-of"> documented</span>
            </span>
          </div>
        )}

        {/* The component total is the one figure that costs something to get —
            it means loading every page. Everything else is read on open, so
            only this sits behind a button. */}
        <div className="stat-action">
          <span className="stat-of">
            {counts.components === null
              ? 'Component total needs every page loaded'
              : 'Counted — run again after adding components'}
          </span>
          <button
            className="link-btn"
            disabled={counting}
            onClick={() => {
              setCounting(true)
              onCountComponents().finally(() => setCounting(false))
            }}
          >
            {counting
              ? 'Counting…'
              : counts.components === null
                ? 'Count components'
                : 'Recount'}
          </button>
        </div>
      </div>

      <ProjectGuidelines filled={home.projectSections} />

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
