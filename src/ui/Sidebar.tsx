// The left pane: navigate the design system here, document it on the right.
//
// Navigation is a stack, so back is a pop and the breadcrumb is the labels
// joined. Selecting a leaf does not navigate — it just changes what the right
// pane shows, which is the point of the split.

import { useState } from 'react'
import type { BridgeStatus, EntityKind, HomeState, ListItem } from '../shared/types'
import { Browser, type BrowserSource } from './screens/Browser'
import { StartBridge } from './StartBridge'
import {
  ArrowLeft,
  Book,
  Chevron,
  Circle,
  Download,
  HalfCircle,
  Activity,
  Page,
  Rules,
  TypeIcon,
  Variable,
} from './icons'

export type L1 =
  | 'about'
  | 'activity'
  | 'variables'
  | 'paintStyle'
  | 'textStyle'
  | 'effectStyle'
  | 'components'
  | 'project'

interface Props {
  home: HomeState | null
  crumbs: string[]
  title: string
  atRoot: boolean
  source: BrowserSource | null
  selectedId: string | null
  onBack: () => void
  /** Jump straight to a level rather than pressing back repeatedly. */
  onCrumb: (index: number) => void
  onOpenL1: (target: L1) => void
  onOpenFolder: (path: string, name: string) => void
  onOpenList: (item: ListItem) => void
  onSelectEntity: (entityId: string, entityKind: EntityKind, name: string) => void
  onExport: () => void
  exporting: boolean
  refreshToken: number
  bridge: BridgeStatus
  /** Bridge folder learned from a previous connection; null until there's been one. */
  bridgeHome: string | null
  asking: boolean
  busyCount: number
  pendingCount: number
  levelTargets: Array<{ entityId: string; entityKind: EntityKind }>
  onTargets: (targets: Array<{ entityId: string; entityKind: EntityKind }>) => void
  onDraftLevel: () => void
}

export function Sidebar(props: Props) {
  const { home, crumbs, title, atRoot, source, selectedId } = props
  const [showStarter, setShowStarter] = useState(false)

  return (
    <aside className="pane-nav">
      <div className="header">
        {!atRoot && (
          <button className="back" onClick={props.onBack} title="Back">
            <ArrowLeft />
          </button>
        )}
        <div className="crumbs">
          {crumbs.length > 0 && (
            <span className="crumb-trail">
              {crumbs.map((crumb, i) => (
                <span key={i}>
                  {i > 0 && <span className="crumb-sep">/</span>}
                  <button className="crumb" onClick={() => props.onCrumb(i)} title={`Back to ${crumb}`}>
                    {crumb}
                  </button>
                </span>
              ))}
            </span>
          )}
          <strong>{title}</strong>
        </div>
      </div>

      <div className="pane-body">
        {source ? (
          <Browser
            source={source}
            selectedId={selectedId}
            onTargets={props.onTargets}
            refreshToken={props.refreshToken}
            onOpenFolder={props.onOpenFolder}
            onOpenList={props.onOpenList}
            onOpenEntity={props.onSelectEntity}
          />
        ) : (
          <RootMenu
            home={home}
            selectedId={selectedId}
            busyCount={props.busyCount}
            pendingCount={props.pendingCount}
            onOpen={props.onOpenL1}
          />
        )}
      </div>

      <div className="footer">
        {props.levelTargets.length > 0 && (
          <button
            className="btn"
            disabled={props.bridge !== 'connected' || props.asking}
            onClick={props.onDraftLevel}
            title={
              props.bridge === 'connected'
                ? `Send all ${props.levelTargets.length} to Claude for drafting`
                : 'Start the bridge from Claude to enable this'
            }
          >
            {props.asking ? 'Sending…' : `Draft ${props.levelTargets.length} with Claude`}
          </button>
        )}
        <button className="btn primary" onClick={props.onExport} disabled={props.exporting}>
          <Download /> {props.exporting ? 'Building…' : 'Export'}
        </button>
      </div>

      {showStarter && (
        <StartBridge home={props.bridgeHome} onClose={() => setShowStarter(false)} />
      )}

      <div className={`bridge-bar ${props.bridge}`} title={BRIDGE_HINT[props.bridge]}>
        <span className="bridge-dot" />
        <span className="bridge-label">
          {props.bridge === 'connected'
            ? 'Claude bridge connected'
            : props.bridge === 'connecting'
              ? 'Looking for the Claude bridge…'
              : 'Claude bridge off'}
        </span>
        {/* Offered while it is still looking, not only once it has given up —
            "connecting" is what you see for the whole time it is not running. */}
        {props.bridge !== 'connected' && (
          <button
            className="bridge-start"
            onClick={() => setShowStarter((open) => !open)}
            title="How to start the bridge on your machine"
          >
            Start it
          </button>
        )}
      </div>
    </aside>
  )
}

