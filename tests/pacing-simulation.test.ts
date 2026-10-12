// Progression and loss recovery through the real BattleEngine and script runner.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { BattleInit, ScriptStep, TrainerDef } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { Rng } from '../src/shared/rng.ts'
import { rivalTrainerId, STORY_CONTENT, walkSteps } from '../src/shared/world/story.ts'
import { createCreature, expForLevel, healFull, maxHp } from '../src/shared/creature.ts'
import { BattleEngine } from '../src/shared/battle/engine.ts'
import { chooseAiAction } from '../src/shared/battle/ai.ts'
import { startBossBattle } from '../src/shared/battle/boss-battle.ts'
import { applyResearch, researchFromBattle } from '../src/shared/gameplay/research.ts'
import { fightStory, STARTERS } from './boss-story.ts'
import type { ScriptHost } from '../src/client/world/script.ts'
import { createScriptRunner } from '../src/client/world/script.ts'
import { claimResearchRewards, researchSummary } from '../src/client/world/research.ts'
import { makeRuntimeRig, world } from './pacing-fixture.ts'


export const FIXED_SIMULATION_SEEDS = [101, 202, 303, 404, 505, 606, 707, 808, 909, 1001] as const



/** Uses the game's action scorer, including type matchups, rather than always clicking the first damaging move. */
function runEngineFight(init: BattleInit, captureBall?: string): BattleEngine {
  const engine = new BattleEngine(init, CONTENT)
  engine.start()
  const rng = new Rng(init.seed)
  for (let guard = 0; !engine.finished && guard < 400; guard++) {
    const req = engine.request(0)
    if (req.kind === 'action') {
      if (captureBall && req.canItem && (engine.itemsLeft(0)[captureBall] ?? 0) > 0) {
        if (engine.choose(0, { kind: 'item', itemId: captureBall, partyIndex: 0 }) === null) {
          engine.step()
          continue
        }
      }
      assert.equal(engine.choose(0, chooseAiAction(engine, 0, rng, CONTENT)), null)
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
          { kind: 'player', name: save.name, party: save.party, aiLevel: 3, items: { ...save.bag } },
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
    const ernieNpc = world.maps[world.startMap].npcs.find((n) => n.id === 'ds-ernie')!
    let catchStep: Extract<ScriptStep, { op: 'wildBattle' }> | undefined
    walkSteps(ernieNpc.script, (step) => { if (step.op === 'wildBattle') catchStep = step })
    assert.ok(catchStep)
    assert.ok(catchStep.species)
    assert.ok(catchStep.level)
    const ernieFoe = createCreature(catchStep.species, catchStep.level, { rng: new Rng(17), moves: catchStep.moves, gradeFloor: catchStep.gradeFloor }, CONTENT)
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
      mods: { catchRate: catchStep.catchRateMul },
      biome: CONTENT.biomes[0].id,
      timeOfDay: 'day',
    }, 'prompt-ball')
    assert.equal(ernieEngine.result, 'caught', 'Ernie-Bot caught in real BattleEngine')
    assert.ok(ernieEngine.caught)
    save.party.splice(1, 0, ernieEngine.caught)

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
    const { engine: drillEngine } = startBossBattle('deepseek-drill', save.party, {
      seed: 303,
      tier: 'story',
      expGain: true,
      items: { ...save.bag, 'off-peak-coupon': 3 },
    })
    for (let guard = 0; !drillEngine.finished && guard < 400; guard++) {
      const req = drillEngine.request(0)
      if (req.kind === 'action') {
        const me = drillEngine.party(0)[drillEngine.activeIndex(0)]
        if (req.canItem && me.hp < maxHp(me, CONTENT) * 0.4 && (drillEngine.itemsLeft(0)['cache-potion'] ?? 0) > 0) {
          assert.equal(drillEngine.choose(0, { kind: 'item', itemId: 'cache-potion', partyIndex: drillEngine.activeIndex(0) }), null)
          drillEngine.step()
          continue
        }
        const state = drillEngine.extractBossState()!
        if (req.canItem && state.meters.tide === 0 && state.meters.grace === 0 && (drillEngine.itemsLeft(0)['off-peak-coupon'] ?? 0) > 0) {
          assert.equal(drillEngine.choose(0, { kind: 'item', itemId: 'off-peak-coupon', partyIndex: drillEngine.activeIndex(0) }), null)
          drillEngine.step()
          continue
        }
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

    // 5. Real BattleEngine fight against Corridor Relay trainer (ds-relay-<starter>)
    for (const c of save.party) healFull(c, CONTENT)
    const relayTr = world.trainers[`ds-relay-${starter}`]
    assert.ok(relayTr, `relay trainer ds-relay-${starter} exists`)
    const relayEngine = runEngineFight(buildTrainerFight(relayTr, 404))
    assert.equal(relayEngine.result, 'win', `${starter} wins corridor relay trainer fight`)

    assert.ok(starterCr.level >= 8, `${starter} reaches at least Lv8 without random grinding (level=${starterCr.level}, exp=${starterCr.exp})`)

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
