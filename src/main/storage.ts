// Persistence layer.
//
// Notes live as pluginData on the Figma object they describe — a Variable, a
// VariableCollection, a style, a component node. That means they travel with the
// file, sync to everyone who opens it, and are scoped per-file automatically.
//
// Figma throws above 100 kB per (pluginId, key, value) entry, so payloads are
// split across numbered keys and the count is recorded in a small header.

import type { DocumentedCounts, EntityKind, EntityMeta, NoteEntry, SectionKey } from '../shared/types'

/**
 * The subset of the Figma API we need to read/write notes.
 *
 * Variable, VariableCollection, BaseStyle and every SceneNode all satisfy this
 * structurally, which is what lets one code path cover every entity kind.
 */
export interface PluginDataHost {
  getPluginData(key: string): string
  setPluginData(key: string, value: string): void
  /** Real Figma nodes expose this; a synthetic (folder) host does not. */
  getPluginDataKeys?(): string[]
}

const META_KEY = 'dsdoc.meta'
const LOG_KEY = 'dsdoc.log'
const DOC_KEY = 'dsdoc.doc'
const BODY_KEY = 'dsdoc.body'
const INDEX_META_KEY = 'dsdoc.indexmeta'
const INDEX_KEY = 'dsdoc.index'

/**
 * 80 kB per chunk, under Figma's 100 kB ceiling. Because every payload is
 * ASCII-escaped before it is written (see `encode`), one character is exactly
 * one byte — so this character count *is* a byte count.
 */
const CHUNK_SIZE = 80_000

// ─── Encoding ────────────────────────────────────────────────────────────────

/** Matches every character outside printable ASCII. */
const NON_ASCII = /[^\x20-\x7E]/g

/**
 * Serialises to pure-ASCII JSON.
 *
 * Figma's 100 kB limit is measured in bytes, but JavaScript string lengths are
 * in UTF-16 units — a note written in Devanagari is 3 bytes per character, so
 * slicing on `.length` would produce chunks three times over the limit and
 * `setPluginData` would throw. Escaping every non-ASCII character to `\uXXXX`
 * makes length and byte count identical, which makes chunking exact rather than
 * approximate. `JSON.parse` reverses it for free, surrogate pairs included.
 *
 * `JSON.stringify` has already escaped control characters by this point, so
 * anything still outside printable ASCII is genuinely non-ASCII text.
 */
