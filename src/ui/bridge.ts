// WebSocket client for the Claude bridge.
//
// Lives in the UI iframe: the Figma sandbox has no WebSocket, and the iframe
// can reach localhost because browsers treat it as a trustworthy origin and
// exempt it from mixed-content blocking.
//
// The connection is optional throughout. With no bridge running the plugin
// works exactly as before — this only ever adds suggestions.

import type { BridgeItem, BridgeRequestContext, BridgeStatus, DraftNote } from '../shared/types'

const PORT = 8473
// Must match manifest.json exactly. Figma's manifest validator rejects IP
// literals in `allowedDomains` ("must be a valid URL"), so this is the hostname
// on both sides rather than 127.0.0.1.
const URL = `ws://localhost:${PORT}`
const RETRY_MS = 4000

type StatusListener = (status: BridgeStatus, detail?: string) => void
type DraftListener = (payload: { requestId: string; drafts: DraftNote[]; done: boolean }) => void

/** How a drafting run is going, so the plugin never just says "sent" and stops. */
export interface DraftProgress {
  requestId: string
  done: number
  total: number
  drafted: number
  failed: number
  finished: boolean
  error?: string
}

export interface PolishEdit {
  id: string
  text: string
}

type PolishListener = (edits: PolishEdit[]) => void
const polishListeners = new Set<PolishListener>()

export function onPolished(fn: PolishListener): () => void {
  polishListeners.add(fn)
  return () => polishListeners.delete(fn)
}

/** What tidying is doing, so it is never a silent operation. */
export type PolishState =
  | { phase: 'idle' }
  | { phase: 'working'; count: number }
  | { phase: 'done'; changed: number }
  | { phase: 'failed'; error: string }

type PolishStateListener = (state: PolishState) => void
const polishStateListeners = new Set<PolishStateListener>()

export function onPolishState(fn: PolishStateListener): () => void {
  polishStateListeners.add(fn)
  return () => polishStateListeners.delete(fn)
}

function emitPolishState(state: PolishState): void {
  polishStateListeners.forEach((fn) => fn(state))
}

/** Asks the bridge to tidy notes that are already saved. */
export function sendPolish(
  notes: Array<{ id: string; text: string; section: string; subject: string; kind: string }>,
  context: { brief?: string }
): void {
  if (notes.length === 0) return
  if (socket?.readyState !== 1) {
    // No bridge is not a failure — it just means notes stay as written.
    emitPolishState({ phase: 'idle' })
    return
  }
  emitPolishState({ phase: 'working', count: notes.length })
  socket.send(JSON.stringify({ t: 'polish', notes, context }))
}

/** One thing Claude is working on. */
export interface ActivityItem {
  id: string
  kind: 'draft' | 'chat' | 'tidy'
  label: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  done?: number
  total?: number
  drafted?: number
  error?: string
}

export interface PoolState {
  active: number
  queued: number
  max: number
}

type ActivityListener = (items: ActivityItem[], pool: PoolState | null) => void
const activityListeners = new Set<ActivityListener>()

export function onActivity(fn: ActivityListener): () => void {
  activityListeners.add(fn)
  return () => activityListeners.delete(fn)
}

/** A reply from the session, streamed as it forms. */
export interface ChatEvent {
  threadId: string
  text?: string
  done?: boolean
  error?: string
  ops?: Array<Record<string, unknown>>
}

type ChatListener = (event: ChatEvent) => void
const chatListeners = new Set<ChatListener>()

export function onChat(fn: ChatListener): () => void {
  chatListeners.add(fn)
  return () => chatListeners.delete(fn)
}

/** Sends a question. Returns false when no session is reachable. */
export function sendChat(
  threadId: string,
  label: string,
  text: string,
  context: { entityId: string; kind: string; name: string } | null
): boolean {
  if (socket?.readyState !== 1) return false
  socket.send(JSON.stringify({ t: 'chat', threadId, label, text, context }))
  return true
}

/**
 * Where the bridge is installed, as reported by the bridge itself on connect.
 *
 * The plugin has no filesystem access and cannot know where it was unzipped, so
 * this is the only way it can ever name the launcher's location — and because
 * the path comes from the running process, it is right on every machine rather
 * than hardcoded to whoever built the zip.
 */
type HomeListener = (path: string) => void
const homeListeners = new Set<HomeListener>()

export function onBridgeHome(fn: HomeListener): () => void {
  homeListeners.add(fn)
  return () => homeListeners.delete(fn)
}

type ProgressListener = (progress: DraftProgress | null) => void
const progressListeners = new Set<ProgressListener>()

export function onDraftProgress(fn: ProgressListener): () => void {
  progressListeners.add(fn)
  return () => progressListeners.delete(fn)
}

function emitProgress(progress: DraftProgress | null): void {
  progressListeners.forEach((fn) => fn(progress))
}

