// Vite plugin that serves the editor's write-back endpoint (scripts/dev-api.ts) in `vite` (serve) only: it does not
// exist in `vite build`, so neither the production nor the devtools bundle has it. It also injects the per-boot token
// into the page and keeps the editor's own writes from reloading the page.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Plugin } from 'vite'
import { createDevApi } from './dev-api.ts'

interface EditorFile {
  files: string[]
  endpoint: { path: string; tokenHeader: string; tokenMeta: string; maxBodyBytes: number; maxOps: number; validateTimeoutMs: number }
}

/** Own writes are recognised for this long after they happened (the file watcher reports them a moment later). */
const OWN_WRITE_MS = 4000

export function devApiPlugin(): Plugin {
  const token = randomBytes(24).toString('hex')
  let root = process.cwd()
  let cfg: EditorFile
  const written = new Map<string, number>()
  return {
    name: 'ap-dev-api',
    apply: 'serve',
    configResolved(c) {
      root = c.root
      cfg = JSON.parse(readFileSync(join(root, 'content/dev/editor.json'), 'utf8')) as EditorFile
    },
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: cfg.endpoint.tokenMeta, content: token }, injectTo: 'head' }],
    configureServer(server) {
      server.middlewares.use(createDevApi({
        root, token, files: cfg.files, path: cfg.endpoint.path, tokenHeader: cfg.endpoint.tokenHeader,
        maxBodyBytes: cfg.endpoint.maxBodyBytes, maxOps: cfg.endpoint.maxOps, validateTimeoutMs: cfg.endpoint.validateTimeoutMs,
        onWrite: (file) => { written.set(join(root, file), Date.now()) },
      }))
    },
    handleHotUpdate({ file, server }) {
      const at = written.get(file)
      if (at === undefined || Date.now() - at > OWN_WRITE_MS) return
      // The editor already shows what it wrote: tell the page, skip the full reload. A manual reload reads the new JSON.
      server.ws.send({ type: 'custom', event: 'ap:content-updated', data: { file: relative(root, file) } })
      return []
    },
  }
}