function encode(value: unknown): string {
  return JSON.stringify(value).replace(
    NON_ASCII,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

function decode<T>(raw: string, fallback: T): T {
  if (!raw) return fallback
  const parsed = JSON.parse(raw)
  return parsed === null || parsed === undefined ? fallback : (parsed as T)
}

// ─── Chunked read/write ──────────────────────────────────────────────────────

function readChunks(host: PluginDataHost, base: string, count: number): string {
  if (count <= 0) return ''
  let out = ''
  for (let i = 0; i < count; i++) out += host.getPluginData(`${base}.${i}`)
  return out
}

/**
 * Writes `value` across numbered keys and returns how many were used.
 *
 * Clearing the tail matters: if a payload shrinks from 3 chunks to 2 and key .2
 * is left behind, a later read that trusts a stale count concatenates garbage.
 */
function writeChunks(
  host: PluginDataHost,
  base: string,
  value: string,
  previousCount: number
): number {
  const parts: string[] = []
  for (let i = 0; i < value.length; i += CHUNK_SIZE) {
    parts.push(value.slice(i, i + CHUNK_SIZE))
  }
  if (parts.length === 0) parts.push('')

  parts.forEach((part, i) => host.setPluginData(`${base}.${i}`, part))
  for (let i = parts.length; i < previousCount; i++) {
    host.setPluginData(`${base}.${i}`, '')
  }
  return parts.length
}

/**
 * A chunked JSON value under its own key, for stores that are not the note log.
 *
 * The edit history uses this: it lives on the document under its own key, kept
 * deliberately apart from any note's data and from the rendered markdown, so a
 * record of changes never sits inside the content it describes. The chunk count
 * is held in `<base>.n`, the chunks in `<base>.0`, `<base>.1`, …
 */
export function writeChunkedValue(host: PluginDataHost, base: string, value: unknown): void {
  const previous = Number(host.getPluginData(`${base}.n`) || '0')
  const count = writeChunks(host, base, encode(value), previous)
  host.setPluginData(`${base}.n`, String(count))
}

export function readChunkedValue<T>(host: PluginDataHost, base: string, fallback: T): T {
  const count = Number(host.getPluginData(`${base}.n`) || '0')
  if (count <= 0) return fallback
  try {
    return decode<T>(readChunks(host, base, count), fallback)
  } catch {
    return fallback
  }
}

// ─── Meta ────────────────────────────────────────────────────────────────────

/**
 * The header a previous write left behind.
 *
 * Exposed because it records the `kind` and `name` a note was written *as*,
 * which is the only way to tell a misaddressed write from a note simply typed
 * on the wrong screen.
 */
export function readEntityMeta(host: PluginDataHost): EntityMeta | null {
  return readMeta(host)
}

function readMeta(host: PluginDataHost): EntityMeta | null {
  try {
    const meta = decode<EntityMeta | null>(host.getPluginData(META_KEY), null)
    return meta && meta.v === 1 ? meta : null
  } catch {
    return null
  }
}

function writeMeta(host: PluginDataHost, meta: EntityMeta): void {
  host.setPluginData(META_KEY, encode(meta))
}

// ─── Notes ───────────────────────────────────────────────────────────────────

/** Reads the append-only log. Returns [] for anything never documented. */
export function readLog(host: PluginDataHost): NoteEntry[] {
  const meta = readMeta(host)
  if (!meta) return []

  const raw = readChunks(host, LOG_KEY, meta.chunks.log)
  if (!raw) return []

  try {
    const parsed = decode<NoteEntry[]>(raw, [])
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Losing notes is the one failure this plugin must never have. If the
    // payload will not parse, surface it as a note rather than dropping it.
    console.error('[dsdoc] note log did not parse; preserving raw payload')
    return [
      {
        id: 'recovered',
        ts: Date.now(),
        author: 'system',
        section: 'notes',
        text: `Stored notes could not be read back. Raw data preserved:\n\n${raw}`,
      },
    ]
  }
}

function persistLog(
  host: PluginDataHost,
  kind: EntityKind,
  name: string,
  log: NoteEntry[]
): void {
  const previous = readMeta(host)
  const logChunks = writeChunks(host, LOG_KEY, encode(log), previous?.chunks.log ?? 0)
  writeMeta(host, {
    v: 1,
    kind,
    name,
    // Carry the body fields forward. Rebuilding meta from scratch here would
    // drop `bodyEdited`, orphaning a hand-edited body the moment a note is
    // added — the edit would still be in storage but unreachable.
    chunks: {
      log: logChunks,
      doc: previous?.chunks.doc ?? 0,
      body: previous?.chunks.body ?? 0,
    },
    bodyEdited: previous?.bodyEdited ?? false,
    updatedAt: Date.now(),
  })
}

let counter = 0

/** Appends one note. Existing entries are never touched. */
export function appendNote(
  host: PluginDataHost,
  kind: EntityKind,
  name: string,
  text: string,
  section: SectionKey,
  author: string,
  scope?: Record<string, string>
): NoteEntry[] {
  const log = readLog(host)
  const entry: NoteEntry = {
    id: `${Date.now()}-${counter++}`,
    ts: Date.now(),
    author,
    text,
    section,
  }
  // Stored only when it narrows something. An empty object would read as a
  // scope in every later comparison, when what it means is "no scope at all".
  if (scope && Object.keys(scope).length > 0) entry.scope = scope
  log.push(entry)
  persistLog(host, kind, name, log)
  return log
}

/**
 * Hides a note from the rendered document.
 *
 * Deliberately a soft delete — the hard requirement is that nothing the
 * designer wrote is ever lost, so the text stays in the log and only stops
 * being rendered and exported.
 */
export function softDeleteNote(
  host: PluginDataHost,
  kind: EntityKind,
  name: string,
  noteId: string
): NoteEntry[] {
  const log = readLog(host)
  const entry = log.find((e) => e.id === noteId)
  if (entry) {
    entry.deleted = true
    persistLog(host, kind, name, log)
  }
  return log
}

/**
 * Rewrites a note's wording, keeping what it replaced.
 *
 * The previous text is pushed onto `revisions` rather than dropped, so an edit
 * is as recoverable as a hidden note. Timestamp and author stay as they were —
 * this is a correction to an existing note, not a new one.
 */
export function editNote(
  host: PluginDataHost,
  kind: EntityKind,
  name: string,
  noteId: string,
  text: string,
  author: string
): NoteEntry[] {
  const log = readLog(host)
  const entry = log.find((e) => e.id === noteId)
  const trimmed = text.trim()

  if (entry && trimmed && trimmed !== entry.text) {
    entry.revisions = (entry.revisions ?? []).concat({
      text: entry.text,
      ts: Date.now(),
      author,
    })
    entry.text = trimmed
    persistLog(host, kind, name, log)
  }
  return log
}

/**
 * Finds live notes matching a wording and category.
 *
 * Batch notes get their own id on each component, so a shared note can only be
 * matched by what it says.
 */
/**
 * Applies a targeted patch to one note and persists — the single primitive the
 * edit-history undo/redo builds every reversal on (restore a deletion, re-draft
 * an approval, put text or a category back). Overwrites rather than revisioning:
 * the prior value already lives in the history entry doing the reverting.
 */
export function patchNote(
  host: PluginDataHost,
  kind: EntityKind,
  name: string,
  noteId: string,
  patch: { text?: string; section?: SectionKey; deleted?: boolean; draft?: boolean }
): NoteEntry[] {
  const log = readLog(host)
  const entry = log.find((e) => e.id === noteId)
  if (!entry) return log
  if (patch.text !== undefined) entry.text = patch.text
  if (patch.section !== undefined) entry.section = patch.section
  if (patch.deleted !== undefined) {
    if (patch.deleted) entry.deleted = true
    else delete entry.deleted
  }
  if (patch.draft !== undefined) {
    if (patch.draft) entry.draft = true
    else delete entry.draft
  }
  persistLog(host, kind, name, log)
  return log
}

export function findNotesMatching(
  log: NoteEntry[],
  section: SectionKey,
  text: string
): NoteEntry[] {
  return log.filter((e) => !e.deleted && e.section === section && e.text === text)
}

/**
 * Moves a note to a different category.
 *
 * Only the filing changes — `text`, `ts` and `author` are untouched, so
 * correcting the classifier never rewrites what someone actually said.
 */
export function recategorizeNote(
  host: PluginDataHost,
  kind: EntityKind,
  name: string,
  noteId: string,
  section: SectionKey
): NoteEntry[] {
  const log = readLog(host)
  const entry = log.find((e) => e.id === noteId)
  if (entry) {
    entry.section = section
    persistLog(host, kind, name, log)
  }
  return log
}

/** Caches rendered markdown. Always regenerable from the log, so safe to lose. */
export function writeDoc(host: PluginDataHost, markdown: string): void {
  const previous = readMeta(host)
  if (!previous) return
  const docChunks = writeChunks(host, DOC_KEY, encode(markdown), previous.chunks.doc)
  writeMeta(host, { ...previous, chunks: { ...previous.chunks, doc: docChunks } })
}

// ─── Hand-edited body ────────────────────────────────────────────────────────

/**
 * The authored half of the document, once someone has edited it by hand.
 *
 * Normally the body is derived from the note log on every render. Editing it
 * pins it: this override becomes what renders and exports, and new notes are
 * merged into it rather than regenerating over the top. The log keeps
 * accumulating underneath either way, so "rebuild from notes" is always a way
 * back and no wording is ever actually lost.
 *
 * Returns null when the body has never been edited.
 */
export function readBody(host: PluginDataHost): string | null {
  const meta = readMeta(host)
  if (!meta || !meta.bodyEdited) return null
  const raw = readChunks(host, BODY_KEY, meta.chunks.body ?? 0)
  if (!raw) return null
  try {
    return decode<string>(raw, '')
  } catch {
    return null
  }
}

export function writeBody(
  host: PluginDataHost,
  kind: EntityKind,
  name: string,
  body: string
): void {
  const previous = readMeta(host)
  const bodyChunks = writeChunks(host, BODY_KEY, encode(body), previous?.chunks.body ?? 0)
  writeMeta(host, {
    v: 1,
    kind,
    name,
    chunks: {
      log: previous?.chunks.log ?? 0,
      doc: previous?.chunks.doc ?? 0,
      body: bodyChunks,
    },
    bodyEdited: true,
    updatedAt: Date.now(),
  })
}

/** Drops the override so the body goes back to being derived from the log. */
export function clearBody(host: PluginDataHost): void {
  const previous = readMeta(host)
  if (!previous) return
  writeChunks(host, BODY_KEY, '', previous.chunks.body ?? 0)
  writeMeta(host, {
    ...previous,
    chunks: { ...previous.chunks, body: 0 },
    bodyEdited: false,
    updatedAt: Date.now(),
  })
}

/**
 * Adds bullets under a heading in an edited body, creating the section if it is
 * not there.
 *
 * Needed because once a body is pinned, appending a note can no longer mean
 * "re-render everything" — that would throw away the edit.
 */
export function insertUnderHeading(body: string, headingText: string, bullets: string[]): string {
  if (bullets.length === 0) return body

  const lines = body.split('\n')
  const target = `## ${headingText}`
  const headingIndex = lines.findIndex((line) => line.trim() === target)

  if (headingIndex === -1) {
    const tail = body.trim()
    return `${tail ? `${tail}\n\n` : ''}${target}\n\n${bullets.join('\n')}\n`
  }

  // Walk to the end of this section — the next heading, or the end of the body.
  let end = lines.length
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      end = i
      break
    }
  }

  // Back up over trailing blank lines so the bullet joins the list, not the gap.
  let insertAt = end
  while (insertAt > headingIndex + 1 && lines[insertAt - 1].trim() === '') insertAt--

  const before = lines.slice(0, insertAt)
  const after = lines.slice(insertAt)
  return before.concat(bullets, after).join('\n')
}

