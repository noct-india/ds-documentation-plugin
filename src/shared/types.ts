// Contract shared by the sandbox (src/main) and the UI iframe (src/ui).
// Both halves import from here so the postMessage protocol stays honest.

/** Every kind of thing a designer can document. */
export type EntityKind =
  | 'variable'
  | 'collection'
  | 'paintStyle'
  | 'textStyle'
  | 'effectStyle'
  | 'component'
  | 'componentSet'
  | 'folder' // a "/" group inside a collection or style set
  | 'page'
  | 'section'
  | 'project' // figma.root — project-wide guidelines

/**
 * The buckets a note lands in.
 *
 * Chosen against what actually makes a generated UI go off-system: inventing
 * components that don't exist, picking the wrong variant, and skipping loading /
 * empty / error states. The governing rule is that a category only exists for
 * knowledge Figma *cannot* tell us — anatomy, variants, props and nesting are
 * already auto-extracted, so nobody is asked to retype them.
 */
export const SECTION_KEYS = [
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
] as const
export type SectionKey = (typeof SECTION_KEYS)[number]

/** Short form, for the chip row. */
export const SECTION_LABELS: Record<SectionKey, string> = {
  purpose: 'Purpose',
  character: 'Character',
  layout: 'Layout',
  usage: 'When to use',
  instead: 'Instead',
  modes: 'Modes',
  naming: 'Naming',
  pairs: 'Pairs with',
  states: 'States',
  content: 'Content',
  rules: 'Rules',
  donts: "Don't",
  notes: 'Notes',
}

/** Long form, for markdown headings — an agent reads these without context. */
export const SECTION_HEADINGS: Record<SectionKey, string> = {
  purpose: 'Purpose',
  character: 'Product character',
  layout: 'Layout and page scaffolding',
  usage: 'When to use',
  instead: 'Use instead',
  modes: 'Modes',
  naming: 'Naming convention',
  pairs: 'Pairs with',
  states: 'States',
  content: 'Content and wording',
  rules: 'Rules',
  donts: "Don't",
  notes: 'Notes',
}

/**
 * The question put in the input field when a chip is picked.
 *
 * This is the part that does the motivating. A label names a bucket; a question
 * retrieves a memory — "what mistake have you seen someone make with this?"
 * surfaces things "Don't" alone never would.
 */
export const SECTION_PROMPTS: Record<SectionKey, string> = {
  purpose: 'What is this for, in one line?',
  character: 'Density, surface strategy — how sparingly is brand colour used?',
  layout: 'Grid and page scaffolding — what must every page include?',
  usage: 'What situation should make someone reach for this?',
  instead: 'When this is the wrong choice, what should they use?',
  modes: 'What is each mode for, and which one is the source of truth?',
  naming: 'How are these named, and what does each part mean?',
  pairs: 'What does this sit inside, or next to?',
  states: 'What about loading, empty, error, disabled?',
  content: 'How should the text inside it read?',
  rules: 'What must always be true? Be absolute.',
  donts: 'What mistake have you seen someone make with this?',
  notes: 'Anything else worth knowing?',
}

/**
 * Which categories apply to which kind of thing, in render order.
 *
 * Showing "States" on a colour variable is noise, and noise trains people to
 * ignore the whole row — which would defeat the point of the empty chips being
 * a visible checklist.
 */
const SECTION_SETS: Record<EntityKind, SectionKey[]> = {
  variable: ['purpose', 'usage', 'instead', 'rules', 'donts', 'notes'],
  collection: ['purpose', 'modes', 'naming', 'rules', 'donts', 'notes'],
  paintStyle: ['purpose', 'usage', 'instead', 'pairs', 'rules', 'donts', 'notes'],
  textStyle: ['purpose', 'usage', 'instead', 'pairs', 'content', 'rules', 'donts', 'notes'],
  effectStyle: ['purpose', 'usage', 'instead', 'rules', 'donts', 'notes'],
  component: [
    'purpose',
    'usage',
    'instead',
    'pairs',
    'states',
    'content',
    'rules',
    'donts',
    'notes',
  ],
  componentSet: [
    'purpose',
    'usage',
    'instead',
    'pairs',
    'states',
    'content',
    'rules',
    'donts',
    'notes',
  ],
  folder: ['purpose', 'usage', 'naming', 'rules', 'donts', 'notes'],
  page: ['purpose', 'usage', 'rules', 'donts', 'notes'],
  section: ['purpose', 'usage', 'rules', 'donts', 'notes'],
  project: ['character', 'layout', 'rules', 'donts', 'notes'],
}

export function sectionsFor(kind: EntityKind): SectionKey[] {
  return SECTION_SETS[kind] ?? SECTION_SETS.variable
}

