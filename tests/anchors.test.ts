// Teleport anchors (#38): deterministic placement from the world seed, grand anchors at every spawn, spacing and
// walking coverage of the core, valid ground, frontier sites and filler, saves (migration, unlock persistence),
// the destination list and the travel gate. Tuning lives in content/world/anchors.json; the numbers asserted
// here are acceptance bars (what the tuning must at least deliver), not game data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { GameMap, SaveData } from '../src/shared/types.ts'
import { buildWorld, worldAnchors, worldBuildInfo } from '../src/shared/world/index.ts'
import { WORLD_CONTENT } from '../src/shared/world/data.ts'
import { validateAnchorsContent } from '../src/shared/world/validate.ts'
import { collisionField, elevationAt, objectsInRect, terrainAt, warpAt } from '../src/shared/world/worldapi.ts'
import { COLLISION_FREE, propRect } from '../src/shared/world/collision.ts'
import {
  anchorId, anchorKindSpec, anchorSpotFromId, anchorSpotOf, anchorsInRect, coreAnchors, homeAnchor, isAnchorProp, parseAnchorId, preUnlockedIds,
  type AnchorSpot,
} from '../src/shared/world/anchors.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { GAME, validateGameContent } from '../src/client/world/config.ts'
import { validateRenderContent } from '../src/client/render/config.ts'
import {
  anchorGateMessage, anchorGroup, anchorLanding, anchorName, canAnchorTravel, destinationOf, isUnlocked, markSeen, travelDestinations, unlockAnchor,
  unlockedAnchors,
} from '../src/client/world/anchors.ts'

const A = WORLD_CONTENT.anchors
const world = buildWorld()
const info = worldBuildInfo(world)
const ow = world.maps[world.startMap]
const field = collisionField(ow)
const core = coreAnchors(world)
const rule = (id: string) => A.core.rules.find((r) => r.id === id)!
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
const centre = (a: AnchorSpot) => ({ x: a.cx, y: a.cy })
const isPreUnlocked = (id: string) => preUnlockedIds(world).includes(id)

test('anchors.json and its references (props, sounds, fx, beacon styles, interaction) are consistent', () => {
  assert.deepEqual(validateAnchorsContent(), [])
  assert.deepEqual(validateGameContent().filter((e) => e.includes('anchor')), [])
  assert.deepEqual(validateRenderContent().filter((e) => e.includes('anchor')), [])
  for (const kind of Object.keys(A.kinds) as (keyof typeof A.kinds)[]) {
    const spec = anchorKindSpec(kind)
    assert.ok(isAnchorProp(spec.prop))
    assert.equal(GAME.interact.props[spec.prop]?.action, 'anchor')
  }
})

test('ids round-trip: kind and footprint corner, junk is rejected', () => {
  const id = anchorId('minor', 12, -7)
  assert.deepEqual(parseAnchorId(id), { kind: 'minor', x: 12, y: -7 })
  assert.equal(anchorSpotFromId(id)?.id, id)
  for (const junk of ['', 'anchor:minor:1', 'anchor:huge:1:2', 'anchor:minor:a:2', 'anchor:minor:1.5:2', 'town:origin']) assert.equal(parseAnchorId(junk), null, junk)
})

test('placement is deterministic for a seed and differs between seeds', () => {
  const ids = (w: typeof world) => coreAnchors(w).map((a) => a.id)
  assert.deepEqual(ids(buildWorld()), ids(world))
  assert.notDeepEqual(ids(buildWorld(CONTENT.config.world.seed + 1)), ids(world))
  assert.ok(core.length >= 100 && core.length <= 260, `${core.length} core anchors`)
  assert.equal(new Set(core.map((a) => a.id)).size, core.length, 'ids are unique')
})

