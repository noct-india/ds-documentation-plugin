// Sandbox entry point.
//
// Owns all Figma API access and answers RPC calls from the UI iframe. The UI
// never touches the Figma API directly — it only sends requests and renders
// what comes back.

import type {
  EntityDetail,
  EntityKind,
  HomeState,
  Request,
  RpcRequest,
  DraftNote,
  PendingDraft,
  RpcResponse,
  SectionKey,
  SharedNote,
} from '../shared/types'
import { SECTION_HEADINGS, migrateSection } from '../shared/types'
import type { PluginDataHost } from './storage'
import { buildBridgeRequest } from './bridge'
import {
  appendDrafts,
  appendNote,
  countDocumented,
  approveDrafts,
  clearAllEntityData,
  clearBody,
  draftCount,
  editNote,
  findNotesMatching,
  insertUnderHeading,
  liveNoteCount,
  readBody,
  readBrief,
  readEntityMeta,
  readIndex,
  readLog,
  recategorizeNote,
  softDeleteNote,
  updateIndex,
  writeBody,
  writeBrief,
  writeDoc,
} from './storage'
import { entityExists, resolveEntity } from './reader/entity'
import {
  applyDirection as applyHistoryDirection,
  clearHistoryFor,
  readHistory,
  recordHistory,
  undoAll as undoAllHistory,
  type Resolve,
} from './history'
import { invalidatePreviewCache, renderNode } from './reader/preview'
import { listCollections, getCollectionTree, invalidateVariableCache } from './reader/variables'
import { getStyleTree, invalidateStyleCache } from './reader/styles'
import {
  allComponents,
  invalidateComponentCache,
  listComponents,
  listPages,
  listSections,
} from './reader/components'
import { resolveSelection, resolveSelectionBatch, revealNode } from './reader/selection'
import { buildExport, coverageSnapshot } from './export/build'
import { renderAuthoredSections, renderEntityDoc, renderStructure } from './export/render'

// Wide enough for the navigation pane and a readable notes pane side by side.
// The UI carries a drag grip that calls back through the `resize` request.
figma.showUI(__html__, { width: 880, height: 640, themeColors: true })

/** clientStorage key for the bridge folder — see `rememberBridgeHome`. */
const BRIDGE_HOME_KEY = 'dsdoc.bridgeHome'

// ─── Detail assembly ─────────────────────────────────────────────────────────

/** Detail-view rendering keeps blank headings visible so gaps are obvious. */
const DETAIL_OPTIONS = { includeEmptySections: true } as const

async function buildDetail(entityId: string, entityKind: EntityKind): Promise<EntityDetail> {
  const resolved = await resolveEntity(entityId, entityKind)

  if (!resolved) {
    // The Figma object is gone. Report it rather than silently showing a blank
    // page — its notes went with it and the user needs to know.
    const indexed = readIndex()[entityId]
    return {
      entityId,
      entityKind,
      name: indexed?.name ?? 'Deleted item',
      structure: { typeLabel: 'Missing' },
      log: [],
      markdown: '',
      structureMarkdown: '',
      bodyMarkdown: '',
      bodyEdited: false,
      missing: true,
    }
  }

  const log = readLog(resolved.host)
  const structureMarkdown = renderStructure(resolved.name, entityKind, resolved.structure)
  const override = readBody(resolved.host)
  const bodyEdited = override !== null

  // A pinned body is shown verbatim. A derived one keeps its empty headings so
  // the gaps stay visible in the preview.
  const bodyMarkdown = override ?? renderAuthoredSections(log, entityKind)
  const preview = override ?? renderEntityDoc(
    resolved.name,
    entityKind,
    resolved.structure,
    log,
    DETAIL_OPTIONS
  )

  const meta = readEntityMeta(resolved.host)

  return {
    entityId,
    entityKind,
    name: resolved.name,
    structure: resolved.structure,
    log,
    markdown: override ? `${structureMarkdown}\n\n${override}` : preview,
    structureMarkdown,
    bodyMarkdown,
    bodyEdited,
    storedAs: meta ? { kind: meta.kind, name: meta.name } : undefined,
  }
}

