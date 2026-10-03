// Client side of the world-event / rarity / research layer: content/events/client.json wiring, research level
// rewards, the new ScriptStep ops and the place helpers (alias ids, revealed-place window).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ScriptStep } from '../src/shared/types.ts'
import type { GameContext } from '../src/client/contracts.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import { researchPoints, tasksFor } from '../src/shared/gameplay/research.ts'
import { dayOf } from '../src/shared/gameplay/events.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { GPC, validateGameplayClient } from '../src/client/world/gameplay-config.ts'
import { claimResearchRewards, claimedLevel, researchSummary } from '../src/client/world/research.ts'
import { createScriptRunner, type ScriptHost } from '../src/client/world/script.ts'
import { realPlaceId, revealedPlaces } from '../src/client/world/places.ts'
import { cutsPassage } from '../src/client/world/rarity-spawns.ts'
import { canStep, collisionField } from '../src/shared/world/worldapi.ts'
import { worldBuildInfo } from '../src/shared/world/index.ts'

const world = buildWorld()

function fakeCtx() {
  const saves = createSaveManager({ world, storage: null })
  const avatar = CONTENT.characters.find((c) => c.playable) ?? CONTENT.characters[0]
  const toasts: string[] = []
  const events: string[] = []
  const ctx = {
    data: { ...CONTENT, world },
    save: saves.newGame({ name: 'p', avatar: avatar.id }),
    clock: { timeOfDay: 'night' },
    ui: { async say() {}, async choose() { return 0 }, toast(text: string) { toasts.push(text) }, async fade() {} },
    audio: { playSfx() {}, playCry() {}, playBgm() {} },
    events: { emit(name: string) { events.push(name) } },
  }
  return { ctx: ctx as unknown as GameContext, toasts, events }
}

test('content/events/client.json implements every cue and validates', () => {
  const errs = validateGameplayClient()
  assert.deepEqual(errs, [], errs.join('\n'))
})

test('research: level summary and one-shot reward claim', () => {
  const f = fakeCtx()
  const s = f.ctx.save
  const need = GAMEPLAY.research.levels[0].points
  const state: Record<string, Record<string, number>> = {}
  for (const sp of CONTENT.speciesList) {
    if (researchPoints(state) >= need) break
    state[sp.id] = Object.fromEntries(tasksFor(sp.id).map((tk) => [tk.id, Math.max(...tk.thresholds)]))
  }
  s.research = state
  const sum = researchSummary(s)
  assert.ok(sum.level >= 1 && sum.canClaim)
  const money = s.money
  const bag = { ...s.bag }
  const got = claimResearchRewards(f.ctx)
  assert.ok(got)
  assert.equal(claimedLevel(s), sum.level)
  assert.equal(s.money, money + got.money)
  for (const [id, n] of Object.entries(got.items)) assert.equal(s.bag[id], (bag[id] ?? 0) + n)
  assert.equal(claimResearchRewards(f.ctx), null)
  assert.equal(researchSummary(s).canClaim, false)
})

