import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { GameMap, World } from '../src/shared/types.ts'
import { WORLD_CONTENT, buildWorld, validateWorldContent, worldAnchors, worldBuildInfo, worldStats } from '../src/shared/world/index.ts'
import {
  buildCollision, canStep, elevationAt, propDoor, propDoors, propRect, propSize, regionAt, stairsDir, terrainAt,
} from '../src/shared/world/collision.ts'
import { floodReach } from '../src/shared/world/reach.ts'
import { createNoise, fbm, fbm01, perlin, ridged, simplex, upsample, sampleField, worley } from '../src/shared/noise.ts'

// Budgets for one 1024x1024 build (generous for slow CI machines; typical is ~1.7 s cold). Measured as process CPU
// time (buildWorld is synchronous), so the parallel full suite on a busy host does not fail on CPU contention alone.
// AP_PERF_SCALE loosens timing budgets on slower shared CI runners.
const COLD_BUDGET_MS = 4000 * Number(process.env.AP_PERF_SCALE ?? 1)
const WARM_BUDGET_MS = 3000 * Number(process.env.AP_PERF_SCALE ?? 1)
const cpuMs = (since: NodeJS.CpuUsage) => { const u = process.cpuUsage(since); return (u.user + u.system) / 1000 }

const c0 = process.cpuUsage()
const t0 = performance.now()
const world = buildWorld()
const coldWallMs = performance.now() - t0
const coldMs = cpuMs(c0)
const info = worldBuildInfo(world)
const anchors = worldAnchors(world)
const ow = world.maps[world.startMap]
const owCol = buildCollision(ow)
const COLS = new Map<string, Uint8Array>([[ow.id, owCol]])
const colOf = (m: GameMap) => { let c = COLS.get(m.id); if (!c) { c = buildCollision(m); COLS.set(m.id, c) } return c }
const storyTowns = world.towns.filter((t) => (t.kind ?? 'town') === 'town')
const hamlets = world.towns.filter((t) => t.kind === 'hamlet')
const features = info.features

function digest(w: World): string {
  let h = 0x811c9dc5
  const mix = (v: number) => { h = Math.imul(h ^ v, 0x01000193) }
  for (const id of Object.keys(w.maps).sort()) {
    const m = w.maps[id]
    for (const a of [m.terrain, m.elevation, m.region]) for (let i = 0; i < a.length; i++) mix(a[i])
    const s = JSON.stringify([m.props, m.warps, m.signs, m.items, m.lights, m.regions, m.spawn])
    for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i))
  }
  const s = JSON.stringify([w.towns, w.badges, w.startMap])
  for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i))
  return (h >>> 0).toString(16)
}

const terrainKey = (m: GameMap, x: number, y: number) => CONTENT.terrain[terrainAt(m, x, y)]

test('world content JSON references are valid', () => {
  const errs = validateWorldContent()
  assert.deepEqual(errs, [], errs.join('\n'))
})

test('buildWorld is deterministic, fast and problem-free', () => {
  assert.ok(coldMs < COLD_BUDGET_MS, `cold build took ${coldMs.toFixed(0)} ms CPU (${coldWallMs.toFixed(0)} ms wall)`)
  const c1 = process.cpuUsage()
  const again = buildWorld()
  const warmMs = cpuMs(c1)
  assert.ok(warmMs < WARM_BUDGET_MS, `warm build took ${warmMs.toFixed(0)} ms CPU`)
  assert.equal(digest(again), digest(world))
  assert.deepEqual(worldAnchors(again), anchors)
  assert.deepEqual(info.problems, [], info.problems.join('\n'))
  const other = buildWorld(CONTENT.config.world.seed + 1)
  assert.notEqual(digest(other), digest(world))
  assert.deepEqual(worldBuildInfo(other).problems, [], worldBuildInfo(other).problems.join('\n'))
})

