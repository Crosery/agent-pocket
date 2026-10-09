// The developer net simulation: the fake server's messages obey the protocol, the link keeps order while it delays and
// stalls, drops look like the network cut the connection, and the real NetClient plays a whole session against it.
import { test, mock, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { EventBus, GameEvents } from '../src/client/contracts.ts'
import type { ClientMsg, PlayerState, PublicProfile, ServerMsg } from '../src/shared/protocol.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { FakeServer, hash01, peerAt, peerHome, type FakeConfig } from '../src/shared/dev/netsim.ts'
import { createNetClient } from '../src/client/net/index.ts'
import { createNetSim, type NetSim, type NetSimConfig, type SocketLike } from '../src/client/dev/net-sim.ts'
import { installDevText } from '../src/client/dev/text.ts'
import { COMMANDS } from '../src/client/dev/commands/index.ts'
import { devEnums } from '../src/client/dev/enums.ts'
import { createRegistry, DevError } from '../src/client/dev/registry.ts'
import type { DevHost } from '../src/client/dev/kit.ts'

const CFG = JSON.parse(readFileSync(new URL('../content/dev/net-sim.json', import.meta.url), 'utf8')) as NetSimConfig
const FAKE: FakeConfig = CFG.fake
const TEXT = { motd: 'motd', peerName: (n: number) => `peer${n}`, unsupported: 'nope' }
const AVATARS = CONTENT.characters.filter((c) => c.playable).map((c) => c.id)
before(() => installDevText())
afterEach(() => { mock.timers.reset() })

// ----------------------------------------------------------------------------- protocol conformance

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const DIRS = ['down', 'left', 'right', 'up']

function assertPlayer(p: PlayerState): void {
  assert.ok(typeof p.id === 'string' && typeof p.name === 'string' && typeof p.avatar === 'string' && typeof p.map === 'string', 'identity strings')
  assert.ok(isNum(p.x) && isNum(p.y) && isNum(p.badges) && isNum(p.dexCaught), 'numbers')
  assert.ok(DIRS.includes(p.facing) && typeof p.moving === 'boolean' && typeof p.running === 'boolean' && typeof p.busy === 'boolean', 'flags')
  assert.ok(p.lead === null || typeof p.lead.speciesId === 'string')
}

function assertProfile(p: PublicProfile): void {
  assert.ok(typeof p.id === 'string' && typeof p.name === 'string' && typeof p.avatar === 'string')
  assert.ok(Array.isArray(p.badges) && Array.isArray(p.party) && isNum(p.dexCaught) && isNum(p.pvpWins) && isNum(p.pvpLosses) && isNum(p.playTimeSec))
}

/** Structural check of every ServerMsg the fake server can emit (protocol.ts is the contract). */
function assertServerMsg(m: ServerMsg): void {
  switch (m.t) {
    case 'welcome': assert.ok(typeof m.selfId === 'string' && isNum(m.serverTime) && typeof m.motd === 'string' && isNum(m.online)); break
    case 'snapshot': assert.ok(typeof m.map === 'string' && Array.isArray(m.players)); m.players.forEach(assertPlayer); break
    case 'join': assertPlayer(m.player); break
    case 'leave': assert.equal(typeof m.id, 'string'); break
    case 'chat': assert.ok(typeof m.from === 'string' && typeof m.name === 'string' && ['global', 'local', 'system', 'whisper'].includes(m.channel) && typeof m.text === 'string' && isNum(m.at)); break
    case 'online':
      assert.ok(isNum(m.count) && Array.isArray(m.players))
      for (const p of m.players) assert.ok(typeof p.id === 'string' && typeof p.name === 'string' && typeof p.map === 'string' && typeof p.avatar === 'string' && typeof p.busy === 'boolean')
      break
    case 'profile': assertProfile(m.profile); break
    case 'leaderboard':
      for (const e of m.entries) assert.ok(typeof e.id === 'string' && isNum(e.dexCaught) && isNum(e.badges) && isNum(e.pvpWins) && isNum(e.pvpLosses))
      break
    case 'system': assert.ok(typeof m.text === 'string' && ['info', 'warn', 'error'].includes(m.level)); break
    case 'pong': assert.ok(isNum(m.at) && isNum(m.serverTime)); break
    default: assert.fail(`the fake server must not emit ${m.t}`)
  }
}

const profile: PublicProfile = { id: 'x', name: 'Me', avatar: 'x', badges: [], dexCaught: 0, party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0 }
const HELLO: ClientMsg = { t: 'hello', v: CONTENT.config.net.protocolVersion, playerId: 'p', name: 'Me', avatar: 'x', map: 'overworld', x: 100, y: 200, facing: 'down', lead: null, profile }

function server(peers = FAKE.peers, start = 1000): FakeServer { return new FakeServer(FAKE, TEXT, AVATARS, peers, start) }

test('fake server: hello gets welcome, online and a snapshot of the crowd; every message conforms to ServerMsg', () => {
  const s = server()
  assert.deepEqual(s.tick(1100), [], 'silent before the hello')
  const out = s.handle(HELLO, 1000)
  assert.deepEqual(out.map((m) => m.t), ['welcome', 'online', 'snapshot'])
  out.forEach(assertServerMsg)
  const [welcome, online, snap] = out as [Extract<ServerMsg, { t: 'welcome' }>, Extract<ServerMsg, { t: 'online' }>, Extract<ServerMsg, { t: 'snapshot' }>]
  assert.equal(welcome.online, FAKE.peers + 1)
  assert.equal(online.count, FAKE.peers + 1)
  assert.equal(snap.map, 'overworld')
  assert.equal(snap.players.length, FAKE.peers)
  assert.equal(new Set(snap.players.map((p) => p.id)).size, FAKE.peers, 'ids are unique')
  assert.ok(snap.players.every((p) => p.map === 'overworld' && Math.hypot(p.x - 100, p.y - 200) < FAKE.radiusTiles + 12), 'the crowd stands near the player')
  assert.ok(snap.players.some((p) => p.busy) && snap.players.some((p) => !p.busy))
})

test('fake server: ping, chat echo, leaderboard, inspect and the things it cannot do', () => {
  const s = server()
  s.handle(HELLO, 1000)
  assert.deepEqual(s.handle({ t: 'ping', at: 42 }, 1500), [{ t: 'pong', at: 42, serverTime: 1500 }])
  const chat = s.handle({ t: 'chat', channel: 'global', text: 'hi' }, 1600)
  assert.deepEqual(chat, [{ t: 'chat', from: FAKE.selfId, name: 'Me', channel: 'global', text: 'hi', at: 1600 }])
  assert.deepEqual(s.handle({ t: 'chat', channel: 'whisper', text: 'psst', to: 'dev-peer-1' }, 1600), [])
  const lb = s.handle({ t: 'leaderboard' }, 1700)
  lb.forEach(assertServerMsg)
  const entries = (lb[0] as Extract<ServerMsg, { t: 'leaderboard' }>).entries
  assert.equal(entries.length, FAKE.peers)
  assert.ok(entries.every((e, i) => i === 0 || entries[i - 1].dexCaught >= e.dexCaught), 'sorted by dex')
  const prof = s.handle({ t: 'inspect', target: 'dev-peer-3' }, 1700)
  prof.forEach(assertServerMsg)
  assert.equal((prof[0] as Extract<ServerMsg, { t: 'profile' }>).profile.name, 'peer4')
  for (const bad of [{ t: 'inspect', target: 'dev-peer-99' }, { t: 'trade.request', to: 'dev-peer-1' }, { t: 'pvp.challenge', to: 'dev-peer-1' }] as ClientMsg[]) {
    assert.deepEqual(s.handle(bad, 1800), [{ t: 'system', text: 'nope', level: 'info' }])
  }
  assert.deepEqual(s.handle({ t: 'busy', busy: true }, 1900), [])
})

test('fake server: ticks produce snapshots, the online summary comes every onlineSeconds, peers join and leave', () => {
  const s = server()
  s.handle(HELLO, 1000)
  const t1 = s.tick(1100)
  assert.deepEqual(t1.map((m) => m.t), ['snapshot'])
  assert.deepEqual(s.tick(1000 + FAKE.onlineSeconds * 1000 + 50).map((m) => m.t), ['snapshot', 'online'])
  const grow = s.setPeers(FAKE.peers + 2, 7000)
  grow.forEach(assertServerMsg)
  assert.deepEqual(grow.map((m) => m.t), ['join', 'join', 'online'])
  const shrink = s.setPeers(3, 7100)
  assert.deepEqual(shrink.filter((m) => m.t === 'leave').map((m) => (m as { id: string }).id), Array.from({ length: FAKE.peers - 1 }, (_, i) => `dev-peer-${i + 3}`))
  assert.equal(s.peers, 3)
  assert.equal((s.tick(7200)[0] as Extract<ServerMsg, { t: 'snapshot' }>).players.length, 3)
  const moved = s.handle({ t: 'move', map: 'forge', x: 5, y: 6, facing: 'up', moving: true, running: false }, 7300)
  assert.deepEqual(moved, [])
  assert.ok((s.tick(7400)[0] as Extract<ServerMsg, { t: 'snapshot' }>).players.every((p) => p.map === 'forge' && Math.hypot(p.x - 5, p.y - 6) < FAKE.radiusTiles + 12), 'the crowd follows the player to the new map')
})

test('walking patterns are pure, stay inside their shape and move the way they face', () => {
  const c = { x: 50, y: 50 }
  FAKE.patterns.forEach((pat, i) => {
    const home = peerHome(FAKE, i, c)
    const a = peerAt(FAKE, i, 12.3, c)
    assert.deepEqual(a, peerAt(FAKE, i, 12.3, c), 'same inputs, same pose')
    for (let t = 0; t < 60; t += 0.37) {
      const p = peerAt(FAKE, i, t, c)
      if (pat.kind === 'circle') assert.ok(Math.abs(Math.hypot(p.x - home.x, p.y - home.y) - pat.radius) < 1e-6)
      if (pat.kind === 'line') assert.ok(pat.axis === 'x' ? p.y === home.y && p.x >= home.x - 1e-9 && p.x <= home.x + pat.length + 1e-9 : p.x === home.x && p.y >= home.y - 1e-9 && p.y <= home.y + pat.length + 1e-9)
      if (pat.kind === 'wander') assert.ok(Math.abs(p.x - home.x) <= pat.radius + 1e-9 && Math.abs(p.y - home.y) <= pat.radius + 1e-9)
      if (pat.kind === 'idle') assert.equal(p.moving, false)
      assert.ok(DIRS.includes(p.facing))
    }
  })
  // facing agrees with the actual displacement
  const i = FAKE.patterns.findIndex((p) => p.kind === 'line' && p.axis === 'x')
  const p0 = peerAt(FAKE, i, 5, c), p1 = peerAt(FAKE, i, 5.05, c)
  assert.equal(p0.facing, p1.x > p0.x ? 'right' : 'left')
  assert.ok(hash01(1, 2) >= 0 && hash01(1, 2) < 1 && hash01(1, 2) === hash01(1, 2) && hash01(1, 2) !== hash01(2, 1))
})

// ----------------------------------------------------------------------------- the link

/** A scripted stand-in for the genuine WebSocket. */
class ScriptedReal implements SocketLike {
  static all: ScriptedReal[] = []
  readyState = 0
  sent: string[] = []
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  readonly url: string
  constructor(url: string) { this.url = url; ScriptedReal.all.push(this) }
  open() { this.readyState = 1; this.onopen?.({}) }
  say(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }) }
  send(d: string) { this.sent.push(d) }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code, reason: '', wasClean: true }) }
}

