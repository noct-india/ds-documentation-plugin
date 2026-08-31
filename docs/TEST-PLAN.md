# Design System Documentation (v2) — Test Plan

Version under test: working tree on `main` (as of 2026-08-28), which adds to the last
commit `f5261b2`:

- **Restored** the detail-pane loader effect deleted in `9c82c5e` (the "Loading…" hang).
- **Added** Windows launchers (`Start Claude bridge.cmd`, `Run bridge at login.cmd`,
  `run-hidden.vbs`) + made the in-plugin "Start it" panel OS-aware.

How to read this: **§0 is automated** and already run (results inline). **§1–§7 are manual**
— run them in Figma desktop and mark each `Result` as ✅ / ❌ / ⚠️. Priority tags: **P1**
must pass before this ships, **P2** important, **P3** nice-to-have.

Open finding to settle first: **[F-1] variant-scoped note exported without its scope** — see
§3 and the Findings appendix.

---

## §0 · Automated baseline — ✅ all green (run 2026-08-28)

Run from the plugin root. These need no Figma.

| ID | Command | Checks | Result |
|----|---------|--------|--------|
| A1 | `npm run typecheck` | TS types (plugin + tests) | ✅ clean |
| A2 | `npm test` | storage, tree parse, slugging, rendering, drafts, **scope**, migration | ✅ **500 checks** |
| A3 | `npm run test:bridge` | bridge round-trip: connect, request, draft, cancel, survive-close | ✅ verified |
| A4 | `npm run test:refs` | model-reply → ref-parser replay | ✅ intact (6 drafted, 0 failed) |
| A5 | `npm run build` | esbuild → `dist/code.js` + `dist/ui.html` | ✅ builds |
| A6 | `npm run package` | distributable zip incl. Mac + Windows launchers | ✅ 16 files |

Re-run A1–A4 after any source change: `npm run check` covers typecheck + test + build.

---

## §1 · Install & bridge lifecycle

### 1a · Plugin import (both OSes) — P1
| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| I1 | Unzip; Figma desktop → Plugins → Development → Import from manifest → `manifest.json` | Plugin appears under Development | |
| I2 | Run on a **design-system library** file | Sidebar lists Variables / Color / Effect / Text styles / Components with counts | |
| I3 | Footer with no bridge running | "Claude bridge off" | |

### 1b · macOS bridge — P1
| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| M1 | Double-click `bridge/Start Claude bridge.command` | Terminal opens; `listening on 127.0.0.1:8473` + `[::1]:8473`; footer → "Claude bridge connected" | |
| M2 | With M1 running, double-click it again | Detects port held, names the process, offers to stop | |
| M3 | Double-click `Run bridge at login.command` | Registers launchd agent; bridge running; "starts at every login" | |
| M4 | Double-click `Run bridge at login.command` again | Removes the agent; bridge stops | |

### 1c · Windows bridge (NEW — needs a real Windows box) — P1
| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| W1 | Double-click `bridge\Start Claude bridge.cmd` | Window: finds node, frees port, `npm install` on first run, starts bridge; footer → connected | |
| W2 | Run W1 again while bridge up | Names the PID on 8473, offers Y/N to stop and restart | |
| W3 | With no Node installed | Clear "install from nodejs.org" message, no crash | |
| W4 | Double-click `Run bridge at login.cmd` | Registers task `NOCT DS Bridge`; bridge starts **hidden** (no console); log at `%LOCALAPPDATA%\NOCT\dsdoc-bridge.log` | |
| W5 | Reboot / log out+in | Bridge auto-starts at login; plugin connects within a few seconds | |
| W6 | Double-click `Run bridge at login.cmd` again | Deletes the task, stops the running bridge | |
| W7 | In-plugin "Start it" panel (footer) on Windows | Names `Start Claude bridge.cmd` (not `.command`); "Copy terminal command" gives `cd /d "…" && node server.mjs` | |
| W8 | Path with a space (e.g. unzip into `C:\Users\me\My Tools\…`) | Both `.cmd` files and the login task still work (quoting holds) | |

### 1d · Resilience — P2
| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| R1 | Start bridge with **no `claude` CLI** on PATH | Bridge still starts + connects; warns drafting will fail | |
| R2 | Kill bridge mid-session | Footer flips to "off"; plugin retries and reconnects when it's back (no reload) | |
| R3 | Two bridges / port 8473 already taken | Second launcher refuses cleanly, names the holder | |

---

## §2 · Core authoring (no AI needed)

### 2a · Write a note on each entity kind — P1
For each: open it, type a note, press Enter, confirm it saves under an auto-chosen section
and the count/marks update.