const BRIDGE_HINT: Record<BridgeStatus, string> = {
  connected: 'Claude can read this file and suggest notes.',
  connecting: 'Run the bridge from Claude — it reconnects on its own.',
  off: 'Optional. Everything works without it.',
}

function RootMenu({
  home,
  selectedId,
  busyCount,
  pendingCount,
  onOpen,
}: {
  home: HomeState | null
  selectedId: string | null
  busyCount: number
  pendingCount: number
  onOpen: (target: L1) => void
}) {
  const c = home?.counts
  const plural = (n: number | undefined, word: string) =>
    n === undefined ? '…' : `${n} ${word}${n === 1 ? '' : 's'}`

  return (
    <>
      <Row
        icon={<Book />}
        name="About this project"
        detail={
          home?.brief?.trim()
            ? 'Written — feeds every AI draft'
            : 'Start here — feeds every AI draft'
        }
        documented={Boolean(home?.brief?.trim())}
        active={selectedId === 'about'}
        onClick={() => onOpen('about')}
      />
      <Row
        icon={<Rules />}
        name="Project guidelines"
        detail={
          home && home.projectNoteCount > 0
            ? `${home.projectNoteCount} note${home.projectNoteCount === 1 ? '' : 's'}`
            : 'Overall rules'
        }
        documented={Boolean(home && home.projectNoteCount > 0)}
        active={selectedId === 'project'}
        onClick={() => onOpen('project')}
      />
      <Row
        icon={<Activity />}
        name={busyCount > 0 ? `Activity · ${busyCount} running` : 'Activity'}
        detail={
          pendingCount > 0
            ? `${pendingCount} suggestion${pendingCount === 1 ? '' : 's'} waiting for you`
            : busyCount > 0
              ? 'Claude is working'
              : 'Drafts and questions in flight'
        }
        documented={pendingCount > 0}
        active={selectedId === 'activity'}
        onClick={() => onOpen('activity')}
      />
      <Row
        icon={<Variable />}
        name="Variables"
        detail={
          c ? `${plural(c.collections, 'collection')} · ${c.variables} variables` : 'Loading…'
        }
        onClick={() => onOpen('variables')}
      />
      <Row
        icon={<Circle />}
        name="Color styles"
        detail={plural(c?.paintStyles, 'style')}
        onClick={() => onOpen('paintStyle')}
      />
      <Row
        icon={<HalfCircle />}
        name="Effect styles"
        detail={plural(c?.effectStyles, 'style')}
        onClick={() => onOpen('effectStyle')}
      />
      <Row
        icon={<TypeIcon />}
        name="Text styles"
        detail={plural(c?.textStyles, 'style')}
        onClick={() => onOpen('textStyle')}
      />
      <Row
        icon={<Page />}
        name="Components"
        detail="By page and section"
        onClick={() => onOpen('components')}
      />
    </>
  )
}

function Row({
  icon,
  name,
  detail,
  documented,
  active,
  onClick,
}: {
  icon: React.ReactNode
  name: string
  detail: string
  documented?: boolean
  active?: boolean
  onClick: () => void
}) {
  return (
    <button className={`row${active ? ' active' : ''}`} onClick={onClick}>
      <span className="row-icon">{icon}</span>
      <span className="row-main">
        <span className="row-name">{name}</span>
        <span className="row-detail">{detail}</span>
      </span>
      {documented !== undefined && <span className={`dot${documented ? ' on' : ''}`} />}
      <span className="row-chevron">
        <Chevron />
      </span>
    </button>
  )
}