test('world shape: maps, towns, badges and story slots', () => {
  const spec = WORLD_CONTENT.world.overworld
  assert.equal(world.startMap, spec.id)
  assert.equal(ow.kind, 'overworld')
  assert.equal(ow.width, spec.width)
  assert.equal(ow.height, spec.height)
  assert.ok(ow.width >= 1024 && ow.height >= 1024, 'overworld is at least 1024x1024')
  assert.ok(ow.regions.length <= 256, 'region index is 8-bit')
  assert.deepEqual(storyTowns.map((t) => t.id), WORLD_CONTENT.towns.map((t) => t.id))
  for (const t of world.towns) {
    assert.ok(t.kind === 'town' || t.kind === 'hamlet' || t.kind === 'landmark', `${t.id} kind`)
    assert.ok(t.levelRange && t.levelRange[0] >= 1 && t.levelRange[0] <= t.levelRange[1], `${t.id} levelRange`)
    assert.equal(t.map, ow.id)
  }
  assert.equal(new Set(world.towns.map((t) => t.id)).size, world.towns.length, 'town ids are unique')
  const gymTowns = WORLD_CONTENT.towns.filter((t) => t.gym)
  assert.equal(world.badges.length, gymTowns.length)
  for (const b of world.badges) {
    assert.ok(CONTENT.typeById[b.type], b.type)
    assert.ok(CONTENT.characterById[b.leader], b.leader)
    assert.ok(world.towns.some((t) => t.id === b.town))
  }
  for (const m of Object.values(world.maps)) {
    const n = m.width * m.height
    assert.equal(m.terrain.length, n); assert.equal(m.elevation.length, n); assert.equal(m.region.length, n)
    assert.ok(m.regions.length > 0, m.id)
    for (let i = 0; i < n; i++) if (!(m.region[i] < m.regions.length && CONTENT.terrain[m.terrain[i]])) assert.fail(`${m.id} tile ${i}`)
    assert.ok(CONTENT.audio.bgm.some((b) => b.id === m.music), `${m.id} music`)
    for (const r of m.regions) {
      assert.ok(CONTENT.biomeById[r.biome], `${m.id} region ${r.id} biome`)
      assert.ok(CONTENT.audio.bgm.some((b) => b.id === r.music), `${m.id} region ${r.id} music`)
    }
    const lit = m.props.filter((p) => CONTENT.props[p.prop]?.light).length
    assert.equal(m.lights.length, lit, `${m.id} lights`)
  }
  const home = WORLD_CONTENT.towns.find((t) => t.start)!
  const spawnAnchor = anchors[`town:${home.id}:${home.home}`]
  assert.deepEqual({ x: ow.spawn.x, y: ow.spawn.y }, { x: spawnAnchor.x, y: spawnAnchor.y })
  assert.equal(owCol[ow.spawn.y * ow.width + ow.spawn.x], 0)
  const stats = worldStats(world)
  assert.equal(stats.width, ow.width)
  assert.equal(stats.maps, Object.keys(world.maps).length)
  assert.equal(stats.hamlets, hamlets.length)
  assert.equal(stats.pois, features.pois.length)
  assert.equal(stats.dungeons, features.dungeons.length)
  assert.equal(stats.regions, ow.regions.length)
  assert.ok(typeof stats.buildMs === 'number')
})

test('every warp lands on a walkable, non-warp tile and is itself enterable', () => {
  for (const m of Object.values(world.maps)) {
    const col = colOf(m)
    for (const w of m.warps) {
      const at = `${m.id} warp (${w.x},${w.y}) -> ${w.toMap}`
      assert.ok(w.x >= 0 && w.y >= 0 && w.x < m.width && w.y < m.height, at)
      assert.notEqual(col[w.y * m.width + w.x], 1, `${at}: warp tile blocked`)
      const t = world.maps[w.toMap]
      assert.ok(t, `${at}: unknown map`)
      assert.ok(w.toX >= 0 && w.toY >= 0 && w.toX < t.width && w.toY < t.height, `${at}: target out of bounds`)
      assert.equal(colOf(t)[w.toY * t.width + w.toX], 0, `${at}: target blocked`)
      assert.ok(!t.warps.some((o) => o.x === w.toX && o.y === w.toY), `${at}: lands on another warp`)
    }
  }
})

test('door warps pair with interior exits (return in front of the door, facing away)', () => {
  let doors = 0
  for (const p of ow.props) {
    const door = propDoor(p)
    if (!door) continue
    doors++
    const warp = ow.warps.find((w) => w.x === door.x && w.y === door.y)
    assert.ok(warp, `${p.prop} at ${p.x},${p.y} has no door warp`)
    const inner = world.maps[warp.toMap]
    const back = inner.warps.find((w) => w.toMap === ow.id && w.toX === door.front.x && w.toY === door.front.y)
    assert.ok(back, `${warp.toMap}: no exit back to the door front`)
    assert.equal(back.facing, door.facing)
    assert.equal(owCol[door.front.y * ow.width + door.front.x], 0, `${p.prop}: door front blocked`)
    assert.ok(Math.abs(warp.toX - back.x) + Math.abs(warp.toY - back.y) === 1, `${warp.toMap}: arrival is not next to the exit`)
  }
  assert.ok(doors >= storyTowns.length * 3 + hamlets.length * 2, `${doors} doors`)
  for (const h of features.hamlets) {
    for (const slot of h.doors) assert.ok(anchors[`hamlet:${h.id}:${slot}-door`], `hamlet:${h.id}:${slot}-door`)
    assert.ok(h.doors.length >= WORLD_CONTENT.pois.hamlets.houses[0], `${h.id} has too few doors`)
  }
  for (const m of Object.values(world.maps)) {
    if (m.kind === 'overworld') continue
    assert.ok(m.warps.length > 0, `${m.id} has no warps`)
    for (const w of m.warps) {
      const back = world.maps[w.toMap].warps.find((o) => o.toMap === m.id)
      assert.ok(back, `${m.id} -> ${w.toMap} has no return warp`)
    }
  }
})

