# Component viewer with a properties panel — built in a new v2 folder

## Context

The plugin documents components well but shows nothing of what they *look* like. A
designer writing rules for `Button` sees a property table and a name — the same
information a text file would give them. Meanwhile the plugin already exports component
PNGs for Claude (`src/main/bridge.ts` `exportImage`) precisely because "density, shape,
weight and hierarchy are not inferable from names". The person writing the note deserves
what the model already gets.

**Does Figma expose this?** Yes — all of it except its own panel chrome, which we draw
ourselves:

| Need | API | Status |
|---|---|---|
| Render a component or variant | `exportAsync({format:'PNG'})` + `figma.base64Encode` | already implemented, `src/main/bridge.ts:28` |
| Property controls | `componentPropertyDefinitions` | already extracted, `readProperties()` in `src/main/reader/components.ts:187` |
| The variants themselves | `ComponentSetNode.children` | — |
| Which combination a variant is | `ComponentNode.variantProperties` | — |
| **Booleans actually toggling hidden layers** | `createInstance()` + `setProperties()` | verified in typings |
| Notes on one variant | `setPluginData` on the variant node | works — a variant is a real node |

**Decisions taken:** all work happens in a new copy so the working plugin is untouched;
property picker rather than a contact sheet; notes at both the set level *and* the
individual variant level; booleans and text properties change the picture, not just the
table.

---

## Step 0 — the v2 copy

```bash
cd "…/AI implementation/experiments"
rsync -a --exclude node_modules --exclude dist --exclude package --exclude .DS_Store \
  "DS documentation plugin/" "DS doc plugin v2/"
cd "DS doc plugin v2" && npm install && (cd bridge && npm install)
npm run check          # must pass before a line is changed — proves the copy is sound
```

`node_modules` is excluded deliberately: 68 MB of thousands of tiny files is the worst
possible thing to hand Google Drive to sync. Two `npm install`s are faster and cleaner.

**The v2 manifest gets both a new `id` and a new `name`:**

```json
"id":   "ds-documentation-plugin-noct-v2",
"name": "Design System Documentation (v2)",
```

The new id is what gives v2 its own data space. Figma's own words: *"The data is specific
to your plugin ID. Plugins with other IDs won't be able to read this data."* So v2 cannot
see, change or corrupt a single note v1 has written — the isolation is enforced by Figma,
not by care. The new name is so two entries in the Development menu are tellable apart.

**The consequence, stated plainly: v2 starts with zero notes.** That is fine for building
this feature — the viewer reads components from Figma, not from notes, and per-variant
notes are new ones you write as you test. But documentation written while testing v2 stays
in the v2 space. Treat it as test data.

**Rejoining later is one line.** v2's code is a superset of v1's, so if v2 becomes the
version you keep, change its manifest `id` back to `ds-documentation-plugin-noct` and it
reads every note v1 ever wrote. No migration tool, no export/import — the code and the data
simply meet again. That is what keeps this decision reversible.

Only run one bridge at a time. Both versions use port 8473, and the port is baked into
`manifest.json` under `allowedDomains`, so it is not worth changing.

### Git — deferred, and not under the current account

Deferred by your call, since the folder copy is the fallback for now. When it happens, note
that this machine is **not** currently set up as NOCT:

```
git    user.email  tusharkalkal1@gmail.com
gh     accounts    tusharkalkal1-sudo (active), gowthameein-eng
```

Committing now would author every commit as `tusharkalkal1@gmail.com`. Two separate things
fix that, and only the first matters for a local fallback:

**Commit identity** — no login, no GitHub account needed. Per-repo is safest; it leaves
your other projects alone:

```bash
git config user.email "studio@noct.in"
git config user.name "NOCT"
```

**Push access to GitHub** — only needed if this ever goes to a remote. Neither logged-in
account is NOCT's, so it would be `gh auth login` with the studio account, then
`gh auth switch` to move between them.

---

## Choosing where a note lands

A visible control rather than a mode you can end up in by accident.

```
┌──────────────────────────────────────────────────────┐
│  ▓▓▓▓▓▓▓▓▓▓▓▓        Type   [Primary ▾]              │
│  ▓  Button  ▓        Size   [36      ▾]              │
│  ▓▓▓▓▓▓▓▓▓▓▓▓        State  [Hover   ▾]              │
│                      Icon   [ ●───  ] on             │
│  176 variants                                        │
├──────────────────────────────────────────────────────┤
│  Writing about   ● Button, all variants              │
│                  ○ This one · Size=36, Type=Primary  │
└──────────────────────────────────────────────────────┘
│  Note about Button…                             [↑]  │
```