/**
 * A view of a host under a key prefix.
 *
 * Folders have no Figma object of their own, so their notes live on the nearest
 * real one — the collection, or the document for style groups — namespaced by
 * path. Prefixing keys rather than inventing a second storage path means
 * chunking, migration and the never-lose guarantees all apply unchanged.
 */
/**
 * Wipes every trace of this plugin from one node — a full clean slate.
 *
 * On a real node it sweeps every `dsdoc.*` key, which catches stale markers left
 * by earlier builds under names the current code no longer writes. A synthetic
 * folder host has no key list, so it clears the stores the meta knows about.
 */
export function clearAllEntityData(host: PluginDataHost): void {
  const keys = host.getPluginDataKeys?.()
  if (keys) {
    for (const key of keys) {
      if (key.startsWith('dsdoc.')) host.setPluginData(key, '')
    }
    return
  }
  const meta = readMeta(host)
  if (meta) {
    for (let i = 0; i < (meta.chunks.log ?? 0); i++) host.setPluginData(`${LOG_KEY}.${i}`, '')
    for (let i = 0; i < (meta.chunks.doc ?? 0); i++) host.setPluginData(`${DOC_KEY}.${i}`, '')
    for (let i = 0; i < (meta.chunks.body ?? 0); i++) host.setPluginData(`${BODY_KEY}.${i}`, '')
  }
  host.setPluginData(META_KEY, '')
}

