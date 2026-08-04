// Checks that a draft survives the round trip for the id shape that was failing.
//
// Folder ids embed a  separator, so the old prompt — which asked the model
// to echo the id back — dropped every note for a folder. Refs are integers, so
// the id never leaves this process.
//
//   node refcheck.mjs

import { draftRequest } from './draft.mjs'

const SEP = ''
const folderId = ['folder', 'textStyle', 'Display'].join(SEP)

const got = []
const summary = await draftRequest({
  items: [
    {
      entityId: folderId,
      entityKind: 'folder',
      name: 'Display',
      typeLabel: 'folder in Text styles',
      existingNotes: [],
      siblings: ['Display/Large', 'Display/Medium', 'Display/Small'],
      ancestry: [{ name: 'Text styles', kind: 'style group', notes: [] }],
    },
  ],
  context: {
    fileName: 'Webapp DS',
    brief: 'A dense trading terminal used by professionals all day.',
    componentNames: [],
    styleGroups: { color: [], text: ['Display/Large'], effect: [] },
    collections: [],
    projectNotes: [],
  },
  model: 'haiku',
  log: (m) => console.log('  log:', m),
  onBatch: (drafts) => got.push(...drafts),
})

const idsIntact = got.length > 0 && got.every((g) => g.entityId === folderId)
const kindsKept = got.length > 0 && got.every((g) => g.entityKind === 'folder')

console.log(`\n  drafted        : ${summary.drafted} (failed ${summary.failed})`)
console.log(`  id survived    : ${idsIntact}`)
console.log(`  kind survived  : ${kindsKept}`)
for (const g of got.slice(0, 4)) {
  console.log(`    ${String(g.section).padEnd(9)} ${g.text.slice(0, 92)}`)
}

const ok = summary.drafted > 0 && idsIntact && kindsKept
console.log(ok ? '\n  ✓ round trip intact\n' : '\n  ✗ still dropping notes\n')
process.exit(ok ? 0 : 1)
