// HTTP: JSON API (/api/health, /api/leaderboard) + static file serving of the built client (dist/)
// with ETag/Last-Modified revalidation, immutable caching of hashed assets, brotli/gzip for text,
// byte ranges for binary media, traversal/symlink protection and SPA fallback.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { brotliCompress, gzip, constants as zc } from 'node:zlib'
import { promisify } from 'node:util'
import type { Stats } from 'node:fs'
import type { LeaderboardEntry } from '../shared/protocol.ts'
import { t } from '../shared/content/index.ts'
import { NET } from './config.ts'

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

export interface HttpApi {
  health(): Record<string, unknown>
  leaderboard(): LeaderboardEntry[]
}

export interface HttpOptions {
  /** Built client directory; may not exist (then only the API answers). */
  distDir: string
  /** Vite publicDir: files copied verbatim into dist (never content-hashed). */
  publicDir: string
  api: HttpApi
  log?: (msg: string) => void
}

type Encoding = 'br' | 'gzip'

/** Pick br/gzip from an Accept-Encoding header honouring q-values (q=0 = refused). */
export function negotiateEncoding(header: string | undefined): Encoding | null {
  if (!header) return null
  const q: Record<string, number> = {}
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (!name) continue
    let weight = 1
    for (const p of params) {
      const m = /^\s*q=([0-9.]+)\s*$/.exec(p)
      if (m) weight = Number(m[1])
    }
    q[name] = Number.isFinite(weight) ? weight : 0
  }
  const pick = (e: Encoding) => q[e] ?? (q['*'] !== undefined ? q['*'] : 0)
  const br = pick('br'), gz = pick('gzip')
  if (br > 0 && br >= gz) return 'br'
  if (gz > 0) return 'gzip'
  return null
}

function sendText(res: ServerResponse, status: number, text: string, head = false): void {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
  res.end(head ? undefined : body)
}

function sendJson(res: ServerResponse, status: number, data: unknown, head = false): void {
  const body = Buffer.from(JSON.stringify(data), 'utf8')
  res.writeHead(status, { 'Content-Type': NET.http.mime['.json'], 'Content-Length': body.length, 'Cache-Control': 'no-store' })
  res.end(head ? undefined : body)
}