let socket: WebSocket | null = null
let status: BridgeStatus = 'off'
let wanted = false
let retry: ReturnType<typeof setTimeout> | null = null

const statusListeners = new Set<StatusListener>()
const draftListeners = new Set<DraftListener>()

function setStatus(next: BridgeStatus, detail?: string): void {
  status = next
  statusListeners.forEach((fn) => fn(next, detail))
}

function open(fileName: string): void {
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return

  setStatus('connecting')
  let ws: WebSocket
  try {
    ws = new WebSocket(URL)
  } catch {
    setStatus('off', 'Could not open a connection.')
    return
  }
  socket = ws

  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'hello', fileName }))
    setStatus('connected')
  }

  ws.onmessage = (event) => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    const requestId = String(message.requestId ?? '')
    const threadId = String(message.threadId ?? '')

    switch (message.t) {
      case 'ready':
        if (typeof message.home === 'string' && message.home) {
          homeListeners.forEach((fn) => fn(message.home as string))
        }
        break

      case 'drafts':
        draftListeners.forEach((fn) =>
          fn({
            requestId,
            drafts: (message.drafts ?? []) as DraftNote[],
            done: message.done === true,
          })
        )
        break

      case 'drafting':
        emitProgress({
          requestId,
          done: Number(message.done ?? 0),
          total: Number(message.total ?? 0),
          drafted: Number(message.drafted ?? 0),
          failed: Number(message.failed ?? 0),
          finished: false,
        })
        break

      case 'draftDone':
        emitProgress({
          requestId,
          done: Number(message.drafted ?? 0),
          total: Number(message.drafted ?? 0),
          drafted: Number(message.drafted ?? 0),
          failed: Number(message.failed ?? 0),
          finished: true,
        })
        break

      case 'activity':
        activityListeners.forEach((fn) =>
          fn(
            (message.items ?? []) as ActivityItem[],
            (message.pool ?? null) as PoolState | null
          )
        )
        break

      case 'chatDelta':
        chatListeners.forEach((fn) => fn({ threadId, text: String(message.text ?? '') }))
        break

      case 'chatDone':
        chatListeners.forEach((fn) =>
          fn({
            threadId,
            text: String(message.text ?? ''),
            done: true,
            ops: (message.ops ?? []) as Array<Record<string, unknown>>,
          })
        )
        break

      case 'chatFailed':
        chatListeners.forEach((fn) =>
          fn({ threadId, done: true, error: String(message.error ?? 'Claude could not answer') })
        )
        break

      case 'polishing':
        emitPolishState({ phase: 'working', count: Number(message.count ?? 1) })
        break

      case 'polished': {
        const edits = (message.edits ?? []) as PolishEdit[]
        emitPolishState({ phase: 'done', changed: edits.length })
        polishListeners.forEach((fn) => fn(edits))
        break
      }

      case 'polishFailed':
        emitPolishState({ phase: 'failed', error: String(message.error ?? 'Could not tidy') })
        break

      case 'draftFailed':
        emitProgress({
          requestId,
          done: 0,
          total: 0,
          drafted: 0,
          failed: 1,
          finished: true,
          error: String(message.error ?? 'Drafting failed'),
        })
        break

      default:
        break
    }
  }

  ws.onclose = () => {
    if (socket === ws) socket = null
    if (!wanted) {
      setStatus('off')
      return
    }
    // Claude restarts the bridge whenever its session restarts, so a closed
    // socket is routine rather than an error — keep trying quietly.
    setStatus('connecting')
    retry = setTimeout(() => open(fileName), RETRY_MS)
  }

  ws.onerror = () => {
    // `onclose` always follows, and handles the retry.
  }
}

export function connect(fileName: string): void {
  wanted = true
  open(fileName)
}

export function disconnect(): void {
  wanted = false
  if (retry) clearTimeout(retry)
  retry = null
  socket?.close()
  socket = null
  setStatus('off')
}

export function isConnected(): boolean {
  return socket?.readyState === 1
}

export function getStatus(): BridgeStatus {
  return status
}

/** Queues a drafting request. Returns the id Claude will refer to it by. */
export function sendRequest(payload: {
  mode: 'single' | 'bulk'
  scope: string
  items: BridgeItem[]
  context: BridgeRequestContext
}): string | null {
  if (!socket || socket.readyState !== 1) return null
  const id = `req-${Date.now().toString(36)}`
  socket.send(JSON.stringify({ t: 'request', id, ...payload }))
  return id
}

export function cancelRequest(id: string): void {
  if (socket?.readyState === 1) socket.send(JSON.stringify({ t: 'cancel', id }))
}

export function onStatus(fn: StatusListener): () => void {
  statusListeners.add(fn)
  fn(status)
  return () => statusListeners.delete(fn)
}

export function onDrafts(fn: DraftListener): () => void {
  draftListeners.add(fn)
  return () => draftListeners.delete(fn)
}
