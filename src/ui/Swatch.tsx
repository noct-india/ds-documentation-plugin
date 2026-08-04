// Visual stand-ins for tokens and styles, so a list of names reads the way
// Figma's own Variables and Assets panels do.

import type { Preview } from '../shared/types'

interface Props {
  preview?: Preview
  /** `lg` is the detail-screen size; `sm` is a list row. */
  size?: 'sm' | 'lg'
}

export function Swatch({ preview, size = 'sm' }: Props) {
  if (!preview) return null
  const large = size === 'lg'

  if (preview.kind === 'color') {
    // A variable with several modes gets one stripe per mode, in collection
    // order — the same way Figma shows a token that differs across themes.
    return (
      <span className={`swatch${large ? ' lg' : ''}`} title={preview.values.join(' · ')}>
        {preview.values.slice(0, 4).map((value, i) => (
          <span key={i} className="swatch-part" style={{ background: value }} />
        ))}
      </span>
    )
  }

  if (preview.kind === 'effect') {
    return (
      <span className={`swatch${large ? ' lg' : ''}`}>
        <span
          className="swatch-effect"
          style={{ boxShadow: preview.shadow, filter: preview.filter }}
        />
      </span>
    )
  }

  // Type: a scaled "Ag" carrying the real weight, with the size beside it.
  const scale = large ? 1 : 0.55
  return (
    <span className={`swatch type${large ? ' lg' : ''}`}>
      <span
        style={{
          fontSize: `${Math.max(8, Math.min(preview.size * scale, large ? 34 : 15))}px`,
          fontWeight: preview.weight,
          lineHeight: 1,
        }}
      >
        Ag
      </span>
    </span>
  )
}
