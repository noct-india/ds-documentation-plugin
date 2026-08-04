#!/usr/bin/env node
// Bridges the Design System Documentation Figma plugin to Claude.
//
// One process, two faces:
//   • a WebSocket server the plugin connects to (localhost only)
//   • an MCP server over stdio that Claude drives
//
// The plugin cannot talk to Claude and Claude cannot talk to the plugin, so
// this sits in the middle holding requests and drafts. Nothing is persisted —
// state lives only while the process does, which is the session.
//
// IMPORTANT: stdout is the MCP protocol channel. Every log goes to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { draftRequest, polishNotes, poolState, preflight } from './draft.mjs'
import { Session } from './session.mjs'

/**
 * Where this file lives, told to the plugin on connect.
 *
 * A Figma plugin cannot see the filesystem and has no idea where its own folder
 * is, so it can never tell a designer where the launcher is. The bridge does
 * know, and it is the same folder on whoever's machine it is running on — which
 * is the only way this survives being zipped and passed around.
 */
const HOME = dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.DSDOC_BRIDGE_PORT ?? 8473)
/** Draft automatically on arrival. Set DSDOC_AUTO_DRAFT=0 to require asking Claude. */
const AUTO = process.env.DSDOC_AUTO_DRAFT !== '0'
const MODEL = process.env.DSDOC_MODEL ?? 'sonnet'
/** Tidying is short and frequent, so it uses the fastest model. */
const POLISH_MODEL = process.env.DSDOC_POLISH_MODEL ?? 'haiku'
const log = (...args) => console.error('[ds-bridge]', ...args)

// ─── State ───────────────────────────────────────────────────────────────────

/** The connected plugin, if any. Only one Figma file at a time. */
let plugin = null
let pluginInfo = { fileName: null, connectedAt: null }

/** requestId → { id, mode, scope, items, context, createdAt, drafted } */
const requests = new Map()

/** Requests the plugin has withdrawn; kept briefly so late submits fail loudly. */
const cancelled = new Set()

/**
 * Drafts that arrived while no plugin was listening.
 *
 * Drafting a large request takes a while, and a designer who sends one then
 * closes the plugin should not silently lose the results. These are flushed the
 * moment a plugin reconnects.
 */
const undelivered = []

function send(message) {
  if (!plugin || plugin.readyState !== 1) return false
  plugin.send(JSON.stringify(message))
  return true
}

/** Queues when nobody is listening, so nothing drafted is thrown away. */
function deliver(message) {
  if (send(message)) return true
  undelivered.push(message)
  log(`plugin not connected — holding ${message.drafts?.length ?? 0} draft(s) until it returns`)
  return false
}

function flush() {
  if (undelivered.length === 0) return
  const held = undelivered.splice(0, undelivered.length)
  let sent = 0
  for (const message of held) {
    if (send(message)) sent++
    else undelivered.push(message)
  }
  if (sent > 0) log(`delivered ${sent} held message(s)`)
}

// ─── WebSocket face (the plugin) ─────────────────────────────────────────────

/**
 * Both loopback addresses, same port.
 *
 * `localhost` resolves to ::1 on macOS and 127.0.0.1 elsewhere, and there is no
 * saying which one Figma's iframe will pick. Binding only one leaves a failure
 * that looks exactly like "the bridge isn't running" and is miserable to
 * diagnose remotely, so listen on both. Loopback only — never reachable from
 * another machine.
 */
const HOSTS = ['127.0.0.1', '::1']

