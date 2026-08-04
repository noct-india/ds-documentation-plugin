# Design System Documentation — Figma plugin

Attach written documentation to every element of a Figma design system, and export it
as a ZIP of markdown shaped for **Figma Make's `guidelines/` folder**.

## Why

Figma Make can pull variables and styles out of a published library, but only as
"a simplified version" converted to CSS values — per Figma's own docs, Make kits
"don't support full extraction of design tokens". None of the reasoning survives:
why a token exists, when to reach for which variant, what never to do.

This plugin captures that. A designer drills to any variable, style or component and
types a rule. It persists inside the Figma file, accumulates over months, and exports
as guidelines Make can actually read.

## Running it

Development and sideloading require the **Figma desktop app** — the browser version
cannot load an unpublished plugin.

```bash
npm install
npm run build
```

Then in Figma desktop: **Plugins → Development → Import plugin from manifest…** and
pick `manifest.json` from this folder. Run it from **Plugins → Development → Design
System Documentation**.

`npm run dev` rebuilds on change. Figma does not hot-reload — re-run the plugin to
pick up a rebuild.

| Command | Does |
|---|---|
| `npm run build` | One-shot build into `dist/` |
| `npm run dev` | Rebuild on change |
| `npm test` | Self-test of storage, tree parsing, slugging, rendering, drafts (418 checks) |
| `npm run typecheck` | Typecheck plugin source and tests separately |
| `npm run sample` | Regenerate `sample-output/` — a realistic export, no Figma needed |
| `npm run classify -- "note"` | Show where a given note auto-files (classifier tuning) |
| `npm run check` | typecheck + test + build |
| `npm run test:bridge` | End-to-end harness for `bridge/`, no Figma needed |
| `npm run test:refs` | Replays recorded model replies against the ref parser |
| `npm run package` | Build a zip another designer can import — see below |

> **Test against a scratch file, not a client library.** The plugin writes plugin data,
> which modifies the file. Duplicate a design system before pointing it at one.

### Sharing it with another designer

`npm run package` writes a zip into `package/` containing `manifest.json`, the built
`dist/`, the optional `bridge/`, and [`INSTALL.md`](INSTALL.md) — everything needed and
nothing else, around 160 kB. The recipient unzips it and imports the manifest; no
`npm install`, no build step, because `dist/` ships built.

Figma has no private distribution below an Organization plan, so a zip is the honest
answer rather than a workaround. Each recipient gets their own copy of the plugin, but
notes live in the **Figma file**, so two designers running two copies against the same
library see the same documentation.

## How it works

### Storage — notes live on the thing they describe

Notes are written as `pluginData` on the Figma object itself: the `Variable`, the
`VariableCollection`, the `PaintStyle`/`TextStyle`/`EffectStyle`, the `ComponentNode`.
All of these support the same `getPluginData`/`setPluginData` pair, so one code path
covers every entity kind. Data saves with the file, syncs to everyone who opens it,
and is scoped per file automatically — two design systems never mix.

**The source of truth is an append-only log, not the markdown.** Every raw note the
designer types is stored verbatim and never rewritten. The structured markdown is
*derived* from it. Removing a note is a soft delete: it stops rendering, the words
stay. That is what makes "nothing is ever lost" true rather than aspirational — and
it is what will let an AI pass rewrite the prose later without risking the original.

**Everything is ASCII-escaped before writing.** Figma's 100 kB limit is measured in
bytes and *throws* when exceeded, but JavaScript string lengths are UTF-16 units. A
note in Devanagari is 3 bytes per character, so slicing an 80,000-character chunk
would produce 240,000 bytes and fail. Escaping non-ASCII to `\uXXXX` makes length and
byte count identical, so chunking is exact. `npm test` covers this directly.

### Reading — lazy, mirroring the file

Navigation reflects how the design system is actually arranged:

- **Variables** → collections → `/` folder groups → variable
- **Color / Text / Effect styles** → `/` folder groups → style
- **Components** → pages → sections → component

Figma has no folder object — grouping is purely the `/` characters in a name, so the
tree is reconstructed by splitting names. Notes are anchored to entity **ids**, never
to a derived path, so renaming a group reshuffles navigation without orphaning
anything.

