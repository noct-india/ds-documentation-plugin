// Reading variable collections and variables.
//
// Everything here uses the async API — `documentAccess: "dynamic-page"` is
// mandatory for new plugins and the synchronous getters throw under it.

import type {
  EntityStructure,
  ListItem,
  Preview,
  TreeNode,
  VariableModeValue,
} from '../../shared/types'
import { liveNoteCount, readLog, scopedHost } from '../storage'
import { ancestorPaths, folderKeyPrefix } from '../../shared/folder'
import {
  buildTree,
  renderTreeOutline,
  type FolderNotes,
  type TreeInput,
} from '../../shared/tree'
import { cssColor } from './paint'

/** Cached per session — collections rarely change mid-session and this is hot. */
let collectionCache: VariableCollection[] | null = null
let variableCache: Variable[] | null = null

export async function getCollections(): Promise<VariableCollection[]> {
  if (!collectionCache) {
    collectionCache = await figma.variables.getLocalVariableCollectionsAsync()
  }
  return collectionCache
}

/**
 * Every local variable, in one call.
 *
 * Resolving a collection's `variableIds` one id at a time means an async lookup
 * per variable — on a 500-variable system that is 500 round-trips every time the
 * home screen recalculates coverage. Fetching the whole set once and filtering
 * in memory is a single call.
 */
async function getAllVariables(): Promise<Variable[]> {
  if (!variableCache) {
    variableCache = await figma.variables.getLocalVariablesAsync()
  }
  return variableCache
}

export function invalidateVariableCache(): void {
  collectionCache = null
  variableCache = null
}

export async function listCollections(): Promise<ListItem[]> {
  const collections = await getCollections()
  const items: ListItem[] = []

  for (const collection of collections) {
    const variables = await variablesIn(collection)
    const documented = variables.filter((v) => liveNoteCount(readLog(v)) > 0).length
    const modeSuffix =
      collection.modes.length > 1 ? ` · ${collection.modes.length} modes` : ''
    items.push({
      id: collection.id,
      name: collection.name,
      detail: `${variables.length} variable${variables.length === 1 ? '' : 's'}${modeSuffix} · ${documented} documented`,
      noteCount: liveNoteCount(readLog(collection)),
      entityKind: 'collection' as const,
    })
  }

  // Left in the order Figma returns them, which is the order they appear in the
  // Variables panel.
  return items
}

/** The variables belonging to one collection, in the collection's own order. */
export async function variablesIn(collection: VariableCollection): Promise<Variable[]> {
  const all = await getAllVariables()
  const byId = new Map(all.map((v) => [v.id, v]))
  // Walk variableIds rather than filtering `all` so ordering matches Figma's.
  return collection.variableIds
    .map((id) => byId.get(id))
    .filter((v): v is Variable => v !== undefined)
}

/**
 * Follows an alias chain to the colour actually painted.
 *
 * Semantic tokens usually point at other tokens, sometimes several hops deep,
 * so a swatch needs the resolved value rather than the first alias. Runs
 * against the cached variable map, so this stays synchronous no matter how many
 * variables the list holds.
 */
function resolveColor(
  value: VariableValue,
  byId: Map<string, Variable>,
  modeId: string,
  depth = 0
): RGBA | null {
  if (depth > 8) return null // a cycle, or deeper nesting than is worth drawing

  if (isAlias(value)) {
    const target = byId.get(value.id)
    if (!target) return null
    // The target may sit in another collection whose modes are different, so
    // fall back to its first mode rather than giving up.
    const modeValues = target.valuesByMode
    const next = modeValues[modeId] ?? Object.keys(modeValues).map((k) => modeValues[k])[0]
    return next === undefined ? null : resolveColor(next, byId, modeId, depth + 1)
  }

  if (typeof value === 'object' && value !== null && 'r' in value) return value as RGBA
  return null
}