function handleConnection(socket) {
  // One plugin at a time — a second Figma file would silently overwrite the
  // first one's requests, so the newest wins and the old one is closed.
  if (plugin && plugin.readyState === 1) {
    log('replacing an existing plugin connection')
    try {
      plugin.close(1000, 'replaced by a newer connection')
    } catch {
      /* already gone */
    }
  }
  plugin = socket
  pluginInfo = { fileName: null, connectedAt: new Date().toISOString() }
  log('plugin connected')

  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      log('ignoring unparseable message')
      return
    }

    switch (message.t) {
      case 'hello':
        pluginInfo.fileName = message.fileName ?? null
        log(`plugin identified: ${pluginInfo.fileName ?? 'unnamed file'}`)
        send({ t: 'ready', port: PORT, home: HOME })
        flush()
        break

      case 'request': {
        const { id, mode, scope, items, context } = message
        if (!id || !Array.isArray(items)) {
          log('rejecting a malformed request')
          return
        }
        requests.set(id, {
          id,
          mode: mode ?? 'single',
          scope: scope ?? '',
          items,
          context: context ?? {},
          createdAt: new Date().toISOString(),
          drafted: 0,
        })
        cancelled.delete(id)

        // Summarised to stderr so a bad payload is visible without an MCP
        // client attached — the plugin side is the part hardest to inspect.
        const withImages = items.filter((i) => i.imagePng).length
        const kb = Math.round(JSON.stringify(items).length / 1024)
        log(`request ${id} — ${mode} · ${items.length} item(s) · ${scope}`)
        log(`  ${withImages} with images · ~${kb} kB · ${items.map((i) => i.name).slice(0, 8).join(', ')}${items.length > 8 ? ' …' : ''}`)
        const thin = items.filter((i) => !i.typeLabel || !i.entityId)
        if (thin.length > 0) log(`  ⚠ ${thin.length} item(s) missing basic fields`)

        send({ t: 'ack', id })
        if (AUTO) startDrafting(id)
        break
      }

      case 'mirror': {
        // The plugin exports every note as markdown; Claude reads it as files,
        // so it can grep the whole system rather than one entity at a time.
        getSession()
          .writeMirror(message.files ?? [])
          .catch((err) => log(`mirror failed — ${err.message}`))
        break
      }

      case 'chat': {
        const { threadId, label, text, context } = message
        if (!text?.trim()) break
        getSession()
          .ask({ threadId, label, text, context })
          .then((id) => {
            send({ t: 'chatQueued', threadId, messageId: id })
            track(id, {
              kind: 'chat',
              label: label || 'Question',
              status: 'running',
              threadId,
            })
          })
          .catch((err) => {
            log(`chat failed — ${err.message}`)
            send({ t: 'chatFailed', threadId, error: err.message })
          })
        break
      }

      case 'polish': {
        const notes = message.notes ?? []
        if (notes.length === 0) break

        // The note is already saved, so this never blocks anything — but the
        // designer should still see it happening, and see it when it fails.
        const tidyId = `tidy-${Date.now().toString(36)}`
        send({ t: 'polishing', count: notes.length })
        track(tidyId, {
          kind: 'tidy',
          label: `${notes.length} note${notes.length === 1 ? '' : 's'}`,
          status: 'running',
        })

        polishNotes({ notes, context: message.context ?? {}, model: POLISH_MODEL, log })
          .then((result) => {
            if (!result.ok) {
              send({ t: 'polishFailed', error: result.error })
              track(tidyId, { status: 'failed', error: result.error })
              untrack(tidyId, 15000)
              return
            }
            deliver({ t: 'polished', edits: result.edits })
            track(tidyId, { status: 'done', drafted: result.edits.length })
            untrack(tidyId)
          })
          .catch((err) => {
            log(`polish crashed — ${err.message}`)
            send({ t: 'polishFailed', error: err.message })
            track(tidyId, { status: 'failed', error: err.message })
            untrack(tidyId, 15000)
          })
        break
      }

      case 'cancel': {
        const run = running.get(message.id)
        if (run) run.abort()
        requests.delete(message.id)
        cancelled.add(message.id)
        track(message.id, { status: 'cancelled' })
        untrack(message.id, 2000)
        log(`request ${message.id} cancelled by the plugin`)
        break
      }

      default:
        break
    }
  })

  socket.on('close', () => {
    if (plugin === socket) {
      plugin = null
      pluginInfo = { fileName: null, connectedAt: null }
      log('plugin disconnected')
    }
  })

  socket.on('error', (err) => log('socket error:', err.message))
}

let bound = 0
const servers = HOSTS.map((host) => {
  const server = new WebSocketServer({ host, port: PORT })
  server.on('connection', handleConnection)
  server.on('listening', () => {
    bound++
    log(`listening on ${host === '::1' ? `[${host}]` : host}:${PORT}`)
  })
  server.on('error', (err) => {
    // One family missing is fine as long as the other bound. A port already in
    // use is not, and is nearly always a second bridge still running.
    if (err.code === 'EADDRINUSE') {
      log(`port ${PORT} is already in use on ${host} — close the other bridge, or set DSDOC_BRIDGE_PORT`)
    } else {
      log(`could not listen on ${host}:${PORT} — ${err.message}`)
    }
  })
  return server
})

setTimeout(() => {
  if (bound === 0) log(`nothing bound on port ${PORT}; the plugin will not connect`)
  else log(`plugin should connect on ws://localhost:${PORT}`)
}, 500)

/** Checked once at startup so a broken login is known before it is needed. */
let modelReady = null
if (AUTO) {
  preflight({ model: POLISH_MODEL, log }).then((r) => {
    modelReady = r.ok ? true : r.error
  })
}

// ─── Activity ────────────────────────────────────────────────────────────────

