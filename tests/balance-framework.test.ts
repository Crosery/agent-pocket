import { test } from 'node:test'
import assert from 'node:assert/strict'
import { C, RULES } from '../tools/balance/lib.ts'
import { typeViolations } from '../tools/balance/typechart.ts'
import { evolutionSteps, statOutliers } from '../tools/balance/stats.ts'
import { moveViolations } from '../tools/balance/moves.ts'
import { ttkViolations } from '../tools/balance/ttk.ts'
import { curveViolations } from '../tools/balance/curve.ts'
import { rarityCell } from '../tools/balance/solo.ts'
import { bossCardRows, bossCardViolations } from '../tools/balance/bosscard.ts'
import { judgeMatrix, runMatrix, type TeamSource } from '../tools/balance/sim.ts'
import { DEFS, buildArchetype, lawProblems } from '../tools/balance/teams.ts'
import { buildWorld, worldBuildInfo } from '../src/shared/world/index.ts'
import { WORLD_CONTENT } from '../src/shared/world/data.ts'

/**
 * Numeric framework guardrails (docs/balance.md). Every threshold lives in tools/balance/rules.json and
 * tools/balance/archetypes.json; the same checks run in full, with more battles, through
 * `node tools/balance/cli.ts all|matrix|solo`. The matrix and rarity checks here are small seeded samples.
 */

const fmt = (rows: { id?: string; why: string }[] | string[]): string[] => rows.map((r) => (typeof r === 'string' ? r : `${r.id ?? ''}: ${r.why}`))

test('type chart: coverage, weaknesses and per-type power index stay inside the bands', () => {
  assert.deepEqual(fmt(typeViolations()), [])
})

test('stats: rarity budgets have no outliers and evolutions gain a clear step', () => {
  assert.deepEqual(fmt(statOutliers()), [])
  const [lo, hi] = RULES.stats.evolutionBstRatio
  const bad = evolutionSteps().filter((s) => s.ratio < lo || s.ratio > hi).map((s) => `${s.from} -> ${s.to} x${s.ratio}`)
  assert.deepEqual(bad, [])
})

test('moves: power, accuracy, PP and effect value are consistent per tier', () => {
  assert.deepEqual(fmt(moveViolations()), [])
})

test('time to KO: neutral, super effective and resisted hits sit in their bands at every level', () => {
  assert.deepEqual(ttkViolations(), [])
})

test('curves: exp per level, gym ladder and the healing economy follow the rules', () => {
  assert.deepEqual(curveViolations(), [])
})

test('archetype teams obey the team-building law and use real species', () => {
  assert.ok(DEFS.roles.length >= 6, `need at least 6 archetypes, have ${DEFS.roles.length}`)
  for (const role of DEFS.roles) {
    for (const variant of [0, 1, 7]) {
      const team = buildArchetype(role, variant)
      assert.ok(team, `${role.id}#${variant}: no team satisfies the law`)
      assert.deepEqual(lawProblems(team), [], `${role.id}#${variant}`)
      for (const m of team.members) assert.ok(C.species[m.species], `${role.id}: unknown species ${m.species}`)
    }
  }
})

test('rarity ladder: a higher rarity is clearly but never absolutely ahead at an even level', () => {
  for (const [hi, lo] of [['R', 'N'], ['SR', 'R'], ['SSR', 'SR']] as const) {
    const even = rarityCell(hi, lo, 0, 12, 6, RULES.sim.seed).rate
    assert.ok(even > 0.55 && even < 0.95, `${hi} vs ${lo} at even level: ${even.toFixed(2)}`)
  }
})

test('archetype matrix (seeded sample): no dominant archetype, every one has prey and a counter, a counter-cycle exists', () => {
  const cache = new Map<string, ReturnType<typeof buildArchetype>>()
  const src: TeamSource = (id, variant) => {
    const key = `${id}#${variant}`
    if (!cache.has(key)) cache.set(key, buildArchetype(DEFS.roles.find((r) => r.id === id)!, variant))
    return cache.get(key)!
  }
  const ids = DEFS.roles.map((r) => r.id)
  // A small sample is noisy (+-5% at 1 sigma), so each rule may be overshot by this much; the CLI run uses the exact rules.
  const slack = 0.08
  const R = RULES.sim
  const m = runMatrix(src, ids, 120, R.seed, undefined, R.level, 12)
  const v = judgeMatrix(m)
  ids.forEach((id, i) => {
    const others = m.rate[i].filter((_, j) => j !== i)
    assert.ok(Math.min(...others) <= R.maxAllOpponentsWin + slack, `${id} beats every other archetype (worst matchup ${Math.min(...others).toFixed(2)})`)
    assert.ok(Math.max(...others) >= R.favourableWin - slack, `${id} has no favourable matchup (best ${Math.max(...others).toFixed(2)})`)
    assert.ok(Math.min(...others) <= R.unfavourableWin + slack, `${id} has no unfavourable matchup (worst ${Math.min(...others).toFixed(2)})`)
    assert.ok(v.fieldWin[i] >= R.minFieldWin - slack && v.fieldWin[i] <= R.maxFieldWin + slack, `${id} field win ${v.fieldWin[i].toFixed(2)}`)
  })
  assert.ok(v.cycle, 'no counter-cycle among archetypes')
  assert.ok(v.maxDraw <= R.maxDrawRate + slack, `draw rate ${v.maxDraw.toFixed(2)}`)
})

test('encounter coverage: every non-UR, non-MYTHIC base form is wild-obtainable (evolutions come from them)', () => {
  const world = buildWorld()
  const rules = WORLD_CONTENT.world.encounters
  const ur = C.rarityById.UR.order
  assert.ok(rules.coverage && rules.coverage.maxOrder >= ur - 1, 'coverage rule must reach every rarity below UR')
  const wild = new Set<string>()
  for (const m of Object.values(world.maps)) for (const r of m.regions) for (const e of r.encounters) wild.add(e.species)
  const missing = C.speciesList.filter((s) => !s.evolvesFrom && !s.starter && C.rarityById[s.rarity].order < ur && !wild.has(s.id)).map((s) => s.id)
  assert.deepEqual(missing, [], 'base forms in no wild encounter table')
  assert.deepEqual(worldBuildInfo(world).problems.filter((p) => p.startsWith('encounter coverage')), [])
  for (const s of C.speciesList) if (s.evolvesFrom) assert.equal(C.species[s.evolvesFrom]?.evolvesTo?.id, s.id, `${s.id}: its pre-evolution does not evolve into it`)
})

test('boss card: a V4 card at its badge cap (2 / 4 / 6 badges = Lv19 / Lv29 / Lv41, IVs 19, Weight Drop) does not win the next gym alone', () => {
  const rows = bossCardRows()
  assert.deepEqual(rows.map((r) => r.cap), [19, 29, 41])
  assert.deepEqual(rows.map((r) => r.gym), ['sound', 'compute', 'agent'], 'gyms 3 / 5 / 7')
  assert.deepEqual(bossCardViolations(rows), [])
})
