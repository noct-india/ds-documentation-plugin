// Self-test for the pure logic — storage encoding, the folder-tree parser,
// slugging and markdown rendering.
//
// The plugin itself can only be exercised inside Figma, but everything that is
// easy to get subtly wrong is plain data transformation and can be checked
// here. Run with `npm test`.

import {
  appendDrafts,
  appendNote,
  approveDrafts,
  clearBody,
  draftCount,
  editNote,
  findNotesMatching,
  insertUnderHeading,
  countDocumented,
  liveNoteCount,
  planVariantMigration,
  readBody,
  readLog,
  softDeleteNote,
  writeBody,
  type PluginDataHost,
} from '../src/main/storage'
import { buildTree, flattenLeaves, folderAt, renderTreeOutline } from '../src/shared/tree'
import {
  describeScope,
  matchVariant,
  reconcile,
  scopeApplies,
  scopeDepth,
  scopeKey,
  scopeReach,
} from '../src/shared/variants'
import { componentDir, slug, uniqueSlugger } from '../src/shared/slug'
import { isDocumented, renderAuthoredSections, renderEntityDoc } from '../src/main/export/render'
import { classify, classifySegments, splitIntoSentences } from '../src/shared/classify'
import { cssColor, cssEffects, cssPaints, fontWeight } from '../src/main/reader/paint'
import type { EntityKind, NoteEntry, SectionKey } from '../src/shared/types'
import {
  SECTION_HEADINGS,
  SECTION_LABELS,
  SECTION_PROMPTS,
  migrateSection,
  sectionsFor,
} from '../src/shared/types'

let failures = 0
let checks = 0

function check(label: string, condition: boolean, detail?: string): void {
  checks++
  if (condition) return
  failures++
  console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
}

function section(name: string): void {
  console.log(`\n  ${name}`)
}

/** Stand-in for a Variable / style / node, with Figma's 100 kB rule enforced. */
class FakeHost implements PluginDataHost {
  private data = new Map<string, string>()
  readonly pluginId = 'ds-documentation-plugin-noct'

  getPluginData(key: string): string {
    return this.data.get(key) ?? ''
  }

  setPluginData(key: string, value: string): void {
    // Figma measures the whole entry in bytes and throws past 100 kB.
    const bytes = Buffer.byteLength(this.pluginId + key + value, 'utf8')
    if (bytes > 100_000) {
      throw new Error(`in setPluginData: This pluginData entry exceeds 100 kB per entry limit.`)
    }
    this.data.set(key, value)
  }

  get keyCount(): number {
    return [...this.data.values()].filter((v) => v !== '').length
  }
}

// A minimal `figma` global so storage.ts can reference figma.root if it wants.
;(globalThis as Record<string, unknown>).figma = { root: new FakeHost() }

// ─── Storage ─────────────────────────────────────────────────────────────────

section('storage: round-trip across scripts')

const scripts: Array<[string, string]> = [
  ['ascii', 'Use this token for primary actions only.'],
  ['devanagari', 'यह टोकन केवल मुख्य क्रियाओं के लिए प्रयोग करें।'],
  ['emoji', 'Primary CTA only 🎨✨ — never for destructive actions 🚫'],
  ['mixed', 'Heading 1 — शीर्षक — always at the top of a page ✅'],
  ['quotes', 'Do NOT use "secondary" or \'ghost\' — those variants don\'t exist.'],
  ['newlines', 'Line one\nLine two\n\tTabbed'],
]

for (const [label, text] of scripts) {
  const host = new FakeHost()
  appendNote(host, 'variable', 'neutral-1000', text, 'rules', 'Tester')
  const log = readLog(host)
  check(`${label}: survives a round-trip`, log.length === 1 && log[0].text === text,
    log[0] ? `got: ${JSON.stringify(log[0].text)}` : 'no entry')
}

section('storage: large payloads stay under the 100 kB per-entry limit')

// The case that motivated ASCII-escaping: 3 bytes per character in UTF-8.
const bigDevanagari = 'नियम '.repeat(30_000) // ~150k chars, ~450 kB raw
const bigEmoji = '🎨'.repeat(30_000)
const bigAscii = 'rule '.repeat(40_000)

for (const [label, text] of [
  ['devanagari', bigDevanagari],
  ['emoji', bigEmoji],
  ['ascii', bigAscii],
] as Array<[string, string]>) {
  const host = new FakeHost()
  let threw: string | null = null
  try {
    appendNote(host, 'variable', 'big', text, 'notes', 'Tester')
  } catch (err) {
    threw = (err as Error).message
  }
  check(`${label}: ${text.length} chars writes without throwing`, threw === null, threw ?? '')
  if (!threw) {
    const log = readLog(host)
    check(`${label}: reads back byte-identical`, log[0]?.text === text)
  }
}

section('storage: append-only behaviour')

{
  const host = new FakeHost()
  appendNote(host, 'variable', 'x', 'first rule', 'rules', 'A')
  appendNote(host, 'variable', 'x', 'second rule', 'instead', 'B')
  appendNote(host, 'variable', 'x', 'third rule', 'donts', 'A')
  const log = readLog(host)
  check('three notes accumulate', log.length === 3)
  check('order is preserved', log.map((e) => e.text).join('|') === 'first rule|second rule|third rule')
  check('sections are kept per note', log[1].section === 'instead')

  const after = softDeleteNote(host, 'variable', 'x', log[1].id)
  check('soft delete keeps the original text', after[1].text === 'second rule')
  check('soft delete marks rather than removes', after.length === 3 && after[1].deleted === true)
  check('live count excludes hidden notes', liveNoteCount(after) === 2)
}

section('storage: shrinking payload clears stale chunks')

{
  // A long note spans several chunks; replacing it with a short log must not
  // leave a trailing chunk behind for the next read to concatenate.
  const host = new FakeHost()
  appendNote(host, 'variable', 'x', 'a'.repeat(200_000), 'notes', 'A')
  const before = host.keyCount
  const log = readLog(host)
  softDeleteNote(host, 'variable', 'x', log[0].id)

  // Rewrite with a tiny log by starting fresh on the same host.
  const host2 = new FakeHost()
  appendNote(host2, 'variable', 'x', 'b'.repeat(200_000), 'notes', 'A')
  const big = readLog(host2)
  big.length = 0
  // Simulate a shrink by writing a one-entry log over the multi-chunk one.
  appendNote(host2, 'variable', 'x', 'tiny', 'notes', 'A')

  check('multi-chunk write used more than one chunk', before > 2, `keys: ${before}`)
  const reread = readLog(host2)
  check(
    'no stale chunk leaks into the re-read',
    reread.every((e) => typeof e.text === 'string'),
    JSON.stringify(reread).slice(0, 120)
  )
}

// ─── Tree ────────────────────────────────────────────────────────────────────

section('tree: slash names become folders')

{
  const tree = buildTree([
    { entityId: '1', entityKind: 'paintStyle', name: 'illustration/spot/blue', noteCount: 1 },
    { entityId: '2', entityKind: 'paintStyle', name: 'illustration/spot/green', noteCount: 0 },
    { entityId: '3', entityKind: 'paintStyle', name: 'illustration/flat/amber', noteCount: 0 },
    { entityId: '4', entityKind: 'paintStyle', name: 'surface/card', noteCount: 2 },
    { entityId: '5', entityKind: 'paintStyle', name: 'ungrouped', noteCount: 0 },
  ])

  check('top level has two folders and one leaf', tree.length === 3)

  // Order follows Figma, not the alphabet: a folder takes the position of its
  // first member, so "illustration" leads because illustration/spot/blue did.
  check(
    'input order is preserved',
    tree.map((n) => n.name).join(',') === 'illustration,surface,ungrouped',
    tree.map((n) => n.name).join(',')
  )

  const illustration = tree[0]
  check('folder name is the segment', illustration.kind === 'folder' && illustration.name === 'illustration')
  check(
    'leaf counts roll up through nesting',
    illustration.kind === 'folder' && illustration.leafCount === 3,
    illustration.kind === 'folder' ? `got ${illustration.leafCount}` : ''
  )
  check(
    'documented counts roll up',
    illustration.kind === 'folder' && illustration.documentedCount === 1
  )

  const spot = folderAt(tree, 'illustration/spot')
  check('folderAt reaches a nested level', spot !== null && spot.length === 2)
  check('folderAt on a missing path returns null', folderAt(tree, 'nope/nope') === null)
  check('folderAt with an empty path returns the root', folderAt(tree, '') === tree)

  check('flattenLeaves finds every leaf', flattenLeaves(tree).length === 5)

  const outline = renderTreeOutline(tree)
  check('outline indents nested folders', outline.includes('  spot/'), outline)
  check('outline keeps leaf names', outline.includes('    blue'), outline)

  // A leaf declared before a folder must stay before it.
  const mixed = buildTree([
    { entityId: '1', entityKind: 'variable', name: 'red', noteCount: 0 },
    { entityId: '2', entityKind: 'variable', name: 'blue/500', noteCount: 0 },
    { entityId: '3', entityKind: 'variable', name: 'blue/700', noteCount: 0 },
    { entityId: '4', entityKind: 'variable', name: 'green', noteCount: 0 },
  ])
  check(
    'a leaf before a folder keeps its place',
    mixed.map((n) => n.name).join(',') === 'red,blue,green',
    mixed.map((n) => n.name).join(',')
  )
  const blue = mixed[1]
  check(
    'members keep their declared order inside a folder',
    blue.kind === 'folder' && blue.children.map((c) => c.name).join(',') === '500,700'
  )
}