| ID | Entity kind | Result |
|----|-------------|--------|
| N1 | `variable` (a token) | |
| N2 | `collection` | |
| N3 | `paintStyle` (color style) | |
| N4 | `textStyle` | |
| N5 | `effectStyle` *(0 in the test file — verify empty state reads cleanly)* | |
| N6 | `component` | |
| N7 | `componentSet` | |
| N8 | `folder` (a `/` group) | |
| N9 | `page` (section) | |
| N10 | `project` ("About this project") | |

### 2b · Classifier — P2
| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| C1 | Type "Don't use for destructive actions" | Auto-files to **Don't** (pill shows `Auto → Don't`) | |
| C2 | Type "Pairs well with the input field" | Auto-files to **Pairs with** | |
| C3 | Manually pick a section pill, then send | Manual pick overrides the auto guess | |
| C4 | CLI cross-check: `npm run classify -- "your text"` | Same section the UI shows | |

### 2c · Edit / history / lifecycle — P2
| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| E1 | Reword a saved note | New text shown; original preserved in history | |
| E2 | Hide a note | Excluded from export; wording retained under history | |
| E3 | Recategorise a note to another section | Moves; export reflects new section | |
| E4 | Delete the underlying Figma node, reopen its notes | "This item no longer exists…" banner, not a crash | |

---

## §3 · Component viewer & variant scoping — **focus area**

This is where **[F-1]** lives. Do C-scope tests on a real set (the 47-variant Button is ideal).

### 3a · Viewer basics — P1
| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| V1 | Open a component **set** | Viewer renders a preview + a property panel (dropdowns/switches), "N variants" | |
| V2 | Change a dropdown (e.g. State = Hover) | Preview re-rasterises to that combination | |
| V3 | Toggle a BOOLEAN (Show Icon) | Preview updates; if it can't apply, the "could not be applied" note shows | |
| V4 | Open a set with a **sparse** variant matrix | Picker never strands you on a non-existent combo | |

### 3b · Scoping a note to a subset — **P1, covers F-1**
| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| S1 | Tick **only** the `Type` checkbox, dropdown = Primary | Footer reads "Writing about **Type = Primary** · ~N of 47 variants"; the row highlights | |
| S2 | Type "This variant should be used only once per page" → **send (plain Add)** | Note saves | |
| S3 | Immediately: does the saved note in the detail list show it's scoped to Type = Primary? | **Scope is visible on the note** (not a bare unscoped bullet) | |
| S4 | Tick `Type`+`State`+`Size` all → send a note | "this exact variant"; note carries the full combo | |
| S5 | Tick nothing → send a note | "every variant"; stored unscoped (applies to whole set) | |
| S6 | **Export** and open `components/…/<set>.md` | Scoped notes appear under a **`When Type = Primary`** heading; unscoped ones under plain sections | |
| S7 | `clear` the scope, confirm footer returns to "every variant" | Scope resets | |

> **F-1 pass criterion:** after S2, the exported file MUST show
> `## When Type = Primary` (or equivalent) above "This variant should be used only once per
> page" — **not** a bare `## When to use` bullet. In the attached
> `printstopds-guidelines` export this note came out **unscoped**, so S2/S6 is the decisive
> test. If it fails here with the scope clearly ticked, it's a submit-time bug to fix; if it
> passes, the earlier export was an un-ticked send.

### 3c · Variant target vs set — P2
| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| T1 | Select one variant on canvas, open plugin | Opens on that combination | |
| T2 | Move the write-target to a variant chip, write a note | Note follows the target; picker doesn't snap back to Primary (the `e81ce02` fix) | |
| T3 | Legacy per-variant notes present | Migrated onto the set as scoped notes (the `9c82c5e` migration) | |

---

## §4 · Detail-loader regression — **verifies today's fix** — P1

The bug: opening any item left the right pane stuck on "Loading…". Re-run the plugin first
so Figma picks up the rebuilt `dist/ui.html`.

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| L1 | Open a **component** | Detail renders (notes + viewer), **never** stuck "Loading…" | |
| L2 | Open a **variable**, a **text style**, a **color style** | Each loads its detail | |
| L3 | Open "About this project" then a component then a collection in sequence | Every switch loads; no stale "Loading…" | |
| L4 | Open item A, quickly open item B before A finishes | B wins; no flicker of A's data (the `cancelled` guard) | |

---

