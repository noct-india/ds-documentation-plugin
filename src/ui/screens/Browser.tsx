// The drill-down list screens: collections, folder trees, pages, sections,
// components. All of them render the same row shape; only the data source and
// what a click does differ.

import { useEffect, useState } from 'react'
import type { EntityKind, ListItem, TreeNode } from '../../shared/types'
import { call } from '../rpc'
import {
  Chevron,
  Component,
  Diamond,
  Folder,
  Page,
  Variable,
} from '../icons'
import { Swatch } from '../Swatch'
import { folderAt } from '../../shared/tree'

export type BrowserSource =
  | { type: 'collections' }
  | { type: 'collectionTree'; collectionId: string; path: string }
  | { type: 'styleTree'; styleKind: 'paintStyle' | 'textStyle' | 'effectStyle'; path: string }
  | { type: 'pages' }
  | { type: 'sections'; pageId: string }
  | { type: 'components'; pageId: string; sectionId: string }

interface Props {
  source: BrowserSource
  onOpenFolder: (path: string, name: string) => void
  onOpenList: (item: ListItem) => void
  onOpenEntity: (entityId: string, entityKind: EntityKind, name: string) => void
  /** Highlights the row whose notes the right pane is showing. */
  selectedId?: string | null
  /** Reports the documentable items at this level, for "Draft with Claude". */
  onTargets?: (targets: Array<{ entityId: string; entityKind: EntityKind }>) => void
  refreshToken: number
}

