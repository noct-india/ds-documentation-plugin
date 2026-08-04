// Drafting documentation by driving Claude Code headlessly.
//
// MCP is pull-only — a server cannot make Claude start working. So when a
// request arrives from the plugin, the bridge runs `claude -p` itself, in
// batches, and streams the drafts back. The designer clicks once and walks away.

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

/**
 * How long one batch may take before it is abandoned.
 *
 * A spawned `claude` can block indefinitely — waiting on a trust prompt, a
 * stalled network call, anything. Without a ceiling that becomes a spinner that
 * never resolves and tells the designer nothing.
 */
const TIMEOUT_MS = Number(process.env.DSDOC_TIMEOUT_MS ?? 180_000)

/** Small enough that one bad batch is cheap, large enough to amortise startup. */
const BATCH_SIZE = 20
/**
 * Batches in flight at once.
 *
 * Each `claude -p` spends ~9s starting before it thinks, so the win here is
 * overlapping that dead time rather than raw throughput.
 */
const CONCURRENCY = Number(process.env.DSDOC_CONCURRENCY ?? 4)

/**
 * A ceiling on `claude` processes across every run at once.
 *
 * Per-run concurrency is not enough: firing five bulk drafts would otherwise
 * spawn twenty processes and bring the machine to its knees. Runs share this
 * pool, so queueing more work makes it slower, never unstable.
 */
const MAX_PROCESSES = Number(process.env.DSDOC_MAX_PROCESSES ?? 4)
let active = 0
const waiting = []

function acquire() {
  if (active < MAX_PROCESSES) {
    active++
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(resolve))
}

function release() {
  const next = waiting.shift()
  if (next) next()
  else active = Math.max(0, active - 1)
}

/** How many slots are busy and how many runs are stacked behind them. */
export function poolState() {
  return { active, queued: waiting.length, max: MAX_PROCESSES }
}

const SYSTEM = `You are documenting a design system so that an AI agent (Figma Make) can
build UI with it correctly. You write for machines that will follow your rules literally.

Be specific to THIS system. Never invent component or token names — only reference names
present in the context you are given. If you cannot infer something confidently from the
structure, names and image provided, omit it. Fewer, accurate notes beat complete coverage.
A confidently wrong rule is worse than a missing one, because it will be obeyed.

Write imperatively and in one sentence where possible. No hedging, no "consider", no
restating the element's own name back as its purpose.`

const SECTION_GUIDE = `Categories, and what each is for:
- purpose   — what this is, in one line. Not a restatement of its name.
- usage     — the situation that should make someone reach for it.
- instead   — when this is the WRONG choice, what to use instead. Highest value; only
              name alternatives that appear in the catalogue.
- pairs     — what it sits inside or next to (components only).
- states    — loading / empty / error / disabled behaviour (components only).
- content   — wording, casing, length of text inside it (components, text styles).
- rules     — hard constraints. Absolute, testable.
- donts     — a specific mistake someone would plausibly make.
- modes     — what each mode is for, which is the source of truth (collections only).
- naming    — the naming convention and what each part means (collections only).
- notes     — anything else worth knowing.`

function describeItem(item, ref) {
  // A short integer, not the entity id. Folder ids carry a \u001F separator and
  // component ids are long — either way, making the model echo one back exactly
  // is a weak link, and a mistyped id silently drops the whole note.
  const lines = [`### [${ref}] ${item.name}`, `kind: ${item.entityKind} (${item.typeLabel})`]

  if (item.parentName) lines.push(`in: ${item.parentName}`)
  if (item.description) lines.push(`figma description: ${item.description}`)
  if (item.modes?.length) lines.push(`modes: ${item.modes.join(', ')}`)
  if (item.values?.length) {
    lines.push(`values: ${item.values.map((v) => `${v.modeName}=${v.value}`).join(' · ')}`)
  }
  if (item.variantCount && item.variantCount > 1) lines.push(`variants: ${item.variantCount}`)
  if (item.properties?.length) {
    lines.push('properties:')
    for (const p of item.properties) {
      const options = p.options?.length ? ` [${p.options.join(' | ')}]` : ''
      lines.push(`  - ${p.displayName}: ${p.type}${options} default=${p.defaultValue}`)
    }
  }
  if (item.nests?.length) lines.push(`nests: ${item.nests.join(', ')}`)
  // The chain this sits inside, outermost first. A rule on the collection or a
  // folder applies to everything below it, so a draft must not contradict it.
  if (item.ancestry?.length) {
    lines.push('sits inside:')
    for (const level of item.ancestry) {
      lines.push(`  ${level.kind} "${level.name}"${level.notes.length ? ':' : ' (not documented)'}`)
      for (const note of level.notes) lines.push(`    - [${note.section}] ${note.text}`)
    }
  }
  if (item.existingNotes?.length) {
    lines.push('already documented (do NOT repeat these):')
    for (const note of item.existingNotes) lines.push(`  - [${note.section}] ${note.text}`)
  }

  return lines.join('\n')
}

