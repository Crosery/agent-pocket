import type { GameMap } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { Rng } from '../src/shared/rng.ts'
import { RngHub } from '../src/client/core/rng-hub.ts'
import { collisionField, regionAt, terrainAt, warpAt } from '../src/shared/world/worldapi.ts'
import { createOverworld } from '../src/client/world/controller.ts'
import { createRoamingLayer } from '../src/client/world/roaming.ts'
import { createGameplayRuntime } from '../src/client/world/events-runtime.ts'
import { findHabitatSpot, makeRuntimeRig, overworld } from '../tests/pacing-fixture.ts'

const assert = {
  ok(value: unknown, message = 'Expected a truthy value') {
    if (!value) throw new Error(message)
  },
  equal(actual: unknown, expected: unknown, message = 'Values differ') {
    if (!Object.is(actual, expected)) throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`)
  },
  notEqual(actual: unknown, expected: unknown, message = 'Values unexpectedly match') {
    if (Object.is(actual, expected)) throw new Error(message)
  },
}

export async function runPacingRuntime() {
  const roaming = runRoamingRuntime()
  const walking = await runOverworldPacing()
  return { roaming, walking }
}
function runRoamingRuntime() {
  const { ctx } = makeRuntimeRig(101)
  const rng = new Rng(101)

  // 1. A paved-road map inside an encounter region spawns 0 roamers through createRoamingLayer
  const w = 40, h = 40
  const pathId = CONTENT.terrainByKey.path.id
  const meadowRegion = overworld.regions.find((r) => r.id === 'meadow') ?? overworld.regions.find((r) => r.encounters.length > 0)!
  const roadMap: GameMap = {
    ...overworld,
    infinite: undefined,
    id: 'test-road',
    width: w,
    height: h,
    terrain: new Uint8Array(w * h).fill(pathId),
    elevation: new Uint8Array(w * h),
    region: new Uint8Array(w * h).fill(0),
    regions: [meadowRegion],
    props: [], warps: [], npcs: [], signs: [], items: [], lights: [],
  }
  const roadGrid = { map: roadMap, field: collisionField(roadMap) }
  const roadPlayer = { x: 20.5, y: 20.5 }
  const roadRoaming = createRoamingLayer({
    ctx,
    rng: new Rng(202),
    grid: () => roadGrid,
    reserved: () => false,
  })
  for (let t = 0; t < 60; t += 0.2) {
    const touched = roadRoaming.update(0.2, roadPlayer, true)
    assert.equal(touched, null, 'paved road never triggers a roaming touch battle')
  }
  assert.equal(roadRoaming.list.length, 0, 'createRoamingLayer spawns 0 roamers when all tiles are non-encounter road terrain')

  // 2. On the real overworld habitat, createRoamingLayer + createGameplayRuntime spawns only on encounter terrain,
  //    at distance >= minSpawnDistance (no spawn-on-player chain fight), capped by roamingMax, and never chasing.
  const spot = findHabitatSpot()
  const player = { x: spot.x, y: spot.y }
  const owGrid = { map: overworld, field: collisionField(overworld) }
  const gameplay = createGameplayRuntime({
    ctx,
    rng,
    place: () => ({ map: overworld, x: player.x, y: player.y, region: regionAt(overworld, player.x, player.y) }),
    weather: () => 'clear',
    setEventWeather() {},
    npcs: { add() {}, remove() {} },
    reserved: (tx, ty) => !!warpAt(overworld, tx, ty),
    runScript: async () => {},
    startWild: async () => ({ result: 'run', moneyDelta: 0 }),
  })
  const owRoaming = createRoamingLayer({
    ctx,
    rng,
    grid: () => owGrid,
    reserved: (tx, ty) => !!warpAt(overworld, tx, ty),
    pick: (region, x, y, present) => gameplay.roamPick(region, x, y, present),
    cue: (key, at) => gameplay.cue(key, at),
  })

  const seenIds = new Set<number>()
  for (let t = 0; t < 90; t += 0.2) {
    const touched = owRoaming.update(0.2, player, true)
    assert.equal(touched, null, 'standing still in habitat is never chased down or spawned on top of')
    for (const r of owRoaming.list) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id)
        const spawnDist = Math.hypot(r.home.x - player.x, r.home.y - player.y)
        assert.ok(spawnDist >= 8.5, `newly spawned roamer at ${spawnDist.toFixed(2)} tiles must not spawn on top of player`)
        const tileTerrain = CONTENT.terrain[terrainAt(overworld, Math.floor(r.home.x), Math.floor(r.home.y))]
        assert.equal(tileTerrain?.encounter, true, `roamer spawned on ${tileTerrain?.key} instead of encounter terrain`)
      }
      assert.notEqual(r.mood, 'chase', `roamer ${r.creature.speciesId} must not default to chase`)
    }
  }
  assert.ok(owRoaming.list.length >= 1 && owRoaming.list.length <= CONTENT.config.encounters.roamingMax, `active roamers (${owRoaming.list.length}) within cap`)

  // 3. Voluntary collection vs narrow brush-past on a real spawned roamer
  const targetRoamer = owRoaming.list[0]
  assert.ok(targetRoamer, 'at least one roamer available for voluntary collection')
  const brushPast = owRoaming.update(0.05, { x: targetRoamer.x + 0.50, y: targetRoamer.y }, true)
  assert.equal(brushPast, null, 'passing 0.50 tiles away does not trigger involuntary touch battle')
  const deliberateTouch = owRoaming.update(0.05, { x: targetRoamer.x + 0.10, y: targetRoamer.y }, true)
  assert.equal(deliberateTouch?.id, targetRoamer.id, 'stepping into roamer (0.10 tiles) triggers voluntary encounter')
  const result = { roadSpawns: roadRoaming.list.length, habitatSpawns: seenIds.size, brushPassTriggered: brushPast !== null, intentionalTouchTriggered: deliberateTouch?.id === targetRoamer.id }
  roadRoaming.clear()
  owRoaming.clear()
  gameplay.dispose()
  return result
}
async function runOverworldPacing() {
  const { ctx, save, localWorld, setAxis } = makeRuntimeRig(303)
  const spot = findHabitatSpot()
  const region = regionAt(overworld, spot.x, spot.y)!
  assert.ok(region && region.encounterRate > 0)

  // 1. 5,000 steps through tall grass via real gameplay.rollGrass
  const gameplay = createGameplayRuntime({
    ctx,
    rng: new Rng(303),
    place: () => ({ map: overworld, x: spot.x, y: spot.y, region }),
    weather: () => 'clear',
    setEventWeather() {},
    npcs: { add() {}, remove() {} },
    reserved: () => false,
    runScript: async () => {},
    startWild: async () => ({ result: 'run', moneyDelta: 0 }),
  })
  const steps = 5000
  let encounters = 0
  for (let i = 0; i < steps; i++) {
    if (gameplay.rollGrass(region, { repelActive: false, leadLevel: 5 })) encounters++
  }
  assert.ok(encounters >= 12 && encounters <= 55, `expected ~30 tall-grass encounters in 5000 steps, got ${encounters}`)

  let repelEncounters = 0
  for (let i = 0; i < 500; i++) {
    if (gameplay.rollGrass(region, { repelActive: true, leadLevel: 30 })) repelEncounters++
  }
  assert.equal(repelEncounters, 0, 'repel blocks all weaker wild encounters in gameplay.rollGrass')

  // 2. Real createOverworld controller: 22-step grace window in 100%-rate tall grass, plus 5% blackout penalty
  const gw = 60, gh = 10
  const tallGrassId = CONTENT.terrainByKey.tall_grass.id
  const highRateRegion = { ...region, encounterRate: 20, roamingDensity: 0 }
  localWorld.maps['test-grace'] = {
    ...overworld,
    infinite: undefined,
    id: 'test-grace',
    width: gw,
    height: gh,
    terrain: new Uint8Array(gw * gh).fill(tallGrassId),
    elevation: new Uint8Array(gw * gh),
    region: new Uint8Array(gw * gh).fill(0),
    regions: [highRateRegion],
    props: [], warps: [], npcs: [], signs: [], items: [], lights: [],
    spawn: { x: 2, y: 5, facing: 'right' },
  }

  const prevRaf = globalThis.requestAnimationFrame
  const ow = createOverworld(ctx, { rng: new RngHub(303) })
  try {
    globalThis.requestAnimationFrame = () => 0
    // Blackout deducts 5% (150 from 3000), not 25% (750)
    save.money = 3000
    await ow.blackout()
    assert.equal(save.money, 2850, 'createOverworld.blackout deducts 5% money (150 from 3000)')

    // Enter high-rate tall-grass strip: first 22 tile steps are protected by graceTiles, step 23 triggers encounter
    save.stats.steps = 0
    await ow.enterMap('test-grace', 2, 5, 'right', false)
    setAxis(1, 0)
    let encounterStep = -1
    for (let tick = 0; tick < 800; tick++) {
      ow.update(0.05)
      if (!ow.free) {
        encounterStep = save.stats.steps
        break
      }
    }
    assert.equal(encounterStep, 23, `createOverworld protected exactly 22 grace steps before first tall-grass battle on step ${encounterStep}`)
    return { steps, encounters, repelEncounters, firstEncounterStep: encounterStep, blackoutFrom: 3000, blackoutAfter: save.money }
  } finally {
    ow.dispose()
    gameplay.dispose()
    globalThis.requestAnimationFrame = prevRaf
  }
}
