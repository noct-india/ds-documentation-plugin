// Turning Figma paint, effect and type data into CSS the plugin UI can render.
//
// Lets the list rows show real swatches instead of a generic icon, so browsing
// the plugin reads the way Figma's own Variables and Assets panels do.

/** Figma stores channels 0–1; CSS wants 0–255. */
function channel(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 255)
}

export function cssColor(color: RGB | RGBA, opacity = 1): string {
  const alpha = ('a' in color ? color.a : 1) * opacity
  const rgb = `${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}`
  return alpha < 1 ? `rgba(${rgb}, ${Number(alpha.toFixed(3))})` : `rgb(${rgb})`
}

/**
 * Angle of a linear gradient, in CSS degrees.
 *
 * Figma describes gradients with a transform matrix rather than an angle. This
 * reads the direction off the first row and shifts to CSS's "0deg points up"
 * convention. Approximate by design — it renders into a 16px swatch.
 */
function gradientAngle(transform: Transform): number {
  const [[a, b]] = transform
  return Math.round((Math.atan2(b, a) * 180) / Math.PI) + 90
}

function gradientStops(paint: GradientPaint, opacity: number): string {
  return paint.gradientStops
    .map((stop) => `${cssColor(stop.color, opacity)} ${Math.round(stop.position * 100)}%`)
    .join(', ')
}

/** CSS `background` for one paint, or null for paints with no flat equivalent. */
export function cssPaint(paint: Paint): string | null {
  if (paint.visible === false) return null
  const opacity = paint.opacity ?? 1

  switch (paint.type) {
    case 'SOLID':
      return cssColor(paint.color, opacity)
    case 'GRADIENT_LINEAR':
      return `linear-gradient(${gradientAngle(paint.gradientTransform)}deg, ${gradientStops(paint, opacity)})`
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_DIAMOND':
      return `radial-gradient(circle, ${gradientStops(paint, opacity)})`
    case 'GRADIENT_ANGULAR':
      return `conic-gradient(${gradientStops(paint, opacity)})`
    default:
      // Image and video fills have no CSS stand-in without exporting bytes.
      return null
  }
}

/**
 * The first paint that can be drawn.
 *
 * A style may stack several; the swatch shows the topmost renderable one rather
 * than trying to composite, which at 16px would be indistinguishable anyway.
 */
export function cssPaints(paints: readonly Paint[]): string | null {
  for (const paint of paints) {
    const css = cssPaint(paint)
    if (css) return css
  }
  return null
}

/** CSS shadow and blur for an effect style. */
export function cssEffects(effects: readonly Effect[]): { shadow?: string; filter?: string } {
  const shadows: string[] = []
  let filter: string | undefined

  for (const effect of effects) {
    if (effect.visible === false) continue
    switch (effect.type) {
      case 'DROP_SHADOW':
      case 'INNER_SHADOW': {
        const inset = effect.type === 'INNER_SHADOW' ? 'inset ' : ''
        const spread = effect.spread ?? 0
        shadows.push(
          `${inset}${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${spread}px ${cssColor(effect.color)}`
        )
        break
      }
      case 'LAYER_BLUR':
      case 'BACKGROUND_BLUR':
        filter = `blur(${Math.min(effect.radius, 12)}px)`
        break
      default:
        break
    }
  }

  return { shadow: shadows.length > 0 ? shadows.join(', ') : undefined, filter }
}

const WEIGHTS: Array<[RegExp, number]> = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/regular|normal|book/i, 400],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
]

/**
 * Numeric weight from a Figma style name ("Semibold", "Light Italic").
 *
 * Order matters — "Semibold" and "Extrabold" both contain "bold", so the
 * compound names have to be tested before the bare one.
 */
export function fontWeight(styleName: string): number {
  for (const [pattern, weight] of WEIGHTS) {
    if (pattern.test(styleName)) return weight
  }
  return 400
}
