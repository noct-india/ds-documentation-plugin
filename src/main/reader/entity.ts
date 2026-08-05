// Resolving an (entityId, entityKind) pair back to the live Figma object.
//
// Notes are anchored to ids rather than names or paths, so renaming a variable
// or reshuffling a folder never orphans its documentation.

import type { EntityKind, EntityStructure } from '../../shared/types'
import { folderKeyPrefix, folderName, parseFolderId } from '../../shared/folder'
import { scopedHost, type PluginDataHost } from '../storage'
import { componentStructure } from './components'
import { styleStructure, type StyleKind } from './styles'
import { collectionStructure, variableStructure } from './variables'

export interface ResolvedEntity {
  host: PluginDataHost
  name: string
  structure: EntityStructure
}

const STYLE_KINDS: EntityKind[] = ['paintStyle', 'textStyle', 'effectStyle']

/**
 * Does this entity still exist?
 *
 * Orphan detection runs over every documented entity each time the home screen
 * loads, so it must not go through `resolveEntity` — that builds the full
 * structure, which for a variable means resolving its collection and formatting
 * every mode value, alias lookups included. Open time would grow with how much
 * of the system you had documented, which is precisely backwards.
 */
export async function entityExists(
  entityId: string,
  entityKind: EntityKind
): Promise<boolean> {
  // A switch rather than an if-chain, so adding a kind fails the typecheck here
  // instead of silently falling through. Pages, sections and folders were all
  // reported as deleted because they landed in a component-only fallback.
  switch (entityKind) {
    case 'project':
      return true

    case 'folder': {
      const ref = parseFolderId(entityId)
      if (!ref) return false
      // A folder is derived from names, so it has no object to look up. Its
      // notes live on the collection (or the document for style groups), and
      // stay reachable as long as that host does.
      if (ref.scope.indexOf('VariableCollectionId') === 0) {
        return (await figma.variables.getVariableCollectionByIdAsync(ref.scope)) !== null
      }
      return true
    }

    case 'variable':
      return (await figma.variables.getVariableByIdAsync(entityId)) !== null

    case 'collection':
      return (await figma.variables.getVariableCollectionByIdAsync(entityId)) !== null

    case 'paintStyle':
    case 'textStyle':
    case 'effectStyle':
      return (await figma.getStyleByIdAsync(entityId)) !== null

    case 'page':
      return (await figma.getNodeByIdAsync(entityId))?.type === 'PAGE'

    case 'section':
      return (await figma.getNodeByIdAsync(entityId))?.type === 'SECTION'

    case 'component':
    case 'componentSet': {
      const node = await figma.getNodeByIdAsync(entityId)
      return node?.type === 'COMPONENT' || node?.type === 'COMPONENT_SET'
    }

    case 'variant': {
      // A variant is a component *inside a set*. Checking the parent matters:
      // pulling a variant out of its set makes it an ordinary component, and
      // its notes should then be reported as orphaned rather than silently
      // shown against something that is no longer a variant of anything.
      const node = await figma.getNodeByIdAsync(entityId)
      return node?.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET'
    }

    default: {
      const exhaustive: never = entityKind
      void exhaustive
      return false
    }
  }
}

/** Returns null when the underlying object has been deleted — an orphan. */
export async function resolveEntity(
  entityId: string,
  entityKind: EntityKind
): Promise<ResolvedEntity | null> {
  if (entityKind === 'folder') {
    const ref = parseFolderId(entityId)
    if (!ref) return null

    // Variable folders hang off their collection, which keeps them with the
    // thing they describe. Style folders have no container object, so the
    // document is the only host available.
    const collection = await figma.variables.getVariableCollectionByIdAsync(ref.scope)
    const host = collection ?? figma.root
    const label = collection ? `folder in ${collection.name}` : `${ref.scope} folder`

    return {
      host: scopedHost(host, folderKeyPrefix(ref)),
      name: folderName(ref.path),
      structure: {
        typeLabel: label,
        parentName: collection?.name,
        structureTree: ref.path,
      },
    }
  }

  if (entityKind === 'project') {
    return {
      host: figma.root,
      name: figma.root.name,
      structure: { typeLabel: 'Project guidelines' },
    }
  }

  if (entityKind === 'variable') {
    const variable = await figma.variables.getVariableByIdAsync(entityId)
    if (!variable) return null
    return {
      host: variable,
      name: variable.name,
      structure: await variableStructure(variable),
    }
  }

  if (entityKind === 'collection') {
    const collection = await figma.variables.getVariableCollectionByIdAsync(entityId)
    if (!collection) return null
    return {
      host: collection,
      name: collection.name,
      structure: await collectionStructure(collection),
    }
  }

  if (STYLE_KINDS.indexOf(entityKind) !== -1) {
    const style = await figma.getStyleByIdAsync(entityId)
    if (!style) return null
    return {
      host: style,
      name: style.name,
      structure: await styleStructure(style, entityKind as StyleKind),
    }
  }

  if (entityKind === 'variant') {
    const node = await figma.getNodeByIdAsync(entityId)
    if (!node || node.type !== 'COMPONENT' || node.parent?.type !== 'COMPONENT_SET') return null
    const set = node.parent

    return {
      host: node,
      name: node.name,
      structure: {
        typeLabel: `Variant of ${set.name}`,
        parentName: set.name,
        description: node.description || undefined,
        // The combination itself, so the rendered markdown states which variant
        // a rule belongs to rather than leaving it to the heading alone.
        variants: [
          {
            id: node.id,
            name: node.name,
            properties: node.variantProperties ?? {},
          },
        ],
      },
    }
  }

  if (entityKind === 'page' || entityKind === 'section') {
    const node = await figma.getNodeByIdAsync(entityId)
    if (!node) return null
    if (entityKind === 'page' && node.type !== 'PAGE') return null
    if (entityKind === 'section' && node.type !== 'SECTION') return null
    return {
      host: node,
      name: node.name,
      structure: {
        typeLabel: entityKind === 'page' ? 'Page' : 'Section',
        parentName: node.parent && 'name' in node.parent ? node.parent.name : undefined,
      },
    }
  }

  // component | componentSet
  const node = await figma.getNodeByIdAsync(entityId)
  if (!node || (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET')) return null
  return {
    host: node,
    name: node.name,
    structure: await componentStructure(node),
  }
}
