// The editor's write-back endpoint, against a temporary copy of the layout files: every refusal leaves the files
// untouched, and a good request changes exactly the targeted file, formatted, atomically.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createDevApi, type DevApiOptions, type Validation } from '../scripts/dev-api.ts'

const REPO = new URL('..', import.meta.url).pathname
const TOWNS = 'content/world/layouts/towns.json'
const FILES = [TOWNS, 'content/world/layouts/interiors.json', 'content/world/layouts/gyms.json']
const TOKEN = 't'.repeat(48)
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

let root = ''
let server: Server
let port = 0
let stub: (file: string, candidate: string) => Promise<Validation> = async () => ({ ok: true, fresh: [] })
const wrote: string[] = []

const opts = (over: Partial<DevApiOptions> = {}): DevApiOptions => ({
  root, token: TOKEN, tokenHeader: 'x-ap-dev-token', path: '/__ap/dev/content', files: FILES, maxBodyBytes: 4096, maxOps: 8, validateTimeoutMs: 60000,
  onWrite: (f) => { wrote.push(f) }, validate: (f, c) => stub(f, c), ...over,
})

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ap-endpoint-'))
  await mkdir(join(root, 'content/world/layouts'), { recursive: true })
  await mkdir(join(root, 'tools'), { recursive: true })
  for (const f of FILES) await cp(join(REPO, f), join(root, f))
  await cp(join(REPO, 'tools/content_fmt.py'), join(root, 'tools/content_fmt.py'))
  const handler = createDevApi(opts())
  server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end('next') }))
  await new Promise<void>((ok) => server.listen(0, '0.0.0.0', ok))
  port = (server.address() as AddressInfo).port
})
after(async () => { server.close(); await rm(root, { recursive: true, force: true }) })

interface Reply { status: number; body: Record<string, unknown> }

function call(o: { method?: string; path?: string; headers?: Record<string, string>; body?: string; host?: string; port?: number } = {}): Promise<Reply> {
  const p = o.port ?? port
  const host = o.host ?? '127.0.0.1'
  return new Promise((ok, fail) => {
    const req = request({ host, port: p, method: o.method ?? 'POST', path: o.path ?? '/__ap/dev/content', headers: o.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let body: Record<string, unknown> = {}; try { body = JSON.parse(t) as Record<string, unknown> } catch { body = { text: t } } ok({ status: res.statusCode ?? 0, body }) })
    })
    req.on('error', fail)
    if (o.body !== undefined) req.write(o.body)
    req.end()
  })
}

const good = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'x-ap-dev-token': TOKEN, ...extra })
const readFileBytes = (f: string) => readFile(join(root, f))
const hashOf = async (f: string) => sha(await readFileBytes(f))
const post = async (file: string, ops: unknown, baseHash?: string, headers = good()) => call({ headers, body: JSON.stringify({ file, baseHash: baseHash ?? (await hashOf(file)), ops }) })

const MOVE_BENCH = [{ op: 'replace', path: '/templates/town_start/props/1/x', value: 14 }]

test('the endpoint ignores other paths', async () => {
  assert.equal((await call({ path: '/other', method: 'GET', headers: good() })).status, 404)
})

test('403 for a peer that is not loopback (unit: forged peer address; socket: the machine\'s own LAN address)', async () => {
  const handler = createDevApi(opts())
  const sent: { status: number; body: string }[] = []
  const res = { headersSent: false, writeHead(s: number) { sent.push({ status: s, body: '' }) }, end(b: string) { sent[sent.length - 1].body = b } }
  const req = { url: '/__ap/dev/content', method: 'POST', headers: { host: 'localhost:5230', origin: 'http://localhost:5230', 'x-ap-dev-token': TOKEN, 'content-type': 'application/json' }, socket: { remoteAddress: '192.168.1.20' }, on() { return this } }
  handler(req as never, res as never, () => assert.fail('must not fall through'))
  await new Promise((ok) => setTimeout(ok, 20))
  assert.equal(sent[0]?.status, 403)
  assert.equal(JSON.parse(sent[0].body).error, 'forbidden')

  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)
  if (!lan) return // no external interface on this machine: the forged-peer case above is the check
  const r = await call({ host: lan.address, headers: { ...good(), origin: `http://${lan.address}:${port}` }, body: '{}' })
  assert.equal(r.status, 403)
  assert.equal(r.body.error, 'forbidden')
})

