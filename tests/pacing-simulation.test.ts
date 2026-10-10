// Consumer-path regressions for overworld roaming/encounter pacing, 22-step grace & blackout via createOverworld,
// zero-wild-grind XP progression via BattleEngine/startBossBattle, and ds-loss recovery via createScriptRunner.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { BattleInit, GameMap, ScriptStep, TrainerDef } from '../src/shared/types.ts'
import type { CreatureActor, GameContext } from '../src/client/contracts.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { Rng } from '../src/shared/rng.ts'
import { RngHub } from '../src/client/core/rng-hub.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { collisionField, regionAt, terrainAt, warpAt } from '../src/shared/world/worldapi.ts'
import { rivalTrainerId, STORY_CONTENT } from '../src/shared/world/story.ts'
import { createCreature, expForLevel, healFull } from '../src/shared/creature.ts'
import { BattleEngine } from '../src/shared/battle/engine.ts'
import { startBossBattle } from '../src/shared/battle/boss-battle.ts'
import { applyResearch, researchFromBattle } from '../src/shared/gameplay/research.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { createOverworld } from '../src/client/world/controller.ts'
import { createRoamingLayer } from '../src/client/world/roaming.ts'
import { createGameplayRuntime } from '../src/client/world/events-runtime.ts'
import { standable } from '../src/client/world/rarity-spawns.ts'
import { claimResearchRewards, researchSummary } from '../src/client/world/research.ts'
import { createScriptRunner, type ScriptHost } from '../src/client/world/script.ts'
import { fightStory, STARTERS } from './boss-story.ts'

export const FIXED_SIMULATION_SEEDS = [101, 202, 303, 404, 505, 606, 707, 808, 909, 1001] as const

const world = buildWorld()
const overworld = world.maps[world.startMap]

const stubCreatureActor = (): CreatureActor => ({
  object: undefined as never, x: 0, y: 0, elev: 0, speciesId: '',
  setPosition() {}, setFacingLeft() {}, setMoving() {}, setVisible() {}, setShiny() {}, setAura() {}, bubble() {}, update() {}, dispose() {},
})

function makeRuntimeRig(seed = 20261011) {
  const saves = createSaveManager({ world, storage: null })
  const avatar = CONTENT.characters.find((c) => c.playable) ?? CONTENT.characters[0]
  const save = saves.newGame({ name: '测试', avatar: avatar.id })
  const lead = createCreature('o1', 6, { rng: new Rng(seed) }, CONTENT)
  healFull(lead, CONTENT)
  save.party = [lead]
  let choice = 0
  let axis = { x: 0, y: 0 }
  const toasts: string[] = []
  const localWorld = { ...world, maps: { ...world.maps } }
  const ctx = {
    data: { ...CONTENT, world: localWorld },
    save,
    clock: { timeOfDay: 'day', minutesOfDay: 600, label: () => '10:00' },
    world: {
      map: null,
      async loadMap() {},
      createActor: () => ({
        setName() {}, setPosition() {}, setFacing() {}, setMoving() {}, hop() {}, bubble() {}, update() {}, dispose() {},
      }),
      createCreatureActor: stubCreatureActor,
      elevationAt: () => 0,
      spawnFx() {},
      setBeacons() {},
      setQuestPath() {},
      setGroundItems() {},
      setZoom() {},
      setWeather() {},
      update() {},
    },
    minimap: {
      exploredBits: () => null,
      setMap() {},
      setFogPages() {},
      reveal() {},
      update() {},
    },
    ui: {
      async say() {},
      async choose() { return choice },
      async confirm() { return false },
      toast(text: string) { toasts.push(text) },
      async fade() {},
      isBlocking: () => false,
    },
    hud: {
      overlay: { style: { visibility: '' } },
      setRegion() {},
      setClock() {},
      setMoney() {},
      setQuest() {},
      setLead() {},
      setPrompts() {},
      setEvents() {},
      setLegendSense() {},
      showBanner() {},
    },
    input: {
      axis: () => axis,
      held: () => false,
      pressed: () => false,
      consume() {},
      onWorldTap: () => () => {},
    },
    net: {
      status: 'offline',
      send() {},
      reportPosition() {},
      setStepReplay() {},
      onCorrection: () => () => {},
    },
    chat: { isOpen: false },
    audio: { currentBgm: '', playSfx() {}, playCry() {}, playBgm() {} },
    events: { emit() {}, on: () => () => {}, once: () => () => {} },
    renderer: { flash() {}, shake() {}, setTransition() {} },
    battle: { async run() { return { result: 'run', moneyDelta: 0 } } },
    screens: { async starter(o: { id: string }[]) { return o[0].id }, async shop() {}, async box() {} },
    persist() {},
  } as unknown as GameContext
  return {
    ctx,
    save,
    localWorld,
    toasts,
    setChoice: (i: number) => { choice = i },
    setAxis: (x: number, y: number) => { axis = { x, y } },
  }
}