section('tree: awkward names')

{
  const tree = buildTree([
    { entityId: '1', entityKind: 'variable', name: 'no-slashes', noteCount: 0 },
    { entityId: '2', entityKind: 'variable', name: '/leading', noteCount: 0 },
    { entityId: '3', entityKind: 'variable', name: 'trailing/', noteCount: 0 },
    { entityId: '4', entityKind: 'variable', name: 'a//double', noteCount: 0 },
  ])
  check('every awkward name still produces a reachable leaf', flattenLeaves(tree).length === 4)
  const names = flattenLeaves(tree).map((l) => l.name)
  check('empty segments are dropped, not rendered blank', !names.includes(''), names.join(','))
}

// ─── Slugs ───────────────────────────────────────────────────────────────────

section('slug: filenames')

check('spaces and case are stripped', slug('Primitive Colors') === 'primitivecolors')
check('slashes become hyphens', slug('Button/Primary') === 'button-primary')
check('punctuation is dropped', slug('Fill / usage-specific!') === 'fill-usage-specific')
check('an empty name still yields a filename', slug('???') === 'untitled')

section('slug: component folders mirror the Figma file')

{
  check(
    'page and section become folders',
    componentDir('✅ Icons', 'Navigation') === 'components/icons/navigation'
  )
  check(
    'a loose component gets no section folder',
    componentDir('Icons', null) === 'components/icons'
  )
  // Page names carry status emoji constantly ("✅ Icons"); those must not reach
  // the filesystem. Spaces are dropped rather than hyphenated, matching the
  // filename rule ("Primitive Colors" → primitivecolors.md); only "/" becomes
  // a hyphen, since it already means nesting in Figma.
  check(
    'emoji and punctuation are stripped from folder names',
    componentDir('🎨 Actions & Inputs', 'Buttons / Primary') ===
      'components/actionsinputs/buttons-primary',
    componentDir('🎨 Actions & Inputs', 'Buttons / Primary')
  )
  check('a status emoji prefix disappears', componentDir('✅ Icons', null) === 'components/icons')
  check('an unnamed page still yields a folder', componentDir('', null) === 'components/untitled')

  // Uniqueness is now per folder, so the same name on two pages is fine.
  const icons = uniqueSlugger()
  const shapes = uniqueSlugger()
  check('same name in two folders keeps its name', icons('Box') === 'box' && shapes('Box') === 'box')
  check('a repeat within one folder is still suffixed', icons('Box') === 'box-2')
}

section('slug: filename collisions')

{
  const next = uniqueSlugger()
  check('first use is unsuffixed', next('Button') === 'button')
  check('a collision is suffixed', next('Button') === 'button-2')
  check('a third collision increments', next('button') === 'button-3')
  check('an unrelated name is unaffected', next('Checkbox') === 'checkbox')
}

// ─── Rendering ───────────────────────────────────────────────────────────────

section('render: markdown')

{
  const log: NoteEntry[] = [
    { id: '1', ts: 1, author: 'A', section: 'rules', text: 'Only one primary button per section.' },
    { id: '2', ts: 2, author: 'A', section: 'donts', text: 'Never use for destructive actions.' },
    { id: '3', ts: 3, author: 'A', section: 'rules', text: 'Hidden', deleted: true },
    { id: '4', ts: 4, author: 'A', section: 'instead', text: 'For navigation use Link.' },
    { id: '5', ts: 5, author: 'A', section: 'states', text: 'Disabled needs a tooltip saying why.' },
    // Written under the retired "Do" key — must land in Rules, not Notes.
    { id: '6', ts: 6, author: 'A', section: 'dos' as SectionKey, text: 'Legacy do entry.' },
  ]

  const md = renderEntityDoc(
    'Button',
    'componentSet',
    {
      typeLabel: 'Component set',
      variantCount: 176,
      properties: [
        { key: 'Type', displayName: 'Type', type: 'VARIANT', defaultValue: 'Primary', options: ['Primary', 'Secondary'] },
        { key: 'Icon#0:0', displayName: 'Icon', type: 'BOOLEAN', defaultValue: 'false' },
      ],
      nestedComponents: ['Icon'],
    },
    log,
    { includeEmptySections: false }
  )

  check('title renders', md.startsWith('# Button'), md.split('\n')[0])
  check('variant count appears', md.includes('176 variants'))
  check('property table renders', md.includes('| `Type` | VARIANT |'), md)
  check('the #uniqueId suffix is hidden from display', md.includes('| `Icon` |') && !md.includes('Icon#0:0'))
  check('authored rules render', md.includes('- Only one primary button per section.'))
  check("don'ts render under their own heading", md.includes("## Don't"))
  check('soft-deleted notes are excluded', !md.includes('Hidden'))
  check('empty sections are omitted when exporting', !md.includes('## Purpose'))
  check('nested components are listed', md.includes('Nests: `Icon`'))
  check('the redirect category uses its long heading', md.includes('## Use instead'), md)
  check('states render for a component', md.includes('## States'))
  check('a legacy "dos" note lands in Rules', md.includes('- Legacy do entry.'))
  check(
    'a legacy "dos" note does NOT fall through to Notes',
    md.indexOf('- Legacy do entry.') < md.indexOf('## Notes') || !md.includes('## Notes'),
    md
  )
  check(
    'sections follow the component order, not declaration order',
    md.indexOf('## Use instead') < md.indexOf('## States') &&
      md.indexOf('## States') < md.indexOf('## Rules'),
    md
  )
}

section('render: categories adapt to entity kind')

{
  const states: NoteEntry[] = [
    { id: '1', ts: 1, author: 'A', section: 'states', text: 'Shows a spinner while loading.' },
  ]

  // "States" is not in the variable set, but a note filed there must still
  // render — dropping it would break the never-lose-anything guarantee.
  const asVariable = renderEntityDoc('tok', 'variable', { typeLabel: 'COLOR' }, states, {
    includeEmptySections: false,
  })
  check('an out-of-set note still renders', asVariable.includes('## States'), asVariable)

  const emptyVariable = renderEntityDoc('tok', 'variable', { typeLabel: 'COLOR' }, [], {
    includeEmptySections: true,
  })
  check('variables do not prompt for States', !emptyVariable.includes('## States'), emptyVariable)
  check('variables do prompt for Use instead', emptyVariable.includes('## Use instead'))

  const emptyComponent = renderEntityDoc('C', 'component', { typeLabel: 'Component' }, [], {
    includeEmptySections: true,
  })
  check('components prompt for States', emptyComponent.includes('## States'))
  check('components prompt for Content', emptyComponent.includes('## Content and wording'))

  const emptyProject = renderEntityDoc('P', 'project', { typeLabel: 'Project' }, [], {
    includeEmptySections: true,
  })
  check('project prompts for Product character', emptyProject.includes('## Product character'))
  check('project does not prompt for When to use', !emptyProject.includes('## When to use'))

  const emptyCollection = renderEntityDoc('Col', 'collection', { typeLabel: 'Collection' }, [], {
    includeEmptySections: true,
  })
  check('collections prompt for Modes', emptyCollection.includes('## Modes'))
  check('collections prompt for Naming', emptyCollection.includes('## Naming convention'))
}

