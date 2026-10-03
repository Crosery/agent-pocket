// Opening-fairness guard: simulates the first fights of the game with the deterministic engine and a naive
// "mash the first damaging move" player. Thresholds are the acceptance bar; OPENING_REPORT=1 prints the table.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { BattleInit, Creature, GameMap, SpeciesDef, TrainerDef } from '../src/shared/types.ts'
import { Rng } from '../src/shared/rng.ts'
import { createCreature, calcStats, healFull } from '../src/shared/creature.ts'
import { BattleEngine } from '../src/shared/battle/engine.ts'
import { computeDamage, emptyStages, type Fighter } from '../src/shared/battle/formulas.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { rivalTrainerId, starterSpecies } from '../src/shared/world/story.ts'
import { levelForm } from '../src/shared/world/pick.ts'

const SEEDS = 200
const RIVAL_MIN_WIN = 0.9
const EARLY_MIN_WIN = 0.7
/** Regions a new player walks through before gym 1: the home meadow, route 1 and the gym-town forest. */
const FIRST_AREA = ['meadow', 'route-1', 'forest']
/** Starter level a player is expected to bring to gym 1 (route-1 trainers + wilds, no grinding). */
const GYM1_PLAYER_LEVEL = 10
const REPORT = !!process.env.OPENING_REPORT

const world = buildWorld()
const overworld: GameMap = world.maps[world.startMap]
const starters = starterSpecies()

type Opponent = { label: string; party: { species: string; level: number; moves?: string[] }[]; aiLevel: 0 | 1 | 2 | 3; wild: boolean; items?: Record<string, number> }

const trainerOpp = (id: string): Opponent => {
  const t: TrainerDef = world.trainers[id]
  assert.ok(t, `trainer ${id} exists`)
  return { label: id, party: t.party.map((p) => ({ species: p.species!, level: p.level, ...(p.moves ? { moves: p.moves } : {}) })), aiLevel: t.aiLevel, wild: false, ...(t.items ? { items: t.items } : {}) }
}

function makeParty(opp: Opponent, rng: Rng): Creature[] {
  return opp.party.map((p) => {
    const cr = createCreature(p.species, p.level, { rng, ...(p.moves ? { moves: p.moves } : {}) }, CONTENT)
    healFull(cr, CONTENT)
    return cr
  })
}

function makeStarter(sp: SpeciesDef, level: number, rng: Rng): Creature {
  const cr = createCreature(levelForm(sp, level).id, level, { rng }, CONTENT)
  healFull(cr, CONTENT)
  return cr
}

/** Naive policy: first move that deals damage (and has PP), otherwise first usable move. */
function fight(sp: SpeciesDef, level: number, opp: Opponent, seed: number): 'win' | 'lose' {
  const rng = new Rng(seed)
  const mine = makeStarter(sp, level, rng)
  const foes = makeParty(opp, rng)
  const init: BattleInit = {
    seed: seed * 7919 + 13,
    sides: [
      { kind: 'player', name: 'p', party: [mine] },
      opp.wild
        ? { kind: 'wild', name: 'w', party: foes }
        : { kind: 'trainer', name: 't', party: foes, aiLevel: opp.aiLevel, ...(opp.items ? { items: { ...opp.items } } : {}) },
    ],
    isWild: opp.wild, canRun: opp.wild, canCatch: false, biome: CONTENT.biomes[0].id, timeOfDay: 'day', expGain: false,
  }
  const e = new BattleEngine(init, CONTENT)
  e.start()
  for (let guard = 0; !e.finished && guard < 400; guard++) {
    const r = e.request(0)
    if (r.kind === 'action') {
      const moves = e.party(0)[e.activeIndex(0)].moves
      const order = moves.map((m, i) => i).sort((a, b) => Number(CONTENT.moves[moves[b].id]?.power > 0) - Number(CONTENT.moves[moves[a].id]?.power > 0) || a - b)
      for (const i of order) if (moves[i].pp > 0 && e.choose(0, { kind: 'move', moveIndex: i }) === null) break
    }
    e.step()
  }
  return e.result === 'win' ? 'win' : 'lose'
}

function winRate(sp: SpeciesDef, level: number, opp: Opponent): number {
  let w = 0
  for (let s = 1; s <= SEEDS; s++) if (fight(sp, level, opp, s) === 'win') w++
  return w / SEEDS
}

/** Largest single hit (max roll, crit, best damaging move) any foe party member can deal, as a fraction of the
 * weakest-HP (IV 0) starter's max hp. */
