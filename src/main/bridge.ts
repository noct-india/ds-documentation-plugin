// Assembling what Claude needs to draft useful documentation.
//
// Suggestion quality is almost entirely a function of context. A property table
// alone yields generic advice; the same table plus the component's picture, its
// siblings, and the rules already written elsewhere in the system yields advice
// that is specific to *this* design system.

import type { BridgeItem, BridgeRequestContext, EntityKind, SectionKey } from '../shared/types'
import { migrateSection } from '../shared/types'
import { ancestorPaths, folderId, folderName } from '../shared/folder'
import { readBrief, readLog } from './storage'
import { resolveEntity } from './reader/entity'
import { getCollections, variablesIn } from './reader/variables'
import { getStyles } from './reader/styles'
import { allComponents } from './reader/components'

/** Cap on the PNG sent per component — enough to read a control, not a screenshot. */
const IMAGE_MAX_PX = 320

/**
 * A picture of the component.
 *
 * For anything visual this is worth more than its property table: it shows
 * density, shape, weight and hierarchy, none of which are inferable from names.
 * Only the first variant of a set is exported — 176 near-identical images would
 * cost a great deal and say almost nothing extra.
 */
async function exportImage(node: ComponentNode | ComponentSetNode): Promise<string | undefined> {
  const target = node.type === 'COMPONENT_SET' ? (node.children[0] ?? node) : node
  if (!('exportAsync' in target)) return undefined

  const width = 'width' in target ? target.width : IMAGE_MAX_PX
  const scale = width > 0 ? Math.min(2, IMAGE_MAX_PX / width) : 1

  try {
    const bytes = await target.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: Math.max(0.25, scale) },
    })
    return figma.base64Encode(bytes)
  } catch (err) {
    // A component that cannot be rasterised should not sink the whole request.
    console.error('[dsdoc] could not export image', err)
    return undefined
  }
}

function notesOf(host: { getPluginData(key: string): string }): BridgeItem['existingNotes'] {
  return readLog(host as Parameters<typeof readLog>[0])
    .filter((e) => !e.deleted)
    .map((e) => ({
      section: migrateSection(e.section) as SectionKey,
      text: e.text,
      draft: e.draft === true,
    }))
}

/**
 * Everything the whole file offers, sent once per request.
 *
 * This is what lets a suggestion say "for navigation use `Link`" and have
 * `Link` actually exist — without the catalogue a model invents plausible
 * component names, which is the single worst failure mode here.
 */
async function buildContext(): Promise<BridgeRequestContext> {
  const collections = await getCollections()
  const componentNames: string[] = []

  for (const { component } of await allComponents()) {
    componentNames.push(component.name)
    if (componentNames.length >= 400) break
  }

  return {
    fileName: figma.root.name,
    brief: readBrief(),
    projectNotes: notesOf(figma.root),
    collections: collections.map((c) => ({
      name: c.name,
      modes: c.modes.map((m) => m.name),
      variableCount: c.variableIds.length,
    })),
    styleGroups: {
      color: (await getStyles('paintStyle')).map((s) => s.name).slice(0, 300),
      text: (await getStyles('textStyle')).map((s) => s.name).slice(0, 200),
      effect: (await getStyles('effectStyle')).map((s) => s.name).slice(0, 100),
    },
    componentNames,
  }
}

/**
 * The chain of containers a token sits inside, with what has been written about
 * each — the collection, then every folder above it, outermost first.
 *
 * Without this a draft only ever sees a leaf name. With it, a variable inside
 * "Interaction" in a collection documented as "aliases, never referenced
 * directly" gets advice that follows from both.
 */
