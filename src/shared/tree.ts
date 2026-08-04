// Folder-tree parsing.
//
// Figma has no folder object for variables or styles — grouping is purely the
// "/" characters in a name ("illustration/spot/blue"). The Assets and Variables
// panels just do prefix matching on that string. So we reconstruct the tree the
// designer sees by splitting names ourselves.
//
// Notes are always anchored to the entity id, never to a derived path, so
// renaming a group reshuffles the navigation without orphaning anything.

import type { EntityKind, Preview, TreeFolder, TreeLeaf, TreeNode } from './types'
import { folderId } from './folder'

/** Notes written about a folder itself, keyed by its path. */
export type FolderNotes = Record<string, number>

export interface TreeInput {
  entityId: string
  entityKind: EntityKind
  /** Raw Figma name, "/" separators intact. */
  name: string
  noteCount: number
  preview?: Preview
  detail?: string
}

/**
 * Builds a nested folder tree from slash-separated names.
 *
 * `scope` and `folderNotes` make each folder addressable in its own right, so a
 * group can carry a purpose ("aliases only — never referenced directly") rather
 * than only its members.
 */
export function buildTree(
  items: TreeInput[],
  scope?: string,
  folderNotes?: FolderNotes
): TreeNode[] {
  const root: TreeFolder = {
    kind: 'folder',
    name: '',
    path: '',
    children: [],
    leafCount: 0,
    documentedCount: 0,
  }

  for (const item of items) {
    const segments = item.name.split('/').map((s) => s.trim()).filter(Boolean)
    // A name that is nothing but slashes still deserves a row.
    const leafName = segments.pop() ?? item.name
    let cursor = root

    for (const segment of segments) {
      let next = cursor.children.find(
        (c): c is TreeFolder => c.kind === 'folder' && c.name === segment
      )
      if (!next) {
        const path = cursor.path ? `${cursor.path}/${segment}` : segment
        next = {
          kind: 'folder',
          name: segment,
          path,
          children: [],
          leafCount: 0,
          documentedCount: 0,
          entityId: scope ? folderId({ scope, path }) : undefined,
          noteCount: folderNotes?.[path] ?? 0,
        }
        cursor.children.push(next)
      }
      cursor = next
    }

    const leaf: TreeLeaf = {
      kind: 'leaf',
      name: leafName,
      path: item.name,
      entityId: item.entityId,
      entityKind: item.entityKind,
      noteCount: item.noteCount,
      preview: item.preview,
      detail: item.detail,
    }
    cursor.children.push(leaf)
  }

  tally(root)
  // Deliberately unsorted. `collection.variableIds` and the local-style lists
  // come back in the order the designer arranged them in Figma, and a folder
  // takes the position of its first member — which is how Figma's own Variables
  // panel reads. Alphabetising here would throw that ordering away.
  return root.children
}

/** Rolls leaf counts up so a folder row can show "12 items · 4 documented". */
function tally(folder: TreeFolder): void {
  let leaves = 0
  let documented = 0
  for (const child of folder.children) {
    if (child.kind === 'leaf') {
      leaves += 1
      if (child.noteCount > 0) documented += 1
    } else {
      tally(child)
      leaves += child.leafCount
      documented += child.documentedCount
    }
  }
  folder.leafCount = leaves
  folder.documentedCount = documented
}

/** Walks a tree to the folder at `path`, or null. Used to render a sub-level. */
export function folderAt(nodes: TreeNode[], path: string): TreeNode[] | null {
  if (!path) return nodes
  const segments = path.split('/').filter(Boolean)
  let current = nodes
  for (const segment of segments) {
    const next = current.find(
      (n): n is TreeFolder => n.kind === 'folder' && n.name === segment
    )
    if (!next) return null
    current = next.children
  }
  return current
}

/**
 * Renders a tree as an indented text block for the `## Structure` section of
 * the exported markdown, so grouping like `illustration/` survives the export.
 */
export function renderTreeOutline(nodes: TreeNode[], indent = ''): string {
  const lines: string[] = []
  for (const node of nodes) {
    if (node.kind === 'folder') {
      lines.push(`${indent}${node.name}/`)
      lines.push(renderTreeOutline(node.children, `${indent}  `))
    } else {
      lines.push(`${indent}${node.name}`)
    }
  }
  return lines.filter(Boolean).join('\n')
}

/** Flattens to leaves only, in display order. */
export function flattenLeaves(nodes: TreeNode[]): TreeLeaf[] {
  const out: TreeLeaf[] = []
  for (const node of nodes) {
    if (node.kind === 'leaf') out.push(node)
    else out.push(...flattenLeaves(node.children))
  }
  return out
}