- **The set is always the default.** Open a component, type, send — it goes on `Button`.
  Nothing changes for anyone who never touches the picker.
- **Choosing "This one" is a deliberate click**, and the option always spells out which
  combination it means. Change a dropdown while it is selected and the label changes with
  it, so the target is never hidden.
- **The composer restates the target** in its placeholder.
- **At set level you see everything** — the set's own notes plus any variant notes, each
  tagged with the variant it belongs to. Selecting a variant filters to that one. Variant
  notes are never squirrelled away where you forget they exist.

This matters more than it looks: the one unexplained bug in this project is notes landing
on the wrong entity, and a picker that quietly redirected writes would be the ideal way to
cause more of them.

---

## Rendering, and why booleans need a different path

**Variant properties** pick a different node, so they cost nothing: find the child of the
set whose `variantProperties` match, `exportAsync` it. No document change.

**Boolean, text and instance-swap properties do not.** They are overrides applied to an
*instance* — the variant node itself renders with the defaults baked in, so toggling
`Icon` on a static export would do nothing. To make the hidden layer actually appear:

```ts
const instance = target.createInstance()      // lands on the current page
instance.x = -100_000                          // out of anyone's way
try {
  instance.setProperties({ ...variant, ...booleans, ...text })
  png = figma.base64Encode(await instance.exportAsync({ format: 'PNG', constraint }))
} finally {
  instance.remove()                            // never leave one behind
}
```

`setProperties` takes `string | boolean | VariableAlias` and handles every property type in
one call, so this path is uniform.

**It runs only when a non-variant property is moved off its default**, because it briefly
writes to the document. The `finally` is not optional: an orphaned instance left on a
design system page would be a genuine mess.

Whether this pollutes the undo stack is the one thing the typings do not settle — Figma
coalesces plugin edits in ways the docs leave vague. Verification step 5 checks it against
a real file; if ⌘Z resurrects phantom instances, the fallback is to gate the instance path
behind an explicit "show with overrides" button rather than firing on every toggle.

**Exports are lazy and cached** either way — only what is on screen is ever rasterised, so
a 176-variant set costs one image, not 176. That is the whole reason a picker beats a
contact sheet. Transparent PNGs sit on the checkerboard already defined for `.swatch` in
`src/ui/styles.css`, or a dark icon on the dark panel is invisible.

---

## Work — all paths below are inside `DS doc plugin v2/`

### 1. Shared preview module — `src/main/reader/preview.ts` (new)

Lift `exportImage` out of `src/main/bridge.ts:28`, parameterise the max dimension (the
bridge wants 320px, the viewer ~480px), add a session `Map<key, png>` cache, and add the
instance-override path above. Both callers use it. Keep the existing failure behaviour: a
component that cannot be rasterised returns `undefined` rather than sinking the request.

### 2. Variant list in `EntityStructure` — `src/shared/types.ts`

```ts
/** Component sets: every variant and the combination it represents. */
variants?: Array<{ id: string; name: string; properties: Record<string, string> }>
```

Populated in `componentStructure()` from `node.children` — ids and `variantProperties`
only, no exports, so it stays cheap.

### 3. New RPC — `getComponentImage`

```ts
{ type: 'getComponentImage'; nodeId: string; overrides?: Record<string, string | boolean>; maxPx?: number }
  → { png: string; width: number; height: number } | null
```

No overrides takes the direct path; overrides take the instance path.

### 4. Per-variant notes — new `EntityKind: 'variant'`

A variant is a `COMPONENT` whose parent is a `COMPONENT_SET`, so storage needs nothing new.
What does:

- **`SECTION_SETS.variant`** — the component set list minus `pairs` (composition is a
  set-level concern). Also `SECTION_LABELS`, `SECTION_HEADINGS`, `SECTION_PROMPTS`.
- **`entityExists`** (`src/main/reader/entity.ts`) — add `case 'variant'`: node exists, is
  `COMPONENT`, parent is `COMPONENT_SET`. The exhaustive `never` default will fail the
  typecheck until this is added, which is exactly what it is there for.
- **`resolveEntity`** — `case 'variant'` returning the variant node as host, name from
  `variantProperties`, `typeLabel: 'Variant of Button'`.