section('categories: no gaps in the lookup tables')

{
  for (const kind of [
    'variable',
    'collection',
    'paintStyle',
    'textStyle',
    'effectStyle',
    'component',
    'componentSet',
    'project',
  ] as const) {
    const set = sectionsFor(kind)
    check(`${kind}: has a category set`, set.length > 0)
    check(`${kind}: ends with Notes as the escape hatch`, set[set.length - 1] === 'notes')
    for (const key of set) {
      check(`${kind}/${key}: has a chip label`, Boolean(SECTION_LABELS[key]))
      check(`${kind}/${key}: has a markdown heading`, Boolean(SECTION_HEADINGS[key]))
      check(`${kind}/${key}: has a prompt question`, Boolean(SECTION_PROMPTS[key]))
    }
  }
  check('a retired key maps onto a live one', migrateSection('dos') === 'rules')
  check('an unknown key falls back to Notes', migrateSection('nonsense') === 'notes')
  check('a live key is left alone', migrateSection('states') === 'states')
}

section('render: table cells survive hostile input')

{
  const md = renderEntityDoc(
    'weird',
    'variable',
    {
      typeLabel: 'STRING',
      modeValues: [
        { modeName: 'Light | Dark', value: 'a | b' },
        { modeName: 'Multi', value: 'line one\nline two' },
      ],
    },
    [],
    { includeEmptySections: false }
  )
  const tableRows = md.split('\n').filter((l) => l.startsWith('|'))
  for (const row of tableRows) {
    const unescaped = row.replace(/\\\|/g, '')
    check(
      `row keeps exactly 2 columns: ${row.slice(0, 40)}`,
      (unescaped.match(/\|/g) ?? []).length === 3,
      row
    )
  }
  check('newlines never reach a table cell', !tableRows.some((r) => r.includes('\n')))
}

section('render: undocumented items are flagged, not faked')

{
  const md = renderEntityDoc('lonely', 'variable', { typeLabel: 'COLOR' }, [], {
    includeEmptySections: false,
  })
  check('an undocumented entity carries a warning', md.includes('Not documented yet'), md)
}

// ─── Classifier ──────────────────────────────────────────────────────────────

section('classify: real notes land where a designer would file them')

{
  // The first three are verbatim from the first in-Figma session, together with
  // the category the designer picked by hand.
  const cases: Array<[EntityKind, string, SectionKey]> = [
    ['componentSet', 'Used to dictate icon sizes across the product', 'purpose'],
    [
      'componentSet',
      'All icons in the product should be used as an instance swap within the icon wrapper',
      'usage',
    ],
    [
      'componentSet',
      "Always swap the placeholder rectangle icon with an actual icon. Don't use the icon wrapper as it is",
      'rules',
    ],

    ['componentSet', 'Only one primary button per visible section', 'rules'],
    ['componentSet', 'For navigation use Link, not Button', 'instead'],
    ['componentSet', 'Disabled must be paired with a tooltip explaining why', 'states'],
    ['componentSet', 'Sentence case, verb first, three words maximum', 'content'],
    ['componentSet', 'Never use Tertiary for a destructive action', 'donts'],
    ['componentSet', 'Sits inside a Button group when there is more than one action', 'pairs'],
    // A redirect outranks the prohibition it travels with.
    ["componentSet", "Don't use a bare button. Use the Button component instead.", 'instead'],
    ['variable', 'The darkest neutral, for maximum contrast on text and icons', 'purpose'],
    ['variable', 'Never reference this hex directly, go through the semantic alias', 'donts'],
    // Verbatim from a session — was landing in Notes because the purpose
    // patterns only knew "used to", not "used in", and the definitional opener
    // required "is a/an/the" rather than "These are".
    [
      'componentSet',
      'These are icons used in the main navigation of the product',
      'purpose',
    ],
    ['componentSet', 'This is the primary control for committing an action', 'purpose'],
    ['textStyle', 'Used for section headings throughout the app', 'purpose'],
    // A prohibition is the operative content even when the sentence is phrased
    // as a description, so this must not be read as a purpose.
    ['componentSet', 'These are never used for destructive actions', 'donts'],
    ['collection', 'Light is the source of truth, dark is derived', 'modes'],
    ['collection', 'Named family/weight where weight runs 100 to 1000', 'naming'],
    ['project', 'Breathable density with generous whitespace', 'character'],
  ]

  for (const [kind, text, expected] of cases) {
    const got = classify(text, kind)
    check(`${expected.padEnd(9)} ← "${text.slice(0, 44)}…"`, got.section === expected, `got ${got.section}`)
  }
}

section('classify: stays inside the categories that kind allows')

{
  // "Disabled" is a states signal, but a variable has no States category — it
  // must not be filed somewhere that will never render.
  const onVariable = classify('Disabled state uses this token', 'variable')
  check(
    'a states note on a variable falls to an allowed category',
    sectionsFor('variable').indexOf(onVariable.section) !== -1,
    `got ${onVariable.section}`
  )

  const onProject = classify('For navigation use Link instead', 'project')
  check(
    'an instead note on the project falls to an allowed category',
    sectionsFor('project').indexOf(onProject.section) !== -1,
    `got ${onProject.section}`
  )

  for (const kind of ['variable', 'collection', 'component', 'project'] as const) {
    const result = classify('completely unremarkable sentence fragment', kind)
    check(
      `${kind}: an unmatched note still gets an allowed category`,
      sectionsFor(kind).indexOf(result.section) !== -1
    )
  }
}

section('classify: reports low confidence honestly')

{
  check('a note with no signal is not confident', !classify('it goes at the top', 'component').confident)
  check('an empty note is not confident', !classify('   ', 'component').confident)
  check('a clear note is confident', classify('Never use this for destructive actions', 'component').confident)
}

section('classify: patterns are stateless across calls')

{
  // A `g` flag on any pattern would make every second call miss.
  const text = 'Never use Tertiary for a destructive action'
  const runs = [1, 2, 3].map(() => classify(text, 'componentSet').section)
  check('repeated calls agree', new Set(runs).size === 1, runs.join(','))
}

// ─── Sentence splitting ──────────────────────────────────────────────────────

section('classify: sentence splitting')

{
  const split = (t: string) => splitIntoSentences(t)
  check('a single sentence stays whole', split('Only one primary per section').length === 1)
  check('two sentences split', split('Always do this. Never do that.').length === 2)
  check('a decimal is not a sentence end', split('Spacing is 1.5 rem and fixed.').length === 1,
    JSON.stringify(split('Spacing is 1.5 rem and fixed.')))
  check('an abbreviation is not a sentence end', split('Use e.g. the primary variant.').length === 1,
    JSON.stringify(split('Use e.g. the primary variant.')))
  check('a lowercase continuation does not split', split('Sizes are 28 px. and 36 on desktop.').length === 1,
    JSON.stringify(split('Sizes are 28 px. and 36 on desktop.')))
  check('"?!" ends one sentence, not three', split('Really?! Never do that.').length === 2)
  check('newlines are hard breaks', split('First line\nSecond line').length === 2)
  check('trailing whitespace produces no empty sentence', split('One. Two.  ').length === 2)
  check('an empty string yields nothing', split('   ').length === 0)
}

section('classify: segments keep dependent sentences together')