function rig(opts: { rand?: () => number } = {}): NetSim {
  ScriptedReal.all = []
  return createNetSim({ Real: ScriptedReal, config: CFG, text: TEXT, avatars: AVATARS, now: () => Date.now(), ...(opts.rand ? { rand: opts.rand } : {}) })
}

const fakeTimers = () => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })

function connect(sim: NetSim, url = 'ws://x/ws'): { sock: InstanceType<NetSim['Socket']>; got: { at: number; msg: unknown }[]; closes: number[] } {
  const sock = new sim.Socket(url)
  const got: { at: number; msg: unknown }[] = []
  const closes: number[] = []
  sock.onmessage = (e) => got.push({ at: Date.now(), msg: JSON.parse(String(e.data)) })
  sock.onclose = (e) => closes.push(e.code)
  return { sock, got, closes }
}

test('link: with no settings the real socket passes straight through, in both directions', () => {
  fakeTimers()
  const sim = rig()
  const { sock, got } = connect(sim)
  const real = ScriptedReal.all[0]
  let opened = 0
  sock.onopen = () => { opened++ }
  real.open()
  assert.equal(opened, 1)
  assert.equal(sock.readyState, 1)
  real.say({ t: 'x', n: 1 })
  assert.deepEqual(got.map((g) => g.msg), [{ t: 'x', n: 1 }], 'delivered synchronously, nothing queued')
  sock.send('hello')
  assert.deepEqual(real.sent, ['hello'])
  assert.equal(sim.state().mode, 'real')
  assert.equal(sim.state().sockets, 1)
})

