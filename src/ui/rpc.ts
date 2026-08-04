// Promise-based RPC over Figma's postMessage bridge.
//
// Each call carries an id so replies can be matched to their caller — without
// it, two in-flight requests of the same type would resolve each other.

import type {
  BatchTarget,
  ProgressEvent,
  Request,
  ResponseMap,
  RpcResponse,
  SelectionEvent,
} from '../shared/types'

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

const pending = new Map<number, Pending>()
let nextId = 1

const selectionListeners = new Set<(targets: BatchTarget[]) => void>()
const progressListeners = new Set<(message: string) => void>()

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data?.pluginMessage as
    | RpcResponse
    | SelectionEvent
    | ProgressEvent
    | undefined
  if (!message) return

  if (message.__rpc === 'selection') {
    selectionListeners.forEach((fn) => fn(message.targets))
    return
  }

  if (message.__rpc === 'progress') {
    progressListeners.forEach((fn) => fn(message.message))
    return
  }

  if (message.__rpc === 'res') {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(message.error))
  }
})

/** Sends a request to the sandbox and resolves with its typed response. */
export function call<T extends Request['type']>(
  payload: Extract<Request, { type: T }>
): Promise<ResponseMap[T]> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    parent.postMessage({ pluginMessage: { __rpc: 'req', id, payload } }, '*')
  })
}

export function onSelectionChange(fn: (targets: BatchTarget[]) => void): () => void {
  selectionListeners.add(fn)
  return () => selectionListeners.delete(fn)
}

export function onProgress(fn: (message: string) => void): () => void {
  progressListeners.add(fn)
  return () => progressListeners.delete(fn)
}
