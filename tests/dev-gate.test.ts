// Developer-tooling gate (ADR 0002 §5): the compile-time switch, the production bundle check, and the
// official server refusing clients built with developer tooling.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import type { EventBus, GameEvents, NetStatus } from '../src/client/contracts.ts'
import type { ClientMsg, PublicProfile, ServerMsg } from '../src/shared/protocol.ts'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { createNetClient, NET_CLIENT } from '../src/client/net/index.ts'
import { startServer } from '../src/server/index.ts'
import { NET, validateNetContent } from '../src/server/config.ts'
import { devtoolsBuild, devtoolsProblems, GATE, productionProblems, scanBundle } from '../scripts/dev-gate.ts'

const root = new URL('../', import.meta.url)
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'ap-devgate-test-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

function writeBundle(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
}

function sourceFiles(rel: string, out: string[] = []): string[] {
  for (const name of readdirSync(new URL(rel, root))) {
    const p = `${rel}${name}`
    if (statSync(new URL(p, root)).isDirectory()) sourceFiles(`${p}/`, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

// ----------------------------------------------------------------------------- compile-time switch

test('devtoolsBuild: on for the dev server and --mode devtools, off for a production build', () => {
  assert.equal(devtoolsBuild('serve', 'development'), true)
  assert.equal(devtoolsBuild('build', 'devtools'), true)
  assert.equal(devtoolsBuild('build', 'production'), false)
  assert.equal(devtoolsBuild('build', 'development'), false)
  assert.equal(devtoolsBuild('build', 'staging'), false)
})

test('vite.config.ts defines __AP_DEVTOOLS__ from devtoolsBuild and game.ts guards the import with it', () => {
  assert.match(read('vite.config.ts'), /__AP_DEVTOOLS__:\s*JSON\.stringify\(devtoolsBuild\(command, mode\)\)/)
  const game = read('src/client/game.ts')
  assert.match(game, /typeof __AP_DEVTOOLS__ !== 'undefined' && __AP_DEVTOOLS__\s*\?\s*await loadDevKit\(\)\s*:\s*null/)
})

test('src/client/dev and src/shared/dev are reachable only through the guarded dynamic import (types aside)', () => {
  const offenders: string[] = []
  for (const f of sourceFiles('src/')) {
    if (f.startsWith('src/client/dev/') || f.startsWith('src/shared/dev/')) continue
    const text = read(f)
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;\n]*?from\s+'([^']*\/dev\/[^']*)'/gm)) offenders.push(`${f}: ${m[1]}`)
    for (const m of text.matchAll(/import\(\s*'([^']*\/dev\/[^']*)'\s*\)/g)) if (f !== 'src/client/game.ts') offenders.push(`${f}: dynamic ${m[1]}`)
  }
  assert.deepEqual(offenders, [])
})