test('link: latency and jitter delay both directions and never reorder', () => {
  fakeTimers()
  let k = 0
  const sim = rig({ rand: () => [0.9, 0.1, 0.8, 0.0, 0.5][k++ % 5] })
  sim.setLink({ latencyMs: 100, jitterMs: 80 })
  const { sock, got } = connect(sim)
  const real = ScriptedReal.all[0]
  real.readyState = 1
  sock.onopen = () => {}
  mock.timers.tick(500) // the open event arrives after the link delay
  real.onopen?.({})
  mock.timers.tick(500)
  const base = Date.now()
  for (let i = 0; i < 5; i++) real.say({ t: 'n', i })
  assert.equal(got.length, 0, 'nothing arrives instantly')
  mock.timers.tick(1000)
  assert.deepEqual(got.map((g) => (g.msg as { i: number }).i), [0, 1, 2, 3, 4], 'order kept despite jitter')
  assert.ok(got.every((g) => g.at - base >= 20), 'every message waited at least latency - jitter')
  assert.ok(got.every((g, i) => i === 0 || g.at >= got[i - 1].at), 'arrival times never go backwards')
  sock.send('up1'); sock.send('up2')
  assert.deepEqual(real.sent, [])
  mock.timers.tick(1000)
  assert.deepEqual(real.sent, ['up1', 'up2'])
})

