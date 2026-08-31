// The edit history.
//
// A document-level, timestamped record of every change to the notes, kept in
// its own store — deliberately apart from the notes themselves and from the
// rendered markdown, so a record of edits never lives inside the content it
// describes. Powers the global History tab and each component's own edit log.
//
// Every entry is independently reversible. It carries a `before` patch and an
// `after` patch; undo applies `before`, redo applies `after`, both targeted at
// the one note the entry changed. "Undo all" walks every still-live entry back,
// newest first, to a clean slate. Reversal is pragmatic rather than a full
// operational transform: undoing an older edit while a newer one exists puts the
// note back to that entry's `before` value — the newer change can be redone.

import type { EntityKind, HistoryEntry } from '../shared/types'
import type { PluginDataHost } from './storage'
import { patchNote, readChunkedValue, writeChunkedValue } from './storage'

const HISTORY_KEY = 'dsdoc.history'

/** Resolves an entry's entity to the store its note actually lives on. */
export type Resolve = (
  entityId: string,
  entityKind: EntityKind
) => Promise<{ host: PluginDataHost; name: string } | null>

let seq = 0

function readAll(root: PluginDataHost): HistoryEntry[] {
  return readChunkedValue<HistoryEntry[]>(root, HISTORY_KEY, [])
}

function writeAll(root: PluginDataHost, log: HistoryEntry[]): void {
  writeChunkedValue(root, HISTORY_KEY, log)
}

export function recordHistory(
  root: PluginDataHost,
  entry: Omit<HistoryEntry, 'id' | 'ts' | 'undone'>
): void {
  const log = readAll(root)
  log.push({ ...entry, id: `h${Date.now().toString(36)}-${seq++}`, ts: Date.now() })
  writeAll(root, log)
}

/**
 * All entries, or one entity's, newest first. Ties on the timestamp — bulk ops
 * like "approve all" stamp the same millisecond — break by insertion order, so
 * the most recently recorded still sorts first.
 */
export function readHistory(root: PluginDataHost, entityId?: string): HistoryEntry[] {
  return readAll(root)
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => !entityId || e.entityId === entityId)
    .sort((a, b) => b.e.ts - a.e.ts || b.i - a.i)
    .map(({ e }) => e)
}

/** Reverses (undo) or re-applies (redo) one entry. Returns it, or null. */
export async function applyDirection(
  root: PluginDataHost,
  resolve: Resolve,
  id: string,
  direction: 'undo' | 'redo'
): Promise<HistoryEntry | null> {
  const log = readAll(root)
  const entry = log.find((e) => e.id === id)
  if (!entry) return null
  const target = await resolve(entry.entityId, entry.entityKind)
  if (!target) return null
  patchNote(
    target.host,
    entry.entityKind,
    target.name,
    entry.noteId,
    direction === 'undo' ? entry.before : entry.after
  )
  entry.undone = direction === 'undo'
  writeAll(root, log)
  return entry
}

/** Drops one entity's entries entirely — used when that item is reset. */
export function clearHistoryFor(root: PluginDataHost, entityId: string): void {
  const kept = readAll(root).filter((e) => e.entityId !== entityId)
  writeAll(root, kept)
}

/** Walks every still-live entry back to a clean slate. Scoped when given. */
export async function undoAll(
  root: PluginDataHost,
  resolve: Resolve,
  entityId?: string
): Promise<number> {
  const log = readAll(root)
  const live = log
    .filter((e) => !e.undone && (!entityId || e.entityId === entityId))
    .sort((a, b) => b.ts - a.ts)
  let count = 0
  for (const entry of live) {
    const target = await resolve(entry.entityId, entry.entityKind)
    if (!target) continue
    patchNote(target.host, entry.entityKind, target.name, entry.noteId, entry.before)
    entry.undone = true
    count++
  }
  writeAll(root, log)
  return count
}
