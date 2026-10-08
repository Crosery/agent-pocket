import { test } from 'node:test'
import assert from 'node:assert/strict'
import { C, RULES } from '../tools/balance/lib.ts'
import { typeViolations } from '../tools/balance/typechart.ts'
import { evolutionSteps, statOutliers } from '../tools/balance/stats.ts'
import { moveViolations } from '../tools/balance/moves.ts'
import { ttkViolations } from '../tools/balance/ttk.ts'
import { curveViolations } from '../tools/balance/curve.ts'
import { rarityCell } from '../tools/balance/solo.ts'
import { judgeMatrix, runMatrix, type TeamSource } from '../tools/balance/sim.ts'
import { DEFS, buildArchetype, lawProblems } from '../tools/balance/teams.ts'

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
    const even = rarityCell(hi, lo, 0, 6, 2, RULES.sim.seed).rate
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