{
  const seg = (t: string, k: EntityKind = 'componentSet') => classifySegments(t, k)

  const twoRules = seg("Always swap the placeholder icon with a real one. Don't use the wrapper as it is")
  check('a rule and a don\'t split apart', twoRules.length === 2, JSON.stringify(twoRules))
  check('the rule half lands in Rules', twoRules[0]?.section === 'rules')
  check("the don't half lands in Don't", twoRules[1]?.section === 'donts')

  // The whole point of the back-reference rule: "It" has nothing to refer to
  // once separated, so the sentences must stay welded.
  const backRef = seg('Used to dictate icon sizes. It should never be edited directly.')
  check('a back-referencing sentence stays attached', backRef.length === 1, JSON.stringify(backRef))
  check('the merged segment keeps both sentences',
    backRef[0].text.indexOf('It should never') !== -1)

  const fragment = seg('Never do this. Ever.')
  check('a short fragment stays attached', fragment.length === 1, JSON.stringify(fragment))

  const standalone = seg('Only one primary per section. Never hand-space them.')
  check('a three-word instruction stands alone', standalone.length === 2, JSON.stringify(standalone))

  const threeWay = seg('Use for any committing action. For navigation use Link instead. Labels are sentence case.')
  check('three categories split three ways', threeWay.length === 3, JSON.stringify(threeWay))
  check('order is preserved', threeWay[0].section === 'usage' && threeWay[1].section === 'instead')

  const sameCategory = seg('Always use tokens. Always check contrast.')
  check('adjacent same-category sentences merge', sameCategory.length === 1, JSON.stringify(sameCategory))

  // Nothing typed may be dropped, whatever the splitting does.
  const original = "Always swap the placeholder icon with a real one. Don't use the wrapper as it is"
  const rejoined = twoRules.map((s) => s.text).join(' ')
  check('splitting loses no words', rejoined === original, rejoined)

  check('an empty note yields no segments', seg('   ').length === 0)
  check('a single sentence yields one segment', seg('Only one primary per section').length === 1)
}

// ─── Hand-edited body ────────────────────────────────────────────────────────

section('storage: inserting into an edited body')

{
  const body = ['## Purpose', '', '- The main action.', '', '## Rules', '', '- Only one primary.', ''].join('\n')

  const added = insertUnderHeading(body, 'Rules', ['- Never mix sizes.'])
  check('the bullet lands under the right heading',
    added.indexOf('- Only one primary.\n- Never mix sizes.') !== -1, added)
  check('the other section is untouched', added.indexOf('- The main action.') !== -1)

  const newSection = insertUnderHeading(body, "Don't", ['- Not for navigation.'])
  check('a missing heading is created', newSection.indexOf("## Don't") !== -1, newSection)
  check('the new bullet follows its heading',
    newSection.indexOf("## Don't") < newSection.indexOf('- Not for navigation.'))

  const intoEmpty = insertUnderHeading('', 'Purpose', ['- First note.'])
  check('an empty body gets a heading and a bullet',
    intoEmpty.indexOf('## Purpose') !== -1 && intoEmpty.indexOf('- First note.') !== -1, intoEmpty)

  check('no bullets is a no-op', insertUnderHeading(body, 'Rules', []) === body)

  // A bullet must join the list, not land after the blank line that separates
  // one section from the next.
  const trailing = insertUnderHeading('## Rules\n\n- One.\n\n', 'Rules', ['- Two.'])
  check('a trailing blank line does not swallow the bullet',
    trailing.indexOf('- One.\n- Two.') !== -1, JSON.stringify(trailing))
}

section('storage: a hand-edited body survives new notes')

{
  const host = new FakeHost()
  appendNote(host, 'component', 'Button', 'The main action.', 'purpose', 'A')
  check('body starts underived', readBody(host) === null)

  writeBody(host, 'component', 'Button', '## Purpose\n\n- Hand-written wording.\n')
  check('an edited body reads back', readBody(host) === '## Purpose\n\n- Hand-written wording.\n')

  // The log keeps accumulating underneath regardless.
  appendNote(host, 'component', 'Button', 'Never for navigation.', 'donts', 'A')
  check('the log still grows under an edited body', readLog(host).length === 2)
  check('the edit is not clobbered by a new note',
    (readBody(host) ?? '').indexOf('Hand-written wording.') !== -1)

  clearBody(host)
  check('clearing the override restores derivation', readBody(host) === null)
  check('clearing does not touch the notes', readLog(host).length === 2)
}

// ─── Batch ───────────────────────────────────────────────────────────────────

section('batch: appending to many components touches nothing existing')

{
  // Three components in the state a real selection would be in: one already
  // documented, one lightly documented, one untouched.
  const button = new FakeHost()
  const checkbox = new FakeHost()
  const toggle = new FakeHost()

  appendNote(button, 'componentSet', 'Button', 'The main action.', 'purpose', 'Anusha')
  appendNote(button, 'componentSet', 'Button', 'Only one primary per section.', 'rules', 'Anusha')
  appendNote(checkbox, 'componentSet', 'Checkbox', 'Never nest inside a row.', 'donts', 'Gowtham')

  const before = {
    button: JSON.stringify(readLog(button)),
    checkbox: JSON.stringify(readLog(checkbox)),
  }

  // The same note goes to all three, exactly as the batch screen sends it.
  const entries: Array<{ text: string; section: SectionKey }> = [
    { text: 'All interactive controls need a visible focus ring.', section: 'rules' },
    { text: 'Never remove the focus outline.', section: 'donts' },
  ]
  for (const host of [button, checkbox, toggle]) {
    for (const entry of entries) {
      appendNote(host, 'componentSet', 'x', entry.text, entry.section, 'Anusha')
    }
  }

  const buttonAfter = readLog(button)
  const checkboxAfter = readLog(checkbox)
  const toggleAfter = readLog(toggle)

  check('a documented component keeps every prior note', buttonAfter.length === 4)
  check(
    'prior notes are byte-identical afterwards',
    JSON.stringify(buttonAfter.slice(0, 2)) === before.button,
    JSON.stringify(buttonAfter.slice(0, 2))
  )
  check(
    "another component's prior note is untouched",
    JSON.stringify(checkboxAfter.slice(0, 1)) === before.checkbox
  )
  check('an undocumented component receives only the new notes', toggleAfter.length === 2)
  check('every target got the same wording', toggleAfter[0].text === entries[0].text)
  check('the batch keeps its categories', toggleAfter[1].section === 'donts')
  check(
    'prior authorship survives',
    buttonAfter[0].author === 'Anusha' && checkboxAfter[0].author === 'Gowtham'
  )

  // Ids must not collide across targets, or re-filing or hiding one note would
  // hit the wrong entry on another component.
  const allIds = buttonAfter
    .concat(checkboxAfter, toggleAfter)
    .map((e) => e.id)
  check('note ids are unique across the batch', new Set(allIds).size === allIds.length)
}

section('notes: editing keeps the wording it replaced')

{
  const host = new FakeHost()
  appendNote(host, 'componentSet', 'Button', 'Only one primary per page.', 'rules', 'Anusha')
  const [note] = readLog(host)

  editNote(host, 'componentSet', 'Button', note.id, 'Only one primary per section.', 'Gowtham')
  const after = readLog(host)

  check('the new wording is live', after[0].text === 'Only one primary per section.')
  check('the previous wording is kept', after[0].revisions?.[0].text === 'Only one primary per page.')
  check('the edit is attributed', after[0].revisions?.[0].author === 'Gowtham')
  check('the original author is unchanged', after[0].author === 'Anusha')
  check('the note keeps its id', after[0].id === note.id)
  check('the note keeps its category', after[0].section === 'rules')
  check('no extra note is created', after.length === 1)

  // A second edit stacks rather than replacing the first revision.
  editNote(host, 'componentSet', 'Button', note.id, 'Exactly one primary per section.', 'Anusha')
  const twice = readLog(host)
  check('revisions accumulate', twice[0].revisions?.length === 2)
  check('revisions are oldest first',
    twice[0].revisions?.[0].text === 'Only one primary per page.' &&
      twice[0].revisions?.[1].text === 'Only one primary per section.')

  // Editing to the same text, or to nothing, must not manufacture a revision.
  editNote(host, 'componentSet', 'Button', note.id, 'Exactly one primary per section.', 'A')
  check('an unchanged edit is a no-op', readLog(host)[0].revisions?.length === 2)
  editNote(host, 'componentSet', 'Button', note.id, '   ', 'A')
  check('an empty edit is refused', readLog(host)[0].text === 'Exactly one primary per section.')
}

section('notes: matching a shared note across components')

