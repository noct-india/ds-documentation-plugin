// Seeing what you are documenting.
//
// Figma gives no way to embed its own properties panel, so this draws one: the
// controls come from `componentPropertyDefinitions` and picking a combination
// re-renders the component. Variant properties select a different node and cost
// nothing; booleans and text are instance overrides, and the sandbox handles
// those by rendering through a throwaway instance — otherwise toggling "Icon"
// would leave the picture unchanged, which is worse than not offering it.
//
// Only what is on screen is ever rasterised, so a 176-variant set costs one
// image rather than 176.

import { useEffect, useMemo, useState } from 'react'
import type {
  ComponentProperty,
  EntityKind,
  EntityStructure,
  VariantRef,
} from '../shared/types'
import { call } from './rpc'

/**
 * What a note is written to.
 *
 * The viewer only ever points this at a component set or one of its variants,
 * but the type stays as wide as `EntityKind` because every screen carries a
 * target — a colour style is simply its own.
 */
export interface WriteTarget {
  entityId: string
  entityKind: EntityKind
  name: string
}

interface Props {
  entityId: string
  name: string
  structure: EntityStructure
  /**
   * The chosen combination, and the overrides applied on top.
   *
   * Both are owned by the detail screen rather than held here. Switching the
   * write target reloads the notes, which briefly unmounts this component — and
   * state born inside it would be reseeded from the first variant every time,
   * so picking "Tertiary" and then clicking the variant chip would snap back to
   * "Primary". Lifting it gives it the lifetime it should have: it survives a
   * target change and resets only when a different component is opened.
   */
  chosen: Record<string, string>
  onChosenChange: (next: Record<string, string>) => void
  overrides: Record<string, string | boolean>
  onOverridesChange: (next: Record<string, string | boolean>) => void
  /** Which thing notes are currently written to. */
  target: WriteTarget
  onTargetChange: (target: WriteTarget) => void
}

/** Properties that choose a variant, as opposed to overriding one. */
function variantProps(properties: ComponentProperty[]): ComponentProperty[] {
  return properties.filter((p) => p.type === 'VARIANT' && (p.options?.length ?? 0) > 0)
}

/** Properties applied on top of a variant — these need an instance to show. */
function overrideProps(properties: ComponentProperty[]): ComponentProperty[] {
  return properties.filter((p) => p.type === 'BOOLEAN' || p.type === 'TEXT')
}

/** The variant matching a chosen combination, if the set has one. */
function matchVariant(
  variants: VariantRef[],
  chosen: Record<string, string>
): VariantRef | undefined {
  return variants.find((variant) =>
    Object.keys(chosen).every((key) => variant.properties[key] === chosen[key])
  )
}

export function ComponentViewer({
  entityId,
  name,
  structure,
  chosen,
  onChosenChange,
  overrides,
  onOverridesChange,
  target,
  onTargetChange,
}: Props) {
  const properties = structure.properties ?? []
  const variants = structure.variants ?? []
  const selectors = useMemo(() => variantProps(properties), [properties])
  const overridables = useMemo(() => overrideProps(properties), [properties])

  const [image, setImage] = useState<{ png: string; width: number; height: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const current = variants.length > 0 ? matchVariant(variants, chosen) : undefined
  // What actually gets rendered: the matching variant, or the component itself
  // when there are no variants to choose between.
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

  // Moving the picker while writing to a variant follows the picker, so the
  // target label and the picture never disagree about which one you mean.
  useEffect(() => {
    if (target.entityKind !== 'variant' || !current) return
    if (target.entityId === current.id) return
    onTargetChange({ entityId: current.id, entityKind: 'variant', name: current.name })
  }, [current?.id])

  const onSet = target.entityKind !== 'variant'

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
          {selectors.map((property) => (
            <label key={property.key} className="viewer-prop">
              <span className="viewer-prop-name">{property.displayName}</span>
              <select
                className="viewer-select"
                value={chosen[property.displayName] ?? property.defaultValue}
                onChange={(e) =>
                  onChosenChange({ ...chosen, [property.displayName]: e.target.value })
                }
              >
                {property.options?.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          ))}

          {overridables.map((property) =>
            property.type === 'BOOLEAN' ? (
              <label key={property.key} className="viewer-prop">
                <span className="viewer-prop-name">{property.displayName}</span>
                <input
                  type="checkbox"
                  className="viewer-toggle"
                  checked={
                    typeof overrides[property.key] === 'boolean'
                      ? (overrides[property.key] as boolean)
                      : property.defaultValue === 'true'
                  }
                  onChange={(e) =>
                    onOverridesChange({ ...overrides, [property.key]: e.target.checked })
                  }
                />
              </label>
            ) : (
              <label key={property.key} className="viewer-prop">
                <span className="viewer-prop-name">{property.displayName}</span>
                <input
                  type="text"
                  className="viewer-text"
                  placeholder={property.defaultValue}
                  value={String(overrides[property.key] ?? '')}
                  onChange={(e) =>
                    onOverridesChange(
                      (() => {
                        const next = { ...overrides }
                        // Clearing the field returns to the default rather than
                        // rendering the component with an empty string in it.
                        if (e.target.value === '') delete next[property.key]
                        else next[property.key] = e.target.value
                        return next
                      })()
                    )
                  }
                />
              </label>
            )
          )}

          {selectors.length === 0 && overridables.length === 0 && (
            <div className="viewer-noprops">No properties</div>
          )}

          {structure.variantCount !== undefined && structure.variantCount > 1 && (
            <div className="viewer-count">{structure.variantCount} variants</div>
          )}
        </div>
      </div>

      {/* Which thing a note is written to. Always visible, never inferred —
          a picker that quietly redirected writes would be the ideal way to
          file notes against the wrong element. */}
      {current && (
        <div className="viewer-target">
          <span className="viewer-target-label">Writing about</span>
          <button
            className={`viewer-target-opt${onSet ? ' on' : ''}`}
            onClick={() =>
              onTargetChange({ entityId, entityKind: 'componentSet', name })
            }
          >
            {name}, all variants
          </button>
          <button
            className={`viewer-target-opt${onSet ? '' : ' on'}`}
            onClick={() =>
              onTargetChange({ entityId: current.id, entityKind: 'variant', name: current.name })
            }
            title={`Write a note about only ${current.name}`}
          >
            This one · {current.name}
          </button>
        </div>
      )}
    </div>
  )
}
