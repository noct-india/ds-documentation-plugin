// Reading paint, text and effect styles.
//
// All three share the "/" naming convention for grouping, so one tree builder
// serves them all. Style objects support pluginData via BaseStyle, which means
// notes attach directly to the style — same storage path as everything else.

import type { EntityKind, EntityStructure, Preview, TreeNode } from '../../shared/types'
import { liveNoteCount, readLog, scopedHost } from '../storage'
import { ancestorPaths, folderKeyPrefix } from '../../shared/folder'
import { buildTree, renderTreeOutline, type TreeInput } from '../../shared/tree'
import { cssEffects, cssPaints, fontWeight } from './paint'
import { variableRef } from './variables'

export type StyleKind = 'paintStyle' | 'textStyle' | 'effectStyle'

const caches: Record<StyleKind, BaseStyle[] | null> = {
  paintStyle: null,
  textStyle: null,
  effectStyle: null,
}

export async function getStyles(kind: StyleKind): Promise<BaseStyle[]> {
  if (!caches[kind]) {
    caches[kind] =
      kind === 'paintStyle'
        ? await figma.getLocalPaintStylesAsync()
        : kind === 'textStyle'
          ? await figma.getLocalTextStylesAsync()
          : await figma.getLocalEffectStylesAsync()
  }
  return caches[kind]!
}

export function invalidateStyleCache(): void {
  caches.paintStyle = null
  caches.textStyle = null
  caches.effectStyle = null
}

/** The swatch, shadow box or type sample shown beside a style. */
export function stylePreview(style: BaseStyle, kind: StyleKind): Preview | undefined {
  if (kind === 'paintStyle') {
    const css = cssPaints((style as PaintStyle).paints)
    return css ? { kind: 'color', values: [css] } : undefined
  }

  if (kind === 'effectStyle') {
    const { shadow, filter } = cssEffects((style as EffectStyle).effects)
    return shadow || filter ? { kind: 'effect', shadow, filter } : undefined
  }

  const text = style as TextStyle
  return { kind: 'text', size: text.fontSize, weight: fontWeight(text.fontName.style) }
}

export async function getStyleTree(kind: StyleKind): Promise<TreeNode[]> {
  const styles = await getStyles(kind)
  const inputs: TreeInput[] = styles.map((style) => ({
    entityId: style.id,
    entityKind: kind as EntityKind,
    name: style.name,
    noteCount: liveNoteCount(readLog(style)),
    preview: stylePreview(style, kind),
  }))
  const folderNotes: Record<string, number> = {}
  for (const style of styles) {
    const segments = style.name.split('/').filter(Boolean)
    for (const path of ancestorPaths(segments.slice(0, -1).join('/'))) {
      if (folderNotes[path] !== undefined) continue
      // Style groups have no container object, so the document hosts them.
      const host = scopedHost(figma.root, folderKeyPrefix({ scope: kind, path }))
      folderNotes[path] = liveNoteCount(readLog(host))
    }
  }

  return buildTree(inputs, kind, folderNotes)
}

/** Pre-rendered outline of a style group's folder structure, for the export. */
export async function styleStructureTree(kind: StyleKind): Promise<string> {
  const styles = await getStyles(kind)
  return renderTreeOutline(
    buildTree(
      styles.map((s) => ({
        entityId: s.id,
        entityKind: kind as EntityKind,
        name: s.name,
        noteCount: 0,
      }))
    )
  )
}

// ─── Per-style value summaries ───────────────────────────────────────────────

