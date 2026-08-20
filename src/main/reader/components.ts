// Reading components as the designer arranged them: pages → sections → components.
//
// Loading is deliberately lazy. `figma.root.children` hands back every page
// without touching its contents, but a page's `.children` throws until
// `loadAsync()` has run — and `loadAllPagesAsync()` is documented as slow on
// large files. So pages list instantly and a page's contents load only when
// opened. The one full sweep happens on export, where a pause is expected.

import type {
  ComponentProperty,
  EntityStructure,
  ListItem,
  VariantRef,
} from '../../shared/types'
import {
  draftCount,
  liveNoteCount,
  planVariantMigration,
  readIndex,
  readLog,
  replaceLog,
  updateIndex,
} from '../storage'

/** Components sitting directly on a page rather than inside a section. */
export const UNGROUPED_ID = '__ungrouped__'
export const UNGROUPED_NAME = 'Ungrouped'

type DocumentableComponent = ComponentNode | ComponentSetNode

interface PageContents {
  sections: Array<{
    id: string
    name: string
    components: DocumentableComponent[]
    node: SectionNode | PageNode
  }>
}

const pageCache = new Map<string, PageContents>()

export function invalidateComponentCache(): void {
  pageCache.clear()
}

/**
 * Pages that actually hold components.
 *
 * Knowing which ones do means loading them, so this pays for a single
 * `loadAllPagesAsync()` up front rather than listing every page in the file.
 * A design system's pages are mostly archives, scratch and test surfaces —
 * showing all of them buries the handful that matter.
 *
 * The cost lands once per session; `pageCache` covers every later call.
 */
export async function listPages(
  onProgress?: (done: number, total: number) => void
): Promise<ListItem[]> {
  await figma.loadAllPagesAsync()

  const pages = figma.root.children
  const items: ListItem[] = []

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const contents = await loadPage(page.id)
    onProgress?.(i + 1, pages.length)
    if (!contents) continue

    const count = countComponents(contents)
    if (count === 0) continue

    items.push({
      id: page.id,
      name: page.name,
      detail: `${count} component${count === 1 ? '' : 's'}`,
      entityKind: 'page',
      noteCount: liveNoteCount(readLog(page)),
    })
  }

  return items
}

function countComponents(contents: PageContents): number {
  return contents.sections.reduce((n, s) => n + s.components.length, 0)
}

/**
 * A component set is the documentation unit — a designer reasons about "Button",
 * not about "Button/Primary/28/Hover". So variants inside a set are skipped and
 * only the set itself is listed.
 */
export function isDocumentable(node: SceneNode): node is DocumentableComponent {
  if (node.type === 'COMPONENT_SET') return true
  if (node.type === 'COMPONENT') return node.parent?.type !== 'COMPONENT_SET'
  return false
}

async function loadPage(pageId: string): Promise<PageContents | null> {
  const cached = pageCache.get(pageId)
  if (cached) return cached

  const page = figma.root.children.find((p) => p.id === pageId)
  if (!page) return null
  await page.loadAsync()

  const sections: PageContents['sections'] = []
  const ungrouped: DocumentableComponent[] = []

  for (const child of page.children) {
    if (child.type === 'SECTION') {
      // findAllWithCriteria reaches components nested in sub-sections and frames.
      const found = child
        .findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] })
        .filter(isDocumentable)
      // A section with nothing in it is not somewhere to document.
      if (found.length > 0) {
        sections.push({ id: child.id, name: child.name, components: found, node: child })
      }
    } else if (isDocumentable(child)) {
      ungrouped.push(child)
    } else if ('findAllWithCriteria' in child) {
      // Components inside plain frames/groups still need to be reachable.
      const found = child
        .findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] })
        .filter(isDocumentable)
      ungrouped.push(...found)
    }
  }

  if (ungrouped.length > 0) {
    sections.push({ id: UNGROUPED_ID, name: UNGROUPED_NAME, components: ungrouped, node: page })
  }

  const contents: PageContents = { sections }
  pageCache.set(pageId, contents)
  return contents
}

