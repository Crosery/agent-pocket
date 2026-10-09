// Determinism (ADR 0002 §4.3): one master seed fixes the world, the encounters and the battles; another seed
// changes all three. Also the random hub and the developer clock/commands that steer them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BattleEvent, GameMap, RegionDef } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { createCreature } from '../src/shared/creature.ts'
import { BattleEngine } from '../src/shared/battle/engine.ts'
import { chooseAiAction } from '../src/shared/battle/ai.ts'
import { rollEncounter } from '../src/client/world/encounters.ts'
import { RNG_STREAMS, RngHub } from '../src/client/core/rng-hub.ts'
import { createDevClock } from '../src/client/dev/clock.ts'
import { digest } from '../src/client/dev/diff.ts'
import { createRegistry, DevError } from '../src/client/dev/registry.ts'
import { COMMANDS } from '../src/client/dev/commands/index.ts'
import { installDevText } from '../src/client/dev/text.ts'
import { readDebugParams } from '../src/client/dev/params.ts'
import type { DevHost } from '../src/client/dev/kit.ts'

const SEED = 20261030
installDevText()

// ----------------------------------------------------------------------------- the random hub

const draw = (hub: RngHub, name: (typeof RNG_STREAMS)[number], n = 6) => Array.from({ length: n }, () => hub.stream(name).int(0, 1e6))

test('RngHub: same seed, same streams; streams independent; different seed differs', () => {
  const a = new RngHub(SEED), b = new RngHub(SEED), c = new RngHub(SEED + 1)
  for (const n of RNG_STREAMS) assert.deepEqual(draw(a, n), draw(b, n), n)
  assert.notDeepEqual(draw(new RngHub(SEED), 'encounter'), draw(new RngHub(SEED), 'battle'), 'streams have their own sequences')
  assert.notDeepEqual(draw(new RngHub(SEED), 'encounter'), draw(c, 'encounter'))
  const x = new RngHub(SEED), y = new RngHub(SEED)
  draw(x, 'cosmetic', 50)
  assert.deepEqual(draw(x, 'encounter'), draw(y, 'encounter'), 'draining one stream leaves the others untouched')
})

test('RngHub: cursors count every draw kind; reseed restarts in place and keeps references valid', () => {
  const hub = new RngHub(SEED)
  const enc = hub.stream('encounter')
  enc.next(); enc.int(1, 9); enc.chance(0.5); enc.pick([1, 2, 3]); enc.weighted([1, 2], (n) => n)
  assert.equal(hub.cursors().encounter, 1 + 1 + 1 + 1 + 1, 'next, int, chance, pick and weighted take one draw each')
  assert.equal(hub.cursors().battle, 0)
  const first = new RngHub(SEED + 5).stream('encounter').int(0, 1e9)
  hub.reseed(SEED + 5)
  assert.equal(hub.seed, SEED + 5)
  assert.equal(hub.cursors().encounter, 0)
  assert.equal(enc.int(0, 1e9), first, 'the stream handed out before the reseed follows the new seed')
  assert.equal(hub.stream('encounter'), enc)
})

test('RngHub: no seed means a different random session every time', () => {
  const seeds = new Set(Array.from({ length: 5 }, () => new RngHub().seed))
  assert.ok(seeds.size > 1)
})

// ----------------------------------------------------------------------------- world, encounters, battles

function worldSummary(map: GameMap): string {
  return digest({
    size: [map.width, map.height], spawn: map.spawn,
    terrain: digest(Array.from(map.terrain)), elevation: digest(Array.from(map.elevation)),
    props: map.props.length, warps: map.warps.map((w) => [w.x, w.y, w.toMap, w.toX, w.toY]), signs: map.signs.length, regions: map.regions.map((r) => r.id),
  })
}

interface Walk { steps: { step: number; species: string; level: number; shiny: boolean; seed: number }[]; battles: string[] }

/** A fixed walk through the first region that has wild encounters: every step rolls like the overworld does. */
function walkAndFight(hub: RngHub, region: RegionDef, steps = 600): Walk {
  const enc = hub.stream('encounter')
  const out: Walk = { steps: [], battles: [] }
  for (let i = 0; i < steps && out.steps.length < 3; i++) {
    const pick = rollEncounter(region, 'day', enc, { repelActive: false, leadLevel: 1 })
    if (!pick) continue
    const wild = createCreature(pick.speciesId, pick.level, { rng: enc, otName: 'x', otId: 'x', caughtMap: 'overworld' })
    const seed = hub.stream('battle').int(1, 0x7fffffff)
    out.steps.push({ step: i, species: pick.speciesId, level: pick.level, shiny: wild.shiny, seed })
    const lead = createCreature(CONTENT.speciesList[0].id, 20, { rng: hub.stream('debug'), otName: 'p', otId: 'p', caughtMap: 'overworld' })
    const e = new BattleEngine({
      seed, isWild: true, canRun: false, canCatch: false, biome: 'x', timeOfDay: 'day', expGain: false,
      sides: [{ kind: 'player', name: 'p', party: [lead] }, { kind: 'wild', name: 'w', party: [wild] }],
    })
    const events: BattleEvent[] = [...e.start()]
    const ai = hub.stream('debug')
    for (let n = 0; n < 300 && !e.finished; n++) {
      if (e.request(0).kind !== 'wait') e.choose(0, chooseAiAction(e, 0, ai))
      if (e.request(1).kind !== 'wait') e.choose(1, chooseAiAction(e, 1, ai))
      events.push(...e.step())
    }
    assert.ok(e.finished, 'the battle ends')
    out.battles.push(digest(events))
  }
  return out
}