/** Swatches for a colour variable — one per mode, in the collection's order. */
async function variablePreview(
  variable: Variable,
  collection: VariableCollection
): Promise<{ preview?: Preview; detail?: string }> {
  if (variable.resolvedType !== 'COLOR') {
    // Numbers, strings and booleans have no visual form, so show the value.
    const first = variable.valuesByMode[collection.modes[0]?.modeId]
    return { detail: first === undefined ? undefined : await formatValue(first) }
  }

  const all = await getAllVariables()
  const byId = new Map(all.map((v) => [v.id, v]))

  const values: string[] = []
  for (const mode of collection.modes) {
    const raw = variable.valuesByMode[mode.modeId]
    const color = raw === undefined ? null : resolveColor(raw, byId, mode.modeId)
    values.push(color ? cssColor(color) : 'transparent')
  }

  return values.length > 0 ? { preview: { kind: 'color', values } } : {}
}

export async function getCollectionTree(collectionId: string): Promise<TreeNode[]> {
  const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId)
  if (!collection) return []

  const variables = await variablesIn(collection)
  const inputs: TreeInput[] = []
  for (const variable of variables) {
    const { preview, detail } = await variablePreview(variable, collection)
    inputs.push({
      entityId: variable.id,
      entityKind: 'variable',
      name: variable.name,
      noteCount: liveNoteCount(readLog(variable)),
      preview,
      detail,
    })
  }
  // Folder notes live on the collection, so they travel with it.
  const folderNotes: FolderNotes = {}
  for (const variable of variables) {
    const segments = variable.name.split('/').filter(Boolean)
    for (const path of ancestorPaths(segments.slice(0, -1).join('/'))) {
      if (folderNotes[path] !== undefined) continue
      const host = scopedHost(collection, folderKeyPrefix({ scope: collection.id, path }))
      folderNotes[path] = liveNoteCount(readLog(host))
    }
  }

  return buildTree(inputs, collection.id, folderNotes)
}

// ─── Value formatting ────────────────────────────────────────────────────────

function toHex(color: RGB | RGBA): string {
  const channel = (n: number) =>
    Math.round(Math.max(0, Math.min(1, n)) * 255)
      .toString(16)
      .padStart(2, '0')
  const base = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase()
  const alpha = 'a' in color ? color.a : 1
  return alpha < 1 ? `${base} ${Math.round(alpha * 100)}%` : base
}

function isAlias(value: VariableValue): value is VariableAlias {
  return typeof value === 'object' && value !== null && (value as VariableAlias).type === 'VARIABLE_ALIAS'
}

/**
 * Renders one mode's value for display and export.
 *
 * Aliases resolve to the target's name rather than its colour: for a semantic
 * token, "→ color/blue/500" is the fact worth documenting, not the hex it
 * happens to point at today.
 */
export async function formatValue(value: VariableValue): Promise<string> {
  if (isAlias(value)) {
    const target = await figma.variables.getVariableByIdAsync(value.id)
    return target ? `→ \`${target.name}\`` : '→ (unresolved alias)'
  }
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && 'r' in value) {
    return `\`${toHex(value as RGBA)}\``
  }
  return String(value)
}

export async function variableStructure(variable: Variable): Promise<EntityStructure> {
  const collection = await figma.variables.getVariableCollectionByIdAsync(
    variable.variableCollectionId
  )

  const modeValues: VariableModeValue[] = []
  if (collection) {
    for (const mode of collection.modes) {
      const raw = variable.valuesByMode[mode.modeId]
      modeValues.push({
        modeName: mode.name,
        value: raw === undefined ? '—' : await formatValue(raw),
      })
    }
  }

  return {
    typeLabel: variable.resolvedType,
    description: variable.description || undefined,
    modeValues,
    parentName: collection?.name,
    preview: collection ? (await variablePreview(variable, collection)).preview : undefined,
  }
}

export async function collectionStructure(
  collection: VariableCollection
): Promise<EntityStructure> {
  const variables = await variablesIn(collection)
  const tree = buildTree(
    variables.map((v) => ({
      entityId: v.id,
      entityKind: 'variable' as const,
      name: v.name,
      noteCount: 0,
    }))
  )

  return {
    typeLabel: 'Variable collection',
    modes: collection.modes.map((m) => m.name),
    childCount: variables.length,
    structureTree: renderTreeOutline(tree),
  }
}