test('link: a stall holds back the whole stream like a TCP retransmission, then releases it in order', () => {
  fakeTimers()
  const draws = [0.0, 0.5, 0.9, 0.9, 0.9, 0.9, 0.9]
  let k = 0
  const sim = rig({ rand: () => draws[k++] ?? 0.9 })
  sim.setLink({ latencyMs: 10, stallChance: 0.5, stallMs: [300, 900] })
  const { sock, got } = connect(sim)
  const real = ScriptedReal.all[0]
  mock.timers.tick(100)
  real.open()
  mock.timers.tick(2000)
  k = 0
  const base = Date.now()
  real.say({ t: 'n', i: 0 }) // draws 0.0 -> stalls for 300 + 0.5 * 600 = 600
  real.say({ t: 'n', i: 1 }) // no stall of its own, but waits behind the first
  mock.timers.tick(609)
  assert.equal(got.length, 0, 'both are held for the stall (latency 10 + 600)')
  mock.timers.tick(2)
  assert.deepEqual(got.map((g) => (g.msg as { i: number }).i), [0, 1])
  assert.ok(got.every((g) => g.at - base >= 610))
  assert.ok(sock.readyState === 1)
})

test('link: drop ends every socket at once with the abnormal code and releases what was queued', () => {
  fakeTimers()
  const sim = rig()
  sim.setLink({ latencyMs: 200 })
  const a = connect(sim), b = connect(sim)
  assert.equal(sim.state().sockets, 2)
  ScriptedReal.all[0].readyState = 1
  ScriptedReal.all[0].say({ t: 'late' })
  assert.equal(sim.drop(), 2)
  assert.deepEqual([a.closes, b.closes], [[1006], [1006]])
  assert.ok(a.sock.readyState === 3 && sim.state().sockets === 0)
  mock.timers.tick(1000)
  assert.equal(a.got.length, 0, 'queued traffic is discarded, not delivered after the close')
  assert.throws(() => a.sock.send('x'))
  assert.equal(sim.drop(), 0)
})