test('script runner: random / ifTime / ifWeather / ifDex / triggerEvent / revealPlace / research / {day} flags', async () => {
  const f = fakeCtx()
  const log: string[] = []
  const host: ScriptHost = {
    ctx: f.ctx,
    async moveNpc() {}, faceNpc() {}, setNpcHidden() {},
    async trainerBattle() { return 'win' }, async wildBattle() { return 'win' },
    async blackout() {}, async warp() {},
    playerPlace: () => ({ map: world.startMap, x: 1, y: 1, facing: 'down' }),
    playMusic() {}, onWorldChanged() {},
    weather: () => 'rain',
    async triggerEvent(id) { log.push(`event:${id}`); return true },
    async revealPlace(ref) { log.push(`reveal:${ref}`); return null },
  }
  const run = createScriptRunner(host).run
  const sp = CONTENT.speciesList.find((x) => tasksFor(x.id).length)!
  const task = tasksFor(sp.id)[0]
  const ev = GAMEPLAY.events[0].id
  const steps: ScriptStep[] = [
    { op: 'random', chance: 1, then: [{ op: 'setFlag', flag: 'r1' }], else: [{ op: 'setFlag', flag: 'r0' }] },
    { op: 'random', chance: 0, then: [{ op: 'setFlag', flag: 'q1' }], else: [{ op: 'setFlag', flag: 'q0' }] },
    { op: 'ifTime', times: ['night'], then: [{ op: 'setFlag', flag: 'night' }] },
    { op: 'ifTime', times: ['day'], then: [{ op: 'setFlag', flag: 'day' }] },
    { op: 'ifWeather', weather: ['rain', 'fog'], then: [{ op: 'setFlag', flag: 'wet' }], else: [{ op: 'setFlag', flag: 'dry' }] },
    { op: 'ifDex', caughtAtLeast: 1, then: [{ op: 'setFlag', flag: 'dex' }], else: [{ op: 'setFlag', flag: 'nodex' }] },
    { op: 'triggerEvent', event: ev },
    { op: 'revealPlace', place: 'nearest:town' },
    { op: 'research', species: sp.id, task: task.id, amount: 1 },
    { op: 'setFlag', flag: 'gift:{day}' },
    { op: 'ifFlag', flag: 'gift:{day}', then: [{ op: 'setFlag', flag: 'giftSeen' }] },
  ]
  assert.equal(await run(steps, null), 'done')
  const fl = f.ctx.save.flags
  assert.deepEqual([fl.r1, fl.r0, fl.q1, fl.q0], [true, undefined, undefined, true])
  assert.deepEqual([fl.night, fl.day, fl.wet, fl.dry, fl.dex, fl.nodex], [true, undefined, true, undefined, undefined, true])
  assert.deepEqual(log, [`event:${ev}`, 'reveal:nearest:town'])
  assert.equal(f.ctx.save.research?.[sp.id]?.[task.id], 1)
  assert.equal(fl[`gift:${dayOf(f.ctx.save.clockMinutes)}`], true)
  assert.equal(fl.giftSeen, true)
})

test('places: frontier alias ids and the revealed-place ping window', () => {
  assert.equal(realPlaceId('monolith-@fx:landmark:1:11'), 'fx:landmark:1:11')
  assert.equal(realPlaceId('monolith-3'), 'monolith-3')
  const save = { flags: { [`${GPC.flags.revealed}a`]: 100, [`${GPC.flags.revealed}b`]: 300, [`${GPC.flags.revealed}old`]: 1, other: 5 } as Record<string, number> }
  const now = 1 + GPC.places.revealPingMinutes + 50
  assert.deepEqual(revealedPlaces(save, now).map((r) => r.id), ['b', 'a'])
})

test('event blockers: a 1-tile causeway is a passage cut, open ground is not', () => {
  const ow = world.maps[world.startMap]
  const gate = worldBuildInfo(world).features.gates[0]
  // A causeway tile a few steps out from the core edge: walkable, with walkable tiles only ahead and behind.
  const x = gate.out.x + gate.dir.x * 4, y = gate.out.y + gate.dir.y * 4
  const f = collisionField(ow)
  assert.ok(canStep(ow, f, x - gate.dir.x, y - gate.dir.y, x, y, { surf: false }), 'causeway tile is walkable')
  assert.equal(cutsPassage(ow, x, y), true)
  // Some tile near the spawn whose 8 neighbours are all walkable from it.
  let open: { x: number; y: number } | null = null
  for (let r = 0; r < 40 && !open; r++) for (let dy = -r; dy <= r && !open; dy++) for (let dx = -r; dx <= r && !open; dx++) {
    const tx = ow.spawn.x + dx, ty = ow.spawn.y + dy
    let all = true
    for (let oy = -1; oy <= 1 && all; oy++) for (let ox = -1; ox <= 1 && all; ox++) if ((ox || oy) && !canStep(ow, f, tx, ty, tx + ox, ty + oy, { surf: false })) all = false
    if (all) open = { x: tx, y: ty }
  }
  assert.ok(open, 'an open tile exists near the spawn')
  assert.equal(cutsPassage(ow, open.x, open.y), false)
  // Already-taken neighbours count as blocked: closing one side of an open tile's ring still leaves one group,
  // closing two opposite sides splits it.
  assert.equal(cutsPassage(ow, open.x, open.y, (bx, by) => by === open.y - 1), false)
  assert.equal(cutsPassage(ow, open.x, open.y, (bx, by) => by !== open.y && bx === open.x), true)
})
