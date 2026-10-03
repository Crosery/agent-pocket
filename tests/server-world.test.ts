// Server on the infinite world: tile-step validation (geo.ts, real generated world), interest hysteresis,
// trade / pvp proximity, server-observed distance records, frontier interiors. Test ports 8812-8813.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { ClientMsg, PublicProfile, ServerMsg } from '../src/shared/protocol.ts'
import type { GameMap } from '../src/shared/types.ts'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { startServer } from '../src/server/index.ts'
import { NET, PRESENCE } from '../src/server/config.ts'
import { loadWorldInfo, type WorldInfo } from '../src/server/world.ts'
import type { PathLimits, WorldGeo } from '../src/server/geo.ts'
import * as W from '../src/shared/world/worldapi.ts'

// ----------------------------------------------------------------------------- helpers

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
        const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${type}; got ${msgs.slice(from).map((m) => m.t).join(',')}`)) }, opts.ms ?? 3000)
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

const move = (c: Client, map: string, x: number, y: number) => c.send({ t: 'move', map, x, y, facing: 'down', moving: true, running: false })

/** Latest position of `id` as seen by `watcher` in its snapshots. */
function seen(watcher: Client, id: string): { map: string; x: number; y: number } | null {
  const snap = watcher.all('snapshot').reverse().find((m) => m.players.some((p) => p.id === id))
  const p = snap?.players.find((q) => q.id === id)
  return snap && p ? { map: snap.map, x: p.x, y: p.y } : null
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-server-world-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

// ----------------------------------------------------------------------------- geo on the real world

const LIM: PathLimits = { maxSteps: 4, margin: NET.server.world.pathMarginTiles, maxNodes: NET.server.world.pathMaxNodes }
const WIDE: PathLimits = { maxSteps: 20, margin: NET.server.world.pathMarginTiles, maxNodes: NET.server.world.pathMaxNodes }

/** A one-way ledge: walking down is reachable, walking up is not (searched near frontier hamlets). */
function findLedge(geo: WorldGeo, ow: GameMap): { top: [number, number]; foot: [number, number] } | null {
  const p = ow.infinite!
  const field = W.collisionField(ow)
  const S = p.size
  for (const h of (p as unknown as { placesIn(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] }).placesIn(-2000, -2000, 0, 0).slice(0, 12)) {
    const cx = Math.floor(h.x / S), cy = Math.floor(h.y / S)
    for (let y = cy * S + 1; y < (cy + 1) * S - 1; y++) {
      for (let x = cx * S + 1; x < (cx + 1) * S - 1; x++) {
        if (!W.isLedge(ow, x, y)) continue
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const fx = x + dx, fy = y + dy
          if (W.elevationAt(ow, fx, fy) !== W.elevationAt(ow, x, y) - 1 || field.at(fx, fy) !== 0) continue
          if (geo.reachable(ow, x, y, fx, fy, LIM) && !geo.reachable(ow, fx, fy, x, y, WIDE)) return { top: [x, y], foot: [fx, fy] }
        }
      }
    }
  }
  return null
}

test('geo: maps, interiors, step rules, chunk accounting and retain on the generated world', async (tc) => {
  const info = await loadWorldInfo()
  if (!info?.geo) { tc.skip('world generator unavailable'); return }
  const geo = info.geo
  const ow = geo.map(geo.overworldId ?? '')
  assert.ok(ow && geo.isInfinite(ow), 'overworld is infinite')
  const p = ow.infinite!
  const places = (p as unknown as { placesIn(x0: number, y0: number, x1: number, y1: number): { id: string; kind?: string; x: number; y: number }[] })
    .placesIn(-1500, -1500, 0, 0)
  const hamlet = places.find((pl) => pl.kind === 'hamlet' && pl.x < 0 && pl.y < 0)
  assert.ok(hamlet, 'a frontier hamlet at negative coordinates')

  await tc.test('static maps, frontier interiors (not cached into world.maps), bogus ids', () => {
    assert.equal(geo.map(geo.startMap)?.id, geo.startMap)
    const interior = `${hamlet.id}:house1`
    const m = geo.map(interior)
    assert.ok(m && !geo.isInfinite(m) && m.width > 0, 'hamlet interior generated on demand')
    assert.equal(info.maps.has(interior), false)
    assert.equal(geo.map('fx:hamlet:99999999:99999999:center'), null)
    assert.equal(geo.map('no-such-map'), null)
    const a = geo.anchorOf(interior)!
    assert.ok(Math.hypot(a.x - hamlet.x, a.y - hamlet.y) <= NET.server.world.interiorReachTiles, 'anchor near the hamlet')
    assert.equal(geo.anchorOf(geo.startMap), null)
  })

  await tc.test('step rules: same tile, blocked tiles, one-way ledges, distance cap', () => {
    const field = W.collisionField(ow)
    const objs = W.objectsInRect(ow, hamlet.x - 40, hamlet.y - 40, hamlet.x + 40, hamlet.y + 40)
    const wall = objs.props.find((pr) => CONTENT.props[pr.prop]?.collide && Math.min(...CONTENT.props[pr.prop].footprint) >= 3)
    assert.ok(wall, 'a 3x3+ blocking prop in the hamlet')
    const inside: [number, number] = [wall.x + 1, wall.y + 1]
    assert.equal(field.at(...inside), 1)
    let free: [number, number] | null = null
    for (const [dx, dy] of [[-2, 0], [0, -2], [4, 0], [0, 4], [-2, 1], [1, -2]]) {
      const q: [number, number] = [inside[0] + dx, inside[1] + dy]
      if (field.at(...q) === 0) { free = q; break }
    }
    assert.ok(free, 'a free tile next to the prop')
    assert.equal(geo.reachable(ow, free[0], free[1], free[0], free[1], LIM), true)
    assert.equal(geo.reachable(ow, free[0], free[1], inside[0], inside[1], WIDE), false, 'cannot walk into a building')
    assert.equal(geo.reachable(ow, free[0], free[1], free[0] + 40, free[1], LIM), false, 'beyond maxSteps')
    const ledge = findLedge(geo, ow)
    assert.ok(ledge, 'a one-way ledge near the frontier hamlets')
    assert.equal(geo.reachable(ow, ...ledge.top, ...ledge.foot, LIM), true, 'ledge drop')
    assert.equal(geo.reachable(ow, ...ledge.foot, ...ledge.top, WIDE), false, 'no walking up a ledge')
  })

  await tc.test('missing chunks are counted before generation and retain() evicts far chunks', () => {
    const fx = -20000 - 7, fy = 15000 + 3
    const S = p.size
    const before = geo.missingChunks(ow, fx, fy, fx + 2, fy + 2)
    assert.ok(before >= 1)
    W.collisionField(ow).at(fx, fy)
    assert.ok(geo.missingChunks(ow, fx, fy, fx + 2, fy + 2) < before, 'reading tiles generated chunks')
    assert.ok(p.peek(Math.floor(fx / S), Math.floor(fy / S)))
    assert.equal(geo.missingChunks(ow, 100, 100, 110, 110), 0, 'core chunks never count')
    geo.retain([{ x: hamlet.x, y: hamlet.y }], NET.server.world.retainRadiusTiles)
    assert.equal(p.peek(Math.floor(fx / S), Math.floor(fy / S)), null, 'far chunk evicted')
    geo.retain([], NET.server.world.retainRadiusTiles)
    assert.equal(p.peek(Math.floor(hamlet.x / S), Math.floor(hamlet.y / S)), null, 'nobody online: nothing kept')
  })
})

// ----------------------------------------------------------------------------- hub with a scripted world

const WALL_X = -10
const ANCHOR = { x: 40, y: 40 }
const fakeMap = (id: string, width: number, height: number) => ({ id, width, height }) as unknown as GameMap
const FAKE_MAPS: Record<string, GameMap> = {
  ow: fakeMap('ow', 64, 64),
  house: fakeMap('house', 8, 8),
  'fx:hamlet:0:0:house1': fakeMap('fx:hamlet:0:0:house1', 10, 8),
}

/** Infinite flat overworld 'ow' with an impassable column x = WALL_X; origin (0, 0). */
function fakeGeo(): WorldGeo {
  return {
    startMap: 'ow',
    overworldId: 'ow',
    map: (id: string) => FAKE_MAPS[id] ?? null,
    isInfinite: (m: GameMap) => m.id === 'ow',
    anchorOf: (id: string) => (id.startsWith('fx:') ? ANCHOR : null),
    distance: (x: number, y: number) => Math.hypot(x, y),
    missingChunks: () => 0,
    reachable(map: GameMap, fx: number, fy: number, tx: number, ty: number, lim: PathLimits) {
      if (Math.max(Math.abs(tx - fx), Math.abs(ty - fy)) > lim.maxSteps) return false
      if (map.id !== 'ow') return true
      return tx !== WALL_X && !(fx < WALL_X && tx > WALL_X) && !(fx > WALL_X && tx < WALL_X)
    },
    retain() {},
  }
}

function fakeWorld(geo: WorldGeo): WorldInfo {
  const spawn = { x: 0, y: 0, facing: 'down' as const }
  return {
    maps: new Map(Object.values(FAKE_MAPS).map((m) => [m.id, { width: m.width, height: m.height, spawn }])),
    startMap: 'ow', badgeIds: new Set(), geo,
  }
}

test('hub on an infinite world: walls, interest hysteresis, proximity, distance records, interiors', async (tc) => {
  await withTempDir(async (dataDir) => {
    const PORT = 8813
    const geo = fakeGeo()
    const srv = await startServer({ port: PORT, dataDir, distDir: pathJoin(dataDir, 'nd'), quiet: true, world: fakeWorld(geo) })
    const clients: Client[] = []
    const open = async (name: string, map: string, x: number, y: number) => { const c = await join(PORT, name, map, x, y); clients.push(c); return c }
    // Every test client shares one IP (net.json maxClientsPerIp): close a subtest's clients before the next one.
    const closeAll = async () => {
      for (const c of clients.splice(0)) c.ws.close()
      await sleep(100)
    }
    try {
      await tc.test('negative / far coordinates are valid positions on the infinite map', async () => {
        const A = await open('Far', 'ow', -250000.5, 99999.5)
        const B = await open('Near', 'ow', -250002.5, 99999.5)
        const snap = await A.waitFor('snapshot', (m) => m.players.some((p) => p.id === B.selfId), { from: 0 })
        assert.equal(snap.map, 'ow')
        // Out of the coordinate range: spawned at the world spawn instead (seen by a watcher there).
        const S = await open('Spawn', 'ow', 0.5, 0.5)
        const O = await open('Outside', 'ow', NET.server.world.maxCoordTiles + 10, 0)
        await S.waitFor('snapshot', (m) => m.players.some((p) => p.id === O.selfId && p.x === 0 && p.y === 0), { from: 0 })
        await closeAll()
      })

      await tc.test('walking through a wall spends the jump budget; walks never do', async () => {
        // 2 tiles apart: within the per-move speed tolerance, so only the tile rules can reject the crossing.
        const west = { x: WALL_X - 0.5, y: -30.5 }, east = { x: WALL_X + 1.5, y: -30.5 }
        const budget = NET.server.rates.jump.count
        const expected = budget % 2 === 1 ? east : west
        const Wt = await open('WallWatch', 'ow', WALL_X - 2.5, -28.5)
        const J = await open('Ghost', 'ow', west.x, west.y)
        for (let i = 1; i <= budget + 1; i++) {
          const q = i % 2 === 1 ? east : west
          move(J, 'ow', q.x, q.y)
        }
        await sleep(tickMs * 4)
        assert.deepEqual(seen(Wt, J.selfId), { map: 'ow', ...expected })
        // Budget exhausted: ordinary walks on the same side are still accepted.
        const dir = expected === west ? -1 : 1
        const from = Wt.mark()
        for (let i = 1; i <= 3; i++) move(J, 'ow', expected.x + dir * i, expected.y)
        await Wt.waitFor('snapshot', (m) => m.players.some((p) => p.id === J.selfId && p.x === expected.x + dir * 3), { from })
        await closeAll()
      })

      await tc.test('interest: join at viewRadius, leave only beyond viewRadius + leaveMargin', async () => {
        const R = PRESENCE.viewRadiusTiles, L = PRESENCE.leaveMarginTiles
        const base = { x: 3000.5, y: 3000.5 }
        const A = await open('Eye', 'ow', base.x, base.y)
        const B = await open('Walker', 'ow', base.x + 1, base.y)
        await A.waitFor('join', (m) => m.player.id === B.selfId, { from: 0 })
        let from = A.mark()
        move(B, 'ow', base.x + R + L / 2, base.y)
        await A.waitFor('snapshot', (m) => m.players.some((p) => p.id === B.selfId && p.x === base.x + R + L / 2), { from })
        assert.equal(A.all('leave', from).length, 0, 'inside the leave margin: still visible')
        move(B, 'ow', base.x + R + L + 2, base.y)
        await A.waitFor('leave', (m) => m.id === B.selfId, { from })
        from = A.mark()
        move(B, 'ow', base.x + R + L / 2, base.y)
        await sleep(tickMs * 4)
        assert.equal(A.all('join', from).length, 0, 'not re-joined until inside viewRadius')
        move(B, 'ow', base.x + R - 1, base.y)
        await A.waitFor('join', (m) => m.player.id === B.selfId, { from })
        const C = await open('Faraway', 'ow', base.x + 10 * R, base.y)
        await sleep(tickMs * 4)
        assert.ok(!A.all('snapshot').some((m) => m.players.some((p) => p.id === C.selfId)), 'far players never reach the snapshot')
        await closeAll()
      })

      await tc.test('trade and pvp need proximity (request and acceptance)', async () => {
        const base = { x: -5000.5, y: 7000.5 }
        const A = await open('Ann', 'ow', base.x, base.y)
        const B = await open('Bea', 'ow', base.x + 2, base.y)
        const far = Math.max(PRESENCE.tradeRangeTiles ?? 0, PRESENCE.pvpRangeTiles ?? 0) + 5
        const C = await open('Cid', 'ow', base.x + far, base.y)
        const H = await open('Hal', 'house', 2, 2)
        if (PRESENCE.tradeRangeTiles !== null) {
          let fa = A.mark()
          A.send({ t: 'trade.request', to: C.selfId })
          const e = await A.waitFor('error', (m) => m.code === 'too_far', { from: fa })
          assert.equal(e.message, t('net.error.too_far'))
          A.send({ t: 'trade.request', to: H.selfId })
          await A.waitFor('error', (m) => m.code === 'too_far', { from: fa })
          // In range at request time, out of range at acceptance.
          fa = A.mark()
          const fb = B.mark()
          A.send({ t: 'trade.request', to: B.selfId })
          await B.waitFor('trade.requested', (m) => m.from === A.selfId, { from: fb })
          move(B, 'ow', base.x + far, base.y + 1)
          await sleep(tickMs * 2)
          B.send({ t: 'trade.respond', from: A.selfId, accept: true })
          await B.waitFor('error', (m) => m.code === 'too_far', { from: fb })
          await B.waitFor('system', (m) => m.text === t('net.trade.tooFar', { name: 'Ann' }), { from: fb })
          const cancelled = await A.waitFor('trade.cancelled', undefined, { from: fa })
          assert.equal(cancelled.reason, t('net.trade.tooFar', { name: 'Bea' }))
          move(B, 'ow', base.x + 2, base.y)
          await sleep(tickMs * 2)
        }
        if (PRESENCE.pvpRangeTiles !== null) {
          let fa = A.mark()
          A.send({ t: 'pvp.challenge', to: C.selfId })
          const e = await A.waitFor('error', (m) => m.code === 'pvp_too_far', { from: fa })
          assert.equal(e.message, t('multiplayer.serverError.pvp_too_far', { name: 'Cid' }))
          fa = A.mark()
          const fb = B.mark()
          A.send({ t: 'pvp.challenge', to: B.selfId })
          await B.waitFor('pvp.challenged', (m) => m.from === A.selfId, { from: fb })
          move(B, 'ow', base.x + far, base.y + 1)
          await sleep(tickMs * 2)
          B.send({ t: 'pvp.respond', from: A.selfId, accept: true })
          await B.waitFor('error', (m) => m.code === 'pvp_too_far', { from: fb })
          await A.waitFor('error', (m) => m.code === 'pvp_too_far', { from: fa })
          assert.equal(A.all('pvp.start', fa).length + B.all('pvp.start', fb).length, 0)
        }
        await closeAll()
      })

      await tc.test('distance record: paced walks count, teleports and spam do not', async () => {
        const K = await open('Kai', 'ow', 0.5, 0.5)
        const steps = 20
        for (let i = 1; i <= steps; i++) { move(K, 'ow', 0.5 + i, 0.5); await sleep(80) }
        await sleep(tickMs)
        const fk = K.mark()
        K.send({ t: 'leaderboard' })
        const lb = await K.waitFor('leaderboard', undefined, { from: fk })
        const mine = lb.entries.find((e) => e.id === K.selfId)
        assert.ok(mine && (mine.maxDistance ?? 0) >= steps - NET.server.world.distanceStepTiles && (mine.maxDistance ?? 0) <= steps, `record ${mine?.maxDistance}`)
        const fi = K.mark()
        K.send({ t: 'inspect', target: K.selfId })
        assert.equal((await K.waitFor('profile', undefined, { from: fi })).profile.maxDistance, mine?.maxDistance)

        const T = await open('Tele', 'ow', 0.5, 0.5)
        move(T, 'ow', 4000.5, 0.5)
        for (let i = 1; i <= 8; i++) { move(T, 'ow', 4000.5 + i, 0.5); await sleep(60) }
        // Spam within the per-message tolerance: accepted as walks, but credited at most at top speed.
        const S = await open('Spam', 'ow', 0.5, 0.5)
        for (let i = 1; i <= 30; i++) move(S, 'ow', 0.5 + i * 1.9, 0.5)
        await sleep(tickMs * 2)
        await closeAll()
        const V = await open('Viewer', 'ow', 0.5, 0.5)
        V.send({ t: 'leaderboard' })
        const after = await V.waitFor('leaderboard', undefined, { from: 0 })
        const rec = (id: string) => after.entries.find((e) => e.id === id)?.maxDistance ?? 0
        assert.equal(rec(K.selfId), steps, 'flushed on disconnect')
        assert.equal(rec(T.selfId), 0, 'walking after a teleport beyond the known range earns nothing')
        const spamCap = Math.max(...Object.values(CONTENT.config.movement)) * NET.server.moveSpeedSlack * 0.5
        assert.ok(rec(S.selfId) < spamCap, `spammed walks are capped by top speed (${rec(S.selfId)})`)
        await closeAll()
      })

      await tc.test('frontier interiors: entered near their site only; unknown maps rejected', async () => {
        const In = await open('Inside', 'fx:hamlet:0:0:house1', 3, 3)
        const Near = await open('Visitor', 'ow', ANCHOR.x + 5, ANCHOR.y)
        const Far = await open('Stranger', 'ow', ANCHOR.x + NET.server.world.interiorReachTiles + 50, ANCHOR.y)
        move(Far, 'fx:hamlet:0:0:house1', 4, 4)
        move(Near, 'fx:hamlet:0:0:house1', 5, 5)
        await In.waitFor('join', (m) => m.player.id === Near.selfId, { from: 0 })
        const from = In.mark()
        move(Near, 'fx:hamlet:9:9:house1', 5, 5)
        move(Near, 'fx:hamlet:0:0:house1', 5, 6)
        await In.waitFor('snapshot', (m) => m.players.some((p) => p.id === Near.selfId && p.y === 6), { from })
        assert.ok(!In.all('snapshot').some((m) => m.players.some((p) => p.id === Far.selfId)), 'far player could not enter')
      })
    } finally {
      for (const c of clients) c.ws.close()
      await srv.close()
    }
  })
})

// ----------------------------------------------------------------------------- hub on the generated world

test('generated world: two players walk a frontier hamlet and enter its interior', async (tc) => {
  const info = await loadWorldInfo()
  if (!info?.geo) { tc.skip('world generator unavailable'); return }
  const geo = info.geo
  const ow = geo.map(geo.overworldId ?? '')!
  const p = ow.infinite as unknown as { placesIn(x0: number, y0: number, x1: number, y1: number): { id: string; kind?: string; x: number; y: number }[] }
  const hamlet = p.placesIn(-1500, -1500, 0, 0).find((pl) => pl.kind === 'hamlet')!
  const field = W.collisionField(ow)
  // A short walkable path from a free tile near the hamlet centre.
  let start: [number, number] | null = null
  for (let r = 1; r < 12 && !start; r++) {
    for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) if (!start && field.at(hamlet.x + dx, hamlet.y + dy) === 0) start = [hamlet.x + dx, hamlet.y + dy]
  }
  assert.ok(start)
  const path: [number, number][] = [start]
  const seenTiles = new Set([start.join()])
  for (let i = 0; i < 8; i++) {
    const [x, y] = path[path.length - 1]
    const next = ([[1, 0], [0, 1], [-1, 0], [0, -1]] as const).map(([dx, dy]) => [x + dx, y + dy] as [number, number])
      .find((q) => !seenTiles.has(q.join()) && geo.reachable(ow, x, y, q[0], q[1], LIM))
    if (!next) break
    seenTiles.add(next.join())
    path.push(next)
  }
  assert.ok(path.length >= 4, 'found a walkable path')
  await withTempDir(async (dataDir) => {
    const PORT = 8812
    const srv = await startServer({ port: PORT, dataDir, distDir: pathJoin(dataDir, 'nd'), quiet: true, pvp: null })
    const clients: Client[] = []
    try {
      const [sx, sy] = path[0]
      const A = await join(PORT, 'Ada', ow.id, sx + 0.5, sy + 0.5)
      const B = await join(PORT, 'Bo', ow.id, sx + 0.5, sy + 0.5)
      clients.push(A, B)
      await A.waitFor('snapshot', (m) => m.players.some((q) => q.id === B.selfId), { from: 0 })
      let from = A.mark()
      for (const [x, y] of path.slice(1)) { move(B, ow.id, x + 0.5, y + 0.5); await sleep(60) }
      const [lx, ly] = path[path.length - 1]
      await A.waitFor('snapshot', (m) => m.players.some((q) => q.id === B.selfId && q.x === lx + 0.5 && q.y === ly + 0.5), { from })
      const door = `${hamlet.id}:house1`
      const inside = geo.map(door)!
      from = A.mark()
      move(B, door, inside.spawn.x + 0.5, inside.spawn.y + 0.5)
      await A.waitFor('leave', (m) => m.id === B.selfId, { from })
      from = A.mark()
      move(A, door, inside.spawn.x + 0.5, inside.spawn.y + 0.5)
      const snap = await A.waitFor('snapshot', (m) => m.map === door && m.players.some((q) => q.id === B.selfId), { from })
      assert.equal(snap.map, door)
      assert.equal(info.maps.has(door), false)
    } finally {
      for (const c of clients) c.ws.close()
      await srv.close()
    }
  })
})