test('no prop sits on a warp tile except the building that owns the door', () => {
  for (const m of Object.values(world.maps)) {
    const warpAt = new Set(m.warps.map((w) => w.y * m.width + w.x))
    for (const p of m.props) {
      const r = propRect(p)
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
        if (!warpAt.has(y * m.width + x)) continue
        const ownsDoor = propDoors(p).some(door => door.x === x && door.y === y)
        const passable = !CONTENT.props[p.prop]?.collide
        assert.ok(ownsDoor || passable, `${m.id}: ${p.prop} covers warp at ${x},${y}`)
      }
    }
  }
})

test('every town and hamlet (squares and door fronts) is reachable on foot; landmarks too unless on an island', () => {
  const near = (reach: Uint8Array, x: number, y: number) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => reach[(y + dy) * ow.width + x + dx] === 1)
  for (const t of storyTowns) {
    assert.equal(info.walkReach[t.y * ow.width + t.x], 1, `town ${t.id} square unreachable`)
    for (const [name, a] of Object.entries(anchors)) {
      if (a.map === ow.id && name.startsWith(`town:${t.id}:`) && !name.includes(':exit-')) {
        assert.equal(info.walkReach[a.y * ow.width + a.x], 1, `${name} unreachable`)
      }
    }
  }
  for (const h of hamlets) {
    assert.ok(near(info.walkReach, h.x, h.y), `hamlet ${h.id} unreachable on foot`)
    for (const [name, a] of Object.entries(anchors)) {
      if (name.startsWith(`hamlet:${h.id}:`)) assert.ok(near(info.walkReach, a.x, a.y), `${name} unreachable on foot`)
    }
  }
  const islandPoi = new Set(features.pois.filter((p) => p.island).map((p) => p.id))
  for (const t of world.towns.filter((x) => x.kind === 'landmark')) {
    // Island POIs are documented as surf-only; everything else must be walkable from spawn.
    const reach = islandPoi.has(t.id) ? info.surfReach : info.walkReach
    assert.ok(near(reach, t.x, t.y), `landmark ${t.id} unreachable`)
  }
  for (const d of features.dungeons) assert.ok(d.mouth && near(info.walkReach, d.mouth.x, d.mouth.y), `dungeon ${d.id} mouth unreachable`)
  const islandAnchors = Object.entries(anchors).filter(([k]) => k.startsWith('island:'))
  assert.equal(islandAnchors.length, features.islands.length)
  assert.ok(features.islands.filter((i) => i.authored).length === WORLD_CONTENT.world.overworld.islands.length)
  for (const [k, a] of islandAnchors) {
    assert.equal(info.walkReach[a.y * ow.width + a.x], 0, `${k} reachable on foot`)
    assert.equal(info.surfReach[a.y * ow.width + a.x], 1, `${k} unreachable by surf`)
  }
})

test('gates are true choke points: closing them cuts off their region (even with surf)', () => {
  const gates = WORLD_CONTENT.routes.filter((r) => r.gate)
  assert.ok(gates.length >= 2)
  const blocked = new Set<number>()
  for (const r of gates) {
    const a = anchors[`gate:${r.gate!.name}`]
    assert.ok(a, `missing gate:${r.gate!.name}`)
    assert.equal(owCol[a.y * ow.width + a.x], 0)
    blocked.add(a.y * ow.width + a.x)
  }
  for (const surf of [false, true]) {
    const reach = floodReach(ow, owCol, ow.spawn.x, ow.spawn.y, surf, blocked)
    for (const r of gates) {
      const gated = WORLD_CONTENT.towns.filter((t) => t.region === r.gate!.region)
      assert.ok(gated.length > 0)
      for (const t of gated) {
        const td = world.towns.find((x) => x.id === t.id)!
        assert.equal(reach[td.y * ow.width + td.x], 0, `${t.id} reachable past closed gate ${r.gate!.name} (surf=${surf})`)
      }
    }
  }
})

test('start region is enclosed: without route paths the player stays in the start area', () => {
  const start = WORLD_CONTENT.towns.find((t) => t.start)!
  const startRegion = WORLD_CONTENT.regions.findIndex((r) => r.id === start.region)
  const pathT = new Set(WORLD_CONTENT.routes.map((r) => CONTENT.terrainByKey[r.terrain].id))
  const blocked = new Set<number>()
  for (let i = 0; i < ow.width * ow.height; i++) {
    const own = ow.regions[ow.region[i]]
    if (pathT.has(ow.terrain[i]) && WORLD_CONTENT.routes.some((r) => r.id === own.id)) blocked.add(i)
  }
  const reach = floodReach(ow, owCol, ow.spawn.x, ow.spawn.y, false, blocked)
  const startTown = world.towns.find((t) => t.id === start.id)!
  // Story towns only: the start zone's own wilderness (hamlets, landmarks) is open off-route by design.
  for (const t of storyTowns) {
    if (t.id === startTown.id) continue
    assert.equal(reach[t.y * ow.width + t.x], 0, `${t.id} reachable off-route from the start`)
  }
  assert.ok(startRegion >= 0)
})

