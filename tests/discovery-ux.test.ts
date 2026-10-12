import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import { buildWorld, worldAnchors } from '../src/shared/world/index.ts'
import { applyStory, storyProblems } from '../src/shared/world/story.ts'
import { SCREENS } from '../src/client/ui/screens/config.ts'
import { TUTORIAL } from '../src/client/onboarding/config.ts'
import { bearing, nearestTarget, pickObjective, type ProgressView } from '../src/client/onboarding/logic.ts'
import { GPC } from '../src/client/world/gameplay-config.ts'
import { researchPoints, tasksFor } from '../src/shared/gameplay/research.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { researchSummary } from '../src/client/world/research.ts'
import type { SaveData } from '../src/shared/types.ts'
import type { GameContext, GameEvents } from '../src/client/contracts.ts'
import { createEventBus } from '../src/client/core/events.ts'
import { createCreature, maxHp } from '../src/shared/creature.ts'
import { Rng } from '../src/shared/rng.ts'
import { collisionField, warpAt } from '../src/shared/world/worldapi.ts'
import { createScriptRunner } from '../src/client/world/script.ts'
import type { ScriptHost } from '../src/client/world/script.ts'

const world = buildWorld()
applyStory(world)
const anchors = worldAnchors(world)
const saves = createSaveManager({ world, storage: null })

function freshSave(): SaveData {
  return saves.newGame({ name: 'Explorer', avatar: CONTENT.characters.find((c) => c.playable)!.id })
}

test('first objective fallback: players waking up have an immediate clear goal and arrow', () => {
  const save = freshSave()
  const picked = pickObjective(world, save as ProgressView, TUTORIAL)
  assert.equal(picked.ruleId, 'starter')
  assert.equal(picked.textKey, 'tutorial.objective.starter')

  const from = { map: save.position.map, x: save.position.x, y: save.position.y }
  const places = picked.targets.map((k) => anchors[k]).filter(Boolean)
  assert.ok(places.length > 0, 'starter anchor exists')

  const dest = nearestTarget(world, from, places)
  assert.ok(dest, 'can resolve target door / professor')
  const b = bearing(from, dest)
  assert.ok(Number.isFinite(b.angle))
  assert.ok(b.tiles > 0)
})

test('progressive pause menu: party and bag first, progressive disclosure by flags', () => {
  assert.equal(SCREENS.pause.entries[0].action, 'party', 'party is entry 0')
  assert.equal(SCREENS.pause.entries[1].action, 'bag', 'bag is entry 1')

  const isUnlocked = (e: (typeof SCREENS.pause.entries)[number], save: SaveData): boolean => {
    if (e.action === 'research' && researchSummary(save).canClaim) return true
    if (!e.unlockFlag) return true
    return Boolean(save.flags[e.unlockFlag])
  }

  // Brand new save
  const s0 = freshSave()
  const u0 = SCREENS.pause.entries.filter((e) => isUnlocked(e, s0)).map((e) => e.action)
  assert.deepEqual(u0, ['bag', 'quests', 'manual', 'save', 'settings', 'title'], 'initial menu has 6 essential entries')

  // Starter received
  const s1 = freshSave()
  s1.flags.starter = 'o1'
  const u1 = SCREENS.pause.entries.filter((e) => isUnlocked(e, s1)).map((e) => e.action)
  assert.deepEqual(u1, ['party', 'bag', 'dex', 'map', 'quests', 'manual', 'save', 'settings', 'title'], 'starter unlocks party, dex, map')

  // Type lesson completed
  const s2 = freshSave()
  s2.flags.starter = 'o1'
  s2.flags['lesson:typeChart'] = true
  const u2 = SCREENS.pause.entries.filter((e) => isUnlocked(e, s2)).map((e) => e.action)
  assert.ok(u2.includes('typeChart'), 'typeChart unlocked after lesson')

  // Catch stamp completed
  const s3 = freshSave()
  s3.flags.starter = 'o1'
  s3.flags['lesson:typeChart'] = true
  s3.flags['ds:stamp:catch'] = true
  const u3 = SCREENS.pause.entries.filter((e) => isUnlocked(e, s3)).map((e) => e.action)
  assert.ok(u3.includes('research'), 'research unlocked after catch stamp')

  // First boss beaten (gate opened)
  const s4 = freshSave()
  s4.flags.starter = 'o1'
  s4.flags['lesson:typeChart'] = true
  s4.flags['ds:stamp:catch'] = true
  s4.flags['ds:gateOpen'] = true
  const u4 = SCREENS.pause.entries.filter((e) => isUnlocked(e, s4)).map((e) => e.action)
  assert.equal(u4.length, 13, 'all 13 entries unlocked after prologue boss')
  assert.ok(u4.includes('intel') && u4.includes('online'))
})