export function createHttpHandler(opts: HttpOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const h = NET.http
  const log = opts.log ?? (() => {})
  const hashedRe = new RegExp(h.hashedAssetPattern)
  const hashedCache = new Map<string, boolean>()
  const compressed = new Map<string, Buffer>()
  const inflight = new Map<string, Promise<Buffer>>()
  let compressedBytes = 0
  let rootReal: string | null | undefined

  async function distRoot(): Promise<string | null> {
    // Re-resolve while missing so a build produced after startup is picked up.
    if (rootReal) return rootReal
    try { rootReal = await realpath(opts.distDir) } catch { rootReal = null }
    return rootReal
  }

  const isCompressible = (type: string) => h.compressible.some((p) => type.startsWith(p))

  function isHashed(rel: string): boolean {
    let v = hashedCache.get(rel)
    if (v === undefined) {
      v = hashedRe.test(basename(rel)) && !existsSync(join(opts.publicDir, rel))
      hashedCache.set(rel, v)
    }
    return v
  }

  function cacheControl(rel: string): string {
    const name = basename(rel)
    if (name === h.indexFile || h.noCacheFiles.includes(name)) return 'no-cache'
    if (isHashed(rel)) return `public, max-age=${h.immutableMaxAgeSeconds}, immutable`
    return `public, max-age=${h.defaultMaxAgeSeconds}`
  }

  async function compressedBody(file: string, st: Stats, enc: Encoding): Promise<Buffer> {
    const key = `${enc}|${st.size}|${st.mtimeMs}|${file}`
    const hit = compressed.get(key)
    if (hit) {
      compressed.delete(key)
      compressed.set(key, hit)
      return hit
    }
    let job = inflight.get(key)
    if (!job) {
      job = (async () => {
        const raw = await readFile(file)
        const out = enc === 'br'
          ? await brotliAsync(raw, { params: { [zc.BROTLI_PARAM_QUALITY]: h.brotliQuality, [zc.BROTLI_PARAM_SIZE_HINT]: raw.length } })
          : await gzipAsync(raw, { level: h.gzipLevel })
        if (out.length <= h.compressCacheBytes) {
          compressed.set(key, out)
          compressedBytes += out.length
          for (const [k, b] of compressed) {
            if (compressedBytes <= h.compressCacheBytes) break
            compressed.delete(k)
            compressedBytes -= b.length
          }
        }
        return out
      })().finally(() => inflight.delete(key))
      inflight.set(key, job)
    }
    return job
  }

  /** Resolve a URL path to a file inside dist (null = not found / not allowed). */
  async function resolveFile(root: string, pathname: string): Promise<{ file: string; rel: string; st: Stats } | null> {
    const parts = pathname.split('/').filter(Boolean)
    if (parts.some((p) => p === '..' || p.startsWith('.') || p.includes('\\'))) return null
    const tryPath = async (candidate: string) => {
      try {
        const real = await realpath(candidate)
        if (real !== root && !real.startsWith(root + sep)) return null
        let st = await stat(real)
        let file = real
        if (st.isDirectory()) {
          file = join(real, h.indexFile)
          st = await stat(file)
        }
        if (!st.isFile()) return null
        return { file, rel: relative(root, file).split(sep).join('/'), st }
      } catch {
        return null
      }
    }
    const direct = await tryPath(join(root, ...parts))
    if (direct) return direct
    // SPA fallback: extension-less paths are client routes; missing assets stay 404.
    const last = parts[parts.length - 1] ?? ''
    if (extname(last) === '') return tryPath(join(root, h.indexFile))
    return null
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, head: boolean): Promise<void> {
    const root = await distRoot()
    const found = root ? await resolveFile(root, pathname) : null
    if (!found) { sendText(res, 404, t('net.http.notFound'), head); return }
    const { file, rel, st } = found
    const type = h.mime[extname(file).toLowerCase()] ?? h.defaultMime
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
    const compressible = isCompressible(type) && st.size >= h.compressMinBytes
    res.setHeader('Content-Type', type)
    res.setHeader('ETag', etag)
    res.setHeader('Last-Modified', st.mtime.toUTCString())
    res.setHeader('Cache-Control', cacheControl(rel))
    if (compressible) res.setHeader('Vary', 'Accept-Encoding')
    else res.setHeader('Accept-Ranges', 'bytes')

    const inm = req.headers['if-none-match']
    const ims = req.headers['if-modified-since']
    const matchesTag = typeof inm === 'string' && inm.split(',').some((x) => {
      const v = x.trim()
      return v === '*' || v.replace(/^W\//, '') === etag.replace(/^W\//, '')
    })
    const notModifiedSince = !inm && typeof ims === 'string' && Math.floor(st.mtimeMs / 1000) <= Math.floor(Date.parse(ims) / 1000)
    if (matchesTag || notModifiedSince) { res.writeHead(304); res.end(); return }

    const enc = compressible ? negotiateEncoding(req.headers['accept-encoding']) : null
    if (enc) {
      const body = await compressedBody(file, st, enc)
      res.writeHead(200, { 'Content-Encoding': enc, 'Content-Length': body.length })
      res.end(head ? undefined : body)
      return
    }

    let start = 0, end = st.size - 1, status = 200
    const range = !compressible ? req.headers.range : undefined
    if (typeof range === 'string' && st.size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])) } else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])) }
        if (start > end || start >= st.size) {
          res.setHeader('Content-Range', `bytes */${st.size}`)
          sendText(res, 416, t('net.http.rangeNotSatisfiable'), head)
          return
        }
        status = 206
        res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`)
      }
    }
    res.writeHead(status, { 'Content-Length': st.size === 0 ? 0 : end - start + 1 })
    if (head || st.size === 0) { res.end(); return }
    const stream = createReadStream(file, { start, end })
    stream.on('error', (err) => { log(`static read failed ${rel}: ${err.message}`); res.destroy(err) })
    stream.pipe(res)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const head = method === 'HEAD'
    res.setHeader('X-Content-Type-Options', 'nosniff')
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      sendText(res, 400, t('net.http.badRequest'), head)
      return
    }
    if (pathname.includes('\0')) { sendText(res, 400, t('net.http.badRequest'), head); return }
    const isApi = pathname.startsWith(h.apiPrefix) || pathname === h.apiPrefix.replace(/\/$/, '')
    if (method !== 'GET' && !head) {
      res.setHeader('Allow', 'GET, HEAD')
      if (isApi) sendJson(res, 405, { error: 'method_not_allowed', message: t('net.http.methodNotAllowed') })
      else sendText(res, 405, t('net.http.methodNotAllowed'))
      return
    }
    if (pathname === h.healthPath) { sendJson(res, 200, opts.api.health(), head); return }
    if (pathname === h.leaderboardPath) { sendJson(res, 200, { entries: opts.api.leaderboard() }, head); return }
    if (isApi) { sendJson(res, 404, { error: 'not_found', message: t('net.http.notFound') }, head); return }
    await serveStatic(req, res, pathname, head)
  }

  return (req, res) => {
    handle(req, res).catch((err: Error) => {
      log(`http ${req.method} ${req.url} failed: ${err.stack ?? err.message}`)
      if (!res.headersSent) sendText(res, 500, t('net.http.serverError'))
      else res.destroy()
    })
  }
}