export function Browser({
  source,
  onOpenFolder,
  onOpenList,
  onOpenEntity,
  selectedId,
  onTargets,
  refreshToken,
}: Props) {
  const [items, setItems] = useState<ListItem[] | null>(null)
  const [tree, setTree] = useState<TreeNode[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    // Clear first: without this the previous level's rows stay on screen while
    // the new level loads, and a fast click would route them against the new
    // source — picking a collection would be read as picking a page.
    setItems(null)
    setTree(null)

    const load = async () => {
      switch (source.type) {
        case 'collections':
          return { items: await call({ type: 'getCollections' }) }
        case 'pages':
          return { items: await call({ type: 'getPages' }) }
        case 'sections':
          return { items: await call({ type: 'getPageSections', pageId: source.pageId }) }
        case 'components':
          return {
            items: await call({
              type: 'getSectionComponents',
              pageId: source.pageId,
              sectionId: source.sectionId,
            }),
          }
        case 'collectionTree':
          return {
            tree: await call({
              type: 'getCollectionTree',
              collectionId: source.collectionId,
            }),
          }
        case 'styleTree':
          return { tree: await call({ type: 'getStyleTree', styleKind: source.styleKind }) }
      }
    }

    load()
      .then((result) => {
        if (cancelled) return
        setItems(result.items ?? null)
        setTree(result.tree ?? null)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })

    return () => {
      cancelled = true
    }
    // `path` is handled client-side below — refetching on drill-in would be waste.
  }, [
    source.type,
    'collectionId' in source ? source.collectionId : '',
    'styleKind' in source ? source.styleKind : '',
    'pageId' in source ? source.pageId : '',
    'sectionId' in source ? source.sectionId : '',
    refreshToken,
  ])

  // What "Draft with Claude" covers: exactly the rows on screen, so the count
  // on the button always matches what you can see.
  //
  // At a level showing folders that means the folders themselves, not the
  // hundreds of tokens beneath them — and that is the better order anyway.
  // Documenting a group first gives every element inside it inherited context,
  // because ancestry travels with each drafted item.
  const levelTargets: Array<{ entityId: string; entityKind: EntityKind }> = (() => {
    if (tree) {
      const level = folderAt(tree, 'path' in source ? source.path : '')
      if (!level) return []
      return level
        .map((node) =>
          node.kind === 'leaf'
            ? { entityId: node.entityId, entityKind: node.entityKind }
            : node.entityId
              ? { entityId: node.entityId, entityKind: 'folder' as EntityKind }
              : null
        )
        .filter((t): t is { entityId: string; entityKind: EntityKind } => t !== null)
    }
    if (items && source.type === 'components') {
      return items.map((i) => ({
        entityId: i.id,
        entityKind: i.entityKind ?? ('componentSet' as EntityKind),
      }))
    }
    return []
  })()

  // Keyed on a stable signature rather than the array, which is rebuilt every
  // render and would otherwise loop against state set in the parent.
  const signature = levelTargets.map((t) => t.entityId).join(',')
  useEffect(() => {
    onTargets?.(levelTargets)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  if (error) return <div className="state">{error}</div>
  if (!items && !tree) return <div className="state">Loading…</div>

  if (tree) {
    const path = 'path' in source ? source.path : ''
    const level = folderAt(tree, path)
    if (!level) return <div className="state">That group no longer exists.</div>
    if (level.length === 0) return <div className="state">Nothing here yet.</div>

    return (
      <>
        {level.map((node) =>
          node.kind === 'folder' ? (
            <button
              key={`f:${node.path}`}
              className="row"
              onClick={() => onOpenFolder(node.path, node.name)}
            >
              <span className="row-icon">
                <Folder />
              </span>
              <span className="row-main">
                <span className="row-name">{node.name}</span>
                <span className="row-detail">
                  {node.leafCount} item{node.leafCount === 1 ? '' : 's'} · {node.documentedCount}{' '}
                  documented
                </span>
              </span>
              {node.entityId && (
                <span
                  className={`folder-note${node.noteCount ? ' on' : ''}`}
                  role="button"
                  tabIndex={0}
                  title={
                    node.noteCount
                      ? `${node.noteCount} note${node.noteCount === 1 ? '' : 's'} about this group`
                      : 'Document this group itself'
                  }
                  onClick={(e) => {
                    // The row drills in; this documents the group itself.
                    e.stopPropagation()
                    onOpenEntity(node.entityId!, 'folder', node.name)
                  }}
                >
                  {node.noteCount ? node.noteCount : '+'}
                </span>
              )}
              <span className="row-chevron">
                <Chevron />
              </span>
            </button>
          ) : (
            <button
              key={`l:${node.entityId}`}
              className={`row${selectedId === node.entityId ? ' active' : ''}`}
              onClick={() => onOpenEntity(node.entityId, node.entityKind, node.name)}
            >
              <span className="row-icon">
                {node.preview ? (
                  <Swatch preview={node.preview} />
                ) : node.entityKind === 'variable' ? (
                  <Variable />
                ) : (
                  <Diamond />
                )}
              </span>
              <span className="row-main">
                <span className="row-name">{node.name}</span>
                {(node.detail || node.noteCount > 0) && (
                  <span className="row-detail">
                    {[
                      node.detail,
                      node.noteCount > 0
                        ? `${node.noteCount} note${node.noteCount === 1 ? '' : 's'}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </span>
              <span className={`dot${node.noteCount > 0 ? ' on' : ''}`} />
              <span className="row-chevron">
                <Chevron />
              </span>
            </button>
          )
        )}
      </>
    )
  }

  if (items!.length === 0) {
    return (
      <div className="state">
        {source.type === 'sections'
          ? 'No components on this page.'
          : source.type === 'components'
            ? 'No components in this section.'
            : source.type === 'pages'
              ? 'No page in this file holds components.'
              : 'Nothing here yet.'}
      </div>
    )
  }

  return (
    <>
      {items!.map((item) => (
        <button
          key={item.id}
          className={`row${selectedId === item.id ? ' active' : ''}`}
          onClick={() => onOpenList(item)}
        >
          <span className="row-icon">
            {source.type === 'pages' ? (
              <Page />
            ) : item.entityKind === 'componentSet' || item.entityKind === 'component' ? (
              <Component />
            ) : (
              <Folder />
            )}
          </span>
          <span className="row-main">
            <span className="row-name">{item.name}</span>
            {item.detail && <span className="row-detail">{item.detail}</span>}
          </span>
          {/* Collections, pages and sections are drilled into by the row, and
              documented by this badge — a group deserves its own purpose. */}
          {item.entityKind && source.type !== 'components' && (
            <span
              className={`folder-note${item.noteCount ? ' on' : ''}`}
              role="button"
              tabIndex={0}
              title={
                item.noteCount
                  ? `${item.noteCount} note${item.noteCount === 1 ? '' : 's'} about this`
                  : 'Document this itself'
              }
              onClick={(e) => {
                e.stopPropagation()
                onOpenEntity(item.id, item.entityKind!, item.name)
              }}
            >
              {item.noteCount ? item.noteCount : '+'}
            </span>
          )}
          {item.noteCount !== undefined && source.type === 'components' && (
            <span className={`dot${item.noteCount > 0 ? ' on' : ''}`} />
          )}
          <span className="row-chevron">
            <Chevron />
          </span>
        </button>
      ))}
    </>
  )
}