Pages list instantly from `figma.root.children`; a page's contents load only when
opened. `loadAllPagesAsync()` runs exactly once, on export, behind a progress
indicator — it is documented as slow on large files.

### Components auto-populate

A component's document arrives pre-filled with its real structure pulled from Figma —
variant axes, boolean toggles, text and instance-swap props, defaults, nested
components, and Figma's own per-property descriptions. An undocumented component still
exports its full property table plus an explicit "not documented yet" warning, so an
agent knows the difference between *no rule* and *no constraint*.

Property keys for BOOLEAN/TEXT/INSTANCE_SWAP carry a `#0:0` suffix that disambiguates
two properties sharing a display name. The full key is stored; only the clean prefix
is displayed.

### Layout

Two panes: navigate on the left, document on the right. They hold separate state, so
drilling into a folder does not disturb notes being written, and picking a token does not
lose your place in the tree. The selected row is marked in the left pane, breadcrumbs are
clickable, and the window has a drag grip in the bottom-right corner.

**The right pane always shows what a note will be written to** — name plus a badge saying
`Variable`, `Component set`, `Color style` and so on. A name alone does not say what kind
of thing it is, which is how notes about icons end up on a colour token.

### Ordering

Variables, collections and styles appear **in Figma's order, not alphabetically**.
`collection.variableIds` and the local-style lists come back in the order the designer
arranged them, and the folder tree gives a folder the position of its first member — so
the plugin reads like the Variables panel it mirrors. Components stay alphabetical within
a section, matching Figma's Assets panel.

### Visual previews

Lists show what a token or style actually looks like, so browsing the plugin reads the
way Figma's own Variables and Assets panels do rather than as a column of names.

- **Colour variables** get a swatch — **one stripe per mode**, in collection order, so a
  token that differs between Light and Dark shows both at a glance.
- **Alias chains resolve to the real colour.** A semantic token pointing at another token
  pointing at a primitive shows the colour finally painted, not the first hop. Resolution
  runs against the cached variable map, so it stays synchronous however many variables a
  collection holds, and follows aliases into *other* collections whose mode ids differ.
- **Non-colour variables** show their resolved value instead, since a number has no
  visual form.
- **Colour styles** render solid fills and gradients (linear, radial, conic). The topmost
  renderable paint wins; hidden paints are skipped and image fills fall back to the plain
  icon.
- **Effect styles** render as a small box carrying the real shadow, with extreme blurs
  capped so a 200px blur does not swamp a 16px swatch.
- **Text styles** show `Ag` at the real weight, scaled to the row.

Swatches sit on a checkerboard, so a 10% fill is distinguishable from a solid one — the
same reason Figma does it. The detail screen shows the same preview, larger.

### Categories

The chip row is a thinking prompt, not just a filing system. It is designed against the
ways generated UI actually goes off-system: inventing components that don't exist,
picking the wrong variant, and skipping loading / empty / error states.

**A category only exists for knowledge Figma cannot see.** Anatomy, variants, props,
defaults and nesting are already auto-extracted, so nobody is asked to retype them.

| Category | What it prevents |
|---|---|
| **Purpose** | Reinventing something that already exists |
| **When to use** | Reaching for the wrong component |
| **Instead** | The big one — an explicit redirect stops wrong-component picks dead |
| **Pairs with** | Layouts that are assembled rather than designed |
| **States** | The most-cited gap: loading, empty, error, disabled |
| **Content** | Copy that reads like a machine wrote it |
| **Rules** | Constraints being treated as preferences |
| **Don't** | Repeating a known mistake |
| **Notes** | Everything else |

`Do` was merged into `Rules`. Every rule is also a "do", so keeping both guaranteed
inconsistent filing — a designer hesitating between two buckets files badly, and bad
filing is worse than a coarser bucket. `Don't` survives because negative constraints
are distinctly high-signal for an agent, and a distinctly different memory prompt.

**The sets adapt per type.** A variable shows six chips; a component adds Pairs with,
States and Content; a collection swaps in Modes and Naming; project level uses Character
and Layout — density, surface strategy and colour restraint, which is the closest thing
to encoding a designer's taste. Showing "States" on a colour variable would be noise,
and noise trains people to ignore the row.

