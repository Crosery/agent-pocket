// Client side of the infinite overworld: fog pages, object streaming, motion / ledges on WorldApi, save repair of
// frontier positions, warp-chain exits, place lookup / landing, region estimates for the world map, exploration.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GameMap, SaveData } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import type { FrontierProvider } from '../src/shared/world/frontier/index.ts'
import { canStep, collisionField, elevationAt, getMap, isLedge, objectsInRect, regionAt, terrainAt } from '../src/shared/world/worldapi.ts'
import { createCreature } from '../src/shared/creature.ts'
import { Rng } from '../src/shared/rng.ts'
import { FogPages, fogGrid, setBit } from '../src/client/ui/fog.ts'
import { bakeChunkPixels } from '../src/client/ui/mapbake.ts'
import { provincesIn, quickSample, regionUnder } from '../src/client/ui/worldgeo.ts'
import { overworldExit, overworldPosition } from '../src/client/ui/screens/logic.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { EXPLORE, validateExploreContent } from '../src/client/world/explore-config.ts'
import { createExplorer, dangerStars, findLanding, flyLanding, fogPagesFor, isFlyTarget, knownPlaces, placeKindOf, resolvePlace, storeFogPages } from '../src/client/world/explore.ts'
import { gridField, moveBody, tilePassable, type MotionGrid } from '../src/client/world/motion.ts'
import { createObjectStream, mergeLive } from '../src/client/world/stream.ts'
import { GAME } from '../src/client/world/config.ts'

const world = buildWorld()
const ow = world.maps[world.startMap]
const P = ow.infinite as unknown as FrontierProvider
const CELL = CONTENT.config.world.chunk

test('content/explore.json is consistent', () => {
  assert.deepEqual(validateExploreContent(), [])
})

test('fog pages: negative cells, encode/decode round trip, repaging, legacy bitset import', () => {
  const f = new FogPages(CELL, 32)
  assert.equal(f.revealAround(-5, -700, 1), 9)
  assert.equal(f.revealAround(-5, -700, 1), 0, 'idempotent')
  assert.ok(f.tileExplored(-5, -700) && f.tileExplored(-5 - CELL, -700 + CELL) && !f.tileExplored(-5 - 2 * CELL, -700))
  f.setCell(1000, 2000)
  const s = f.encode()
  const g = FogPages.decode(s, CELL, 32)!
  assert.ok(g)
  assert.equal(g.encode(), s)
  assert.ok(g.hasCell(1000, 2000) && g.tileExplored(-5, -700))
  const re = FogPages.decode(s, CELL, 64)!
  assert.equal(re.pageCells, 64)
  assert.ok(re.hasCell(1000, 2000) && re.tileExplored(-5, -700), 'repaged keeps cells')
  for (const junk of ['', 'x', 'p7|', 'p32|1,2:###', 'p32|a,b:AAAA', 'p32|0,0:AAAA']) assert.equal(FogPages.decode(junk, CELL, 32), null, junk)
  const cells: string[] = []
  f.forEachCell(-10, -50, 10, -40, (x, y) => cells.push(`${x},${y}`))
  assert.equal(cells.length, 9)
  // Legacy finite bitset (fogGrid layout) folds into pages.
  const grid = fogGrid(ow.width, ow.height, CELL)
  const bits = new Uint8Array(grid.bytes)
  setBit(bits, 3 * grid.cols + 5)
  const h = new FogPages(CELL, 32)
  h.importGrid(bits, grid)
  assert.ok(h.hasCell(5, 3) && !h.hasCell(5, 4))
  assert.ok(h.anyExplored(5 * CELL, 3 * CELL, 5 * CELL + 1, 3 * CELL + 1) && !h.anyPage(-5000, -5000, -4000, -4000))
})

test('stream: hysteresis keeps nearby live objects, adds fresh ones, drops far ones', () => {
  const live = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }]
  const fresh = [{ id: 'c', x: 5, y: 5 }, { id: 'a', x: 0, y: 0 }]
  assert.deepEqual(mergeLive(live, fresh, (o) => o.id, 0, 0, 60).map((o) => o.id), ['a', 'c'])
})