/** Finds an open habitat spot in the overworld where tall grass and roaming encounters exist. */
function findHabitatSpot(): { x: number; y: number } {
  const ctx = { data: { ...CONTENT, world } } as unknown as Pick<GameContext, 'data'>
  for (let r = 6; r < 90; r += 2) {
    for (let dy = -r; dy <= r; dy += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        const cx = overworld.spawn.x + dx
        const cy = overworld.spawn.y + dy
        const rg = regionAt(overworld, cx, cy)
        if (!rg || !rg.encounters.length || rg.roamingDensity <= 0.3) continue
        if (!standable(overworld, cx, cy, ctx)) continue
        let grassCount = 0
        for (let y = cy - 12; y <= cy + 12; y++) {
          for (let x = cx - 12; x <= cx + 12; x++) {
            const t = CONTENT.terrain[terrainAt(overworld, x, y)]
            if (t?.encounter) grassCount++
          }
        }
        if (grassCount >= 40) return { x: cx + 0.5, y: cy + 0.5 }
      }
    }
  }
  throw new Error('no habitat spot found near spawn')
}

/** Runs a real BattleEngine fight using greedy damaging moves (and optional first-turn item) until finished. */
function runEngineFight(init: BattleInit, firstTurnItem?: string): BattleEngine {
  const engine = new BattleEngine(init, CONTENT)
  engine.start()
  let usedItem = false
  for (let guard = 0; !engine.finished && guard < 400; guard++) {
    const req = engine.request(0)
    if (req.kind === 'action') {
      if (firstTurnItem && !usedItem && req.canItem) {
        usedItem = true
        if (engine.choose(0, { kind: 'item', itemId: firstTurnItem, partyIndex: 0 }) === null) {
          engine.step()
          continue
        }
      }
      const me = engine.party(0)[engine.activeIndex(0)]
      const order = me.moves
        .map((_, i) => i)
        .sort((a, b) => Number((CONTENT.moves[me.moves[b].id]?.power ?? 0) > 0) - Number((CONTENT.moves[me.moves[a].id]?.power ?? 0) > 0) || a - b)
      for (const i of order) {
        if (me.moves[i].pp > 0 && engine.choose(0, { kind: 'move', moveIndex: i }) === null) break
      }
    } else if (req.kind === 'switch') {
      const party = engine.party(0)
      for (let i = 0; i < party.length; i++) {
        if (party[i].hp > 0 && engine.choose(0, { kind: 'switch', partyIndex: i }) === null) break
      }
    }
    engine.step()
  }
  return engine
}

test('roaming runtime: paved roads spawn 0 roamers; habitat spawns stay on encounter tiles, never chase, and require close touch', () => {
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
})

test('overworld & tall-grass runtime: createOverworld enforces 22-step grace window, 5% blackout penalty, and reduced grass rate', async () => {
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
  globalThis.requestAnimationFrame = () => 0
  const ow = createOverworld(ctx, { rng: new RngHub(303) })
  try {
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
  } finally {
    ow.dispose()
    globalThis.requestAnimationFrame = prevRaf
  }
})

