# Session — 2026-08-29

DS Documentation (v2) Figma plugin — bug fixes, variant-scope, Windows support,
persistent scope strip, and a new edit-history + undo subsystem.

All work is **uncommitted** on `main` (see Files below). The source files are saved to
disk (Drive-synced); "saved" here means this log, not a git commit.

---

## What was done

1. **Detail pane "Loading…" hang — fixed.** Commit `9c82c5e` had deleted the `getEntity`
   loader effect; restored it in `src/ui/screens/Detail.tsx`. (Root-caused via git history.)

2. **Windows bridge support — added.** The bridge only had macOS `.command` launchers.
   Added `bridge/Start Claude bridge.cmd`, `bridge/Run bridge at login.cmd` (registers a
   logon Scheduled Task `NOCT DS Bridge`), and `bridge/run-hidden.vbs` (windowless start).
   Made the in-plugin "Start it" panel OS-aware (`StartBridge.tsx`). Ship list in
   `package.mjs` updated; `.node-path` gitignored. **Needs a real Windows smoke test.**

3. **Variant scope not showing — fixed (two real bugs).**
   - **Renderer:** `renderEntityDoc` (the preview + export renderer) grouped by section only
     and ignored scope entirely. Fixed to emit `## When Type = Primary` blocks, matching
     `renderAuthoredSections`. This was THE bug; storage was correct all along, so it is
     **retroactive** — existing scoped notes render correctly after reload.
   - **Draft path:** Claude drafts never carried the viewer scope (`askClaude` passed only a
     string label; `DraftNote`/`appendDrafts`/`applyDrafts` had no scope field). Threaded the
     active viewer scope from `Detail.onScope` → `App` (`draftScopeRef`, keyed by request id)
     → stamped on each streamed draft → stored. Approved drafts now land scoped.
   - Earlier mistake: my first repro tested `renderAuthoredSections` (wrong function), which
     is why I wrongly cleared the renderer. Tests now assert through `renderEntityDoc`.

4. **Pinned-body markdown — left untouched (reverted).** A component with a hand-edited body
   ("Edit markdown") shows it verbatim and skips the scope renderer — that is why Button
   failed but a fresh component worked. Fix for the user: **Edit markdown → "Rebuild from
   notes"**. I briefly injected `When …` headings into pinned bodies on new notes;
   **reverted** per user — do not corrupt hand-edited markdown.

5. **Persistent "Writing about" strip — added.** A pinned band above the composer
   (`.composer-scope` in `Detail.tsx` + `styles.css`) so the active scope stays visible
   while typing.

6. **Edit history + vector undo — new subsystem (backend tested, UI unverified).**
   - New `src/main/history.ts`: a **separate document-level store** (`dsdoc.history` on
     `figma.root`), isolated from notes and markdown. Each entry carries `before`/`after`
     patches. Uniform reversal: undo applies `before`, redo applies `after`.
   - Recording wired into all six note ops in `code.ts` (add / edit / delete / approve /
     reject / recategorize).
   - RPC: `getHistory`, `historyUndo{id,direction}`, `historyUndoAll{entityId?}`.
   - UI: global **History tab** in `Activity.tsx` + per-component **Edit history** section in
     `Detail.tsx`, via new `src/ui/HistoryList.tsx`. Undo/redo per row + "Undo all → clean
     slate".
   - `storage.ts` gained generic `readChunkedValue`/`writeChunkedValue` (for the separate
     store) and `patchNote` (the reversal primitive).
   - Engine proven headlessly: `npm run test:history` (added to `package.json`).

**Verification:** typecheck clean; `npm test` = 510 checks; `npm run test:history`,
`test:bridge`, `test:refs` all green; build + package clean. The **UI is not visually
verified** (cannot run the Figma plugin from here).

---

## Decisions

- **Undo model = per-edit vector revert** (user-chosen), in a **separate store, never the
  markdown** (user constraint). Current implementation is *pragmatic*: undoing an older edit
  on a note sets the note back to that entry's `before` value (a newer edit is lost until
  redone). See the open item below — the user wants true independence.
- Pinned/hand-edited bodies are manual; scope grouping only applies to auto-generated bodies.
  "Rebuild from notes" regenerates scope-aware. Never auto-edit a pinned body's markdown.
- Windows login item = logon Scheduled Task (starts at login), not a launchd-style supervisor
  (no mid-session crash-restart). Acceptable for an idle bridge.

---

## Open items / next session

