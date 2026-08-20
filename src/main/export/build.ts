// Assembling the export.
//
// Output is shaped for Figma Make's guidelines folder: `Guidelines.md` is the
// entry point Make reads first, and it routes to granular files rather than
// containing everything — Figma's guidance is that "multiple short guidelines
// files are better than a few large files".
//
// This is the one place `loadAllPagesAsync()` runs. It is documented as slow on
// large files, so it stays behind an explicit user action with progress shown.

import type { ExportFile, NoteEntry } from '../../shared/types'
import { componentDir, uniqueSlugger } from '../../shared/slug'
import { liveNoteCount, readLog } from '../storage'
import {
  allComponents,
  componentStructure,
  migrateVariantNotes,
  UNGROUPED_NAME,
} from '../reader/components'
import { getStyles, styleStructure, type StyleKind } from '../reader/styles'
import { collectionStructure, getCollections, variablesIn, variableStructure } from '../reader/variables'
import { isDocumented, renderAuthoredSections, renderEntityDoc, renderStructure } from './render'
import { readBody, type PluginDataHost } from '../storage'
import type { EntityKind, EntityStructure, NoteEntry as Note } from '../../shared/types'

/**
 * Renders one entity for the export, honouring a hand-edited body.
 *
 * Without this the ZIP would quietly rebuild every document from the note log
 * and drop every manual edit — the export has to show what the plugin shows.
 */
function renderForExport(
  host: PluginDataHost,
  name: string,
  kind: EntityKind,
  structure: EntityStructure,
  log: Note[],
  level = 1
): string {
  const override = readBody(host)
  if (override === null) {
    return renderEntityDoc(name, kind, structure, log, { ...EXPORT_OPTIONS, level })
  }
  const structureMd = renderStructure(name, kind, structure, level)
  return `${structureMd}\n\n${override.trim()}\n`
}

type Progress = (message: string) => void

/**
 * Figma Make reads the library itself, so the export carries only what it
 * cannot get from there: the writing.
 *
 * `notesOnly` drops generated structure — property tables, variant counts,
 * folder trees — because restating them is both redundant and a liability: the
 * copy in the markdown goes stale the moment someone adds a variant, and a
 * stale rule is followed as faithfully as a true one. Token values survive; see
 * `renderExportHeader`.
 */
const EXPORT_OPTIONS = { includeEmptySections: false, notesOnly: true } as const

interface Manifest {
  collections: Array<{ name: string; file: string; variables: number; documented: number }>
  styles: Array<{ label: string; file: string; count: number; documented: number }>
  components: Array<{
    name: string
    file: string
    page: string
    section: string
    documented: boolean
  }>
}

