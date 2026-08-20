// Seeing what you are documenting, and saying what you mean by it.
//
// Two jobs in one panel, deliberately. The dropdowns and switches choose which
// variant is on screen. The checkbox beside each one says whether that property
// is part of what the next note is *about* — tick Type and the note applies to
// every primary; tick nothing and it applies to the whole component; tick them
// all and it applies to exactly what you are looking at.
//
// Figma gives no way to embed its own properties panel, so this draws one. Only
// what is on screen is ever rasterised, so a 47-variant set costs one image.

import { useEffect, useMemo, useState } from 'react'
import type { ComponentProperty, EntityKind, EntityStructure } from '../shared/types'
import { call } from './rpc'
import {
  describeScope,
  matchVariant,
  reconcile,
  scopeReach,
  type Scope,
} from '../shared/variants'

/**
 * What a note is written to.
 *
 * For a component this is always the set itself; `scope` is what narrows it.
 * There is no Figma object meaning "all primary buttons", so the scope travels
 * with the note rather than being encoded in where it is stored.
 */
export interface WriteTarget {
  entityId: string
  entityKind: EntityKind
  name: string
  scope?: Scope
}

interface Props {
  entityId: string
  name: string
  structure: EntityStructure
  /** The combination on screen, and any overrides applied on top of it. */
  chosen: Record<string, string>
  onChosenChange: (next: Record<string, string>) => void
  overrides: Record<string, string | boolean>
  onOverridesChange: (next: Record<string, string | boolean>) => void
  /** Which properties are part of what the next note is about. */
  scoped: string[]
  onScopedChange: (next: string[]) => void
}

/** Properties that choose a variant, as opposed to overriding one. */
function variantProps(properties: ComponentProperty[]): ComponentProperty[] {
  return properties.filter((p) => p.type === 'VARIANT' && (p.options?.length ?? 0) > 0)
}

/** Properties applied on top of a variant — these need an instance to show. */
function overrideProps(properties: ComponentProperty[]): ComponentProperty[] {
  return properties.filter((p) => p.type === 'BOOLEAN' || p.type === 'TEXT')
}

