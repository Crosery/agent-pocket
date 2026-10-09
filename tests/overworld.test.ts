import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import type { EncounterSlot, GameMap, NpcDef, ScriptStep, TimeOfDay } from '../src/shared/types.ts'
import type { GameContext } from '../src/client/contracts.ts'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { Rng } from '../src/shared/rng.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { GAME, textOrKey, validateGameContent } from '../src/client/world/config.ts'
import { facingFromAxis, moveBody, type MotionGrid, type MotionOpts } from '../src/client/world/motion.ts'
import { createTrail } from '../src/client/world/trail.ts'
import { activeSlots, pickEncounter, repelBlocks, rollEncounter } from '../src/client/world/encounters.ts'
import { applyQuest, keyItemOf } from '../src/client/world/save-ops.ts'
import { createScriptRunner, type ScriptHost } from '../src/client/world/script.ts'

const root = new URL('../', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, root), 'utf8')

// ---------------------------------------------------------------- content

test('content/game.json validates against content tables', () => {
  const errs = validateGameContent()
  assert.deepEqual(errs, [], errs.join('\n'))
})

test('every world./game. text key referenced by overworld code exists', () => {
  const files = [
    ...readdirSync(new URL('src/client/world/', root)).filter((f) => f.endsWith('.ts')).map((f) => `src/client/world/${f}`),
    'src/client/game.ts',
    'src/client/debug-overlay.ts',
    'src/client/dev/legacy.ts',
  ]
  const missing: string[] = []
  for (const f of files) {
    for (const m of read(f).matchAll(/'((?:world|game)\.[A-Za-z0-9_.]+)'/g)) {
      if (!m[1].endsWith('.') && CONTENT.text[m[1]] === undefined) missing.push(`${f}: ${m[1]}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('textOrKey resolves keys and passes literals through', () => {
  const key = Object.keys(CONTENT.text).find((k) => k.startsWith('world.'))!
  assert.equal(textOrKey(key), t(key))
  assert.equal(textOrKey('纯文本'), '纯文本')
})

// ---------------------------------------------------------------- motion

/** '#' blocked, '.' free, '~' water; flat ground, no stairs. */
function grid(rows: string[]): MotionGrid {
  const h = rows.length, w = rows[0].length
  const flat = CONTENT.terrain.findIndex((tr) => tr.walkable && !tr.stairs)
  const map = {
    id: 'test', nameZh: '', kind: 'overworld', width: w, height: h,
    terrain: new Uint8Array(w * h).fill(flat), elevation: new Uint8Array(w * h), region: new Uint8Array(w * h),
    regions: [], props: [], warps: [], npcs: [], signs: [], items: [], lights: [],
    spawn: { x: 0, y: 0, facing: 'down' }, outdoor: true, music: '',
  } as GameMap
  const col = new Uint8Array(w * h)
  rows.forEach((r, y) => [...r].forEach((ch, x) => { col[y * w + x] = ch === '#' ? 1 : ch === '~' ? 2 : 0 }))
  return { map, col }
}

const opts = (o: Partial<MotionOpts> = {}): MotionOpts => ({
  radius: GAME.player.radius, surf: false, cornerSlip: GAME.player.cornerSlip,
  cornerSlipRate: GAME.player.cornerSlipRate, substep: GAME.player.substepTiles, ...o,
})

test('moveBody moves freely in open ground', () => {
  const g = grid(['.....', '.....', '.....'])
  const r = moveBody(g, 1.5, 1.5, 1, 0, opts())
  assert.ok(Math.abs(r.x - 2.5) < 1e-9 && r.y === 1.5 && !r.blocked)
})

test('moveBody clamps against a wall and slides along it', () => {
  const g = grid(['.....', '..#..', '.....'])
  const o = opts()
  const hit = moveBody(g, 1.5, 1.5, 1, 0, o)
  assert.ok(hit.blocked)
  assert.ok(hit.x <= 2 - o.radius + 1e-3 && hit.x > 1.5, `x=${hit.x}`)
  // Diagonal into the wall: x is stopped, y keeps moving.
  const slide = moveBody(g, 1.5, 1.5, 0.5, 0.4, o)
  assert.ok(slide.y > 1.85, `y=${slide.y}`)
  assert.ok(slide.x <= 2 - o.radius + 1e-3)
})

test('moveBody blocks water unless surfing, and keeps inside the map', () => {
  const g = grid(['..~..'])
  assert.ok(moveBody(g, 1.5, 0.5, 1, 0, opts()).x < 2)
  assert.ok(moveBody(g, 1.5, 0.5, 1, 0, opts({ surf: true })).x > 2.4)
  assert.ok(moveBody(g, 0.5, 0.5, -2, 0, opts()).x >= GAME.player.radius - 1e-3)
})

test('moveBody slips around a corner into a one-tile opening', () => {
  const g = grid(['#####', '#...#', '##.##', '#...#'])
  const o = opts()
  // Slightly off the opening's centre line: walking down must nudge the body into the gap.
  let x = 2.5 + o.cornerSlip * 0.6, y = 1.5
  for (let i = 0; i < 40; i++) ({ x, y } = moveBody(g, x, y, 0, 0.05, o))
  assert.ok(y > 2.5, `y=${y}`)
  assert.ok(Math.abs(x - 2.5) <= 0.5 - o.radius + 1e-3, `x=${x}`)
})

test('facingFromAxis keeps the current facing on near-diagonals', () => {
  assert.equal(facingFromAxis(1, 0, 'up', GAME.player.facingHysteresis), 'right')
  assert.equal(facingFromAxis(0, -1, 'right', GAME.player.facingHysteresis), 'up')
  assert.equal(facingFromAxis(0.7, 0.71, 'right', GAME.player.facingHysteresis), 'right')
})

// ---------------------------------------------------------------- trail

test('trail records spaced points and samples by arc distance', () => {
  const tr = createTrail(0.25, 64)
  tr.reset({ x: 0, y: 0, elev: 0 })
  for (let i = 1; i <= 8; i++) tr.push({ x: i * 0.5, y: 0, elev: 0 })
  tr.push({ x: 4.1, y: 0, elev: 1 }) // below spacing: only refreshes elevation
  assert.equal(tr.length, 9)
  assert.deepEqual(tr.sample(0.25), { x: 3.75, y: 0, elev: 0.5 })
  assert.deepEqual(tr.sample(1), { x: 3, y: 0, elev: 0 })
  assert.deepEqual(tr.sample(100), { x: 0, y: 0, elev: 0 })
  tr.reset({ x: 5, y: 5, elev: 0 }, { x: 5, y: 4, elev: 0 })
  assert.deepEqual(tr.sample(0.5), { x: 5, y: 4.5, elev: 0 })
})

// ---------------------------------------------------------------- encounters

const species = CONTENT.speciesList.slice(0, 2)
const slots: EncounterSlot[] = [
  { species: species[0].id, minLevel: 3, maxLevel: 5, weight: 1 },
  { species: species[1].id, minLevel: 3, maxLevel: 5, weight: 1, time: [CONTENT.config.time.phases[0].id as TimeOfDay] },
]

test('encounter slots honour time windows and level ranges', () => {
  const phases = CONTENT.config.time.phases.map((p) => p.id as TimeOfDay)
  const other = phases.find((p) => p !== phases[0])!
  assert.equal(activeSlots(slots, phases[0]).length, 2)
  assert.equal(activeSlots(slots, other).length, 1)
  const rng = new Rng(7)
  for (let i = 0; i < 50; i++) {
    const p = pickEncounter(slots, other, rng)!
    assert.equal(p.speciesId, species[0].id)
    assert.ok(p.level >= 3 && p.level <= 5)
  }
})

test('repel keeps weaker wild creatures away', () => {
  assert.equal(repelBlocks(4, 10), true)
  assert.equal(repelBlocks(10, 10), false)
  const region = { id: 'r', nameZh: '', biome: CONTENT.biomes[0].id, music: '', encounters: slots, encounterRate: 1, roamingDensity: 0 }
  const rng = new Rng(3)
  for (let i = 0; i < 30; i++) assert.equal(rollEncounter(region, 'day' as TimeOfDay, rng, { repelActive: true, leadLevel: 50 }), null)
  assert.ok(rollEncounter(region, 'day' as TimeOfDay, rng, { repelActive: false, leadLevel: 50 }))
})

// ---------------------------------------------------------------- script runner

test('every ScriptStep op of the contract is handled by the runner', () => {
  const types = read('src/shared/types.ts')
  const block = types.slice(types.indexOf('export type ScriptStep ='))
  const union = block.slice(0, block.search(/\n\n|\nexport /))
  const ops = [...union.matchAll(/op: '(\w+)'/g)].map((m) => m[1])
  assert.ok(ops.length > 20)
  const runner = read('src/client/world/script.ts')
  assert.deepEqual(ops.filter((op) => !runner.includes(`case '${op}'`)), [])
})

const world = buildWorld()

function fakeCtx() {
  const saves = createSaveManager({ world, storage: null })
  const avatar = CONTENT.characters.find((c) => c.playable) ?? CONTENT.characters[0]
  const said: string[] = []
  const toasts: string[] = []
  const events: string[] = []
  let choice = 0
  const ctx = {
    data: { ...CONTENT, world },
    save: saves.newGame({ name: '测试', avatar: avatar.id }),
    ui: {
      async say(lines: { text: string }[]) { said.push(...lines.map((l) => l.text)) },
      async choose() { return choice },
      toast(text: string) { toasts.push(text) },
      async fade() {},
    },
    audio: { playSfx() {}, playCry() {}, playBgm() {} },
    events: { emit(name: string) { events.push(name) } },
    screens: { async starter(o: { id: string }[]) { return o[0].id }, async shop() {}, async box() {} },
  }
  return { ctx: ctx as unknown as GameContext, said, toasts, events, setChoice: (i: number) => { choice = i } }
}

function host(ctx: GameContext, log: string[] = []): ScriptHost {
  return {
    ctx,
    async moveNpc(id) { log.push(`move:${id}`) },
    faceNpc(id, dir) { log.push(`face:${id}:${dir}`) },
    setNpcHidden(id, h) { log.push(`${h ? 'hide' : 'show'}:${id}`) },
    async trainerBattle() { return 'lose' },
    async wildBattle() { return 'win' },
    async blackout() { log.push('blackout') },
    async warp(map) { log.push(`warp:${map}`) },
    playerPlace: () => ({ map: world.startMap, x: 3.4, y: 4.6, facing: 'down' }),
    playMusic(id) { log.push(`bgm:${id}`) },
    onWorldChanged() {},
  }
}

test('script runner: flags, branches, choice, money, end', async () => {
  const f = fakeCtx()
  const run = createScriptRunner(host(f.ctx)).run
  const money = f.ctx.save.money
  const steps: ScriptStep[] = [
    { op: 'setFlag', flag: 'a', value: 2 },
    { op: 'ifFlag', flag: 'a', equals: 2, then: [{ op: 'setFlag', flag: 'b' }], else: [{ op: 'setFlag', flag: 'c' }] },
    { op: 'choice', text: '?', options: ['x', 'y'], branches: [[{ op: 'setFlag', flag: 'x' }], [{ op: 'setFlag', flag: 'y' }]] },
    { op: 'giveMoney', amount: 50 },
    { op: 'say', text: 'hi {name}' },
  ]
  f.setChoice(1)
  assert.equal(await run(steps, null), 'done')
  assert.deepEqual([f.ctx.save.flags.a, f.ctx.save.flags.b, f.ctx.save.flags.c, f.ctx.save.flags.x, f.ctx.save.flags.y], [2, true, undefined, undefined, true])
  assert.equal(f.ctx.save.money, money + 50)
  assert.equal(f.said.at(-1), 'hi {name}')
  assert.equal(await run([{ op: 'takeMoney', amount: f.ctx.save.money + 1 }, { op: 'setFlag', flag: 'after' }], null), 'end')
  assert.equal(f.ctx.save.flags.after, undefined)
  assert.equal(await run([{ op: 'end' }, { op: 'setFlag', flag: 'after' }], null), 'end')
  assert.equal(f.ctx.save.flags.after, undefined)
})

test('script runner: items, starter, respawn, npc choreography, loss aborts', async () => {
  const f = fakeCtx()
  const log: string[] = []
  const run = createScriptRunner(host(f.ctx, log)).run
  const item = CONTENT.itemList.find((it) => it.category !== 'key')!
  const npc = { id: 'n' } as NpcDef
  const steps: ScriptStep[] = [
    { op: 'giveItem', item: item.id, qty: 3 },
    { op: 'takeItem', item: item.id, qty: 1 },
    { op: 'ifItem', item: item.id, atLeast: 2, then: [{ op: 'setFlag', flag: 'has' }] },
    { op: 'chooseStarter' },
    { op: 'setRespawn' },
    { op: 'moveNpc', npc: 'n', path: ['up'] },
    { op: 'faceNpc', npc: 'n', dir: 'left' },
    { op: 'hideNpc', npc: 'n' },
    { op: 'warp', map: world.startMap, x: 1, y: 1, facing: 'down' },
  ]
  assert.equal(await run(steps, npc), 'done')
  assert.equal(f.ctx.save.bag[item.id], 2)
  assert.equal(f.ctx.save.flags.has, true)
  assert.equal(f.ctx.save.party.length, 1)
  assert.ok(f.ctx.save.party[0] && CONTENT.species[f.ctx.save.party[0].speciesId].starter)
  assert.deepEqual(f.ctx.save.respawn, { map: world.startMap, x: 3, y: 4, facing: 'down' })
  assert.deepEqual(log, ['move:n', 'face:n:left', 'hide:n', `warp:${world.startMap}`])
  const trainer = Object.keys(world.trainers)[0]
  assert.equal(await run([{ op: 'battle', trainer }, { op: 'setFlag', flag: 'after' }], npc), GAME.battle.lossAbortsScript ? 'abort' : 'done')
  if (GAME.battle.lossAbortsScript) assert.equal(log.at(-1), 'blackout')
})

test('quests never move backwards and pay out once', () => {
  const f = fakeCtx()
  const q = world.quests.find((d) => d.stages.length > 1 && d.reward?.money) ?? world.quests.find((d) => d.stages.length > 1)!
  assert.ok(applyQuest(f.ctx, q.id, 1, false)?.started)
  assert.equal(f.ctx.save.trackedQuest, q.id)
  applyQuest(f.ctx, q.id, 0, false)
  assert.equal(f.ctx.save.quests[q.id].stage, 1)
  const before = f.ctx.save.money
  assert.ok(applyQuest(f.ctx, q.id, q.stages.length - 1, true)?.finished)
  const paid = f.ctx.save.money - before
  assert.equal(paid, q.reward?.money ?? 0)
  applyQuest(f.ctx, q.id, q.stages.length - 1, true)
  assert.equal(f.ctx.save.money - before, paid)
})

test('key items are found by capability, not id', () => {
  for (const kind of GAME.debug.keyItemKinds) {
    const it = keyItemOf(kind)
    assert.ok(it, `no key item with effect.key "${kind}"`)
    assert.equal(it.effect.kind === 'key' && it.effect.key, kind)
  }
})