/**
 * Maps a stored section key onto a current one.
 *
 * "Do" was merged into "Rules" — keeping both guaranteed inconsistent filing,
 * since every rule is also a "do". Notes written under the old key keep their
 * meaning rather than silently sliding into the Notes catch-all.
 */
const LEGACY_SECTIONS: Record<string, SectionKey> = { dos: 'rules' }

export function migrateSection(section: string): SectionKey {
  if ((SECTION_KEYS as readonly string[]).indexOf(section) !== -1) return section as SectionKey
  return LEGACY_SECTIONS[section] ?? 'notes'
}

/**
 * One thing the designer typed. Append-only: `text` is never rewritten and
 * entries are never spliced out — `deleted` hides an entry from the rendered
 * document while keeping the original words in the log.
 */
export interface NoteEntry {
  id: string
  ts: number
  author: string
  text: string
  section: SectionKey
  deleted?: boolean
  /**
   * Awaiting review.
   *
   * Drafts come from Claude via the bridge. They are held apart from authored
   * notes and kept out of the export until a human approves one — an unreviewed
   * guess must never reach Figma Make, which would follow an invented rule as
   * faithfully as a real one.
   */
  draft?: boolean
  /**
   * Previous wordings, oldest first.
   *
   * Editing a note rewrites `text`, so the wording it replaced is pushed here
   * rather than discarded — the never-lose guarantee covers rewrites, not just
   * deletions.
   */
  revisions?: Array<{ text: string; ts: number; author: string }>
}

/** Small header record, read before the (possibly chunked) payloads. */
export interface EntityMeta {
  v: 1
  kind: EntityKind
  name: string
  chunks: { log: number; doc: number; body?: number }
  /** True once the authored body has been hand-edited and pinned. */
  bodyEdited?: boolean
  updatedAt: number
}

// ─── Navigation ──────────────────────────────────────────────────────────────

export interface TreeFolder {
  kind: 'folder'
  name: string
  path: string
  children: TreeNode[]
  /** Synthetic id so the folder itself can carry notes. */
  entityId?: string
  /** Notes written about the group, as opposed to its members. */
  noteCount?: number
  /** Leaves at or below this folder — drives the "12 items" count in the UI. */
  leafCount: number
  documentedCount: number
}

/**
 * A visual stand-in for the thing being documented, so browsing the plugin
 * reads like browsing Figma's own panels rather than a list of names.
 */
export type Preview =
  /** One CSS colour or gradient per mode — a variable can differ across them. */
  | { kind: 'color'; values: string[] }
  | { kind: 'effect'; shadow?: string; filter?: string }
  | { kind: 'text'; size: number; weight: number }

export interface TreeLeaf {
  kind: 'leaf'
  name: string
  path: string
  entityId: string
  entityKind: EntityKind
  noteCount: number
  /** Swatch, shadow box or type sample shown in place of the generic icon. */
  preview?: Preview
  /** Resolved value, for variables that have no visual form. */
  detail?: string
}

export type TreeNode = TreeFolder | TreeLeaf

/** A row in any list screen — collections, pages, sections, components. */
export interface ListItem {
  id: string
  name: string
  /** e.g. "48 variables · 12 documented" */
  detail?: string
  noteCount?: number
  /** Set on rows that open a detail screen rather than drilling deeper. */
  entityKind?: EntityKind
}

// ─── Entity detail ───────────────────────────────────────────────────────────

export interface VariableModeValue {
  modeName: string
  value: string
}

export interface ComponentProperty {
  /** Full key including any "#0:0" suffix — this is the identity. */
  key: string
  /** Human-facing prefix, e.g. "IconVisible". */
  displayName: string
  type: 'VARIANT' | 'BOOLEAN' | 'TEXT' | 'INSTANCE_SWAP' | 'SLOT'
  defaultValue: string
  options?: string[]
  /** Figma's own per-property description, where the designer wrote one. */
  description?: string
}

/** Auto-pulled facts about an entity. Regenerated from Figma on every open. */
export interface EntityStructure {
  /** e.g. "COLOR", "COMPONENT_SET" — shown under `## Type`. */
  typeLabel: string
  /** Figma's own description field, where one exists. */
  description?: string
  /** Variables: resolved value per mode. */
  modeValues?: VariableModeValue[]
  /** Collections: the modes and how many variables they hold. */
  modes?: string[]
  /** Collections / style groups: the "/" folder tree, pre-rendered. */
  structureTree?: string
  /** Components: variant + property table. */
  properties?: ComponentProperty[]
  variantCount?: number
  nestedComponents?: string[]
  /** Collections: number of variables inside. */
  childCount?: number
  /** Breadcrumb-ish context line, e.g. "Primitive Colors". */
  parentName?: string
  /** Same visual stand-in the list rows use, shown larger on the detail screen. */
  preview?: Preview
}

