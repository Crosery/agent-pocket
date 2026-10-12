// Teleport anchors online (#38): an anchor trip is one same-map move across the world. The server treats it like
// the fly: accepted through the jump budget (no walk rules to pass), never credited as distance, never an error
// or a kick. Starts a real server (real generated world) on an ephemeral port.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { CONTENT } from '../src/shared/content/index.ts'
import { startServer } from '../src/server/index.ts'
import { NET } from '../src/server/config.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { coreAnchors, homeAnchor } from '../src/shared/world/anchors.ts'
import { anchorLanding } from '../src/client/world/anchors.ts'
import { joinAuthenticatedClient, type TestWsClient } from './net-fixture.ts'

const tickMs = 1000 / CONTENT.config.net.tickHz

const move = (c: TestWsClient, map: string, x: number, y: number) =>
  c.send({ t: 'move', map, x, y, facing: 'up', moving: false, running: false })
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
  const clients: TestWsClient[] = []
  const open = async (name: string, p: { x: number; y: number }) => {
    const c = await joinAuthenticatedClient(srv, { name, map: ow.id, x: p.x, y: p.y })
    move(c, ow.id, p.x, p.y)
    clients.push(c)
    return c
  }
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