{
  // What a batch edit does: find the same wording on each component by what it
  // says, since a batch note has a different id on every one of them.
  const a = new FakeHost()
  const b = new FakeHost()
  appendNote(a, 'componentSet', 'nav-home', 'Used in the main navigation.', 'purpose', 'A')
  appendNote(b, 'componentSet', 'nav-trading', 'Used in the main navigation.', 'purpose', 'A')
  appendNote(b, 'componentSet', 'nav-trading', 'Only on the trading page.', 'rules', 'A')

  const inA = findNotesMatching(readLog(a), 'purpose', 'Used in the main navigation.')
  const inB = findNotesMatching(readLog(b), 'purpose', 'Used in the main navigation.')
  check('the shared note is found on both', inA.length === 1 && inB.length === 1)
  check('their ids differ', inA[0].id !== inB[0].id)

  check(
    'a non-shared note is not matched',
    findNotesMatching(readLog(a), 'rules', 'Only on the trading page.').length === 0
  )
  check(
    'the category is part of the match',
    findNotesMatching(readLog(a), 'rules', 'Used in the main navigation.').length === 0
  )

  // Editing on both should leave each component's other notes alone.
  for (const [host, name] of [
    [a, 'nav-home'],
    [b, 'nav-trading'],
  ] as Array<[FakeHost, string]>) {
    for (const match of findNotesMatching(readLog(host), 'purpose', 'Used in the main navigation.')) {
      editNote(host, 'componentSet', name, match.id, 'Used in the primary nav rail.', 'A')
    }
  }
  check('both were reworded', readLog(a)[0].text === 'Used in the primary nav rail.' &&
    readLog(b)[0].text === 'Used in the primary nav rail.')
  check("the unshared note is untouched", readLog(b)[1].text === 'Only on the trading page.')

  // A hidden note must not be picked up by a later batch edit.
  softDeleteNote(a, 'componentSet', 'nav-home', readLog(a)[0].id)
  check(
    'a hidden note is no longer matched',
    findNotesMatching(readLog(a), 'purpose', 'Used in the primary nav rail.').length === 0
  )
}

section('batch: a hand-edited target keeps its edit')

{
  const host = new FakeHost()
  appendNote(host, 'componentSet', 'Button', 'The main action.', 'purpose', 'A')
  writeBody(host, 'componentSet', 'Button', '## Purpose\n\n- Carefully reworded by hand.\n')

  // What the batch path does per target: append, then merge into the override.
  appendNote(host, 'componentSet', 'Button', 'Never remove the focus ring.', 'donts', 'A')
  const merged = insertUnderHeading(readBody(host) ?? '', "Don't", [
    '- Never remove the focus ring.',
  ])
  writeBody(host, 'componentSet', 'Button', merged)

  const body = readBody(host) ?? ''
  check('the hand-written wording survives a batch note',
    body.indexOf('Carefully reworded by hand.') !== -1, body)
  check('the batch note is merged in', body.indexOf('- Never remove the focus ring.') !== -1)
  check('the log holds both notes', readLog(host).length === 2)
}

// ─── Swatches ────────────────────────────────────────────────────────────────

section('paint: colours become CSS')

{
  check('an opaque colour drops the alpha channel',
    cssColor({ r: 1, g: 0, b: 0, a: 1 }) === 'rgb(255, 0, 0)', cssColor({ r: 1, g: 0, b: 0, a: 1 }))
  check('a semi-transparent colour keeps it',
    cssColor({ r: 0, g: 0, b: 0, a: 0.5 }) === 'rgba(0, 0, 0, 0.5)', cssColor({ r: 0, g: 0, b: 0, a: 0.5 }))
  check('an RGB without alpha is opaque',
    cssColor({ r: 0, g: 0, b: 1 }) === 'rgb(0, 0, 255)')
  check('paint opacity multiplies into alpha',
    cssColor({ r: 0, g: 0, b: 0, a: 0.5 }, 0.5) === 'rgba(0, 0, 0, 0.25)')
  // Figma occasionally hands back values a hair outside 0–1.
  check('out-of-range channels clamp',
    cssColor({ r: 1.02, g: -0.01, b: 0.5 }) === 'rgb(255, 0, 128)', cssColor({ r: 1.02, g: -0.01, b: 0.5 }))
}

section('paint: fills become CSS backgrounds')

{
  const solid: Paint = { type: 'SOLID', color: { r: 1, g: 1, b: 1 } } as Paint
  check('a solid fill renders', cssPaints([solid]) === 'rgb(255, 255, 255)')

  const hidden = { ...solid, visible: false } as Paint
  check('a hidden fill is skipped', cssPaints([hidden, solid]) === 'rgb(255, 255, 255)')
  check('only-hidden fills yield nothing', cssPaints([hidden]) === null)
  check('no fills yields nothing', cssPaints([]) === null)

  const image = { type: 'IMAGE', scaleMode: 'FILL' } as unknown as Paint
  check('an image fill has no CSS stand-in', cssPaints([image]) === null)
  check('a renderable fill below an image still wins', cssPaints([image, solid]) !== null)

  const gradient = {
    type: 'GRADIENT_LINEAR',
    gradientTransform: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    gradientStops: [
      { color: { r: 0, g: 0, b: 0, a: 1 }, position: 0 },
      { color: { r: 1, g: 1, b: 1, a: 1 }, position: 1 },
    ],
  } as unknown as Paint
  const css = cssPaints([gradient]) ?? ''
  check('a gradient becomes a CSS gradient', css.indexOf('linear-gradient(') === 0, css)
  check('stops carry their positions', css.indexOf('rgb(0, 0, 0) 0%') !== -1, css)
  check('the last stop lands at 100%', css.indexOf('rgb(255, 255, 255) 100%') !== -1, css)
}

section('paint: effects become CSS')

{
  const shadow = {
    type: 'DROP_SHADOW',
    color: { r: 0, g: 0, b: 0, a: 0.25 },
    offset: { x: 0, y: 2 },
    radius: 8,
    spread: 0,
    visible: true,
  } as unknown as Effect

  const drop = cssEffects([shadow])
  check('a drop shadow renders', (drop.shadow ?? '').indexOf('0px 2px 8px 0px rgba(0, 0, 0, 0.25)') !== -1, drop.shadow ?? '')
  check('a drop shadow is not inset', (drop.shadow ?? '').indexOf('inset') === -1)

  const inner = cssEffects([{ ...shadow, type: 'INNER_SHADOW' } as unknown as Effect])
  check('an inner shadow is inset', (inner.shadow ?? '').indexOf('inset') === 0, inner.shadow ?? '')

  const blur = cssEffects([{ type: 'LAYER_BLUR', radius: 4, visible: true } as unknown as Effect])
  check('a blur becomes a filter', blur.filter === 'blur(4px)')
  // A 200px blur would swamp a 16px swatch.
  const huge = cssEffects([{ type: 'LAYER_BLUR', radius: 200, visible: true } as unknown as Effect])
  check('an extreme blur is capped for the swatch', huge.filter === 'blur(12px)', huge.filter ?? '')

  check('a hidden effect is skipped',
    cssEffects([{ ...shadow, visible: false } as unknown as Effect]).shadow === undefined)
  check('no effects yield nothing', cssEffects([]).shadow === undefined)

  const stacked = cssEffects([shadow, { ...shadow, offset: { x: 0, y: 8 } } as unknown as Effect])
  check('stacked shadows are comma-joined', (stacked.shadow ?? '').split(',').length > 4, stacked.shadow ?? '')
}

section('paint: font weights')

{
  // "Semibold" and "Extrabold" both contain "bold", so ordering decides these.
  check('Semibold is 600', fontWeight('Semibold') === 600)
  check('SemiBold with a space is 600', fontWeight('Semi Bold') === 600)
  check('Extrabold is 800', fontWeight('Extrabold') === 800)
  check('plain Bold is 700', fontWeight('Bold') === 700)
  check('Regular is 400', fontWeight('Regular') === 400)
  check('Light is 300', fontWeight('Light') === 300)
  check('Thin is 100', fontWeight('Thin') === 100)
  check('Black is 900', fontWeight('Black') === 900)
  check('an italic variant keeps its weight', fontWeight('Bold Italic') === 700)
  check('an unknown style falls back to regular', fontWeight('Condensed') === 400)
}

// ─── Drafts ──────────────────────────────────────────────────────────────────

section('drafts: never reach the export before approval')

