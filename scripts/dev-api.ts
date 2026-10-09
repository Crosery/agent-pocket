// Write-back endpoint of the developer editor (ADR 0002 §3.3), as a plain connect/node middleware so the Vite plugin
// (scripts/vite-dev-api.ts) and the tests (tests/dev-api-endpoint.test.ts) use the very same code.
//   GET  <path>?file=<repo-relative json>   -> { hash }
//   POST <path>  { file, baseHash, ops }    -> { ok, hash }   (ops: RFC 6902 add / remove / replace)
// Checks, in order: loopback peer, Host and Origin, per-boot token, JSON content type, body size, whitelist and shape,
// baseHash (409), patch, validator (422, file untouched), atomic write, canonical formatting.
import { createHash, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyPatch, PatchError, type PatchOp } from '../src/shared/dev/editor.ts'

export interface Validation { ok: boolean; fresh: string[]; error?: string }

export interface DevApiOptions {
  /** Repo root (a copy of it in tests): files, tools/content_fmt.py and the validator are resolved against it. */
  root: string
  token: string
  tokenHeader: string
  path: string
  /** Repo-relative files that may be written. */
  files: readonly string[]
  maxBodyBytes: number
  maxOps: number
  validateTimeoutMs: number
  /** Runs after a successful write (the Vite plugin suppresses the page reload for it). */
  onWrite?: (file: string) => void
  /** Replaces the child-process validator (tests). Receives the repo-relative file and the absolute path of the patched candidate. */
  validate?: (file: string, candidate: string) => Promise<Validation>
}

const LOOPBACK_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOST = new Set(['localhost', '127.0.0.1', '[::1]'])
const here = dirname(fileURLToPath(import.meta.url))

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const hostname = (hostHeader: string): string => (hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0]).toLowerCase()

/** Host must be a loopback name (DNS rebinding) and Origin, when sent, the very same origin. */
function originOk(req: IncomingMessage, requireOrigin: boolean): boolean {
  const host = req.headers.host
  if (!host || !LOOPBACK_HOST.has(hostname(host))) return false
  const origin = req.headers.origin
  if (origin === undefined) return !requireOrigin
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase() } catch { return false }
}

function tokenOk(req: IncomingMessage, o: DevApiOptions): boolean {
  const got = req.headers[o.tokenHeader]
  if (typeof got !== 'string') return false
  const a = Buffer.from(got), b = Buffer.from(o.token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = []
    let n = 0
    let over = false
    req.on('data', (c: Buffer) => {
      n += c.length
      if (over) return
      if (n > max) { over = true; chunks.length = 0; ok(null); return }
      chunks.push(c)
    })
    req.on('end', () => { if (!over) ok(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', fail)
  })
}

const isOp = (v: unknown): v is PatchOp => {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.path !== 'string' || !o.path.startsWith('/')) return false
  if (o.op === 'remove') return Object.keys(o).length === 2
  return (o.op === 'add' || o.op === 'replace') && 'value' in o && Object.keys(o).length === 3
}

function run(cmd: string, args: string[], timeout: number): Promise<{ code: number; out: string }> {
  return new Promise((ok) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      ok({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number | undefined ?? 1) : 0, out: String(stdout) })
    })
  })
}

/** The default validator: scripts/dev/validate-edit.ts in a child process (fresh module state, killed on timeout). */
export function childValidator(o: Pick<DevApiOptions, 'root' | 'validateTimeoutMs'>): (file: string, candidate: string) => Promise<Validation> {
  return async (file, candidate) => {
    const r = await run(process.execPath, [join(here, 'dev', 'validate-edit.ts'), '--root', o.root, '--file', file, '--candidate', candidate], o.validateTimeoutMs)
    try {
      const line = r.out.trim().split('\n').filter(Boolean).pop() ?? ''
      const v = JSON.parse(line) as Validation
      return { ok: v.ok === true, fresh: Array.isArray(v.fresh) ? v.fresh : [], ...(v.error ? { error: v.error } : {}) }
    } catch { return { ok: false, fresh: [], error: 'validator failed' } }
  }
}