// ─── Home ────────────────────────────────────────────────────────────────────

async function buildHome(): Promise<HomeState> {
  const snapshot = await coverageSnapshot()
  const index = readIndex()

  // An indexed entity that no longer resolves is an orphan: the variable or
  // component was deleted, taking its notes with it.
  const entries = Object.entries(index).filter(([, entry]) => entry.kind !== 'project')
  const alive = await Promise.all(
    entries.map(([entityId, entry]) => entityExists(entityId, entry.kind))
  )
  const orphans: HomeState['orphans'] = entries
    .filter((_, i) => !alive[i])
    .map(([entityId, entry]) => ({
      entityId,
      kind: entry.kind,
      name: entry.name,
      noteCount: entry.noteCount,
    }))

  // Per-kind documented counts, from the same index the orphan scan just walked.
  const documented = countDocumented(
    entries.map(([, entry], i) => ({ entry, alive: alive[i] }))
  )

  const projectLog = readLog(figma.root).filter((e) => !e.deleted && !e.draft)
  const projectSections = Array.from(
    new Set(projectLog.map((e) => migrateSection(e.section)))
  )

  return {
    fileName: figma.root.name,
    documented,
    projectSections,
    counts: {
      collections: snapshot.collections,
      variables: snapshot.variables,
      paintStyles: snapshot.paintStyles,
      textStyles: snapshot.textStyles,
      effectStyles: snapshot.effectStyles,
      components: null, // filled in lazily — walking pages is expensive
    },
    documentedCount: snapshot.documented,
    projectNoteCount: liveNoteCount(readLog(figma.root)),
    brief: readBrief(),
    orphans,
  }
}

/**
 * Appends notes to one entity and keeps its derived state in step.
 *
 * Shared by the single-entity and batch paths so they cannot drift — in
 * particular so a batch note respects a hand-edited body exactly as a single
 * note does.
 */
function applyNotes(
  host: PluginDataHost,
  entityId: string,
  entityKind: EntityKind,
  name: string,
  entries: Array<{ text: string; section: SectionKey }>,
  scope?: Record<string, string>
): void {
  const author = currentAuthor()
  let log = readLog(host)
  for (const entry of entries) {
    log = appendNote(host, entityKind, name, entry.text, entry.section, author, scope)
  }
  updateIndex(entityId, entityKind, name, liveNoteCount(log))

  // A hand-edited body is not regenerated — new notes are merged into it, so
  // adding a note never silently discards someone's edit.
  const override = readBody(host)
  if (override !== null) {
    let merged = override
    for (const entry of entries) {
      merged = insertUnderHeading(merged, SECTION_HEADINGS[entry.section], [
        `- ${entry.text.trim().split('\n').join(' ')}`,
      ])
    }
    writeBody(host, entityKind, name, merged)
  }
}

/**
 * Every note across a batch selection, grouped by what it says.
 *
 * A note added to eight components exists as eight separate entries with eight
 * ids, so grouping is by category + wording. The count tells the designer
 * whether a note really is shared across the whole selection or only some of it.
 */
async function collectSharedNotes(
  targets: Array<{ entityId: string; entityKind: EntityKind }>
): Promise<SharedNote[]> {
  const groups = new Map<string, SharedNote>()
  let resolvedTargets = 0

  for (const target of targets) {
    const resolved = await resolveEntity(target.entityId, target.entityKind)
    if (!resolved) continue
    resolvedTargets += 1

    // Count each wording once per component, even if it appears twice there.
    const seen = new Set<string>()
    for (const entry of readLog(resolved.host)) {
      if (entry.deleted) continue
      const section = migrateSection(entry.section)
      const key = `${section}\u0000${entry.text}`
      if (seen.has(key)) continue
      seen.add(key)

      const existing = groups.get(key)
      if (existing) existing.count += 1
      else groups.set(key, { text: entry.text, section, count: 1, total: targets.length })
    }
  }

  const shared = Array.from(groups.values()).map((note) => ({
    ...note,
    total: resolvedTargets,
  }))
  // Most widely shared first — those are the ones a batch edit will affect most.
  shared.sort((a, b) => b.count - a.count || a.section.localeCompare(b.section))
  return shared
}

