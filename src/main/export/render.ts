// Rendering entities to markdown.
//
// Shape follows Figma's own published guidance for Make guidelines: tables for
// variants and props, imperative language, explicit Do / Don't. Auto-generated
// facts come from the Figma file and are rewritten on every render; authored
// sections come from the append-only note log.

import type {
  EntityKind,
  EntityStructure,
  NoteEntry,
  SectionKey,
} from '../../shared/types'
import { SECTION_HEADINGS, migrateSection, sectionsFor } from '../../shared/types'

export interface RenderOptions {
  /**
   * Detail view shows every heading so the designer can see what is still
   * blank; the export omits empty ones to keep the guidelines terse.
   */
  includeEmptySections: boolean
  /** Heading level for the entity title — `#` standalone, `###` when nested. */
  level?: number
  /**
   * Export only: leave out everything Figma Make already reads from the library.
   *
   * Make imports the library itself, so a property table, a variant count or a
   * folder tree in the markdown is the same fact stated twice — and the copy in
   * the file goes stale the moment someone adds a variant. What Make cannot
   * recover is why any of it exists, so that is all the export carries.
   *
   * Token values are the exception: Figma's own docs say Make gets "a
   * simplified version" of variables converted to CSS, and that Make kits
   * "don't support full extraction of design tokens".
   */
  notesOnly?: boolean
}

function heading(level: number, text: string): string {
  return `${'#'.repeat(level)} ${text}`
}

/** Renders one note as a bullet, indenting any continuation lines. */
function bullet(text: string): string {
  const lines = text.trim().split('\n')
  const [first, ...rest] = lines
  return [`- ${first}`, ...rest.map((l) => (l.trim() ? `  ${l}` : ''))].join('\n')
}

/**
 * Makes arbitrary text safe inside a markdown table cell.
 *
 * Mode names, string variable values and property descriptions are all
 * user-typed, so a stray `|` or newline would otherwise shear the table apart.
 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

function groupBySection(log: NoteEntry[]): Map<SectionKey, NoteEntry[]> {
  const groups = new Map<SectionKey, NoteEntry[]>()
  for (const entry of log) {
    // Unapproved drafts never render — not in the plugin's document pane and
    // not in the export. They live in the review panel until a human accepts
    // them, so a suggestion cannot become a rule Figma Make follows.
    if (entry.deleted || entry.draft) continue
    const key = migrateSection(entry.section)
    const existing = groups.get(key)
    if (existing) existing.push(entry)
    else groups.set(key, [entry])
  }
  return groups
}

/**
 * Section order for one entity kind, followed by any section that carries notes
 * but is not in that kind's set.
 *
 * The tail matters: if a note was filed under a category that no longer applies
 * here, it still renders rather than vanishing from the document.
 */
function orderedSections(kind: EntityKind, groups: Map<SectionKey, NoteEntry[]>): SectionKey[] {
  const primary = sectionsFor(kind)
  const extra = Array.from(groups.keys()).filter((key) => primary.indexOf(key) === -1)
  return primary.concat(extra)
}

// ─── Auto-generated blocks ───────────────────────────────────────────────────

function renderContextLine(structure: EntityStructure): string {
  const parts: string[] = [structure.typeLabel]
  if (structure.variantCount && structure.variantCount > 1) {
    parts.push(`${structure.variantCount} variants`)
  }
  if (structure.childCount !== undefined) {
    parts.push(`${structure.childCount} variables`)
  }
  if (structure.parentName) parts.push(`in \`${structure.parentName}\``)
  return `> ${parts.join(' · ')}`
}

// Takes the entity heading level so a variable rendered as `###` inside a
// collection file does not sprout a `##` table underneath it.
function renderValues(structure: EntityStructure, level = 1): string {
  if (!structure.modeValues || structure.modeValues.length === 0) return ''
  const isModes = structure.modeValues.length > 1
  const rows = structure.modeValues
    .map((mv) => `| ${escapeCell(mv.modeName)} | ${escapeCell(mv.value)} |`)
    .join('\n')
  return [
    heading(level + 1, isModes ? 'Values by mode' : 'Value'),
    '',
    `| ${isModes ? 'Mode' : 'Property'} | Value |`,
    '|---|---|',
    rows,
  ].join('\n')
}

function renderProperties(structure: EntityStructure): string {
  const properties = structure.properties
  if (!properties || properties.length === 0) return ''

  // Only widen the table when at least one property actually carries a note.
  const hasNotes = properties.some((p) => p.description)

  const rows = properties
    .map((p) => {
      const options = p.options?.length ? p.options.map((o) => `\`${o}\``).join(', ') : '—'
      const cells = [`\`${p.displayName}\``, p.type, options, `\`${p.defaultValue}\``]
      if (hasNotes) cells.push(p.description ? escapeCell(p.description) : '—')
      return `| ${cells.join(' | ')} |`
    })
    .join('\n')

  const header = ['Property', 'Type', 'Options', 'Default']
  if (hasNotes) header.push('Notes')

  const blocks = [
    heading(2, 'Variants and properties'),
    '',
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    rows,
  ]

  if (structure.nestedComponents?.length) {
    blocks.push('', `Nests: ${structure.nestedComponents.map((n) => `\`${n}\``).join(', ')}`)
  }

  return blocks.join('\n')
}

function renderModes(structure: EntityStructure): string {
  if (!structure.modes || structure.modes.length === 0) return ''
  return [
    heading(2, 'Modes'),
    '',
    structure.modes.map((m) => `- \`${m}\``).join('\n'),
  ].join('\n')
}