export function ComponentViewer({
  entityId,
  name,
  structure,
  chosen,
  onChosenChange,
  overrides,
  onOverridesChange,
  scoped,
  onScopedChange,
}: Props) {
  const properties = structure.properties ?? []
  const variants = structure.variants ?? []
  const selectors = useMemo(() => variantProps(properties), [properties])
  const overridables = useMemo(() => overrideProps(properties), [properties])

  const [image, setImage] = useState<{
    png: string
    width: number
    height: number
    unapplied?: string[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const current = variants.length > 0 ? matchVariant(variants, chosen) : undefined
  const renderId = current?.id ?? entityId
  const dirty = Object.keys(overrides).length > 0

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)

    call({
      type: 'getComponentImage',
      nodeId: renderId,
      overrides: dirty ? overrides : undefined,
    })
      .then((result) => {
        if (cancelled) return
        setImage(result)
        setFailed(result === null)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        // A component that will not rasterise must not take the notes with it.
        setFailed(true)
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [renderId, JSON.stringify(overrides)])

  const toggleScope = (property: string) => {
    onScopedChange(
      scoped.indexOf(property) === -1
        ? [...scoped, property]
        : scoped.filter((p) => p !== property)
    )
  }

  // What the next note will be about, built from the ticked properties and the
  // values currently on screen.
  const scope: Scope = {}
  for (const property of scoped) {
    if (chosen[property] !== undefined) scope[property] = chosen[property]
  }
  const scopeSize = Object.keys(scope).length
  const reach = scopeReach(variants, scope)
  const everything = scopeSize === 0
  const exact = scopeSize > 0 && scopeSize === selectors.length + overridables.length

  const row = (property: ComponentProperty, control: React.ReactNode) => {
    const on = scoped.indexOf(property.displayName) !== -1
    return (
      <div key={property.key} className={`prop-row${on ? ' scoped' : ''}`}>
        <input
          type="checkbox"
          className="prop-check"
          id={`scope-${property.key}`}
          checked={on}
          onChange={() => toggleScope(property.displayName)}
          title={
            on
              ? `Notes will be about this ${property.displayName}`
              : `Notes apply whatever ${property.displayName} is`
          }
        />
        <label className="prop-name" htmlFor={`scope-${property.key}`}>
          {property.displayName}
        </label>
        <div className="prop-control">{control}</div>
      </div>
    )
  }

  return (
    <div className="viewer">
      <div className="viewer-stage">
        {failed ? (
          <div className="viewer-empty">No preview</div>
        ) : (
          <div className="viewer-frame">
            {image && (
              <img
                className="viewer-img"
                src={`data:image/png;base64,${image.png}`}
                alt={current?.name ?? name}
                style={{ opacity: loading ? 0.4 : 1 }}
              />
            )}
            {loading && !image && <div className="viewer-empty">…</div>}
          </div>
        )}

        <div className="viewer-props">
          {selectors.map((property) =>
            row(
              property,
              <select
                className="viewer-select"
                value={chosen[property.displayName] ?? property.defaultValue}
                onChange={(e) =>
                  onChosenChange(
                    reconcile(variants, chosen, property.displayName, e.target.value)
                  )
                }
              >
                {property.options?.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            )
          )}

          {overridables.map((property) => {
            if (property.type === 'BOOLEAN') {
              const value =
                typeof overrides[property.key] === 'boolean'
                  ? (overrides[property.key] as boolean)
                  : property.defaultValue === 'true'
              return row(
                property,
                <>
                  {/* A switch, not a checkbox — the checkbox beside it already
                      means something else entirely, and two of them in a row
                      would be unreadable. */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={value}
                    aria-label={property.displayName}
                    className="viewer-switch"
                    onClick={() => {
                      onOverridesChange({ ...overrides, [property.key]: !value })
                      onChosenChange({ ...chosen, [property.displayName]: !value ? 'On' : 'Off' })
                    }}
                  >
                    <span className="viewer-switch-knob" />
                  </button>
                  <span className="viewer-switch-value">{value ? 'On' : 'Off'}</span>
                </>
              )
            }
            return row(
              property,
              <input
                type="text"
                className="viewer-text"
                placeholder={property.defaultValue}
                value={String(overrides[property.key] ?? '')}
                onChange={(e) => {
                  const next = { ...overrides }
                  // Clearing the field returns to the default rather than
                  // rendering the component with an empty string in it.
                  if (e.target.value === '') delete next[property.key]
                  else next[property.key] = e.target.value
                  onOverridesChange(next)
                }}
              />
            )
          })}

          {selectors.length === 0 && overridables.length === 0 && (
            <div className="viewer-noprops">No properties</div>
          )}

          {structure.variantCount !== undefined && structure.variantCount > 1 && (
            <div className="viewer-count">{structure.variantCount} variants</div>
          )}
        </div>
      </div>

      {/* A property the component would not accept. Said out loud, because a
          toggle that changes nothing and explains nothing reads as broken. */}
      {image?.unapplied && (
        <div className="viewer-warn">
          {image.unapplied.join(', ')} could not be applied to this variant — the preview
          shows it unchanged.
        </div>
      )}

      {/* What the next note is about. Never inferred: this is the control that
          decides where what you type ends up. */}
      <div className="viewer-scope">
        <span className="viewer-scope-label">Writing about</span>
        <span className="viewer-scope-value">
          {everything ? `${name} — every variant` : describeScope(scope)}
        </span>
        <span className="viewer-scope-reach">
          {everything
            ? `all ${variants.length || ''} variants`.trim()
            : exact
              ? 'this exact variant'
              : `${reach} of ${variants.length} variants`}
        </span>
        {scopeSize > 0 && (
          <button className="viewer-scope-clear" onClick={() => onScopedChange([])}>
            clear
          </button>
        )}
      </div>
    </div>
  )
}