function maxHitFraction(sp: SpeciesDef, level: number, opp: Opponent, crit = true): number {
  const rng = new Rng(1)
  const me = makeStarter(sp, level, rng)
  me.ivs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }
  const defF: Fighter = { creature: me, level, stats: calcStats(me, CONTENT), stages: emptyStages(), critStageAdd: 0 }
  let best = 0
  for (const foe of makeParty(opp, rng)) {
    const att: Fighter = { creature: foe, level: foe.level, stats: calcStats(foe, CONTENT), stages: defF.stages, critStageAdd: 0 }
    for (const slot of foe.moves) {
      const mv = CONTENT.moves[slot.id]
      if (!mv || mv.power <= 0 || mv.category === 'status') continue
      const spec = { type: mv.type, category: mv.category, power: mv.power }
      const out = computeDamage(att, defF, spec, 'clear', { crit, random: CONTENT.config.battle.randomMax }, CONTENT)
      best = Math.max(best, out.damage / defF.stats.hp)
    }
  }
  return best
}

const rows: string[] = []
const problems: string[] = []
const check = (ok: boolean, msg: string) => { if (!ok) problems.push(msg) }
const record = (group: string, sp: string, label: string, level: number, win: number, hit: number) =>
  rows.push(`${group.padEnd(8)} ${sp.padEnd(14)} ${label.padEnd(34)} L${String(level).padEnd(3)} win ${(win * 100).toFixed(0).padStart(3)}%  maxHit ${(hit * 100).toFixed(0).padStart(3)}%`)

test('first rival battle: never a one-hit KO, >=90% naive win rate for every starter', () => {
  assert.ok(starters.length >= 3)
  for (const sp of starters) {
    const opp = trainerOpp(rivalTrainerId('lab', sp.id))
    const level = CONTENT.config.creature.starterLevel
    const hit = maxHitFraction(sp, level, opp)
    const win = winRate(sp, level, opp)
    record('rival', sp.id, opp.label, level, win, hit)
    check(hit < 1, `${sp.id}: rival can one-hit KO (${(hit * 100).toFixed(0)}%)`)
    check(win >= RIVAL_MIN_WIN, `${sp.id}: rival win rate ${win}`)
  }
})

test('first-route trainers and wilds: no one-hit KO, >=70% naive win rate', () => {
  const trainerIds = Object.keys(world.trainers).filter((id) => id.startsWith('r1-'))
  assert.ok(trainerIds.length >= 5)
  for (const sp of starters) {
    for (const id of trainerIds) {
      const opp = trainerOpp(id)
      const level = Math.max(CONTENT.config.creature.starterLevel, ...opp.party.map((p) => p.level))
      const hit = maxHitFraction(sp, level, opp)
      const win = winRate(sp, level, opp)
      record('route-1', sp.id, id, level, win, hit)
      check(hit < 1, `${sp.id} vs ${id}: one-hit KO`)
      check(win >= EARLY_MIN_WIN, `${sp.id} vs ${id}: win rate ${win}`)
    }
  }
})

test('first-area wild encounters: no one-hit KO, >=70% naive win rate', () => {
  const regions = overworld.regions.filter((r) => FIRST_AREA.includes(r.id))
  assert.equal(regions.length, FIRST_AREA.length)
  for (const sp of starters) {
    for (const r of regions) {
      let worstHit = 0
      let worstWin = 1
      const seen = new Set<string>()
      for (const slot of r.encounters) {
        for (const level of new Set([slot.minLevel, slot.maxLevel])) {
          const key = `${slot.species}:${level}`
          if (seen.has(key)) continue
          seen.add(key)
          const opp: Opponent = { label: key, party: [{ species: slot.species, level }], aiLevel: 0, wild: true }
          const plv = Math.max(CONTENT.config.creature.starterLevel, level)
          const hit = maxHitFraction(sp, plv, opp)
          const win = winRate(sp, plv, opp)
          if (hit > worstHit) worstHit = hit
          if (win < worstWin) worstWin = win
          check(hit < 1, `${sp.id} vs wild ${key} in ${r.id}: one-hit KO`)
          check(win >= EARLY_MIN_WIN, `${sp.id} vs wild ${key} in ${r.id}: win rate ${win}`)
        }
      }
      record('wild', sp.id, `${r.id} (worst of ${seen.size})`, 5, worstWin, worstHit)
    }
  }
})

test('gym 1 trainers and leader: >=70% naive win rate with a level-appropriate starter', () => {
  const ids = world.trainers['gc-xiaoma'] ? ['gc-xiaoma', 'gc-ace', 'gc-xiaoyuan', 'leader_code'] : []
  assert.equal(ids.length, 4)
  for (const sp of starters) {
    for (const id of ids) {
      const opp = trainerOpp(id)
      const level = GYM1_PLAYER_LEVEL
      const hit = maxHitFraction(sp, level, opp)
      const win = winRate(sp, level, opp)
      record('gym-1', sp.id, id, level, win, hit)
      check(hit < 1, `${sp.id} vs ${id}: one-hit KO`)
      check(win >= EARLY_MIN_WIN, `${sp.id} vs ${id}: win rate ${win}`)
    }
  }
})

test('opening balance summary', () => {
  if (REPORT) console.log(rows.join('\n'))
  assert.deepEqual(problems, [])
})