test('anchors: required coverage, valid tiles', () => {
  const names = Object.keys(anchors)
  assert.ok(anchors.spawn)
  for (const t of WORLD_CONTENT.towns) assert.ok(anchors[`town:${t.id}`], `town:${t.id}`)
  const routeSpots = names.filter((n) => n.startsWith('route:'))
  assert.ok(routeSpots.length >= 60, `${routeSpots.length} route trainer spots`)
  for (const r of WORLD_CONTENT.routes) assert.ok(anchors[`route:${r.id}:1`], r.id)
  assert.ok(names.filter((n) => n.startsWith('quest:')).length >= 12)
  for (const t of WORLD_CONTENT.towns) {
    const gymId = t.buildings?.gym?.mapId
    if (!gymId) continue
    assert.ok(anchors[`${gymId}:leader`], `${gymId}:leader`)
    const trainers = names.filter((n) => n.startsWith(`${gymId}:trainer-`))
    assert.ok(trainers.length >= 2 && trainers.length <= 4, `${gymId} trainers`)
  }
  for (const cv of WORLD_CONTENT.caves.caves) assert.ok(names.some((n) => n.startsWith(`${cv.id}:`)), cv.id)
  for (const h of features.hamlets) assert.ok(anchors[`hamlet:${h.id}`], `hamlet:${h.id}`)
  for (const p of features.pois) assert.ok(anchors[`poi:${p.id}:center`], `poi:${p.id}:center`)
  for (const p of features.pois) {
    const tpl = WORLD_CONTENT.pois.templates[p.template]
    if (tpl.spots > 0) assert.ok(anchors[`poi:${p.id}:spot:1`], `poi:${p.id}:spot:1`)
  }
  for (const d of features.dungeons) {
    assert.ok(anchors[`dungeon:${d.id}:mouth`], `dungeon:${d.id}:mouth`)
    d.floors.forEach((_, k) => assert.ok(anchors[`dungeon:${d.id}:floor${k + 1}:entrance`], `dungeon:${d.id}:floor${k + 1}:entrance`))
    assert.ok(anchors[`dungeon:${d.id}:floor${d.floors.length}:boss`], `dungeon:${d.id}:floor${d.floors.length}:boss`)
  }
  const wild = names.filter((n) => n.startsWith('wild:'))
  assert.ok(wild.length >= 200, `${wild.length} wild anchors`)
  for (const w of features.wilds) assert.ok(anchors[`wild:${w.id}:1`], `wild:${w.id}:1`)
  for (const [name, a] of Object.entries(anchors)) {
    const m = world.maps[a.map]
    assert.ok(m, `${name}: unknown map ${a.map}`)
    assert.ok(a.x >= 0 && a.y >= 0 && a.x < m.width && a.y < m.height, `${name} out of bounds`)
    const col = colOf(m)
    const free = col[a.y * m.width + a.x] === 0
    const adjacent = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const x = a.x + dx, y = a.y + dy
      return x >= 0 && y >= 0 && x < m.width && y < m.height && col[y * m.width + x] === 0
    })
    assert.ok(free || adjacent, `${name} is neither walkable nor next to a walkable tile`)
  }
})

test('anchors are reachable, and NPCs standing on every spot never seal off warps or towns', () => {
  const near = (m: GameMap, reach: Uint8Array, x: number, y: number) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
    const nx = x + dx, ny = y + dy
    return nx >= 0 && ny >= 0 && nx < m.width && ny < m.height && reach[ny * m.width + nx] === 1
  })
  const byMap = new Map<string, [string, { x: number; y: number }][]>()
  for (const [k, a] of Object.entries(anchors)) { const l = byMap.get(a.map) ?? []; l.push([k, a]); byMap.set(a.map, l) }
  for (const m of Object.values(world.maps)) {
    const col = colOf(m)
    const own = byMap.get(m.id) ?? []
    const open = m === ow ? info.surfReach : floodReach(m, col, m.spawn.x, m.spawn.y, false)
    for (const [k, a] of own) assert.ok(near(m, open, a.x, a.y), `${k} unreachable`)
    if (m === ow) continue
    const blocked = new Set(own.filter(([k]) => !/:entrance(-|$)/.test(k)).map(([, a]) => a.y * m.width + a.x))
    const reach = floodReach(m, col, m.spawn.x, m.spawn.y, false, blocked)
    for (const w of m.warps) assert.ok(near(m, reach, w.x, w.y), `${m.id}: warp (${w.x},${w.y}) sealed by NPC spots`)
  }
  // Gym trainers and the guide stand still: the leader must stay reachable around them.
  for (const t of WORLD_CONTENT.towns) {
    const gymId = t.buildings?.gym?.mapId
    if (!gymId) continue
    const m = world.maps[gymId]
    const own = Object.entries(anchors).filter(([k, a]) => a.map === gymId && (k.startsWith(`${gymId}:trainer-`) || k === `${gymId}:guide`))
    const reach = floodReach(m, buildCollision(m), m.spawn.x, m.spawn.y, false, new Set(own.map(([, a]) => a.y * m.width + a.x)))
    const leader = anchors[`${gymId}:leader`]
    assert.ok(near(m, reach, leader.x, leader.y), `${gymId}: leader sealed off by trainers`)
  }
  const routeNpcs = new Set(Object.entries(anchors).filter(([k, a]) => a.map === ow.id && k.startsWith('route:')).map(([, a]) => a.y * ow.width + a.x))
  const reach = floodReach(ow, owCol, ow.spawn.x, ow.spawn.y, false, routeNpcs)
  for (const t of [...storyTowns, ...hamlets]) assert.ok(near(ow, reach, t.x, t.y), `${t.id} cut off by route trainers`)
})