function renderStructureTree(structure: EntityStructure): string {
  if (!structure.structureTree) return ''
  return [heading(2, 'Structure'), '', '```', structure.structureTree, '```'].join('\n')
}

// ─── Entity document ─────────────────────────────────────────────────────────

/**
 * One entity's full markdown — the top pane in the plugin, and one file (or one
 * `###` block inside a grouped file) in the export.
 */
/**
 * The auto-generated half: title, context, values, property tables, folder tree.
 *
 * Always regenerated from the live Figma file and never editable — if a
 * component gains a variant, the table has to follow. Kept separate from the
 * authored half precisely so the authored half *can* be hand-edited without
 * freezing this in place.
 */
export function renderStructure(
  name: string,
  kind: EntityKind,
  structure: EntityStructure,
  level = 1
): string {
  const blocks: string[] = [heading(level, titleFor(name, kind)), renderContextLine(structure)]

  if (structure.description) blocks.push(`_${structure.description.trim()}_`)

  blocks.push(renderModes(structure))
  blocks.push(renderValues(structure, level))
  blocks.push(renderProperties(structure))
  blocks.push(renderStructureTree(structure))

  return blocks.filter(Boolean).join('\n\n')
}

/**
 * The heading, and nothing else Figma Make can work out for itself.
 *
 * Values survive because Make's token extraction is documented as partial — a
 * hex per mode is the one generated fact worth restating. Property tables,
 * variant counts, nesting and folder trees do not: Make reads the library.
 *
 * The plugin's own detail pane still uses `renderStructure`, because a designer
 * writing a rule about `Size=28` wants the property table in front of them. The
 * difference is the audience, not the data.
 */
export function renderExportHeader(
  name: string,
  kind: EntityKind,
  structure: EntityStructure,
  level = 1
): string {
  return [heading(level, titleFor(name, kind)), renderValues(structure, level)]
    .filter(Boolean)
    .join('\n\n')
}

export function renderEntityDoc(
  name: string,
  kind: EntityKind,
  structure: EntityStructure,
  log: NoteEntry[],
  options: RenderOptions
): string {
  const level = options.level ?? 1
  const blocks: string[] = [
    options.notesOnly
      ? renderExportHeader(name, kind, structure, level)
      : renderStructure(name, kind, structure, level),
  ]

  const groups = groupBySection(log)

  for (const key of orderedSections(kind, groups)) {
    const entries = groups.get(key) ?? []
    if (entries.length === 0 && !options.includeEmptySections) continue
    blocks.push(heading(level + 1, SECTION_HEADINGS[key]))
    blocks.push(
      entries.length > 0 ? entries.map((e) => bullet(e.text)).join('\n') : '_Not documented yet._'
    )
  }

  // No "not documented yet" placeholder in a notes-only export: nothing
  // undocumented is written at all, so the warning would have nothing to warn
  // about. Absence carries the meaning instead — a name missing from the
  // guidelines is a name nobody has written a rule for.
  if (groups.size === 0 && !options.includeEmptySections && !options.notesOnly) {
    blocks.push(
      `> ⚠️ Not documented yet — no usage rules have been written for this ${structure.typeLabel.toLowerCase()}. Do not infer constraints for it; ask instead.`
    )
  }

  return blocks.filter(Boolean).join('\n\n') + '\n'
}

function titleFor(name: string, kind: EntityKind): string {
  // Grouped files nest entities under headings, so the leaf name alone reads
  // better than the full slash path; standalone files keep the full name.
  switch (kind) {
    case 'variable':
      return `Variable: ${name}`
    case 'collection':
      return `Collection: ${name}`
    case 'paintStyle':
    case 'textStyle':
    case 'effectStyle':
      return name
    case 'project':
      return name
    default:
      return name
  }
}

/**
 * Just the authored sections, with no generated title or context line.
 *
 * `Guidelines.md` supplies its own H1 and summary, so folding the project-level
 * notes in through `renderEntityDoc` would repeat both.
 */
export function renderAuthoredSections(
  log: NoteEntry[],
  kind: EntityKind = 'project',
  level = 2
): string {
  const groups = groupBySection(log)
  const blocks: string[] = []
  for (const key of orderedSections(kind, groups)) {
    const entries = groups.get(key) ?? []
    if (entries.length === 0) continue
    blocks.push(heading(level, SECTION_HEADINGS[key]))
    blocks.push(entries.map((e) => bullet(e.text)).join('\n'))
  }
  return blocks.join('\n\n')
}

/** True when an entity carries at least one approved note. */
export function isDocumented(log: NoteEntry[]): boolean {
  return log.some((e) => !e.deleted && !e.draft)
}