test('same seed twice: identical world, frontier chunks, encounters and battle event streams; another seed changes all of them', () => {
  const worldA = buildWorld(SEED), worldB = buildWorld(SEED), worldC = buildWorld(SEED + 1)
  const owA = worldA.maps[worldA.startMap], owB = worldB.maps[worldB.startMap], owC = worldC.maps[worldC.startMap]
  assert.equal(worldSummary(owA), worldSummary(owB), 'core continent')
  assert.notEqual(worldSummary(owA), worldSummary(owC), 'another seed builds another continent')

  // Two independent frontier providers hash the same chunks identically (far outside the core).
  const pa = owA.infinite!, pb = owB.infinite!, pc = owC.infinite!
  const samples: [number, number][] = [[-9, -4], [-30, 12], [40, 60], [90, -75], [-120, -140]]
  const hashes = (p: NonNullable<GameMap['infinite']>) => samples.map(([cx, cy]) => {
    const c = p.chunk(cx, cy)
    return digest({ t: digest(Array.from(c.terrain)), e: digest(Array.from(c.elevation)), props: c.props.length, r: c.regionIds })
  })
  assert.deepEqual(hashes(pa), hashes(pb), 'frontier chunks')
  assert.notDeepEqual(hashes(pa), hashes(pc), 'frontier chunks differ with the seed')

  const region = owA.regions.find((r) => r.encounterRate > 0 && r.encounters.length > 0)
  assert.ok(region, 'the core continent has a wild region')
  const one = walkAndFight(new RngHub(SEED), region), two = walkAndFight(new RngHub(SEED), region)
  assert.ok(one.steps.length === 3, `the walk meets three wild creatures (${one.steps.length})`)
  assert.deepEqual(one, two, 'encounters and battle seeds')
  assert.equal(one.battles.length, 3)
  const other = walkAndFight(new RngHub(SEED + 1), region)
  assert.notDeepEqual(other.steps, one.steps, 'encounters differ with the seed')
  assert.notDeepEqual(other.battles, one.battles, 'battles differ with the seed')
})

// ----------------------------------------------------------------------------- developer clock, commands, params

test('devClock: pause, scale, fixed step, manual stepping', () => {
  const c = createDevClock()
  assert.equal(c.frameDt(0.016), 0.016)
  c.scale(2)
  assert.equal(c.frameDt(0.01), 0.02)
  c.fixed(1 / 30)
  assert.equal(c.frameDt(0.5), 1 / 30, 'fixed ignores real time and scale')
  c.fixed(null)
  c.pause()
  assert.equal(c.frameDt(0.016), null)
  const ticks: number[] = []
  assert.equal(c.step(3, 0.05, (dt) => ticks.push(dt)), 3, 'stepping works while paused')
  assert.deepEqual(ticks, [0.05, 0.05, 0.05])
  assert.deepEqual(c.state(), { paused: true, scale: 2, fixed: null, stepped: 3 })
  c.resume()
  assert.equal(c.frameDt(0.01), 0.02)
})

test('time.* and rng.seed commands: validated, do not taint, steer the clock and the hub', async () => {
  const ticks: number[] = []
  const host = { rng: new RngHub(1), clock: createDevClock(), tick: (dt: number) => { ticks.push(dt) } } as unknown as DevHost
  const reg = createRegistry(host, COMMANDS)
  await reg.run('time.pause')
  assert.equal(host.clock.state().paused, true)
  await reg.run('time.step', { frames: 4 })
  assert.equal(ticks.length, 4)
  assert.ok(Math.abs(ticks[0] - 1 / 60) < 1e-4, 'default step is 1/60 s')
  await reg.run('time.step', { frames: 2, dt: 0.25 })
  assert.deepEqual(ticks.slice(4), [0.25, 0.25])
  await reg.run('time.scale', { scale: 5 })
  await reg.run('time.fixed', { dt: 0.1 })
  assert.deepEqual(host.clock.state(), { paused: true, scale: 5, fixed: 0.1, stepped: 6 })
  await reg.run('time.fixed', {})
  assert.equal(host.clock.state().fixed, null)
  const seeded = await reg.run('rng.seed', { seed: 99 }) as { seed: number }
  assert.equal(seeded.seed, 99)
  assert.equal(host.rng.seed, 99)
  assert.equal(reg.taint.count, 0, 'environment controls do not taint the session')
  for (const [id, args] of [['time.step', { frames: 0 }], ['time.step', { frames: 99999 }], ['time.scale', { scale: -1 }], ['time.scale', { scale: 999 }],
    ['time.fixed', { dt: 5 }], ['rng.seed', { seed: -1 }], ['rng.seed', { seed: 2 ** 32 }]] as const) {
    await assert.rejects(reg.run(id, args as Record<string, unknown>), (e: Error) => e instanceof DevError, `${id} ${JSON.stringify(args)}`)
  }
  assert.equal(ticks.length, 6, 'rejected steps ran no frames')
})

test('?seed and ?rng: dev only, non-negative 32-bit integers', () => {
  const p = readDebugParams('?dev=1&seed=123&rng=77')
  assert.equal(p.seed, 123)
  assert.equal(p.rng, 77)
  for (const bad of ['-1', '1.5', 'abc', '4294967296', '']) {
    const q = readDebugParams(`?dev=1&seed=${bad}&rng=${bad}`)
    assert.equal(q.seed, null, bad)
    assert.equal(q.rng, null, bad)
  }
  const off = readDebugParams('?seed=123&rng=77')
  assert.equal(off.seed, null)
  assert.equal(off.rng, null)
})
