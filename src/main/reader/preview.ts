// Rasterising a component so a person can see what they are documenting.
//
// Two paths, and the difference matters. Variant properties select a different
// *node*, so switching them is free: find the right child and export it, with
// the document untouched. Boolean, text and instance-swap properties do not —
// they are overrides applied to an instance, and the variant node itself
// renders with the defaults baked in. Toggling one on a static export would do
// nothing at all, which is why they need an instance.
//
// So the cheap path runs whenever it can, and the instance path only when a
// non-variant property is actually moved off its default.

/** A rendered node, ready for an <img src="data:image/png;base64,…">. */
export interface RenderedImage {
  png: string
  width: number
  height: number
  /**
   * Properties the component would not accept, by display name.
   *
   * Surfaced so a toggle that cannot take effect says so, rather than looking
   * broken. Usually means the property is exposed on the set but lives on a
   * layer this render could not reach.
   */
  unapplied?: string[]
}

/** Sent to the bridge: enough to read a control, not a screenshot. */
export const BRIDGE_MAX_PX = 320
/** Shown in the plugin: the designer is actually looking at this one. */
export const VIEWER_MAX_PX = 480

/**
 * Rasterised images, for the session.
 *
 * Export is the expensive part by a wide margin, and a designer clicking back
 * and forth between two variants is the normal case. Keyed on everything that
 * changes the picture.
 */
const cache = new Map<string, RenderedImage>()

export function invalidatePreviewCache(): void {
  cache.clear()
}

type Overrides = Record<string, string | boolean>

/** Stable across key order, which a plain stringify would not be. */
function cacheKey(nodeId: string, maxPx: number, overrides?: Overrides): string {
  if (!overrides || Object.keys(overrides).length === 0) return `${nodeId}:${maxPx}`
  const stable = Object.keys(overrides)
    .sort()
    .map((k) => `${k}=${String(overrides[k])}`)
    .join(',')
  return `${nodeId}:${maxPx}:${stable}`
}

/**
 * Scale so the longest edge lands near `maxPx`.
 *
 * Capped at 2 because exporting a 16px icon at 30× to fill a panel produces a
 * huge blurry PNG, and floored at 0.25 so a 4000px marketing frame still comes
 * back as something rather than timing out.
 */
function scaleFor(node: SceneNode, maxPx: number): number {
  const longest = Math.max('width' in node ? node.width : 0, 'height' in node ? node.height : 0)
  if (longest <= 0) return 1
  return Math.max(0.25, Math.min(2, maxPx / longest))
}

async function rasterise(node: SceneNode, maxPx: number): Promise<RenderedImage | null> {
  if (!('exportAsync' in node)) return null
  const scale = scaleFor(node, maxPx)

  try {
    const bytes = await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: scale },
    })
    return {
      png: figma.base64Encode(bytes),
      width: Math.round(('width' in node ? node.width : 0) * scale),
      height: Math.round(('height' in node ? node.height : 0) * scale),
    }
  } catch (err) {
    // One component that cannot be rasterised must not sink the whole request.
    console.error('[dsdoc] could not export image', err)
    return null
  }
}

/** The half of a property key before its `#0:0` suffix. */
function displayName(key: string): string {
  return key.split('#')[0]
}

/**
 * Applies component properties, following them down to wherever they live.
 *
 * A variant is very often a thin wrapper around an instance of a master
 * component, with the layers a boolean controls sitting inside that master.
 * The property is surfaced on the set, so the plugin offers it — but
 * `setProperties` on the outer instance rejects it, because it belongs to the
 * nested one. That threw, the whole render was abandoned, and the toggle looked
 * inert.
 *
 * So each property is applied on its own — one unknown key must not sink the
 * others — and anything the outer instance refuses is looked for by name among
 * the instances beneath it. Whatever still finds no home is reported rather
 * than silently ignored, because a control that does nothing and says nothing
 * is worse than one that admits it.
 */
function applyProperties(instance: InstanceNode, overrides: Overrides): string[] {
  const pending = new Map(Object.entries(overrides))

  const attempt = (target: InstanceNode, key: string, value: string | boolean): boolean => {
    try {
      target.setProperties({ [key]: value })
      return true
    } catch {
      return false
    }
  }

  for (const [key, value] of [...pending]) {
    if (attempt(instance, key, value)) pending.delete(key)
  }
  if (pending.size === 0) return []

  // Matched on the visible name: the nested instance carries its own suffix, so
  // the outer key will never equal it.
  const nested = instance.findAllWithCriteria({ types: ['INSTANCE'] })
  for (const child of nested) {
    if (pending.size === 0) break
    let definitions: Record<string, unknown>
    try {
      definitions = child.componentProperties as unknown as Record<string, unknown>
    } catch {
      continue
    }
    for (const [key, value] of [...pending]) {
      const match = Object.keys(definitions).find((k) => displayName(k) === displayName(key))
      if (match && attempt(child, match, value)) pending.delete(key)
    }
  }

  return [...pending.keys()].map(displayName)
}

/**
 * Render with properties applied, via a throwaway instance.
 *
 * The instance is parented to the current page by `createInstance`, so it is
 * moved far out of the way and removed in a `finally`. That last part is not
 * optional: an orphaned instance left behind on a design system page would be a
 * genuine mess for whoever opens the file next.
 */
async function rasteriseWithOverrides(
  component: ComponentNode,
  overrides: Overrides,
  maxPx: number
): Promise<RenderedImage | null> {
  let instance: InstanceNode | null = null
  try {
    instance = component.createInstance()
    instance.x = -100_000
    instance.y = -100_000
    const unapplied = applyProperties(instance, overrides)
    const image = await rasterise(instance, maxPx)
    return image ? { ...image, unapplied: unapplied.length > 0 ? unapplied : undefined } : null
  } catch (err) {
    console.error('[dsdoc] could not render with overrides', err)
    return null
  } finally {
    instance?.remove()
  }
}

/** The component an instance should be made from, for a node of any kind. */
function instantiable(node: BaseNode): ComponentNode | null {
  if (node.type === 'COMPONENT') return node
  if (node.type === 'COMPONENT_SET') return node.defaultVariant ?? (node.children[0] as ComponentNode)
  return null
}

/**
 * A picture of one node, optionally with component properties applied.
 *
 * Returns null rather than throwing — a missing preview should leave the rest
 * of the screen working.
 */
export async function renderNode(
  nodeId: string,
  options: { maxPx?: number; overrides?: Overrides } = {}
): Promise<RenderedImage | null> {
  const maxPx = options.maxPx ?? VIEWER_MAX_PX
  const key = cacheKey(nodeId, maxPx, options.overrides)

  const hit = cache.get(key)
  if (hit) return hit

  const node = await figma.getNodeByIdAsync(nodeId)
  if (!node) return null

  let image: RenderedImage | null

  if (options.overrides && Object.keys(options.overrides).length > 0) {
    const component = instantiable(node)
    image = component ? await rasteriseWithOverrides(component, options.overrides, maxPx) : null
  } else {
    // A component set is a frame holding every variant, which is rarely what
    // someone wants to look at. Its default variant is what Figma itself would
    // insert, so that is what stands in for the set.
    const target =
      node.type === 'COMPONENT_SET' ? (node.defaultVariant ?? node.children[0]) : node
    image = 'exportAsync' in target ? await rasterise(target as SceneNode, maxPx) : null
  }

  if (image) cache.set(key, image)
  return image
}