export function scopedHost(host: PluginDataHost, prefix: string): PluginDataHost {
  return {
    getPluginData: (key) => host.getPluginData(`${prefix}.${key}`),
    setPluginData: (key, value) => host.setPluginData(`${prefix}.${key}`, value),
  }
}

// ─── Project brief ───────────────────────────────────────────────────────────

const BRIEF_KEY = 'dsdoc.brief'
const BRIEF_META_KEY = 'dsdoc.briefmeta'

/**
 * Free prose about the product this design system serves.
 *
 * Deliberately not a categorised note: what the product is, who uses it and how
 * it should feel is the context that makes every other suggestion specific
 * rather than generic. It leads the drafting prompt and the exported
 * `Guidelines.md`.
 */
export function readBrief(): string {
  let chunks = 0
  try {
    chunks = decode<{ chunks: number }>(figma.root.getPluginData(BRIEF_META_KEY), { chunks: 0 })
      .chunks
  } catch {
    return ''
  }
  const raw = readChunks(figma.root, BRIEF_KEY, chunks)
  if (!raw) return ''
  try {
    return decode<string>(raw, '')
  } catch {
    return ''
  }
}

export function writeBrief(text: string): void {
  let previous = 0
  try {
    previous = decode<{ chunks: number }>(figma.root.getPluginData(BRIEF_META_KEY), { chunks: 0 })
      .chunks
  } catch {
    previous = 0
  }
  const chunks = writeChunks(figma.root, BRIEF_KEY, encode(text), previous)
  figma.root.setPluginData(BRIEF_META_KEY, encode({ chunks }))
}

