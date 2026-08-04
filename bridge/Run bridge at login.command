#!/bin/bash
# Double-click to make the bridge start at login — or, if it already does, to
# stop it doing so. The same file both ways round, so there is one thing to find.
#
# An idle bridge costs nothing: it only spawns `claude` when the plugin actually
# asks for drafts. That is what makes always-on reasonable rather than wasteful.
#
# Everything here is written at install time from this file's own location, so
# the plist is correct on whichever machine unzipped the folder.

set -u

LABEL="in.noct.dsdoc-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/dsdoc-bridge.log"

# ─── Locate ourselves ────────────────────────────────────────────────────────
# Deliberately duplicated from the launcher rather than shared: each file has to
# survive being the only one someone copied somewhere.
target="${BASH_SOURCE[0]}"
while [ -L "$target" ]; do
  dir="$(cd -P "$(dirname "$target")" && pwd)"
  target="$(readlink "$target")"
  [[ "$target" != /* ]] && target="$dir/$target"
done
HERE="$(cd -P "$(dirname "$target")" && pwd)"
cd "$HERE" || exit 1

printf '\033]0;Claude bridge — login item\007'

pause_and_exit() {
  echo
  [ -t 0 ] && read -r -p "Press return to close… " _
  exit "${1:-0}"
}

if [ ! -f "server.mjs" ]; then
  echo "Can't find server.mjs next to this file."
  echo "Expected it in: $HERE"
  pause_and_exit 1
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
command -v fnm >/dev/null 2>&1 && eval "$(fnm env 2>/dev/null)"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node isn't installed, or isn't on the PATH this window can see."
  echo "Install it from https://nodejs.org, then try again."
  pause_and_exit 1
fi

# ─── Already installed? Then this is the off switch ──────────────────────────
if [ -f "$PLIST" ]; then
  echo "The bridge currently starts at login."
  echo "  definition: $PLIST"
  echo "  log:        $LOG"
  echo
  if [ ! -t 0 ]; then
    echo "Run this from Finder to turn it off."
    exit 0
  fi
  read -r -p "Stop starting it at login? [y/N] " answer
  case "$answer" in
    [Yy]*) ;;
    *)
      echo "Left as it is."
      pause_and_exit 0
      ;;
  esac

  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null ||
    launchctl unload -w "$PLIST" 2>/dev/null
  # Kept, not deleted — renaming is enough, because launchd only ever reads
  # files ending in .plist. Reinstalling overwrites it anyway.
  mv "$PLIST" "$PLIST.removed"
  echo
  echo "Done. The bridge no longer starts at login, and is not running now."
  echo "Start it by hand any time with 'Start Claude bridge.command'."
  pause_and_exit 0
fi

# ─── Install ─────────────────────────────────────────────────────────────────
echo "This will start the Claude bridge automatically every time you log in,"
echo "and restart it if it ever stops."
echo
echo "  bridge: $HERE"
echo "  node:   $NODE"
echo "  log:    $LOG"
echo
if [ -t 0 ]; then
  read -r -p "Set that up? [y/N] " answer
  case "$answer" in
    [Yy]*) ;;
    *)
      echo "Nothing changed."
      pause_and_exit 0
      ;;
  esac
  echo
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies first…"
  if ! npm install; then
    echo
    echo "Install failed — not setting up the login item."
    pause_and_exit 1
  fi
  echo
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# launchd hands a process almost no PATH, and the bridge spawns `claude` by
# name. Without this, everything works until the moment you ask for a draft.
AGENT_PATH="$(dirname "$NODE"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# A plist is XML, and a folder called "Brand & Identity" is entirely plausible.
# Unescaped it produces a file launchd silently refuses to load.
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
X_NODE="$(xml "$NODE")"
X_HERE="$(xml "$HERE")"
X_LOG="$(xml "$LOG")"
X_HOME="$(xml "$HOME")"
X_PATH="$(xml "$AGENT_PATH")"

cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$X_NODE</string>
    <string>$X_HERE/server.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$X_HERE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$X_PATH</string>
    <key>HOME</key>
    <string>$X_HOME</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$X_LOG</string>
  <key>StandardErrorPath</key>
  <string>$X_LOG</string>
</dict>
</plist>
PLIST_END

# A bridge already running by hand would hold the port and the agent would come
# up bound to nothing. Stop it first — the agent replaces it.
holder="$(lsof -nP -tiTCP:8473 -sTCP:LISTEN 2>/dev/null | head -1)"
if [ -n "$holder" ]; then
  echo "Stopping the bridge that's already running, so the login item can take over."
  kill "$holder" 2>/dev/null
  sleep 1
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  # Older macOS, or a system that still prefers the legacy verbs.
  if ! launchctl load -w "$PLIST" 2>/dev/null; then
    echo "Couldn't register the login item. The definition is written to:"
    echo "  $PLIST"
    pause_and_exit 1
  fi
fi

sleep 2
if lsof -nP -iTCP:8473 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Done — the bridge is running now and will start with every login."
  echo "The plugin should show 'Claude bridge connected' within a few seconds."
else
  echo "Registered, but nothing is listening on port 8473 yet."
  echo "Check the log for why: $LOG"
fi
echo
echo "To undo this, double-click this same file again."
pause_and_exit 0
