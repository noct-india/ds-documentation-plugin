// Inline SVG icons. Kept here rather than pulled from a package — the UI has to
// bundle into a single self-contained HTML file, so every byte is inlined.
//
// Where an icon stands for something Figma already has a mark for, it matches
// Figma's: designers scan for those shapes, and a near-miss reads as the wrong
// kind of thing entirely.

interface IconProps {
  size?: number
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

// ─── Navigation ──────────────────────────────────────────────────────────────

export const ArrowLeft = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M10 3 5 8l5 5" />
  </svg>
)

export const Chevron = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M6 3l5 5-5 5" />
  </svg>
)

export const Folder = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.3 1.5h5.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z" />
  </svg>
)

export const Page = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 2h5l3 3v9H4z" />
    <path d="M9 2v3h3" />
  </svg>
)

export const Book = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 3h4a2 2 0 0 1 2 2v8a1.5 1.5 0 0 0-1.5-1.5H3z" />
    <path d="M13 3H9a2 2 0 0 0-2 2v8a1.5 1.5 0 0 1 1.5-1.5H13z" />
  </svg>
)

export const Rules = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 4h10M3 8h10M3 12h6" />
  </svg>
)

export const Activity = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M1.5 8h3l2-5 2.5 10 2-5h3" />
  </svg>
)

// ─── Figma's own marks ───────────────────────────────────────────────────────

/**
 * Variable: a hexagon around a dot.
 *
 * Flat top and bottom, points at left and right. A sharp-cornered diamond —
 * which this used to be — is Figma's *instance* mark, so it read as the wrong
 * kind of thing entirely.
 */
export const Variable = ({ size = 14 }: IconProps) => (
  <svg {...base(size)} strokeWidth={1.3}>
    <path d="M13.6 8 10.8 12.9H5.2L2.4 8 5.2 3.1h5.6z" />
    <circle cx="8" cy="8" r="1.7" />
  </svg>
)

/**
 * Component: a four-pointed star.
 *
 * The concave sides are what make it read as a component rather than a shape.
 * Sets share this mark — whether variants exist is already in the properties
 * table, so a second glyph only repeated it.
 */
export const Component = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M8 1.5C8 4 4 8 1.5 8C4 8 8 12 8 14.5C8 12 12 8 14.5 8C12 8 8 4 8 1.5Z" />
  </svg>
)

/** Instance — a plain diamond, distinct from the rounded variable hexagon. */
export const Diamond = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M8 2l6 6-6 6-6-6z" />
  </svg>
)

// ─── Styles ──────────────────────────────────────────────────────────────────

export const Circle = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="8" cy="8" r="5.5" />
  </svg>
)

export const HalfCircle = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor" />
  </svg>
)

export const TypeIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 4V3h10v1M8 3v10M6 13h4" />
  </svg>
)

// ─── Actions ─────────────────────────────────────────────────────────────────

export const Mic = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="6" y="1.5" width="4" height="8" rx="2" />
    <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" />
  </svg>
)

export const Send = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M14 2 2 7l5 2 2 5z" />
  </svg>
)

export const Target = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="1.5" />
  </svg>
)

export const Download = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M8 2v8m0 0 3-3m-3 3L5 7M2.5 12.5h11" />
  </svg>
)