{
  const host = new FakeHost()
  appendNote(host, 'componentSet', 'Button', 'Only one primary per section.', 'rules', 'Anusha')
  appendDrafts(
    host,
    'componentSet',
    'Button',
    [
      { text: 'Suggested: never use for navigation.', section: 'donts' },
      { text: 'Suggested: labels are sentence case.', section: 'content' },
    ],
    'Claude'
  )

  const log = readLog(host)
  check('drafts are stored', log.length === 3)
  check('drafts are flagged', log.filter((e) => e.draft).length === 2)
  check('the authored note is not flagged', log[0].draft === undefined)

  // The load-bearing guarantee: an unreviewed guess must not become a rule that
  // Figma Make follows.
  const exported = renderEntityDoc(
    'Button',
    'componentSet',
    { typeLabel: 'Component set' },
    log,
    { includeEmptySections: false }
  )
  check('the approved note exports', exported.indexOf('Only one primary per section.') !== -1)
  check('drafts do NOT export', exported.indexOf('Suggested:') === -1, exported)
  check('a draft-only category stays absent', exported.indexOf("## Don't") === -1)

  check('coverage ignores drafts', liveNoteCount(log) === 1)
  check('drafts are counted separately', draftCount(log) === 2)
}

section('drafts: an entity with only drafts is undocumented')

{
  const host = new FakeHost()
  appendDrafts(host, 'variable', 'blue-500', [{ text: 'Suggested purpose.', section: 'purpose' }], 'Claude')
  const log = readLog(host)

  check('not counted as documented', isDocumented(log) === false)
  check('coverage stays zero', liveNoteCount(log) === 0)

  const exported = renderEntityDoc('blue-500', 'variable', { typeLabel: 'COLOR' }, log, {
    includeEmptySections: false,
  })
  check(
    'still exports the not-documented warning',
    exported.indexOf('Not documented yet') !== -1,
    exported
  )
}

section('drafts: approving is what makes one count')

{
  const host = new FakeHost()
  appendDrafts(
    host,
    'componentSet',
    'Button',
    [
      { text: 'First suggestion.', section: 'purpose' },
      { text: 'Second suggestion.', section: 'rules' },
    ],
    'Claude'
  )
  const drafts = readLog(host).filter((e) => e.draft)

  approveDrafts(host, 'componentSet', 'Button', [drafts[0].id], 'Anusha')
  const afterOne = readLog(host)
  check('the approved one is no longer a draft', afterOne[0].draft === undefined)
  check('the other is still a draft', afterOne[1].draft === true)
  check('coverage counts only the approved one', liveNoteCount(afterOne) === 1)
  // Approval is when a human takes responsibility for the claim.
  check('approval is attributed to the approver', afterOne[0].author === 'Anusha')
  check('the wording is untouched', afterOne[0].text === 'First suggestion.')

  const exportedOnce = renderEntityDoc('Button', 'componentSet', { typeLabel: 'Set' }, afterOne, {
    includeEmptySections: false,
  })
  check('the approved one now exports', exportedOnce.indexOf('First suggestion.') !== -1)
  check('the unapproved one still does not', exportedOnce.indexOf('Second suggestion.') === -1)

  approveDrafts(host, 'componentSet', 'Button', null, 'Anusha')
  check('null approves the rest', draftCount(readLog(host)) === 0)
  check('all now count', liveNoteCount(readLog(host)) === 2)
}

section('drafts: rejecting keeps the wording')

{
  const host = new FakeHost()
  appendDrafts(host, 'variable', 'x', [{ text: 'A wrong guess.', section: 'rules' }], 'Claude')
  const draft = readLog(host)[0]

  softDeleteNote(host, 'variable', 'x', draft.id)
  const after = readLog(host)
  check('the entry survives rejection', after.length === 1)
  check('its wording is retained', after[0].text === 'A wrong guess.')
  check('it no longer counts as a draft', draftCount(after) === 0)
  check('it never counted as documented', liveNoteCount(after) === 0)
}

section('drafts: arriving alongside existing notes changes nothing')

{
  const host = new FakeHost()
  appendNote(host, 'componentSet', 'Button', 'Human rule.', 'rules', 'Anusha')
  const before = JSON.stringify(readLog(host))

  appendDrafts(host, 'componentSet', 'Button', [{ text: 'Machine guess.', section: 'rules' }], 'Claude')
  const after = readLog(host)

  check('the existing note is byte-identical', JSON.stringify(after.slice(0, 1)) === before)
  check('the draft is appended after it', after[1].draft === true)
  check('both live in the same category without merging', after.length === 2)
}

section('variants: a variant is documented as itself, not as its set')

{
  // A variant inherits the set's purpose, so it offers a narrower set of
  // categories. `pairs` in particular belongs to the component, not to one of
  // its states — documenting what Button sits beside, once per variant, would
  // be noise repeated 176 times.
  const forVariant = sectionsFor('variant')
  const forSet = sectionsFor('componentSet')

  check('a variant has its own category set', forVariant.length > 0)
  check('it drops "pairs"', forVariant.indexOf('pairs' as SectionKey) === -1)
  check('the set keeps "pairs"', forSet.indexOf('pairs' as SectionKey) !== -1)
  check(
    'everything a variant offers is also offered by its set',
    forVariant.every((key) => forSet.indexOf(key) !== -1)
  )
  check('every variant category has a heading', forVariant.every((key) => Boolean(SECTION_HEADINGS[key])))
  check('every variant category has a label', forVariant.every((key) => Boolean(SECTION_LABELS[key])))
  check('every variant category has a prompt', forVariant.every((key) => Boolean(SECTION_PROMPTS[key])))
}

{
  const host = new FakeHost()
  appendNote(host, 'variant', 'Size=36, Type=Primary', 'Never use below 32px.', 'rules', 'Anusha')

  const log = readLog(host)
  check('a variant note stores against the variant kind', log.length === 1)

  // Level 4, so it nests under "### Size=36, Type=Primary" inside the
  // component's own file rather than competing with the component's headings.
  const nested = renderAuthoredSections(log, 'variant', 4)
  check('it renders at heading level 4', nested.indexOf('#### ') !== -1)
  check('it does not open a level-2 heading', nested.indexOf('\n## ') === -1)
  check('the wording is carried through verbatim', nested.indexOf('Never use below 32px.') !== -1)

  // A draft is a suggestion nobody has accepted. It must not reach the export
  // by riding along inside a variant block.
  const drafted = new FakeHost()
  appendDrafts(drafted, 'variant', 'Size=36', [{ text: 'A guess.', section: 'rules' }], 'Claude')
  check(
    'an undecided suggestion renders nothing for the export',
    renderAuthoredSections(
      readLog(drafted).filter((e) => !e.draft),
      'variant',
      4
    ).trim() === ''
  )
}

section('scope: typed and approved-draft notes render under a When heading')

{
  // The regression behind the "preview/export dropped Type = Primary" report.
  // renderEntityDoc — what the live preview AND the per-entity export actually
  // call — grouped by section only and ignored scope, so a note stored with a
  // scope still rendered as a whole-set rule. Assert through the REAL renderer,
  // for both authoring paths (typed, and drafted by Claude then approved).
  const structure = { typeLabel: 'Component set' }
  const doc = (host: PluginDataHost) =>
    renderEntityDoc('Button', 'componentSet', structure, readLog(host), {
      includeEmptySections: false,
    })

  const typed = new FakeHost()
  appendNote(typed, 'componentSet', 'Button', 'Only one per page.', 'usage', 'A', { Type: 'Primary' })
  check('typed: scope survives storage', JSON.stringify(readLog(typed)[0]?.scope) === '{"Type":"Primary"}')
  const typedDoc = doc(typed)
  check('typed: the entity doc emits the scope heading', typedDoc.includes('When Type = Primary'))
  check(
    'typed: the scoped note sits under that heading',
    typedDoc.indexOf('When Type = Primary') < typedDoc.indexOf('Only one per page.')
  )

  const drafted = new FakeHost()
  appendDrafts(
    drafted,
    'componentSet',
    'Button',
    [{ text: 'Reserve for the dominant action.', section: 'usage', scope: { Type: 'Primary' } }],
    'Claude'
  )
  check('draft: scope is stored on the suggestion', JSON.stringify(readLog(drafted)[0]?.scope) === '{"Type":"Primary"}')
  check('draft: an unapproved suggestion renders nothing', !doc(drafted).includes('Reserve for the dominant action.'))
  approveDrafts(drafted, 'componentSet', 'Button', null, 'A')
  check('draft: approval keeps the scope', JSON.stringify(readLog(drafted)[0]?.scope) === '{"Type":"Primary"}')
  const draftedDoc = doc(drafted)
  check('draft: the approved suggestion emits the scope heading', draftedDoc.includes('When Type = Primary'))
  check(
    'draft: the approved note sits under that heading',
    draftedDoc.indexOf('When Type = Primary') < draftedDoc.indexOf('Reserve for the dominant action.')
  )

  // An unscoped note must still render as a plain whole-set rule, no When block.
  const plain = new FakeHost()
  appendNote(plain, 'componentSet', 'Button', 'Always keyboard reachable.', 'rules', 'A')
  const plainDoc = doc(plain)
  check('unscoped: no When heading is emitted', !plainDoc.includes('When Type'))
  check('unscoped: it renders under its plain section', plainDoc.includes('Always keyboard reachable.'))
}

