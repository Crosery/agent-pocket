import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { ChunkProvider, GameMap, MapChunk, QuestDef, SaveData, World } from '../src/shared/types.ts'
import { buildWorld, worldAnchors } from '../src/shared/world/index.ts'
import { canStep, collisionField, invalidateCollision } from '../src/shared/world/worldapi.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { TUTORIAL } from '../src/client/onboarding/config.ts'
import { createQuestNavigator, createRouteSearch, navigationWaypoints, trackedQuest, type RoutePoint } from '../src/client/world/quest-navigation.ts'
import { gridField, moveBody, type MotionGrid } from '../src/client/world/motion.ts'
import { GAME } from '../src/client/world/config.ts'
import { applyQuest } from '../src/client/world/save-ops.ts'
import type { GameContext } from '../src/client/contracts.ts'
import { collectMarkers } from '../src/client/world/markers.ts'

const rules = TUTORIAL.objective.navigation
const terrain = CONTENT.terrain.find(t => t.walkable && !t.stairs && !t.ledge)!.id
function fixture(rows: string[]): MotionGrid {
  const width = rows[0].length, height = rows.length
  const map: GameMap = {
    id: 'field', nameZh: 'Field', kind: 'overworld', width, height,
    terrain: new Uint8Array(width * height).fill(terrain), elevation: new Uint8Array(width * height), region: new Uint8Array(width * height),
    props: [], warps: [], npcs: [], signs: [], items: [], lights: [], regions: [],
    spawn: { x: 0, y: 0, facing: 'down' }, outdoor: true, music: '',
  }
  const col = new Uint8Array(width * height)
  rows.forEach((r, y) => [...r].forEach((c, x) => { col[y * width + x] = c === '#' ? 1 : c === '~' ? 2 : 0 }))
  return { map, col }
}
const finish = (search: ReturnType<typeof createRouteSearch>) => {
  for (let i = 0; search.status === 'searching' && i < 1000; i++) search.advance(256)
  assert.notEqual(search.status, 'searching', 'search has a bounded completion')
  return search.path
}
function assertWalkable(grid: MotionGrid, path: readonly RoutePoint[], surf = false) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i]
    assert.equal(Math.abs(b.x - a.x) + Math.abs(b.y - a.y), 1, 'every breadcrumb is a neighbouring walkable tile')
    assert.ok(canStep(grid.map, gridField(grid), a.x, a.y, b.x, b.y, { surf }))
    assert.ok(!grid.blocked?.(b.x, b.y))
    const result = moveBody(grid, a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y, {
      radius: GAME.player.radius, surf, cornerSlip: GAME.player.cornerSlip, cornerSlipRate: GAME.player.cornerSlipRate, substep: GAME.player.substepTiles,
    })
    assert.ok(Math.abs(result.x - b.x - 0.5) < 0.001 && Math.abs(result.y - b.y - 0.5) < 0.001, 'the actual player body can walk the indicated step')
  }
}
function smallWorld(grid: MotionGrid, target: RoutePoint = { x: 4, y: 1 }): World {
  return { maps: { field: grid.map }, startMap: 'field', seed: 1, quests: [
    { id: 'delivery', nameZh: 'Delivery', kind: 'side', stages: [{ text: 'Deliver the parcel.', target: { map: 'field', ...target } }] },
  ], trainers: {}, towns: [], badges: [] } as World
}
const newSave = (world: World) => createSaveManager({ world, storage: null }).newGame({ name: 'QA', avatar: CONTENT.characters.find(c => c.playable)!.id })
const settle = (nav: ReturnType<typeof createQuestNavigator>, grid: MotionGrid, player: RoutePoint, save: SaveData, dt = 1 / 60) => {
  for (let i = 0; i < 1000; i++) {
    nav.update(dt, grid, player, save, false)
    if (!nav.state || nav.state.status !== 'searching') return nav.state
  }
  assert.fail('navigator did not settle')
}

