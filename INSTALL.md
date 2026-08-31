# Design System Documentation — setup

A Figma plugin for writing down what a design system means: why a token exists, when to
reach for a component, what never to do. It exports that as markdown shaped for **Figma
Make**, so a Make kit builds on-system instead of guessing.

Takes about five minutes. The AI half is optional and comes later.

---

## 1 · Install the plugin

You need the **Figma desktop app** — the browser version cannot load a plugin that hasn't
been published.

1. Unzip this folder anywhere you like. Don't move the files around inside it.
2. In Figma: **Plugins → Development → Import plugin from manifest…**
3. Pick `manifest.json` from the unzipped folder.
4. Run it from **Plugins → Development → Design System Documentation**.

That's it. Everything except the AI features works now.

> Keep the folder somewhere permanent. Figma remembers the path, so deleting or moving it
> breaks the plugin until you re-import.

---

## 2 · What you can do straight away

Open the plugin on a design system file — the library itself, not a file that consumes it.

- **Browse** your variables, styles and components exactly as they're arranged in Figma:
  collections, `/` folder groups, pages and sections, in your order, with colour swatches
  and type samples.
- **Write notes** on anything: a variable, a style, a component, a folder, a whole
  collection, a page, a section, or the project. Type and press enter — it files itself
  into the right category.
- **Select components on canvas** and write one note across all of them at once.
- **Export** a `guidelines/` folder of markdown, mirroring your pages and sections.

### Where notes are stored

**Inside the Figma file itself.** They sync to everyone who opens it, and they travel with
the file. They are not on your machine and not in this folder.

That also means notes are per-file: two design systems keep separate documentation, which
is what you want.

### Nothing you type is discarded

Hiding a note keeps its wording. Rewording one keeps what it replaced. You can always see
the original in the notes list under the document.

> **Try it on a duplicate first.** The plugin writes into the Figma file, so point it at a
> copy before running it against a live library.

---

## 3 · The AI half (optional)

A local bridge lets Claude read your design system and draft documentation — one element,
a whole collection, or a page of 600 icons. It also tidies wording on request, and answers
questions like *"which components have no States documented?"*.

Everything runs on your own machine. Nothing is uploaded, and the bridge listens on
loopback only.

### What you need

- **Node.js 18+** — `node --version` to check
- **Claude Code**, logged in — `claude -p "reply ok"` should print `ok`

If that second command asks you to log in, run `claude` once on its own first.

### Set it up

**On a Mac, double-click `bridge/Start Claude bridge.command`.**
**On Windows, double-click `bridge\Start Claude bridge.cmd`.**
Either one installs what it needs on first run, checks nothing else is holding the port, and
starts the bridge. That is the whole setup — you never need to type any of this again. Leave
the window it opens running while you work.

Can't find it? Open the plugin and press **Start it** next to the status line at the bottom
of the sidebar. Once the bridge has connected once, that panel shows the exact path to the
launcher on your machine and will copy it for you.

**Tired of starting it at all?** Double-click the "run at login" file once and the bridge
starts on its own with every login — `bridge/Run bridge at login.command` on a Mac,
`bridge\Run bridge at login.cmd` on Windows. An idle bridge costs nothing — it only runs
Claude when you actually ask for drafts. Double-click the same file again to undo it.

On a Mac the login item also restarts the bridge immediately if it ever stops. On Windows it
starts at each login (and comes back the next time you log in if it ever stops) and runs with
no window; to bring it back right away without logging out, double-click
`Start Claude bridge.cmd`. Its log is at `%LOCALAPPDATA%\NOCT\dsdoc-bridge.log`.

If you'd rather use a terminal (any OS):

```bash
cd bridge
npm install
node server.mjs
```

Leave it running. You should see:

```
listening on 127.0.0.1:8473
listening on [::1]:8473
ready — `claude` CLI responded in 4258ms
```

The plugin's footer switches to **Claude bridge connected**. If the last line reports a
problem instead, drafting will refuse rather than hang, and it tells you what to fix.

### Using it

- **Draft _n_ with Claude** in the sidebar sends the level you're browsing.
- **Ask Claude** on the right sends one element, or a question.
- The send button's dropdown offers **Add and tidy up** and **Ask Claude**.
- **Activity** in the nav shows everything in flight and everything waiting for approval.

**Suggestions arrive as drafts.** They don't count as documented and are excluded from the
export until you keep them. That's deliberate: an unreviewed guess would be followed by
Figma Make exactly as faithfully as a rule you wrote yourself.

### Worth writing first

**About this project**, the first item in the nav. A few lines on what the product is, who
uses it, and how it should feel. It goes into every draft request, and it's the difference
between generic design advice and advice about *your* product.

Then document a collection or two by hand. Every element inherits the rules of the
collection and folders above it, so a little context at the top improves everything below.

---

## 4 · Exporting to Figma Make

**Export** produces `<file-name>-guidelines-<date>.zip`. Unzip it and you get:

```
guidelines/
  Guidelines.md          the entry point Make reads first
  foundations/           one file per collection, plus the style groups
  components/            mirrors your pages and sections
```

In a Figma Make file, open the `guidelines/` folder and drag the `.md` files in. Recreate
the subfolders to match. `Guidelines.md` routes Make to the rest.

Elements you haven't documented still export their structure — variants, properties,
values — with an explicit note that no rules were written, so Make knows the difference
between *"no constraint"* and *"nobody has said yet"*.

---

## Troubleshooting

**Plugin missing after a restart** — the folder moved or was deleted. Re-import the
manifest.

**"Claude bridge off"** — the bridge isn't running. Double-click
`bridge/Start Claude bridge.command` (Mac) or `bridge\Start Claude bridge.cmd` (Windows), or
run `cd bridge && node server.mjs` in a terminal.

**"port 8473 is already in use"** — a bridge is already running somewhere. The launcher
spots this, names the process and offers to stop it. By hand on a Mac:
`lsof -nP -iTCP:8473 -sTCP:LISTEN` then `kill <pid>`. On Windows:
`netstat -ano | findstr :8473` then `taskkill /PID <pid> /F`.

**Double-clicking the launcher does nothing, or opens a text editor** — on a Mac the
executable bit was lost, which some unzip tools do; fix it once with
`chmod +x "bridge/Start Claude bridge.command"`. On Windows, right-click
`Start Claude bridge.cmd` and choose **Run** (or **Open**); if SmartScreen warns about an
unrecognised script, choose **More info**, then **Run anyway** — it is the local file you
just unzipped, nothing is downloaded.

**Drafting fails with a 401** — the Claude CLI login has expired. Run `claude` once
interactively. Alternatively `export ANTHROPIC_API_KEY=...` before starting the bridge and
it skips the CLI entirely.

**Text styles show 0** — the plugin documents *local* styles. Open it in the library that
defines them, not a file that uses them.

**Components takes a moment to open** — it loads every page once to find which hold
components, so archives and test pages stay out of the list. Cached after that.