section('export: carries the writing, not what Figma Make already has')

{
  const structure = {
    typeLabel: 'Component set',
    variantCount: 176,
    parentName: 'Actions',
    description: 'Primary interactive control.',
    nestedComponents: ['Icon'],
    properties: [
      {
        key: 'Size',
        displayName: 'Size',
        type: 'VARIANT' as const,
        defaultValue: '36',
        options: ['28', '36'],
      },
    ],
  }
  const log: NoteEntry[] = [
    {
      id: '1',
      ts: 1,
      author: 'Anusha',
      text: 'Only one primary per section.',
      section: 'rules' as SectionKey,
    },
  ]

  const shipped = renderEntityDoc('Button', 'componentSet', structure, log, {
    includeEmptySections: false,
    notesOnly: true,
  })

  check('the note survives', shipped.indexOf('Only one primary per section.') !== -1)
  check('the property table does not', shipped.indexOf('| Property |') === -1)
  check('nor the variant count', shipped.indexOf('176 variants') === -1)
  check('nor the nesting list', shipped.indexOf('Nests:') === -1)
  // Figma's own description field is already on the component in the library.
  check('nor Figma\'s description', shipped.indexOf('Primary interactive control') === -1)

  // The plugin's own pane still shows all of it — a designer writing a rule
  // about Size=28 wants the table in front of them. Same data, different reader.
  const onScreen = renderEntityDoc('Button', 'componentSet', structure, log, {
    includeEmptySections: true,
  })
  check('the detail pane still shows the property table', onScreen.indexOf('| Property |') !== -1)
}

{
  // Token values are the exception: Figma documents Make's extraction of them
  // as partial, so a documented variable still states what it resolves to.
  const withValues = renderEntityDoc(
    'neutral/1000',
    'variable',
    {
      typeLabel: 'COLOR',
      modeValues: [
        { modeName: 'Light', value: '`#0A0A0A`' },
        { modeName: 'Dark', value: '`#FAFAFA`' },
      ],
    },
    [{ id: '1', ts: 1, author: 'A', text: 'Body text only.', section: 'rules' as SectionKey }],
    { includeEmptySections: false, notesOnly: true, level: 3 }
  )

  check('a documented token keeps its values', withValues.indexOf('#0A0A0A') !== -1)
  check(
    'the values table nests under the entity heading',
    withValues.indexOf('#### Values by mode') !== -1
  )
  check('and it does not outrank its own title', withValues.indexOf('\n## Values') === -1)
}

{
  // An alias must never export as the colour it happens to resolve to: theming
  // modes live on the primitive, and a hardcoded hex severs the chain for every
  // level below it.
  const alias = renderEntityDoc(
    'text/primary',
    'variable',
    {
      typeLabel: 'COLOR',
      modeValues: [{ modeName: 'Value', value: '→ `Primitive Colors/neutral/1000`' }],
    },
    [{ id: '1', ts: 1, author: 'A', text: 'Default body colour.', section: 'rules' as SectionKey }],
    { includeEmptySections: false, notesOnly: true }
  )

  check('an alias exports as a reference', alias.indexOf('Primitive Colors/neutral/1000') !== -1)
  check('never as a resolved hex', alias.indexOf('#0A0A0A') === -1)
  check('and the reference is qualified by collection', alias.indexOf('Primitive Colors/') !== -1)
}

{
  // Nothing undocumented ships, so the placeholder warning has nothing to warn
  // about — absence is what says "nobody wrote a rule for this".
  const bare = renderEntityDoc(
    'Untouched',
    'componentSet',
    { typeLabel: 'Component set' },
    [],
    { includeEmptySections: false, notesOnly: true }
  )
  check('an undocumented entity renders no warning block', bare.indexOf('⚠️') === -1)
  check('it is just the heading', bare.trim() === '# Untouched')
}

section('coverage: what counts as documented, and what quietly should not')

{
  const at = (kind: EntityKind, noteCount: number, alive = true) => ({
    entry: { kind, name: 'x', noteCount, updatedAt: 0 },
    alive,
  })

  const counts = countDocumented([
    at('variable', 3),
    at('variable', 1),
    at('collection', 2),
    at('paintStyle', 1),
    at('textStyle', 1),
    at('effectStyle', 1),
    at('component', 1),
    at('componentSet', 1),
    at('variant', 1),
  ])

  check('variables are counted once each', counts.variables === 2)
  check('a component and a component set share one bucket', counts.components === 2)
  check('variants are counted apart from their set', counts.variants === 1)
  check('each style kind lands in its own bucket', counts.paintStyles === 1 && counts.textStyles === 1 && counts.effectStyles === 1)
  check('collections are their own bucket', counts.collections === 1)
}

{
  const entry = (kind: EntityKind, noteCount: number, alive: boolean) => ({
    entry: { kind, name: 'x', noteCount, updatedAt: 0 },
    alive,
  })

  // An orphan is an entity whose Figma object was deleted. Its notes went with
  // it, so counting it would report coverage the file no longer has.
  const withOrphan = countDocumented([
    entry('variable', 2, true),
    entry('variable', 5, false),
  ])
  check('a deleted entity is not coverage', withOrphan.variables === 1)

  // noteCount excludes drafts, so an entity whose only suggestions are
  // unapproved reads as zero — an unreviewed guess must not inflate the number.
  const draftsOnly = countDocumented([entry('component', 0, true)])
  check('an entity holding only unapproved drafts is undocumented', draftsOnly.components === 0)

  // Folders, pages and sections are documentable but have no denominator, so
  // they are deliberately absent from the table rather than miscounted into it.
  const containers = countDocumented([
    entry('folder', 4, true),
    entry('page', 4, true),
    entry('section', 4, true),
    entry('project', 9, true),
  ])
  const total = Object.values(containers).reduce((n, v) => n + v, 0)
  check('containers and the project are not counted as coverage', total === 0)
}

{
  // The project checklist is driven by this list, so "layout" being in it is
  // what makes an undocumented layout visible rather than merely absent.
  const projectSections = sectionsFor('project')
  check('the project offers a layout section', projectSections.indexOf('layout' as SectionKey) !== -1)
  check('every project section has a label for the chip', projectSections.every((k) => Boolean(SECTION_LABELS[k])))
}

section('variants: a sparse set never strands the picker')

{
  // A real set, deliberately not a full cross-product: "Mobile Link" was only
  // ever drawn at Small, and Tertiary has no Pressed state. Every combination
  // the dropdowns can express is not a variant somebody made.
  const v = (id: string, Type: string, State: string, Size: string) => ({
    id,
    name: `Type=${Type}, State=${State}, Size=${Size}`,
    properties: { Type, State, Size },
  })
  const variants = [
    v('1', 'Primary', 'Default', 'Large'),
    v('2', 'Primary', 'Hover', 'Large'),
    v('3', 'Primary', 'Default', 'Small'),
    v('4', 'Tertiary', 'Default', 'Large'),
    v('5', 'Tertiary', 'Default', 'Small'),
    v('6', 'Mobile Link', 'Default', 'Small'),
  ]

  const start = { Type: 'Primary', State: 'Default', Size: 'Large' }
  check('an existing combination resolves', matchVariant(variants, start)?.id === '1')

  // The case from the bug report: Mobile Link does not exist at Large.
  const moved = reconcile(variants, start, 'Type', 'Mobile Link')
  check('the property just changed is honoured', moved.Type === 'Mobile Link')
  check('the rest give way to something real', matchVariant(variants, moved)?.id === '6')
  check('so the picker still points at a variant', matchVariant(variants, moved) !== undefined)

  // Where the combination does exist, nothing else should move.
  const kept = reconcile(variants, start, 'State', 'Hover')
  check('an available change moves only that property', kept.Size === 'Large' && kept.Type === 'Primary')
  check('and lands exactly', matchVariant(variants, kept)?.id === '2')

  // Closest means most properties retained, not first in the list.
  const fromSmall = { Type: 'Mobile Link', State: 'Default', Size: 'Small' }
  const toTertiary = reconcile(variants, fromSmall, 'Type', 'Tertiary')
  check('the nearest variant wins, not the first', toTertiary.Size === 'Small')

  // A value no variant carries cannot be snapped to. The selection stands and
  // the viewer reports it, rather than silently jumping somewhere unrelated.
  const impossible = reconcile(variants, start, 'Type', 'Ghost')
  check('an unavailable value is left as chosen', impossible.Type === 'Ghost')
  check('and is reported as having no variant', matchVariant(variants, impossible) === undefined)
}