test('A* takes the shortest detour around a wall instead of pointing straight through it', () => {
  const grid = fixture(['.......', '...#...', '...#...', '...#...', '.......'])
  const search = createRouteSearch(grid, { x: 1, y: 2 }, [{ x: 5, y: 2 }], false, rules)
  const path = finish(search)
  assert.equal(search.status, 'ready')
  assert.equal(path.length - 1, 8)
  assert.deepEqual(path[0], { x: 1, y: 2 })
  assert.deepEqual(path.at(-1), { x: 5, y: 2 })
  assertWalkable(grid, path)
})

test('bounded and sparse searches preserve the same shortest route and parent chain', () => {
  const grid = fixture(['........................................', '.#####..................................', '........................................'])
  const from = { x: 0, y: 1 }, goal = { x: 6, y: 1 }
  const dense = createRouteSearch(grid, from, [goal], false, rules)
  const sparse = createRouteSearch(grid, from, [goal], false, { ...rules, maxNodes: 100 })
  const path = finish(dense)
  assert.deepEqual(finish(sparse), path)
  assert.equal(path.length - 1, 8)
  assertWalkable(grid, path)
  const alreadyThere = createRouteSearch(grid, from, [from], false, rules)
  assert.deepEqual(finish(alreadyThere), [from])
})

test('A* is advanced over frames and never fabricates a path for an unreachable goal', () => {
  const grid = fixture(['.....', '#####', '.....'])
  const search = createRouteSearch(grid, { x: 0, y: 0 }, [{ x: 4, y: 2 }], false, rules)
  search.advance(1)
  assert.equal(search.status, 'searching')
  assert.equal(search.visited, 1)
  finish(search)
  assert.equal(search.status, 'unreachable')
  assert.deepEqual(search.path, [])
  const capped = createRouteSearch(fixture(['..........']), { x: 0, y: 0 }, [{ x: 9, y: 0 }], false, { ...rules, maxNodes: 2 })
  finish(capped)
  assert.equal(capped.status, 'unreachable')
  assert.equal(capped.visited, 2)
})

test('a long detour outside the old goal margin is still found, with deterministic A* tie-breaking', () => {
  const grid = fixture(Array.from({ length: 140 }, (_, y) => y < 130 ? '...#...' : '.......'))
  const search = createRouteSearch(grid, { x: 1, y: 2 }, [{ x: 5, y: 2 }], false, { ...rules, marginTiles: 2 })
  assert.equal(finish(search).length - 1, 260)
  assertWalkable(grid, search.path)
  const open = createRouteSearch(fixture(Array(100).fill('.'.repeat(100))), { x: 0, y: 0 }, [{ x: 99, y: 99 }], false, rules)
  finish(open)
  assert.equal(open.path.length - 1, 198)
  assert.equal(open.visited, 198, 'equal-score nodes prefer progress toward the goal, not a flood of the whole rectangle')
})

test('frontier routes keep negative tile coordinates and use the same collision rules as movement', () => {
  const grid = fixture(['.......', '.......', '.......']), size = 8, chunks = new Map<string, MapChunk>()
  const provider: ChunkProvider = {
    seed: 1, size, core: { x: 0, y: 0, width: grid.map.width, height: grid.map.height },
    chunk(cx, cy) {
      const key = `${cx},${cy}`
      let ch = chunks.get(key)
      if (!ch) {
        ch = { cx, cy, size, terrain: new Uint8Array(size * size).fill(terrain), elevation: new Uint8Array(size * size),
          region: new Uint8Array(size * size), regionIds: [], props: [], warps: [], npcs: [], signs: [], items: [], lights: [], places: [] }
        chunks.set(key, ch)
      }
      return ch
    },
    peek: (cx, cy) => chunks.get(`${cx},${cy}`) ?? null,
    region: () => null, interior: () => null, place: () => null,
    sample: () => ({ terrain, elevation: 0, biome: 'meadow' }), retain() {},
  }
  grid.map.infinite = provider
  delete grid.col
  grid.blocked = (x, y) => x === -5 && y === -6
  const search = createRouteSearch(grid, { x: -8, y: -6 }, [{ x: 2, y: -6 }], false, rules)
  const path = finish(search)
  assert.equal(search.status, 'ready')
  assert.equal(path.length - 1, 12)
  assert.deepEqual(path[0], { x: -8, y: -6 })
  assert.deepEqual(path.at(-1), { x: 2, y: -6 })
  assertWalkable(grid, path)
})

