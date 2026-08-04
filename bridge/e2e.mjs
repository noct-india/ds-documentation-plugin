// End-to-end check of the bridge, with a stand-in for the plugin.
//
// Drives the real server over both faces at once: a WebSocket client pretending
// to be the plugin, and MCP JSON-RPC on stdio pretending to be Claude. Proves
// the round trip — request in from the plugin, context out to Claude, drafts
// back in — without needing Figma open.
//
//   node e2e.mjs

import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = 8479 // not the real port, so a running bridge is not disturbed

let failures = 0
const check = (label, ok, detail) => {
  if (ok) return
  failures++
  console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
}

const server = spawn('node', [resolve(here, 'server.mjs')], {
  env: { ...process.env, DSDOC_BRIDGE_PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const stderr = []
server.stderr.on('data', (d) => stderr.push(String(d)))

// ── MCP plumbing ─────────────────────────────────────────────────────────────

let nextId = 1
const waiting = new Map()
let buffer = ''

server.stdout.on('data', (chunk) => {
  buffer += String(chunk)
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    try {
      const message = JSON.parse(line)
      const pending = waiting.get(message.id)
      if (pending) {
        waiting.delete(message.id)
        pending(message)
      }
    } catch {
      /* not our line */
    }
  }
})

function rpc(method, params) {
  const id = nextId++
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timeout: ${method}`)), 8000)
    waiting.set(id, (m) => {
      clearTimeout(timer)
      res(m)
    })
  })
}

const callTool = async (name, args) => {
  const reply = await rpc('tools/call', { name, arguments: args ?? {} })
  const first = reply.result?.content?.find((c) => c.type === 'text')
  try {
    return { parsed: JSON.parse(first?.text ?? '{}'), raw: reply.result }
  } catch {
    return { parsed: first?.text, raw: reply.result }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── The run ──────────────────────────────────────────────────────────────────

try {
  await sleep(700)
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1' },
  })
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  console.log('\n  bridge: with no plugin connected')
  {
    const { parsed } = await callTool('figma_docs_status')
    check('reports no plugin', parsed.pluginConnected === false, JSON.stringify(parsed))
    check('reports no pending work', parsed.pendingRequests.length === 0)
    check('tells Claude what to do next', typeof parsed.hint === 'string')
  }

  console.log('\n  bridge: plugin connects and sends a request')
  const socket = new WebSocket(`ws://localhost:${PORT}`)
  const inbox = []
  socket.on('message', (raw) => inbox.push(JSON.parse(String(raw))))
  await new Promise((res, rej) => {
    socket.on('open', res)
    socket.on('error', rej)
  })

  socket.send(JSON.stringify({ t: 'hello', fileName: 'Tradium DS' }))
  await sleep(250)
  check('server greets the plugin', inbox.some((m) => m.t === 'ready'), JSON.stringify(inbox))

  socket.send(
    JSON.stringify({
      t: 'request',
      id: 'req-test',
      mode: 'bulk',
      scope: 'Icons / Navigation',
      context: { fileName: 'Tradium DS', componentNames: ['Button', 'Link'] },
      items: [
        {
          entityId: '1:1',
          entityKind: 'componentSet',
          name: 'nav-home',
          typeLabel: 'Component set',
          existingNotes: [],
          imagePng: Buffer.from('fake-png').toString('base64'),
        },
        {
          entityId: '1:2',
          entityKind: 'componentSet',
          name: 'nav-trading',
          typeLabel: 'Component set',
          existingNotes: [],
        },
      ],
    })
  )
  await sleep(250)
  check('server acknowledges the request', inbox.some((m) => m.t === 'ack'))

  console.log('\n  bridge: Claude reads it')
  {
    const { parsed } = await callTool('figma_docs_status')
    check('plugin now shows as connected', parsed.pluginConnected === true)
    check('file name carried over', parsed.fileName === 'Tradium DS')
    check('request is listed', parsed.pendingRequests[0]?.requestId === 'req-test')
    check('item count is right', parsed.pendingRequests[0]?.items === 2)
  }

  {
    const { parsed } = await callTool('figma_docs_get_items', { requestId: 'req-test' })
    check('returns both items', parsed.returned === 2, JSON.stringify(parsed).slice(0, 160))
    check('reports no more pages', parsed.hasMore === false)
    check('passes project context through', parsed.projectContext?.fileName === 'Tradium DS')
    // Images are heavy, so they are opt-in — but their presence is flagged.
    check('omits image bytes by default', parsed.items[0].imagePng === undefined)
    check('flags that an image exists', parsed.items[0].hasImage === true)
    check('does not invent an image', parsed.items[1].hasImage === false)
  }

  {
    const { raw } = await callTool('figma_docs_get_items', {
      requestId: 'req-test',
      withImages: true,
    })
    const images = raw.content.filter((c) => c.type === 'image')
    check('sends the image when asked', images.length === 1, `got ${images.length}`)
    check('image carries a mime type', images[0]?.mimeType === 'image/png')
  }

  {
    const { parsed } = await callTool('figma_docs_get_items', {
      requestId: 'req-test',
      offset: 1,
      limit: 1,
    })
    check('paginates', parsed.returned === 1 && parsed.items[0].name === 'nav-trading')
  }

  {
    const { parsed } = await callTool('figma_docs_get_items', { requestId: 'nope' })
    check('an unknown request is refused clearly', String(parsed).indexOf('No request') === 0, String(parsed))
  }

  console.log('\n  bridge: Claude submits drafts')
  {
    // An entityId that was never sent must not be accepted — a typo would
    // otherwise document something the designer never asked about.
    const { parsed } = await callTool('figma_docs_submit_drafts', {
      requestId: 'req-test',
      drafts: [{ entityId: '9:9', entityKind: 'componentSet', section: 'purpose', text: 'x' }],
    })
    check('rejects unknown entity ids', parsed.applied === 0, JSON.stringify(parsed))
  }

  {
    const { parsed } = await callTool('figma_docs_submit_drafts', {
      requestId: 'req-test',
      drafts: [
        { entityId: '1:1', entityKind: 'componentSet', section: 'purpose', text: 'Home nav icon.' },
        { entityId: '1:2', entityKind: 'componentSet', section: 'usage', text: 'Trading tab.' },
        { entityId: '9:9', entityKind: 'componentSet', section: 'purpose', text: 'not asked for' },
      ],
      done: true,
    })
    check('applies the known drafts', parsed.applied === 2, JSON.stringify(parsed))
    check('skips the unknown one', parsed.skippedUnknownIds === 1)
  }

  await sleep(250)
  const delivered = inbox.find((m) => m.t === 'drafts')
  check('drafts reach the plugin', Boolean(delivered), JSON.stringify(inbox.map((m) => m.t)))
  check('only known drafts are delivered', delivered?.drafts.length === 2)
  check('the batch is marked final', delivered?.done === true)

  {
    const { parsed } = await callTool('figma_docs_status')
    check('a finished request is cleared', parsed.pendingRequests.length === 0)
  }

  console.log('\n  bridge: cancelling')
  {
    socket.send(JSON.stringify({ t: 'request', id: 'req-cancel', mode: 'single', scope: 's', items: [{ entityId: '1:1', entityKind: 'component', name: 'x', typeLabel: 'C', existingNotes: [] }] }))
    await sleep(150)
    socket.send(JSON.stringify({ t: 'cancel', id: 'req-cancel' }))
    await sleep(200)
    const { parsed } = await callTool('figma_docs_submit_drafts', {
      requestId: 'req-cancel',
      drafts: [{ entityId: '1:1', entityKind: 'component', section: 'purpose', text: 'late' }],
    })
    check('a cancelled request refuses late drafts', String(parsed).indexOf('cancelled') !== -1, String(parsed))
  }

  console.log('\n  bridge: drafts survive the plugin being closed')
  {
    // Drafting a large request takes a while. A designer who sends one and then
    // closes the plugin must not silently lose the results.
    socket.send(
      JSON.stringify({
        t: 'request',
        id: 'req-offline',
        mode: 'bulk',
        scope: 'later',
        items: [{ entityId: '2:1', entityKind: 'component', name: 'x', typeLabel: 'C', existingNotes: [] }],
      })
    )
    await sleep(200)
    socket.close()
    await sleep(300)

    const { parsed } = await callTool('figma_docs_submit_drafts', {
      requestId: 'req-offline',
      drafts: [{ entityId: '2:1', entityKind: 'component', section: 'purpose', text: 'Held.' }],
      done: true,
    })
    check('drafting still succeeds with no plugin', parsed.applied === 1, JSON.stringify(parsed))
    check('and says they are held', String(parsed.status).indexOf('held') !== -1, String(parsed.status))

    // Reconnecting should hand them over.
    const second = new WebSocket(`ws://localhost:${PORT}`)
    const later = []
    second.on('message', (raw) => later.push(JSON.parse(String(raw))))
    await new Promise((res, rej) => {
      second.on('open', res)
      second.on('error', rej)
    })
    second.send(JSON.stringify({ t: 'hello', fileName: 'Tradium DS' }))
    await sleep(400)

    const held = later.find((m) => m.t === 'drafts')
    check('held drafts arrive on reconnect', Boolean(held), JSON.stringify(later.map((m) => m.t)))
    check('with their content intact', held?.drafts[0]?.text === 'Held.')
    second.close()
    await sleep(200)
  }

  {
    const { parsed } = await callTool('figma_docs_status')
    check('notices the plugin left', parsed.pluginConnected === false)
  }

  console.log(failures === 0 ? '\n  ✓ bridge round trip verified\n' : `\n  ✗ ${failures} failed\n`)
} catch (err) {
  failures++
  console.error('\n  ✗ run failed:', err.message)
  console.error(stderr.join(''))
} finally {
  server.kill()
}

process.exit(failures === 0 ? 0 : 1)
