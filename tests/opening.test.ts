// The new prologue (#60): the stage chain is walkable, no choice can leave the player stuck, dialogue is paced, every text
// key exists, the stamps come from the three scripts the story names, and a time model keeps the road to the boss short.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorld, worldAnchors } from '../src/shared/world/index.ts'
import { STORY_CONTENT, storyProblems, walkSteps } from '../src/shared/world/story.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import type { NpcDef, ScriptStep } from '../src/shared/types.ts'

const world = buildWorld()
const anchors = worldAnchors(world)
const PROLOGUE_STAGES = 7
const MODEL = { dialogueSec: 4, turnSec: 10, tilesPerSec: 3.6, maxMinutes: 12 }

const npcById = new Map<string, { map: string; n: NpcDef }>()
for (const [map, m] of Object.entries(world.maps)) for (const n of m.npcs) npcById.set(n.id, { map, n })
const npc = (id: string) => { const e = npcById.get(id); assert.ok(e, `npc ${id}`); return e }
/** Every prologue script: the DS story scripts plus the NPCs that run them. */
const PROLOGUE_NPCS = ['mom', 'professor', 'rival-lab', 'aide-types', 'ds-terminal', 'rival-lab-back', 'ds-guard', 'ds-guard-aside', 'ds-ernie', 'ds-r1', 'ds-v2', 'ds-supply', 'ds-heal', 'ds-relay', 'ds-v4', 'rival-depart']
const scriptList = (): { id: string; steps: ScriptStep[] }[] => [
  ...PROLOGUE_NPCS.filter((id) => npcById.has(id)).map((id) => ({ id: `npc:${id}`, steps: npc(id).n.script })),
  ...Object.entries(STORY_CONTENT.scripts).filter(([id]) => id.startsWith('ds-')).map(([id, steps]) => ({ id, steps: steps as unknown as ScriptStep[] })),
]

test('prologue: the story validates clean', () => {
  assert.deepEqual(storyProblems(world), [])
})

test('stage chain: every prologue stage targets a real anchor and the next map is reachable by doors from the last', () => {
  const main = world.quests.find((q) => q.id === 'main')!
  const doors = (map: string) => world.maps[map].warps.map((w) => w.toMap)
  const reach = (from: string, to: string) => {
    const seen = new Set([from])
    const queue = [from]
    while (queue.length) for (const next of doors(queue.shift()!)) if (!seen.has(next)) { seen.add(next); queue.push(next) }
    return seen.has(to)
  }
  let at = world.startMap
  for (let i = 0; i <= PROLOGUE_STAGES; i++) {
    const target = main.stages[i].target
    assert.ok(target, `stage ${i} has a target`)
    const a = (target as unknown as { map: string } | undefined)?.map ?? anchors[target as unknown as string]?.map
    assert.ok(a, `stage ${i} target resolves`)
    assert.ok(reach(at, a), `stage ${i}: ${a} reachable from ${at}`)
    at = a
  }
})

/** Some path through `steps` sets `flag` without it hiding behind one option of a choice (every option sets it, or none is needed). */
const setsAlways = (steps: readonly ScriptStep[], flag: string): boolean =>
  steps.some((s) => {
    if (s.op === 'setFlag') return s.flag === flag
    if (s.op === 'ifFlag' || s.op === 'ifCaught' || s.op === 'ifItem' || s.op === 'ifBadges') return setsAlways(s.then, flag) || setsAlways(s.else ?? [], flag)
    if (s.op === 'choice') return s.branches.length > 0 && s.branches.every((b) => setsAlways(b, flag))
    return false
  })

test('choices: every flag the road to the boss waits for is set whichever option the player takes', () => {
  // The nurse / clerk lesson: a stamp, a briefing or a gate flag must never sit behind one option of a choice.
  const GATES = ['ds:stamp:starter', 'ds:stamp:types', 'ds:stamp:catch', 'ds:briefed', 'ds:drill', 'ds:met', 'ds:done', 'ds:gateOpen', 'ds:ernie', 'ds:relay']
  for (const flag of GATES) assert.ok(scriptList().some(({ steps }) => setsAlways(steps, flag)), `${flag} is set by some script on every option`)
})

test('choices: both "我都懂" / "不用了" options of the aide, the lobby brief and the drill rematch lead on', () => {
  const find = (id: string) => (id.startsWith('npc:') ? npc(id.slice(4)).n.script : (STORY_CONTENT.scripts[id] as unknown as ScriptStep[]))
  for (const id of ['npc:aide-types', 'npc:ds-r1']) {
    let seen = 0
    walkSteps(find(id), (s) => {
      if (s.op !== 'choice') return
      seen++
      assert.ok(s.branches.length === s.options.length, `${id}: one branch per option`)
    })
    assert.ok(seen > 0, `${id} has a choice`)
  }
})

test('pacing: no more than four say lines in a row without a beat between them', () => {
  const BEATS = new Set(['chooseStarter', 'emote', 'moveNpc', 'choice', 'wildBattle', 'battle', 'bossBattle', 'rivalBattle', 'starterBattle'])
  for (const { id, steps } of scriptList()) {
    const run = (list: ScriptStep[]): void => {
      let streak = 0
      for (const s of list) {
        if (s.op === 'say') streak++
        else if (BEATS.has(s.op)) streak = 0
        assert.ok(streak <= 4, `${id}: ${streak} say lines in a row`)
        if (s.op === 'ifFlag') { run(s.then); run(s.else ?? []) }
        if (s.op === 'choice') for (const b of s.branches) run(b)
      }
    }
    run(steps)
  }
})

