// Automatic categorisation.
//
// Designers write documentation as sentences, not as filing decisions. Making
// someone pick a bucket before they can type turns a thought into admin, and
// the buckets are genuinely ambiguous anyway — "Always swap the placeholder
// icon. Don't use the wrapper as it is" is both a rule and a don't.
//
// So: type first, and this works out where it belongs. Deterministic, offline,
// and instant, which means the guess can be shown live while typing and
// corrected in one click. When the AI pass lands it can replace this wholesale
// without anything else changing.

import type { EntityKind, SectionKey } from './types'
import { sectionsFor } from './types'

interface Signal {
  section: SectionKey
  pattern: RegExp
  weight: number
}

/**
 * Patterns that suggest a category, with how strongly.
 *
 * No `g` flag anywhere — a global regex carries `lastIndex` between `.test()`
 * calls and would match every other time.
 */
const SIGNALS: Signal[] = [
  // Instead — an explicit redirect. Deliberately outweighs the "don't" it
  // usually travels with: "don't use X, use Y" is more useful to an agent
  // filed as the redirect than as the prohibition.
  // Weighted above a leading "don't" plus its lead bonus, so "Don't use a bare
  // button. Use the Button component instead." files as the redirect.
  { section: 'instead', pattern: /\binstead\b/i, weight: 10 },
  { section: 'instead', pattern: /\brather than\b/i, weight: 5 },
  { section: 'instead', pattern: /\bin place of\b/i, weight: 5 },
  { section: 'instead', pattern: /\bprefer\b/i, weight: 4 },
  { section: 'instead', pattern: /\bfor [^.,]{3,40}\buse\b/i, weight: 3 },

  // Don't. Weighted high because a prohibition is always the operative content
  // of the sentence containing it — "These are never used for X" is a don't,
  // not a description, even though it reads like one.
  { section: 'donts', pattern: /\b(don'?t|do not|never|must not|shouldn'?t|should not)\b/i, weight: 7 },
  { section: 'donts', pattern: /\bavoid\b/i, weight: 4 },
  { section: 'donts', pattern: /\bno longer\b/i, weight: 3 },

  // Rules
  { section: 'rules', pattern: /\balways\b/i, weight: 5 },
  { section: 'rules', pattern: /\bmust\b/i, weight: 4 },
  { section: 'rules', pattern: /\bonly (one|ever|use|the)\b/i, weight: 4 },
  { section: 'rules', pattern: /\b(required|mandatory|ensure)\b/i, weight: 3 },
  { section: 'rules', pattern: /\bevery\b/i, weight: 2 },

  // States
  { section: 'states', pattern: /\b(loading|disabled|skeleton|spinner)\b/i, weight: 6 },
  {
    section: 'states',
    pattern: /\b(empty|error|hover|pressed|focus|active|selected)[- ]?states?\b/i,
    weight: 6,
  },
  { section: 'states', pattern: /\bwhen (there (is|are) no|nothing|it fails)\b/i, weight: 4 },
  { section: 'states', pattern: /\b(empty|error)\b/i, weight: 2 },

  // Content and wording
  { section: 'content', pattern: /\b(sentence case|title case|uppercase|lowercase)\b/i, weight: 6 },
  {
    section: 'content',
    pattern: /\b(max(imum)?|at most|no more than) \w+ (characters?|words?|lines?)\b/i,
    weight: 6,
  },
  { section: 'content', pattern: /\b(wording|microcopy|copy should|phrasing)\b/i, weight: 5 },
  { section: 'content', pattern: /\b(tone|verb|reads?)\b/i, weight: 2 },
  { section: 'content', pattern: /\blabels?\b/i, weight: 2 },

  // Pairs with. "inside"/"within" are weak on their own — they locate something
  // without necessarily being a composition rule.
  {
    section: 'pairs',
    pattern: /\b(wrapped in|nested (in|inside)|sits (in|inside|next to)|pairs? with)\b/i,
    weight: 6,
  },
  { section: 'pairs', pattern: /\b(next to|alongside|together with|combined with)\b/i, weight: 4 },
  { section: 'pairs', pattern: /\b(inside|within)\b/i, weight: 2 },
  { section: 'pairs', pattern: /\bwrapper\b/i, weight: 1 },

  // Modes
  { section: 'modes', pattern: /\bmodes?\b/i, weight: 6 },
  { section: 'modes', pattern: /\bsource of truth\b/i, weight: 4 },
  { section: 'modes', pattern: /\b(light|dark)\b/i, weight: 2 },

  // Naming
  { section: 'naming', pattern: /\bnam(e|ed|ing|es)\b/i, weight: 5 },
  { section: 'naming', pattern: /\b(prefix|suffix|convention)\b/i, weight: 5 },

  // When to use
  { section: 'usage', pattern: /\buse (this|it|them) (when|for|wherever)\b/i, weight: 6 },
  { section: 'usage', pattern: /\bwhen(ever)? (you|the user|there|a|an|building)\b/i, weight: 5 },
  { section: 'usage', pattern: /\bshould be used\b/i, weight: 5 },
  { section: 'usage', pattern: /\bfor (cases|situations|any)\b/i, weight: 3 },

  // Purpose
  { section: 'purpose', pattern: /\b(used to|exists to|serves to|is meant to)\b/i, weight: 5 },
  { section: 'purpose', pattern: /\b(represents|provides|defines|dictates|controls)\b/i, weight: 4 },
  { section: 'purpose', pattern: /\bpurpose\b/i, weight: 4 },
  { section: 'purpose', pattern: /^(this |the )?[\w\s`'-]{0,30}\bis (a|an|the)\b/i, weight: 3 },
  // Definitional openers — "These are icons used in the main nav", "This is the
  // primary control". A statement about what something *is*, as opposed to an
  // instruction about what to do with it.
  { section: 'purpose', pattern: /^(these|those|this|that|they|it)\s+(is|are|was|were)\b/i, weight: 3 },
  // Passive description of a role: "used in the main navigation", "used for
  // headings". Distinct from "used to", which is already covered above.
  { section: 'purpose', pattern: /\bused\s+(in|for|as|by|across|throughout)\b/i, weight: 3 },
  // A bare definition — "The darkest neutral, for maximum contrast" — carries
  // no instruction verb at all. Weak enough that any real signal outranks it,
  // but it beats dumping a definition into Notes.
  { section: 'purpose', pattern: /^(the|a|an)\s+\w+/i, weight: 2 },

  // Layout / character — project level only.
  { section: 'layout', pattern: /\b(grid|columns?|gutter|breakpoints?|margins?)\b/i, weight: 5 },
  { section: 'layout', pattern: /\bevery (page|screen|view)\b/i, weight: 5 },
  { section: 'character', pattern: /\b(density|breathable|cramped|minimal|playful|restrained)\b/i, weight: 5 },
  { section: 'character', pattern: /\b(feels?|character|personality|aesthetic)\b/i, weight: 4 },
]

/**
 * Order used to settle ties, most specific first.
 *
 * A note that scores equally as a rule and a don't is more useful filed as the
 * don't; one that also offers an alternative is better still as the redirect.
 */
const TIE_BREAK: SectionKey[] = [
  'instead',
  'states',
  'content',
  'modes',
  'naming',
  'layout',
  'character',
  'pairs',
  'donts',
  'rules',
  'usage',
  'purpose',
  'notes',
]

/**
 * A signal near the start of a note describes its main point.
 *
 * The bonus has to exceed the gap between any two signal weights, or a strong
 * signal buried at the end outranks the clause the note actually leads with —
 * "Always swap the icon. Don't use the wrapper." would read as a don't.
 */
const LEAD_CHARS = 32
const LEAD_BONUS = 3

export interface Classification {
  section: SectionKey
  /** False when nothing matched and this is a fallback rather than a read. */
  confident: boolean
}

/**
 * Works out where a note belongs.
 *
 * Only categories valid for this kind of entity are considered — that alone
 * removes most misfiling, since "states" and "pairs with" simply do not apply
 * to a colour variable.
 */
export function classify(text: string, kind: EntityKind): Classification {
  const trimmed = text.trim()
  const allowed = sectionsFor(kind)
  const fallback: SectionKey = allowed.indexOf('notes') !== -1 ? 'notes' : allowed[0]
  if (!trimmed) return { section: fallback, confident: false }

  const scores = new Map<SectionKey, number>()
  const bonused = new Set<SectionKey>()

  for (const signal of SIGNALS) {
    if (allowed.indexOf(signal.section) === -1) continue
    const match = signal.pattern.exec(trimmed)
    if (!match) continue

    // At most one lead bonus per category. Awarding it per signal would let two
    // weak descriptive matches near the start outweigh one strong prohibition —
    // "These are never used for X" would read as a purpose rather than a don't.
    let bonus = 0
    if (match.index < LEAD_CHARS && !bonused.has(signal.section)) {
      bonus = LEAD_BONUS
      bonused.add(signal.section)
    }

    scores.set(signal.section, (scores.get(signal.section) ?? 0) + signal.weight + bonus)
  }

  if (scores.size === 0) return { section: fallback, confident: false }

  let best = fallback
  let bestScore = -1
  for (const section of TIE_BREAK) {
    const score = scores.get(section)
    if (score !== undefined && score > bestScore) {
      bestScore = score
      best = section
    }
  }

  return { section: best, confident: true }
}

// ─── Sentence-level classification ───────────────────────────────────────────

/** Abbreviations that end in a full stop without ending a sentence. */
const ABBREVIATION = /\b(e\.g|i\.e|etc|vs|approx|fig|min|max|no|ref|cf|incl)\.$/i

/**
 * Openings that point back at the sentence before.
 *
 * These are the whole reason splitting is safe: "Used to size icons. It should
 * never be edited directly." is one thought, and filing the second half under
 * Don't would strand a pronoun with nothing to refer to.
 */
const BACK_REFERENCE =
  /^(it|its|this|that|these|those|they|them|their|the same|also|and|but|so|then|otherwise|however|plus|there|which|doing so|either)\b/i

function wordCount(text: string): number {
  const words = text.trim().split(/\s+/)
  return words.length === 1 && words[0] === '' ? 0 : words.length
}

/**
 * Splits a line into sentences.
 *
 * Written as a scan rather than a regex so it avoids lookbehind, which is
 * ES2018 and cannot be down-levelled by the bundler.
 */
function splitLine(line: string): string[] {
  const text = line.trim()
  if (!text) return []

  const sentences: string[] = []
  let start = 0
  let i = 0

  while (i < text.length) {
    const char = text[i]
    if (char !== '.' && char !== '!' && char !== '?') {
      i++
      continue
    }

    // Swallow runs like "?!" or "..." so they end one sentence, not three.
    let end = i
    while (end + 1 < text.length && '.!?'.indexOf(text[end + 1]) !== -1) end++

    const rest = text.slice(end + 1)
    const candidate = text.slice(start, end + 1).trim()

    // A decimal ("1.5") or a mid-word dot is not a sentence end.
    const followedBySpace = rest === '' || /^\s/.test(rest)
    const trimmedRest = rest.replace(/^\s+/, '')
    const continuesLowercase = /^[a-z]/.test(trimmedRest)

    if (
      !followedBySpace ||
      !candidate ||
      ABBREVIATION.test(candidate) ||
      continuesLowercase
    ) {
      i = end + 1
      continue
    }

    sentences.push(candidate)
    start = end + 1
    i = end + 1
  }

  const tail = text.slice(start).trim()
  if (tail) sentences.push(tail)
  return sentences
}

/** Splits a whole note into sentences, treating newlines as hard breaks. */
export function splitIntoSentences(input: string): string[] {
  const out: string[] = []
  for (const line of input.split(/\n+/)) {
    for (const sentence of splitLine(line)) out.push(sentence)
  }
  return out
}

export interface Segment {
  section: SectionKey
  text: string
}

/**
 * Classifies a note sentence by sentence, keeping dependent sentences together.
 *
 * A note like "Always swap the placeholder icon. Don't use the wrapper as it
 * is." is genuinely two rules living in two categories, and filing the whole
 * thing under whichever one led is lossy. But splitting blindly is worse — so a
 * sentence stays welded to the one before it when it cannot stand alone:
 *
 *   - it carries no category signal of its own,
 *   - it opens with a back-reference ("It should never…"),
 *   - or it is too short to be a complete thought.
 *
 * Adjacent sentences that land in the same category are also merged, so a
 * three-sentence rule stays one bullet.
 */
export function classifySegments(text: string, kind: EntityKind): Segment[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const sentences = splitIntoSentences(trimmed)
  const whole = (): Segment[] => [{ section: classify(trimmed, kind).section, text: trimmed }]
  if (sentences.length <= 1) return whole()

  const segments: Segment[] = []

  for (const sentence of sentences) {
    const result = classify(sentence, kind)
    const previous = segments.length > 0 ? segments[segments.length - 1] : null

    if (previous) {
      // Under three words is a fragment ("Ever.", "No exceptions."). Three is
      // already a complete instruction — "Never hand-space them." — so the
      // threshold has to sit below it or real rules get swallowed.
      const cannotStandAlone =
        !result.confident || BACK_REFERENCE.test(sentence) || wordCount(sentence) < 3
      if (cannotStandAlone || previous.section === result.section) {
        previous.text = `${previous.text} ${sentence}`
        continue
      }
    }

    segments.push({ section: result.section, text: sentence })
  }

  return segments.length > 0 ? segments : whole()
}
