// Emits a representative export into sample-output/ so the markdown format can
// be reviewed — and dropped into a Figma Make kit — without running the plugin.
//
// Uses the real renderer with stand-in data, so what appears here is what the
// plugin actually produces.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderEntityDoc } from '../src/main/export/render'
import type { NoteEntry } from '../src/shared/types'

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../sample-output/guidelines')

function note(section: NoteEntry['section'], text: string, i: number): NoteEntry {
  return { id: String(i), ts: 1_770_000_000_000 + i, author: 'Anusha', text, section }
}

function write(path: string, content: string): void {
  const full = resolve(out, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
  console.log(`  ${path}`)
}

// ─── foundations/primitivecolors.md ──────────────────────────────────────────

const collection = renderEntityDoc(
  'Primitive Colors',
  'collection',
  {
    typeLabel: 'Variable collection',
    modes: ['Light', 'Dark'],
    childCount: 3,
    structureTree: 'neutral/\n  1000\n  900\nbrand/\n  blue-500',
  },
  [
    note('purpose', 'Raw palette. Never referenced directly by a designer or a developer — always go through a semantic alias in `Color - General alias`.', 1),
    note('modes', 'Light is the source of truth. Dark is derived and must preserve the same contrast rank — if a token is the darkest neutral in Light, it is the lightest in Dark.', 2),
    note('naming', '`family/weight` — weight runs 100 (lightest) to 1000 (darkest) in Light mode. The number describes position in the ramp, not lightness, so it stays stable across modes.', 3),
    note('rules', 'Every primitive must have at least one semantic alias pointing at it. An unaliased primitive is dead weight.', 4),
    note('donts', 'Do not add a new primitive to solve a one-off. Add a semantic alias to an existing one instead.', 5),
  ],
  { includeEmptySections: false, notesOnly: true }
)

const variables = [
  renderEntityDoc(
    'neutral/1000',
    'variable',
    {
      typeLabel: 'COLOR',
      parentName: 'Primitive Colors',
      modeValues: [
        { modeName: 'Light', value: '`#0A0A0A`' },
        { modeName: 'Dark', value: '`#FAFAFA`' },
      ],
    },
    [
      note('purpose', 'The darkest neutral. Provides maximum contrast for text, icons and borders while staying visually neutral — no blue, green or warm tint.', 1),
      note('usage', 'Use wherever maximum readability and hierarchy are required — primary body text, headings, high-emphasis icons.', 2),
      note('instead', 'For secondary or supporting text use `neutral/700`. For anything on a coloured surface use `content/on-brand`.', 3),
      note('donts', 'Never reference this hex directly. Consumers use the semantic token `content/primary`.', 4),
    ],
    { includeEmptySections: false, notesOnly: true, level: 3 }
  ),
  renderEntityDoc(
    'brand/blue-500',
    'variable',
    {
      typeLabel: 'COLOR',
      parentName: 'Primitive Colors',
      modeValues: [
        { modeName: 'Light', value: '`#2D6BFF`' },
        { modeName: 'Dark', value: '`#5B8CFF`' },
      ],
    },
    [note('rules', 'Brand blue is an accent. Never use it as a background for cards, panels or large areas.', 1)],
    { includeEmptySections: false, notesOnly: true, level: 3 }
  ),
]

write(
  'foundations/primitivecolors.md',
  [collection, '## Variables\n', ...variables].join('\n')
)

// ─── components/button.md ────────────────────────────────────────────────────

write(
  'components/button.md',
  renderEntityDoc(
    'Button',
    'componentSet',
    {
      typeLabel: 'Component set',
      variantCount: 176,
      parentName: 'Actions',
      description: 'Primary interactive control.',
      properties: [
        { key: 'Type', displayName: 'Type', type: 'VARIANT', defaultValue: 'Primary - brand', options: ['Primary - brand', 'Primary - buy', 'Secondary - grey', 'Tertiary'] },
        { key: 'Size', displayName: 'Size', type: 'VARIANT', defaultValue: '36', options: ['28', '36', '40', '48'] },
        { key: 'State', displayName: 'State', type: 'VARIANT', defaultValue: 'Default', options: ['Default', 'Hover', 'Pressed', 'Disabled'] },
        { key: 'IconLeading#12:0', displayName: 'IconLeading', type: 'BOOLEAN', defaultValue: 'false', description: 'Shows the leading icon slot.' },
        { key: 'Label#8:1', displayName: 'Label', type: 'TEXT', defaultValue: 'Button' },
      ],
      nestedComponents: ['Icon'],
    },
    [
      note('purpose', 'The primary interactive control. Every action a user can take is a Button.', 1),
      note('usage', 'Use whenever the user commits to something — submitting, confirming, triggering. Never build a bare HTML button.', 2),
      note('instead', 'For navigation that changes the URL, use `Link`. For an action on a single row or cell, use `Icon button`.', 3),
      note('pairs', 'Inside a `Button group` when there is more than one action — gap 8px, never hand-spaced.', 4),
      note('states', 'Disabled must be paired with a tooltip explaining why. A button that triggers a request shows the loading state, never a spinner placed next to it.', 5),
      note('content', 'Sentence case, verb first, three words maximum. "Save changes", not "Submit" and not "Save Changes".', 6),
      note('rules', 'Only one `Primary - brand` button per visible section.', 7),
      note('rules', 'All buttons in a group must share the same Size. Do not mix 36 and 40.', 8),
      note('rules', 'Use `Primary - buy` / `Primary - sell` only inside trading flows.', 9),
      note('donts', 'Do not use Tertiary for a destructive action — it reads as a link.', 10),
      note('notes', 'State is driven by the interaction-alias variable mode; the layer structure is identical across all four states.', 11),
    ],
    { includeEmptySections: false, notesOnly: true }
  )
)

// ─── An undocumented component, to show how a gap reads ──────────────────────

write(
  'components/checkbox.md',
  renderEntityDoc(
    'Checkbox',
    'componentSet',
    {
      typeLabel: 'Component set',
      variantCount: 12,
      parentName: 'Selectors',
      properties: [
        { key: 'State', displayName: 'State', type: 'VARIANT', defaultValue: 'Unchecked', options: ['Unchecked', 'Checked', 'Indeterminate'] },
      ],
    },
    [],
    { includeEmptySections: false, notesOnly: true }
  )
)

console.log('\n  Sample written to sample-output/guidelines/\n')
