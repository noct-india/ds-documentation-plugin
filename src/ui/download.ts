// Zipping and downloading the export.
//
// This runs in the UI iframe, not the sandbox: the sandbox has no DOM, so it
// cannot create a Blob URL or click an anchor. One zip rather than many files
// also sidesteps Figma's cap on downloads per plugin run.

import JSZip from 'jszip'
import type { ExportFile } from '../shared/types'
import { slug } from '../shared/slug'

export async function downloadZip(fileName: string, files: ExportFile[]): Promise<string> {
  const zip = new JSZip()
  for (const file of files) zip.file(file.path, file.content)

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  const stamp = new Date().toISOString().slice(0, 10)
  const name = `${slug(fileName)}-guidelines-${stamp}.zip`

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoking immediately can cancel the download in some builds; give it a beat.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)

  return name
}