test('content/dev is imported only by the dev tooling, never by shipped source', () => {
  const isDev = (f: string) => f.startsWith('src/client/dev/') || f.startsWith('src/shared/dev/')
  const offenders = sourceFiles('src/').filter((f) => !isDev(f) && /(?:from|import\()\s*'[^']*content\/dev\//.test(read(f)))
  assert.deepEqual(offenders, [])
})

// ----------------------------------------------------------------------------- bundle check

test('gate config: the ADR needles are present, patterns compile, the sentinel is the one the dev entry exports', () => {
  for (const needle of ['__AP_DEV_SENTINEL', 'skipTitle', 'content/dev']) assert.ok(GATE.prodForbidden.includes(needle), needle)
  assert.ok(GATE.prodForbidden.some((p) => new RegExp(p).test('window.__ap={')), '__ap')
  assert.ok(GATE.prodForbidden.every((p) => !new RegExp(p).test('let t=`__ap_probe__`')), 'the storage probe key is not a debug hook')
  for (const p of [...GATE.prodForbidden, ...GATE.devtoolsRequired]) assert.doesNotThrow(() => new RegExp(p), p)
  for (const p of GATE.devtoolsRequired) assert.ok(GATE.prodForbidden.includes(p), `${p}: required in devtools but not forbidden in production`)
  assert.match(read('src/client/dev/index.ts'), new RegExp(`DEV_SENTINEL = '${GATE.sentinel}'`))
})

test('bundle check: flags tooling in a production bundle, passes a clean one, and demands it in a devtools bundle', () => {
  withTempDir((dir) => {
    const clean = join(dir, 'clean'), dirty = join(dir, 'dirty'), dev = join(dir, 'dev'), vacuous = join(dir, 'vacuous')
    writeBundle(clean, { 'index.html': '<html></html>', 'assets/a.js': 'let t=`__ap_probe__`;export{t}', 'assets/logo.png': '__ap skipTitle' })
    writeBundle(dirty, { 'assets/a.js': 'window.__ap={pos(){}}', 'assets/b.js': 'x.skipTitle', 'assets/c.js': '"__AP_DEV_SENTINEL"' })
    writeBundle(dev, { 'assets/dev.js': 'window.__ap={};window.__AP=1;x.skipTitle;"__AP_DEV_SENTINEL";{"../../../content/dev/scenarios/a.json":1}' })
    writeBundle(vacuous, { 'assets/dev.js': 'nothing here' })

    assert.deepEqual(productionProblems(clean), [], 'binary assets are not scanned and the storage probe is not a hook')
    const bad = productionProblems(dirty)
    assert.ok(bad.some((p) => p.includes('a.js') && p.includes('__ap')))
    assert.ok(bad.some((p) => p.includes('b.js') && p.includes('skipTitle')))
    assert.ok(bad.some((p) => p.includes('c.js') && p.includes('__AP_DEV_SENTINEL')))
    assert.deepEqual(devtoolsProblems(dev), [])
    assert.equal(devtoolsProblems(vacuous).length, GATE.devtoolsRequired.length, 'every required needle is reported missing')
    assert.equal(scanBundle(dirty, ['nothing']).length, 0)
  })
})

// ----------------------------------------------------------------------------- server refuses devtools clients

const profile: PublicProfile = { id: 'x', name: 'Dev', avatar: 'x', badges: [], dexCaught: 0, party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0 }

function helloMsg(build?: { devtools: boolean }): ClientMsg {
  return {
    t: 'hello', v: CONTENT.config.net.protocolVersion, playerId: crypto.randomUUID(), name: 'Dev', avatar: 'x',
    map: 'm', x: 1, y: 1, facing: 'down', lead: null, profile, ...(build ? { build } : {}),
  }
}

/** Opens a socket, sends the hello and reports the messages seen until the server closes it or says welcome. */
function handshake(port: number, hello: ClientMsg): Promise<{ welcome: boolean; errors: string[]; closeCode: number | null }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}${NET.protocol.wsPath}`)
    const errors: string[] = []
    let welcome = false
    const timer = setTimeout(() => { ws.close(); reject(new Error('handshake timeout')) }, 4000)
    ws.addEventListener('open', () => ws.send(JSON.stringify(hello)))
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as ServerMsg
      if (m.t === 'error') errors.push(m.code)
      if (m.t === 'welcome') { welcome = true; clearTimeout(timer); ws.close(); resolve({ welcome, errors, closeCode: null }) }
    })
    ws.addEventListener('close', (e) => { clearTimeout(timer); resolve({ welcome, errors, closeCode: e.code }) })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')) })
  })
}

test('net content: devNotAllowed is a valid close code with its own text', () => {
  assert.deepEqual(validateNetContent(), [])
  const codes = Object.values(NET.protocol.closeCodes)
  assert.equal(new Set(codes).size, codes.length, 'close codes are distinct')
  assert.ok(t('net.error.dev_not_allowed') !== 'net.error.dev_not_allowed')
})

test('server: a devtools client is refused unless AP_DEV is on; production-style hellos are unaffected', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ap-devgate-srv-'))
  const official = await startServer({ port: 0, dataDir: join(dataDir, 'a'), distDir: join(dataDir, 'no-dist'), quiet: true, pvp: null, world: null })
  const permissive = await startServer({ port: 0, dataDir: join(dataDir, 'b'), distDir: join(dataDir, 'no-dist'), quiet: true, pvp: null, world: null, allowDev: true })
  try {
    const refused = await handshake(official.port, helloMsg({ devtools: true }))
    assert.equal(refused.welcome, false)
    assert.deepEqual(refused.errors, ['dev_not_allowed'])
    assert.equal(refused.closeCode, NET.protocol.closeCodes.devNotAllowed)

    assert.equal((await handshake(official.port, helloMsg({ devtools: false }))).welcome, true, 'production build declares devtools:false')
    assert.equal((await handshake(official.port, helloMsg())).welcome, true, 'older clients send no build field')
    assert.equal((await handshake(official.port, { ...helloMsg(), build: 'yes' } as unknown as ClientMsg)).welcome, true, 'a malformed build field is ignored, not trusted')

    assert.equal((await handshake(permissive.port, helloMsg({ devtools: true }))).welcome, true, 'AP_DEV servers accept devtools builds')
  } finally {
    await official.close()
    await permissive.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ----------------------------------------------------------------------------- client stops retrying

function bus(): EventBus<GameEvents> & { log: { type: string; payload: unknown }[] } {
  const handlers = new Map<string, Set<(p: unknown) => void>>()
  const log: { type: string; payload: unknown }[] = []
  return {
    log,
    on(type, fn) {
      const k = String(type)
      if (!handlers.has(k)) handlers.set(k, new Set())
      handlers.get(k)!.add(fn as (p: unknown) => void)
      return () => handlers.get(k)?.delete(fn as (p: unknown) => void)
    },
    once(type, fn) { const off = this.on(type, (p) => { off(); fn(p) }); return off },
    emit(type, payload) { log.push({ type: String(type), payload }); for (const f of handlers.get(String(type)) ?? []) f(payload) },
  }
}

test('client: devNotAllowed ends reconnecting and tells the player why', async () => {
  let hellos = 0
  const sockets: WsSocket[] = []
  const wss: WebSocketServer = await new Promise((resolve) => {
    const w: WebSocketServer = new WebSocketServer({ port: 0, path: NET_CLIENT.protocol.wsPath }, () => resolve(w))
    w.on('connection', (ws: WsSocket) => {
      sockets.push(ws)
      ws.on('message', (d: Buffer) => {
        if ((JSON.parse(String(d)) as ClientMsg).t === 'hello') { hellos++; ws.close(NET_CLIENT.protocol.closeCodes.devNotAllowed) }
      })
    })
  })
  const port = (wss.address() as { port: number }).port
  const events = bus()
  const net = createNetClient(events, () => helloMsg({ devtools: true }) as Extract<ClientMsg, { t: 'hello' }>, { url: `ws://localhost:${port}${NET_CLIENT.protocol.wsPath}` })
  try {
    net.connect()
    const end = Date.now() + 3000
    while (net.status !== 'error' && Date.now() < end) await sleep(10)
    assert.equal(net.status, 'error')
    const r = NET_CLIENT.client.reconnect
    await sleep(r.baseMs * (1 + r.jitter) + 200)
    assert.equal(hellos, 1, 'no reconnect after the refusal')
    assert.equal(net.status, 'error')
    const statuses = events.log.filter((e) => e.type === 'net:status').map((e) => (e.payload as { status: NetStatus }).status)
    assert.deepEqual(statuses, ['connecting', 'error'])
    const toast = events.log.find((e) => e.type === 'toast')
    assert.equal((toast?.payload as { text: string }).text, t('net.error.dev_not_allowed'))
  } finally {
    net.disconnect()
    for (const s of sockets) s.terminate()
    await new Promise<void>((r) => wss.close(() => r()))
  }
})
