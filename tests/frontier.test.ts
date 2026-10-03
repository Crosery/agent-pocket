import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { GameMap, MapChunk } from '../src/shared/types.ts'
import { buildWorld, worldBuildInfo } from '../src/shared/world/index.ts'
import {
  canStep, collisionField, elevationAt, getMap, isInfinite, objectsInRect, regionAt, terrainAt, warpAt,
} from '../src/shared/world/worldapi.ts'
import { COLLISION_BLOCKED, COLLISION_FREE } from '../src/shared/world/collision.ts'
import { FrontierProvider } from '../src/shared/world/frontier/provider.ts'
import { WORLD_CONTENT } from '../src/shared/world/data.ts'
import { FRONTIER_CONTENT } from '../src/shared/world/frontier/config.ts'
import { registerChunkDecorator, unregisterDecorator } from '../src/shared/world/frontier/decorate.ts'
import { baseArea } from '../src/shared/world/frontier/base.ts'
import { newColumn } from '../src/shared/world/frontier/fields.ts'
import { parseRegionId, provincePoint } from '../src/shared/world/frontier/regions.ts'
import type { FrontierSite } from '../src/shared/world/frontier/sites.ts'

// Budgets (generous for slow CI; typical numbers are reported in docs/world.md).
const CHUNK_BUDGET_MS = 8
const SAMPLE_BUDGET_MS = 600

const world = buildWorld()
const info = worldBuildInfo(world)
const ow = world.maps[world.startMap]
const P = ow.infinite as FrontierProvider
const S = P.size
const gates = info.features.gates
const fresh = () => new FrontierProvider({ seed: world.seed, overworldId: ow.id, core: ow, gates, origin: { x: ow.spawn.x, y: ow.spawn.y }, corePlaces: () => world.towns })

function digest(ch: MapChunk): string {
  let h = 0x811c9dc5
  const mix = (v: number) => { h = Math.imul(h ^ v, 0x01000193) }
  for (const a of [ch.terrain, ch.elevation, ch.region]) for (let i = 0; i < a.length; i++) mix(a[i])
  const s = JSON.stringify([ch.regionIds, ch.props, ch.npcs, ch.signs, ch.items, ch.warps, ch.lights, ch.places])
  for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i))
  return (h >>> 0).toString(16)
}

const gateSite = (id: string): FrontierSite => {
  const g = gates.find((x) => x.id === id)!
  const [sx, sy] = P.grid.cellOf(g.x, g.y)
  return P.grid.siteAt(sx, sy)!
}

/** 4-neighbour walking BFS with the WorldApi step rules inside a box. */
function walkBfs(map: GameMap, from: { x: number; y: number }, x0: number, y0: number, x1: number, y1: number): (x: number, y: number) => boolean {
  const W = x1 - x0, H = y1 - y0
  const seen = new Uint8Array(W * H)
  const q = new Int32Array(W * H)
  const field = collisionField(map)
  let qh = 0, qt = 0
  const s0 = (from.y - y0) * W + (from.x - x0)
  seen[s0] = 1; q[qt++] = s0
  while (qh < qt) {
    const i = q[qh++]
    const x = (i % W) + x0, y = Math.floor(i / W) + y0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy
      if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue
      const j = (ny - y0) * W + (nx - x0)
      if (seen[j] || !canStep(map, field, x, y, nx, ny, { surf: false })) continue
      seen[j] = 1; q[qt++] = j
    }
  }
  return (x, y) => x >= x0 && y >= y0 && x < x1 && y < y1 && seen[(y - y0) * W + (x - x0)] === 1
}

test('buildWorld attaches the frontier provider to the overworld', () => {
  assert.ok(isInfinite(ow))
  assert.deepEqual(P.core, { x: 0, y: 0, width: ow.width, height: ow.height })
  assert.equal(S, FRONTIER_CONTENT.gen.chunkSize)
  assert.equal(ow.width % S, 0)
  assert.ok(gates.length >= 2, `causeway gates: ${gates.map((g) => g.id)}`)
  // JSON stays finite despite provider -> core map -> provider.
  const json = JSON.stringify({ p: ow.infinite })
  assert.ok(json.includes('"infinite":true'))
  for (const g of gates) assert.ok(info.walkReach[g.edge.y * ow.width + g.edge.x], `${g.id}: causeway reachable on foot from the spawn`)
})

