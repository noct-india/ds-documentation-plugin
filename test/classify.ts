// Playground for tuning the auto-categoriser.
//
//   npm run classify -- "Never use this for destructive actions"
//   npm run classify -- variable "The darkest neutral, for maximum contrast"
//
// Defaults to componentSet, since components have the widest category set.
// When a note here files somewhere you disagree with, add it as a case in
// selftest.ts first, then tune the weights in src/shared/classify.ts until it
// passes — that way the fix cannot regress later.

import { classifySegments } from '../src/shared/classify'
import { sectionsFor, type EntityKind } from '../src/shared/types'

const KINDS: EntityKind[] = [
  'variable',
  'collection',
  'paintStyle',
  'textStyle',
  'effectStyle',
  'component',
  'componentSet',
  'project',
]

const args = process.argv.slice(2)
const maybeKind = args[0] as EntityKind
const kind: EntityKind = KINDS.indexOf(maybeKind) !== -1 ? maybeKind : 'componentSet'
const text = (KINDS.indexOf(maybeKind) !== -1 ? args.slice(1) : args).join(' ')

if (!text) {
  console.log('\n  Usage: npm run classify -- [kind] "your note text"')
  console.log(`  Kinds: ${KINDS.join(', ')}\n`)
  process.exit(1)
}

const segments = classifySegments(text, kind)

console.log(`\n  "${text}"\n`)
console.log(`  kind       ${kind}`)
console.log(`  available  ${sectionsFor(kind).join(' · ')}`)
console.log(
  `  files as   ${segments.length} note${segments.length === 1 ? '' : 's'}\n`
)
for (const segment of segments) {
  console.log(`    ${segment.section.padEnd(10)} ${segment.text}`)
}
console.log()