test('encounter tables: non-empty, data-derived, starters excluded when possible', () => {
  const rules = WORLD_CONTENT.world.encounters
  for (const m of Object.values(world.maps)) {
    for (const r of m.regions) {
      if (r.encounterRate <= 0) { assert.equal(r.encounters.length, 0); continue }
      assert.ok(r.encounters.length >= Math.min(rules.minSlots, 1), `${m.id}/${r.id} empty`)
      for (const s of r.encounters) {
        const sp = CONTENT.species[s.species]
        assert.ok(sp, s.species)
        assert.ok(s.minLevel <= s.maxLevel && s.weight > 0)
        if (CONTENT.speciesList.some((x) => !x.starter && x.habitats.length)) assert.ok(!sp.starter, `${r.id}: starter ${s.species}`)
      }
      const distinctLevels = new Set(r.encounters.map((s) => `${s.species}:${s.minLevel}-${s.maxLevel}:${s.time ?? ''}`))
      assert.ok(distinctLevels.size >= Math.min(rules.minSlots, r.encounters.length))
    }
  }
})

test('terrain: elevation steps are one level, stairs have a direction, required features exist', () => {
  const passable = CONTENT.terrain.map((t) => t.walkable || t.swim)
  for (const m of Object.values(world.maps)) {
    const W = m.width
    for (let y = 0; y < m.height; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!passable[m.terrain[i]]) continue
      const e = m.elevation[i]
      if (x + 1 < W && passable[m.terrain[i + 1]] && Math.abs(e - m.elevation[i + 1]) > 1) assert.fail(`${m.id} cliff >1 at ${x},${y}`)
      if (y + 1 < m.height && passable[m.terrain[i + W]] && Math.abs(e - m.elevation[i + W]) > 1) assert.fail(`${m.id} cliff >1 at ${x},${y}`)
      if (CONTENT.terrain[m.terrain[i]].stairs) assert.ok(stairsDir(m, x, y), `${m.id} stairs without direction at ${x},${y}`)
    }
  }
  const keys = new Set<string>()
  for (let i = 0; i < ow.terrain.length; i++) keys.add(CONTENT.terrain[ow.terrain[i]].key)
  const required = new Set<string>()
  // Biomes the core continent can produce (frontier-only biomes are covered by tests/frontier.test.ts).
  const coreBiomes = new Set([...WORLD_CONTENT.climate.rules.map((r) => r.biome), ...WORLD_CONTENT.regions.map((r) => r.biome)])
  for (const [id, b] of Object.entries(WORLD_CONTENT.scatter.biomes)) {
    if (!coreBiomes.has(id)) continue
    required.add(b.ground); b.layers.forEach((l) => required.add(l.terrain))
  }
  required.add(WORLD_CONTENT.world.overworld.bridgeTerrain)
  required.add(WORLD_CONTENT.world.overworld.stairsTerrain)
  for (const k of required) assert.ok(keys.has(k), `overworld has no ${k}`)
  let maxElev = 0
  for (const v of ow.elevation) maxElev = Math.max(maxElev, v)
  assert.ok(maxElev >= 5, `mountains too low (${maxElev})`)
  for (const b of coreBiomes) assert.ok(ow.regions.some((r) => r.biome === b && !r.isTown), `no region for biome ${b}`)
})

