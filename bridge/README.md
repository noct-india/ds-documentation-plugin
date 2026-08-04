# Claude bridge

Lets Claude read a design system out of the Figma plugin and send documentation back.

Documenting 200 components, 150 variables and 50 styles by hand is the real cost of this
plugin. The bridge turns that into reviewing drafts, which is several times faster than
authoring from scratch.

## What it is

One Node process wearing two faces:

```
Claude  ──MCP over stdio──▶  bridge  ◀──WebSocket (127.0.0.1)──  Figma plugin
```

The plugin cannot talk to Claude and Claude cannot talk to the plugin, so this sits in the
middle holding requests and drafts. Nothing is written to disk and nothing leaves the
machine — the WebSocket binds to loopback only, and state lives just as long as the process.

It listens on **both** `127.0.0.1` and `[::1]`. `localhost` resolves to IPv6 on macOS and
IPv4 elsewhere, and there is no saying which one Figma's iframe will pick; binding one
family leaves a failure that looks exactly like "the bridge isn't running".

The manifest must name the **hostname**, not an IP — Figma's validator rejects
`ws://127.0.0.1:8473` with *"must be a valid URL"* but accepts `ws://localhost:8473`.

## Setup

```bash
cd bridge
npm install
```

Then register it with Claude. In **Claude Desktop**, add to
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ds-documentation": {
      "command": "node",
      "args": ["/absolute/path/to/DS documentation plugin/bridge/server.mjs"]
    }
  }
}
```

In **Claude Code**:

```bash
claude mcp add ds-documentation -- node "/absolute/path/to/DS documentation plugin/bridge/server.mjs"
```

Claude starts the process; there is nothing to run by hand. The plugin finds it on
`ws://localhost:8473` and reconnects on its own, so restarting Claude is harmless. Set
`DSDOC_BRIDGE_PORT` to move it, and change `manifest.json` to match.

### Or start it yourself

Registering it with Claude is optional — the bridge spawns `claude -p` itself when a
request arrives, so drafting works with nothing but the process running.

Double-click **`Start Claude bridge.command`**, or `node server.mjs`. The launcher exists
because a bridge owned by a chat session dies with that session and can leave the port
held; one you started yourself is one you can see and stop. It finds `node` even when
Finder hands it a bare PATH, installs dependencies on first run, and names whatever is
already holding the port rather than failing quietly.

### Or never think about it again

`Run bridge at login.command` registers a launchd agent (`in.noct.dsdoc-bridge`) with
`RunAtLoad` and `KeepAlive`, so the bridge is up from login and comes back if it stops.
Double-clicking the same file removes it again.

Two details do the real work. The agent's `PATH` is written at install time and includes
the directory holding `claude` — launchd hands a process almost nothing, and without this
the bridge would run perfectly until the first draft request. And the plist is written with
its paths XML-escaped, because a design system living in a folder called `Brand & Identity`
is entirely plausible and an unescaped `&` produces a file launchd silently refuses.

Logs go to `~/Library/Logs/dsdoc-bridge.log`. The launcher detects the agent and declines
to fight it — killing a `KeepAlive` process just makes launchd restart it.

The plugin's **Start it** button points at that file. It cannot run it: a Figma plugin has
no filesystem access and cannot spawn a process, and it does not even know where its own
folder is. So the bridge tells it — `ready` carries this directory, the plugin keeps it in
`clientStorage`, and shows it once the bridge is off. The path is therefore discovered on
each machine rather than baked in, which is what lets the folder be zipped and passed on.

## Using it

1. Open the plugin in Figma. The footer reads **Claude bridge connected**.
2. Navigate to a collection, style group or component section.
3. **Draft _n_ with Claude** sends that level; **Ask Claude** on the right sends one item.
4. In Claude: *"check the documentation plugin and draft notes for what's pending."*
5. Suggestions arrive in the plugin as drafts to approve, edit or reject.

Claude sees the element's structure, its siblings, the whole component catalogue, your
project guidelines, and — for 25 items or fewer — **a PNG of each component**. That last
part matters: density, shape and hierarchy are not inferable from a property table.

## Tools Claude gets

| Tool | Does |
|---|---|
| `figma_docs_status` | Is a plugin connected, and what is pending |
| `figma_docs_get_items` | Read a request, paginated; `withImages` for pages of ≤10 |
| `figma_docs_submit_drafts` | Send drafts back, in batches |

## Drafts are drafts

Suggestions arrive flagged. Until a human approves one it does **not** count toward
coverage and is **excluded from the export** — an unreviewed guess must never reach Figma
Make, which would follow an invented constraint as faithfully as a real one. Approving is
recorded as an edit by the approver, because that is the moment a person takes
responsibility for the claim.

Two safeguards worth knowing:

- Drafts naming an `entityId` that was not part of the request are **rejected**, so a
  mistyped id cannot document something the designer never asked about.
- Cancelling a request in the plugin makes later submissions for it fail loudly.

## Checking it works

```bash
node e2e.mjs
```

Drives the real server over both faces at once — a fake plugin on the WebSocket and MCP
JSON-RPC on stdio — and verifies the whole round trip without Figma. Uses port 8479, so a
running bridge is left alone.