export interface EntityDetail {
  entityId: string
  entityKind: EntityKind
  name: string
  structure: EntityStructure
  log: NoteEntry[]
  /** The whole document — structure + body — for the read-only preview. */
  markdown: string
  /** Auto-generated half. Regenerated from Figma; not editable. */
  structureMarkdown: string
  /** Authored half. This is what the editor edits. */
  bodyMarkdown: string
  /** True when the body has been hand-edited and is no longer derived. */
  bodyEdited: boolean
  /**
   * What the last write recorded this entity as.
   *
   * Normally identical to `name`/`entityKind`. A disagreement means notes were
   * stored against something other than what they were written for.
   */
  storedAs?: { kind: EntityKind; name: string }
  /** True when the underlying Figma object could not be resolved. */
  missing?: boolean
}

// ─── Home ────────────────────────────────────────────────────────────────────

export interface HomeCounts {
  collections: number
  variables: number
  paintStyles: number
  textStyles: number
  effectStyles: number
  /** Null until the user has visited Components (walking pages is lazy). */
  components: number | null
}

export interface HomeState {
  fileName: string
  counts: HomeCounts
  documentedCount: number
  projectNoteCount: number
  /** Free prose about the product; feeds AI drafting and the export. */
  brief: string
  /** Entities in the index whose Figma object no longer resolves. */
  orphans: Array<{ entityId: string; kind: EntityKind; name: string; noteCount: number }>
}

/** Where the plugin should land on open, when something is selected on canvas. */
export interface SelectionTarget {
  entityId: string
  entityKind: EntityKind
  name: string
}

/** One recipient of a batch note. */
export interface BatchTarget extends SelectionTarget {
  noteCount: number
}

/**
 * A note as it appears across a batch selection.
 *
 * Batch-added notes get their own id on each component, so identity here is the
 * wording plus the category, not an id.
 */
export interface SharedNote {
  text: string
  section: SectionKey
  /** How many of the selected components carry this note. */
  count: number
  /** How many components are selected. */
  total: number
}

/** An entity carrying suggestions that nobody has reviewed yet. */
export interface PendingDraft {
  entityId: string
  entityKind: EntityKind
  name: string
  draftCount: number
}

/** Outcome of writing one note to many components. */
export interface BatchResult {
  /** Components that received the notes. */
  applied: number
  /** Notes written to each. */
  notes: number
  /** Names of components that could no longer be resolved. */
  skipped: string[]
}

// ─── Bridge ──────────────────────────────────────────────────────────────────

/** One element, as sent to Claude for drafting. */
export interface BridgeItem {
  entityId: string
  entityKind: EntityKind
  name: string
  typeLabel: string
  description?: string
  parentName?: string
  modes?: string[]
  values?: VariableModeValue[]
  properties?: ComponentProperty[]
  variantCount?: number
  nests?: string[]
  /** Names of neighbours in the same collection, for contrast and redirects. */
  siblings?: string[]
  /**
   * The chain this sits inside — collection, then each folder above it, with
   * whatever has been documented about each. This is what lets a draft say
   * something specific about a token instead of guessing from its name.
   */
  ancestry?: Array<{
    name: string
    kind: string
    notes: Array<{ section: SectionKey; text: string }>
  }>
  existingNotes: Array<{ section: SectionKey; text: string; draft: boolean }>
  /** base64 PNG. Components only, and only when asked for. */
  imagePng?: string
}

/** Whole-file context, sent once per request. */
export interface BridgeRequestContext {
  fileName: string
  /** Free prose about the product — leads the drafting prompt. */
  brief: string
  projectNotes: Array<{ section: SectionKey; text: string; draft: boolean }>
  collections: Array<{ name: string; modes: string[]; variableCount: number }>
  styleGroups: { color: string[]; text: string[]; effect: string[] }
  componentNames: string[]
}

/** A suggestion coming back from Claude. */
export interface DraftNote {
  entityId: string
  entityKind: EntityKind
  section: SectionKey
  text: string
}

export type BridgeStatus = 'off' | 'connecting' | 'connected'

// ─── Export ──────────────────────────────────────────────────────────────────

export interface ExportFile {
  /** Path inside the zip, e.g. "guidelines/components/button.md". */
  path: string
  content: string
}

// ─── RPC ─────────────────────────────────────────────────────────────────────

