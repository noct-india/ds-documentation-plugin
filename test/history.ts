// Engine test for the edit history: recording, per-entry vector undo/redo, and
// undo-all to a clean slate. The notes live on one host, the history on another
// (the document) — exactly as in the plugin. Run with `npm run test:history`.

import { appendNote, editNote, readLog, softDeleteNote } from '../src/main/storage'
import { applyDirection, readHistory, recordHistory, undoAll } from '../src/main/history'
import type { EntityKind } from '../src/shared/types'

class Host {
  private d = new Map<string, string>()
  getPluginData(k: string): string {
    return this.d.get(k) ?? ''
  }
  setPluginData(k: string, v: string): void {
    this.d.set(k, v)
  }
}

let fails = 0
const check = (label: string, ok: boolean) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`)
  if (!ok) fails++
}
const live = (h: Host) => readLog(h).filter((e) => !e.deleted && !e.draft)
const note = (h: Host, id: string) => readLog(h).find((e) => e.id === id)

async function main() {
  const root = new Host() // the document-level history store
  const host = new Host() // where a component's notes live
  const resolve = async (_id: string, _kind: EntityKind) => ({ host, name: 'Button' })

  // Two notes added, each recorded.
  appendNote(host, 'componentSet', 'Button', 'Rule one.', 'rules', 'A')
  const id1 = readLog(host)[0].id
  recordHistory(root, {
    op: 'add', entityId: 'B', entityKind: 'componentSet', entityName: 'Button',
    noteId: id1, summary: 'Added a Rule', before: { deleted: true }, after: { deleted: false },
  })
  appendNote(host, 'componentSet', 'Button', 'Rule two.', 'rules', 'A')
  const id2 = readLog(host)[1].id
  recordHistory(root, {
    op: 'add', entityId: 'B', entityKind: 'componentSet', entityName: 'Button',
    noteId: id2, summary: 'Added a Rule', before: { deleted: true }, after: { deleted: false },
  })

  check('history holds both entries', readHistory(root).length === 2)
  check('history is newest-first', readHistory(root)[0].noteId === id2)
  check('both notes are live', live(host).length === 2)

  // Undo the SECOND add independently — the first must be untouched.
  const e2 = readHistory(root).find((e) => e.noteId === id2)!
  await applyDirection(root, resolve, e2.id, 'undo')
  check('undo add hides only note two', note(host, id2)!.deleted === true && !note(host, id1)!.deleted)
  check('the entry is marked undone', readHistory(root).find((e) => e.id === e2.id)!.undone === true)

  // Redo it.
  await applyDirection(root, resolve, e2.id, 'redo')
  check('redo restores note two', !note(host, id2)!.deleted)
  check('the entry is no longer undone', !readHistory(root).find((e) => e.id === e2.id)!.undone)

  // Edit note one, record, then undo just that edit.
  editNote(host, 'componentSet', 'Button', id1, 'Rule one, revised.', 'A')
  recordHistory(root, {
    op: 'edit', entityId: 'B', entityKind: 'componentSet', entityName: 'Button',
    noteId: id1, summary: 'Edited a Rule',
    before: { text: 'Rule one.' }, after: { text: 'Rule one, revised.' },
  })
  check('edit took effect', note(host, id1)!.text === 'Rule one, revised.')
  const eEdit = readHistory(root).find((e) => e.op === 'edit')!
  await applyDirection(root, resolve, eEdit.id, 'undo')
  check('undo edit puts the old wording back', note(host, id1)!.text === 'Rule one.')

  // A soft delete, recorded, then undone.
  softDeleteNote(host, 'componentSet', 'Button', id2)
  recordHistory(root, {
    op: 'delete', entityId: 'B', entityKind: 'componentSet', entityName: 'Button',
    noteId: id2, summary: 'Deleted a Rule', before: { deleted: false }, after: { deleted: true },
  })
  check('delete hides note two', note(host, id2)!.deleted === true)
  const eDel = readHistory(root).find((e) => e.op === 'delete')!
  await applyDirection(root, resolve, eDel.id, 'undo')
  check('undo delete brings note two back', !note(host, id2)!.deleted)

  // Undo everything still live -> clean slate (nothing renders).
  const reversed = await undoAll(root, resolve)
  check('undo-all reverses the remaining live entries', reversed > 0)
  check('undo-all reaches a clean slate', live(host).length === 0)

  console.log(fails === 0 ? '\n  ✓ history engine verified' : `\n  ✗ ${fails} failed`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
