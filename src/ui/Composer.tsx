// The note composer: category chips, input, and the live split preview.
//
// Shared by the single-entity detail screen and the batch screen so the two
// cannot drift — a note typed into a batch is categorised by exactly the same
// rules as one typed against a single component.

import { useRef, useState } from 'react'
import type { EntityKind, SectionKey } from '../shared/types'
import { SECTION_LABELS, SECTION_PROMPTS, sectionsFor } from '../shared/types'
import { classify, classifySegments } from '../shared/classify'
import { Mic, Send } from './icons'

export interface ComposerEntry {
  text: string
  section: SectionKey
}

/**
 * What pressing send does.
 *
 * `add` is the default and stays instant and offline — the common case is
 * recording a fact you already know, and that should never wait on a model.
 * The other two are deliberate choices, not defaults.
 */
export type SendMode = 'add' | 'tidy' | 'ask'

const MODE_LABELS: Record<SendMode, string> = {
  add: 'Add note',
  tidy: 'Add and tidy up',
  ask: 'Ask Claude',
}

const MODE_HINTS: Record<SendMode, string> = {
  add: 'Saved as written, instantly',
  tidy: 'Saved as written, then reworded — your original is kept',
  ask: 'A question or an instruction, not a note',
}

interface Props {
  /** Drives which categories are offered. */
  entityKind: EntityKind
  /** Categories that already carry notes; omitted in batch, where it varies. */
  filled?: Set<SectionKey>
  onSubmit: (entries: ComposerEntry[], mode: SendMode) => Promise<void>
  /** Off when no bridge is running — the model-backed modes need one. */
  bridgeReady?: boolean
  /** Rendered at the end of the chip row — e.g. "reveal on canvas". */
  trailing?: React.ReactNode
  placeholder?: string
}

/** `auto` means "let the classifier decide"; anything else is a manual override. */
type Choice = SectionKey | 'auto'

export function Composer({
  entityKind,
  filled,
  onSubmit,
  trailing,
  placeholder,
  bridgeReady,
}: Props) {
  const [text, setText] = useState('')
  const [choice, setChoice] = useState<Choice>('auto')
  const [busy, setBusy] = useState(false)
  const [micHint, setMicHint] = useState(false)
  const [mode, setMode] = useState<SendMode>('add')
  const [menuOpen, setMenuOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const sections = sectionsFor(entityKind)
  const guess = classify(text, entityKind)

  // Auto mode reads sentence by sentence, so one typed note can become several
  // entries. Choosing a category by hand keeps it as a single note.
  const segments: ComposerEntry[] =
    choice === 'auto'
      ? classifySegments(text, entityKind)
      : text.trim()
        ? [{ section: choice, text: text.trim() }]
        : []

  const grow = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  const send = async (using: SendMode = mode) => {
    if (segments.length === 0 || busy) return
    setMenuOpen(false)
    setBusy(true)
    try {
      // "Ask" is a question, not a note, so it goes whole rather than split
      // into categorised segments.
      await onSubmit(using === 'ask' ? [{ section: 'notes', text: text.trim() }] : segments, using)
      setText('')
      setChoice('auto')
      requestAnimationFrame(grow)
    } finally {
      setBusy(false)
    }
  }

  const remaining = filled
    ? sections.filter((key) => !filled.has(key) && key !== 'notes').length
    : 0

  return (
    <div className="composer">
      <div className="sections">
        <button
          className={`chip auto${choice === 'auto' ? ' on' : ''}`}
          onClick={() => setChoice('auto')}
          title="Files the note automatically, based on how it reads"
        >
          {choice === 'auto' && segments.length > 0
            ? `Auto → ${segments.map((s) => SECTION_LABELS[s.section]).join(' + ')}`
            : 'Auto'}
        </button>
        {sections.map((key) => (
          <button
            key={key}
            className={`chip${choice === key ? ' on' : ''}${filled?.has(key) ? ' filled' : ''}`}
            onClick={() => setChoice(key)}
            title={SECTION_PROMPTS[key]}
          >
            {SECTION_LABELS[key]}
          </button>
        ))}
        {trailing}
      </div>

      <div className="input-bar">
        <textarea
          ref={textareaRef}
          value={text}
          placeholder={
            choice === 'auto'
              ? (placeholder ?? 'Write a rule, a purpose, a gotcha — it files itself…')
              : SECTION_PROMPTS[choice]
          }
          rows={1}
          onChange={(e) => {
            setText(e.target.value)
            grow()
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline — notes are usually one line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button
          className="icon-btn"
          title="Dictate with your operating system"
          onClick={() => {
            textareaRef.current?.focus()
            setMicHint(true)
          }}
        >
          <Mic />
        </button>
        <span className="send-group">
          <button
            className="icon-btn send"
            disabled={segments.length === 0 || busy}
            onClick={() => send()}
            title={MODE_LABELS[mode]}
          >
            <Send />
          </button>
          <button
            className="icon-btn caret"
            onClick={() => setMenuOpen((v) => !v)}
            title="Choose what send does"
          >
            ▾
          </button>

          {menuOpen && (
            <div className="send-menu">
              {(['add', 'tidy', 'ask'] as SendMode[]).map((option) => {
                const needsBridge = option !== 'add'
                const disabled = needsBridge && !bridgeReady
                return (
                  <button
                    key={option}
                    className={`send-option${mode === option ? ' on' : ''}`}
                    disabled={disabled}
                    onClick={() => {
                      setMode(option)
                      if (text.trim()) send(option)
                      else setMenuOpen(false)
                    }}
                  >
                    <span className="send-option-name">{MODE_LABELS[option]}</span>
                    <span className="send-option-hint">
                      {disabled ? 'Needs the Claude bridge running' : MODE_HINTS[option]}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </span>
      </div>

      {micHint ? (
        <div className="hint">
          Figma blocks microphone access inside plugins, so dictation runs at the OS level:
          press <strong>Fn Fn</strong> on macOS or <strong>⊞ Win + H</strong> on Windows, then
          speak — it types straight into the field above.
        </div>
      ) : segments.length > 1 ? (
        <div className="hint">
          <div>Saving as {segments.length} notes — pick a category above to keep it as one:</div>
          {segments.map((segment, i) => (
            <div key={i} className="split-row">
              <span className="split-label">{SECTION_LABELS[segment.section]}</span>
              <span className="split-text">{segment.text}</span>
            </div>
          ))}
        </div>
      ) : choice === 'auto' && text.trim() && !guess.confident ? (
        <div className="hint">
          Nothing in this reads like a category, so it will go to Notes — pick one above if it
          belongs somewhere specific.
        </div>
      ) : remaining > 0 ? (
        <div className="hint">
          {remaining} categor{remaining === 1 ? 'y' : 'ies'} still empty — an outlined chip is
          something Figma Make will have to guess at.
        </div>
      ) : null}
    </div>
  )
}
