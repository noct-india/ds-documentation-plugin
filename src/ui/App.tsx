// Two-pane shell: navigate on the left, document on the right.
//
// The panes own separate state — a navigation stack for the left, a selection
// for the right — so drilling into a folder does not disturb the notes you are
// writing, and picking a token does not lose your place in the tree.

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BatchTarget,
  BridgeStatus,
  EntityKind,
  HomeState,
  ListItem,
  PendingDraft,
} from '../shared/types'
import { call, onProgress, onSelectionChange } from './rpc'
import {
  connect as connectBridge,
  isConnected as isBridgeConnected,
  onDraftProgress,
  onDrafts,
  cancelRequest,
  onActivity,
  onChat,
  onPolishState,
  onPolished,
  sendChat,
  onBridgeHome,
  onStatus as onBridgeStatus,
  sendPolish,
  sendRequest,
  type ActivityItem,
  type DraftProgress,
  type PoolState,
  type PolishState,
} from './bridge'
import { downloadZip } from './download'
import { Sidebar, type L1 } from './Sidebar'
import { type BrowserSource } from './screens/Browser'
import { Overview } from './screens/Overview'
import { Activity } from './screens/Activity'
import { Detail } from './screens/Detail'
import { Batch } from './screens/Batch'

/** Where the left pane is. `null` source means the top-level menu. */
interface NavRoute {
  label: string
  source: BrowserSource | null
}

/** What the right pane is showing. */
type Selection =
  | {
      kind: 'entity'
      entityId: string
      entityKind: EntityKind
      name: string
      /** Set when a variant was picked on canvas — opens the viewer on it. */
      variantId?: string
    }
  | { kind: 'batch'; targets: BatchTarget[] }
  /** The project brief, reachable from the nav rather than only on first open. */
  | { kind: 'about' }
  /** Everything Claude is working on. */
  | { kind: 'activity' }
  | null

const ROOT: NavRoute = { label: 'Design system', source: null }

/**
 * Shown beside the name of whatever is open.
 *
 * A note is written to exactly one thing, and "Neutral 100" alone does not say
 * whether that thing is a variable or a component — which is how icon notes end
 * up on a colour token.
 */
const KIND_LABELS: Record<EntityKind, string> = {
  folder: 'Folder',
  page: 'Page',
  section: 'Section',
  variable: 'Variable',
  collection: 'Variable collection',
  paintStyle: 'Color style',
  textStyle: 'Text style',
  effectStyle: 'Effect style',
  component: 'Component',
  componentSet: 'Component set',
  variant: 'Variant',
  project: 'Project',
}

