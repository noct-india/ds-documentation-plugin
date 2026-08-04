// A long-lived Claude session over the design system's notes.
//
// `claude --input-format stream-json` keeps one process alive and fed over
// stdin, so the ~9s startup is paid once per file rather than once per message.
// Its working directory is a markdown mirror of every note, which means Claude
// can grep and cross-reference the whole corpus instead of seeing one entity at
// a time.
//
// Turns are serialised through a queue: one session, one turn at a time, with
// everything waiting visible to the designer.

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const TURN_TIMEOUT_MS = Number(process.env.DSDOC_TURN_TIMEOUT_MS ?? 180_000)

const SYSTEM = `You maintain the documentation for a Figma design system.

Your working directory is a read-only markdown mirror of every note in the system.
Read it freely — grep it, cross-reference it, compare entities. Do NOT edit those
files; edits there are discarded on the next refresh.

To change documentation, end your reply with a fenced \`\`\`dsdoc block containing a
JSON array of operations:

\`\`\`dsdoc
[{"op":"add","entityId":"<id>","section":"rules","text":"One rule, one sentence."}]
\`\`\`

Operations:
  {"op":"add","entityId","section","text"}       write a new note
  {"op":"edit","entityId","noteId","text"}       reword an existing note
  {"op":"hide","entityId","noteId"}              hide a note (wording is kept)
  {"op":"recategorize","entityId","noteId","section"}

Sections: purpose, character, layout, usage, instead, modes, naming, pairs,
states, content, rules, donts, notes.

How to read what the designer types:
- A statement about the current element is a note. Record it, tidied into one
  clear imperative sentence, without changing its meaning or strength.
- A question or an instruction is a task. Do it, and answer briefly.
- If you are unsure which, ask rather than guess.

Never invent component or token names. Only reference names that appear in the
mirror. Keep replies to a couple of lines — the designer is working in a narrow
panel, not reading an essay.`

/** Pulls the operations block out of a reply. */
export function extractOps(text) {
  if (!text) return []
  const match = text.match(/```dsdoc\s*([\s\S]*?)```/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[1].trim())
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** The reply with the operations block stripped, for showing to the designer. */
export function stripOps(text) {
  return (text ?? '').replace(/```dsdoc[\s\S]*?```/g, '').trim()
}

export class Session {
  /**
   * @param {object} options
   * @param {(event: object) => void} options.emit  pushed to the plugin
   * @param {(msg: string) => void} options.log
   */
  constructor({ emit, log, model = process.env.DSDOC_CHAT_MODEL ?? 'sonnet' }) {
    this.emit = emit
    this.log = log
    this.model = model
    this.child = null
    this.folder = null
    this.queue = []
    this.current = null
    this.buffer = ''
    this.reply = ''
    this.tools = []
  }

  /** Writes the markdown mirror Claude reads. Regenerated whenever notes change. */
  async writeMirror(files) {
    if (!this.folder) this.folder = await mkdtemp(join(tmpdir(), 'dsdoc-'))
    for (const file of files) {
      const path = join(this.folder, file.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.content, 'utf8')
    }
    this.log(`mirror: ${files.length} file(s) in ${this.folder}`)
    return this.folder
  }

  get running() {
    return this.child !== null && !this.child.killed
  }

  async start() {
    if (this.running) return
    if (!this.folder) this.folder = await mkdtemp(join(tmpdir(), 'dsdoc-'))

    this.child = spawn(
      'claude',
      [
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        this.model,
        // Read and search the mirror, but never write to it — documentation
        // changes come back as operations so they keep their identity.
        '--permission-mode',
        'plan',
        '--append-system-prompt',
        SYSTEM,
      ],
      { cwd: this.folder, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } }
    )

    this.child.stdout.on('data', (chunk) => this.onStdout(String(chunk)))
    this.child.stderr.on('data', (d) => this.log(`session stderr: ${String(d).slice(0, 200)}`))
    this.child.on('exit', (code) => {
      this.log(`session exited (${code})`)
      this.child = null
      this.failCurrent('The Claude session ended. It will restart on the next message.')
    })

    this.log(`session started · ${this.model} · ${this.folder}`)
    this.emitQueue()
  }

  onStdout(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.onEvent(message)
    }
  }

  onEvent(message) {
    if (message.type === 'assistant') {
      const content = message.message?.content ?? []
      for (const part of content) {
        if (part.type === 'text' && part.text) {
          this.reply += part.text
          // Streamed so the designer sees it forming rather than a blank wait.
          this.emit({ t: 'chatDelta', threadId: this.current?.threadId, text: part.text })
        }
        if (part.type === 'tool_use') {
          this.tools.push(part.name)
          this.emit({ t: 'chatTool', threadId: this.current?.threadId, tool: part.name })
        }
      }
      return
    }

    if (message.type === 'result') this.finishTurn()
  }

  finishTurn() {
    const turn = this.current
    if (!turn) return
    clearTimeout(turn.timer)
    this.current = null

    const ops = extractOps(this.reply)
    this.emit({
      t: 'chatDone',
      threadId: turn.threadId,
      messageId: turn.id,
      text: stripOps(this.reply),
      ops,
      tools: this.tools,
    })

    this.reply = ''
    this.tools = []
    this.emitQueue()
    this.pump()
  }

  failCurrent(error) {
    const turn = this.current
    if (!turn) {
      this.emitQueue()
      return
    }
    clearTimeout(turn.timer)
    this.current = null
    this.reply = ''
    this.tools = []
    this.emit({ t: 'chatFailed', threadId: turn.threadId, messageId: turn.id, error })
    this.emitQueue()
    this.pump()
  }

  emitQueue() {
    this.emit({
      t: 'queue',
      running: this.current
        ? { threadId: this.current.threadId, label: this.current.label, id: this.current.id }
        : null,
      waiting: this.queue.map((q) => ({ threadId: q.threadId, label: q.label, id: q.id })),
      sessionUp: this.running,
    })
  }

  /** Adds a turn. Returns its id so the plugin can track it. */
  async ask({ threadId, label, text, context }) {
    const id = `m-${Date.now().toString(36)}-${Math.round(performance.now() % 1000)}`
    this.queue.push({ id, threadId, label, text, context })
    this.emitQueue()
    await this.start()
    this.pump()
    return id
  }

  pump() {
    if (this.current || this.queue.length === 0 || !this.running) return
    const turn = this.queue.shift()
    this.current = turn

    // Context goes with every message, because the session is shared across
    // everything the designer opens — without it "this" is ambiguous.
    const preamble = turn.context
      ? `[Currently open: ${turn.context.name} — ${turn.context.kind}, id ${turn.context.entityId}]\n`
      : '[No element open — this is a general question about the system.]\n'

    turn.timer = setTimeout(() => {
      this.failCurrent(`No reply within ${Math.round(TURN_TIMEOUT_MS / 1000)}s.`)
    }, TURN_TIMEOUT_MS)

    this.child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: preamble + turn.text }] },
      })}\n`
    )
    this.emitQueue()
  }

  async stop() {
    this.queue = []
    this.current = null
    if (this.child) {
      try {
        this.child.stdin.end()
        this.child.kill()
      } catch {
        /* already gone */
      }
      this.child = null
    }
    if (this.folder) {
      await rm(this.folder, { recursive: true, force: true }).catch(() => {})
      this.folder = null
    }
  }
}