test('at least 24 biomes, every frontier biome is fully specified and appears somewhere', () => {
  assert.ok(CONTENT.biomes.length >= 24, `${CONTENT.biomes.length} biomes`)
  const fb = FRONTIER_CONTENT.biomes.biomes
  for (const b of CONTENT.biomes) {
    assert.ok(fb[b.id], `${b.id}: frontier spec`)
    const habitats = b.encounterHabitats ?? [b.id]
    assert.ok(CONTENT.speciesList.some((sp) => sp.habitats.some((h) => habitats.includes(h))), `${b.id}: some species live in its habitats`)
    for (const k of ['beach', 'ledge', 'road'] as const) assert.ok(CONTENT.terrainByKey[fb[b.id][k]], `${b.id}.${k}`)
    assert.ok(CONTENT.terrainByKey[fb[b.id].ledge].ledge, `${b.id}: ledge terrain has ledge:true`)
  }
  const seen = new Set<string>()
  const col = newColumn()
  for (let y = -6000; y < 7000; y += 29) for (let x = -6000; x < 7000; x += 29) {
    P.fields.columnAt(x, y, col)
    seen.add(CONTENT.biomes[col.biome].id)
  }
  const missing = CONTENT.biomes.map((b) => b.id).filter((id) => !seen.has(id))
  assert.deepEqual(missing, [], `biomes never generated: ${missing}`)
})

test('chunks are deterministic, order-independent and work for negative coordinates', () => {
  const coords: [number, number][] = [[-1, -1], [-7, 3], [17, 16], [16, -2], [-3, 22], [40, -31], [5, 17], [-60, -60]]
  const a = coords.map(([cx, cy]) => digest(P.chunk(cx, cy)))
  const q = fresh()
  const b = [...coords].reverse().map(([cx, cy]) => digest(q.chunk(cx, cy))).reverse()
  assert.deepEqual(b, a)
  const c = coords.map(([cx, cy]) => digest(fresh().generate(cx, cy)))
  for (let k = 0; k < coords.length; k++) if (!P.inCoreChunk(coords[k][0], coords[k][1])) assert.equal(c[k], a[k], `chunk ${coords[k]}`)
  for (const [cx, cy] of coords) {
    const ch = P.chunk(cx, cy)
    assert.equal(ch.terrain.length, S * S)
    assert.equal(P.peek(cx, cy), ch)
    const inside = (o: { x: number; y: number }) => o.x >= cx * S && o.y >= cy * S && o.x < (cx + 1) * S && o.y < (cy + 1) * S
    for (const list of [ch.props, ch.npcs, ch.signs, ch.items, ch.warps, ch.lights, ch.places]) for (const o of list) assert.ok(inside(o), `object anchored outside chunk ${cx},${cy}`)
    for (let i = 0; i < S * S; i++) assert.ok(CONTENT.terrain[ch.terrain[i]], 'valid terrain id')
  }
})

test('core chunks are exactly the core continent', () => {
  const n = ow.width / S, m = ow.height / S
  const totals = { props: 0, npcs: 0, signs: 0, items: 0, warps: 0, lights: 0 }
  for (let cy = 0; cy < m; cy++) for (let cx = 0; cx < n; cx++) {
    const ch = P.chunk(cx, cy)
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (cy * S + y) * ow.width + cx * S + x, j = y * S + x
      if (ch.terrain[j] !== ow.terrain[i] || ch.elevation[j] !== ow.elevation[i] || ch.regionIds[ch.region[j]] !== ow.regions[ow.region[i]].id) {
        assert.fail(`core tile ${cx * S + x},${cy * S + y} differs`)
      }
    }
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += ch[k].length
  }
  assert.deepEqual(totals, { props: ow.props.length, npcs: ow.npcs.length, signs: ow.signs.length, items: ow.items.length, warps: ow.warps.length, lights: ow.lights.length })
  assert.equal(new Set(ow.regions.map((r) => r.id)).size, ow.regions.length, 'core region ids are unique')
})