/**
 * Everything in flight, in one list.
 *
 * Drafting runs and chat turns queue independently but compete for the same
 * process pool, so the only honest picture is a combined one.
 */
const activity = new Map()

function track(id, patch) {
  const existing = activity.get(id) ?? { id, startedAt: Date.now() }
  activity.set(id, { ...existing, ...patch })
  emitActivity()
}

function untrack(id, delay = 6000) {
  // Finished work lingers briefly so a run that completes while you are looking
  // elsewhere does not vanish without trace.
  setTimeout(() => {
    activity.delete(id)
    emitActivity()
  }, delay)
}

function emitActivity() {
  send({
    t: 'activity',
    items: Array.from(activity.values()).sort((a, b) => a.startedAt - b.startedAt),
    pool: poolState(),
  })
}

// ─── Conversation ────────────────────────────────────────────────────────────

/**
 * One session for the whole file.
 *
 * Turns queue rather than running in parallel: a second `claude` process would
 * double the memory and lose the shared conversational context, which is the
 * main reason a session beats one-shot calls.
 */
let session = null

function getSession() {
  if (!session) {
    session = new Session({ emit: (event) => send(event), log })
  }
  return session
}

// ─── Auto-drafting ───────────────────────────────────────────────────────────

/** requestId → AbortController, for runs currently in flight. */
const running = new Map()

/**
 * Drafts a request the moment it arrives.
 *
 * MCP is pull-only — nothing can make Claude start working on its own — so the
 * bridge drives a headless `claude -p` itself. The designer clicks once in
 * Figma and the drafts come back without anyone asking for them.
 */
async function startDrafting(requestId) {
  const request = requests.get(requestId)
  if (!request || running.has(requestId)) return

  const controller = new AbortController()
  running.set(requestId, controller)

  if (typeof modelReady === 'string') {
    log('refusing to draft — the model was unreachable at startup')
    send({ t: 'draftFailed', requestId, error: modelReady })
    running.delete(requestId)
    return
  }

  log(`drafting ${request.items.length} item(s) with ${MODEL}…`)
  send({ t: 'drafting', requestId, done: 0, total: request.items.length })
  track(requestId, {
    kind: 'draft',
    label: request.scope || `${request.items.length} items`,
    status: 'running',
    done: 0,
    total: request.items.length,
    drafted: 0,
  })

  try {
    const summary = await draftRequest({
      items: request.items,
      context: request.context,
      model: MODEL,
      signal: controller.signal,
      log,
      // Delivered per batch so the first twenty can be reviewed while the rest
      // are still running.
      onBatch: (drafts) => {
        request.drafted += drafts.length
        deliver({ t: 'drafts', requestId, drafts, done: false })
      },
      onProgress: (p) => {
        send({ t: 'drafting', requestId, ...p })
        track(requestId, { done: p.done, total: p.total, drafted: p.drafted })
      },
    })

    if (summary.error) {
      log(`drafting stopped — ${summary.error}`)
      send({ t: 'draftFailed', requestId, error: summary.error })
      track(requestId, { status: 'failed', error: summary.error })
      untrack(requestId, 15000)
    } else if (summary.cancelled) {
      track(requestId, { status: 'cancelled' })
      untrack(requestId)
    } else {
      const spent = summary.cost ? ` · $${summary.cost.toFixed(2)}` : ''
      log(`drafted ${summary.drafted} note(s) across ${summary.batches} batch(es)${spent}`)
      deliver({ t: 'drafts', requestId, drafts: [], done: true })
      send({ t: 'draftDone', requestId, drafted: summary.drafted, failed: summary.failed })
      track(requestId, { status: 'done', drafted: summary.drafted })
      untrack(requestId)
    }
  } catch (err) {
    log(`drafting crashed — ${err.message}`)
    send({ t: 'draftFailed', requestId, error: err.message })
    track(requestId, { status: 'failed', error: err.message })
    untrack(requestId, 15000)
  } finally {
    running.delete(requestId)
    requests.delete(requestId)
  }
}

// ─── MCP face (Claude) ───────────────────────────────────────────────────────

const mcp = new McpServer({ name: 'ds-documentation-bridge', version: '0.1.0' })

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

mcp.tool(
  'figma_docs_status',
  'Check whether the Design System Documentation Figma plugin is connected, and list ' +
    'documentation requests it is waiting on. Call this first.',
  {},
  async () => {
    const pending = Array.from(requests.values()).map((r) => ({
      requestId: r.id,
      mode: r.mode,
      scope: r.scope,
      items: r.items.length,
      drafted: r.drafted,
      createdAt: r.createdAt,
    }))

    return text({
      pluginConnected: Boolean(plugin && plugin.readyState === 1),
      fileName: pluginInfo.fileName,
      pendingRequests: pending,
      hint: pending.length
        ? 'Call figma_docs_get_items to read a request, then figma_docs_submit_drafts to answer it.'
        : 'Nothing pending. In Figma, use "Draft with Claude" in the plugin to send a request.',
    })
  }
)

