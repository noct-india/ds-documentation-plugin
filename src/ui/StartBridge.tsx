// How to start the bridge, from inside the plugin.
//
// This cannot be a button that starts it. A Figma plugin runs in a sandboxed
// iframe with no filesystem and no way to launch a process — and it cannot even
// find out where its own folder is, so it could not name the launcher either.
//
// What it can do is remember. The bridge reports its own directory when it
// connects, so after the first successful connection the plugin knows exactly
// where the launcher lives on *this* machine, and can say so once the bridge is
// off. That path is discovered, never hardcoded, which is what keeps this
// correct for anyone who unzips the folder somewhere else.
//
// It also cannot be one instruction for everyone: the launcher is a different
// file on Windows (.cmd) than on a Mac (.command). The machine's OS is worked
// out from the reported path when there is one — a backslash or a drive letter
// is unambiguous — and from the browser's own platform string before the first
// connection, so a Windows designer is never told to double-click a file that
// isn't there.

import { useState } from 'react'

interface Props {
  /** Bridge folder from a previous connection, if there has been one. */
  home: string | null
  onClose: () => void
}

/** Windows, as far as we can tell — for choosing which launcher to name. */
function isWindows(home: string | null): boolean {
  // A reported path is definitive: only Windows paths carry a drive letter or
  // a backslash. It also describes the right machine, because the bridge that
  // reported it was running on this one.
  if (home) return /^[a-zA-Z]:[\\/]/.test(home) || home.includes('\\')
  // No connection yet, so fall back to what the iframe can see about itself.
  const nav = typeof navigator === 'undefined' ? null : navigator
  const platform = (nav?.platform ?? '').toLowerCase()
  const agent = (nav?.userAgent ?? '').toLowerCase()
  return platform.startsWith('win') || agent.includes('windows')
}

/** The launcher's file name for this OS. */
function launcherName(win: boolean): string {
  return win ? 'Start Claude bridge.cmd' : 'Start Claude bridge.command'
}

/** The always-on toggle's file name for this OS. */
function loginName(win: boolean): string {
  return win ? 'Run bridge at login.cmd' : 'Run bridge at login.command'
}

/** The launcher, as a full path to double-click. */
function launcher(home: string, win: boolean): string {
  const sep = win ? '\\' : '/'
  return `${home}${sep}${launcherName(win)}`
}

/** Portable equivalent, for anyone who would rather use a terminal. */
function command(home: string, win: boolean): string {
  return win ? `cd /d "${home}" && node server.mjs` : `cd "${home}" && node server.mjs`
}

/**
 * Copies without the Clipboard API.
 *
 * `navigator.clipboard` is unreliable inside the plugin iframe — it is a
 * permissioned API and the iframe's origin is null. The textarea trick has no
 * such requirement and works in both the desktop app and the browser.
 */
function copy(text: string): boolean {
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(field)
  return ok
}

export function StartBridge({ home, onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null)
  const win = isWindows(home)

  const handleCopy = (text: string, label: string) => {
    if (copy(text)) {
      setCopied(label)
      setTimeout(() => setCopied(null), 2000)
    }
  }

  return (
    <div className="starter">
      <div className="starter-head">
        <strong>Start the bridge</strong>
        <button className="starter-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      {home ? (
        <>
          <p className="starter-line">Double-click this file:</p>
          <div className="starter-path" title={launcher(home, win)}>
            {launcher(home, win)}
          </div>
          <div className="starter-actions">
            <button className="btn" onClick={() => handleCopy(launcher(home, win), 'path')}>
              {copied === 'path' ? 'Copied' : 'Copy path'}
            </button>
            <button className="btn" onClick={() => handleCopy(command(home, win), 'command')}>
              {copied === 'command' ? 'Copied' : 'Copy terminal command'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="starter-line">
            In the plugin folder you unzipped, open <code>bridge</code> and double-click{' '}
            <strong>{launcherName(win)}</strong>.
          </p>
          <p className="starter-line dim">
            Once it has connected the first time, this panel will show you the exact path.
          </p>
        </>
      )}

      <p className="starter-line dim">
        Tired of starting it? Double-click <strong>{loginName(win)}</strong> once and the
        bridge starts with every login.
      </p>

      <p className="starter-line dim">
        The plugin reconnects on its own — leave it open, no need to reopen anything. Figma
        plugins can't launch programs, which is why this is a pointer rather than a button.
      </p>
    </div>
  )
}