test('zero-extra-wild-battles progression: real BattleEngine & startBossBattle fights bring all starters to Lv8 and beat V4', async () => {
  for (const starter of STARTERS) {
    const { ctx, save, setChoice } = makeRuntimeRig(505)
    assert.equal(save.bag['cache-potion'], 2, 'new game starts with 2 cache-potions')

    const starterCr = createCreature(starter, CONTENT.config.creature.starterLevel, { rng: new Rng(11), gradeFloor: CONTENT.quality.giftGradeFloor }, CONTENT)
    healFull(starterCr, CONTENT)
    save.party = [starterCr]
    save.flags.starter = starter

    const buildTrainerFight = (tr: TrainerDef, seed: number): BattleInit => {
      const rng = new Rng(seed)
      const foes = tr.party.map((p) => {
        const cr = createCreature(p.species!, p.level, { rng, ...(p.moves ? { moves: p.moves } : {}) }, CONTENT)
        healFull(cr, CONTENT)
        return cr
      })
      return {
        seed,
        sides: [
          { kind: 'player', name: save.name, party: save.party },
          { kind: 'trainer', name: tr.nameZh, party: foes, aiLevel: tr.aiLevel, ...(tr.items ? { items: { ...tr.items } } : {}) },
        ],
        isWild: false,
        canRun: false,
        canCatch: false,
        expGain: true,
        biome: CONTENT.biomes[0].id,
        timeOfDay: 'day',
      }
    }

    // 1. Real BattleEngine fight against Lab Rival
    const rivalTr = world.trainers[rivalTrainerId('lab', starter)]
    assert.ok(rivalTr, `lab rival exists for ${starter}`)
    const rivalEngine = runEngineFight(buildTrainerFight(rivalTr, 101))
    assert.equal(rivalEngine.result, 'win', `${starter} wins lab rival fight`)
    assert.ok(starterCr.exp > expForLevel(CONTENT.species[starter].growth, 5, CONTENT), 'BattleEngine awarded lab rival EXP')

    // 2. Skip type lesson via real script runner on STORY_CONTENT.scripts['ds-aide']
    const host: ScriptHost = {
      ctx,
      async moveNpc() {},
      faceNpc() {},
      setNpcHidden() {},
      async trainerBattle() { return 'win' },
      async wildBattle() { return 'caught' },
      async blackout() {},
      async warp() {},
      playerPlace: () => ({ map: world.startMap, x: 1, y: 1, facing: 'down' }),
      playMusic() {},
      onWorldChanged() {},
    }
    const runner = createScriptRunner(host)
    setChoice(1) // Option 2: skip lesson ("我都懂")
    await runner.run(STORY_CONTENT.scripts['ds-aide'] as unknown as ScriptStep[], null)
    const phi3 = save.party.find((c) => c.speciesId === 'phi-3')
    assert.ok(phi3, 'ds-aide script gave phi-3')
    assert.equal(phi3.level, 6, 'ds-aide script grants Lv6 phi-3 on skip path')

    // 3. Real BattleEngine fight for scripted Ernie-Bot capture on Route 1 (0 EXP for capture, +8 research pts)
    const ernieFoe = createCreature('ernie-bot', 6, { rng: new Rng(17), moves: ['token-tackle', 'web-crawl', 'morning-greeting', 'embedding-orb'] }, CONTENT)
    const ernieEngine = runEngineFight({
      seed: 202,
      sides: [
        { kind: 'player', name: save.name, party: save.party, items: { 'prompt-ball': 5 } },
        { kind: 'wild', name: 'ernie-bot', party: [ernieFoe] },
      ],
      isWild: true,
      canRun: true,
      canCatch: true,
      expGain: true,
      mods: { catchRate: 100 },
      biome: CONTENT.biomes[0].id,
      timeOfDay: 'day',
    }, 'prompt-ball')
    assert.equal(ernieEngine.result, 'caught', 'Ernie-Bot caught in real BattleEngine')
    save.party.splice(1, 0, createCreature('ernie-bot', 6, {
      rng: new Rng(19),
      gradeFloor: CONTENT.quality.giftGradeFloor,
      moves: ['token-tackle', 'web-crawl', 'morning-greeting', 'embedding-orb'],
    }, CONTENT))

    // Apply battle research from Ernie capture and verify Research Lv1 reward claim
    const researchEvents = researchFromBattle({
      seen: ['ernie-bot'],
      defeated: [],
      result: 'caught',
      caught: { speciesId: 'ernie-bot', shiny: false },
      foeMoves: [],
      timeOfDay: 'day',
      weather: 'clear',
      biome: 'grassland',
    })
    save.research = applyResearch(save.research ?? {}, researchEvents).state
    const summary = researchSummary(save)
    assert.ok(summary.level >= 1 && summary.canClaim, `Ernie capture + Phi-3 reaches Research Lv1 (points=${summary.points})`)
    const claimed = claimResearchRewards(ctx)
    assert.ok(claimed, 'claimed Research Lv1 rewards')
    assert.equal(claimed.money, 500)
    assert.equal(claimed.items['prompt-ball'], 10)
    assert.equal(claimed.items['repel'], 2)

    // 4. Real startBossBattle against V2 sparring partner (deepseek-drill, tier 'story', expGain: true)
    for (const c of save.party) healFull(c, CONTENT)
    const expBeforeDrill = starterCr.exp
    const { engine: drillEngine } = startBossBattle('deepseek-drill', save.party, {
      seed: 303,
      tier: 'story',
      expGain: true,
      items: { 'off-peak-coupon': 3 },
    })
    for (let guard = 0; !drillEngine.finished && guard < 400; guard++) {
      const req = drillEngine.request(0)
      if (req.kind === 'action') {
        const me = drillEngine.party(0)[drillEngine.activeIndex(0)]
        const order = me.moves
          .map((_, i) => i)
          .sort((a, b) => Number((CONTENT.moves[me.moves[b].id]?.power ?? 0) > 0) - Number((CONTENT.moves[me.moves[a].id]?.power ?? 0) > 0) || a - b)
        for (const i of order) {
          if (me.moves[i].pp > 0 && drillEngine.choose(0, { kind: 'move', moveIndex: i }) === null) break
        }
      } else if (req.kind === 'switch') {
        for (let i = 0; i < save.party.length; i++) {
          if (save.party[i].hp > 0 && drillEngine.choose(0, { kind: 'switch', partyIndex: i }) === null) break
        }
      }
      drillEngine.step()
    }
    assert.equal(drillEngine.result, 'win', `${starter} defeats deepseek-drill sparring partner`)
    assert.equal(starterCr.exp - expBeforeDrill, 372, 'deepseek-drill awards 372 EXP via real BattleEngine')

    // 5. Real BattleEngine fight against Corridor Relay trainer (ds-relay-<starter>)
    for (const c of save.party) healFull(c, CONTENT)
    const relayTr = world.trainers[`ds-relay-${starter}`]
    assert.ok(relayTr, `relay trainer ds-relay-${starter} exists`)
    const relayEngine = runEngineFight(buildTrainerFight(relayTr, 404))
    assert.equal(relayEngine.result, 'win', `${starter} wins corridor relay trainer fight`)

    // Verify starter reached Lv8 with 0 extra wild battles
    assert.equal(starterCr.level, 8, `${starter} reaches Lv8 before DeepSeek-V4 with 0 extra wild battles (exp=${starterCr.exp})`)

    // 6. Verify guided boss readiness across FIXED_SIMULATION_SEEDS using the Lv8 party earned above
    let wins = 0
    for (const seed of FIXED_SIMULATION_SEEDS) {
      const party = save.party.map((c) => {
        const copy = structuredClone(c)
        healFull(copy, CONTENT)
        return copy
      })
      const run = fightStory(party, 'guided', seed, { 'cache-potion': 2, 'off-peak-coupon': 2 })
      if (run.won) wins++
    }
    const winRate = wins / FIXED_SIMULATION_SEEDS.length
    assert.ok(winRate >= 0.8, `${starter} Lv8 party guided win rate ${(winRate * 100).toFixed(0)}% must be >= 80%`)
  }
})

