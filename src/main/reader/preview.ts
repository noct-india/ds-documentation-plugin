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
    instance.setProperties(overrides)
    return await rasterise(instance, maxPx)
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