test('progressive pause menu: claimable research reward is accessible even early', () => {
  const save = freshSave()
  assert.equal(Boolean(save.flags['ds:stamp:catch']), false)

  const isUnlocked = (e: (typeof SCREENS.pause.entries)[number], s: SaveData): boolean => {
    if (e.action === 'research' && researchSummary(s).canClaim) return true
    if (!e.unlockFlag) return true
    return Boolean(s.flags[e.unlockFlag])
  }

  // Before reward: research is locked
  assert.equal(isUnlocked(SCREENS.pause.entries.find((e) => e.action === 'research')!, save), false)

  // Give enough research points to reach level 1
  const need = GAMEPLAY.research.levels[0].points
  const state: Record<string, Record<string, number>> = {}
  for (const sp of CONTENT.speciesList) {
    if (researchPoints(state) >= need) break
    state[sp.id] = Object.fromEntries(tasksFor(sp.id).map((tk) => [tk.id, Math.max(...tk.thresholds)]))
  }
  save.research = state

  assert.equal(researchSummary(save).canClaim, true, 'reward is claimable')
  assert.equal(isUnlocked(SCREENS.pause.entries.find((e) => e.action === 'research')!, save), true, 'claimable reward unlocks research early')
})

test('event scheduler: quiet in prologue before ds:gateOpen', () => {
  assert.equal(GPC.scheduler.requireFlag, 'ds:gateOpen')
  assert.equal(GPC.research.toastGains, false, 'research gain toast spam is turned off')
  assert.equal(GPC.special.touchRadius, 0.45, 'special roamer touchRadius is relaxed to 0.45')

  const fresh = freshSave()
  const isGated = Boolean(GPC.scheduler.requireFlag && !fresh.flags[GPC.scheduler.requireFlag])
  assert.equal(isGated, true, 'scheduler announcements and rumors are gated during prologue')

  fresh.flags['ds:gateOpen'] = true
  const unGated = Boolean(GPC.scheduler.requireFlag && !fresh.flags[GPC.scheduler.requireFlag])
  assert.equal(unGated, false, 'scheduler activates after prologue boss')
})

test('local easter egg rewards and healing cannot be claimed again after reload', async () => {
  assert.deepEqual(storyProblems(world), [])
  const cases = [
    { map: world.startMap, npc: 'easter-origin-qwen', flag: 'easter:origin-qwen', rewards: { 'data-shard': 2, 'server-fan': 1 }, heals: false },
    { map: world.startMap, npc: 'easter-route1-terminal', flag: 'easter:route1-terminal', rewards: { 'data-shard': 1, 'few-shot-ball': 2 }, heals: true },
    { map: 'origin-lab-b1', npc: 'zero-log-b1', flag: 'easter:zero-b1', rewards: { 'data-shard': 1, 'server-fan': 1 }, heals: false },
  ]
  for (const entry of cases) {
    const map = world.maps[entry.map]
    const npc = map.npcs.find((n) => n.id === entry.npc)!
    assert.ok(npc)
    assert.equal(collisionField(map).at(npc.x, npc.y), 0)
    assert.ok(!warpAt(map, npc.x, npc.y), 'easter egg does not stand on a warp')
    const save = freshSave()
    save.flags.starter = 'o1'
    const lead = createCreature('o1', 6, { rng: new Rng(123) })
    lead.hp = 1
    save.party = [lead]
    const before = { ...save.bag }
    const ctx = {
      data: { ...CONTENT, world }, save, saves, events: createEventBus<GameEvents>(),
      net: { status: 'offline' },
      ui: { async say() {}, async choose() { return 0 }, toast() {}, async fade() {} },
      audio: { playSfx() {} },
      persist() { saves.write(ctx.save) },
    } as unknown as GameContext
    const host: ScriptHost = {
      ctx, async moveNpc() {}, faceNpc() {}, setNpcHidden() {},
      async trainerBattle() { throw new Error('Unexpected battle in an easter egg') },
      async wildBattle() { throw new Error('Unexpected encounter in an easter egg') },
      async blackout() { throw new Error('Unexpected blackout in an easter egg') },
      async warp() { throw new Error('Unexpected warp in an easter egg') },
      playerPlace: () => ({ map: entry.map, x: npc.x, y: npc.y + 1, facing: 'up' }),
      playMusic() {}, onWorldChanged() {},
    }
    const runner = createScriptRunner(host)
    await runner.run(npc.script, npc)
    assert.equal(ctx.save.flags[entry.flag], true)
    for (const [id, qty] of Object.entries(entry.rewards)) assert.equal(ctx.save.bag[id], (before[id] ?? 0) + qty)
    assert.equal(ctx.save.party[0].hp, entry.heals ? maxHp(lead, CONTENT) : 1)
    const rewardedBag = { ...ctx.save.bag }
    ctx.save.party[0].hp = 1
    ctx.persist('easter-egg-reload')
    ctx.save = saves.load()!
    await runner.run(npc.script, npc)
    assert.deepEqual(ctx.save.bag, rewardedBag, `${entry.npc} cannot double-pay after reload`)
    assert.equal(ctx.save.party[0].hp, 1, 'one-time healing does not reset on reload')
  }
})