**Categorisation is automatic.** Type the note; it files itself. Picking a category by
hand is an override, not a prerequisite — making someone choose a bucket before they can
type turns a thought into admin, and the buckets are genuinely ambiguous anyway ("Always
swap the placeholder icon. Don't use the wrapper as it is" is both a rule and a don't).

**It reads sentence by sentence, not just the opening.** One typed note often carries two
rules — "Always swap the placeholder icon. Don't use the wrapper as it is" is a rule *and*
a don't — and filing the whole thing under whichever one led is lossy. Each sentence is
classified separately, and the composer shows the split before you send it.

Splitting blindly would be worse, so a sentence stays welded to the one before it when it
cannot stand alone:

- it carries no category signal of its own,
- it opens with a back-reference — "Used to size icons. **It** should never be edited" is
  one thought, and separating it strands a pronoun,
- or it is under three words ("Ever.", "No exceptions.").

Adjacent sentences landing in the same category merge back together, so a three-sentence
rule stays one bullet. Picking a category by hand overrides all of it and keeps the note
whole. Splitting is verified never to drop a word.

The classifier is a weighted pattern match in `src/shared/classify.ts` — deterministic,
offline, instant. That last part is what makes it usable: the split is shown live on the
Auto chip as you type (`Auto → Rules + Don't`), so it is never a surprise, and any note can
be re-filed in one click from the history list. Two design points worth keeping:

- **Only categories valid for that entity kind are considered.** A colour variable has no
  "States", so a note mentioning `disabled` cannot be misfiled somewhere it would never
  render. This removes most misclassification for free.
- **A signal in the first 32 characters counts extra**, because that is where the main
  point of a note sits. "Always X. Don't Y." files as a rule; "Don't Y. Use X instead."
  files as a redirect.

To tune it: add the note as a case in `test/selftest.ts`, then adjust weights until it
passes. `npm run classify -- "your note"` shows where a given note lands. When the AI pass
arrives it can replace this module wholesale — nothing else depends on how the guess is made.

**Gaps are visible.** An outlined chip has nothing written; a filled one does. Selecting a
chip puts a question in the input ("What mistake have you seen someone make with this?")
rather than a generic prompt. A label names a bucket; a question retrieves a memory.

Notes filed under a category that later stops applying still render — the never-lose
guarantee covers reorganisation, not just deletion. Retired keys are migrated, not
dropped: a note written under `Do` reappears under Rules.

### Batch notes

Select several components on canvas and open the plugin — it lands on a batch composer
instead of a single document. Anything written there is appended to **every** selected
component.

Strictly additive, by construction: each component gets its own appended entries, and
nothing already written to any of them is read back, rewritten or overwritten. A component
that already has notes simply gains more, with its existing wording, categories and
authorship untouched. Covered by tests.

Selection resolves the way you would expect:

- Selecting variants or instances resolves **up** to the component they belong to.
- Selecting three variants of one set yields that set **once**, not three times.
- Selecting a section or frame with no component above it looks **down**, so you can
  document everything inside it in one go.
- **Components win.** If the selection contains any, you get those and nothing else —
  selecting a button opens the button, not a picker listing every token it uses.
- **Otherwise you get the tokens the selection is painted with** — the styles and bound
  variables on the selected layers. Select a rectangle, document the colour style on it.

> Figma does **not** tell plugins what is selected in the Variables or Styles panels —
> `figma.currentPage.selection` is scene nodes only, and `ActiveUser.selection` is node
> ids. Clicking a variable row in Figma's own panel cannot open its notes; reading tokens
> off a selected *layer* is the closest available thing. Use the left pane to reach a
> variable directly.

The batch screen lists every recipient with its current note count before you write
anything, so a wide selection is never a surprise. Clicking one opens its own notes.
Categorisation works exactly as it does for a single component — same classifier, same
sentence splitting — because both screens share one composer.

**Notes already on the selection are shown, and can be edited across all of them.** A
batch note exists as a separate entry on each component with its own id, so identity here
is the wording plus the category, not an id. Each row says whether a note is on all of the
selection or only some (`on 5 of 8`) — that distinction matters, because editing rewrites
it everywhere it appears and nowhere it does not.