test('refusals: Origin, Host (rebinding), token, method, content type, size, whitelist, shape', async () => {
  const before = await hashOf(TOWNS)
  const body = JSON.stringify({ file: TOWNS, baseHash: before, ops: MOVE_BENCH })
  assert.equal((await call({ headers: good({ origin: 'http://evil.example' }), body })).body.error, 'origin')
  assert.equal((await call({ headers: { 'content-type': 'application/json', 'x-ap-dev-token': TOKEN }, body })).body.error, 'origin', 'POST needs an Origin')
  assert.equal((await call({ headers: good({ host: `evil.example:${port}`, origin: `http://evil.example:${port}` }), body })).body.error, 'origin', 'a non-loopback Host name is refused')
  assert.equal((await call({ headers: good({ 'x-ap-dev-token': 'x'.repeat(48) }), body })).body.error, 'token')
  assert.equal((await call({ headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body })).body.error, 'token')
  assert.equal((await call({ method: 'PUT', headers: good(), body })).status, 405)
  assert.equal((await call({ headers: good({ 'content-type': 'text/plain' }), body })).status, 415)
  assert.equal((await call({ headers: good({ 'content-type': 'application/jsonx' }), body })).status, 415)
  assert.equal((await call({ headers: good(), body: 'x'.repeat(5000) })).status, 413)
  assert.equal((await call({ headers: good(), body: '{nope' })).status, 400)
  for (const file of ['content/world/world.json', '../../etc/passwd', `${TOWNS}/../world.json`, '/etc/passwd']) {
    assert.equal((await post(file, MOVE_BENCH, before)).body.error, 'not_whitelisted', file)
  }
  assert.equal((await post(TOWNS, MOVE_BENCH, 'abc')).body.error, 'baseHash')
  for (const ops of [[], 'x', [{ op: 'move', path: '/a', from: '/b' }], [{ op: 'replace', path: 'a', value: 1 }], [{ op: 'replace', path: '/a' }], [{ op: 'remove', path: '/a', value: 1 }], Array.from({ length: 9 }, () => MOVE_BENCH[0])]) {
    assert.equal((await post(TOWNS, ops, before)).body.error, 'ops', JSON.stringify(ops).slice(0, 60))
  }
  assert.equal(await hashOf(TOWNS), before, 'nothing was written')
  assert.equal((await call({ method: 'GET', path: '/__ap/dev/content?file=content/world/world.json', headers: good() })).status, 403)
  assert.equal((await call({ method: 'GET', path: `/__ap/dev/content?file=${TOWNS}`, headers: { origin: `http://127.0.0.1:${port}` } })).body.error, 'token')
  assert.equal((await call({ method: 'GET', path: `/__ap/dev/content?file=${TOWNS}`, headers: good() })).body.hash, before)
})

test('409 when the file changed since the editor read it; the file stays as it is', async () => {
  const stale = sha('stale')
  const before = await hashOf(TOWNS)
  const r = await post(TOWNS, MOVE_BENCH, stale)
  assert.equal(r.status, 409)
  assert.equal(r.body.hash, before, 'the reply carries the current hash so the editor can re-read')
  assert.equal(await hashOf(TOWNS), before)
})

test('422 for a patch that does not apply, and for a validator that objects; the file is untouched either way', async () => {
  const before = await hashOf(TOWNS)
  const bad = await post(TOWNS, [{ op: 'replace', path: '/templates/town_start/props/9999/x', value: 1 }], before)
  assert.equal(bad.status, 422)
  assert.equal(bad.body.error, 'patch')
  stub = async () => ({ ok: false, fresh: ['town town_start: building lab does not fit'] })
  const refused = await post(TOWNS, MOVE_BENCH, before)
  assert.equal(refused.status, 422)
  assert.equal(refused.body.error, 'validation')
  assert.deepEqual(refused.body.problems, ['town town_start: building lab does not fit'])
  stub = async () => { throw new Error('validator crashed') }
  assert.equal((await post(TOWNS, MOVE_BENCH, before)).status, 500)
  assert.equal(await hashOf(TOWNS), before, 'unchanged')
  assert.deepEqual((await readdir(join(root, 'content/world/layouts'))).filter((n) => n.startsWith('.edit-')), [], 'no staging files left behind')
  stub = async () => ({ ok: true, fresh: [] })
})