- **`ancestryOf`** (`src/main/bridge.ts`) — a variant inherits set → section → page, so AI
  drafts never contradict a rule written on the set. Reuses the existing chain-walk.
- **Selection** — `resolveSelection` keeps resolving a canvas variant *up to its set*
  (`src/main/reader/selection.ts`) and additionally reports the variant id, so the picker
  opens on the variant you had selected while the write target stays the set.

### 5. Export — variants live inside their component's file

The MD grouping rule stands: individual components get individual `.md` files. A variant is
not a component, so variant notes render as `### Variant: Size=36, Type=Primary`
subsections inside the parent's file, after the set-level sections
(`src/main/export/build.ts:174-201`).

Gather them via the root index (`readIndex`) to learn *which* variants carry notes rather
than reading plugin data off every child of every set — the difference between a few
lookups and several thousand.

### 6. Coverage counts components, not variants

A documented variant must not change the component denominator in `coverageSnapshot`.
Surface it on the component row instead: `Button · 4 notes · 2 variants documented`.

---

## Files

All inside `DS doc plugin v2/`. `DS documentation plugin/` is not touched.

| File | Change |
|---|---|
| `manifest.json` | new `id` (own data space) and new `name` |
| `src/main/reader/preview.ts` | **new** — cached export, direct and instance-override paths |
| `src/ui/ComponentViewer.tsx` | **new** — picker, image, write-target control |
| `src/main/reader/components.ts` | variant list in `componentStructure` |
| `src/main/reader/entity.ts` | `variant` in `entityExists` and `resolveEntity` |
| `src/main/bridge.ts` | use shared preview; variant ancestry |
| `src/main/export/build.ts` | variant subsections inside component files |
| `src/shared/types.ts` | `variant` kind, section sets, `variants`, new RPC |
| `src/main/code.ts` | `getComponentImage` handler |
| `src/ui/screens/Detail.tsx` | render the viewer; target-aware composing and note list |
| `src/ui/styles.css` | viewer layout, reusing the `.swatch` checkerboard |

---

## Verification

```bash
npm run check     # in DS doc plugin v2/
```

Then **Plugins → Development → Import plugin from manifest…** on the v2 manifest, so both
versions are available and distinguishable by name. A scratch or duplicated Figma file is
still the sensible place to work, but v2 writing to its own data space means a real library
is no longer at risk from a v2 bug.

1. Open a large multi-variant set (Button, 176 variants). It must open without a stall —
   proves exports are lazy.
2. Change a variant dropdown; the image swaps. Change it back; no second export (cache).
3. **Toggle a boolean that hides a layer — the layer appears and disappears in the image.**
   This is the thing static exports cannot do.
4. A single component with no variants shows its image and no picker. An icon with a
   transparent background is visible against the checkerboard.
5. **After toggling booleans, check the canvas for stray instances and press ⌘Z several
   times.** Nothing should reappear. If it does, gate the instance path behind a button.
6. Write a note with the target on the set → lands on the set. Switch to a variant, write
   another → lands on the variant. Reopen: both appear under the right target, the set view
   shows both with the variant one tagged, and the `storedAs` banner never fires.
7. Export: the variant note is a `###` subsection inside `button.md`. No new file.
8. Coverage on the home screen is unchanged by the variant note.
9. **Open the same Figma file in v1.** Its notes are all present and untouched, and none of
   v2's test notes appear. Then reopen v2 — it still sees only its own. This is the check
   that proves the two data spaces are genuinely separate.

## Risks

- **v2 starts empty and its test notes stay there.** The trade for real isolation. Changing
  the manifest `id` back is what reunites v2's code with v1's notes if v2 wins.
- **The instance path writes to the document.** Mitigated by the `finally` and by only
  running when a non-variant property changes, but it is the one part of this that touches
  the file rather than just reading it.
- **Export cost.** Every viewed combination is a rasterise. Lazy plus cached keeps it to
  what is actually looked at; clicking through all 176 would pay for all 176.
- **Variant note explosion.** Per-variant notes are opt-in, but documenting every variant
  of every set produces large component files. The index-driven gather keeps the *build*
  fast; file size is then the designer's choice.
- **`variantProperties` is marked deprecated** in favour of `InstanceNode.componentProperties`,
  which does not apply to a variant inside a set. It remains the documented way to read a
  variant's combination; `node.name` is the fallback if it is ever removed.