test('WorldApi on the infinite overworld matches the finite core map', () => {
  const finite: GameMap = { ...ow, infinite: undefined }
  const fi = collisionField(finite), inf = collisionField(ow)
  let h = 12345
  const rnd = (n: number) => { h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0; return (h >>> 0) % n }
  for (let k = 0; k < 20000; k++) {
    const x = rnd(ow.width), y = rnd(ow.height)
    assert.equal(terrainAt(ow, x, y), terrainAt(finite, x, y))
    assert.equal(elevationAt(ow, x, y), elevationAt(finite, x, y))
    assert.equal(regionAt(ow, x, y)?.id, regionAt(finite, x, y)?.id)
    assert.equal(inf.at(x, y), fi.at(x, y), `collision ${x},${y}`)
    const d = [[1, 0], [0, 1], [1, 1], [-1, 1]][k & 3]
    const nx = x + d[0], ny = y + d[1]
    if (nx < 0 || ny < 0 || nx >= ow.width || ny >= ow.height) continue
    for (const surf of [false, true]) assert.equal(canStep(ow, inf, x, y, nx, ny, { surf }), canStep(finite, fi, x, y, nx, ny, { surf }), `step ${x},${y}->${nx},${ny}`)
  }
  const o = objectsInRect(ow, 400, 400, 700, 700), f = objectsInRect(finite, 400, 400, 700, 700)
  assert.equal(o.props.length, f.props.length)
  assert.equal(o.warps.length, f.warps.length)
  assert.ok(o.places.length > 0, 'core places are bucketed into chunks')
})

test('seams: chunk elevations equal one big base area; roads keep their graded levels across chunks', () => {
  const site = gateSite('south')
  const cx0 = Math.floor(site.x / S) - 1, cy0 = Math.floor(site.y / S)
  const ref = baseArea({ fields: P.fields, grid: P.grid, roads: P.roads }, cx0 * S, cy0 * S, 3 * S, 3 * S)
  for (let cy = cy0; cy < cy0 + 3; cy++) for (let cx = cx0; cx < cx0 + 3; cx++) {
    if (P.inCoreChunk(cx, cy)) continue
    const ch = P.chunk(cx, cy)
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const r = ((cy - cy0) * S + y) * 3 * S + (cx - cx0) * S + x
      if (ch.elevation[y * S + x] !== ref.level[r]) assert.fail(`seam mismatch at ${cx * S + x},${cy * S + y}`)
    }
  }
  let roads = 0
  for (const e of ref.edges) for (let k = 1; k < e.xs.length; k++) {
    if (!e.drawn[k] || !e.drawn[k - 1]) continue
    roads++
    assert.ok(Math.abs(e.levels[k] - e.levels[k - 1]) <= 1, `${e.id}: level jump`)
  }
  assert.ok(roads > 0, 'roads near the south gateway')
})

test('on foot: core spawn -> causeways -> gateway hamlets -> frontier hamlets', () => {
  let reachedFrontier = 0
  for (const g of gates) {
    const site = gateSite(g.id)
    assert.ok(site?.gate, `${g.id}: gateway hamlet`)
    const R = 420
    const x0 = Math.min(g.edge.x, g.x) - R, y0 = Math.min(g.edge.y, g.y) - R, x1 = Math.max(g.edge.x, g.x) + R, y1 = Math.max(g.edge.y, g.y) + R
    const reach = walkBfs(ow, g.edge, x0, y0, x1, y1)
    const ds = P.decorSite(site)
    assert.ok(reach(ds.layout.center.x, ds.layout.center.y), `${g.id}: gateway hamlet reachable on foot`)
    for (const d of ds.layout.doors) assert.ok(reach(d.front.x, d.front.y), `${g.id}: door ${d.slot} reachable`)
    for (const s of P.grid.sitesNear(x0, y0, x1, y1, 0)) {
      if (s.type !== 'hamlet' || s.gate) continue
      const c = P.decorSite(s).layout.center
      if (reach(c.x, c.y)) reachedFrontier++
    }
  }
  assert.ok(reachedFrontier >= 3, `frontier hamlets reachable on foot: ${reachedFrontier}`)
})