/**
 * Moves a variant's notes onto its set, as a fully-specified scope.
 *
 * The plugin briefly stored per-variant notes on the variant node itself. That
 * cannot express "all primary buttons" — there is no node for it — so scoped
 * notes live on the set, and these have to join them or the file ends up with
 * two ways of saying the same thing.
 *
 * Order matters and is not negotiable: the notes are written to the set and
 * read back before anything is cleared from the variant. A crash between the
 * two leaves a duplicate, which the id guard then absorbs on the next run. The
 * reverse order would lose the note outright.
 *
 * Returns the entries to write and whether the variant should then be cleared,
 * so the caller owns the writes and this stays testable.
 */
export function planVariantMigration(
  setLog: NoteEntry[],
  variantLog: NoteEntry[],
  scope: Record<string, string>
): { merged: NoteEntry[]; moved: number } {
  // Already carried across by an earlier run that did not finish. Matching on
  // id rather than text: two variants can legitimately carry the same wording.
  const known = new Set(setLog.map((entry) => entry.id))
  const incoming = variantLog
    .filter((entry) => !known.has(entry.id))
    .map((entry) => ({
      ...entry,
      // A note written against one variant was always about that exact
      // combination; saying so explicitly is the whole migration.
      scope: Object.keys(scope).length > 0 ? scope : entry.scope,
    }))

  return {
    merged: [...setLog, ...incoming].sort((a, b) => a.ts - b.ts),
    moved: incoming.length,
  }
}

/** Writes a log wholesale. Used by the migration, which owns entry ids. */
export function replaceLog(
  host: PluginDataHost,
  kind: EntityKind,
  name: string,
  log: NoteEntry[]
): void {
  persistLog(host, kind, name, log)
}

// ─── Root index ──────────────────────────────────────────────────────────────

export interface IndexEntry {
  kind: EntityKind
  name: string
  noteCount: number
  /** Suggestions awaiting review. Tracked so they can be found file-wide. */
  draftCount?: number
  updatedAt: number
}

export type RootIndex = Record<string, IndexEntry>

/**
 * How many entities of each kind carry at least one approved note.
 *
 * Pure, and separate from the Figma lookups, because the three things that make
 * it wrong are all quiet: counting an orphan whose object was deleted, counting
 * an entity whose only notes are unapproved drafts, and dropping a kind on the
 * floor when a new one is added. `alive` comes from the caller's existence
 * check so this stays synchronous.
 */
export function countDocumented(
  entries: Array<{ entry: IndexEntry; alive: boolean }>
): DocumentedCounts {
  const counts: DocumentedCounts = {
    collections: 0,
    variables: 0,
    paintStyles: 0,
    textStyles: 0,
    effectStyles: 0,
    components: 0,
    variants: 0,
  }

  for (const { entry, alive } of entries) {
    // noteCount is live notes only — drafts are tracked separately — so this
    // one guard covers both "nothing written" and "only unapproved guesses".
    if (!alive || entry.noteCount <= 0) continue
    switch (entry.kind) {
      case 'collection':
        counts.collections += 1
        break
      case 'variable':
        counts.variables += 1
        break
      case 'paintStyle':
        counts.paintStyles += 1
        break
      case 'textStyle':
        counts.textStyles += 1
        break
      case 'effectStyle':
        counts.effectStyles += 1
        break
      case 'component':
      case 'componentSet':
        counts.components += 1
        break
      case 'variant':
        counts.variants += 1
        break
      default:
        // folder, page, section and project are documented but are not things
        // the coverage table counts — they have no denominator to be a share of.
        break
    }
  }

  return counts
}