test('link: presets and settings are clamped to the configured limits', () => {
  const sim = rig()
  assert.deepEqual(sim.setLink({ latencyMs: 1e9, jitterMs: -5, stallChance: 7, stallMs: [50, 1e9] }), { latencyMs: CFG.limits.latencyMs, jitterMs: 0, stallChance: 1, stallMs: [50, CFG.limits.stallMs] })
  assert.deepEqual(sim.preset('off'), { ...CFG.link, ...CFG.presets.off, stallMs: CFG.link.stallMs })
  assert.deepEqual(sim.preset('mobile').stallMs, CFG.presets.mobile.stallMs)
  assert.throws(() => sim.preset('nope'))
  assert.equal(sim.setPeers(1e6), CFG.limits.peers)
})

// ----------------------------------------------------------------------------- a whole session through the real NetClient

function bus(): EventBus<GameEvents> & { log: { type: string; payload: unknown }[] } {
  const handlers = new Map<string, Set<(p: unknown) => void>>()
  const log: { type: string; payload: unknown }[] = []
  return {
    log,
    on(type, fn) { const k = String(type); if (!handlers.has(k)) handlers.set(k, new Set()); handlers.get(k)!.add(fn as (p: unknown) => void); return () => handlers.get(k)?.delete(fn as (p: unknown) => void) },
    once(type, fn) { const off = this.on(type, (p) => { off(); fn(p) }); return off },
    emit(type, payload) { log.push({ type: String(type), payload }); for (const f of handlers.get(String(type)) ?? []) f(payload) },
  }
}

test('NetClient against the fake server: online, crowd in view, chat echo, live resize, drop and reconnect', () => {
  fakeTimers()
  const sim = rig()
  sim.setFake(true, 12)
  const g = globalThis as { WebSocket?: unknown }
  const restore = sim.install(g)
  try {
    const events = bus()
    const net = createNetClient(events, () => ({ ...HELLO } as Extract<ClientMsg, { t: 'hello' }>), { url: 'ws://localhost/ws' })
    net.connect()
    assert.equal(net.status, 'connecting')
    mock.timers.tick(50)
    assert.equal(net.status, 'online', 'welcome arrived')
    assert.equal(net.selfId, FAKE.selfId)
    assert.equal(net.online, 13)
    mock.timers.tick(200)
    assert.equal(net.remotePlayers().size, 12, 'the first snapshots put the crowd in view')
    const [first] = [...net.remotePlayers().values()]
    const x0 = first.x, y0 = first.y
    mock.timers.tick(2000)
    const again = net.remotePlayers().get(first.id)!
    assert.ok(again.x !== x0 || again.y !== y0 || !first.moving, 'walkers move between snapshots')

    const chats: string[] = []
    net.on('chat', (m) => chats.push(m.text))
    net.send({ t: 'chat', channel: 'global', text: 'echo?' })
    mock.timers.tick(50)
    assert.deepEqual(chats, ['echo?'])

    sim.setPeers(4)
    mock.timers.tick(250)
    assert.equal(net.remotePlayers().size, 4, 'leave messages remove the surplus')

    assert.equal(sim.drop(), 1)
    assert.equal(net.status, 'connecting', 'the client saw the cut and queued a reconnect')
    mock.timers.tick(2500)
    assert.equal(net.status, 'online', 'and came back to the fake server')
    mock.timers.tick(250)
    assert.equal(net.remotePlayers().size, 4)
    net.disconnect()
    assert.equal(net.status, 'offline')
    mock.timers.tick(10)
    assert.equal(sim.state().sockets, 0, 'the closed socket is gone once its close handshake completed')
  } finally { restore() }
})