test('frontier objects never strand the player; warps resolve and round-trip', () => {
  const field = collisionField(ow)
  let warps = 0
  const visit = (cx: number, cy: number) => {
    const ch = P.chunk(cx, cy)
    for (const n of ch.npcs) assert.equal(field.at(n.x, n.y), COLLISION_FREE, `npc ${n.id} on a free tile`)
    for (const it of ch.items) assert.equal(field.at(it.x, it.y), COLLISION_FREE, `item ${it.id} on a free tile`)
    for (const w of ch.warps) {
      warps++
      const dest = getMap(world, w.toMap)
      assert.ok(dest, `warp to ${w.toMap} resolves`)
      assert.equal(collisionField(dest).at(w.toX, w.toY), COLLISION_FREE, `arrival in ${w.toMap} at ${w.toX},${w.toY}`)
      // Way back: some warp in the destination leads to a free tile next to this warp.
      const back = dest.warps.find((b) => b.toMap === ow.id)
      if (back) {
        assert.ok(Math.abs(back.toX - w.x) + Math.abs(back.toY - w.y) <= 2, `${w.toMap}: exit leads back next to the door`)
        assert.equal(field.at(back.toX, back.toY), COLLISION_FREE, `${w.toMap}: exit tile free`)
      }
    }
  }
  for (const g of gates) {
    const s = gateSite(g.id)
    for (let cy = Math.floor(s.y / S) - 2; cy <= Math.floor(s.y / S) + 2; cy++) for (let cx = Math.floor(s.x / S) - 2; cx <= Math.floor(s.x / S) + 2; cx++) visit(cx, cy)
  }
  assert.ok(warps > 0)
})

test('hamlet interiors: ids, services and the door round trip', () => {
  const site = gateSite('south')
  const ds = P.decorSite(site)
  assert.ok(ds.layout.doors.length >= 2)
  assert.ok(ds.layout.services, 'gateway hamlets always have services')
  for (const d of ds.layout.doors) {
    assert.match(d.mapId, /^fx:hamlet:-?\d+:-?\d+:[a-z]+\d*$/)
    const w = warpAt(ow, d.doorX, d.doorY)
    assert.ok(w && w.toMap === d.mapId, `door warp of ${d.mapId}`)
    const m = P.interior(d.mapId)!
    assert.equal(m.kind, 'interior')
    assert.equal(P.interior(d.mapId), m, 'cached')
    const exit = m.warps.find((x) => x.toMap === ow.id)!
    assert.deepEqual([exit.toX, exit.toY], [d.front.x, d.front.y])
    assert.ok(m.regions[0].isTown)
  }
  const center = P.interior(`${site.id}:center`)!
  assert.ok(center.npcs.some((n) => n.role === FRONTIER_CONTENT.decor.services.nurse.role), 'nurse in the frontier centre')
  const shop = P.interior(`${site.id}:shop`)!
  const clerk = shop.npcs.find((n) => n.script.some((s) => s.op === 'shop'))
  assert.ok(clerk, 'shop clerk')
  const place = P.place(site.id)!
  assert.equal(place.kind, 'hamlet')
  assert.equal(place.map, ow.id)
  assert.equal(P.region(site.id)?.isTown, true, 'hamlet pad is a safe town region')
  assert.equal(regionAt(ow, ds.layout.center.x, ds.layout.center.y)?.id, site.id)
})