export async function buildExport(progress: Progress): Promise<ExportFile[]> {
  const files: ExportFile[] = []
  const manifest: Manifest = { collections: [], styles: [], components: [] }

  // ── Variable collections ───────────────────────────────────────────────────
  progress('Reading variable collections…')
  const collectionSlug = uniqueSlugger()
  const collections = await getCollections()

  for (const collection of collections) {
    const variables = await variablesIn(collection)
    const collectionLog = readLog(collection)

    // Only tokens somebody has written about. An undocumented one is a name
    // Make already has from the library, so listing it here adds nothing and
    // buries the ones that carry a rule.
    const documentedVars = variables.filter((v) => isDocumented(readLog(v)))
    if (!isDocumented(collectionLog) && documentedVars.length === 0) continue

    const name = `${collectionSlug(collection.name)}.md`
    const path = `guidelines/foundations/${name}`

    const blocks: string[] = [
      renderForExport(
        collection,
        collection.name,
        'collection',
        await collectionStructure(collection),
        collectionLog
      ),
    ]

    if (documentedVars.length > 0) {
      blocks.push('## Variables\n')
      for (const variable of documentedVars) {
        blocks.push(
          renderForExport(
            variable,
            variable.name,
            'variable',
            await variableStructure(variable),
            readLog(variable),
            3
          )
        )
      }
    }

    files.push({ path, content: blocks.join('\n') })
    manifest.collections.push({
      name: collection.name,
      file: `foundations/${name}`,
      variables: variables.length,
      documented: documentedVars.length,
    })
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  const styleGroups: Array<{ kind: StyleKind; label: string; file: string }> = [
    { kind: 'paintStyle', label: 'Color styles', file: 'colorstyles.md' },
    { kind: 'textStyle', label: 'Text styles', file: 'textstyles.md' },
    { kind: 'effectStyle', label: 'Effect styles', file: 'effectstyles.md' },
  ]

  for (const group of styleGroups) {
    progress(`Reading ${group.label.toLowerCase()}…`)
    const styles = await getStyles(group.kind)
    const documented = styles.filter((s) => isDocumented(readLog(s)))
    if (documented.length === 0) continue

    // No folder tree: Make can see the "/" grouping in the style names it
    // already imported, and a tree here would go stale on the next rename.
    const blocks: string[] = [`# ${group.label}`, '']

    for (const style of documented) {
      blocks.push(
        renderForExport(
          style,
          style.name,
          group.kind,
          await styleStructure(style, group.kind),
          readLog(style),
          2
        )
      )
    }

    files.push({ path: `guidelines/foundations/${group.file}`, content: blocks.join('\n') })
    manifest.styles.push({
      label: group.label,
      file: `foundations/${group.file}`,
      count: styles.length,
      documented: documented.length,
    })
  }

  // ── Components ─────────────────────────────────────────────────────────────
  progress('Loading all pages — this can take a moment on large files…')
  await figma.loadAllPagesAsync()

  progress('Reading components…')
  const found = await allComponents()

  // Filenames only need to be unique within their own folder now that the tree
  // mirrors the Figma file — an icon called "box" and a shape called "box" can
  // coexist without one becoming "box-2".
  const sluggers = new Map<string, (name: string) => string>()

  for (const { page, section, component } of found) {
    // A file may never have had this component opened in the plugin, so the
    // export is the other place the migration has to happen — otherwise notes
    // written under the old per-variant model would silently miss the ZIP.
    migrateVariantNotes(component)
    const log = readLog(component)

    // A component nobody has written about gets no file. Its name, properties
    // and variants are already in the library Make imported; a file restating
    // them would be noise in front of the handful that carry a real rule.
    //
    // The previous behaviour — a file per component with a "not documented yet"
    // warning — was meant to distinguish "no rule" from "no constraint". With
    // 200+ components that inverted: the warnings were the export, and the
    // rules were buried in them. Absence says the same thing more quietly.
    if (!isDocumented(log)) continue

    // Mirror how the designer arranged the file: page, then section.
    const dir = componentDir(page, section === UNGROUPED_NAME ? null : section)

    let nextSlug = sluggers.get(dir)
    if (!nextSlug) {
      nextSlug = uniqueSlugger()
      sluggers.set(dir, nextSlug)
    }

    const file = `${dir}/${nextSlug(component.name)}.md`
    const content = renderForExport(
      component,
      component.name,
      component.type === 'COMPONENT_SET' ? 'componentSet' : 'component',
      await componentStructure(component),
      log
    )
    // Variants do not get files of their own — individual components do, and a
    // variant is a state of one, not another component. Anything documented
    // about a single combination lands inside its component's file.
    files.push({ path: `guidelines/${file}`, content })
    manifest.components.push({
      name: component.name,
      file,
      page,
      section,
      documented: true,
    })
  }

  // ── Overviews and router ───────────────────────────────────────────────────
  progress('Writing guidelines…')
  files.push({
    path: 'guidelines/foundations/overview.md',
    content: renderFoundationsOverview(manifest),
  })
  if (manifest.components.length > 0) {
    files.push({
      path: 'guidelines/components/overview.md',
      content: renderComponentsOverview(manifest),
    })
  }
  files.push({ path: 'guidelines/Guidelines.md', content: renderGuidelines(manifest) })

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

// ─── Overview files ──────────────────────────────────────────────────────────

function renderFoundationsOverview(manifest: Manifest): string {
  const lines = ['# Foundations', '', 'Tokens and styles available in this design system.', '']

  if (manifest.collections.length > 0) {
    lines.push('## Variable collections', '')
    lines.push('| Collection | Variables | Documented | File |')
    lines.push('|---|---|---|---|')
    for (const c of manifest.collections) {
      lines.push(`| ${c.name} | ${c.variables} | ${c.documented} | [\`${c.file}\`](${c.file}) |`)
    }
    lines.push('')
  }

  if (manifest.styles.length > 0) {
    lines.push('## Styles', '')
    lines.push('| Group | Styles | Documented | File |')
    lines.push('|---|---|---|---|')
    for (const s of manifest.styles) {
      lines.push(`| ${s.label} | ${s.count} | ${s.documented} | [\`${s.file}\`](${s.file}) |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * The catalogue, grouped the way the Figma file is.
 *
 * A flat table works for twenty components and collapses at four hundred, so
 * this nests by page and section — the same shape the folders now use, which
 * gives an agent a route to the right file rather than a wall of rows.
 */
function renderComponentsOverview(manifest: Manifest): string {
  const lines = [
    '# Component catalogue',
    '',
    'Grouped as the Figma library is: page, then section. Read the file for a component **before** using it.',
    '',
  ]

  // Group preserving first-seen order, which follows the page order in Figma.
  const pages = new Map<string, Map<string, Manifest['components']>>()
  for (const component of manifest.components) {
    let sections = pages.get(component.page)
    if (!sections) {
      sections = new Map()
      pages.set(component.page, sections)
    }
    const bucket = sections.get(component.section)
    if (bucket) bucket.push(component)
    else sections.set(component.section, [component])
  }

  for (const [page, sections] of pages) {
    const total = Array.from(sections.values()).reduce((n, list) => n + list.length, 0)
    lines.push(`## ${page}`, '', `${total} component${total === 1 ? '' : 's'}`, '')

    for (const [section, components] of sections) {
      if (section !== UNGROUPED_NAME) lines.push(`### ${section}`, '')
      lines.push('| Component | Documented | File |', '|---|---|---|')
      for (const c of [...components].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true })
      )) {
        lines.push(`| ${c.name} | ${c.documented ? 'yes' : '**no**'} | [\`${c.file}\`](${c.file}) |`)
      }
      lines.push('')
    }
  }

  const undocumented = manifest.components.filter((c) => !c.documented).length
  if (undocumented > 0) {
    lines.push(
      `> IMPORTANT: ${undocumented} component${undocumented === 1 ? ' has' : 's have'} no written usage rules yet. Do not infer rules for them — ask before assuming intended usage.`
    )
  }

  return lines.join('\n')
}

function renderGuidelines(manifest: Manifest): string {
  const projectLog: NoteEntry[] = readLog(figma.root)
  const totalItems =
    manifest.collections.reduce((n, c) => n + c.variables, 0) +
    manifest.styles.reduce((n, s) => n + s.count, 0) +
    manifest.components.length
  const totalDocumented =
    manifest.collections.reduce((n, c) => n + c.documented, 0) +
    manifest.styles.reduce((n, s) => n + s.documented, 0) +
    manifest.components.filter((c) => c.documented).length

  const lines = [
    `# ${figma.root.name} — Design System Guidelines`,
    '',
    `> Generated from the Figma library by the Design System Documentation plugin.`,
    `> ${totalDocumented} of ${totalItems} elements carry written guidance.`,
    '',
  ]

  // Project-level notes render first — character and layout scaffolding are
  // what let an agent match the system's feel rather than just its tokens.
  const projectBody = renderAuthoredSections(projectLog, 'project')
  if (projectBody) lines.push(projectBody, '')

  lines.push('## Reading order', '')
  lines.push('**Read before writing any code:**', '')
  lines.push('1. This file — project-wide rules')
  if (manifest.collections.length > 0 || manifest.styles.length > 0) {
    lines.push('2. [`foundations/overview.md`](foundations/overview.md) — tokens and styles index')
  }
  if (manifest.components.length > 0) {
    lines.push('3. [`components/overview.md`](components/overview.md) — full component catalogue')
  }
  lines.push('', '**Read on demand:**', '')
  lines.push('- `foundations/<collection>.md` — before using tokens from that collection')
  lines.push('- `components/<name>.md` — before using that component')
  lines.push('')

  lines.push('## Files', '')
  for (const c of manifest.collections) {
    lines.push(`- [\`${c.file}\`](${c.file}) — ${c.name} (${c.variables} variables)`)
  }
  for (const s of manifest.styles) {
    lines.push(`- [\`${s.file}\`](${s.file}) — ${s.label} (${s.count})`)
  }
  if (manifest.components.length > 0) {
    lines.push(
      `- [\`components/overview.md\`](components/overview.md) — ${manifest.components.length} components, one file each`
    )
  }

  lines.push(
    '',
    '## How to read these files',
    '',
    '- **Variants and properties tables are pulled directly from Figma** and are authoritative. Property names shown are the Figma property names.',
    '- **Sections marked _Not documented yet_ carry no rules.** Do not invent constraints for them.',
    '- A `Do` / `Don\'t` entry is a hard rule, not a preference.',
    ''
  )

  return lines.join('\n')
}

/** Coverage numbers for the home screen, without a full page load. */
export async function coverageSnapshot(): Promise<{
  documented: number
  collections: number
  variables: number
  paintStyles: number
  textStyles: number
  effectStyles: number
}> {
  const collections = await getCollections()
  let variables = 0
  let documented = 0

  for (const collection of collections) {
    if (liveNoteCount(readLog(collection)) > 0) documented += 1
    const vars = await variablesIn(collection)
    variables += vars.length
    documented += vars.filter((v) => liveNoteCount(readLog(v)) > 0).length
  }

  const counts: Record<StyleKind, number> = { paintStyle: 0, textStyle: 0, effectStyle: 0 }
  for (const kind of ['paintStyle', 'textStyle', 'effectStyle'] as StyleKind[]) {
    const styles = await getStyles(kind)
    counts[kind] = styles.length
    documented += styles.filter((s) => liveNoteCount(readLog(s)) > 0).length
  }

  return {
    documented,
    collections: collections.length,
    variables,
    paintStyles: counts.paintStyle,
    textStyles: counts.textStyle,
    effectStyles: counts.effectStyle,
  }
}