### Editing a note

Notes can be reworded, in the batch screen or in a single component's history. **The
wording an edit replaces is kept**, not discarded — it goes onto the note's `revisions`,
alongside who changed it and when. The never-lose guarantee covers rewrites, not only
deletions: a note can be corrected without losing what it originally said.

Editing preserves the note's id, category, timestamp and original author — it is a
correction to an existing note, not a new one. Editing to identical or empty text is a
no-op rather than a manufactured revision, and a hidden note is never picked up by a later
batch edit.

### Editing the markdown by hand

The preview has an **Edit markdown** action. Only the authored half is editable — the
title, values and property tables above it are regenerated from Figma on every open, so an
edit there would be overwritten the moment a variant changed.

Saving an edit *pins* the body: it becomes what renders and what exports, instead of being
derived from the note log. New notes are then **merged into** the edited text under the
matching heading rather than regenerating over the top, so adding a note never silently
discards an edit. The note log keeps accumulating underneath either way, so **Rebuild from
notes** is always a way back and nothing typed is ever actually lost.

The export honours pinned bodies too — otherwise the ZIP would quietly rebuild every
document from the log and drop every manual edit.

### Export

```
guidelines/
  Guidelines.md              entry point Make reads first — character, reading order, rules
  foundations/
    overview.md              collections + styles index
    primitivecolors.md       one file per variable collection, modes documented
    colorstyles.md           folder structure preserved in a Structure block
    textstyles.md
    effectstyles.md
  components/
    overview.md              catalogue, grouped by page and section
    icons/                   ← one folder per Figma page
      navigation/            ← one folder per section on that page
        chevron.md
    actions/
      buttons/
        button.md
```

**Component folders mirror the Figma file**: `components/<page>/<section>/<name>.md`,
taken from the pages and sections the designer actually arranged. Components sitting
loose on a page skip the section level rather than landing in an "Ungrouped" folder.
Page names are slugged, so `✅ Icons` becomes `icons/` — status emoji never reach the
filesystem.

Filenames are unique **within a folder**, not globally: an icon called `box` and a shape
called `box` both keep their name. That does mean the tree has to be recreated in Make
rather than dragged in flat.

`Guidelines.md` is the master router. Per Figma's guidance it deliberately does not
contain everything — "multiple short guidelines files are better than a few large
files".

See `sample-output/` for real generated output.

**One file per component, always** — including icons, which are individual components in
this system rather than a single icon set. A 400-icon page therefore produces 400 files,
foldered under its page and section. This is deliberate: each icon can carry its own
usage note, and the folder tree is what keeps that navigable. Do not collapse a section
into one file.

## Voice input

The mic button triggers **OS dictation**, not in-app recording. This is a hard Figma
limitation, not a shortcut: `navigator.mediaDevices` is absent inside a plugin iframe
because Figma does not set `allow="microphone"` on it. Shipped voice plugins work
around it by opening a separate browser tab, which means leaving Figma on every note.

macOS **Fn Fn**, Windows **⊞ Win + H** — dictation types straight into the field and
the quality is already excellent.

## Drafting with Claude

Documenting 200 components, 150 variables and 50 styles by hand is the real cost of this
plugin. `bridge/` turns that into reviewing drafts — several times faster than authoring.

One Node process bridges the two sides: MCP over stdio to Claude, WebSocket on
`127.0.0.1:8473` to the plugin. Nothing is written to disk and nothing leaves the machine.
Double-click `bridge/Start Claude bridge.command` to run it, or register it with Claude and
let Claude start it. See [`bridge/README.md`](bridge/README.md) for setup.

**Start it** in the plugin's status bar tells you where that launcher is — it cannot press
it for you. A plugin runs in a sandboxed iframe: no filesystem, no processes, and no way to
learn its own location on disk. So the bridge reports its directory when it connects and the
plugin remembers it in `clientStorage`, which is why the path shown is right on whichever
machine unzipped the folder rather than the one that built it.

**Drafts are drafts.** Suggestions arrive flagged. Until a human approves one it does not
count toward coverage and is **excluded from the export** — an unreviewed guess must never
reach Figma Make, which would follow an invented constraint as faithfully as a real one.
Approval is recorded as an edit by the approver, because that is the moment a person takes
responsibility for the claim.