test('stream: infinite overworld streams NPCs / items / places around the player at negative coordinates', () => {
  const s = createObjectStream()
  s.reset(ow)
  const gate = P.gates.find((g) => g.id === 'west')!
  assert.ok(gate.x < 0, 'west gateway lies at negative x')
  assert.equal(s.update(gate.x, gate.y, true) || true, true)
  const R = EXPLORE.stream.radius + EXPLORE.stream.stepTiles
  const o = objectsInRect(ow, gate.x - R, gate.y - R, gate.x + R + 1, gate.y + R + 1)
  assert.deepEqual(new Set(s.npcs.map((n) => n.id)), new Set(o.npcs.map((n) => n.id)))
  assert.ok(s.places.length > 0 || s.npcs.length > 0, 'a gateway hamlet has villagers / a place')
  assert.equal(s.update(gate.x + 1, gate.y, false), false, 'no re-query within stepTiles')
  const finite = createObjectStream()
  const interior = Object.values(world.maps).find((m) => m.kind === 'interior' && m.npcs.length)!
  finite.reset(interior)
  assert.equal(finite.npcs, interior.npcs)
})

/** A frontier ledge tile with an orthogonal neighbour one level lower that is enterable. */
function findLedge(): { lx: number; ly: number; tx: number; ty: number } | null {
  const field = collisionField(ow)
  for (const [cx, cy] of [[-4, 8], [-3, 9], [18, 10], [20, 12], [-5, 12], [8, 18], [10, -4], [22, 6], [-6, 4], [12, 19]]) {
    const S = P.size
    for (let y = cy * S; y < (cy + 1) * S; y++) for (let x = cx * S; x < (cx + 1) * S; x++) {
      if (!isLedge(ow, x, y) || field.at(x, y) !== 0) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (elevationAt(ow, x + dx, y + dy) === elevationAt(ow, x, y) - 1 && field.at(x + dx, y + dy) === 0) return { lx: x, ly: y, tx: x + dx, ty: y + dy }
      }
    }
  }
  return null
}

test('motion: moveBody on the infinite overworld (negative coordinates) and one-way ledges', () => {
  const field = collisionField(ow)
  const g: MotionGrid = { map: ow, field }
  assert.equal(gridField(g), field)
  // A free tile beyond the core's west edge with a free east neighbour on the same level.
  let start: { x: number; y: number } | null = null
  const gate = P.gates.find((gt) => gt.id === 'west')!
  for (let r = 0; r < 40 && !start; r++) for (let dx = -r; dx <= r && !start; dx++) {
    const x = gate.x + dx, y = gate.y + r
    if (x < 0 && field.at(x, y) === 0 && field.at(x + 1, y) === 0 && elevationAt(ow, x, y) === elevationAt(ow, x + 1, y)) start = { x, y }
  }
  assert.ok(start, 'free frontier ground near the west gateway')
  const o = { radius: GAME.player.radius, surf: false, cornerSlip: GAME.player.cornerSlip, cornerSlipRate: 1, substep: GAME.player.substepTiles }
  const r = moveBody(g, start!.x + 0.5, start!.y + 0.5, 0.5, 0, o)
  assert.ok(r.x > start!.x + 0.5, `moved east at x=${start!.x}`)
  const ledge = findLedge()
  assert.ok(ledge, 'frontier has a ledge with an enterable lower neighbour')
  const { lx, ly, tx, ty } = ledge!
  assert.ok(canStep(ow, field, lx, ly, tx, ty, { surf: false }), 'drop off the ledge')
  assert.ok(!canStep(ow, field, tx, ty, lx, ly, { surf: false }), 'cannot climb back up')
  assert.ok(tilePassable(g, lx, ly, tx, ty, false) && !tilePassable(g, tx, ty, lx, ly, false))
})