test('the route respects surf ability, elevation and the movement guard', () => {
  const water = fixture(['..~..'])
  const plain = createRouteSearch(water, { x: 0, y: 0 }, [{ x: 4, y: 0 }], false, rules)
  finish(plain)
  assert.equal(plain.status, 'unreachable')
  assertWalkable(water, finish(createRouteSearch(water, { x: 0, y: 0 }, [{ x: 4, y: 0 }], true, rules)), true)
  const cliff = fixture(['.....'])
  cliff.map.elevation[2] = 1
  const cliffRoute = createRouteSearch(cliff, { x: 0, y: 0 }, [{ x: 4, y: 0 }], false, rules)
  finish(cliffRoute)
  assert.equal(cliffRoute.status, 'unreachable')
  const veto = { ...fixture(['.....']), stepGuard: (_x: number, _y: number, tx: number) => tx !== 2 }
  const guarded = createRouteSearch(veto, { x: 0, y: 0 }, [{ x: 4, y: 0 }], false, rules)
  finish(guarded)
  assert.equal(guarded.status, 'unreachable')
})

test('walking routes do not accidentally enter an unrelated building', () => {
  const grid = fixture(['.....', '.....', '.....'])
  grid.map.warps.push({ x: 2, y: 1, toMap: 'wrong-room', toX: 1, toY: 1, kind: 'door', facing: 'down' })
  const path = finish(createRouteSearch(grid, { x: 0, y: 1 }, [{ x: 4, y: 1 }], false, rules))
  assert.equal(path.length - 1, 6)
  assert.ok(!path.some(p => p.x === 2 && p.y === 1))
  assertWalkable(grid, path)
})

test('a quest creates navigation only after acceptance; untracking, completion and disabling guidance clear it', () => {
  const grid = fixture(['.....', '.....', '.....']), world = smallWorld(grid), save = newSave(world)
  const nav = createQuestNavigator(world, rules), player = { x: 0.5, y: 1.5 }
  save.trackedQuest = 'delivery'
  assert.equal(trackedQuest(world, save), null, 'a stale tracked id is not an accepted quest')
  assert.equal(settle(nav, grid, player, save), null)
  delete save.trackedQuest
  const ctx = { data: { ...CONTENT, world }, save, events: { emit() {} } } as unknown as GameContext
  applyQuest(ctx, 'delivery', 0, false)
  assert.equal(settle(nav, grid, player, save)?.status, 'ready')
  delete save.trackedQuest
  assert.equal(settle(nav, grid, player, save), null)
  save.trackedQuest = 'delivery'
  save.settings.showObjective = false
  assert.equal(settle(nav, grid, player, save), null)
  save.settings.showObjective = true
  assert.equal(settle(nav, grid, player, save)?.status, 'ready')
  applyQuest(ctx, 'delivery', 0, true)
  assert.equal(settle(nav, grid, player, save), null)
})

test('following breadcrumbs trims distance; moving off the route starts a new path from the actual position', () => {
  const grid = fixture(['.....', '.....', '.....']), world = smallWorld(grid), save = newSave(world)
  save.quests.delivery = { stage: 0, done: false }; save.trackedQuest = 'delivery'
  const nav = createQuestNavigator(world, rules)
  assert.equal(settle(nav, grid, { x: 0.5, y: 1.5 }, save)?.steps, 4)
  assert.equal(settle(nav, grid, { x: 1.5, y: 1.5 }, save)?.steps, 3)
  const rerouted = settle(nav, grid, { x: 1.5, y: 2.5 }, save)!
  assert.deepEqual(rerouted.path[0], { x: 1, y: 2 })
  assert.equal(rerouted.steps, 4)
  assertWalkable(grid, rerouted.path)
})