- **★ TOP — full operational-transform undo (user explicitly requested "i need this
  approach").** Replace the pragmatic reversal in `history.ts` with true per-op independence:
  undoing an *older* edit on a note must PRESERVE later edits on that same note, not revert to
  the old `before` value. Design: model each note's history as an ordered op list and
  recompute the note's current value by replaying the still-live ops (skip undone ones),
  rather than blindly applying one entry's `before`. Applies to `edit` (text) and
  `recategorize` (section) — the fields where multiple ops stack on one note; `add`/`delete`/
  `approve`/`reject` are already independent. Keep the same store + UI; change only the
  reversal computation. Add tests: two stacked edits on one note, undo the first, assert the
  second survives.
- **Figma smoke test of all UI** (cannot verify here): History tab, per-component Edit
  history, undo/redo/undo-all, the persistent scope strip, and the scope grouping on Button
  after "Rebuild from notes".
- **Windows smoke test** of the `.cmd`/`.vbs` launchers + logon task on a real Windows box.
- **Commit** everything (loader fix, Windows launchers, scope render + draft-scope, strip,
  history subsystem) on a branch with a clear history — offered, not yet done.

## Files touched (uncommitted on `main`)
```
NEW  src/main/history.ts                     history store + vector undo engine
NEW  src/ui/HistoryList.tsx                   shared history list UI
NEW  test/history.ts                          history engine test (npm run test:history)
NEW  bridge/Start Claude bridge.cmd           Windows manual launcher
NEW  bridge/Run bridge at login.cmd           Windows logon-task toggle
NEW  bridge/run-hidden.vbs                    windowless bridge start
NEW  docs/                                    this log + TEST-PLAN.md
 M   src/main/code.ts                         history recording + RPC; (loader unrelated)
 M   src/main/export/render.ts                renderEntityDoc scope grouping (the real fix)
 M   src/main/storage.ts                      chunked-value helpers, patchNote, appendDrafts scope
 M   src/shared/types.ts                      DraftNote.scope, HistoryEntry, history RPC
 M   src/ui/App.tsx                            history state/wiring, draft-scope tracking
 M   src/ui/screens/Detail.tsx                loader fix, onScope, scope strip, per-comp history
 M   src/ui/screens/Activity.tsx              History tab
 M   src/ui/StartBridge.tsx                   OS-aware launcher naming
 M   src/ui/styles.css                        .composer-scope + .history styles
 M   test/selftest.ts                         scope-through-renderEntityDoc coverage (510)
 M   package.json / package.mjs               test:history; ship Windows files
 M   .gitignore / INSTALL.md / README.md / bridge/README.md   Windows docs
```

---

# Update — right-pane redesign + status bar + per-item Reset (same day, 2026-08-29)

Still uncommitted on `main`. Backend typechecks + tests green (510 selftest, history
engine, build, package). **The whole right-pane layout + status bar are UNVERIFIED
visually** — needs a Figma smoke test.

## What was done

1. **Right pane → tabs.** `Detail.tsx` rewritten from a stack into tabs: **Variants**
   (components only) · **Markup** · **History** · **AI drafts**. The composer is fixed at the
   bottom across all tabs. Default landing tab = Markup; Variants leftmost. The per-note
   edit/hide/move list folds into the Markup tab. "Ask Claude" left the header and became the
   AI-drafts tab's empty-state button (new `onDraft` prop; `App` head button removed).

2. **Single "Writing about" strip.** Deleted the ComponentViewer's duplicate strip (and its
   now-dead scope computations + `describeScope`/`scopeReach` imports); kept the one on the
   composer and moved the reach count onto it. `.viewer-scope` CSS is now dead but harmless.

3. **Per-item Reset** (Markup tab, inline confirm). New `clearEntity` RPC →
   `clearAllEntityData(host)` sweeps every `dsdoc.*` key on the node (incl. stale ones from
   earlier builds) via `getPluginDataKeys`, `clearHistoryFor(root, entityId)` drops its
   history, index reset to 0. Decision: **this-item clean slate**, not whole-file.

4. **Unified status bar** (`Sidebar`). Bridge connected = green dot; other activity
   (`onProgress` "Reading pages…", was a toast) = blue-dot row via a new `status` prop on
   `App`→`Sidebar`. Disconnected state kept as "Claude bridge off · Start it" (decision).

## New / changed
```
NEW  src/main/history.ts        + clearHistoryFor
 M   src/main/storage.ts        + clearAllEntityData, getPluginDataKeys? on PluginDataHost
 M   src/main/code.ts           + clearEntity handler
 M   src/shared/types.ts        + clearEntity request/response
 M   src/ui/screens/Detail.tsx  tabbed layout, Reset control, single scope strip w/ reach
 M   src/ui/ComponentViewer.tsx removed the duplicate viewer-scope strip
 M   src/ui/screens/Activity.tsx (History tab from earlier)
 M   src/ui/App.tsx             status state, onDraft, header button removed, Sidebar status
 M   src/ui/Sidebar.tsx         busy status row (blue dot)
 M   src/ui/HistoryList.tsx     container class .history → .editlog (CSS collision)
 M   src/ui/styles.css          .detail-tabs/.detail-tab, .reset-confirm, .btn.danger, busy dot
```

## Open items / next session (unchanged priority)
- **★ TOP — full operational-transform undo** (user: "i need this approach"). See the first
  block's open items for the design. Still the headline task.
- **Figma smoke test** of: the four tabs + fixed composer, Reset's confirm + clean-slate,
  the single Writing-about strip, and the status bar's green/blue dots.
- **Commit** everything on a branch with a clear history.