export function App() {
  const [stack, setStack] = useState<NavRoute[]>([ROOT])
  const [selection, setSelection] = useState<Selection>(null)
  const [home, setHome] = useState<HomeState | null>(null)
  const [homeError, setHomeError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [jumpTo, setJumpTo] = useState<BatchTarget[]>([])
  const [bridge, setBridge] = useState<BridgeStatus>('off')
  const [bridgeHome, setBridgeHome] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [progress, setProgress] = useState<DraftProgress | null>(null)
  const [polish, setPolish] = useState<PolishState>({ phase: 'idle' })
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [pool, setPool] = useState<PoolState | null>(null)
  const [pending, setPending] = useState<PendingDraft[]>([])
  const [answer, setAnswer] = useState<{
    threadId: string
    text: string
    pending: boolean
    error?: string
  } | null>(null)
  const [levelTargets, setLevelTargets] = useState<
    Array<{ entityId: string; entityKind: EntityKind }>
  >([])

  const route = stack[stack.length - 1]
  const push = useCallback((next: NavRoute) => setStack((s) => [...s, next]), [])
  const pop = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), [])

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error })
    setTimeout(() => setToast(null), error ? 6000 : 2500)
  }, [])

  const selectEntity = useCallback(
    (entityId: string, entityKind: EntityKind, name: string, variantId?: string) =>
      setSelection({ kind: 'entity', entityId, entityKind, name, variantId }),
    []
  )

  useEffect(() => {
    call({ type: 'getHome' })
      .then(setHome)
      .catch((err: Error) => setHomeError(err.message))
    call({ type: 'getPendingDrafts' })
      .then(setPending)
      .catch(() => setPending([]))
  }, [refreshToken])

  // Landing on the canvas selection is the point of the plugin living in Figma.
  useEffect(() => {
    call({ type: 'getSelectionBatch' })
      .then((targets) => {
        if (targets.length === 1) {
          selectEntity(
            targets[0].entityId,
            targets[0].entityKind,
            targets[0].name,
            targets[0].variantId
          )
        } else if (targets.length > 1) {
          setSelection({ kind: 'batch', targets })
        }
      })
      .catch(() => {
        /* no selection is the normal case */
      })
  }, [selectEntity])

  // Later selection changes offer a jump rather than yanking the pane away
  // mid-sentence. Read through a ref so the listener registers once.
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  useEffect(
    () =>
      onSelectionChange((targets) => {
        const current = selectionRef.current
        const alreadyOpen =
          (current?.kind === 'entity' &&
            targets.length === 1 &&
            current.entityId === targets[0].entityId) ||
          (current?.kind === 'batch' &&
            current.targets.length === targets.length &&
            current.targets.every((t, i) => t.entityId === targets[i]?.entityId))
        setJumpTo(alreadyOpen ? [] : targets)
      }),
    []
  )

  useEffect(() => onProgress((message) => setToast({ text: message })), [])

  // ── Claude bridge ─────────────────────────────────────────────────────────
  // Entirely optional: with no bridge running the plugin behaves exactly as it
  // did before, so nothing here may be allowed to block normal use.

  useEffect(() => onBridgeStatus(setBridge), [])

  // Where the bridge lives. Seeded from clientStorage so it survives the bridge
  // being off — which is the only time anyone needs to be told where it is —
  // and refreshed from the bridge itself whenever it connects, so moving the
  // folder corrects it rather than leaving a stale path behind.
  useEffect(() => {
    call({ type: 'getBridgeHome' })
      .then(setBridgeHome)
      .catch(() => {
        /* knowing the path is a convenience, never a requirement */
      })
  }, [])

  useEffect(
    () =>
      onBridgeHome((path) => {
        setBridgeHome((current) => {
          if (current !== path) void call({ type: 'rememberBridgeHome', path }).catch(() => {})
          return path
        })
      }),
    []
  )

  // The plugin used to say "sent" and then nothing. Drafting runs for minutes on
  // a big page, so its progress is surfaced until it finishes.
  useEffect(
    () =>
      onDraftProgress((next) => {
        setProgress(next)
        if (next?.finished) {
          notify(
            next.error ?? `Drafted ${next.drafted} suggestion${next.drafted === 1 ? '' : 's'}.`,
            Boolean(next.error)
          )
          setTimeout(() => setProgress(null), 6000)
        }
      }),
    [notify]
  )

  useEffect(() => {
    if (home?.fileName) connectBridge(home.fileName)
  }, [home?.fileName])

  useEffect(
    () =>
      onActivity((items, next) => {
        setActivity(items)
        setPool(next)
      }),
    []
  )

  // Replies stream in, so the panel fills as Claude writes rather than
  // appearing all at once after a wait.
  useEffect(
    () =>
      onChat((event) => {
        setAnswer((current) => {
          if (current && current.threadId !== event.threadId) return current
          const base = current ?? { threadId: event.threadId, text: '', pending: true }
          return {
            ...base,
            text: event.error ? base.text : base.text + (event.text ?? ''),
            pending: !event.done,
            error: event.error,
          }
        })

        // Anything it decided to write lands as a draft to review, not as a
        // fact — the same bar every other suggestion has to clear.
        if (event.done && event.ops?.length) {
          const drafts = event.ops
            .filter((op) => op.op === 'add' && op.entityId && op.section && op.text)
            .map((op) => ({
              entityId: String(op.entityId),
              entityKind: (op.entityKind as EntityKind) ?? 'componentSet',
              section: op.section as never,
              text: String(op.text),
            }))
          if (drafts.length > 0) {
            call({ type: 'applyDrafts', drafts })
              .then(() => setRefreshToken((n) => n + 1))
              .catch(() => {
                /* the reply is still shown; a failed write is not silent data loss */
              })
          }
        }
      }),
    []
  )

  // Tidying is quiet but not silent: a failure has to be visible, or the
  // designer cannot tell "left alone" from "quietly broken".
  useEffect(
    () =>
      onPolishState((state) => {
        setPolish(state)
        if (state.phase === 'done' || state.phase === 'failed') {
          const linger = state.phase === 'failed' ? 8000 : 4000
          setTimeout(() => setPolish({ phase: 'idle' }), linger)
        }
      }),
    []
  )

  // A tidy rewrites the note in place and keeps the original as a revision, so
  // it is always recoverable from the notes list.
  useEffect(
    () =>
      onPolished(async (edits) => {
        const current = selectionRef.current
        if (current?.kind !== 'entity') return
        try {
          for (const edit of edits) {
            await call({
              type: 'editNote',
              entityId: current.entityId,
              entityKind: current.entityKind,
              noteId: edit.id,
              text: edit.text,
            })
          }
          setRefreshToken((n) => n + 1)
          notify(`Tidied ${edits.length} note${edits.length === 1 ? '' : 's'} — original kept.`)
        } catch {
          /* the designer's own wording is already saved; a failed tidy is fine */
        }
      }),
    [notify]
  )

  useEffect(
    () =>
      onDrafts(async ({ drafts, done }) => {
        try {
          const result = await call({ type: 'applyDrafts', drafts })
          setRefreshToken((n) => n + 1)
          notify(
            done
              ? `${result.applied} suggestion${result.applied === 1 ? '' : 's'} ready to review.`
              : `${result.applied} more suggestion${result.applied === 1 ? '' : 's'}…`
          )
        } catch (err) {
          notify((err as Error).message, true)
        }
      }),
    [notify]
  )

  /**
   * Sends a set of entities to Claude for drafting.
   *
   * Images are only attached for small requests — a hundred PNGs would cost a
   * great deal of context and tell Claude less than the structure already does.
   */
  const askClaude = async (
    targets: Array<{ entityId: string; entityKind: EntityKind }>,
    scope: string
  ) => {
    if (!isBridgeConnected()) {
      notify('No bridge running. Start it from Claude, then try again.', true)
      return
    }
    if (targets.length === 0) {
      notify('Nothing here to document.', true)
      return
    }

    setAsking(true)
    try {
      const { items, context } = await call({
        type: 'buildBridgeRequest',
        targets,
        includeImages: targets.length <= 25,
      })
      const id = sendRequest({
        mode: targets.length === 1 ? 'single' : 'bulk',
        scope,
        items,
        context,
      })
      notify(
        id
          ? `Drafting ${items.length} item${items.length === 1 ? '' : 's'}…`
          : 'The bridge dropped while sending. Try again.',
        !id
      )
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setAsking(false)
    }
  }

  const runExport = async () => {
    setExporting(true)
    try {
      const { fileName, files } = await call({ type: 'buildExport' })
      const name = await downloadZip(fileName, files)
      notify(`Exported ${files.length} files — ${name}`)
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setExporting(false)
    }
  }

  const openL1 = (target: L1) => {
    if (target === 'about') {
      setSelection({ kind: 'about' })
      return
    }
    if (target === 'activity') {
      setSelection({ kind: 'activity' })
      return
    }
    if (target === 'project') {
      selectEntity('project', 'project', 'Project guidelines')
      return
    }
    if (target === 'variables') {
      push({ label: 'Variables', source: { type: 'collections' } })
      return
    }
    if (target === 'components') {
      push({ label: 'Components', source: { type: 'pages' } })
      return
    }
    const label =
      target === 'paintStyle'
        ? 'Color styles'
        : target === 'textStyle'
          ? 'Text styles'
          : 'Effect styles'
    push({ label, source: { type: 'styleTree', styleKind: target, path: '' } })
  }

  /** A list row either drills deeper or, for components, selects. */
  const openListItem = (item: ListItem) => {
    const source = route.source
    if (!source) return

    switch (source.type) {
      case 'collections':
        push({
          label: item.name,
          source: { type: 'collectionTree', collectionId: item.id, path: '' },
        })
        break
      case 'pages':
        push({ label: item.name, source: { type: 'sections', pageId: item.id } })
        break
      case 'sections':
        push({
          label: item.name,
          source: { type: 'components', pageId: source.pageId, sectionId: item.id },
        })
        break
      case 'components':
        selectEntity(item.id, item.entityKind ?? 'componentSet', item.name)
        break
      default:
        break
    }
  }

  const selectedId =
    selection?.kind === 'entity'
      ? selection.entityId
      : selection?.kind === 'about'
        ? 'about'
        : selection?.kind === 'activity'
          ? 'activity'
          : null

  return (
    <div className="app">
      <div className="panes">
        <Sidebar
          home={home}
          crumbs={stack.slice(0, -1).map((r) => r.label)}
          title={route.label}
          atRoot={stack.length === 1}
          source={route.source}
          selectedId={selectedId}
          refreshToken={refreshToken}
          exporting={exporting}
          onBack={pop}
          onCrumb={(index) => setStack((s) => s.slice(0, index + 1))}
          onOpenL1={openL1}
          onOpenFolder={(path, name) =>
            push({ label: name, source: { ...route.source, path } as BrowserSource })
          }
          onOpenList={openListItem}
          onSelectEntity={selectEntity}
          onExport={runExport}
          bridge={bridge}
          bridgeHome={bridgeHome}
          asking={asking}
          busyCount={activity.filter((a) => a.status === 'running').length}
          pendingCount={pending.reduce((n, p) => n + p.draftCount, 0)}
          levelTargets={levelTargets}
          onTargets={setLevelTargets}
          onDraftLevel={() => askClaude(levelTargets, route.label)}
        />

        <main className="pane-detail">
          {progress && (
            <div className={`drafting${progress.error ? ' failed' : ''}`}>
              <div className="drafting-line">
                {progress.error
                  ? progress.error
                  : progress.finished
                    ? `Done — ${progress.drafted} suggestion${progress.drafted === 1 ? '' : 's'} to review`
                    : `Drafting ${progress.done} of ${progress.total} — ${progress.drafted} suggestion${progress.drafted === 1 ? '' : 's'} so far`}
              </div>
              {!progress.finished && !progress.error && progress.total > 0 && (
                <div className="meter">
                  <div
                    className="meter-fill"
                    style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}
          {jumpTo.length > 0 && (
            <button
              className="jump"
              onClick={() => {
                if (jumpTo.length === 1) {
                  selectEntity(jumpTo[0].entityId, jumpTo[0].entityKind, jumpTo[0].name)
                } else {
                  setSelection({ kind: 'batch', targets: jumpTo })
                }
                setJumpTo([])
              }}
            >
              {jumpTo.length === 1 ? (
                <>
                  Selected on canvas: <strong>{jumpTo[0].name}</strong> — open its notes
                </>
              ) : (
                <>
                  <strong>{jumpTo.length} selected</strong> on canvas — write one note to all
                </>
              )}
            </button>
          )}

          {selection?.kind === 'entity' ? (
            <>
              <div className="detail-head">
                <strong>{selection.name}</strong>
                <span className="detail-kind">{KIND_LABELS[selection.entityKind]}</span>
                {bridge === 'connected' && selection.entityKind !== 'project' && (
                  <button
                    className="btn small"
                    disabled={asking}
                    onClick={() =>
                      askClaude(
                        [
                          {
                            entityId: selection.entityId,
                            entityKind: selection.entityKind,
                          },
                        ],
                        selection.name
                      )
                    }
                  >
                    Ask Claude
                  </button>
                )}
              </div>
              <Detail
                key={selection.entityId}
                entityId={selection.entityId}
                entityKind={selection.entityKind}
                name={selection.name}
                initialVariantId={selection.variantId}
                onSaved={() => setRefreshToken((n) => n + 1)}
                onError={(message) => notify(message, true)}
                onPolish={(notes) => sendPolish(notes, { brief: home?.brief })}
                polish={polish}
                bridgeReady={bridge === 'connected'}
                answer={answer}
                onDismissAnswer={() => setAnswer(null)}
                onAsk={(text) => {
                  const threadId = selection.entityId
                  setAnswer({ threadId, text: '', pending: true })
                  const sent = sendChat(threadId, selection.name, text, {
                    entityId: selection.entityId,
                    kind: selection.entityKind,
                    name: selection.name,
                  })
                  if (!sent) {
                    setAnswer({
                      threadId,
                      text: '',
                      pending: false,
                      error: 'No bridge running — start it to ask questions.',
                    })
                  }
                }}
              />
            </>
          ) : selection?.kind === 'batch' ? (
            <>
              <div className="detail-head">
                <strong>{selection.targets.length} components</strong>
                <button className="link-btn" onClick={() => setSelection(null)}>
                  clear
                </button>
              </div>
              <Batch
                key={selection.targets.map((t) => t.entityId).join(',')}
                targets={selection.targets}
                onOpenOne={(target) =>
                  selectEntity(target.entityId, target.entityKind, target.name)
                }
                onSaved={() => setRefreshToken((n) => n + 1)}
                onError={(message) => notify(message, true)}
                onDone={(message) => notify(message)}
              />
            </>
          ) : selection?.kind === 'activity' ? (
            <Activity
              items={activity}
              pool={pool}
              pending={pending}
              onCancel={cancelRequest}
              onRefreshPending={() =>
                call({ type: 'getPendingDrafts' })
                  .then(setPending)
                  .catch(() => {
                    /* the list simply stays as it was */
                  })
              }
              onOpen={(draft) =>
                selectEntity(draft.entityId, draft.entityKind, draft.name)
              }
            />
          ) : (
            <Overview
              home={home}
              error={homeError}
              onSaveBrief={(text) => {
                call({ type: 'saveBrief', text })
                  .then(setHome)
                  .catch((err: Error) => notify(err.message, true))
              }}
            />
          )}
        </main>
      </div>

      {toast && <div className={`toast${toast.error ? ' error' : ''}`}>{toast.text}</div>}
      <ResizeGrip />
    </div>
  )
}

/**
 * Drag handle for the plugin window.
 *
 * Two panes want more room than a default plugin panel gives, and how much
 * depends on the screen — so let it be dragged rather than guessing.
 */
function ResizeGrip() {
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const move = (e: PointerEvent) => {
      // The grip sits at the window's bottom-right, so the pointer position
      // inside the iframe *is* the size being asked for.
      call({
        type: 'resize',
        width: Math.max(560, Math.round(e.clientX + 6)),
        height: Math.max(400, Math.round(e.clientY + 6)),
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return <div className="grip" onPointerDown={onPointerDown} title="Drag to resize" />
}