test('defeat recovery runtime: createScriptRunner executes STORY_CONTENT.scripts["ds-loss"] without duplicate stacking', async () => {
  const { ctx, save } = makeRuntimeRig(707)
  const host: ScriptHost = {
    ctx,
    async moveNpc() {},
    faceNpc() {},
    setNpcHidden() {},
    async trainerBattle() { return 'win' },
    async wildBattle() { return 'win' },
    async blackout() {},
    async warp() {},
    playerPlace: () => ({ map: world.startMap, x: 1, y: 1, facing: 'down' }),
    playMusic() {},
    onWorldChanged() {},
  }
  const runner = createScriptRunner(host)
  const dsLossSteps = STORY_CONTENT.scripts['ds-loss'] as unknown as ScriptStep[]

  // 1. Depleted inventory (0 coupons, 1 potion) and used heal terminal -> topped up to 2 coupons, 2 potions, heal terminal reset
  save.flags['ds:healUsed'] = true
  save.bag = { 'off-peak-coupon': 0, 'cache-potion': 1 }
  await runner.run(dsLossSteps, null)
  assert.equal(save.flags['ds:healUsed'], false, 'ds-loss resets B1 heal terminal flag')
  assert.equal(save.bag['off-peak-coupon'], 2, 'ds-loss tops up off-peak-coupon from 0 to 2')
  assert.equal(save.bag['cache-potion'], 2, 'ds-loss tops up cache-potion from 1 to 2')

  // 2. Repeated loss does not stack beyond 2
  await runner.run(dsLossSteps, null)
  assert.equal(save.bag['off-peak-coupon'], 2, 'repeated ds-loss does not stack off-peak-coupon beyond 2')
  assert.equal(save.bag['cache-potion'], 2, 'repeated ds-loss does not stack cache-potion beyond 2')

  // 3. Player with >2 items keeps all earned inventory
  save.bag = { 'off-peak-coupon': 3, 'cache-potion': 5 }
  await runner.run(dsLossSteps, null)
  assert.equal(save.bag['off-peak-coupon'], 3, 'ds-loss never reduces existing off-peak-coupon > 2')
  assert.equal(save.bag['cache-potion'], 5, 'ds-loss never reduces existing cache-potion > 2')
})