export function createDevApi(o: DevApiOptions): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const validate = o.validate ?? childValidator(o)
  const allowed = new Set(o.files)
  const locks = new Map<string, Promise<unknown>>()
  const abs = (file: string): string => {
    const p = resolve(o.root, file)
    if (!p.startsWith(resolve(o.root) + sep)) throw new Error('outside the repository')
    return p
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const post = req.method === 'POST'
    if (!LOOPBACK_ADDR.has(req.socket.remoteAddress ?? '')) return send(res, 403, { error: 'forbidden' })
    if (!originOk(req, post)) return send(res, 403, { error: 'origin' })
    if (!tokenOk(req, o)) return send(res, 403, { error: 'token' })
    if (!post && req.method !== 'GET') return send(res, 405, { error: 'method' })

    if (!post) {
      const file = url.searchParams.get('file') ?? ''
      if (!allowed.has(file)) return send(res, 403, { error: 'not_whitelisted' })
      return send(res, 200, { hash: sha256(await readFile(abs(file))) })
    }

    if (!/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) return send(res, 415, { error: 'content_type' })
    const raw = await readBody(req, o.maxBodyBytes)
    if (raw === null) { res.setHeader('connection', 'close'); return send(res, 413, { error: 'too_large' }) }
    let body: { file?: unknown; baseHash?: unknown; ops?: unknown }
    try { body = JSON.parse(raw) as typeof body } catch { return send(res, 400, { error: 'json' }) }
    if (typeof body.file !== 'string' || !allowed.has(body.file)) return send(res, 403, { error: 'not_whitelisted' })
    if (typeof body.baseHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.baseHash)) return send(res, 400, { error: 'baseHash' })
    if (!Array.isArray(body.ops) || body.ops.length === 0 || body.ops.length > o.maxOps || !body.ops.every(isOp)) return send(res, 400, { error: 'ops' })
    const file = body.file, baseHash = body.baseHash, ops = body.ops as PatchOp[]

    const previous = locks.get(file) ?? Promise.resolve()
    const job = previous.then(() => write(res, file, baseHash, ops), () => write(res, file, baseHash, ops))
    locks.set(file, job.catch(() => undefined))
    await job
  }

  async function write(res: ServerResponse, file: string, baseHash: string, ops: PatchOp[]): Promise<void> {
    const target = abs(file)
    const current = await readFile(target)
    const hash = sha256(current)
    if (hash !== baseHash) return send(res, 409, { error: 'conflict', hash })
    const doc = JSON.parse(current.toString('utf8')) as unknown
    try { applyPatch(doc, ops) } catch (err) {
      if (err instanceof PatchError) return send(res, 422, { error: 'patch', message: err.message })
      throw err
    }
    const dir = await mkdtemp(join(tmpdir(), 'ap-edit-'))
    const staged = join(dirname(target), `.edit-${process.pid}-${Date.now()}.json`)
    try {
      const candidate = join(dir, 'candidate.json')
      await writeFile(candidate, JSON.stringify(doc))
      const v = await validate(file, candidate)
      if (!v.ok) return send(res, 422, { error: 'validation', problems: v.fresh.slice(0, 20), ...(v.error ? { message: v.error } : {}) })
      await writeFile(staged, `${JSON.stringify(doc, null, 2)}\n`)
      const fmt = await run('python3', [join(o.root, 'tools', 'content_fmt.py'), staged], 30000)
      if (fmt.code !== 0) return send(res, 500, { error: 'format' })
      // Announce the write first: the file watcher may report the rename before the next line runs.
      o.onWrite?.(file)
      await rename(staged, target)
      return send(res, 200, { ok: true, hash: sha256(await readFile(target)) })
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(staged, { force: true })
    }
  }

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== o.path) return next()
    handle(req, res, url).catch(() => { if (!res.headersSent) send(res, 500, { error: 'internal' }) })
  }
}