export type Request =
  | { type: 'getHome' }
  | { type: 'getSelection' }
  | { type: 'getSelectionBatch' }
  | { type: 'getPendingDrafts' }
  | {
      type: 'addNotesBatch'
      targets: Array<{ entityId: string; entityKind: EntityKind; name: string }>
      entries: Array<{ text: string; section: SectionKey }>
    }
  | { type: 'getCollections' }
  | { type: 'getCollectionTree'; collectionId: string }
  | { type: 'getStyleTree'; styleKind: 'paintStyle' | 'textStyle' | 'effectStyle' }
  | { type: 'getPages' }
  | { type: 'getPageSections'; pageId: string }
  | { type: 'getSectionComponents'; pageId: string; sectionId: string }
  | { type: 'getEntity'; entityId: string; entityKind: EntityKind }
  | {
      /** One typed note may become several entries — see classifySegments. */
      type: 'addNotes'
      entityId: string
      entityKind: EntityKind
      entries: Array<{ text: string; section: SectionKey }>
    }
  | { type: 'editNote'; entityId: string; entityKind: EntityKind; noteId: string; text: string }
  | { type: 'getSharedNotes'; targets: Array<{ entityId: string; entityKind: EntityKind }> }
  | {
      /** Rewrites the same note on every selected component that carries it. */
      type: 'editSharedNote'
      targets: Array<{ entityId: string; entityKind: EntityKind }>
      section: SectionKey
      from: string
      to: string
    }
  | {
      type: 'removeSharedNote'
      targets: Array<{ entityId: string; entityKind: EntityKind }>
      section: SectionKey
      text: string
    }
  | {
      /** Gathers full context for a set of entities, to send over the bridge. */
      type: 'buildBridgeRequest'
      targets: Array<{ entityId: string; entityKind: EntityKind }>
      includeImages: boolean
    }
  | { type: 'saveBrief'; text: string }
  | { type: 'applyDrafts'; drafts: DraftNote[] }
  | {
      type: 'reviewDrafts'
      entityId: string
      entityKind: EntityKind
      /** null approves or rejects every draft on the entity. */
      noteIds: string[] | null
      action: 'approve' | 'reject'
    }
  | { type: 'saveBody'; entityId: string; entityKind: EntityKind; body: string }
  | { type: 'resetBody'; entityId: string; entityKind: EntityKind }
  | { type: 'deleteNote'; entityId: string; entityKind: EntityKind; noteId: string }
  | {
      type: 'recategorizeNote'
      entityId: string
      entityKind: EntityKind
      noteId: string
      section: SectionKey
    }
  | { type: 'revealEntity'; entityId: string; entityKind: EntityKind }
  | { type: 'buildExport' }
  | { type: 'resize'; width: number; height: number }
  // Where the bridge lives on this machine, learned from the bridge itself and
  // kept in clientStorage so the plugin can still point at it once the bridge
  // has stopped — which is exactly when someone needs to be told how to start it.
  | { type: 'rememberBridgeHome'; path: string }
  | { type: 'getBridgeHome' }

export interface ResponseMap {
  getHome: HomeState
  getSelection: SelectionTarget | null
  getSelectionBatch: BatchTarget[]
  getPendingDrafts: PendingDraft[]
  addNotesBatch: BatchResult
  editNote: EntityDetail
  getSharedNotes: SharedNote[]
  editSharedNote: SharedNote[]
  removeSharedNote: SharedNote[]
  getCollections: ListItem[]
  getCollectionTree: TreeNode[]
  getStyleTree: TreeNode[]
  getPages: ListItem[]
  getPageSections: ListItem[]
  getSectionComponents: ListItem[]
  getEntity: EntityDetail
  addNotes: EntityDetail
  saveBrief: HomeState
  saveBody: EntityDetail
  resetBody: EntityDetail
  buildBridgeRequest: { items: BridgeItem[]; context: BridgeRequestContext }
  applyDrafts: { applied: number; skipped: number }
  reviewDrafts: EntityDetail
  deleteNote: EntityDetail
  recategorizeNote: EntityDetail
  revealEntity: null
  buildExport: { fileName: string; files: ExportFile[] }
  resize: null
  rememberBridgeHome: null
  getBridgeHome: string | null
}

/** UI → sandbox. */
export interface RpcRequest {
  __rpc: 'req'
  id: number
  payload: Request
}

/** Sandbox → UI. */
export type RpcResponse =
  | { __rpc: 'res'; id: number; ok: true; result: unknown }
  | { __rpc: 'res'; id: number; ok: false; error: string }

/** Sandbox → UI, unprompted (selection changed on canvas). */
export interface SelectionEvent {
  __rpc: 'selection'
  targets: BatchTarget[]
}

/** Sandbox → UI, unprompted (export progress). */
export interface ProgressEvent {
  __rpc: 'progress'
  message: string
}