test('ground items: counts, ids, never key items, on reachable walkable tiles', () => {
  const rules = WORLD_CONTENT.items
  const all = Object.values(world.maps).flatMap((m) => m.items.map((it) => ({ m, it })))
  const ids = all.map((x) => x.it.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.match(id, /^gi-\d+$/)
  if (CONTENT.itemList.some((it) => !rules.excludeCategories.includes(it.category))) {
    assert.equal(all.filter((x) => !x.it.hidden).length, rules.visible)
    assert.equal(all.filter((x) => x.it.hidden).length, rules.hidden)
  }
  for (const { m, it } of all) {
    const def = CONTENT.items[it.item]
    assert.ok(def && !rules.excludeCategories.includes(def.category) && def.effect.kind !== 'key', it.item)
    assert.equal(colOf(m)[it.y * m.width + it.x], 0, `${it.id} on blocked tile`)
    if (m === ow) assert.equal(info.surfReach[it.y * m.width + it.x], 1, `${it.id} unreachable`)
    assert.ok(!m.warps.some((w) => w.x === it.x && w.y === it.y))
  }
})

test('signs carry text and stand on sign props', () => {
  for (const m of Object.values(world.maps)) {
    for (const s of m.signs) {
      assert.ok(s.text.length > 0 && !/\{\w+\}/.test(s.text), `${m.id} sign text "${s.text}"`)
      const prop = WORLD_CONTENT.world.overworld.signProps[s.kind]
      assert.ok(m.props.some((p) => p.prop === prop && p.x === s.x && p.y === s.y), `${m.id} sign at ${s.x},${s.y} has no prop`)
    }
  }
  assert.ok(ow.signs.length >= WORLD_CONTENT.routes.length * 2)
})

// ---------------------------------------------------------------------------------------------------
// Procedural content: hamlets, POIs, dungeons, wilderness regions, terrain variety
// ---------------------------------------------------------------------------------------------------

test('procedural features: counts within the JSON ranges', () => {
  const pz = WORLD_CONTENT.pois, dg = WORLD_CONTENT.dungeons
  assert.ok(hamlets.length >= pz.hamlets.count[0] && hamlets.length <= pz.hamlets.count[1], `${hamlets.length} hamlets`)
  assert.ok(features.dungeons.length >= 6 && features.dungeons.length <= dg.count[1], `${features.dungeons.length} dungeons`)
  assert.ok(features.pois.length >= 60, `${features.pois.length} POIs`)
  const kinds = new Set(features.pois.map((p) => p.template))
  assert.ok(kinds.size >= Object.keys(pz.templates).length - 2, `only ${kinds.size} POI kinds`)
  assert.ok(features.pois.some((p) => p.island), 'no POI on an island')
  assert.ok(features.pois.some((p) => p.nest), 'no rare-spawn nest')
  assert.ok(features.rivers >= 8, `${features.rivers} rivers`)
  assert.ok(features.lakes >= WORLD_CONTENT.world.overworld.lakes.length + 3, `${features.lakes} lakes`)
  assert.ok(features.islands.length > WORLD_CONTENT.world.overworld.islands.length, 'no procedural islands')
  const names = [...features.hamlets.map((h) => h.nameZh), ...features.pois.map((p) => p.nameZh), ...features.dungeons.map((d) => d.nameZh), ...features.wilds.map((w) => w.nameZh)]
  assert.equal(new Set(names).size, names.length, 'procedural names are unique')
  for (const n of names) assert.ok(n.length > 0 && !/\{\w+\}/.test(n), `bad name "${n}"`)
})

test('dungeons: floors chained by stairs both ways, every floor walkable from its entrance to the next', () => {
  for (const d of features.dungeons) {
    assert.ok(d.floors.length >= WORLD_CONTENT.dungeons.floors[0] && d.floors.length <= WORLD_CONTENT.dungeons.floors[1], d.id)
    const mouth = ow.warps.find((w) => w.toMap === d.floors[0])
    assert.ok(mouth, `${d.id}: no overworld mouth warp`)
    d.floors.forEach((id, k) => {
      const m = world.maps[id]
      assert.ok(m, `${id} missing`)
      const col = colOf(m)
      const entrance = anchors[`dungeon:${d.id}:floor${k + 1}:entrance`]
      const reach = floodReach(m, col, entrance.x, entrance.y, false)
      const near = (x: number, y: number) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => reach[(y + dy) * m.width + x + dx] === 1)
      const up = m.warps.find((w) => w.toMap === (k === 0 ? ow.id : d.floors[k - 1]))
      assert.ok(up && near(up.x, up.y), `${id}: way back up unreachable`)
      if (k + 1 < d.floors.length) {
        const down = m.warps.find((w) => w.toMap === d.floors[k + 1])
        assert.ok(down && near(down.x, down.y), `${id}: stairs down unreachable`)
        assert.ok(m.props.some((p) => p.prop === WORLD_CONTENT.dungeons.stairsProp), `${id}: no stairs prop`)
        const back = world.maps[d.floors[k + 1]].warps.find((w) => w.toMap === id)
        assert.ok(back && back.toX === down.x + (back.toX - down.x) && Math.abs(back.toX - down.x) + Math.abs(back.toY - down.y) === 1, `${id}: stairs do not pair`)
      }
      if (k === d.floors.length - 1) {
        const boss = anchors[`dungeon:${d.id}:floor${k + 1}:boss`]
        assert.ok(near(boss.x, boss.y), `${id}: boss spot unreachable`)
      }
      const lv = m.regions[0].levelRange!
      if (k > 0) assert.ok(lv[0] > world.maps[d.floors[k - 1]].regions[0].levelRange![0], `${id}: deeper floors are not harder`)
    })
  }
})