test('text: every story.* / boss.deepseek.* key used by a prologue script exists and carries no stray placeholder', () => {
  const keys = new Set<string>()
  for (const { steps } of scriptList()) {
    const take = (v: unknown) => { if (typeof v === 'string' && /^(story|boss\.deepseek)\./.test(v)) keys.add(v) }
    walkSteps(steps, (s) => {
      const o = s as unknown as Record<string, unknown>
      take(o.text); take(o.speaker)
      if (Array.isArray(o.options)) o.options.forEach(take)
    })
  }
  for (const n of PROLOGUE_NPCS.filter((id) => npcById.has(id))) for (const line of (npc(n).n.lines ?? []) as string[]) if (/^story\./.test(line)) keys.add(line)
  assert.ok(keys.size > 80, `prologue uses many keys (${keys.size})`)
  for (const k of keys) {
    assert.ok(k in CONTENT.text, `text key ${k}`)
    if (k.startsWith('story.')) assert.ok(!/\{(?!name\})[^}]*\}/.test(CONTENT.text[k]), `${k} has a placeholder that never expands: ${CONTENT.text[k]}`)
  }
})

test('starter variants: every starter has its byStarter / starterBattle branch', () => {
  for (const { id, steps } of scriptList()) {
    walkSteps(steps, (s) => {
      if (s.op === 'byStarter') for (const starter of STORY_CONTENT.meta.starters ?? []) assert.ok(starter.id in s.cases || !('cases' in s), `${id}: byStarter lacks ${starter.id}`)
    })
  }
})

test('stamps: the three seals are set by the professor, the aide and the catch script; the guard blocks the stairs until the cert is full', () => {
  const sets = (steps: ScriptStep[], flag: string) => { let f = false; walkSteps(steps, (st) => { if (st.op === 'setFlag' && st.flag === flag) f = true }); return f }
  assert.ok(sets(npc('professor').n.script, 'ds:stamp:starter') || sets(STORY_CONTENT.scripts['ds-zero-down'] as unknown as ScriptStep[], 'ds:stamp:starter'), 'the professor line stamps the starter seal')
  assert.ok(sets(npc('aide-types').n.script, 'ds:stamp:types'), 'the aide stamps the types seal')
  assert.ok(sets(STORY_CONTENT.scripts['ds-stamp-catch'] as unknown as ScriptStep[], 'ds:stamp:catch'), 'the catch script stamps the catch seal')
  const guard = npc('ds-guard')
  const stairs = world.maps[guard.map].warps.find((w) => w.kind === 'stairs' && w.toMap === 'origin-lab-b1')
  assert.ok(stairs, 'the lab has stairs down')
  assert.ok(Math.abs(guard.n.x - stairs.x) + Math.abs(guard.n.y - stairs.y) <= 1, 'the guard stands in front of the stairs')
  assert.equal(guard.n.hiddenIfFlag, 'ds:certFull')
})

// -- time model ------------------------------------------------------------------------------------------------

/** A tiny interpreter: follows the first option of every choice, the flags the player has accumulated, includes and macros. */
function readerSeconds(steps: ScriptStep[], flags: Set<string>, depth = 0): { lines: number; battles: string[] } {
  const out = { lines: 0, battles: [] as string[] }
  const run = (list: ScriptStep[]): void => {
    for (const s of list) {
      switch (s.op) {
        case 'say': out.lines++; break
        case 'setFlag': flags.add(s.flag); break
        case 'chooseStarter': flags.add('starter'); break
        case 'byStarter': run((s.cases as Record<string, ScriptStep[]>)['o1'] ?? []); break
        case 'ifCaught': run((flags.has('caught') ? s.then : s.else) ?? []); break
        case 'ifFlag': run((flags.has(s.flag) ? s.then : s.else) ?? []); break
        case 'choice': run(s.branches[0] ?? []); break
        case 'include': if (depth < 8) { const r = readerSeconds(STORY_CONTENT.scripts[s.script] as unknown as ScriptStep[], flags, depth + 1); out.lines += r.lines; out.battles.push(...r.battles) } break
        case 'bossBattle': out.battles.push(`boss:${s.boss}`); break
        case 'battle': case 'wildBattle': case 'rivalBattle': case 'starterBattle': out.battles.push(s.op); break
        default: break
      }
    }
  }
  run(steps)
  return out
}

test('time model: the shortest road from waking to the DeepSeek fight stays within the budget', () => {
  const TURNS: Record<string, number> = { battle: 4, wildBattle: 4, rivalBattle: 4, starterBattle: 4, 'boss:deepseek-drill': 8 }
  // The itinerary a first-time player follows, by NPC id (reading the script once, then walking to the next one).
  const route = ['mom', 'professor', 'rival-lab', 'aide-types', 'ds-ernie', 'ds-guard', 'ds-r1', 'ds-r1', 'ds-relay', 'ds-v4']
  const flags = new Set<string>()
  let lines = 0
  let turns = 0
  let tiles = 0
  let prev: { map: string; x: number; y: number } | null = null
  for (const id of route) {
    const e = npc(id)
    const here = { map: e.map, x: e.n.x, y: e.n.y }
    if (prev) tiles += prev.map === here.map ? Math.abs(prev.x - here.x) + Math.abs(prev.y - here.y) : 12
    prev = here
    const r = readerSeconds(e.n.script, flags)
    lines += r.lines
    for (const b of r.battles) if (b !== 'boss:deepseek') turns += TURNS[b] ?? 0
  }
  const minutes = (lines * MODEL.dialogueSec + turns * MODEL.turnSec + tiles / MODEL.tilesPerSec) / 60
  if (process.env.OPENING_REPORT) console.log(`opening time model: ${lines} lines, ${turns} turns, ${tiles} tiles = ${minutes.toFixed(1)} min`)
  assert.ok(minutes <= MODEL.maxMinutes, `${minutes.toFixed(1)} min > ${MODEL.maxMinutes}`)
})
