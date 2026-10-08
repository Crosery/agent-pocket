// Story branches and the hidden storyline (issue #25): every branch choice has divergent consequences that other scripts
// read later, no branch can stall the main quest, and the hidden 「第 0 号服务器」 chain is reachable and one-time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorld, worldAnchors, worldBuildInfo } from '../src/shared/world/index.ts'
import { STORY_CONTENT, walkSteps } from '../src/shared/world/story.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import type { NpcDef, ScriptStep } from '../src/shared/types.ts'

const world = buildWorld()
const anchors = worldAnchors(world)
const npcs: NpcDef[] = Object.values(world.maps).flatMap((m) => m.npcs)
const all: { n: NpcDef; s: ScriptStep }[] = []
for (const n of npcs) walkSteps(n.script, (s) => { all.push({ n, s }) })

type Choice = Extract<ScriptStep, { op: 'choice' }>
const ops = (steps: ScriptStep[]): ScriptStep[] => { const out: ScriptStep[] = []; walkSteps(steps, (s) => out.push(s)); return out }
const setsOf = (steps: ScriptStep[], flag: string) => ops(steps).flatMap((s) => (s.op === 'setFlag' && s.flag === flag ? [String(s.value ?? true)] : []))
const rewardsOf = (steps: ScriptStep[]) => ops(steps).filter((s) => s.op === 'giveItem' || s.op === 'giveMoney').map((s) => JSON.stringify(s))

// choice flag -> NPCs that must read it with `equals`
const BRANCHES: Record<string, { values: string[]; readers: string[] }> = {
  'rival:bond': { values: ['ally', 'rival', 'calm'], readers: ['rival-frost', 'rival-final'] },
  'choice:dataset': { values: ['public', 'lab', 'keep'], readers: ['professor', 'dc-chief'] },
  'temple:blessing': { values: ['accept', 'refuse'], readers: ['champion'] },
  'zero:ending': { values: ['lab', 'rival', 'self'], readers: ['professor', 'rival-final'] },
}

test('four branch choices: each option sets a different value and pays out differently', () => {
  for (const [flag, spec] of Object.entries(BRANCHES)) {
    const choices = all.filter(({ s }) => s.op === 'choice' && (s as Choice).branches.some((b) => setsOf(b, flag).length))
    assert.equal(choices.length, 1, `${flag}: exactly one deciding choice`)
    const c = choices[0].s as Choice
    const values = c.branches.map((b) => setsOf(b, flag)[0]).filter(Boolean)
    assert.deepEqual([...values].sort(), [...spec.values].sort(), `${flag} values`)
    const rewards = c.branches.filter((b) => setsOf(b, flag).length).map((b) => rewardsOf(b).join('|'))
    assert.equal(new Set(rewards).size, rewards.length, `${flag}: every option has its own reward`)
    for (const b of c.branches) for (const s of ops(b)) assert.ok(s.op !== 'quest' || s.quest !== 'main', `${flag}: a branch must not touch the main quest`)
  }
})

test('branch consequences are read downstream with the right values', () => {
  for (const [flag, spec] of Object.entries(BRANCHES)) {
    for (const reader of spec.readers) {
      const hits = all.filter(({ n, s }) => (n.id === reader || n.trainer === reader) && s.op === 'ifFlag' && s.flag === flag && s.equals !== undefined)
      assert.ok(hits.length, `${reader} never reacts to ${flag}`)
      const seen = new Set(hits.map(({ s }) => String((s as { equals: unknown }).equals)))
      assert.ok([...seen].every((v) => spec.values.includes(v)), `${reader}: unknown value for ${flag}`)
    }
  }
  const lines = (id: string, flag: string, value: string) => all.filter(({ n, s }) => n.id === id && s.op === 'ifFlag' && s.flag === flag && s.equals === value).length
  assert.ok(lines('rival-final', 'rival:bond', 'ally') && lines('rival-final', 'rival:bond', 'rival'), 'the rival greets allies and rivals differently')
})

test('the main quest keeps advancing whatever is chosen', () => {
  const main = STORY_CONTENT.quests.find((q) => q.id === 'main')!
  const stages = new Set<number>()
  for (const { s, n } of all) if (s.op === 'quest' && s.quest === 'main') stages.add(s.stage)
  for (const l of Object.values(STORY_CONTENT.scripts)) walkSteps(l as ScriptStep[], (s) => { if (s.op === 'quest' && s.quest === 'main') stages.add(s.stage) })
  for (let i = 0; i < main.stages.length; i++) assert.ok(stages.has(i), `main stage ${i} still has a setter`)
  // the rival fights stay outside every choice
  for (const id of ['rival-pixelport', 'rival-frost', 'rival-final']) {
    const n = npcs.find((x) => x.id === id)!
    assert.ok(n.script.some((s) => s.op === 'battle' || s.op === 'ifFlag'), `${id} still battles`)
    assert.ok(ops(n.script).some((s) => s.op === 'battle'), `${id} battle step`)
  }
})

test('hidden storyline 「第 0 号服务器」: explore, chain of flags, one-time ending, reachable on foot', () => {
  const t = npcs.find((n) => n.id === 'zero-terminal')!
  const rack = npcs.find((n) => n.id === 'zero-rack')!
  const keeper = npcs.find((n) => n.id === 'zero-keeper')!
  assert.ok(!t.hiddenUnlessFlag, 'the first terminal is found by exploring, not unlocked')
  assert.equal(rack.hiddenUnlessFlag, 'zero:t1')
  assert.equal(keeper.hiddenUnlessFlag, 'zero:t2')
  assert.ok(setsOf(t.script, 'zero:t1').length && setsOf(rack.script, 'zero:t2').length && setsOf(keeper.script, 'zero:ending').length === 3)
  for (const n of [t, rack, keeper]) assert.ok(ops(n.script).some((s) => s.op === 'ifFlag'), `${n.id} has a one-time guard`)
  const q = STORY_CONTENT.quests.find((x) => x.id === 'hq-zero')!
  assert.equal(q.stages.length, 3)
  const stagesSet = new Set(all.filter(({ s }) => s.op === 'quest' && s.quest === 'hq-zero').map(({ s }) => (s as { stage: number }).stage))
  assert.deepEqual([...stagesSet].sort(), [0, 1, 2])
  assert.ok(all.some(({ s }) => s.op === 'quest' && s.quest === 'hq-zero' && s.done), 'the quest finishes')
  // the rack can be paid for with money when no shard is at hand (no soft lock)
  assert.ok(ops(rack.script).some((s) => s.op === 'takeMoney'))
  const walk = worldBuildInfo(world).walkReach
  const open = (id: string) => (id in CONTENT.items || !!CONTENT.items[id])
  for (const s of ops([...t.script, ...rack.script, ...keeper.script])) {
    if (s.op === 'giveItem' || s.op === 'takeItem' || s.op === 'ifItem') assert.ok(open(s.item), s.item)
  }
  const a = anchors['region:desert']
  assert.ok(a && a.map === 'overworld' && walk[a.y * world.maps.overworld.width + a.x] === 1, 'the second cabinet is reachable without surfing')
  for (const n of [t, rack, keeper]) assert.ok(world.maps[n.id === 'zero-terminal' ? 'cave-core' : n.id === 'zero-rack' ? 'overworld' : 'agi-house1'].npcs.includes(n))
})