test('wilderness regions: named, levelled by distance, encounters and danger tiers from wilds.json', () => {
  const wl = WORLD_CONTENT.wilds
  assert.ok(features.wilds.length >= 30, `${features.wilds.length} wild regions`)
  for (const w of features.wilds) {
    const def = ow.regions.find((r) => r.id === w.id)
    assert.ok(def, w.id)
    assert.ok(def.encounters.length > 0 && def.encounterRate > 0, `${w.id} encounters`)
    assert.ok(w.danger >= 0 && w.danger < wl.tiers.length, `${w.id} danger`)
    assert.ok(w.levelRange[1] <= CONTENT.config.party.maxLevel)
  }
  const mean = (d: number) => {
    const l = features.wilds.filter((w) => w.danger === d && !w.island)
    return l.reduce((s, w) => s + w.levelRange[0], 0) / Math.max(1, l.length)
  }
  assert.ok(features.wilds.some((w) => w.danger === wl.tiers.length - 1), 'no region in the top danger tier')
  assert.ok(mean(wl.tiers.length - 1) > mean(0), 'danger tiers do not raise levels')
  const biomes = new Set(features.wilds.map((w) => w.biome))
  assert.ok(biomes.size >= 5, `wilderness biomes: ${[...biomes].join(',')}`)
})

test('terrain variety: snowcaps, beaches, rivers with bridges, lakes and noise-scattered cover', () => {
  const keys = new Map<string, number>()
  for (let i = 0; i < ow.terrain.length; i++) { const k = CONTENT.terrain[ow.terrain[i]].key; keys.set(k, (keys.get(k) ?? 0) + 1) }
  const spec = WORLD_CONTENT.world.overworld
  for (const k of [spec.beach.terrain, spec.bridgeTerrain, spec.stairsTerrain, spec.hydrology.riverTerrain, spec.seaTerrain]) assert.ok(keys.get(k), `no ${k}`)
  const land = ow.terrain.length - (keys.get(spec.seaTerrain) ?? 0) - (keys.get(spec.seaShallowTerrain) ?? 0)
  assert.ok(land > ow.terrain.length * 0.45, 'the continent is too small')
  let peak = 0
  for (const v of ow.elevation) peak = Math.max(peak, v)
  assert.ok(peak >= 8, `peaks too low (${peak})`)
  const props = new Set(ow.props.map((p) => p.prop))
  assert.ok(props.size >= 30, `${props.size} prop kinds on the overworld`)
})

test('noise: deterministic per seed, bounded, lattice sampling matches direct samples', () => {
  const a = createNoise(1234), b = createNoise(1234), c = createNoise(1235)
  const o = { frequency: 1 / 37, octaves: 4, gain: 0.5, lacunarity: 2 }
  let diff = 0
  for (let k = 0; k < 400; k++) {
    const x = k * 3.7 - 200, y = k * 1.9 + 11
    assert.equal(perlin(a, x, y), perlin(b, x, y))
    assert.equal(fbm(a, x, y, o), fbm(b, x, y, o))
    const p = perlin(a, x / 9, y / 9), sx = simplex(a, x / 9, y / 9), r = ridged(a, x, y, o), f = fbm01(a, x, y, o)
    assert.ok(p >= -1 && p <= 1 && sx >= -1 && sx <= 1, 'perlin/simplex in [-1, 1]')
    assert.ok(r >= 0 && r <= 1 && f >= 0 && f <= 1, 'ridged/fbm01 in [0, 1]')
    if (perlin(a, x / 9, y / 9) !== perlin(c, x / 9, y / 9)) diff++
    const wo = worley(99, x / 20, y / 20, 0.8, { f1: 0, f2: 0, id: 0, cx: 0, cy: 0 })
    assert.ok(wo.f1 <= wo.f2)
  }
  assert.ok(diff > 300, 'different seeds give different noise')
  assert.equal(perlin(a, 5, 7), 0, 'perlin is zero on integer lattice points')
  const grid = sampleField(33, 17, 4, (x, y) => x * 2 + y)
  assert.equal(grid.length, 33 * 17)
  for (const [x, y] of [[0, 0], [4, 8], [32, 16], [5, 3]]) assert.ok(Math.abs(grid[y * 33 + x] - (x * 2 + y)) < 1e-4, `bilinear at ${x},${y}`)
  assert.equal(upsample(new Float32Array([1, 1, 1, 1]), 2, 4, 3, 3).length, 9)
})