## §5 · AI / bridge drafting — P2 (bridge running)

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| D1 | "Ask Claude" on a single component | A suggestion streams back as a **draft** (not counted/exported until approved) | |
| D2 | "Draft n with Claude" on a level (e.g. a collection) | Progress meter counts up; drafts land in Activity | |
| D3 | Draft with a scope active (Type = Primary) | Drafts arrive **scoped** to Type = Primary (check export heading after approval) | |
| D4 | Approve all / Reject all | Approved become documented; rejected discard, wording kept in history | |
| D5 | "Add and tidy up" | Note saved first, then tidied wording returns | |
| D6 | Send a draft request, close the plugin, reopen | Drafts were held and flush on reconnect (matches A3) | |
| D7 | Ask a question ("which components have no States documented?") | Answered in the panel, not stored as a note | |

> Note for D3: this is the AI analogue of F-1 — confirm the scope survives the *draft →
> approve → export* path, not just the hand-typed path.

---

## §6 · Export correctness — P1

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| X1 | Export | Produces `<file>-guidelines-<date>.zip` → `guidelines/` with `Guidelines.md`, `foundations/`, `components/` | |
| X2 | `Guidelines.md` | Correct "N of M elements carry guidance"; reading-order links resolve | |
| X3 | A documented component file | Variants/properties table matches Figma; notes under the right sections | |
| X4 | Scoped notes (from §3) | Grouped under `When …` headings | |
| X5 | An **undocumented** element | Still exports its structure + explicit "no rules written yet" note | |
| X6 | Folder/section mirroring | `components/<page>/<section>` mirrors the Figma arrangement | |
| X7 | Drag into a Figma Make `guidelines/` folder | Make reads them; `Guidelines.md` routes to the rest | |

---

## §7 · Edge cases & resilience — P3

| ID | Steps | Expected | Result |
|----|-------|----------|--------|
| Z1 | Open the plugin on a **consuming** file (not the library) | Text styles etc. show 0 with the "open in the defining library" hint | |
| Z2 | Very large / 600-icon page | Components list loads (once), stays responsive | |
| Z3 | Collection/folder name with `&` or `/` | Slugs/paths in export stay valid; no broken files | |
| Z4 | Resize the plugin window | Layout holds; no clipped controls | |
| Z5 | Notes with markdown/emoji/very long text | Render and export without breaking the tables | |

---

## Findings

### F-1 — variant-scoped notes lost their scope · **ROOT-CAUSED + FIXED (draft path)**
- **Root cause (fixed):** the **Claude-draft path never carried the viewer scope** — the
  "Writing about …" selector only stamped *hand-typed* notes. `DraftNote`/`appendDrafts`/
  `applyDrafts` had no scope field and `askClaude` passed only a string label. Fix lifts the
  active scope from the viewer (`Detail.onScope`), carries it on the draft request keyed by
  request id (`App` `draftScopeRef`), stamps it on each streamed draft, and stores it — so an
  approved suggestion now lands under `When Type = Primary`. Covered by 6 new checks in
  `test/selftest.ts` (**506** total). The async draft wiring still needs a Figma smoke test.
- **Hand-typed path:** verified correct in isolation (repro) — a typed scoped note always
  exported under its `When …` heading. Notes stored *before* this fix stay unscoped and must
  be re-added.
- **Seen:** the attached `printstopds-guidelines-2026-08-28.zip` → `button.md` shows
  `## When to use\n- This variant should be used only once per page` with **no** scope
  heading, although the note was authored while "Writing about Type = Primary" was active.
- **Analysis:** storage (`storage.ts:204`), the handler (`code.ts:325`) and the renderer
  (`render.ts:294`, emits `When <scope>`) all support scope, and the viewer clearly computed
  `{Type: Primary}`. So the stored note had **empty** scope → it was most likely sent in an
  earlier submit *before* `Type` was ticked. Test **S2/S6** settles it definitively.
- **If S6 fails with scope ticked:** submit-time scope loss — fix in `Detail.tsx submit`.
  **If S6 passes:** no code bug; consider a UX guard so a scope-dependent note ("This
  variant…") isn't silently saved unscoped.

### Fixed this session (regression-test in §4 / §1c)
- Detail pane stuck on "Loading…" — restored the `getEntity` loader effect (§4).
- No Windows launcher / plugin pointed Windows users at a `.command` file — added `.cmd` +
  login task, made "Start it" OS-aware (§1c).

---

## Sign-off
| Area | Owner | Date | Verdict |
|------|-------|------|---------|
| §0 Automated | (ran) | 2026-08-28 | ✅ |
| §1 Install/bridge (Mac) | | | |
| §1c Windows | | | |
| §2 Authoring | | | |
| §3 Viewer/scoping | | | |
| §4 Loader fix | | | |
| §5 AI drafting | | | |
| §6 Export | | | |