test('frontier dungeons: multi-floor, linked both ways, floors reachable', () => {
  const g = gates.find((x) => x.id === 'south')!
  const [gx, gy] = P.grid.cellOf(g.x, g.y)
  let site: FrontierSite | null = null
  for (let r = 1; r < 12 && !site; r++) for (let sy = gy - r; sy <= gy + r && !site; sy++) for (let sx = gx - r; sx <= gx + r && !site; sx++) {
    const s = P.grid.siteAt(sx, sy)
    if (s?.type === 'dungeon' && P.decorSite(s).layout.dungeon) site = s
  }
  assert.ok(site, 'a dungeon near the south gateway')
  const plan = P.decorSite(site).layout.dungeon!
  const floors = plan.floors.map((f) => getMap(world, f.id)!)
  assert.ok(floors.every((f) => f && f.kind === 'cave'))
  assert.match(floors[0].id, /^fx:dungeon:-?\d+:-?\d+:1$/)
  const mouth = objectsInRect(ow, plan.mouth.x - 2, plan.mouth.y - 2, plan.mouth.x + 3, plan.mouth.y + 3).warps.find((w) => w.toMap === floors[0].id)
  assert.ok(mouth, 'mouth warp into floor 1')
  floors.forEach((f, k) => {
    const field = collisionField(f)
    const up = f.warps.find((w) => (k === 0 ? w.toMap === ow.id : w.toMap === floors[k - 1].id))
    assert.ok(up, `floor ${k + 1}: way up`)
    const down = k + 1 < floors.length ? f.warps.find((w) => w.toMap === floors[k + 1].id) : null
    if (k + 1 < floors.length) assert.ok(down, `floor ${k + 1}: way down`)
    const reach = walkBfs(f, f.spawn, 0, 0, f.width, f.height)
    const nextTo = (w: { x: number; y: number }) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => reach(w.x + dx, w.y + dy))
    assert.ok(nextTo(up!), `floor ${k + 1}: exit reachable`)
    if (down) assert.ok(nextTo(down), `floor ${k + 1}: stairs down reachable`)
    assert.ok(f.regions[0].encounters.length > 0, 'dungeon encounters')
    assert.notEqual(field.at(f.spawn.x, f.spawn.y), COLLISION_BLOCKED)
  })
  assert.equal(P.place(site.id)?.kind, 'landmark')
})

test('frontier dungeons: no floor collapses to its entrance (single-end last floors get a chamber)', () => {
  const minFloor = WORLD_CONTENT.dungeons.minFloor ?? 0
  const [cx, cy] = P.grid.cellOf(ow.spawn.x, ow.spawn.y)
  let floors = 0
  for (let sy = cy - 10; sy <= cy + 10; sy++) for (let sx = cx - 10; sx <= cx + 10; sx++) {
    const s = P.grid.siteAt(sx, sy)
    const plan = s?.type === 'dungeon' ? P.decorSite(s).layout.dungeon : null
    if (!plan) continue
    for (const spec of plan.floors) {
      const f = getMap(world, spec.id)!
      const reach = walkBfs(f, f.spawn, 0, 0, f.width, f.height)
      let n = 0
      for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) if (reach(x, y)) n++
      // Props and accents may take a little of the carved floor; half the guaranteed share is plenty.
      assert.ok(n >= (minFloor / 2) * f.width * f.height, `${f.id}: only ${n} reachable tiles`)
      floors++
    }
  }
  assert.ok(floors >= 20, `scanned ${floors} dungeon floors`)
})

test('frontier regions: provinces, level curve, rarity gating, nests', () => {
  const seen = new Map<string, number>()
  const near = gateSite('south')
  for (const [x, y] of [[near.x, near.y + 200], [near.x + 3000, near.y + 2500], [-4000, 9000]]) {
    const ch = P.chunk(Math.floor(x / S), Math.floor(y / S))
    for (const id of ch.regionIds) {
      const r = P.region(id)
      assert.ok(r, `region ${id} resolves`)
      if (!id.startsWith('fr:')) continue
      const pr = parseRegionId(id)!
      const pv = provincePoint(P.fields, pr.px, pr.py)
      const dist = P.fields.originDist(pv.x, pv.y)
      seen.set(id, dist)
      assert.ok(r.levelRange && r.levelRange[0] >= 1 && r.levelRange[0] <= r.levelRange[1])
      assert.ok(r.encounters.length > 0, `${id}: encounters`)
      for (const s of r.encounters) {
        const sp = CONTENT.species[s.species]
        assert.ok(sp, `${id}: species ${s.species}`)
        const b = P.fields.cf.rarity[sp.rarity]
        if (b) {
          assert.ok(dist >= b.minDistance, `${id}: ${sp.rarity} below its minDistance`)
          assert.ok(b.spawn.includes('grass') || b.spawn.includes('visible'), `${id}: ${sp.rarity} cannot spawn in the wild`)
        }
      }
    }
  }
  const list = [...seen.entries()].map(([id, dist]) => ({ dist, lv: P.region(id)!.levelRange![0] })).sort((a, b) => a.dist - b.dist)
  assert.ok(list.length >= 3)
  assert.ok(list[list.length - 1].lv > list[0].lv, 'farther provinces are higher level')
  // A rare-spawn nest somewhere close: boosted region on its tiles.
  const [gx, gy] = P.grid.cellOf(near.x, near.y)
  let nest: FrontierSite | null = null
  for (let r = 1; r < 14 && !nest; r++) for (let sy = gy - r; sy <= gy + r && !nest; sy++) for (let sx = gx - r; sx <= gx + r && !nest; sx++) {
    const s = P.grid.siteAt(sx, sy)
    if (s && P.decorSite(s).layout.nest.length) nest = s
  }
  assert.ok(nest, 'a nest site')
  const t = P.decorSite(nest).layout.nest[0]
  const nr = regionAt(ow, t.x, t.y)!
  assert.equal(nr.id, `${nest.id}:nest`)
  assert.ok(nr.encounters.some((s) => s.rare), 'nest has rare slots')
})