test('a grand anchor stands next to every spawn: new game, respawn, co-op spawn, frontier gateways', (t) => {
  const grands = core.filter((a) => a.kind === 'grand')
  assert.equal(grands.length, 1, 'one grand anchor on the core continent')
  const home = homeAnchor(world)!
  assert.equal(home.id, grands[0].id)
  const spawn = ow.spawn
  const startRule = rule('start')
  assert.ok(cheb(centre(home), spawn) <= startRule.max + 2, `home anchor is ${cheb(centre(home), spawn)} tiles from the spawn`)
  // The new game wakes up indoors (GAME.newGame.startAnchor) and steps out at the spawn: the spawn tile and the front tile stay free.
  assert.ok(worldAnchors(world)[GAME.newGame.startAnchor], 'the start anchor exists')
  const inFoot = (p: { x: number; y: number }) => p.x >= home.x && p.y >= home.y && p.x < home.x + home.w && p.y < home.y + home.h
  assert.ok(!inFoot(spawn), 'footprint avoids the spawn tile')
  assert.equal(field.at(home.front.x, home.front.y), COLLISION_FREE, 'front tile is free')
  // Fresh saves have it active: new game, respawn point and the server spawn are all this town.
  const saves = createSaveManager({ world, storage: memory(), now: () => 1_700_000_000_000, newId: () => '00000000-0000-4000-8000-000000000001' })
  const avatar = CONTENT.characters.find((c) => c.playable)!
  const save = saves.newGame({ name: avatar.nameZh, avatar: avatar.id })
  assert.ok(save.anchors?.unlocked.includes(home.id))
  assert.ok(Math.hypot(save.respawn.x - home.cx, save.respawn.y - home.cy) <= A.preUnlock.grandWithin, 'respawn is within pre-unlock range')
  assert.deepEqual(preUnlockedIds(world), [home.id])
  // Frontier entry points: each causeway landing has a grand anchor.
  const gates = info.features.gates
  assert.ok(gates.length >= 4)
  for (const g of gates) {
    const near = anchorsInRect(ow, g.x - 30, g.y - 30, g.x + 30, g.y + 30).filter((a) => a.kind === 'grand')
    assert.equal(near.length, 1, `gateway ${g.id} has one grand anchor`)
    assert.ok(cheb(centre(near[0]), g) <= A.frontier.sites.gateway.max + 3, `gateway ${g.id}: anchor ${cheb(centre(near[0]), g)} tiles from the landing`)
    assert.ok(!isPreUnlocked(near[0].id), 'frontier gateways start inactive: they are found by arriving')
  }
  t.diagnostic(`core: ${core.length} anchors (${grands.length} grand); home ${home.id}, ${cheb(centre(home), spawn)} tiles from the spawn; ${gates.length} gateway grands`)
})

test('every town, hamlet and dungeon mouth has an anchor; most points of interest do', () => {
  const R = Math.max(A.naming.radius, 22)
  const nearAnchor = (p: { x: number; y: number }, r: number) => core.some((a) => cheb(centre(a), p) <= r)
  const missing = world.towns.filter((tw) => tw.map === ow.id && !nearAnchor(tw, R) && (tw.kind ?? 'town') !== 'landmark').map((tw) => tw.id)
  assert.deepEqual(missing, [], 'towns and hamlets without an anchor')
  for (const d of info.features.dungeons) assert.ok(d.mouth && nearAnchor(d.mouth, rule('dungeon').max + 5), `dungeon ${d.id} mouth has an anchor`)
  const templates = new Set(rule('poi').templates)
  const pois = info.features.pois.filter((p) => templates.has(p.template))
  const covered = pois.filter((p) => nearAnchor(p, R)).length
  assert.ok(covered / pois.length >= 0.9, `${covered} of ${pois.length} listed points of interest have an anchor`)
})