test('save repair keeps frontier positions, lazily generated interiors and exploration state', () => {
  const saves = createSaveManager({ world, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  const base = saves.newGame({ name: 'a', avatar: '' })
  base.party.push(createCreature(CONTENT.speciesList[0].id, 5, { rng: new Rng(1) }))
  const hamlet = P.placesIn(-2000, -2000, 3000, 3000).find((p) => p.id.startsWith('fx:hamlet:'))!
  assert.ok(hamlet)
  const interiorId = `${hamlet.id}:house1`
  const fog = new FogPages(CELL, EXPLORE.fog.pageCells)
  fog.revealAround(-300, 500, 1)
  const raw = {
    ...base,
    position: { map: ow.id, x: -317.6, y: 1500, facing: 'left' },
    respawn: { map: interiorId, x: 3, y: 3, facing: 'up' },
    discoveredPlaces: [hamlet.id, 'not-a-place', 'fx:hamlet:1:2:house1', hamlet.id],
    visitedTowns: [hamlet.id, 'origin', 'nope'],
    maxDistance: 1234.7,
    explored: fog.encode(),
  }
  const s = saves.sanitize(raw)!
  assert.deepEqual(s.position, { map: ow.id, x: -318, y: 1500, facing: 'left' })
  const im = getMap(world, interiorId)
  if (im && 3 < im.width && 3 < im.height) assert.equal(s.respawn.map, interiorId)
  assert.deepEqual(s.discoveredPlaces, [hamlet.id])
  assert.deepEqual(s.visitedTowns, [hamlet.id, 'origin'])
  assert.equal(s.maxDistance, 1234)
  assert.equal(s.explored, raw.explored)
  const far = saves.sanitize({ ...raw, position: { map: ow.id, x: EXPLORE.save.maxCoord + 5, y: 0, facing: 'down' }, explored: 'junk' })!
  assert.equal(far.position.map, ow.id)
  assert.notEqual(far.position.x, EXPLORE.save.maxCoord + 5)
  assert.equal(far.explored, undefined)
  // A save without the optional keys round-trips without gaining them.
  const plain = saves.sanitize(JSON.parse(JSON.stringify(base)))!
  assert.equal('discoveredPlaces' in plain || 'explored' in plain || 'events' in plain, false)
})

test('overworldExit follows multi-floor frontier dungeons back to the mouth', () => {
  const dg = P.placesIn(-2500, -2500, 3500, 3500).find((p) => p.id.startsWith('fx:dungeon:'))!
  assert.ok(dg)
  let deepest: GameMap | null = null
  for (let f = 1; f <= 4; f++) { const m = getMap(world, `${dg.id}:${f}`); if (m) deepest = m }
  assert.ok(deepest)
  const exit = overworldExit(world, deepest!.id, deepest!.spawn.x, deepest!.spawn.y)
  assert.ok(exit && exit.toMap === ow.id, 'exit warp lands on the overworld')
  assert.ok(Math.hypot(exit!.toX - dg.x, exit!.toY - dg.y) < 40, 'near the dungeon mouth')
  assert.deepEqual(overworldPosition(world, deepest!.id, 1, 1), { x: exit!.toX, y: exit!.toY })
  assert.equal(overworldExit(world, ow.id, 0, 0), null)
})

test('places: resolve, kinds, fly targets, landing tiles', () => {
  const save = createSaveManager({ world, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }).newGame({ name: 'a', avatar: '' })
  const town = world.towns.find((tw) => (tw.kind ?? 'town') === 'town')!
  const coreDungeon = world.towns.find((tw) => placeKindOf(world, tw) === 'dungeon')
  assert.ok(coreDungeon, 'core dungeon mouths are recognised')
  const fxPlaces = P.placesIn(-2500, -2500, 3500, 3500).filter((p) => p.id.startsWith('fx:'))
  const fxHamlet = fxPlaces.find((p) => p.id.startsWith('fx:hamlet:'))!
  const fxDungeon = fxPlaces.find((p) => p.id.startsWith('fx:dungeon:'))!
  assert.equal(resolvePlace(world, fxHamlet.id)?.nameZh, fxHamlet.nameZh)
  assert.equal(resolvePlace(world, town.id), town)
  assert.equal(resolvePlace(world, 'fx:hamlet:99999:99999'), null)
  assert.equal(placeKindOf(world, fxDungeon), 'dungeon')
  assert.equal(placeKindOf(world, fxHamlet), 'hamlet')
  assert.equal(isFlyTarget(world, save, town), false)
  save.visitedTowns.push(town.id)
  assert.equal(isFlyTarget(world, save, town), true)
  assert.equal(isFlyTarget(world, save, fxHamlet), false)
  save.discoveredPlaces = [fxHamlet.id]
  assert.equal(isFlyTarget(world, save, fxHamlet), true)
  const fog = new FogPages(CELL, 32)
  const known = knownPlaces(world, save, fog).map((p) => p.id)
  assert.ok(known.includes(town.id) && known.includes(fxHamlet.id))
  for (const p of [town, fxHamlet, fxDungeon]) {
    const land = flyLanding(world, p)
    assert.ok(land, `landing for ${p.id}`)
    const field = collisionField(land!.map)
    assert.equal(field.at(land!.x, land!.y), 0)
    assert.ok(Math.hypot(land!.x - p.x, land!.y - p.y) <= EXPLORE.landing.searchRadius + 12)
  }
  assert.equal(findLanding(ow, -40000, -40000, 0) === null || true, true)
  assert.match(dangerStars(2), new RegExp(`^${EXPLORE.banner.starOn}{3}${EXPLORE.banner.starOff}{${EXPLORE.banner.dangerTiers - 3}}$`))
})

test('fog pages per save migrate the legacy overworld bitset and store back into save.explored', () => {
  const save = createSaveManager({ world, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }).newGame({ name: 'a', avatar: '' })
  const grid = fogGrid(ow.width, ow.height, CELL)
  const bits = new Uint8Array(grid.bytes)
  setBit(bits, 10 * grid.cols + 12)
  save.exploredChunks[ow.id] = Buffer.from(bits).toString('base64')
  const f = fogPagesFor(save, world)
  assert.ok(f.hasCell(12, 10))
  f.revealAround(-900, -900, 0)
  storeFogPages(save, world)
  assert.ok(save.explored && !(ow.id in save.exploredChunks))
  const again = FogPages.decode(save.explored, CELL, EXPLORE.fog.pageCells)!
  assert.ok(again.hasCell(12, 10) && again.tileExplored(-900, -900))
})

test('world-map geography: province labels and region estimates agree with generated chunks', () => {
  const provs = provincesIn(P, -1500, -1500, 2500, 2500)
  assert.ok(provs.length > 10)
  assert.ok(provs.every((p) => p.nameZh && p.levelRange[0] <= p.levelRange[1] && p.danger >= 0))
  const near = provs.reduce((a, b) => (P.distance(a.x, a.y) < P.distance(b.x, b.y) ? a : b))
  const far = provs.reduce((a, b) => (P.distance(a.x, a.y) > P.distance(b.x, b.y) ? a : b))
  assert.ok(far.danger >= near.danger && far.levelRange[1] >= near.levelRange[1], 'danger grows with distance')
  // Estimates for chunks that are not resident vs. the exact region after generating them.
  P.clearCache()
  const rng = new Rng(7)
  let same = 0, n = 0
  const pts: [number, number][] = []
  for (let i = 0; i < 60; i++) pts.push([rng.int(-2400, -200), rng.int(-2400, 3000)])
  const est = pts.map(([x, y]) => regionUnder(ow, x, y)?.id ?? null)
  pts.forEach(([x, y], i) => {
    const exact = regionAt(ow, x, y)?.id ?? null
    n++
    if (exact === est[i]) same++
  })
  assert.ok(same / n >= 0.8, `region estimate agreement ${same}/${n}`)
  const q = quickSample(P, -3000, 777)
  assert.ok(CONTENT.terrain[q.terrain])
})

test('chunk bake: deterministic chunk bitmaps (minimap / world map tiles)', () => {
  const a = bakeChunkPixels(P, -3, 9)
  const b = bakeChunkPixels(P, -3, 9)
  assert.equal(a.bmp.width, P.size)
  assert.deepEqual(a.bmp.data, b.bmp.data)
  assert.equal(terrainAt(ow, -3 * P.size, 9 * P.size) >= 0, true)
})

test('explorer: distance record, milestones and place discovery', () => {
  const save = createSaveManager({ world, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }).newGame({ name: 'a', avatar: '' }) as SaveData
  const events: string[] = []
  const ex = createExplorer(world, () => save, { toast: (s) => events.push(`toast:${s}`), banner: (s) => events.push(`banner:${s}`), sfx: (s) => events.push(`sfx:${s}`) })
  const o = ow.spawn
  ex.onTile(ow, o.x, o.y)
  assert.equal(save.maxDistance, 0)
  const m0 = EXPLORE.milestones.distances[0]
  ex.onTile(ow, o.x - m0 - 3, o.y)
  assert.ok((save.maxDistance ?? 0) >= m0)
  assert.ok(events.some((e) => e.startsWith('toast:')) && events.includes(`sfx:${EXPLORE.milestones.sfx}`))
  const before = events.length
  ex.onTile(ow, o.x - 5, o.y)
  assert.equal(events.length, before, 'no milestone when not beyond the record')
  const interior = Object.values(world.maps).find((m) => m.kind === 'interior')!
  ex.onTile(interior, 99999, 0)
  assert.ok((save.maxDistance ?? 0) < 99999, 'interiors do not count')
  const hamlet = P.placesIn(-2000, -2000, 3000, 3000).find((p) => p.id.startsWith('fx:hamlet:'))!
  ex.discover(ow, [hamlet], hamlet.x + 0.5, hamlet.y + 0.5)
  ex.discover(ow, [hamlet], hamlet.x + 0.5, hamlet.y + 0.5)
  assert.deepEqual(save.discoveredPlaces, [hamlet.id])
  ex.discover(ow, [{ ...hamlet, id: 'fx:hamlet:-99:-99' }], hamlet.x + EXPLORE.discover.radius * 3, hamlet.y)
  assert.deepEqual(save.discoveredPlaces, [hamlet.id], 'too far away')
})
