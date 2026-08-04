// Resolving a canvas selection to something documentable.
//
// The brief: "when a user has already selected a component and opens the plugin,
// he lands directly on the notes for that component."

import type { BatchTarget, EntityKind, SelectionTarget } from '../../shared/types'
import { liveNoteCount, readLog } from '../storage'
import { isDocumentable } from './components'
import { resolveEntity } from './entity'

type DocumentableComponent = ComponentNode | ComponentSetNode

/**
 * A component set is the documentation unit, so a selected variant resolves up
 * to its parent set rather than to itself.
 */
function normalise(node: DocumentableComponent): SelectionTarget {
  if (node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET') {
    const set = node.parent
    return { entityId: set.id, entityKind: 'componentSet', name: set.name }
  }
  return {
    entityId: node.id,
    entityKind: node.type === 'COMPONENT_SET' ? 'componentSet' : 'component',
    name: node.name,
  }
}

/**
 * Walks from whatever is selected to the component that owns it.
 *
 * An instance jumps straight to its main component; anything else climbs the
 * layer tree. Returns null when the selection is unrelated to a component,
 * in which case the plugin just opens on the home screen.
 */
export async function resolveSelection(): Promise<SelectionTarget | null> {
  const selection = figma.currentPage.selection
  if (selection.length === 0) return null

  const node = selection[0]

  if (node.type === 'INSTANCE') {
    // The sync `.mainComponent` getter throws under dynamic-page loading.
    const main = await node.getMainComponentAsync()
    if (main) return normalise(main)
  }

  let cursor: BaseNode | null = node
  while (cursor) {
    if (cursor.type === 'COMPONENT' || cursor.type === 'COMPONENT_SET') {
      return normalise(cursor)
    }
    if (cursor.type === 'PAGE' || cursor.type === 'DOCUMENT') return null
    cursor = cursor.parent
  }

  return null
}

/**
 * Every documentable component reachable from one selected node.
 *
 * Walks *up* first — selecting a variant or an instance means its component.
 * Only if that finds nothing does it look *down*, so selecting a section or a
 * frame means the components inside it. That covers both "I picked five
 * components" and "I picked the section they live in".
 */
async function componentsUnder(node: SceneNode): Promise<DocumentableComponent[]> {
  if (node.type === 'INSTANCE') {
    const main = await node.getMainComponentAsync()
    if (main) return [main]
  }

  let cursor: BaseNode | null = node
  while (cursor) {
    if (cursor.type === 'COMPONENT' || cursor.type === 'COMPONENT_SET') {
      return [cursor]
    }
    if (cursor.type === 'PAGE' || cursor.type === 'DOCUMENT') break
    cursor = cursor.parent
  }

  if ('findAllWithCriteria' in node) {
    return node.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] }).filter(isDocumentable)
  }
  return []
}

const STYLE_FIELDS = [
  'fillStyleId',
  'strokeStyleId',
  'effectStyleId',
  'gridStyleId',
  'textStyleId',
] as const

const STYLE_KIND: Record<string, EntityKind> = {
  PAINT: 'paintStyle',
  TEXT: 'textStyle',
  EFFECT: 'effectStyle',
  GRID: 'paintStyle', // grid styles are not documented separately
}

/**
 * The styles and variables one layer uses.
 *
 * Figma does not tell plugins what is selected in the Variables or Styles
 * panels — `figma.currentPage.selection` is scene nodes only. Reading them off
 * a selected layer is the closest available thing, and covers the case that
 * matters: click a shape, document the colour it is painted with.
 *
 * Only the node itself is inspected, not its descendants — selecting a frame
 * would otherwise pull in every token on every child.
 */
async function tokensUsedBy(node: SceneNode): Promise<Array<{ id: string; kind: EntityKind }>> {
  const found: Array<{ id: string; kind: EntityKind }> = []

  for (const field of STYLE_FIELDS) {
    if (!(field in node)) continue
    const value = (node as unknown as Record<string, unknown>)[field]
    // Text with more than one style applied reports `figma.mixed`.
    if (typeof value !== 'string' || !value) continue

    const style = await figma.getStyleByIdAsync(value)
    const kind = style ? STYLE_KIND[style.type] : undefined
    if (style && kind) found.push({ id: style.id, kind })
  }

  const bound = (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables
  if (bound) {
    for (const key of Object.keys(bound)) {
      const value = bound[key]
      const aliases = Array.isArray(value) ? value : [value]
      for (const alias of aliases) {
        const id = (alias as VariableAlias | undefined)?.id
        if (!id) continue
        const variable = await figma.variables.getVariableByIdAsync(id)
        if (variable) found.push({ id: variable.id, kind: 'variable' })
      }
    }
  }

  return found
}

/**
 * Resolves the whole selection into documentable things.
 *
 * Components win: if the selection contains any, you get those and nothing
 * else, so selecting a button opens the button rather than a picker listing
 * every token it happens to use. Only when there are no components does this
 * fall through to the styles and variables the selected layers are painted
 * with. Deduplicated by id throughout.
 */
export async function resolveSelectionBatch(): Promise<BatchTarget[]> {
  const components = new Map<string, BatchTarget>()

  for (const node of figma.currentPage.selection) {
    for (const component of await componentsUnder(node)) {
      const normalised = normalise(component)
      if (components.has(normalised.entityId)) continue

      // normalise() may have hopped to a parent set, so re-read the owner.
      const owner =
        component.type === 'COMPONENT' && component.parent?.type === 'COMPONENT_SET'
          ? component.parent
          : component

      components.set(normalised.entityId, {
        ...normalised,
        noteCount: liveNoteCount(readLog(owner)),
      })
    }
  }

  if (components.size > 0) {
    const targets = Array.from(components.values())
    targets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    return targets
  }

  const tokens = new Map<string, BatchTarget>()
  for (const node of figma.currentPage.selection) {
    for (const { id, kind } of await tokensUsedBy(node)) {
      if (tokens.has(id)) continue
      const resolved = await resolveEntity(id, kind)
      if (!resolved) continue
      tokens.set(id, {
        entityId: id,
        entityKind: kind,
        name: resolved.name,
        noteCount: liveNoteCount(readLog(resolved.host)),
      })
    }
  }

  const targets = Array.from(tokens.values())
  targets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return targets
}

/** Selects and zooms to an entity on canvas, where it has a canvas presence. */
export async function revealNode(entityId: string): Promise<void> {
  const node = await figma.getNodeByIdAsync(entityId)
  if (!node || !('type' in node)) return

  const page = pageOf(node)
  if (!page) return

  if (page !== figma.currentPage) await figma.setCurrentPageAsync(page)
  const scene = node as SceneNode
  figma.currentPage.selection = [scene]
  figma.viewport.scrollAndZoomIntoView([scene])
}

function pageOf(node: BaseNode): PageNode | null {
  let cursor: BaseNode | null = node
  while (cursor) {
    if (cursor.type === 'PAGE') return cursor
    cursor = cursor.parent
  }
  return null
}