test('a good request patches exactly the target, formats it canonically, writes atomically and reports the new hash', async () => {
  const others = Object.fromEntries(await Promise.all(FILES.filter((f) => f !== TOWNS).map(async (f) => [f, await hashOf(f)])))
  const before = await hashOf(TOWNS)
  const original = JSON.parse((await readFileBytes(TOWNS)).toString('utf8')) as { templates: { town_start: { props: { x: number }[] } } }
  const seen: string[] = []
  stub = async (file, candidate) => { seen.push(file, String((JSON.parse(await readFile(candidate, 'utf8')) as typeof original).templates.town_start.props[1].x)); return { ok: true, fresh: [] } }
  const r = await post(TOWNS, MOVE_BENCH, before)
  assert.equal(r.status, 200)
  assert.deepEqual(seen, [TOWNS, '14'], 'the validator saw the patched candidate')
  const after = JSON.parse((await readFileBytes(TOWNS)).toString('utf8')) as typeof original
  assert.equal(after.templates.town_start.props[1].x, 14)
  assert.equal(r.body.hash, await hashOf(TOWNS))
  assert.notEqual(r.body.hash, before)
  after.templates.town_start.props[1].x = original.templates.town_start.props[1].x
  assert.deepEqual(after, original, 'only that value changed')
  for (const [f, h] of Object.entries(others)) assert.equal(await hashOf(f), h, `${f} untouched`)
  assert.deepEqual(wrote, [TOWNS])
  assert.equal(await hashOf(TOWNS) === r.body.hash, true)
  // the inverse patch restores the original bytes exactly (the formatter is canonical)
  const back = await post(TOWNS, [{ op: 'replace', path: '/templates/town_start/props/1/x', value: original.templates.town_start.props[1].x }], r.body.hash as string)
  assert.equal(back.status, 200)
  assert.equal(await hashOf(TOWNS), before, 'revert gives back the identical file')
  stub = async () => ({ ok: true, fresh: [] })
})

test('two writes with the same baseHash: one wins, the other gets 409', async () => {
  const before = await hashOf(TOWNS)
  const one = (x: number) => post(TOWNS, [{ op: 'replace', path: '/templates/town_start/props/1/x', value: x }], before)
  const [a, b] = await Promise.all([one(20), one(21)])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
  const winner = (a.status === 200 ? a : b).body.hash
  assert.equal(await hashOf(TOWNS), winner)
  const back = JSON.parse((await readFileBytes(TOWNS)).toString('utf8')) as { templates: { town_start: { props: { x: number }[] } } }
  assert.ok([20, 21].includes(back.templates.town_start.props[1].x))
  assert.equal((await post(TOWNS, [{ op: 'replace', path: '/templates/town_start/props/1/x', value: 13 }])).status, 200)
})

test('the real validator (child process): a no-op passes, a building pushed off the map is refused and the file stays', { timeout: 120000 }, async () => {
  const own = createServer()
  const handler = createDevApi(opts({ validate: undefined, maxBodyBytes: 65536, validateTimeoutMs: 110000 }))
  own.on('request', (req, res) => handler(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise<void>((ok) => own.listen(0, '127.0.0.1', ok))
  const p = (own.address() as AddressInfo).port
  try {
    const h = (): Record<string, string> => ({ 'content-type': 'application/json', origin: `http://127.0.0.1:${p}`, 'x-ap-dev-token': TOKEN })
    const send = async (ops: unknown) => call({ port: p, headers: h(), body: JSON.stringify({ file: TOWNS, baseHash: await hashOf(TOWNS), ops }) })
    const original = await hashOf(TOWNS)
    const noop = await send([{ op: 'replace', path: '/templates/town_start/props/1/x', value: 13 }])
    assert.equal(noop.status, 200, JSON.stringify(noop.body))
    const out = await send([{ op: 'replace', path: '/templates/town_start/buildings/0/x', value: 20 }])
    assert.equal(out.status, 422, JSON.stringify(out.body))
    assert.equal(out.body.error, 'validation')
    assert.ok((out.body.problems as string[]).some((s) => /does not fit/.test(s)), JSON.stringify(out.body))
    assert.equal(await hashOf(TOWNS), noop.body.hash, 'the refused edit changed nothing')
    assert.equal(original === noop.body.hash, true, 'a no-op write is byte-identical (the formatter is canonical)')
  } finally { own.close() }
})