async function ancestryOf(
  entityId: string,
  kind: EntityKind
): Promise<BridgeItem['ancestry']> {
  const chain: NonNullable<BridgeItem['ancestry']> = []

  const add = async (scope: string, path: string, label: string) => {
    const resolved = await resolveEntity(folderId({ scope, path }), 'folder')
    if (!resolved) return
    const notes = notesOf(resolved.host)
      .filter((n) => !n.draft)
      .map((n) => ({ section: n.section, text: n.text }))
    chain.push({ name: folderName(path), kind: label, notes })
  }

  if (kind === 'variable') {
    const variable = await figma.variables.getVariableByIdAsync(entityId)
    if (!variable) return undefined
    const collection = await figma.variables.getVariableCollectionByIdAsync(
      variable.variableCollectionId
    )
    if (collection) {
      chain.push({
        name: collection.name,
        kind: 'variable collection',
        notes: notesOf(collection)
          .filter((n) => !n.draft)
          .map((n) => ({ section: n.section, text: n.text })),
      })
      // Everything above the leaf: "a/b/c" contributes "a" and "a/b".
      const segments = variable.name.split('/').filter(Boolean)
      for (const path of ancestorPaths(segments.slice(0, -1).join('/'))) {
        await add(collection.id, path, 'folder')
      }
    }
  }

  if (kind === 'component' || kind === 'componentSet') {
    // A component's containers are real nodes: the section it sits in, and the
    // page that holds it. Both can carry rules that apply to everything inside.
    const node = await figma.getNodeByIdAsync(entityId)
    const chainUp: Array<{ name: string; kind: string; host: BaseNode }> = []
    let cursor: BaseNode | null = node?.parent ?? null
    while (cursor) {
      if (cursor.type === 'SECTION') chainUp.push({ name: cursor.name, kind: 'section', host: cursor })
      if (cursor.type === 'PAGE') {
        chainUp.push({ name: cursor.name, kind: 'page', host: cursor })
        break
      }
      cursor = cursor.parent
    }
    // Outermost first, so the page's rules are read before the section's.
    for (const level of chainUp.reverse()) {
      chain.push({
        name: level.name,
        kind: level.kind,
        notes: notesOf(level.host as unknown as { getPluginData(key: string): string })
          .filter((n) => !n.draft)
          .map((n) => ({ section: n.section, text: n.text })),
      })
    }
  }

  if (kind === 'paintStyle' || kind === 'textStyle' || kind === 'effectStyle') {
    const style = await figma.getStyleByIdAsync(entityId)
    if (style) {
      const segments = style.name.split('/').filter(Boolean)
      for (const path of ancestorPaths(segments.slice(0, -1).join('/'))) {
        await add(kind, path, 'folder')
      }
    }
  }

  return chain.length > 0 ? chain : undefined
}

/** Sibling names within the same collection or style group, for contrast. */
async function siblingsOf(entityId: string, kind: EntityKind): Promise<string[] | undefined> {
  if (kind === 'variable') {
    for (const collection of await getCollections()) {
      const variables = await variablesIn(collection)
      if (variables.some((v) => v.id === entityId)) {
        return variables.map((v) => v.name).slice(0, 200)
      }
    }
  }
  return undefined
}

export interface BuildOptions {
  targets: Array<{ entityId: string; entityKind: EntityKind }>
  includeImages: boolean
  onProgress?: (done: number, total: number) => void
}

export async function buildBridgeRequest(
  options: BuildOptions
): Promise<{ items: BridgeItem[]; context: BridgeRequestContext }> {
  const context = await buildContext()
  const items: BridgeItem[] = []

  for (let i = 0; i < options.targets.length; i++) {
    const target = options.targets[i]
    const resolved = await resolveEntity(target.entityId, target.entityKind)
    if (!resolved) continue

    const structure = resolved.structure
    const item: BridgeItem = {
      entityId: target.entityId,
      entityKind: target.entityKind,
      name: resolved.name,
      typeLabel: structure.typeLabel,
      description: structure.description,
      parentName: structure.parentName,
      modes: structure.modes,
      values: structure.modeValues,
      properties: structure.properties,
      variantCount: structure.variantCount,
      nests: structure.nestedComponents,
      existingNotes: notesOf(resolved.host),
      siblings: await siblingsOf(target.entityId, target.entityKind),
      ancestry: await ancestryOf(target.entityId, target.entityKind),
    }

    if (
      options.includeImages &&
      (target.entityKind === 'component' || target.entityKind === 'componentSet')
    ) {
      const node = await figma.getNodeByIdAsync(target.entityId)
      if (node && (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET')) {
        item.imagePng = await exportImage(node)
      }
    }

    items.push(item)
    options.onProgress?.(i + 1, options.targets.length)
  }

  return { items, context }
}