section('scope: a note says which combination it is about')

{
  const variants = [
    { id: '1', name: 'a', properties: { Type: 'Primary', Size: 'Large' } },
    { id: '2', name: 'b', properties: { Type: 'Primary', Size: 'Small' } },
    { id: '3', name: 'c', properties: { Type: 'Tertiary', Size: 'Large' } },
  ]

  check('no scope reaches everything', scopeApplies(undefined, { Type: 'Tertiary' }))
  check('an empty scope reaches everything', scopeApplies({}, { Type: 'Tertiary' }))
  check('a matching scope reaches', scopeApplies({ Type: 'Primary' }, { Type: 'Primary', Size: 'Small' }))
  check(
    'a scope naming another value does not',
    !scopeApplies({ Type: 'Primary' }, { Type: 'Tertiary', Size: 'Large' })
  )
  check(
    'every named property has to match, not just one',
    !scopeApplies({ Type: 'Primary', Size: 'Large' }, { Type: 'Primary', Size: 'Small' })
  )

  check('reach counts the variants a scope covers', scopeReach(variants, { Type: 'Primary' }) === 2)
  check('a narrower scope reaches fewer', scopeReach(variants, { Type: 'Primary', Size: 'Large' }) === 1)
  check('an empty scope reaches all of them', scopeReach(variants, {}) === 3)

  // A boolean is a real scope for a note but is not a variant axis, so it must
  // not silently report zero variants and read as covering nothing.
  check('a non-variant property narrows no variants', scopeReach(variants, { 'Show Icon': 'On' }) === 3)

  check('depth orders general before narrow', scopeDepth({}) < scopeDepth({ Type: 'Primary' }))
  check('and narrow before exact', scopeDepth({ Type: 'Primary' }) < scopeDepth({ Type: 'Primary', Size: 'Large' }))

  check('a scope reads as a condition', describeScope({ Type: 'Primary', Size: 'Large' }) === 'Type = Primary, Size = Large')
  check('and an empty one says so', describeScope(undefined) === 'every variant')

  // Grouping in the export depends on two notes about the same combination
  // landing under one heading however the object was built.
  check(
    'the same scope keys the same either way round',
    scopeKey({ Type: 'Primary', Size: 'Large' }) === scopeKey({ Size: 'Large', Type: 'Primary' })
  )
  check(
    'different scopes key differently',
    scopeKey({ Type: 'Primary' }) !== scopeKey({ Type: 'Tertiary' })
  )
}

{
  const host = new FakeHost()
  appendNote(host, 'componentSet', 'Button', 'Every action is a Button.', 'purpose', 'A')
  appendNote(host, 'componentSet', 'Button', 'Only one per section.', 'rules', 'A', { Type: 'Primary' })
  appendNote(host, 'componentSet', 'Button', 'Reserved for the page CTA.', 'rules', 'A', {
    Type: 'Primary',
    Size: 'Large',
  })

  const log = readLog(host)
  check('all three live on the component', log.length === 3)
  check('an unscoped note stores no scope at all', log[0].scope === undefined)
  check('a scoped one keeps its combination', log[1].scope?.Type === 'Primary')

  // An empty object would compare as a scope in every later check, when what it
  // means is "no scope" — so it must not be stored.
  const empty = new FakeHost()
  appendNote(empty, 'componentSet', 'Button', 'x', 'rules', 'A', {})
  check('an empty scope is not stored as one', readLog(empty)[0].scope === undefined)

  const md = renderAuthoredSections(log, 'componentSet', 2)
  check('the general rule leads', md.indexOf('Every action is a Button.') < md.indexOf('Only one per section.'))
  check('a scope becomes a condition heading', md.indexOf('## When Type = Primary') !== -1)
  check('the narrower one gets its own', md.indexOf('## When Type = Primary, Size = Large') !== -1)
  check(
    'and general conditions come before narrow ones',
    md.indexOf('## When Type = Primary\n') < md.indexOf('## When Type = Primary, Size = Large')
  )
}

section('migration: per-variant notes become scoped notes on the set')

{
  const note = (id: string, text: string, ts: number, extra: Partial<NoteEntry> = {}) =>
    ({ id, ts, author: 'A', text, section: 'rules' as SectionKey, ...extra }) as NoteEntry

  const setLog = [note('s1', 'Only one per section.', 100)]
  const variantLog = [note('v1', 'The 28px size drops its label.', 200)]
  const scope = { Type: 'Primary', State: 'Default', Size: 'Small' }

  const plan = planVariantMigration(setLog, variantLog, scope)

  check('the note moves', plan.moved === 1)
  check('nothing already on the set is lost', plan.merged.some((e) => e.id === 's1'))
  check('and the moved one arrives', plan.merged.some((e) => e.id === 'v1'))

  const moved = plan.merged.find((e) => e.id === 'v1')!
  check('its wording is untouched', moved.text === 'The 28px size drops its label.')
  check('its id survives, so a rerun can recognise it', moved.id === 'v1')
  check('it now says which combination it was about', moved.scope?.Size === 'Small')
  check('every axis is pinned — it was about one variant', Object.keys(moved.scope ?? {}).length === 3)
  check('order stays chronological', plan.merged.map((e) => e.id).join(',') === 's1,v1')
}

{
  const note = (id: string, ts: number, extra: Partial<NoteEntry> = {}) =>
    ({ id, ts, author: 'A', text: 't', section: 'rules' as SectionKey, ...extra }) as NoteEntry

  // Running twice must not double the note. The guard is the id, because two
  // variants can legitimately carry identical wording.
  const already = [note('v1', 200, { scope: { Type: 'Primary' } })]
  const again = planVariantMigration(already, [note('v1', 200)], { Type: 'Primary' })
  check('a second run moves nothing', again.moved === 0)
  check('and does not duplicate the entry', again.merged.filter((e) => e.id === 'v1').length === 1)

  // Deleted and draft state has to survive, or a hidden note reappears in the
  // export and an unreviewed suggestion becomes a rule.
  const carried = planVariantMigration(
    [],
    [note('d1', 1, { deleted: true }), note('d2', 2, { draft: true })],
    { Type: 'Primary' }
  )
  check('a hidden note stays hidden', carried.merged.find((e) => e.id === 'd1')?.deleted === true)
  check('an unapproved draft stays a draft', carried.merged.find((e) => e.id === 'd2')?.draft === true)

  // Earlier wordings are the never-lose guarantee; they travel too.
  const withHistory = planVariantMigration(
    [],
    [note('r1', 1, { revisions: [{ text: 'first try', ts: 0, author: 'A' }] })],
    { Type: 'Primary' }
  )
  check(
    'previous wordings travel with it',
    withHistory.merged[0].revisions?.[0].text === 'first try'
  )

  // A variant with no properties to speak of should not gain an empty scope,
  // which would read as a real scope everywhere downstream.
  const noScope = planVariantMigration([], [note('n1', 1)], {})
  check('an empty combination produces no scope', noScope.merged[0].scope === undefined)
}

// ─── Result ──────────────────────────────────────────────────────────────────

console.log(
  failures === 0
    ? `\n  ✓ ${checks} checks passed\n`
    : `\n  ✗ ${failures} of ${checks} checks failed\n`
)
process.exit(failures === 0 ? 0 : 1)