/**
 * Sibling lists, emitted once per container rather than once per item.
 *
 * Every token in a collection carries the same neighbour list, so repeating it
 * per item made it ~90% of the prompt — 68 kB of a 75 kB batch was one list
 * twenty times over. Hoisting it is the single biggest thing that makes this
 * fast, and it costs nothing: the model still sees exactly the same names.
 */
function sharedSiblings(items) {
  const groups = new Map()
  for (const item of items) {
    if (!item.siblings?.length) continue
    const key = item.parentName ?? 'this set'
    if (!groups.has(key)) groups.set(key, item.siblings)
  }
  if (groups.size === 0) return ''

  const blocks = []
  for (const [container, names] of groups) {
    blocks.push(
      `Everything else in "${container}" — use these for contrast and redirects, and never name anything absent from this list:\n${names.slice(0, 200).join(', ')}`
    )
  }
  return blocks.join('\n\n')
}

export function buildPrompt(items, context) {
  const catalogue = context.componentNames?.length
    ? `Components that exist in this file (only ever reference these by name):\n${context.componentNames.slice(0, 250).join(', ')}`
    : ''

  const collections = context.collections?.length
    ? `Variable collections: ${context.collections.map((c) => `${c.name} (${c.modes.join('/')})`).join(' · ')}`
    : ''

  const project = context.projectNotes?.length
    ? `Project-level rules already written:\n${context.projectNotes.map((n) => `- [${n.section}] ${n.text}`).join('\n')}`
    : ''

  const brief = context.brief?.trim()
    ? `About this product — the most important context you have:\n${context.brief.trim()}`
    : ''

  return `Design system: ${context.fileName ?? 'unnamed'}

${[brief, collections, catalogue, project, sharedSiblings(items)].filter(Boolean).join('\n\n')}

${SECTION_GUIDE}

Document each element below. Skip any category you cannot fill confidently.
Where an element sits inside a documented collection or folder, your notes must be
consistent with those rules and must not restate them.

${items.map((item, i) => describeItem(item, i + 1)).join('\n\n')}

OUTPUT FORMAT — this is the whole reply. No preamble, no explanation, no summary
afterwards. A JSON array and nothing else:

[{"ref": 1, "section": "purpose", "text": "One sentence."}]

- "ref" is the bracketed number of the element above. Numbers only.
- Several entries per ref is fine. Omitting a ref entirely is fine.
- If you have nothing accurate to say about anything here, return exactly: []

Do not describe what you did. The array IS the answer.`
}

/** Pulls a JSON array out of a reply that may be fenced or have stray prose. */
function extractJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The Anthropic API, used when a key is present.
 *
 * The CLI path depends on a working `claude` login, which can expire or be
 * unreadable to a spawned process. Setting ANTHROPIC_API_KEY takes that whole
 * class of failure off the table.
 */
async function runApi(prompt, { model, signal, system = SYSTEM }) {
  const MODELS = { sonnet: 'claude-sonnet-4-5', opus: 'claude-opus-4-5', haiku: 'claude-haiku-4-5' }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODELS[model] ?? model,
        max_tokens: 8000,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      return { ok: false, error: `API ${response.status}: ${body.slice(0, 200)}` }
    }

    const data = await response.json()
    const text = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
    const drafts = extractJson(text)
    return { ok: true, drafts: drafts ?? [] }
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'cancelled' }
    return { ok: false, error: err.message }
  }
}

/**
 * One headless Claude run.
 *
 * The prompt goes over stdin rather than argv — a batch of twenty components
 * with their property tables comfortably exceeds the command-line length limit.
 */