function toHex(color: RGB): string {
  const channel = (n: number) =>
    Math.round(Math.max(0, Math.min(1, n)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase()
}

function describePaint(paint: Paint): string {
  switch (paint.type) {
    case 'SOLID': {
      const hex = toHex(paint.color)
      const opacity = paint.opacity ?? 1
      return opacity < 1 ? `${hex} ${Math.round(opacity * 100)}%` : hex
    }
    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND': {
      const stops = paint.gradientStops.map((s) => toHex(s.color)).join(' → ')
      return `${paint.type.replace('GRADIENT_', '').toLowerCase()} gradient (${stops})`
    }
    case 'IMAGE':
      return 'image fill'
    default:
      return paint.type.toLowerCase()
  }
}

function describeEffect(effect: Effect): string {
  switch (effect.type) {
    case 'DROP_SHADOW':
    case 'INNER_SHADOW': {
      const label = effect.type === 'DROP_SHADOW' ? 'drop shadow' : 'inner shadow'
      const { offset, radius, spread, color } = effect
      return `${label} ${offset.x},${offset.y} blur ${radius}${spread ? ` spread ${spread}` : ''} ${toHex(color)} ${Math.round(color.a * 100)}%`
    }
    case 'LAYER_BLUR':
      return `layer blur ${effect.radius}`
    case 'BACKGROUND_BLUR':
      return `background blur ${effect.radius}`
    default:
      return effect.type.toLowerCase()
  }
}

/**
 * A style's value, as a variable reference where it is bound to one.
 *
 * A colour style painted from `neutral/1000` must never export as `#0A0A0A`.
 * The hex is only what it resolves to in whichever mode happened to be active;
 * the binding is the rule.
 *
 * This matters more than it looks. Theming modes are usually set at the
 * primitive level and reach everything above them through the alias chain, so a
 * hardcoded value anywhere in that chain severs the connection for every level
 * below it — the style stops responding to the mode, and so does every
 * component painted with it. Exporting the reference is what keeps a theme
 * switch working end to end.
 */
async function boundOrLiteral(
  bound: VariableAlias | undefined,
  literal: string
): Promise<string> {
  if (!bound) return `\`${literal}\``
  return variableRef(bound)
}

/**
 * The colour binding on a paint or effect, where the union member has one.
 *
 * Only some members carry `boundVariables` — a gradient paint and a shader
 * effect do not — so this narrows rather than casting, and an unbindable member
 * simply reports nothing.
 */
function colorBinding(value: Paint | Effect): VariableAlias | undefined {
  if (!('boundVariables' in value)) return undefined
  const bound = value.boundVariables as { color?: VariableAlias } | undefined
  return bound?.color
}

export async function styleStructure(
  style: BaseStyle,
  kind: StyleKind
): Promise<EntityStructure> {
  const base: EntityStructure = {
    typeLabel:
      kind === 'paintStyle' ? 'Color style' : kind === 'textStyle' ? 'Text style' : 'Effect style',
    description: style.description || undefined,
    preview: stylePreview(style, kind),
  }

  if (kind === 'paintStyle') {
    const paints = (style as PaintStyle).paints
    base.modeValues = []
    for (let i = 0; i < paints.length; i++) {
      const paint = paints[i]
      base.modeValues.push({
        modeName: paints.length > 1 ? `Layer ${i + 1}` : 'Value',
        value: await boundOrLiteral(colorBinding(paint), describePaint(paint)),
      })
    }
  }

  if (kind === 'effectStyle') {
    const effects = (style as EffectStyle).effects
    base.modeValues = []
    for (let i = 0; i < effects.length; i++) {
      const effect = effects[i]
      base.modeValues.push({
        modeName: effects.length > 1 ? `Effect ${i + 1}` : 'Value',
        value: await boundOrLiteral(colorBinding(effect), describeEffect(effect)),
      })
    }
  }

  if (kind === 'textStyle') {
    const text = style as TextStyle
    const lineHeight =
      text.lineHeight.unit === 'AUTO'
        ? 'auto'
        : `${text.lineHeight.value}${text.lineHeight.unit === 'PERCENT' ? '%' : 'px'}`
    const letterSpacing =
      text.letterSpacing.value === 0
        ? '0'
        : `${text.letterSpacing.value}${text.letterSpacing.unit === 'PERCENT' ? '%' : 'px'}`

    // Type scales get bound to number variables for the same reason colours do:
    // a density or breakpoint mode moves them all at once.
    const bound = text.boundVariables
    base.modeValues = [
      {
        modeName: 'Font',
        value: await boundOrLiteral(
          bound?.fontFamily,
          `${text.fontName.family} ${text.fontName.style}`
        ),
      },
      { modeName: 'Size', value: await boundOrLiteral(bound?.fontSize, `${text.fontSize}px`) },
      { modeName: 'Line height', value: await boundOrLiteral(bound?.lineHeight, lineHeight) },
      {
        modeName: 'Letter spacing',
        value: await boundOrLiteral(bound?.letterSpacing, letterSpacing),
      },
    ]
    if (text.textCase !== 'ORIGINAL') {
      base.modeValues.push({ modeName: 'Case', value: `\`${text.textCase}\`` })
    }
    if (text.textDecoration !== 'NONE') {
      base.modeValues.push({ modeName: 'Decoration', value: `\`${text.textDecoration}\`` })
    }
  }

  return base
}
