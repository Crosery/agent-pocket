// The type chart screen teaches from content/types.json: the loops it draws and the matchup rows it lists must
// never drift from the chart itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t, typeEffectiveness } from '../src/shared/content/index.ts'
import { buildWorld, worldAnchors } from '../src/shared/world/index.ts'
import { TUTORIAL, validateTutorial, validateTypeChartTeaching, type LoopDef } from '../src/client/onboarding/config.ts'
import { SCREENS, validateTypeChartConfig } from '../src/client/ui/screens/config.ts'
import { attackGroups, defendGroups, exampleOf, loopEdges, mulOf, ringLayout, rowOfMul } from '../src/client/ui/screens/typechart-logic.ts'

const loops = TUTORIAL.typeChart.loops
const ids = CONTENT.types.map((x) => x.id)

test('every edge of every loop is super effective (x2) in the chart', () => {
  assert.ok(loops.length >= 4, 'the four memory loops are taught')
  for (const loop of loops) {
    assert.ok(loop.types.length >= 3, `${loop.id}: a loop has at least three types`)
    for (const [from, to] of loopEdges(loop)) {
      assert.equal(CONTENT.typeChart[from]?.[to], 2, `${loop.id}: ${from} -> ${to} is not x2 in content/types.json`)
      assert.equal(typeEffectiveness(from, [to]), 2)
    }
  }
})

test('loops are closed rings of distinct, known types and each has a title and a reason per arrow', () => {
  assert.deepEqual(validateTypeChartTeaching(), [])
  for (const loop of loops) {
    assert.equal(new Set(loop.types).size, loop.types.length, `${loop.id}: repeated type`)
    assert.deepEqual(loopEdges(loop).map(([, to]) => to), [...loop.types.slice(1), loop.types[0]], `${loop.id}: last edge closes the ring`)
    assert.notEqual(t(`screens.typeChart.loops.${loop.id}.title`), `screens.typeChart.loops.${loop.id}.title`)
    for (const [a, b] of loopEdges(loop)) assert.ok(`screens.typeChart.reason.${a}.${b}` in CONTENT.text, `${loop.id}: no reason text for ${a} -> ${b}`)
  }
  assert.equal(loops.filter((l) => l.starter).length, 1, 'exactly one ring is the starter triangle')
  const starter = loops.find((l) => l.starter)!
  const starters = CONTENT.speciesList.filter((s) => s.starter).map((s) => s.types[0])
  assert.ok(starter.types.every((id) => starters.includes(id)), 'the starter triangle is made of the starters\' types')
})

test('the validator catches a loop edge that is not x2', () => {
  const bad: LoopDef = { id: 'bad', types: ['chat', 'logic', 'code'] }
  const errs = validateTypeChartTeaching({ ...TUTORIAL, typeChart: { loops: [bad] } })
  assert.ok(errs.some((e) => e.includes('chat -> logic is not super effective')), errs.join('\n'))
})

test('tutorial content (tips offering the chart, lesson links) validates', () => {
  const world = buildWorld()
  assert.deepEqual(validateTutorial(world, worldAnchors(world)), [])
  assert.deepEqual(validateTypeChartConfig(SCREENS.typeChart, CONTENT), [])
  const offered = TUTORIAL.tips.list.filter((x) => x.open).map((x) => x.id)
  for (const id of ['typeMatchup', 'superEffective', 'resisted']) assert.ok(offered.includes(id), `${id} offers the chart`)
  const lesson = TUTORIAL.curriculum.lessons.find((l) => l.id === 'typeChart')!
  assert.ok(lesson.chart, 'the manual page opens the chart')
})

test('matchup rows are exactly the chart: attack and defence agree, and every pair is in at most one row', () => {
  for (const id of ids) {
    const atk = attackGroups(id), def = defendGroups(id)
    for (const g of atk) for (const d of g.types) assert.equal(mulOf(id, d), g.row.mul)
    for (const g of def) for (const a of g.types) assert.equal(mulOf(a, id), g.row.mul)
    for (const a of atk) for (const d of a.types) {
      assert.ok(defendGroups(d).find((g) => g.row.mul === a.row.mul)?.types.includes(id), `${id} -> ${d} appears in ${d}'s defence rows`)
    }
    const seen = atk.flatMap((g) => g.types)
    assert.equal(new Set(seen).size, seen.length, `${id}: a defender listed twice`)
  }
  // Every non-neutral cell of the chart shows up in the attack rows of its attacker.
  for (const a of ids) for (const d of ids) {
    const mul = mulOf(a, d)
    if (mul === 1) { assert.equal(rowOfMul(mul), null); continue }
    assert.ok(attackGroups(a).find((g) => g.row.mul === mul)?.types.includes(d), `${a} -> ${d} x${mul} missing from the attack rows`)
  }
})

test('the worked example is a real x2 (or the next best) matchup of the type', () => {
  for (const id of ids) {
    const ex = exampleOf(id)
    assert.ok(ex, `${id} has an example`)
    assert.equal(mulOf(id, ex.def), ex.mul)
    assert.equal(ex.mul, 2, `${id}: the teaching example is a super effective hit`)
  }
})

test('ring geometry: nodes stay inside the box, arrows run clockwise and stop at the next node', () => {
  const ring = SCREENS.typeChart.loops.ring
  for (const loop of loops) {
    const layout = ringLayout(loop.types, ring, ring.label)
    assert.equal(layout.nodes.length, loop.types.length)
    for (const n of layout.nodes) {
      assert.ok(n.x - ring.node / 2 >= 0 && n.x + ring.node / 2 <= ring.w, `${loop.id}: ${n.id} sticks out sideways`)
      assert.ok(n.y - ring.node / 2 - (n.labelAbove ? ring.label : 0) >= 0 && n.y + ring.node / 2 + (n.labelAbove ? 0 : ring.label) <= ring.h, `${loop.id}: ${n.id} sticks out vertically`)
    }
    assert.deepEqual(layout.arrows.map((a) => [a.from, a.to]), loopEdges(loop))
    for (const a of layout.arrows) {
      const to = layout.nodes.find((n) => n.id === a.to)!
      const tip = a.head[0]
      const gap = Math.hypot(tip[0] - to.x, tip[1] - to.y)
      assert.ok(Math.abs(gap - (ring.node / 2 + ring.gap)) < 0.01, `${a.from} -> ${a.to}: the head touches the next node's rim`)
    }
  }
})