function runClaude(prompt, { model, signal, log, system = SYSTEM }) {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      [
        '--print',
        '--output-format',
        'json',
        '--model',
        model,
        // Read-only: this run should never touch the filesystem.
        '--permission-mode',
        'plan',
        '--append-system-prompt',
        system,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        // A neutral directory: the bridge lives inside a project, and running
        // there can make Claude Code ask whether the folder is trusted — which
        // in a spawned process is an invisible, permanent block.
        cwd: tmpdir(),
        env: { ...process.env, CLAUDE_CODE_NONINTERACTIVE: '1' },
      }
    )

    let out = ''
    let err = ''
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      log?.(`timed out after ${Math.round(TIMEOUT_MS / 1000)}s${err ? ` — stderr: ${err.slice(0, 300)}` : ''}`)
      finish({
        ok: false,
        error:
          `\`claude\` did not respond within ${Math.round(TIMEOUT_MS / 1000)}s. ` +
          'Run `claude -p "ok"` in a terminal — if it waits for input, it needs to be ' +
          'trusted or logged in there first.',
      })
    }, TIMEOUT_MS)

    const onAbort = () => {
      child.kill('SIGTERM')
      finish({ ok: false, error: 'cancelled' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))

    child.on('error', (e) => {
      finish({
        ok: false,
        error:
          e.code === 'ENOENT'
            ? 'The `claude` command was not found. Install Claude Code, or turn auto-draft off.'
            : e.message,
      })
    })

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (settled) return

      if (!out.trim()) {
        finish({
          ok: false,
          error: `claude exited (${code}) with no output${err ? `: ${err.slice(0, 300)}` : ''}`,
        })
        return
      }

      let envelope
      try {
        envelope = JSON.parse(out)
      } catch {
        finish({ ok: false, error: `unreadable reply${err ? `: ${err.slice(0, 200)}` : ''}` })
        return
      }

      if (envelope.is_error) {
        // Surfaced verbatim: an expired login is the likeliest failure and the
        // message says so plainly.
        finish({ ok: false, error: envelope.result ?? 'Claude reported an error' })
        return
      }

      const drafts = extractJson(envelope.result)
      if (!drafts) {
        log?.(`no JSON in reply — model said: ${String(envelope.result).slice(0, 220)}`)
        finish({ ok: true, drafts: [] })
        return
      }
      finish({ ok: true, drafts, cost: envelope.total_cost_usd })
    })

    child.stdin.end(prompt)
  })
}

/**
 * Drafts a whole request, in batches, reporting as it goes.
 *
 * `onBatch` is called with each batch's drafts as they land, so the designer can
 * start reviewing the first twenty while the rest are still running.
 */
export async function draftRequest({ items, context, model = 'sonnet', signal, onBatch, onProgress, log }) {
  const batches = []
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE))
  }

  const kindById = new Map(items.map((i) => [i.entityId, i.entityKind]))

  let done = 0
  let drafted = 0
  let failed = 0
  let cost = 0
  let fatal = null

  let cursor = 0
  const worker = async () => {
    while (cursor < batches.length && !signal?.aborted && !fatal) {
      const index = cursor++
      const batch = batches[index]
      const prompt = buildPrompt(batch, context)

      const attempt = async (extra) => {
        await acquire()
        try {
          const full = extra ? `${prompt}\n\n${extra}` : prompt
          return process.env.ANTHROPIC_API_KEY
            ? await runApi(full, { model, signal })
            : await runClaude(full, { model, signal, log })
        } finally {
          release()
        }
      }

      let result = await attempt()

      // A model that answers in prose has understood the task and failed the
      // format. One terse nudge recovers it far more cheaply than losing the
      // batch — these runs cost real money and returned nothing.
      if (result.ok && (!result.drafts || result.drafts.length === 0)) {
        log?.(`batch ${index + 1}: no array in the reply, retrying once`)
        result = await attempt(
          'REMINDER: reply with the JSON array only. No sentences before or after it. ' +
            'If there is nothing to say, reply with [].'
        )
      }

      if (!result.ok) {
        if (result.error === 'cancelled') return
        failed++
        log?.(`batch ${index + 1}/${batches.length} failed — ${result.error}`)
        // An auth or missing-binary failure will hit every batch, so stop rather
        // than grinding through 32 identical errors.
        if (/not found|authenticate|401|OAuth/i.test(result.error)) fatal = result.error
        done += batch.length
        onProgress?.({ done, total: items.length, drafted, failed })
        continue
      }

      cost += result.cost ?? 0

      // Refs are per batch, so resolve them against this batch's items.
      const byRef = new Map(batch.map((item, i) => [i + 1, item]))
      const clean = (result.drafts ?? [])
        .map((d) => {
          if (!d || typeof d.text !== 'string' || !d.text.trim()) return null
          // Accept an entityId too, in case a model volunteers one.
          const item = byRef.get(Number(d.ref)) ?? batch.find((b) => b.entityId === d.entityId)
          if (!item) return null
          return {
            entityId: item.entityId,
            entityKind: kindById.get(item.entityId),
            section: d.section,
            text: d.text.trim(),
          }
        })
        .filter(Boolean)

      if (result.drafts?.length && clean.length === 0) {
        log?.(`batch ${index + 1}: ${result.drafts.length} entries but none resolved to an item`)
      }

      drafted += clean.length
      done += batch.length
      if (clean.length > 0) onBatch?.(clean)
      onProgress?.({ done, total: items.length, drafted, failed })
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker))

  return {
    drafted,
    failed,
    cost,
    cancelled: Boolean(signal?.aborted),
    error: fatal,
    batches: batches.length,
  }
}