test('an NPC stepping onto the next tile causes a fresh walkable detour', () => {
  const grid = fixture(['.....', '.....', '.....']), world = smallWorld(grid), save = newSave(world)
  const blocked = new Set<string>()
  grid.blocked = (x, y) => blocked.has(`${x},${y}`)
  save.quests.delivery = { stage: 0, done: false }; save.trackedQuest = 'delivery'
  const nav = createQuestNavigator(world, rules), player = { x: 0.5, y: 1.5 }
  settle(nav, grid, player, save)
  blocked.add('1,1')
  const rerouted = settle(nav, grid, player, save, rules.recheckSec + 0.01)!
  assert.equal(rerouted.status, 'ready')
  assert.equal(rerouted.steps, 6)
  assertWalkable(grid, rerouted.path)
})

test('an NPC goal stops on an adjacent interaction tile, never inside the character', () => {
  const grid = fixture(['.....', '.....', '.....']), world = smallWorld(grid), save = newSave(world)
  grid.map.npcs.push({ id: 'partner', x: 4, y: 1, facing: 'left', sprite: 'villager_man', nameZh: 'Partner', role: 'villager', script: [] })
  grid.blocked = (x, y) => x === 4 && y === 1
  save.quests.delivery = { stage: 0, done: false }; save.trackedQuest = 'delivery'
  const state = settle(createQuestNavigator(world, rules), grid, { x: 0.5, y: 1.5 }, save)!
  assert.equal(state.steps, 3)
  assert.deepEqual(state.path.at(-1), { x: 3, y: 1 })
  assertWalkable(grid, state.path)
})

test('a moving task NPC changes the interaction destination rather than leaving breadcrumbs at its spawn', () => {
  const grid = fixture(Array(5).fill('.......')), w = smallWorld(grid, { x: 4, y: 1 }), save = newSave(w)
  let npc = { x: 4.5, y: 1.5 }
  grid.blocked = (x, y) => x === Math.floor(npc.x) && y === Math.floor(npc.y)
  save.quests.delivery = { stage: 0, done: false }; save.trackedQuest = 'delivery'
  const nav = createQuestNavigator(w, rules), player = { x: 0.5, y: 1.5 }
  nav.update(1 / 60, grid, player, save, false, () => npc)
  assert.deepEqual(nav.state!.target, { map: 'field', x: 4, y: 1 })
  npc = { x: 5.5, y: 3.5 }
  nav.update(rules.recheckSec + 0.01, grid, player, save, false, () => npc)
  assert.equal(nav.state!.status, 'ready')
  assert.deepEqual(nav.state!.target, { map: 'field', x: 5, y: 3 })
  const end = nav.state!.path.at(-1)!
  assert.equal(Math.abs(end.x - 5) + Math.abs(end.y - 3), 1)
  assertWalkable(grid, nav.state!.path)
})

test('a deviation on a long route repairs nearby breadcrumbs without repeating the full distant search', () => {
  const grid = fixture(Array.from({ length: 140 }, (_, y) => y < 130 ? '...#...' : '.......'))
  const w = smallWorld(grid, { x: 5, y: 2 }), save = newSave(w)
  save.quests.delivery = { stage: 0, done: false }; save.trackedQuest = 'delivery'
  const nav = createQuestNavigator(w, { ...rules, nodesPerFrame: 32 })
  assert.equal(settle(nav, grid, { x: 1.5, y: 2.5 }, save)!.status, 'ready')
  nav.update(1 / 60, grid, { x: 0.5, y: 2.5 }, save, false)
  assert.equal(nav.state!.status, 'ready', 'local repair fits in one 32-node frame')
  assert.deepEqual(nav.state!.path[0], { x: 0, y: 2 })
  assert.deepEqual(nav.state!.path.at(-1), { x: 5, y: 2 })
  assertWalkable(grid, nav.state!.path)
})

test('cross-map guidance chooses a usable door and handles several map transitions', () => {
  const a = fixture(['.....', '.....', '.....']).map
  const b = { ...a, id: 'hall', warps: [{ x: 4, y: 1, toMap: 'final', toX: 0, toY: 1, kind: 'stairs', facing: 'right' }] } as GameMap
  const c = { ...a, id: 'final', warps: [] }
  a.warps = [{ x: 4, y: 1, toMap: b.id, toX: 0, toY: 1, kind: 'door', facing: 'right' }]
  const world = smallWorld({ map: a })
  world.maps.hall = b; world.maps.final = c
  assert.deepEqual(navigationWaypoints(world, { map: 'field', x: 0, y: 1 }, { map: 'final', x: 3, y: 1 }), [
    { point: { map: 'field', x: 4, y: 1 }, nextMap: 'hall' },
  ])
})

