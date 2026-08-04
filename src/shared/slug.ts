/**
 * Filename slugging for the exported markdown.
 *
 * Follows the convention set in the brief: "Primitive Colors" → primitivecolors.md
 * — lowercase, punctuation and spaces stripped entirely.
 */
export function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[/\\]/g, '-') // component names often carry "/" grouping
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned || 'untitled'
}

/**
 * Folder for a component's markdown, mirroring how the Figma file is arranged.
 *
 * `components/<page>/<section>/`. Pass a null section for components that sit
 * loose on a page — the synthetic "Ungrouped" bucket is not a real section and
 * should not become a folder.
 */
export function componentDir(page: string, section: string | null): string {
  const parts = ['components', slug(page)]
  if (section) parts.push(slug(section))
  return parts.join('/')
}

/**
 * Slugs a batch of names, appending -2, -3 … to collisions.
 *
 * Filenames must be unique across the *whole* export, not just within a folder:
 * Figma Make takes files dragged in one at a time, so a designer may well end up
 * dropping everything flat into `guidelines/`. Uniqueness keeps that working.
 */
export function uniqueSlugger(): (name: string) => string {
  const seen = new Map<string, number>()
  return (name: string) => {
    const base = slug(name)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}-${n}`
  }
}
