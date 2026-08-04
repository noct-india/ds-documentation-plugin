// Builds the folder a colleague can unzip and import.
//
// Ships only what Figma and the bridge actually need: the manifest, the built
// output, the bridge source, and the setup guide. No src/, no test/, no
// node_modules — recipients run `npm install` themselves, and a 42 MB folder of
// dependencies is not something to hand round.
//
//   npm run package

import { cp, mkdir, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))
const p = (...parts) => resolve(root, ...parts)

const NAME = 'DS-Documentation-Plugin'
const OUT = p('package', NAME)

/** Everything a recipient needs, and nothing else. */
const INCLUDE = [
  'manifest.json',
  'INSTALL.md',
  'dist/code.js',
  'dist/ui.html',
  'bridge/server.mjs',
  'bridge/draft.mjs',
  'bridge/session.mjs',
  'bridge/e2e.mjs',
  'bridge/package.json',
  'bridge/README.md',
  // Double-clickable launchers. `cp` carries the mode across and `zip` preserves
  // it, so they arrive executable rather than as text files nobody can run.
  'bridge/Start Claude bridge.command',
  'bridge/Run bridge at login.command',
]

async function bytes(path) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

// A stale dist/ would ship silently, so always rebuild first.
console.log('  building…')
const build = spawnSync('node', [p('build.mjs')], { encoding: 'utf8' })
if (build.status !== 0) {
  console.error('  ✗ build failed — not packaging')
  console.error(build.stdout, build.stderr)
  process.exit(1)
}

await rm(p('package'), { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

for (const file of INCLUDE) {
  const from = p(file)
  if ((await bytes(from)) === 0 && !file.endsWith('.md')) {
    console.error(`  ✗ missing or empty: ${file}`)
    process.exit(1)
  }
  const to = join(OUT, file)
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to)
}

// The manifest travels as-is, but a placeholder id is worth flagging: Figma
// issues a real one when a plugin is published, and this is not one.
const manifest = JSON.parse(await readFile(p('manifest.json'), 'utf8'))
if (!/^\d{6,}$/.test(String(manifest.id))) {
  console.log(`  note: manifest id is "${manifest.id}" — fine for sideloading,`)
  console.log('        but Figma issues a real id if you ever publish.')
}

await writeFile(
  join(OUT, 'READ-ME-FIRST.txt'),
  [
    'Design System Documentation — Figma plugin',
    '',
    'Open INSTALL.md for setup (5 minutes).',
    '',
    'Short version:',
    '  1. Keep this folder somewhere permanent.',
    '  2. Figma desktop app → Plugins → Development → Import plugin from manifest…',
    '  3. Choose manifest.json from this folder.',
    '',
    'The AI features are optional and set up separately — see INSTALL.md section 3.',
    '',
  ].join('\n'),
  'utf8'
)

// zip is present on macOS and Linux; on Windows the folder can be sent as-is.
const zipPath = p('package', `${NAME}.zip`)
const zip = spawnSync('zip', ['-r', '-q', zipPath, NAME], { cwd: p('package') })

let total = 0
for (const file of INCLUDE) total += await bytes(join(OUT, file))

console.log(`\n  ✓ ${INCLUDE.length + 1} files · ${Math.round(total / 1024)} kb`)
console.log(`    folder: package/${NAME}/`)
if (zip.status === 0) {
  console.log(`    zip:    package/${NAME}.zip (${Math.round((await bytes(zipPath)) / 1024)} kb)`)
} else {
  console.log('    zip:    not created — `zip` unavailable; send the folder instead')
}

const stray = await readdir(OUT)
console.log(`    top level: ${stray.join(', ')}\n`)