// ─── Request handling ────────────────────────────────────────────────────────

function progress(message: string): void {
  figma.ui.postMessage({ __rpc: 'progress', message })
}

/**
 * Who is writing this note.
 *
 * `figma.currentUser` throws outright unless the manifest declares the
 * "currentuser" permission — optional chaining does not help, because reading
 * the property is what throws. It is declared, but attribution is a nicety and
 * must never be the reason a note fails to save.
 */
function currentAuthor(): string {
  try {
    return figma.currentUser?.name ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case 'getHome':
      return buildHome()

    case 'getSelection':
      return resolveSelection()

    case 'getCollections':
      return listCollections()

    case 'getCollectionTree':
      return getCollectionTree(request.collectionId)

    case 'getStyleTree':
      return getStyleTree(request.styleKind)

    case 'getPages':
      return listPages((done, total) => {
        if (done === 1 || done % 5 === 0 || done === total) {
          progress(`Reading pages — ${done} of ${total}…`)
        }
      })

    case 'countComponents': {
      progress('Loading all pages — this can take a moment on large files…')
      await figma.loadAllPagesAsync()
      const found = await allComponents()
      return found.length
    }

    case 'getPageSections':
      return listSections(request.pageId)

    case 'getSectionComponents':
      return listComponents(request.pageId, request.sectionId)

    case 'getEntity':
      return buildDetail(request.entityId, request.entityKind)

    case 'addNotes': {
      const resolved = await resolveEntity(request.entityId, request.entityKind)
      if (!resolved) throw new Error('That item no longer exists in this file.')

      const before = new Set(readLog(resolved.host).map((e) => e.id))
      applyNotes(
        resolved.host,
        request.entityId,
        request.entityKind,
        resolved.name,
        request.entries,
        request.scope
      )
      for (const note of readLog(resolved.host).filter((e) => !before.has(e.id))) {
        recordHistory(figma.root, {
          op: 'add',
          entityId: request.entityId,
          entityKind: request.entityKind,
          entityName: resolved.name,
          noteId: note.id,
          summary: `Added a ${SECTION_HEADINGS[note.section]} note`,
          before: { deleted: true },
          after: { deleted: false },
        })
      }

      const detail = await buildDetail(request.entityId, request.entityKind)
      writeDoc(resolved.host, detail.markdown)
      return detail
    }

    case 'getPendingDrafts': {
      // Read from the index rather than scanning the file: a full sweep would
      // mean loading every page just to answer "what is waiting?".
      const index = readIndex()
      const pending: PendingDraft[] = []

      for (const [entityId, entry] of Object.entries(index)) {
        if (!entry.draftCount) continue
        const resolved = await resolveEntity(entityId, entry.kind)
        if (!resolved) continue
        pending.push({
          entityId,
          entityKind: entry.kind,
          name: resolved.name,
          draftCount: draftCount(readLog(resolved.host)),
        })
      }

      return pending
        .filter((p) => p.draftCount > 0)
        .sort((a, b) => b.draftCount - a.draftCount || a.name.localeCompare(b.name))
    }

    case 'getSelectionBatch':
      return resolveSelectionBatch()

    case 'editNote': {
      const resolved = await resolveEntity(request.entityId, request.entityKind)
      if (!resolved) throw new Error('That item no longer exists in this file.')

      const previous = readLog(resolved.host).find((e) => e.id === request.noteId)?.text
      editNote(
        resolved.host,
        request.entityKind,
        resolved.name,
        request.noteId,
        request.text,
        currentAuthor()
      )
      if (previous !== undefined && previous !== request.text.trim()) {
        recordHistory(figma.root, {
          op: 'edit',
          entityId: request.entityId,
          entityKind: request.entityKind,
          entityName: resolved.name,
          noteId: request.noteId,
          summary: 'Edited a note',
          before: { text: previous },
          after: { text: request.text.trim() },
        })
      }
      const detail = await buildDetail(request.entityId, request.entityKind)
      writeDoc(resolved.host, detail.markdown)
      return detail
    }

    case 'getSharedNotes':
      return collectSharedNotes(request.targets)

    case 'editSharedNote': {
      const author = currentAuthor()
      for (const target of request.targets) {
        const resolved = await resolveEntity(target.entityId, target.entityKind)
        if (!resolved) continue
        const matches = findNotesMatching(
          readLog(resolved.host),
          request.section,
          request.from
        )
        for (const match of matches) {
          editNote(
            resolved.host,
            target.entityKind,
            resolved.name,
            match.id,
            request.to,
            author
          )
        }
      }
      return collectSharedNotes(request.targets)
    }

    case 'removeSharedNote': {
      for (const target of request.targets) {
        const resolved = await resolveEntity(target.entityId, target.entityKind)
        if (!resolved) continue
        const matches = findNotesMatching(readLog(resolved.host), request.section, request.text)
        for (const match of matches) {
          softDeleteNote(resolved.host, target.entityKind, resolved.name, match.id)
        }
        updateIndex(
          target.entityId,
          target.entityKind,
          resolved.name,
          liveNoteCount(readLog(resolved.host))
        )
      }
      return collectSharedNotes(request.targets)
    }

    case 'addNotesBatch': {
      // Purely additive: each target gets its own appended entries and nothing
      // already written to any of them is read back or rewritten.
      const skipped: string[] = []
      let applied = 0

      for (const target of request.targets) {
        const resolved = await resolveEntity(target.entityId, target.entityKind)
        if (!resolved) {
          skipped.push(target.name)
          continue
        }
        applyNotes(
          resolved.host,
          target.entityId,
          target.entityKind,
          resolved.name,
          request.entries
        )
        applied += 1
      }

      return { applied, notes: request.entries.length, skipped }
    }

    case 'buildBridgeRequest':
      return buildBridgeRequest({
        targets: request.targets,
        includeImages: request.includeImages,
        onProgress: (done, total) => {
          if (done % 10 === 0 || done === total) {
            progress(`Gathering context — ${done} of ${total}…`)
          }
        },
      })

    case 'applyDrafts': {
      // Group by entity so one entity is written once however many drafts it got.
      const byEntity = new Map<string, { kind: EntityKind; drafts: DraftNote[] }>()
      for (const draft of request.drafts) {
        const existing = byEntity.get(draft.entityId)
        if (existing) existing.drafts.push(draft)
        else byEntity.set(draft.entityId, { kind: draft.entityKind, drafts: [draft] })
      }

      let applied = 0
      let skipped = 0
      for (const [entityId, group] of byEntity) {
        const resolved = await resolveEntity(entityId, group.kind)
        if (!resolved) {
          skipped += group.drafts.length
          continue
        }
        const log = appendDrafts(
          resolved.host,
          group.kind,
          resolved.name,
          group.drafts.map((d) => ({ text: d.text, section: d.section, scope: d.scope })),
          'Claude'
        )
        updateIndex(entityId, group.kind, resolved.name, liveNoteCount(log), draftCount(log))
        applied += group.drafts.length
      }
      return { applied, skipped }
    }

    case 'reviewDrafts': {
      const resolved = await resolveEntity(request.entityId, request.entityKind)
      if (!resolved) throw new Error('That item no longer exists in this file.')

      if (request.action === 'approve') {
        const approved = readLog(resolved.host).filter(
          (e) =>
            e.draft &&
            !e.deleted &&
            (request.noteIds === null || request.noteIds.indexOf(e.id) !== -1)
        )
        const log = approveDrafts(
          resolved.host,
          request.entityKind,
          resolved.name,
          request.noteIds,
          currentAuthor()
        )
        for (const note of approved) {
          recordHistory(figma.root, {
            op: 'approve',
            entityId: request.entityId,
            entityKind: request.entityKind,
            entityName: resolved.name,
            noteId: note.id,
            summary: `Approved a ${SECTION_HEADINGS[note.section]} suggestion`,
            before: { draft: true },
            after: { draft: false },
          })
        }
        updateIndex(
          request.entityId,
          request.entityKind,
          resolved.name,
          liveNoteCount(log),
          draftCount(log)
        )
      } else {
        // Rejecting is a soft delete like any other — the wording is kept.
        const log = readLog(resolved.host)
        const ids =
          request.noteIds ?? log.filter((e) => e.draft && !e.deleted).map((e) => e.id)
        const rejected = log.filter((e) => ids.indexOf(e.id) !== -1)
        for (const id of ids) {
          softDeleteNote(resolved.host, request.entityKind, resolved.name, id)
        }
        for (const note of rejected) {
          recordHistory(figma.root, {
            op: 'reject',
            entityId: request.entityId,
            entityKind: request.entityKind,
            entityName: resolved.name,
            noteId: note.id,
            summary: `Rejected a ${SECTION_HEADINGS[note.section]} suggestion`,
            before: { deleted: false },
            after: { deleted: true },
          })
        }
        const after = readLog(resolved.host)
        updateIndex(
          request.entityId,
          request.entityKind,
          resolved.name,
          liveNoteCount(after),
          draftCount(after)
        )
      }

      const detail = await buildDetail(request.entityId, request.entityKind)
      writeDoc(resolved.host, detail.markdown)
      return detail
    }

    case 'saveBrief':
      writeBrief(request.text)
      return buildHome()

    case 'saveBody': {
      const resolved = await resolveEntity(request.entityId, request.entityKind)
      if (!resolved) throw new Error('That item no longer exists in this file.')

      writeBody(resolved.host, request.entityKind, resolved.name, request.body)
      const detail = await buildDetail(request.entityId, request.entityKind)
      writeDoc(resolved.host, detail.markdown)
      return detail
    }

    case 'resetBody': {
      const resolved = await resolveEntity(request.entityId, request.entityKind)
      if (!resolved) throw new Error('That item no longer exists in this file.')

      clearBody(resolved.host)
      const detail = await buildDetail(request.entityId, request.entityKind)
      writeDoc(resolved.host, detail.markdown)
      return detail
    }

    case 'deleteNote': {
      const resolved = await resolveEntity(request.entityId, request.entityKind)
      if (!resolved) throw new Error('That item no longer exists in this file.')

      const log = softDeleteNote(
        resolved.host,
        request.entityKind,
        resolved.name,
        request.noteId
      )
      recordHistory(figma.root, {
        op: 'delete',
        entityId: request.entityId,
        entityKind: request.entityKind,
        entityName: resolved.name,
        noteId: request.noteId,
        summary: 'Deleted a note',
        before: { deleted: false },
        after: { deleted: true },
      })
      updateIndex(request.entityId, request.entityKind, resolved.name, liveNoteCount(log))

      const detail = await buildDetail(request.entityId, request.entityKind)
      writeDoc(resolved.host, detail.markdown)
      return detail
    }

    case 'recategorizeNote': {
      const resolved = await resolveEntity(request.entityId, request.entityKind)
      if (!resolved) throw new Error('That item no longer exists in this file.')

      const priorSection = readLog(resolved.host).find((e) => e.id === request.noteId)?.section
      recategorizeNote(
        resolved.host,
        request.entityKind,
        resolved.name,
        request.noteId,
        request.section
      )
      if (priorSection !== undefined && priorSection !== request.section) {
        recordHistory(figma.root, {
          op: 'recategorize',
          entityId: request.entityId,
          entityKind: request.entityKind,
          entityName: resolved.name,
          noteId: request.noteId,
          summary: `Moved a note to ${SECTION_HEADINGS[request.section]}`,
          before: { section: priorSection },
          after: { section: request.section },
        })
      }
      const detail = await buildDetail(request.entityId, request.entityKind)
      writeDoc(resolved.host, detail.markdown)
      return detail
    }

    case 'revealEntity': {
      // Variants included — selecting the exact combination you are writing
      // about is more useful than selecting the whole set, and the button is
      // offered for them, so it has to do something.
      if (
        request.entityKind === 'component' ||
        request.entityKind === 'componentSet' ||
        request.entityKind === 'variant'
      ) {
        await revealNode(request.entityId)
      }
      return null
    }

    case 'buildExport': {
      // Caches are session-scoped; the file may have changed since the plugin
      // opened, and an export must reflect what is actually there now.
      invalidateVariableCache()
      invalidateStyleCache()
      invalidateComponentCache()
      invalidatePreviewCache()
      const files = await buildExport(progress)
      return { fileName: figma.root.name, files }
    }

    case 'resize':
      figma.ui.resize(request.width, request.height)
      return null

    // clientStorage rather than the document: where the bridge sits is a fact
    // about this machine, not about this design system. Storing it in the file
    // would follow the library to everyone who opens it and be wrong for all
    // of them.
    case 'rememberBridgeHome':
      await figma.clientStorage.setAsync(BRIDGE_HOME_KEY, request.path)
      return null

    case 'getBridgeHome': {
      const stored = await figma.clientStorage.getAsync(BRIDGE_HOME_KEY)
      return typeof stored === 'string' ? stored : null
    }

    case 'getComponentImage':
      return renderNode(request.nodeId, {
        maxPx: request.maxPx,
        overrides: request.overrides,
      })

    case 'getHistory':
      return readHistory(figma.root, request.entityId)

    case 'historyUndo': {
      const resolve: Resolve = async (entityId, entityKind) => {
        const r = await resolveEntity(entityId, entityKind)
        return r ? { host: r.host, name: r.name } : null
      }
      await applyHistoryDirection(figma.root, resolve, request.id, request.direction)
      return readHistory(figma.root)
    }

    case 'historyUndoAll': {
      const resolve: Resolve = async (entityId, entityKind) => {
        const r = await resolveEntity(entityId, entityKind)
        return r ? { host: r.host, name: r.name } : null
      }
      await undoAllHistory(figma.root, resolve, request.entityId)
      return readHistory(figma.root)
    }

    case 'clearEntity': {
      const resolved = await resolveEntity(request.entityId, request.entityKind)
      if (!resolved) throw new Error('That item no longer exists in this file.')
      // Wipe the node clean — notes, body, doc cache, and any stale keys from
      // earlier builds — then drop this item's history and reset its count.
      clearAllEntityData(resolved.host)
      clearHistoryFor(figma.root, request.entityId)
      updateIndex(request.entityId, request.entityKind, resolved.name, 0)
      return buildDetail(request.entityId, request.entityKind)
    }

    default: {
      const exhaustive: never = request
      throw new Error(`Unknown request: ${JSON.stringify(exhaustive)}`)
    }
  }
}

figma.ui.onmessage = async (message: RpcRequest) => {
  if (!message || message.__rpc !== 'req') return

  let response: RpcResponse
  try {
    response = { __rpc: 'res', id: message.id, ok: true, result: await handle(message.payload) }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[dsdoc]', message.payload.type, error)
    response = { __rpc: 'res', id: message.id, ok: false, error }
  }
  figma.ui.postMessage(response)
}

// Keep a docked panel in step with the canvas.
figma.on('selectionchange', () => {
  resolveSelectionBatch()
    .then((targets) => figma.ui.postMessage({ __rpc: 'selection', targets }))
    .catch(() => {
      /* selection resolution is best-effort */
    })
})