// ---------------------------------------------------------------------------------------------------
// Collision API on synthetic maps (terrain picked by capability flags, never by key)
// ---------------------------------------------------------------------------------------------------

const T = CONTENT.terrain
const ground = T.find((t) => t.walkable && !t.liquid && !t.stairs && !t.encounter)!.id
const stairs = T.find((t) => t.stairs)!.id
const deep = T.find((t) => t.swim && !t.walkable)!.id
const solid = T.find((t) => !t.walkable && !t.swim)!.id

function synth(rows: string[], elev?: string[]): GameMap {
  const h = rows.length, w = rows[0].length
  const terrain = new Uint8Array(w * h), elevation = new Uint8Array(w * h)
  rows.forEach((r, y) => [...r].forEach((ch, x) => {
    terrain[y * w + x] = ch === 'S' ? stairs : ch === '~' ? deep : ch === '#' ? solid : ground
    elevation[y * w + x] = elev ? Number(elev[y][x]) : 0
  }))
  return {
    id: 'synthetic', nameZh: '', kind: 'interior', width: w, height: h, terrain, elevation, region: new Uint8Array(w * h),
    regions: [], props: [], warps: [], npcs: [], signs: [], items: [], lights: [], spawn: { x: 0, y: 0, facing: 'down' }, outdoor: false, music: '',
  }
}

test('collision: rotated footprints swap width and depth', () => {
  const key = Object.keys(CONTENT.props).find((k) => CONTENT.props[k].footprint[0] !== CONTENT.props[k].footprint[1])!
  const [w, d] = CONTENT.props[key].footprint
  assert.deepEqual(propSize(key, 0), [w, d])
  assert.deepEqual(propSize(key, 1), [d, w])
  assert.deepEqual(propSize(key, 3), [d, w])
  const m = synth(['......', '......', '......', '......', '......', '......'])
  m.props.push({ prop: key, x: 1, y: 1, rot: 1 })
  const col = buildCollision(m)
  let blocked = 0
  for (const v of col) if (v === 1) blocked++
  assert.equal(blocked, CONTENT.props[key].collide ? w * d : 0)
  if (CONTENT.props[key].collide) for (let y = 1; y < 1 + w; y++) for (let x = 1; x < 1 + d; x++) assert.equal(col[y * 6 + x], 1)
})

test('collision: 8-dir moves with the diagonal corner rule', () => {
  const m = synth(['...', '.#.', '...'])
  const col = buildCollision(m)
  assert.ok(canStep(m, col, 0, 0, 1, 0, { surf: false }))
  assert.ok(!canStep(m, col, 0, 0, 1, 1, { surf: false }))
  assert.ok(!canStep(m, col, 1, 0, 0, 1, { surf: false }), 'cuts the blocked corner')
  assert.ok(!canStep(m, col, 0, 0, 2, 0, { surf: false }), 'two tiles away')
  const open = synth(['..', '..'])
  assert.ok(canStep(open, buildCollision(open), 0, 0, 1, 1, { surf: false }))
  assert.ok(!canStep(open, buildCollision(open), 1, 1, 2, 2, { surf: false }), 'out of bounds')
})

test('collision: elevation changes only via stairs along their direction', () => {
  // Row 1: ground(0) stairs(0) ground(1); the stairs rise to the right.
  const m = synth(['...', '.S.', '...'], ['001', '001', '001'])
  const col = buildCollision(m)
  assert.equal(stairsDir(m, 1, 1), 'right')
  assert.ok(canStep(m, col, 1, 1, 2, 1, { surf: false }), 'climb the stairs')
  assert.ok(canStep(m, col, 2, 1, 1, 1, { surf: false }), 'descend the stairs')
  assert.ok(!canStep(m, col, 1, 0, 2, 0, { surf: false }), 'cliff without stairs')
  assert.ok(!canStep(m, col, 1, 1, 2, 0, { surf: false }), 'diagonal off stairs')
  assert.ok(canStep(m, col, 0, 1, 1, 1, { surf: false }), 'enter stairs from the low side')
  assert.equal(elevationAt(m, -5, 1), 0)
  assert.equal(regionAt(m, 99, 99), 0)
  assert.equal(terrainAt(m, -1, 0), CONTENT.terrainByKey[WORLD_CONTENT.world.overworld.outOfBounds].id)
})

test('collision: deep water needs surf, solid terrain never passes', () => {
  const m = synth(['.~#'])
  const col = buildCollision(m)
  assert.ok(!canStep(m, col, 0, 0, 1, 0, { surf: false }))
  assert.ok(canStep(m, col, 0, 0, 1, 0, { surf: true }))
  assert.ok(canStep(m, col, 1, 0, 0, 0, { surf: true }), 'land from water')
  assert.ok(!canStep(m, col, 1, 0, 2, 0, { surf: true }))
})