// ─── Tidying what the designer typed ─────────────────────────────────────────

const POLISH_SYSTEM = `You tidy design system notes. You are a copy editor, not an author.

Fix grammar, capitalisation and punctuation. Turn a fragment into one clear sentence.
Prefer the imperative. Keep it short.

Absolute constraints:
- NEVER add information, qualifications or rules that were not written.
- NEVER change what the note means, or how strong it is. "usually" does not become "always".
- Keep every specific the author gave: names, numbers, mode names, component names.
- If a note is already clean, return it unchanged.

You are editing someone's words on their behalf. Being conservative is the whole job.`

/**
 * Cleans up raw notes without changing what they say.
 *
 * Runs after the note is already saved, so typing never waits on it, and the
 * original wording is always kept as a revision — a tidy that goes wrong is
 * undone by reverting, not by retyping.
 */
export async function polishNotes({ notes, context, model = 'haiku', signal, log }) {
  if (notes.length === 0) return { ok: true, edits: [] }

  const prompt = `${context?.brief ? `Product context (for tone only, do not import facts from it):\n${context.brief}\n\n` : ''}Tidy each note. Return ONLY a JSON array:
[{"id": "<id>", "text": "<tidied>"}]

${notes.map((n) => `id: ${n.id}\nabout: ${n.subject} (${n.kind})\ncategory: ${n.section}\nnote: ${n.text}`).join('\n\n')}`

  // Through the shared pool, so tidying cannot add a fifth process while four
  // drafting batches are already running.
  await acquire()
  let result
  try {
    result = process.env.ANTHROPIC_API_KEY
      ? await runApi(prompt, { model, signal, system: POLISH_SYSTEM })
      : await runClaude(prompt, { model, signal, log, system: POLISH_SYSTEM })
  } finally {
    release()
  }

  if (!result.ok) {
    log?.(`polish failed — ${result.error}`)
    return { ok: false, edits: [], error: result.error }
  }

  const byId = new Map(notes.map((n) => [n.id, n]))
  const edits = (result.drafts ?? [])
    .filter((d) => d && byId.has(d.id) && typeof d.text === 'string' && d.text.trim())
    // A "tidy" that returns the same words is not a change worth recording.
    .filter((d) => d.text.trim() !== byId.get(d.id).text.trim())
    .map((d) => ({ id: d.id, text: d.text.trim() }))

  return { ok: true, edits }
}

/**
 * Verifies the model is reachable before any real work depends on it.
 *
 * Run once at startup so a broken login is reported immediately, rather than
 * surfacing as a stalled request the first time a designer tries to use it.
 */
export async function preflight({ model = 'haiku', log } = {}) {
  const started = Date.now()
  const result = process.env.ANTHROPIC_API_KEY
    ? await runApi('Return exactly: []', { model, system: 'Reply with []' })
    : await runClaude('Return exactly: []', { model, log, system: 'Reply with []' })

  const ms = Date.now() - started
  if (result.ok) {
    log?.(
      `ready — ${process.env.ANTHROPIC_API_KEY ? 'Anthropic API' : '`claude` CLI'} responded in ${ms}ms`
    )
    return { ok: true }
  }

  log?.('NOT READY — drafting and tidying will fail until this is fixed:')
  log?.(`  ${result.error}`)
  log?.('  Try `claude -p "ok"` in a terminal. If that fails, run `claude` once to log in,')
  log?.('  or set ANTHROPIC_API_KEY to bypass the CLI entirely.')
  return { ok: false, error: result.error }
}