const world = buildWorld()
const anchors = worldAnchors(world)

test('real home -> street -> lab guidance leads inside to the professor, without an exit loop', () => {
  const save = newSave(world)
  save.quests.main = { stage: 0, done: false }; save.trackedQuest = 'main'
  const nav = createQuestNavigator(world, rules)
  for (const mapId of ['origin-home', world.startMap, 'origin-lab']) {
    const map = world.maps[mapId], grid = { map, field: collisionField(map),
      blocked: (x: number, y: number) => map.npcs.some(n => n.x === x && n.y === y),
    }
    const state = settle(nav, grid, { x: map.spawn.x + 0.5, y: map.spawn.y + 0.5 }, save)!
    assert.equal(state.status, 'ready')
    assert.equal(state.target.map, 'origin-lab')
    assertWalkable(grid, state.path)
    if (mapId === 'origin-lab') {
      assert.equal(state.nextMap, undefined)
      const professor = anchors['origin-lab:professor']
      assert.equal(Math.abs(state.waypoint.x - professor.x) + Math.abs(state.waypoint.y - professor.y), 1)
    } else assert.equal(state.nextMap, mapId === 'origin-home' ? world.startMap : 'origin-lab')
  }
})

test('all core main quest destinations have collision-valid routes from the origin', () => {
  const map = world.maps[world.startMap], grid = { map, field: collisionField(map) }, save = newSave(world)
  save.trackedQuest = 'main'
  const stages = world.quests.find(q => q.id === 'main')!.stages
  for (let stage = 0; stage < stages.length; stage++) {
    save.quests.main = { stage, done: false }
    const state = settle(createQuestNavigator(world, rules), grid, { x: map.spawn.x + 0.5, y: map.spawn.y + 0.5 }, save)!
    assert.equal(state.status, 'ready', `stage ${stage}: reachable walking route`)
    assertWalkable(grid, state.path)
  }
})

test('accepted side quests override story suggestions and drive the minimap through the same waypoint', () => {
  const grid = fixture(['.....', '.....', '.....']), w = smallWorld(grid), save = newSave(w)
  w.quests.push({ id: 'main', nameZh: 'Main', kind: 'main', stages: [{ text: 'Main stage', target: { map: 'field', x: 0, y: 0 } }] } satisfies QuestDef)
  save.quests = { main: { stage: 0, done: false }, delivery: { stage: 0, done: false } }; save.trackedQuest = 'delivery'
  const nav = createQuestNavigator(w, rules)
  const state = settle(nav, grid, { x: 0.5, y: 1.5 }, save)!
  assert.equal(state.questId, 'delivery')
  const sources = { map: grid.map, world: w, save, npcs: [], remotes: [], roamers: [], navigation: state }
  const markers = collectMarkers(sources).filter(m => m.kind === 'quest')
  assert.deepEqual(markers, [{ x: 4.5, y: 1.5, kind: 'quest', label: 'Delivery' }])
  delete save.trackedQuest
  settle(nav, grid, { x: 0.5, y: 1.5 }, save)
  assert.deepEqual(collectMarkers({ ...sources, navigation: nav.state }).filter(m => m.kind === 'quest'), [])
})

test('an opened physical gate is noticed after an unreachable result', () => {
  const grid = fixture(['.....'])
  const stone = CONTENT.terrain.find(t => !t.walkable && !t.swim)!.id
  grid.map.terrain[2] = stone
  delete grid.col
  const w = smallWorld(grid, { x: 4, y: 0 }), save = newSave(w)
  save.quests.delivery = { stage: 0, done: false }; save.trackedQuest = 'delivery'
  const nav = createQuestNavigator(w, rules), player = { x: 0.5, y: 0.5 }
  assert.equal(settle(nav, grid, player, save)?.status, 'unreachable')
  grid.map.terrain[2] = terrain
  invalidateCollision(grid.map)
  assert.equal(settle(nav, grid, player, save, rules.retrySec + 0.01)?.status, 'ready')
})