export async function listSections(pageId: string): Promise<ListItem[]> {
  const contents = await loadPage(pageId)
  if (!contents) return []

  return contents.sections.map((section) => {
    const documented = section.components.filter((c) => liveNoteCount(readLog(c)) > 0).length
    // The synthetic "Ungrouped" bucket is not a real node, so it cannot hold
    // notes of its own.
    const real = section.id !== UNGROUPED_ID
    return {
      id: section.id,
      name: section.name,
      detail: `${section.components.length} component${section.components.length === 1 ? '' : 's'} · ${documented} documented`,
      entityKind: real ? ('section' as const) : undefined,
      noteCount: real ? liveNoteCount(readLog(section.node)) : undefined,
    }
  })
}

export async function listComponents(pageId: string, sectionId: string): Promise<ListItem[]> {
  const contents = await loadPage(pageId)
  const section = contents?.sections.find((s) => s.id === sectionId)
  if (!section) return []

  // Read once for the whole list. Checking each variant's plugin data directly
  // would mean thousands of reads to answer a question about a subtitle.
  const index = readIndex()

  return section.components
    .map((component) => {
      const parts: string[] = []
      if (component.type === 'COMPONENT_SET') {
        parts.push(`${component.children.length} variants`)
        // Notes written about single combinations. Worth surfacing, or they are
        // only discoverable by stepping through the picker one variant at a time.
        const documented = component.children.filter(
          (child) => (index[child.id]?.noteCount ?? 0) > 0
        ).length
        if (documented > 0) parts.push(`${documented} documented`)
      } else {
        parts.push('single')
      }

      return {
        id: component.id,
        name: component.name,
        detail: parts.join(' · '),
        noteCount: liveNoteCount(readLog(component)),
        entityKind:
          component.type === 'COMPONENT_SET' ? ('componentSet' as const) : ('component' as const),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/** Every documentable component in the file. Used only by export. */
export async function allComponents(): Promise<
  Array<{ page: string; section: string; component: DocumentableComponent }>
> {
  const out: Array<{ page: string; section: string; component: DocumentableComponent }> = []
  for (const page of figma.root.children) {
    const contents = await loadPage(page.id)
    if (!contents) continue
    for (const section of contents.sections) {
      for (const component of section.components) {
        out.push({ page: page.name, section: section.name, component })
      }
    }
  }
  return out
}

// ─── Introspection ───────────────────────────────────────────────────────────

function readProperties(node: DocumentableComponent): ComponentProperty[] {
  let definitions: ComponentPropertyDefinitions
  try {
    definitions = node.componentPropertyDefinitions
  } catch {
    // A component inside a set exposes definitions only on the set itself.
    return []
  }

  return Object.entries(definitions).map(([key, definition]) => ({
    // The full key carries a "#0:0" suffix on BOOLEAN/TEXT/INSTANCE_SWAP props,
    // which disambiguates two properties sharing a display name. It is the
    // identity — only the prefix is safe to show.
    key,
    displayName: key.split('#')[0],
    type: definition.type,
    defaultValue: String(definition.defaultValue),
    options: definition.variantOptions ? [...definition.variantOptions] : undefined,
    // Free documentation: whatever the designer already typed into Figma's own
    // property description field.
    description: definition.description || undefined,
  }))
}

/**
 * Names of components instanced inside this one — useful composition context
 * for an agent building the UI kit ("Button nests Icon and Spinner").
 *
 * Only the first variant is walked: a 176-variant set would otherwise mean
 * hundreds of async main-component lookups for the same handful of answers.
 */
async function readNestedComponents(node: DocumentableComponent): Promise<string[]> {
  const sample = node.type === 'COMPONENT_SET' ? node.children[0] : node
  if (!sample || !('findAllWithCriteria' in sample)) return []

  const instances = sample.findAllWithCriteria({ types: ['INSTANCE'] }).slice(0, 40)
  const names = new Set<string>()
  for (const instance of instances) {
    const main = await instance.getMainComponentAsync()
    if (!main) continue
    // Report the set name where there is one — "Icon", not "Icon/chevron/16".
    const owner = main.parent?.type === 'COMPONENT_SET' ? main.parent.name : main.name
    names.add(owner)
  }
  return [...names].sort()
}

/**
 * Every variant, with the combination it stands for.
 *
 * Reading `variantProperties` off each child is cheap — no exports, no async —
 * so even a 176-variant set costs almost nothing. `variantProperties` carries a
 * deprecation marker in the typings, but its replacement is an *instance* API
 * that does not apply to a variant sitting inside a set. The node's own name
 * ("Size=36, Type=Primary") is the fallback if it is ever withdrawn.
 */
function readVariants(node: DocumentableComponent): VariantRef[] | undefined {
  if (node.type !== 'COMPONENT_SET') return undefined

  const variants: VariantRef[] = []
  for (const child of node.children) {
    if (child.type !== 'COMPONENT') continue
    variants.push({
      id: child.id,
      name: child.name,
      properties: child.variantProperties ?? parseVariantName(child.name),
    })
  }
  return variants.length > 0 ? variants : undefined
}

/** "Size=36, Type=Primary" → { Size: "36", Type: "Primary" }. */
function parseVariantName(name: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of name.split(',')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim()
  }
  return out
}

export async function componentStructure(
  node: DocumentableComponent
): Promise<EntityStructure> {
  const properties = readProperties(node)
  const nested = await readNestedComponents(node)

  return {
    typeLabel: node.type === 'COMPONENT_SET' ? 'Component set' : 'Component',
    description: node.description || undefined,
    properties,
    variantCount: node.type === 'COMPONENT_SET' ? node.children.length : 1,
    variants: readVariants(node),
    nestedComponents: nested.length > 0 ? nested : undefined,
    parentName: node.parent?.type === 'SECTION' ? node.parent.name : undefined,
  }
}

/**
 * Brings any per-variant notes in a set up onto the set as scoped notes.
 *
 * Runs when a component is opened and again on export, so a file migrates the
 * first time anyone looks at it and nobody has to be told. Almost always does
 * nothing: the index is consulted first, so an untouched set costs a handful of
 * map lookups rather than a plugin-data read per variant.
 */
export function migrateVariantNotes(node: DocumentableComponent): number {
  if (node.type !== 'COMPONENT_SET') return 0

  const index = readIndex()
  const carriers = node.children.filter(
    (child) => child.type === 'COMPONENT' && (index[child.id]?.noteCount ?? 0) > 0
  ) as ComponentNode[]
  if (carriers.length === 0) return 0

  let moved = 0
  for (const variant of carriers) {
    const variantLog = readLog(variant)
    if (variantLog.length === 0) continue

    const scope = variant.variantProperties ?? {}
    const plan = planVariantMigration(readLog(node), variantLog, scope)
    if (plan.moved === 0) {
      // Nothing new to carry, but the variant is still holding a copy.
      replaceLog(variant, 'variant', variant.name, [])
      updateIndex(variant.id, 'variant', variant.name, 0)
      continue
    }

    // Write to the set first, and read it back before clearing the variant —
    // a note must never exist in neither place.
    replaceLog(node, 'componentSet', node.name, plan.merged)
    const confirmed = new Set(readLog(node).map((entry) => entry.id))
    const carried = variantLog.every((entry) => confirmed.has(entry.id))
    if (!carried) {
      console.error('[dsdoc] variant migration did not land; leaving', variant.name, 'as it was')
      continue
    }

    replaceLog(variant, 'variant', variant.name, [])
    updateIndex(variant.id, 'variant', variant.name, 0)
    moved += plan.moved
  }

  if (moved > 0) {
    const log = readLog(node)
    updateIndex(node.id, 'componentSet', node.name, liveNoteCount(log), draftCount(log))
    console.log('[dsdoc] moved', moved, 'variant note(s) onto', node.name)
  }
  return moved
}