test('core anchors stand on dry flat ground in a free ring, never on warps, signs, items or other props', () => {
  const margin = (k: AnchorSpot['kind']) => anchorKindSpec(k).margin
  const others = ow.props.filter((p) => !isAnchorProp(p.prop))
  const bad: string[] = []
  for (const a of core) {
    const m = margin(a.kind)
    const level = elevationAt(ow, a.x, a.y)
    for (let y = a.y - m; y < a.y + a.h + m; y++) {
      for (let x = a.x - m; x < a.x + a.w + m; x++) {
        const inner = x >= a.x && y >= a.y && x < a.x + a.w && y < a.y + a.h
        const tt = CONTENT.terrain[terrainAt(ow, x, y)]
        if (elevationAt(ow, x, y) !== level) bad.push(`${a.id}: ${x},${y} not flat`)
        if (tt.liquid || tt.ledge || tt.stairs) bad.push(`${a.id}: ${x},${y} is ${tt.key ?? 'liquid/ledge/stairs'}`)
        if (warpAt(ow, x, y)) bad.push(`${a.id}: warp at ${x},${y}`)
        // the footprint is blocked by the anchor itself, the ring must be walkable
        if (!inner && field.at(x, y) !== COLLISION_FREE) bad.push(`${a.id}: ring tile ${x},${y} is blocked`)
      }
    }
    const rect = { x: a.x, y: a.y, w: a.w, h: a.h }
    for (const p of others) {
      const r = propRect(p)
      if (r.x < rect.x + rect.w && r.x + r.w > rect.x && r.y < rect.y + rect.h && r.y + r.h > rect.y) bad.push(`${a.id}: overlaps ${p.prop}@${p.x},${p.y}`)
    }
    const c = A.place.itemClearance
    const hit = (o: { x: number; y: number }) => o.x >= a.x - c && o.y >= a.y - c && o.x < a.x + a.w + c && o.y < a.y + a.h + c
    for (const o of [...ow.signs, ...ow.items, ...ow.npcs]) if (hit(o)) bad.push(`${a.id}: crowds an object at ${o.x},${o.y}`)
    if (info.walkReach[a.front.y * ow.width + a.front.x] !== 1) bad.push(`${a.id}: front tile ${a.front.x},${a.front.y} is not reachable on foot`)
  }
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} problems`)
})

test('spacing: footprints never touch, and no walkable core tile is far from an anchor on foot', (t) => {
  for (let i = 0; i < core.length; i++) {
    for (let j = i + 1; j < core.length; j++) {
      const a = core[i], b = core[j]
      assert.ok(a.x + a.w + 1 <= b.x || b.x + b.w + 1 <= a.x || a.y + a.h + 1 <= b.y || b.y + b.h + 1 <= a.y, `${a.id} and ${b.id} touch`)
    }
  }
  // Multi-source BFS from every anchor's front tile over the tiles the player can walk to (4-neighbour steps).
  const W = ow.width, H = ow.height
  const reach = info.walkReach
  const dist = new Int32Array(W * H).fill(-1)
  const queue = new Int32Array(W * H)
  let qh = 0, qt = 0
  for (const a of core) {
    const i = a.front.y * W + a.front.x
    if (reach[i] && dist[i] < 0) { dist[i] = 0; queue[qt++] = i }
  }
  assert.ok(qt >= core.length * 0.99, 'every anchor front is on the walkable continent')
  while (qh < qt) {
    const i = queue[qh++]
    const x = i % W, y = (i / W) | 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const j = ny * W + nx
      if (reach[j] && dist[j] < 0) { dist[j] = dist[i] + 1; queue[qt++] = j }
    }
  }
  const walk: number[] = []
  let total = 0, cut = 0
  for (let i = 0; i < W * H; i++) {
    if (!reach[i]) continue
    total++
    if (dist[i] < 0) cut++
    else walk.push(dist[i])
  }
  walk.sort((x, y) => x - y)
  const maxWalk = rule('fill').maxWalk!
  const within = walk.filter((d) => d <= maxWalk).length / total
  const q = (p: number) => walk[Math.min(walk.length - 1, Math.floor(walk.length * p))]
  t.diagnostic(`walking steps to the nearest anchor over ${total} tiles: median ${q(0.5)}, p95 ${q(0.95)}, p99 ${q(0.99)}, max ${walk[walk.length - 1]}; ${(100 * within).toFixed(3)}% within ${maxWalk}`)
  assert.equal(cut, 0, 'every walkable tile is connected to an anchor')
  assert.ok(within >= 0.999, `${(100 * within).toFixed(3)}% of walkable tiles within ${maxWalk} steps of an anchor`)
  assert.ok(walk[walk.length - 1] <= maxWalk * 1.3, `farthest walkable tile is ${walk[walk.length - 1]} steps from an anchor`)
  assert.ok(q(0.95) <= maxWalk * 0.7, `p95 ${q(0.95)}`)
})

// --------------------------------------------------------------------------------------------- frontier

test('frontier: gateways and sites carry anchors; the filler keeps wilderness within reach; chunks agree on every anchor', (t) => {
  const open = (map: GameMap, a: AnchorSpot) => {
    for (let y = a.y - 1; y < a.y + a.h + 1; y++) for (let x = a.x - 1; x < a.x + a.w + 1; x++) {
      const inner = x >= a.x && y >= a.y && x < a.x + a.w && y < a.y + a.h
      const tt = CONTENT.terrain[terrainAt(map, x, y)]
      if (tt.liquid || tt.stairs || tt.ledge) return false
      if (!inner && collisionField(map).at(x, y) !== COLLISION_FREE) return false
    }
    return true
  }
  // A 640x640 window of open land well outside the core: anchors every ~64-tile cell where there is room.
  const win = { x0: 300, y0: -900, x1: 940, y1: -260 }
  const list = anchorsInRect(ow, win.x0 - 200, win.y0 - 200, win.x1 + 200, win.y1 + 200)
  assert.ok(list.length >= 40, `${list.length} anchors around the window`)
  assert.deepEqual(list.filter((a) => !open(ow, a)).map((a) => a.id), [], 'frontier anchors have a free dry ring')
  const ds: number[] = []
  for (let y = win.y0; y < win.y1; y += 8) for (let x = win.x0; x < win.x1; x += 8) {
    if (field.at(x, y) !== COLLISION_FREE) continue
    let d = Infinity
    for (const a of list) d = Math.min(d, Math.hypot(a.cx - x, a.cy - y))
    ds.push(d)
  }
  ds.sort((p, q) => p - q)
  const q = (p: number) => ds[Math.min(ds.length - 1, Math.floor(ds.length * p))]
  t.diagnostic(`frontier window: ${list.length} anchors; straight-line distance from open ground to the nearest: median ${q(0.5).toFixed(0)}, p95 ${q(0.95).toFixed(0)}, max ${q(1).toFixed(0)}`)
  assert.ok(q(0.95) <= 120, `p95 ${q(0.95)} tiles`)
  assert.ok(q(0.5) <= 60, `median ${q(0.5)} tiles`)
  // Same anchors from an independent world instance (chunks are generated on demand, in any order).
  const other = buildWorld().maps[world.startMap]
  const again = anchorsInRect(other, win.x0 - 200, win.y0 - 200, win.x1 + 200, win.y1 + 200)
  assert.deepEqual(again.map((a) => a.id).sort(), list.map((a) => a.id).sort())
})

// --------------------------------------------------------------------------------------------- saves

function memory() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } }
}
const saves = createSaveManager({ world, storage: memory(), now: () => 1_700_000_000_000, newId: () => '00000000-0000-4000-8000-000000000001' })
const avatar = CONTENT.characters.find((c) => c.playable)!
const fresh = (): SaveData => saves.newGame({ name: avatar.nameZh, avatar: avatar.id })
const roundTrip = (s: SaveData): SaveData => saves.sanitize(JSON.parse(JSON.stringify(s)))!
const minors = core.filter((a) => a.kind === 'minor')

test('saves: old saves without anchors load with the grand anchor active; junk and duplicates are dropped', () => {
  const old = JSON.parse(JSON.stringify(fresh())) as Record<string, unknown>
  delete old.anchors
  const migrated = saves.sanitize(old)!
  assert.deepEqual(migrated.anchors?.unlocked, preUnlockedIds(world))
  assert.deepEqual(migrated.anchors?.seen, preUnlockedIds(world))
  const raw = JSON.parse(JSON.stringify(fresh())) as { anchors: { unlocked: unknown[]; seen: unknown[] } }
  raw.anchors = { unlocked: [minors[0].id, minors[0].id, 'anchor:minor:x:y', 42, 'town:origin', minors[1].id], seen: [minors[2].id, 'nope'] }
  const back = saves.sanitize(raw)!
  assert.deepEqual(back.anchors?.unlocked, [...preUnlockedIds(world), minors[0].id, minors[1].id])
  assert.deepEqual([...(back.anchors?.seen ?? [])].sort(), [...new Set([minors[2].id, ...(back.anchors?.unlocked ?? [])])].sort(), 'unlocked anchors always count as seen')
  const hostile = saves.sanitize({ ...raw, anchors: 'x' })!
  assert.deepEqual(hostile.anchors?.unlocked, preUnlockedIds(world))
})

test('saves: the caps keep the newest entries and never drop the pre-unlocked grand anchor', () => {
  const raw = JSON.parse(JSON.stringify(fresh())) as { anchors: { unlocked: string[]; seen: string[] } }
  const many = Array.from({ length: A.save.maxUnlocked + 50 }, (_, i) => anchorId('minor', i, 3))
  raw.anchors = { unlocked: many, seen: [] }
  const back = saves.sanitize(raw)!
  assert.equal(back.anchors?.unlocked.length, A.save.maxUnlocked)
  assert.ok(back.anchors?.unlocked.includes(preUnlockedIds(world)[0]))
  assert.ok(back.anchors?.unlocked.includes(many[many.length - 1]) && !back.anchors.unlocked.includes(many[0]))
})

test('unlocking: persists through a save round-trip and an export code; seen stays a superset', () => {
  const save = fresh()
  const a = minors[3], b = minors[4]
  assert.equal(isUnlocked(save, a.id), false)
  assert.equal(markSeen(save, a.id), true)
  assert.equal(markSeen(save, a.id), false, 'seen once')
  assert.equal(unlockAnchor(save, a.id), true)
  assert.equal(unlockAnchor(save, a.id), false, 'unlocked once')
  assert.equal(unlockAnchor(save, b.id), true)
  const back = roundTrip(save)
  assert.deepEqual(unlockedAnchors(back), unlockedAnchors(save))
  assert.deepEqual(back.anchors?.seen, save.anchors?.seen)
  assert.deepEqual(saves.importCode(saves.exportCode(save))?.anchors, save.anchors)
  assert.ok(isUnlocked(back, a.id) && isUnlocked(back, b.id) && isUnlocked(back, preUnlockedIds(world)[0]))
})

// --------------------------------------------------------------------------------------------- client logic

test('travel gate: open from the first minute on the overworld; badges / key item gate it separately from the town fly', () => {
  const save = fresh()
  assert.equal(GAME.anchorTravel.minBadges, 0)
  assert.equal(canAnchorTravel(save, 'overworld'), true, 'available at game start')
  assert.equal(canAnchorTravel(save, 'interior'), false, 'not in interiors')
  assert.equal(canAnchorTravel(save, null), false)
  assert.equal(anchorGateMessage(save), null)
  const saved = { ...GAME.anchorTravel }
  try {
    GAME.anchorTravel.minBadges = 2
    assert.equal(canAnchorTravel(save, 'overworld'), false)
    assert.match(anchorGateMessage(save) ?? '', /2/)
    save.badges = ['a', 'b']
    assert.equal(canAnchorTravel(save, 'overworld'), true)
  } finally { Object.assign(GAME.anchorTravel, saved) }
  assert.equal(canAnchorTravel(save, 'overworld'), true, 'fly gate is a different setting')
})

test('destinations: "回原点" apart, activated anchors grouped by area nearest first, names from places', () => {
  const save = fresh()
  const home = homeAnchor(world)!
  const town = world.towns.find((tw) => tw.id === 'opensource')!
  const nearTown = minors.filter((a) => cheb(centre(a), town) <= 22).sort((a, b) => cheb(centre(a), town) - cheb(centre(b), town))[0]
  assert.equal(anchorName(world, nearTown), town.nameZh, 'an anchor at a town carries its name')
  assert.ok(anchorName(world, minors.find((a) => /·/.test(anchorName(world, a)))!).includes('·'), 'wild anchors are "<area>·<word>"')
  unlockAnchor(save, nearTown.id)
  const wild = minors.filter((a) => /·/.test(anchorName(world, a)))
  for (const w of wild.slice(0, 5)) unlockAnchor(save, w.id)
  const list = travelDestinations(world, save, centre(home))
  assert.equal(list.home?.id, home.id)
  assert.equal(list.home?.kind, 'home')
  assert.equal(list.count, 1 + 1 + 5)
  assert.ok(list.groups.every((g) => g.items.every((d) => d.region === g.region)), 'every item sits in its own area group')
  for (const g of list.groups) assert.deepEqual(g.items.map((d) => d.dist), [...g.items.map((d) => d.dist)].sort((x, y) => x - y), 'nearest first')
  assert.deepEqual(list.groups.map((g) => g.items[0].dist), [...list.groups.map((g) => g.items[0].dist)].sort((x, y) => x - y), 'nearest area first')
  assert.equal(list.groups.flatMap((g) => g.items).some((d) => d.id === home.id), false, 'home is not listed twice')
  const dest = destinationOf(world, nearTown.id, centre(home))!
  assert.equal(dest.name, town.nameZh)
  assert.equal(dest.kind, 'town')
  assert.equal(anchorGroup(world, nearTown), dest.region)
  // standing at the home anchor: no "回原点", and the anchor is marked as "here"
  const here = travelDestinations(world, save, centre(home), home.id)
  assert.equal(here.home, null)
  assert.equal(travelDestinations(world, save, centre(nearTown), nearTown.id).groups.flatMap((g) => g.items).find((d) => d.id === nearTown.id)?.here, true)
})

test('landing: every anchor has a free, non-warp tile to arrive on, next to it', () => {
  const bad: string[] = []
  for (const a of core) {
    const land = anchorLanding(world, a)
    if (!land) { bad.push(`${a.id}: no landing`); continue }
    if (field.at(land.x, land.y) !== COLLISION_FREE || warpAt(ow, land.x, land.y)) bad.push(`${a.id}: landing ${land.x},${land.y} is not free`)
    if (cheb(land, a.front) > 3) bad.push(`${a.id}: landing ${cheb(land, a.front)} tiles from the front`)
  }
  assert.deepEqual(bad.slice(0, 10), [])
  const sample = anchorsInRect(ow, 300, -900, 500, -700)
  assert.ok(sample.length > 0 && sample.every((a) => anchorLanding(world, a) !== null), 'frontier anchors can be landed on too')
  assert.ok(objectsInRect(ow, 0, 0, 1, 1).props.every((p) => anchorSpotOf(p) === null || isAnchorProp(p.prop)))
})
