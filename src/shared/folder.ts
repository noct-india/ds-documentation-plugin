// Identifying folders.
//
// A folder is not a Figma object — it exists only as a "/" in the names of the
// variables or styles inside it. So there is nothing to hang notes on, and a
// folder needs a synthetic id that says where it lives.
//
// Notes then go on the nearest real object (the collection, or the document for
// style groups) under a key prefixed with the folder path, which lets the whole
// storage layer work unchanged.

/**
 * Unit separator — legal inside an id, and effectively never in a name a
 * designer types. Written as an escape so it stays visible in source.
 */
const SEP = '\u001F'
const PREFIX = 'folder'

export interface FolderRef {
  /** Which tree it belongs to: a collection id, or a style kind. */
  scope: string
  /** Slash path within that tree, e.g. "illustration/spot". */
  path: string
}

export function folderId(ref: FolderRef): string {
  return [PREFIX, ref.scope, ref.path].join(SEP)
}

export function isFolderId(id: string): boolean {
  return id.indexOf(`${PREFIX}${SEP}`) === 0
}

export function parseFolderId(id: string): FolderRef | null {
  if (!isFolderId(id)) return null
  const parts = id.split(SEP)
  if (parts.length < 3) return null
  // The path may itself contain a separator if a name did; rejoin the tail.
  return { scope: parts[1], path: parts.slice(2).join(SEP) }
}

/** The last segment, which is what the folder is called. */
export function folderName(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : path
}

/**
 * Every folder above a path, outermost first.
 *
 * "illustration/spot/dark" → ["illustration", "illustration/spot",
 * "illustration/spot/dark"]. Used to gather the chain of context a token sits
 * inside, so a draft knows the group's purpose and not just the leaf's name.
 */
export function ancestorPaths(path: string): string[] {
  const segments = path.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < segments.length; i++) {
    out.push(segments.slice(0, i + 1).join('/'))
  }
  return out
}

/** Storage key prefix for a folder's notes on its host object. */
export function folderKeyPrefix(ref: FolderRef): string {
  return `f${SEP}${ref.scope}${SEP}${ref.path}`
}