test('decorator registry, sample() and retain()', () => {
  const q = fresh()
  const cx = Math.floor(gates[0].x / S) + 2, cy = Math.floor(gates[0].y / S) + 2
  registerChunkDecorator('test-marker', (ctx) => {
    for (let y = ctx.y0; y < ctx.y0 + ctx.size; y++) for (let x = ctx.x0; x < ctx.x0 + ctx.size; x++) {
      if (!ctx.isFree(x, y)) continue
      ctx.chunk.npcs.push({ id: `test:${ctx.cx}:${ctx.cy}`, x, y, facing: 'down', sprite: 'villager', nameZh: 'T', role: 'villager', script: [] })
      ctx.occupy(x, y)
      return
    }
  })
  try {
    assert.ok(q.chunk(cx, cy).npcs.some((n) => n.id === `test:${cx}:${cy}`))
  } finally {
    unregisterDecorator('test-marker')
  }
  q.clearCache()
  assert.ok(!q.chunk(cx, cy).npcs.some((n) => n.id.startsWith('test:')))
  // sample(): exact for resident chunks, natural columns otherwise; independent of the miss counter.
  const ch = q.chunk(cx, cy)
  assert.equal(q.sample(cx * S + 5, cy * S + 7).terrain, ch.terrain[7 * S + 5])
  const fx = -3000, fy = 4000
  const first = q.sample(fx, fy)
  for (let k = 0; k < 80; k++) q.sample(fx + (k % 30), fy + Math.floor(k / 30))
  assert.deepEqual(q.sample(fx, fy), first)
  assert.deepEqual(q.sample(ow.spawn.x, ow.spawn.y).terrain, ow.terrain[ow.spawn.y * ow.width + ow.spawn.x])
  q.retain([{ x: cx * S, y: cy * S }], 100)
  assert.ok(q.peek(cx, cy))
  q.retain([{ x: 1e6, y: 1e6 }], 100)
  assert.equal(q.peek(cx, cy), null)
})

test('performance: chunk generation and minimap sampling budgets', () => {
  const q = fresh()
  for (let k = 0; k < 24; k++) q.chunk(-40 + (k % 6), 30 + Math.floor(k / 6)) // JIT warm-up
  const t0 = performance.now()
  let n = 0
  for (let cy = 50; cy < 58; cy++) for (let cx = -80; cx < -72; cx++) { q.chunk(cx, cy); n++ }
  const avg = (performance.now() - t0) / n
  assert.ok(avg < CHUNK_BUDGET_MS, `avg ${avg.toFixed(2)} ms per ${S}x${S} chunk`)
  const t1 = performance.now()
  for (let y = 9000; y < 9256; y++) for (let x = 9000; x < 9256; x++) q.sample(x, y)
  const ms = performance.now() - t1
  assert.ok(ms < SAMPLE_BUDGET_MS, `256x256 sample() took ${ms.toFixed(0)} ms`)
  console.log(`frontier perf: ${avg.toFixed(2)} ms/chunk, 256x256 sample ${ms.toFixed(0)} ms`)
})
