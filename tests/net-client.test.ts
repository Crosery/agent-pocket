// Tests for src/client/net (interpolation + NetClient) against a scripted ws server and the real server (port 8794).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import type { EventBus, GameEvents, NetStatus } from '../src/client/contracts.ts'
import type { ClientMsg, PublicProfile, ServerMsg } from '../src/shared/protocol.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { createNetClient, NET_CLIENT } from '../src/client/net/index.ts'
import { pushSample, sampleAt, type Sample } from '../src/client/net/interp.ts'
import { startServer } from '../src/server/index.ts'

const PORT = 8794
const URL_WS = `ws://localhost:${PORT}${NET_CLIENT.protocol.wsPath}`
const tickMs = 1000 / CONTENT.config.net.tickHz
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

async function until(cond: () => boolean, ms = 3000, label = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${label}`)
    await sleep(10)
  }
}

const profile = (name: string): PublicProfile => ({ id: 'x', name, avatar: 'x', badges: [], dexCaught: 0, party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0 })

function helloFor(name: string, map: string, x: number, y: number, playerId = crypto.randomUUID()) {
  return (): Extract<ClientMsg, { t: 'hello' }> => ({
    t: 'hello', v: CONTENT.config.net.protocolVersion, playerId, name, avatar: '', map, x, y, facing: 'down', lead: null, profile: profile(name),
  })
}

// ----------------------------------------------------------------------------- interpolation

test('interp: lerp between samples, bridge idle gaps, snap on teleports', () => {
  const o = { keepMs: 1000, snapDistance: 5, tickMs: 100 }
  const buf: Sample[] = []
  pushSample(buf, { t: 0, x: 0, y: 0 }, o)
  pushSample(buf, { t: 100, x: 1, y: 0 }, o)
  assert.deepEqual(sampleAt(buf, 50), { x: 0.5, y: 0 })
  assert.deepEqual(sampleAt(buf, -10), { t: 0, x: 0, y: 0 })
  assert.deepEqual(sampleAt(buf, 500), { t: 100, x: 1, y: 0 })
  pushSample(buf, { t: 5000, x: 2, y: 0 }, o)
  // Idle for 4.9 s: the slide starts one tick before the new sample.
  assert.deepEqual(sampleAt(buf, 4950), { x: 1.5, y: 0 })
  // Samples older than keepMs are pruned, keeping one bracket sample before the cutoff.
  assert.deepEqual(buf.map((x) => x.t), [100, 4900, 5000])
  pushSample(buf, { t: 5100, x: 50, y: 50 }, o)
  assert.equal(buf.length, 1)
  assert.equal(sampleAt([], 0), null)
})

// ----------------------------------------------------------------------------- scripted server

interface Scripted {
  wss: WebSocketServer
  received: ClientMsg[]
  sockets: WsSocket[]
  close(): Promise<void>
}

function scriptedServer(onMsg: (ws: WsSocket, m: ClientMsg) => void): Promise<Scripted> {
  const received: ClientMsg[] = []
  const sockets: WsSocket[] = []
  return new Promise((resolve) => {
    const wss: WebSocketServer = new WebSocketServer({ port: PORT, path: NET_CLIENT.protocol.wsPath }, () => resolve({
      wss, received, sockets,
      close: () => new Promise<void>((r) => { for (const s of sockets) s.terminate(); wss.close(() => r()) }),
    }))
    wss.on('connection', (ws: WsSocket) => {
      sockets.push(ws)
      ws.on('message', (d: Buffer) => { const m = JSON.parse(String(d)) as ClientMsg; received.push(m); onMsg(ws, m) })
    })
  })
}

const sendTo = (ws: WsSocket, m: ServerMsg) => ws.send(JSON.stringify(m))

test('client: lifecycle, throttling, debounce, leaderboard, rtt, reconnect, fatal close', async () => {
  let welcomeCount = 0
  const srv = await scriptedServer((ws, m) => {
    if (m.t === 'hello') { welcomeCount++; sendTo(ws, { t: 'welcome', selfId: 'me', serverTime: Date.now(), motd: 'hi', online: 2 }) }
    if (m.t === 'ping') sendTo(ws, { t: 'pong', at: m.at, serverTime: Date.now() })
    if (m.t === 'leaderboard') sendTo(ws, { t: 'leaderboard', entries: [{ id: 'a', name: 'A', avatar: 'x', dexCaught: 1, badges: 0, pvpWins: 0, pvpLosses: 0 }] })
  })
  const events = bus()
  const net = createNetClient(events, helloFor('Me', 'm', 1, 1), { url: URL_WS })
  try {
    assert.equal(net.status, 'offline')
    net.send({ t: 'chat', channel: 'global', text: 'dropped while offline' })
    net.reportPosition({ map: 'm', x: 1, y: 1, facing: 'down', moving: false, running: false })
    net.connect()
    await until(() => net.status === 'online', 3000, 'online')
    assert.deepEqual(events.log.filter((e) => e.type === 'net:status').map((e) => (e.payload as { status: NetStatus }).status), ['connecting', 'online'])
    assert.equal(net.selfId, 'me')
    assert.equal(net.online, 2)
    assert.equal(net.motd, 'hi')
    assert.equal(srv.received[0].t, 'hello')
    assert.ok(!srv.received.some((m) => m.t === 'chat'), 'offline sends are dropped')
    await until(() => net.rtt >= 0, 2000, 'rtt')

    // Position: first report and moving toggles are immediate, the rest throttled to tickHz.
    const moves = () => srv.received.filter((m) => m.t === 'move')
    for (let i = 0; i < 20; i++) net.reportPosition({ map: 'm', x: 1 + i * 0.01, y: 1, facing: 'right', moving: true, running: false })
    await sleep(30)
    assert.equal(moves().length, 1)
    net.reportPosition({ map: 'm', x: 1.3, y: 1, facing: 'right', moving: false, running: false })
    await sleep(30)
    assert.equal(moves().length, 2, 'moving toggle bypasses the throttle')
    await sleep(tickMs + 10)
    net.reportPosition({ map: 'm', x: 1.4, y: 1, facing: 'right', moving: false, running: false })
    net.reportPosition({ map: 'm', x: 1.4, y: 1, facing: 'right', moving: false, running: false })
    await sleep(30)
    assert.equal(moves().length, 3, 'unchanged positions are not resent')

    // Profile pushes are coalesced.
    for (let i = 0; i < 5; i++) net.updateProfile(profile(`P${i}`))
    await sleep(NET_CLIENT.client.profileDebounceMs + 100)
    const profiles = srv.received.filter((m) => m.t === 'profile')
    assert.equal(profiles.length, 1)
    assert.equal((profiles[0] as Extract<ClientMsg, { t: 'profile' }>).profile.name, 'P4')

    const lb = await net.leaderboard()
    assert.equal(lb[0].id, 'a')

    const seen: string[] = []
    const off = net.on('system', (m) => seen.push(m.text))
    sendTo(srv.sockets[0], { t: 'system', text: 'one', level: 'info' })
    sendTo(srv.sockets[0], { t: 'chat', from: 'x', name: 'X', channel: 'global', text: 'yo', at: 1 })
    await sleep(50)
    off()
    sendTo(srv.sockets[0], { t: 'system', text: 'two', level: 'info' })
    await sleep(50)
    assert.deepEqual(seen, ['one'])
    assert.ok(events.log.some((e) => e.type === 'chat:message' && (e.payload as { text: string }).text === 'yo'))

    // Abrupt drop → backoff reconnect with a fresh hello.
    srv.sockets[0].terminate()
    await until(() => net.status === 'connecting', 2000, 'connecting after drop')
    const r = NET_CLIENT.client.reconnect
    await until(() => net.status === 'online' && welcomeCount === 2, r.baseMs * (1 + r.jitter) + 2000, 'reconnected')

    // Duplicate-login close code is fatal: no reconnect loop.
    srv.sockets[1].close(NET_CLIENT.protocol.closeCodes.duplicate)
    await until(() => net.status === 'error', 2000, 'error status')
    await sleep(r.baseMs * (1 + r.jitter) + 200)
    assert.equal(welcomeCount, 2)
    assert.equal(net.status, 'error')
  } finally {
    net.disconnect()
    await srv.close()
  }
  assert.equal(net.status, 'offline')
})

// ----------------------------------------------------------------------------- real server

test('client against the real server: remote players, interpolation, chat, leaderboard', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-net-client-'))
  // world: null — this test exercises client mechanics on a synthetic map id, not world bounds.
  const srv = await startServer({ port: PORT, dataDir: dir, distDir: pathJoin(dir, 'nd'), quiet: true, pvp: null, world: null })
  const mapId = 'net-client-map'
  const eventsA = bus(), eventsB = bus()
  const a = createNetClient(eventsA, helloFor('Ana', mapId, 10, 10), { url: URL_WS })
  const b = createNetClient(eventsB, helloFor('Bo', mapId, 11, 10), { url: URL_WS })
  try {
    a.connect()
    b.connect()
    await until(() => a.status === 'online' && b.status === 'online', 3000, 'both online')
    a.reportPosition({ map: mapId, x: 10, y: 10, facing: 'down', moving: false, running: false })
    b.reportPosition({ map: mapId, x: 11, y: 10, facing: 'down', moving: false, running: false })
    await until(() => a.remotePlayers().has(b.selfId!), 2000, 'a sees b')
    assert.ok(!a.remotePlayers().has(a.selfId!))

    // Walk b east; a's interpolated position trails the authoritative one and then converges.
    for (let i = 1; i <= 10; i++) {
      b.reportPosition({ map: mapId, x: 11 + i * 0.3, y: 10, facing: 'right', moving: i < 10, running: false })
      await sleep(tickMs + 5)
    }
    await until(() => a.remotePlayers().get(b.selfId!)?.x === 14, 2000, 'authoritative x')
    const mid = a.remotePlayers().get(b.selfId!)!
    assert.ok(mid.rx <= mid.x)
    await sleep(NET_CLIENT.client.interpolationDelayMs + tickMs * 2)
    const done = a.remotePlayers().get(b.selfId!)!
    assert.equal(done.rx, 14)
    assert.equal(done.ry, 10)

    b.send({ t: 'chat', channel: 'global', text: '你好' })
    await until(() => eventsA.log.some((e) => e.type === 'chat:message' && (e.payload as { text: string }).text === '你好'), 2000, 'chat event')

    const lb = await a.leaderboard()
    assert.ok(lb.some((e) => e.id === a.selfId) && lb.some((e) => e.id === b.selfId))

    // Map change on the local side clears remotes immediately.
    a.reportPosition({ map: 'elsewhere', x: 1, y: 1, facing: 'down', moving: false, running: false })
    assert.equal(a.remotePlayers().size, 0)

    b.disconnect()
    assert.equal(b.status, 'offline')
    const offlineLb = await b.leaderboard()
    assert.ok(offlineLb.length >= 2, 'offline leaderboard falls back to HTTP')
  } finally {
    a.disconnect()
    b.disconnect()
    await srv.close()
    await rm(dir, { recursive: true, force: true })
  }
})
