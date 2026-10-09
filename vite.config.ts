import { defineConfig } from 'vite'
import { execFileSync } from 'node:child_process'
import { devtoolsBuild } from './scripts/dev-gate.ts'
import { CDN, cdnBase, publicHash } from './scripts/static-cdn-base.ts'

const SERVER_PORT = Number(process.env.AP_SERVER_PORT ?? 8787)
// Static CDN (see scripts/static-cdn-base.ts): HTML stays on the origin, everything else loads from the CDN.
const CDN_BASE = cdnBase()
// Short commit of the working tree, shown by window.__ap.v1.info() (dev tooling only; unused code is dropped from production).
const COMMIT = (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return 'unknown' }
})()
const PUBLIC_BASE = CDN_BASE ? `${CDN_BASE}${CDN.publicDir}${publicHash('public')}/` : null

export default defineConfig(({ command, mode }) => ({
  root: '.',
  publicDir: 'public',
  // __AP_DEVTOOLS__ (src/client/devtools-flag.ts): developer tooling exists only in `vite` and `vite build --mode devtools`.
  define: { __AP_PUBLIC_BASE__: JSON.stringify(PUBLIC_BASE), __AP_DEVTOOLS__: JSON.stringify(devtoolsBuild(command, mode)), __AP_COMMIT__: JSON.stringify(COMMIT) },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
      '/api': { target: `http://localhost:${SERVER_PORT}` },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  experimental: CDN_BASE && PUBLIC_BASE
    ? { renderBuiltUrl: (file, { type }) => (type === 'public' ? PUBLIC_BASE : CDN_BASE) + file.replace(/^\//, '') }
    : {},
}))