Claude is sent the element's structure, its siblings, the full component catalogue, your
project guidelines, the **About this project** brief, and — for requests of 25 items or
fewer — **a PNG of each component**. Density, shape and hierarchy are not inferable from a
property table, and this is the main reason the bridge beats handing over an exported ZIP.

**Typing a note does not involve Claude.** The composer's send button files what you wrote,
immediately, offline. The dropdown beside it offers **Tidy it up** and **Ask Claude** —
both deliberate choices, never the default. Routing every note through a model was tried
and abandoned: it turned a keystroke-fast action into a nine-second wait for wording that
was already fine.

**Activity** is where anything in flight lives. Nobody waits on a bulk draft, so the runs
had to be watchable from elsewhere: *In flight* shows what is running with progress and a
stop button, *Waiting approval* collects every suggestion that has landed but not yet been
kept or dropped, wherever in the system it belongs.

Two ceilings exist because the live run found both. Four `claude` processes at most, shared
across every run — five bulk drafts would otherwise spawn twenty and take the machine down;
queueing more work now makes it slower, never unstable. And a batch is abandoned after three
minutes, because a spawned `claude` can block indefinitely and a spinner that never resolves
tells a designer nothing.

The whole feature is optional. With no bridge running the plugin behaves exactly as it did
before.

## Where the AI sits

**Figma does not lend plugins its model.** Checked against plugin typings v1.132.0:
there is no `figma.ai`, no completion call, no AI surface of any kind. It has been
requested twice — [July 2024](https://forum.figma.com/ask-the-community-7/is-there-any-plans-to-add-ai-capabilities-to-the-plugin-api-17948)
and [April 2026](https://forum.figma.com/suggest-a-feature-11/consider-enabling-access-to-figma-ai-in-plugin-53176)
— and answered neither time. Figma's own [AI plugin template](https://github.com/figma/ai-plugin-template)
calls OpenAI through a backend the developer hosts, which is Figma saying by example
that there is no in-house option.

So the work splits in two, and only one half wants a model:

**Routing** — which category a sentence belongs to — is mechanical, and the classifier
being instant and offline is not a compromise. It is what makes the live
`Auto → Rules + Don't` preview possible; nothing over a network can run on a keystroke.

**Synthesis** — turning eleven accumulated bullets into prose one person could have
written, spotting two notes that contradict each other, noticing that Button's variants
are documented but nobody ever said when *not* to reach for it — genuinely wants a model.
It is also a batch operation, so it does not need to happen inside the plugin.

**The decided approach is downstream, with no infrastructure.** Export the ZIP, hand the
markdown to an agent (Claude Code with the Figma MCP connected, or Figma Make itself),
then paste the result back through **Edit markdown**. That pins the polished version and
new notes merge into it rather than overwriting. No proxy, no API key, no hosting — and
the agent sees the whole system at once instead of one entity at a time, which is where
contradictions actually surface.

The one rough edge: pasting back is per-entity. Fine for the handful of components worth
polishing, tedious across sixty. If that becomes the bottleneck, the fix is a round-trip
**import** — stamp each exported file with its entity id, then read an edited ZIP back in
and re-pin every body in one go. Not built; the export format would need the id marker
first.

Nothing about this is a dead end if Figma ever ships an AI API. The log stays the source
of truth and the rendered markdown is derived, so a synthesis pass can be swapped in
without migrating anything, and a bad rewrite is always recoverable with **Rebuild from
notes**.

## Known limits

- **Deleting a variable deletes its notes.** They live on the object; nothing can read
  plugin data off something that no longer exists. The plugin detects and reports
  orphans on the home screen, but recovery is via Figma version history or your last
  export. Export periodically — that ZIP is the backup.
- **Branch merges drop root-level plugin data.** The coverage index lives on
  `figma.root` and may not survive a branch merge; it is derived and rebuilds itself.
  Actual notes live on the entities and are unaffected.
- **Entity ids are file-scoped.** Copying the design system into a new file re-ids
  everything and orphans every note. Export first.
- **Remote library items are invisible.** The plugin documents *local* variables,
  styles and components, so run it in the library file itself, not a consuming file.