test('the fake mode needs no server at all: without a real WebSocket it still serves a session', () => {
  fakeTimers()
  const sim = createNetSim({ Real: null, config: CFG, text: TEXT, avatars: AVATARS, now: () => Date.now() })
  const g = globalThis as { WebSocket?: unknown }
  const restore = sim.install(g)
  try {
    const net = createNetClient(bus(), () => ({ ...HELLO } as Extract<ClientMsg, { t: 'hello' }>), { url: 'ws://nowhere/ws' })
    net.connect()
    mock.timers.tick(300)
    assert.equal(net.status, 'online')
    assert.equal(sim.state().mode, 'fake')
    assert.equal(net.remotePlayers().size, FAKE.peers)
    net.disconnect()
  } finally { restore() }
})

// ----------------------------------------------------------------------------- the commands

test('net commands: presets, range checks, forced drops, and switching the fake server reconnects the client', async () => {
  const sim = rig()
  const calls: string[] = []
  const host = { net: sim, ctx: { net: { status: 'online', disconnect: () => calls.push('disconnect'), connect: () => calls.push('connect') } } } as unknown as DevHost
  const reg = createRegistry(host, COMMANDS, { enums: devEnums({ scenarios: {} }) })
  assert.deepEqual(((await reg.run('net.preset', { name: 'mobile' })) as { link: { latencyMs: number } }).link.latencyMs, CFG.presets.mobile.latencyMs)
  await assert.rejects(reg.run('net.preset', { name: 'nope' }), DevError)
  assert.equal(((await reg.run('net.link', { latencyMs: 250, stallMinMs: 500 })) as { link: { latencyMs: number; stallMs: number[] } }).link.stallMs[0], 500)
  for (const bad of [{ latencyMs: -1 }, { latencyMs: CFG.limits.latencyMs + 1 }, { stallChance: 2 }, { jitterMs: 1e9 }]) await assert.rejects(reg.run('net.link', bad), DevError)
  assert.deepEqual(await reg.run('net.drop'), { dropped: 0 })
  assert.deepEqual(calls, [])
  await reg.run('net.fake', { on: true, peers: 5 })
  assert.deepEqual(calls, ['disconnect', 'connect'])
  assert.deepEqual([sim.state().mode, sim.state().peers], ['fake', 5])
  assert.deepEqual(await reg.run('net.peers', { n: 9 }), { peers: 9 })
  await assert.rejects(reg.run('net.peers', { n: CFG.limits.peers + 1 }), DevError)
  await reg.run('net.fake', { on: false })
  assert.equal(sim.state().mode, 'real')
  await reg.run('net.reconnect')
  await reg.run('net.offline')
  assert.deepEqual(calls, ['disconnect', 'connect', 'disconnect', 'connect', 'disconnect', 'connect', 'disconnect'], 'fake on, fake off, reconnect, offline')
})