function readIndexChunkCount(): number {
  try {
    return decode<{ chunks: number }>(figma.root.getPluginData(INDEX_META_KEY), { chunks: 0 })
      .chunks
  } catch {
    return 0
  }
}

/**
 * A roll-up on figma.root of everything documented.
 *
 * Purely derived — it powers coverage counts and orphan detection without
 * enumerating the whole file on every open. Never the only copy of a note:
 * plugin data written to the root does not survive a branch merge, so the
 * authoritative copy always stays on the entity itself.
 */
export function readIndex(): RootIndex {
  try {
    return decode<RootIndex>(readChunks(figma.root, INDEX_KEY, readIndexChunkCount()), {})
  } catch {
    return {}
  }
}

export function updateIndex(
  entityId: string,
  kind: EntityKind,
  name: string,
  noteCount: number,
  draftCount = 0
): void {
  const index = readIndex()
  // An entity carrying only drafts still belongs in the index — otherwise
  // pending suggestions are invisible unless you happen to navigate to them.
  if (noteCount > 0 || draftCount > 0) {
    index[entityId] = { kind, name, noteCount, draftCount, updatedAt: Date.now() }
  } else {
    delete index[entityId]
  }

  try {
    // Chunked like everything else: a large system can index well past the
    // point where a single entry would fit.
    const chunks = writeChunks(figma.root, INDEX_KEY, encode(index), readIndexChunkCount())
    figma.root.setPluginData(INDEX_META_KEY, encode({ chunks }))
  } catch (err) {
    // The index is a convenience, not the source of truth — a failure here
    // must never take the note write down with it.
    console.error('[dsdoc] could not write root index', err)
  }
}

/**
 * Notes counted for coverage.
 *
 * Neither hidden notes nor unapproved drafts count — an entity covered only by
 * suggestions is not documented, and reporting it as such would hide exactly
 * the work still to do.
 */
export function liveNoteCount(log: NoteEntry[]): number {
  return log.filter((e) => !e.deleted && !e.draft).length
}

export function draftCount(log: NoteEntry[]): number {
  return log.filter((e) => !e.deleted && e.draft).length
}

/** Appends suggestions, flagged for review. Never touches existing notes. */
export function appendDrafts(
  host: PluginDataHost,
  kind: EntityKind,
  name: string,
  drafts: Array<{ text: string; section: SectionKey; scope?: Record<string, string> }>,
  author: string
): NoteEntry[] {
  const log = readLog(host)
  for (const draft of drafts) {
    const entry: NoteEntry = {
      id: `${Date.now()}-${counter++}`,
      ts: Date.now(),
      author,
      text: draft.text,
      section: draft.section,
      draft: true,
    }
    // A draft carries the same scope a typed note would, so approving it lands
    // it under the right heading rather than silently as a whole-set rule.
    if (draft.scope && Object.keys(draft.scope).length > 0) entry.scope = draft.scope
    log.push(entry)
  }
  persistLog(host, kind, name, log)
  return log
}

/**
 * Promotes a draft to an authored note.
 *
 * Approval is what makes a suggestion count — it is the moment a human takes
 * responsibility for the claim, so it is recorded as an edit by the approver.
 */
export function approveDrafts(
  host: PluginDataHost,
  kind: EntityKind,
  name: string,
  noteIds: string[] | null,
  approver: string
): NoteEntry[] {
  const log = readLog(host)
  let changed = false

  for (const entry of log) {
    if (!entry.draft || entry.deleted) continue
    if (noteIds !== null && noteIds.indexOf(entry.id) === -1) continue
    delete entry.draft
    entry.author = approver
    entry.ts = Date.now()
    changed = true
  }

  if (changed) persistLog(host, kind, name, log)
  return log
}