mcp.tool(
  'figma_docs_get_items',
  'Read the design system elements in a request, with their structure, existing notes, ' +
    'and shared project context. Paginate with offset/limit for large requests. ' +
    'Component images are returned when withImages is true and the page is small.',
  {
    requestId: z.string().describe('From figma_docs_status'),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(20),
    withImages: z
      .boolean()
      .default(false)
      .describe('Attach component PNGs. Only honoured for pages of 10 or fewer.'),
  },
  async ({ requestId, offset, limit, withImages }) => {
    const request = requests.get(requestId)
    if (!request) {
      return text(`No request ${requestId}. Call figma_docs_status for current requests.`)
    }

    const slice = request.items.slice(offset, offset + limit)
    // Images are large; a big page of them would swamp the context and tell you
    // less than the structure already does.
    const sendImages = withImages && slice.length <= 10

    const payload = {
      requestId,
      mode: request.mode,
      scope: request.scope,
      total: request.items.length,
      offset,
      returned: slice.length,
      hasMore: offset + slice.length < request.items.length,
      projectContext: request.context,
      items: slice.map((item) => {
        const { imagePng, ...rest } = item
        return sendImages ? rest : { ...rest, hasImage: Boolean(imagePng) }
      }),
    }

    const content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }]

    if (sendImages) {
      for (const item of slice) {
        if (!item.imagePng) continue
        content.push({ type: 'text', text: `Image — ${item.name} (${item.entityId}):` })
        content.push({ type: 'image', data: item.imagePng, mimeType: 'image/png' })
      }
    }

    return { content }
  }
)

const DraftSchema = z.object({
  entityId: z.string(),
  entityKind: z.enum([
    'variable',
    'collection',
    'paintStyle',
    'textStyle',
    'effectStyle',
    'component',
    'componentSet',
    'project',
  ]),
  section: z.enum([
    'purpose',
    'character',
    'layout',
    'usage',
    'instead',
    'modes',
    'naming',
    'pairs',
    'states',
    'content',
    'rules',
    'donts',
    'notes',
  ]),
  text: z.string().min(1).describe('One rule, one sentence where possible. Imperative.'),
})

mcp.tool(
  'figma_docs_submit_drafts',
  'Send drafted notes back to the plugin. They arrive as DRAFTS for the designer to ' +
    'approve, edit or reject — they are not applied and are excluded from export until ' +
    'approved. Submit in batches as you work; call repeatedly for the same request.',
  {
    requestId: z.string(),
    drafts: z.array(DraftSchema).min(1).max(200),
    done: z
      .boolean()
      .default(false)
      .describe('True when this is the last batch for the request.'),
  },
  async ({ requestId, drafts, done }) => {
    if (cancelled.has(requestId)) {
      return text(`Request ${requestId} was cancelled in the plugin. Nothing was applied.`)
    }
    const request = requests.get(requestId)
    if (!request) {
      return text(`No request ${requestId}. It may have been answered or cancelled already.`)
    }

    // Only accept drafts for entities the plugin actually asked about — a typo
    // in an entityId would otherwise silently document the wrong thing.
    const known = new Set(request.items.map((i) => i.entityId))
    const accepted = drafts.filter((d) => known.has(d.entityId))
    const rejected = drafts.filter((d) => !known.has(d.entityId))

    if (accepted.length === 0) {
      return text({
        applied: 0,
        error: 'None of these entityIds are part of that request.',
        unknownIds: rejected.map((d) => d.entityId).slice(0, 10),
      })
    }

    const live = deliver({ t: 'drafts', requestId, drafts: accepted, done })
    request.drafted += accepted.length
    if (done) requests.delete(requestId)

    return text({
      applied: accepted.length,
      skippedUnknownIds: rejected.length,
      totalDraftedForRequest: request.drafted,
      status: live
        ? done
          ? 'Request closed. The designer reviews the drafts in Figma.'
          : 'Batch delivered. Continue with the next page of items.'
        : 'The plugin is closed — these are held and will arrive when it reopens. Carry on drafting.',
    })
  }
)

await mcp.connect(new StdioServerTransport())
log('MCP ready on stdio')

const shutdown = () => {
  log('shutting down')
  session?.stop().catch(() => {})
  for (const server of servers) {
    try {
      server.close()
    } catch {
      /* already closed */
    }
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
