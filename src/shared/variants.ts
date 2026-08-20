// Choosing a variant from a property combination.
//
// Pure, and deliberately not in the viewer component: a component set is rarely
// a full cross-product, so which combinations exist is real logic with real
// edge cases, and it is worth testing without a browser.

import type { VariantRef } from './types'

/** The variant matching a chosen combination, if the set has one. */
export function matchVariant(
  variants: VariantRef[],
  chosen: Record<string, string>
): VariantRef | undefined {
  return variants.find((variant) =>
    Object.keys(chosen).every((key) => variant.properties[key] === chosen[key])
  )
}

/**
 * The combination to land on after changing one property.
 *
 * A set is rarely a full cross-product — 47 variants across three axes means
 * plenty of combinations nobody drew. Picking `Type=Mobile Link` when no Mobile
 * Link exists at `Size=Large` used to leave the picker pointing at nothing: the
 * preview quietly fell back to rendering the whole set, and the write-target
 * chips vanished entirely, taking the way back to set-level with them.
 *
 * So the property just changed is honoured absolutely and the rest give way —
 * the closest variant that actually exists wins, which is how Figma's own panel
 * behaves. The impossible state stops being reachable, rather than being
 * explained after the fact.
 */
export function reconcile(
  variants: VariantRef[],
  chosen: Record<string, string>,
  key: string,
  value: string
): Record<string, string> {
  const want = { ...chosen, [key]: value }
  if (matchVariant(variants, want)) return want

  const candidates = variants.filter((v) => v.properties[key] === value)
  // No variant carries this value at all — nothing sensible to snap to, so the
  // selection stands and the caller reports it as unavailable.
  if (candidates.length === 0) return want

  let best = candidates[0]
  let bestScore = -1
  for (const variant of candidates) {
    const score = Object.keys(want).filter(
      (other) => other !== key && variant.properties[other] === want[other]
    ).length
    if (score > bestScore) {
      bestScore = score
      best = variant
    }
  }
  return best.properties
}
