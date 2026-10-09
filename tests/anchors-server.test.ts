// Teleport anchors online (#38): an anchor trip is one same-map move across the world. The server treats it like
// the fly: accepted through the jump budget (no walk rules to pass), never credited as distance, never an error
// or a kick. Starts a real server (real generated world) on an ephemeral port.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { ClientMsg, PublicProfile, ServerMsg } from '../src/shared/protocol.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { startServer } from '../src/server/index.ts'
import { NET } from '../src/server/config.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { coreAnchors, homeAnchor } from '../src/shared/world/anchors.ts'
import { anchorLanding } from '../src/client/world/anchors.ts'

type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>

interface Client {
  ws: WebSocket
  selfId: string
  send(m: ClientMsg | Record<string, unknown>): void
  mark(): number
  waitFor<T extends ServerMsg['t']>(type: T, pred?: (m: Msg<T>) => boolean, opts?: { from?: number; ms?: number }): Promise<Msg<T>>
  all<T extends ServerMsg['t']>(type: T, from?: number): Msg<T>[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tickMs = 1000 / CONTENT.config.net.tickHz

async function join(port: number, name: string, map: string, x: number, y: number): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${port}${NET.protocol.wsPath}`)
  const msgs: ServerMsg[] = []
  const waiters = new Set<() => void>()
  ws.addEventListener('message', (e) => {
    msgs.push(JSON.parse(String(e.data)) as ServerMsg)
    for (const w of [...waiters]) w()
  })
  const c: Client = {
    ws, selfId: '',
    send: (m) => ws.send(JSON.stringify(m)),
    mark: () => msgs.length,
    all: (type, from = 0) => msgs.slice(from).filter((m) => m.t === type) as never,
    waitFor(type, pred = () => true, opts = {}) {
      const from = opts.from ?? msgs.length
      return new Promise((resolve, reject) => {
        let i = from
        const check = () => {
          for (; i < msgs.length; i++) {
            const m = msgs[i]
            if (m.t === type && pred(m as never)) { cleanup(); resolve(m as never); return }
          }
        }
        const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${type}; got ${msgs.slice(from).map((m) => m.t).join(',')}`)) }, opts.ms ?? 4000)
        const cleanup = () => { clearTimeout(timer); waiters.delete(check) }
        waiters.add(check)
        check()
      })
    },
  }
  await new Promise<void>((ok, fail) => { ws.addEventListener('open', () => ok()); ws.addEventListener('error', () => fail(new Error('ws error'))) })
  const profile: PublicProfile = { id: 'x', name: 'x', avatar: 'x', badges: [], dexCaught: 0, party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0 }
  c.send({ t: 'hello', v: CONTENT.config.net.protocolVersion, playerId: crypto.randomUUID(), name, avatar: '', map, x, y, facing: 'down', lead: null, profile })
  c.selfId = (await c.waitFor('welcome', undefined, { from: 0 })).selfId
  return c
}

const move = (c: Client, map: string, x: number, y: number) => c.send({ t: 'move', map, x, y, facing: 'up', moving: false, running: false })

test('an anchor trip is accepted like a fly: one jump, no distance credit, no error, no kick', async () => {
  const world = buildWorld()
  const ow = world.maps[world.startMap]
  const home = homeAnchor(world)!
  // The anchor farthest from the start (several hundred tiles): a walk of that length could never be credited in one move.
  const far = coreAnchors(world).filter((a) => a.kind === 'minor')
    .sort((a, b) => Math.hypot(b.cx - home.cx, b.cy - home.cy) - Math.hypot(a.cx - home.cx, a.cy - home.cy))[0]
  const spot = (a: typeof home) => { const l = anchorLanding(world, a)!; return { x: l.x + 0.5, y: l.y + 0.5 } }
  const H = spot(home), F = spot(far)
  assert.ok(Math.hypot(F.x - H.x, F.y - H.y) > 300, 'a long trip')

  const dataDir = await mkdtemp(pathJoin(tmpdir(), 'ap-anchors-server-'))
  const srv = await startServer({ port: 0, dataDir, distDir: pathJoin(dataDir, 'nd'), quiet: true, pvp: null })
  const clients: Client[] = []
  const open = async (name: string, p: { x: number; y: number }) => { const c = await join(srv.port, name, ow.id, p.x, p.y); clients.push(c); return c }
  try {
    const rider = await open('Rider', H)
    const atFar = await open('FarWatcher', F)
    await rider.waitFor('snapshot', undefined, { from: 0 })
    const jumpBudget = NET.server.rates.jump.count
    assert.ok(jumpBudget >= 3, 'the jump budget covers a there-and-back trip')

    // there: home -> far anchor
    let from = atFar.mark()
    move(rider, ow.id, F.x, F.y)
    await atFar.waitFor('snapshot', (m) => m.players.some((p) => p.id === rider.selfId && p.x === F.x && p.y === F.y), { from })

    // back: far anchor -> home ("回原点"); a second watcher at home sees the arrival
    const atHome = await open('HomeWatcher', H)
    from = atHome.mark()
    move(rider, ow.id, H.x, H.y)
    await atHome.waitFor('snapshot', (m) => m.players.some((p) => p.id === rider.selfId && p.x === H.x && p.y === H.y), { from })
    await sleep(tickMs * 2)

    // nothing was refused, the socket is alive, and neither trip earned distance (the far anchor is hundreds of tiles out)
    assert.equal(rider.all('error').length, 0, 'no error message')
    assert.equal(rider.ws.readyState, WebSocket.OPEN)
    const fi = rider.mark()
    rider.send({ t: 'inspect', target: rider.selfId })
    const profile = (await rider.waitFor('profile', undefined, { from: fi })).profile
    assert.equal(profile.maxDistance ?? 0, 0, 'teleports earn no distance record')

    // the trip did not poison walking: ordinary paced steps from the arrival point are still accepted
    from = atHome.mark()
    for (let i = 1; i <= 3; i++) { move(rider, ow.id, H.x + 0.0, H.y + 0.4 * i); await sleep(90) }
    await atHome.waitFor('snapshot', (m) => m.players.some((p) => p.id === rider.selfId && p.y > H.y + 0.8), { from })
    assert.equal(rider.all('error').length, 0)
  } finally {
    for (const c of clients) c.ws.close()
    await srv.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
