import { TUTORIAL } from '../src/client/onboarding/config.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, typeEffectiveness, type Content } from '../src/shared/content/index.ts'
import type { GameMap, NpcDef, ScriptStep, SpeciesDef, World } from '../src/shared/types.ts'
import { WORLD_CONTENT, buildWorld, worldAnchors, worldBuildInfo } from '../src/shared/world/index.ts'
import { buildCollision } from '../src/shared/world/collision.ts'
import { floodReach } from '../src/shared/world/reach.ts'
import { levelForm, resolvePick, resolvePickAvoiding } from '../src/shared/world/pick.ts'
import {
  STORY_CONTENT, applyStory, rivalStarterFor, rivalTrainerId, starterSpecies, storyFeatures, storyProblems, walkSteps,
  type StoryContent,
} from '../src/shared/world/story.ts'
import { HintIndex } from '../src/shared/world/story-procgen.ts'

// Acceptance thresholds for the shipped story content.
const MIN_ROUTE_TRAINERS = 50
const ROUTE_SIGHT = [3, 5]
const ROUTE_PARTY = [1, 4]
const ROUTE_LEVEL_SLACK = 2
const GYM_TRAINERS = [2, 4]
const FIRST_LEADER_ACE = [10, 14]
const LAST_LEADER_ACE = [50, 55]
const CHAMPION_ACE = [60, 65]
const MIN_SIDE_QUESTS = 10
const MIN_TOWN_VILLAGERS = 3
const MIN_TUTORS = 2
/** Roster size from which type-specific catch quests must be satisfiable (placeholder rosters are smaller). */
const FULL_ROSTER = 30
/** Each population rule must fill at least this fraction of share × matching spots (the rest fail spacing/sealing). */
const MIN_POPULATION_FILL = 0.5
const MIN_WILD_TRAINERS = 150
const MIN_BOUNTIES = 15
const LEGEND_TABLETS = [3, 5]
const MIN_HERMITS = 5
/** applyStory alone on the default world (ms); buildWorld's own budget is asserted in world.test.ts. */
const STORY_BUDGET_MS = 400

const world = buildWorld()
const anchors = worldAnchors(world)
const ow = world.maps[world.startMap]
const npcs: (NpcDef & { map: string })[] = Object.values(world.maps).flatMap((m) => m.npcs.map((n) => ({ ...n, map: m.id })))
const npcById = new Map(npcs.map((n) => [n.id, n]))
const allSteps = (n: NpcDef): ScriptStep[] => { const out: ScriptStep[] = []; walkSteps(n.script, (s) => out.push(s)); return out }
const everyStep = npcs.flatMap((n) => allSteps(n).map((s) => ({ s, n })))
const colCache = new Map<string, Uint8Array>()
const col = (m: GameMap) => { let c = colCache.get(m.id); if (!c) { c = buildCollision(m); colCache.set(m.id, c) } return c }

function storyDigest(w: World): string {
  const maps = Object.keys(w.maps).sort().map((id) => [id, w.maps[id].npcs])
  return JSON.stringify([maps, w.trainers, w.quests])
}

const familyOf = (id: string) => CONTENT.species[id]?.family

test('story applies cleanly to the default world', () => {
  const problems = storyProblems(world)
  assert.deepEqual(problems, [], problems.join('\n'))
  assert.ok(npcs.length > 0 && Object.keys(world.trainers).length > 0 && world.quests.length > 0)
})

test('NPCs: unique ids, walkable non-warp tiles, never on arrival tiles or other NPCs', () => {
  const ids = new Set<string>()
  const tiles = new Set<string>()
  const arrivals = new Set<string>()
  for (const m of Object.values(world.maps)) {
    arrivals.add(`${m.id}:${m.spawn.x},${m.spawn.y}`)
    for (const w of m.warps) arrivals.add(`${w.toMap}:${w.toX},${w.toY}`)
  }
  for (const n of npcs) {
    const m = world.maps[n.map]
    assert.ok(!ids.has(n.id), `duplicate npc id ${n.id}`); ids.add(n.id)
    const key = `${n.map}:${n.x},${n.y}`
    assert.ok(!tiles.has(key), `two NPCs on ${key}`); tiles.add(key)
    assert.ok(n.x >= 0 && n.y >= 0 && n.x < m.width && n.y < m.height, `${n.id} out of bounds`)
    assert.equal(col(m)[n.y * m.width + n.x], 0, `${n.id} on a blocked tile ${key}`)
    assert.ok(!m.warps.some((w) => w.x === n.x && w.y === n.y), `${n.id} on a warp`)
    assert.ok(!arrivals.has(key), `${n.id} on an arrival tile`)
    assert.ok(['up', 'down', 'left', 'right'].includes(n.facing), `${n.id} facing`)
    assert.ok(CONTENT.characterById[n.sprite], `${n.id} sprite ${n.sprite}`)
    if (n.portrait) assert.ok(CONTENT.characterById[n.portrait], `${n.id} portrait ${n.portrait}`)
  }
})

test('permanent NPCs never seal warps, towns or each other', () => {
  const hidden = new Set(everyStep.filter(({ s }) => s.op === 'hideNpc').map(({ s }) => (s as { npc: string }).npc))
  const permanent = npcs.filter((n) => !n.hiddenIfFlag && !hidden.has(n.id))
  for (const m of Object.values(world.maps)) {
    const blocked = new Set(permanent.filter((n) => n.map === m.id).map((n) => n.y * m.width + n.x))
    const reach = floodReach(m, col(m), m.spawn.x, m.spawn.y, m === ow, blocked)
    const near = (x: number, y: number) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy
      return nx >= 0 && ny >= 0 && nx < m.width && ny < m.height && reach[ny * m.width + nx] === 1
    })
    for (const w of m.warps) assert.ok(near(w.x, w.y), `${m.id}: warp ${w.x},${w.y} sealed by NPCs`)
    if (m === ow) for (const t of world.towns) assert.ok(near(t.x, t.y), `${t.id} sealed by NPCs`)
    for (const n of npcs.filter((x) => x.map === m.id)) {
      const across = { up: [0, -2], down: [0, 2], left: [-2, 0], right: [2, 0] }[n.facing]
      const talk = near(n.x, n.y) || reach[(n.y + across[1]) * m.width + (n.x + across[0])] === 1
      assert.ok(talk, `${n.id} cannot be talked to`)
    }
  }
})

test('trainers: references, resolved species, levels, sprites', () => {
  for (const n of npcs) if (n.trainer) assert.ok(world.trainers[n.trainer], `${n.id} -> trainer ${n.trainer}`)
  for (const s of everyStep) if (s.s.op === 'battle') assert.ok(world.trainers[s.s.trainer], `${s.n.id} battles unknown ${s.s.trainer}`)
  for (const t of Object.values(world.trainers)) {
    assert.ok(CONTENT.characterById[t.sprite], `${t.id} sprite`)
    assert.ok(t.party.length >= 1 && t.party.length <= CONTENT.config.party.maxParty, `${t.id} party size`)
    for (const p of t.party) {
      assert.ok(p.species && CONTENT.species[p.species], `${t.id}: unresolved species ${p.species}`)
      assert.equal((p as { pick?: unknown }).pick, undefined, `${t.id}: pick leaked into World`)
      assert.ok(p.level >= 1 && p.level <= CONTENT.config.party.maxLevel)
      assert.equal(levelForm(CONTENT.species[p.species!], p.level).id, p.species, `${t.id}: ${p.species} not level-appropriate at ${p.level}`)
    }
    assert.ok(t.reward >= 0 && Number.isFinite(t.reward))
    assert.ok(t.introText.length > 0 && t.defeatText.length > 0, `${t.id} lines`)
    for (const it of Object.keys(t.items ?? {})) assert.ok(CONTENT.items[it], `${t.id} item ${it}`)
  }
})

const KNOWN_OPS = new Set([
  'say', 'choice', 'setFlag', 'ifFlag', 'ifBadges', 'ifItem', 'ifCaught', 'giveItem', 'takeItem', 'giveMoney', 'takeMoney',
  'giveCreature', 'chooseStarter', 'battle', 'wildBattle', 'heal', 'shop', 'openBox', 'quest', 'warp', 'moveNpc', 'faceNpc',
  'hideNpc', 'showNpc', 'sfx', 'bgm', 'wait', 'fade', 'unlockTown', 'setRespawn', 'end', 'exchange', 'teach', 'openTypeChart',
])

test('scripts are well-formed recursively and every reference resolves', () => {
  const quests = new Map(world.quests.map((q) => [q.id, q]))
  const bgm = new Set(CONTENT.audio.bgm.map((b) => b.id))
  const check = (steps: unknown, where: string): void => {
    assert.ok(Array.isArray(steps), `${where}: not a step list`)
    for (const [i, raw] of (steps as unknown[]).entries()) {
      const at = `${where}.${i}`
      const s = raw as ScriptStep
      assert.ok(KNOWN_OPS.has(s.op), `${at}: unknown op ${s.op}`)
      assert.equal((s as { pick?: unknown }).pick, undefined, `${at}: pick leaked`)
      switch (s.op) {
        case 'say': assert.ok(s.text, at); break
        case 'choice':
          assert.ok(s.options.length >= 2 && s.options.length === s.branches.length, `${at}: options/branches`)
          s.branches.forEach((b, j) => check(b, `${at}.b${j}`))
          break
        case 'ifFlag': case 'ifBadges': case 'ifItem': case 'ifCaught':
          check(s.then, `${at}.then`)
          if (s.else !== undefined) check(s.else, `${at}.else`)
          if (s.op === 'ifItem') assert.ok(CONTENT.items[s.item], `${at}: item ${s.item}`)
          if (s.op === 'ifCaught' && s.type) assert.ok(CONTENT.typeById[s.type], `${at}: type ${s.type}`)
          if (s.op === 'ifCaught' && s.species) assert.ok(CONTENT.species[s.species], `${at}: species ${s.species}`)
          break
        case 'giveItem': case 'takeItem': assert.ok(CONTENT.items[s.item] && s.qty > 0, `${at}: item ${s.item}`); break
        case 'giveMoney': case 'takeMoney': assert.ok(s.amount > 0, at); break
        case 'giveCreature': case 'wildBattle':
          assert.ok(s.species && CONTENT.species[s.species], `${at}: species ${s.species}`)
          if (s.op === 'wildBattle' && s.music) assert.ok(bgm.has(s.music), `${at}: music`)
          break
        case 'battle': assert.ok(world.trainers[s.trainer], `${at}: trainer ${s.trainer}`); break
        case 'shop': assert.ok(s.items.length > 0 && s.items.every((x) => CONTENT.items[x]), `${at}: shop items`); break
        case 'quest': {
          const q = quests.get(s.quest)
          assert.ok(q && s.stage >= 0 && s.stage < q.stages.length, `${at}: quest ${s.quest}#${s.stage}`)
          break
        }
        case 'hideNpc': case 'showNpc': case 'faceNpc': case 'moveNpc': assert.ok(npcById.has(s.npc), `${at}: npc ${s.npc}`); break
        case 'warp': assert.ok(world.maps[s.map], `${at}: map ${s.map}`); break
        case 'sfx': assert.ok(CONTENT.audio.sfx.includes(s.id), `${at}: sfx ${s.id}`); break
        case 'bgm': assert.ok(bgm.has(s.id), `${at}: bgm ${s.id}`); break
        case 'unlockTown': assert.ok(world.towns.some((t) => t.id === s.town), `${at}: town ${s.town}`); break
      }
    }
  }
  for (const n of npcs) check(n.script, n.id)
})

test('no unresolved placeholders or authoring macros reach the World', () => {
  const placeholder = /\{[\w:-]+\}/
  const scan = (v: unknown, where: string): void => {
    if (typeof v === 'string') assert.ok(!placeholder.test(v), `${where}: unresolved "${v}"`)
    else if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${where}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, `${where}.${k}`)
  }
  scan(npcs, 'npcs'); scan(world.trainers, 'trainers'); scan(world.quests, 'quests')
})

test('flags read by scripts are written somewhere or are client conventions', () => {
  const f = STORY_CONTENT.meta.flags
  const written = new Set(everyStep.filter(({ s }) => s.op === 'setFlag').map(({ s }) => (s as { flag: string }).flag))
  for (const { s } of everyStep) if (s.op === 'battle' && s.lossFlag) written.add(s.lossFlag)
  for (const { s } of everyStep) if (s.op === 'teach') written.add(`${TUTORIAL.curriculum.flagPrefix}${s.lesson}`)
  const groundItems = new Set(Object.values(world.maps).flatMap((m) => m.items.map((i) => i.id)))
  const ok = (flag: string) => written.has(flag) || flag === f.starter
    || (flag.startsWith(f.trainerWon) && !!world.trainers[flag.slice(f.trainerWon.length)])
    || (flag.startsWith(f.groundItem) && groundItems.has(flag.slice(f.groundItem.length)))
  for (const n of npcs) {
    for (const flag of [n.hiddenIfFlag, n.hiddenUnlessFlag]) if (flag) assert.ok(ok(flag), `${n.id}: flag "${flag}" never set`)
  }
  for (const { s, n } of everyStep) if (s.op === 'ifFlag') assert.ok(ok(s.flag), `${n.id}: flag "${s.flag}" never set`)
})

test('hideNpc always persists through a flag the hidden NPC watches', () => {
  for (const { s, n } of everyStep) {
    if (s.op !== 'hideNpc') continue
    const target = npcById.get(s.npc)!
    assert.ok(target.hiddenIfFlag, `${s.npc} hidden by ${n.id} but has no hiddenIfFlag`)
    assert.ok(allSteps(n).some((x) => x.op === 'setFlag' && x.flag === target.hiddenIfFlag), `${n.id} hides ${s.npc} without setting ${target.hiddenIfFlag}`)
  }
})

test('every gym has a leader that awards its badge', () => {
  assert.ok(world.badges.length > 0)
  for (const b of world.badges) {
    const t = world.trainers[b.leader]
    assert.ok(t, `badge ${b.id}: leader trainer ${b.leader}`)
    assert.equal(t.badge, b.id)
    const gymMap = WORLD_CONTENT.towns.find((x) => x.id === b.town)?.buildings?.gym?.mapId
    const npc = npcs.find((n) => n.trainer === b.leader)
    assert.ok(npc && npc.role === 'gymLeader' && npc.map === gymMap, `${b.leader} stands in ${gymMap}`)
    const steps = allSteps(npc)
    assert.ok(steps.some((s) => s.op === 'battle' && s.trainer === b.leader), `${b.leader} script battles`)
    assert.ok(steps.some((s) => s.op === 'setFlag' && s.flag === `badge:${b.type}`), `${b.leader} sets badge flag`)
    assert.ok(steps.some((s) => s.op === 'giveItem' && CONTENT.items[s.item]?.category === 'chip'), `${b.leader} gives a chip`)
    const gymTrainers = npcs.filter((n) => n.map === gymMap && n.trainer && n.trainer !== b.leader)
    assert.ok(gymTrainers.length >= GYM_TRAINERS[0] && gymTrainers.length <= GYM_TRAINERS[1], `${gymMap}: ${gymTrainers.length} gym trainers`)
  }
  // Leaders get stronger in town order; the first and last aces sit in the agreed bands.
  const aces = WORLD_CONTENT.towns.filter((t) => t.gym).map((t) => Math.max(...world.trainers[t.gym!.leader].party.map((p) => p.level)))
  for (let i = 1; i < aces.length; i++) assert.ok(aces[i] > aces[i - 1], `leader aces must increase: ${aces}`)
  assert.ok(aces[0] >= FIRST_LEADER_ACE[0] && aces[0] <= FIRST_LEADER_ACE[1], `first ace ${aces[0]}`)
  const last = aces[aces.length - 1]
  assert.ok(last >= LAST_LEADER_ACE[0] && last <= LAST_LEADER_ACE[1], `last ace ${last}`)
})

test('route trainers: count, sight, party size, region-appropriate levels', () => {
  const route = npcs.filter((n) => n.trainer && n.map === ow.id && Object.entries(anchors).some(([k, a]) => k.startsWith('route:') && a.map === n.map && a.x === n.x && a.y === n.y))
  assert.ok(route.length >= MIN_ROUTE_TRAINERS, `${route.length} route trainers`)
  for (const n of route) {
    const name = Object.entries(anchors).find(([k, a]) => k.startsWith('route:') && a.x === n.x && a.y === n.y)![0]
    const spec = WORLD_CONTENT.routes.find((r) => r.id === name.split(':')[1])!
    const t = world.trainers[n.trainer!]
    assert.ok(n.sightRange! >= ROUTE_SIGHT[0] && n.sightRange! <= ROUTE_SIGHT[1], `${n.id} sight ${n.sightRange}`)
    assert.ok(t.party.length >= ROUTE_PARTY[0] && t.party.length <= ROUTE_PARTY[1], `${n.id} party`)
    for (const p of t.party) {
      assert.ok(p.level >= spec.levelRange[0] - ROUTE_LEVEL_SLACK && p.level <= spec.levelRange[1] + ROUTE_LEVEL_SLACK, `${n.id} level ${p.level} vs ${spec.levelRange}`)
    }
  }
})

test('rival: one variant per starter and battle, always taking the advantaged starter', () => {
  const starters = starterSpecies()
  assert.ok(starters.length > 0)
  for (const p of starters) {
    const r = rivalStarterFor(p.id)!
    const off = (a: SpeciesDef) => Math.max(...a.types.map((t) => typeEffectiveness(t, p.types)))
    for (const o of starters) if (o.id !== p.id && starters.length > 1) assert.ok(off(r) >= off(o), `rival vs ${p.id}`)
    for (const b of STORY_CONTENT.rival.battles) {
      const t = world.trainers[rivalTrainerId(b.key, p.id)]
      assert.ok(t, `rival ${b.key} for ${p.id}`)
      const ace = b.party.findIndex((x) => x.rivalStarter)
      if (ace >= 0) assert.equal(familyOf(t.party[ace].species!), r.family, `${t.id} uses the rival starter line`)
    }
  }
  const branches = everyStep.filter(({ s }) => s.op === 'ifFlag' && s.flag === STORY_CONTENT.meta.flags.starter && s.equals !== undefined)
  for (const p of starters) assert.ok(branches.some(({ s }) => (s as { equals?: unknown }).equals === p.id), `no rival branch for ${p.id}`)
})

test('prologue: starter, gifts, rival battle and heal are wired', () => {
  const ops = everyStep.map(({ s }) => s)
  assert.ok(ops.some((s) => s.op === 'chooseStarter'))
  for (const key of ['dex', 'map']) {
    assert.ok(ops.some((s) => s.op === 'giveItem' && (CONTENT.items[s.item]?.effect as { key?: string }).key === key), `key item ${key} given`)
  }
  assert.ok(ops.some((s) => s.op === 'giveItem' && CONTENT.items[s.item]?.category === 'ball' && s.qty >= 5))
  assert.ok(ops.some((s) => s.op === 'heal'))
  for (const key of ['bike', 'surf', 'badgeCase', 'pass']) {
    assert.ok(ops.some((s) => s.op === 'giveItem' && (CONTENT.items[s.item]?.effect as { key?: string }).key === key), `key item ${key} given`)
  }
  // Without a starter the start town is sealed: the starter flag hides the blockers.
  const blockers = npcs.filter((n) => n.map === ow.id && n.hiddenIfFlag === STORY_CONTENT.meta.flags.starter)
  assert.ok(blockers.length > 0)
  const reach = floodReach(ow, col(ow), ow.spawn.x, ow.spawn.y, false, new Set(blockers.map((n) => n.y * ow.width + n.x)))
  const start = world.towns.find((t) => t.x === anchors['town:origin']?.x && t.y === anchors['town:origin']?.y)
  for (const t of world.towns) if (t !== start) assert.equal(reach[t.y * ow.width + t.x], 0, `${t.id} reachable without a starter`)
})

test('gates hold until their condition, then open', () => {
  const gates = npcs.filter((n) => Object.entries(anchors).some(([k, a]) => k.startsWith('gate:') && a.map === n.map && a.x === n.x && a.y === n.y))
  assert.equal(gates.length, Object.keys(anchors).filter((k) => k.startsWith('gate:')).length)
  for (const g of gates) {
    assert.ok(g.hiddenIfFlag, `${g.id} must disappear once open`)
    const reach = floodReach(ow, col(ow), ow.spawn.x, ow.spawn.y, true, new Set(gates.map((n) => n.y * ow.width + n.x)))
    assert.ok(world.towns.some((t) => reach[t.y * ow.width + t.x] === 0), 'gates must lock something')
  }
  const ruinsCheck = everyStep.find(({ s }) => s.op === 'ifBadges' && s.atLeast === world.badges.length)
  assert.ok(ruinsCheck, 'a gate checks for every badge')
})

test('quests: main + side quests, every quest can start and finish', () => {
  const ids = new Set<string>()
  for (const q of world.quests) { assert.ok(!ids.has(q.id), q.id); ids.add(q.id) }
  assert.equal(world.quests.filter((q) => q.kind === 'main').length, 1)
  assert.ok(world.quests.filter((q) => q.kind === 'side').length >= MIN_SIDE_QUESTS)
  const questSteps = everyStep.map(({ s }) => s).filter((s) => s.op === 'quest') as Extract<ScriptStep, { op: 'quest' }>[]
  for (const q of world.quests) {
    assert.ok(questSteps.some((s) => s.quest === q.id && !s.done), `${q.id} never started`)
    assert.ok(questSteps.some((s) => s.quest === q.id && s.done), `${q.id} never finished`)
    for (let i = 0; i < q.stages.length; i++) assert.ok(questSteps.some((s) => s.quest === q.id && s.stage === i), `${q.id} stage ${i} unused`)
    for (const st of q.stages) if (st.target) assert.ok(world.maps[st.target.map], `${q.id} target map`)
    for (const it of Object.keys(q.reward?.items ?? {})) assert.ok(CONTENT.items[it], `${q.id} reward ${it}`)
  }
  if (CONTENT.speciesList.length >= FULL_ROSTER) {
    for (const { s, n } of everyStep) {
      if (s.op !== 'ifCaught' || !s.type) continue
      const have = CONTENT.speciesList.filter((x) => x.types.includes(s.type!) && x.rarity !== 'MYTHIC').length
      assert.ok(have >= (s.atLeast ?? 1), `${n.id}: only ${have} catchable ${s.type} species`)
    }
  }
})

test('every town (and hamlet with services) has nurse, box terminal, clerk and villagers; shops and tutors are sound', () => {
  const townOf = (n: NpcDef & { map: string }) => {
    const m = world.maps[n.map]
    return m.regions[m.region[n.y * m.width + n.x]]?.townId
  }
  const storyTowns = world.towns.filter((t) => (t.kind ?? 'town') === 'town')
  const serviced = new Set(worldBuildInfo(world).features.hamlets.filter((h) => h.services).map((h) => h.id))
  assert.ok(serviced.size > 0, 'some hamlets have a centre and a shop')
  for (const t of [...storyTowns, ...world.towns.filter((x) => serviced.has(x.id))]) {
    const own = npcs.filter((n) => townOf(n) === t.id)
    const nurse = own.find((n) => n.role === 'nurse')
    assert.ok(nurse && allSteps(nurse).some((s) => s.op === 'heal') && allSteps(nurse).some((s) => s.op === 'setRespawn'), `${t.id} nurse`)
    const box = own.find((n) => n.role === 'boxTerminal')
    assert.ok(box && allSteps(box).some((s) => s.op === 'openBox'), `${t.id} box terminal`)
    const clerk = own.find((n) => n.role === 'clerk')
    assert.ok(clerk && allSteps(clerk).some((s) => s.op === 'shop'), `${t.id} clerk`)
    const villagers = own.filter((n) => n.role === 'villager' || n.role === 'questGiver' || n.role === 'tutor')
    if (!serviced.has(t.id)) assert.ok(villagers.length >= MIN_TOWN_VILLAGERS, `${t.id}: ${villagers.length} villagers`)
  }
  for (const { s, n } of everyStep) {
    if (s.op === 'shop') for (const it of s.items) assert.ok(CONTENT.items[it].buyable, `${n.id} sells unbuyable ${it}`)
  }
  const tutors = npcs.filter((n) => n.role === 'tutor')
  assert.ok(tutors.length >= MIN_TUTORS)
  for (const tu of tutors) {
    const steps = allSteps(tu)
    assert.ok(steps.some((s) => s.op === 'takeMoney'), `${tu.id} charges`)
    assert.ok(steps.some((s) => s.op === 'giveItem' && CONTENT.items[s.item].category === 'chip'), `${tu.id} teaches chips`)
  }
})

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** Populated NPCs per rule: [anchor name, npc] for every spot that received its rule's id. */
function populated(w: World): Map<string, [string, NpcDef & { map: string }][]> {
  const a = worldAnchors(w)
  const all = new Map(Object.values(w.maps).flatMap((m) => m.npcs.map((n) => [n.id, { ...n, map: m.id }] as const)))
  const out = new Map<string, [string, NpcDef & { map: string }][]>()
  for (const rule of STORY_CONTENT.population.rules) {
    if (rule.kind === 'services') continue
    const re = new RegExp(rule.anchors)
    const list: [string, NpcDef & { map: string }][] = []
    for (const name of Object.keys(a)) {
      const m = re.exec(name)
      if (!m) continue
      const id = (rule.idPattern ?? '{rule}-{slug}').replace(/\{(\w+)\}/g, (_, k: string) => (k === 'rule' ? rule.id : k === 'slug' ? slugOf(name) : m.groups?.[k] ?? ''))
      const n = all.get(id)
      if (n) list.push([name, n])
    }
    out.set(rule.id, list)
  }
  return out
}

/** Anchors claimed by legend chains and bounties (they run before the population rules). */
function storyClaimed(w: World): Set<string> {
  const f = storyFeatures(w)
  return new Set([...f.legends.flatMap((l) => [...l.tablets, l.final]), ...f.bounties.flatMap((b) => (b.target ? [b.giver, b.target] : [b.giver]))])
}

test('population: procedural spots get biome- and level-appropriate people', () => {
  const pop = STORY_CONTENT.population
  const byRule = populated(world)
  const cap = CONTENT.config.party.maxLevel
  const claimed = storyClaimed(world)
  for (const rule of pop.rules) {
    if (rule.kind === 'services') continue
    const re = new RegExp(rule.anchors)
    const spots = Object.keys(anchors).filter((k) => re.test(k) && !claimed.has(k))
    assert.ok(spots.length > 0, `${rule.id}: no anchor matches ${rule.anchors}`)
    const got = byRule.get(rule.id)!
    assert.ok(got.length > 0 && got.length >= Math.floor(MIN_POPULATION_FILL * (rule.share ?? 1) * spots.length), `${rule.id}: ${got.length} of ${spots.length} spots`)
    for (const [name, n] of got) {
      const a = anchors[name]
      assert.ok(n.map === a.map && n.x === a.x && n.y === a.y, `${n.id} not on ${name}`)
      const m = world.maps[n.map]
      const region = m.regions[m.region[n.y * m.width + n.x]]
      if (rule.kind === 'npc') {
        const arch = pop.npcPools[rule.pool!].filter((x) => x.sprite === n.sprite && (!x.biomes || x.biomes.includes(region.biome)))
        assert.ok(arch.length > 0, `${n.id}: no ${rule.pool} archetype with sprite ${n.sprite} fits biome ${region.biome}`)
        assert.ok(n.script.length > 0 && !n.trainer, `${n.id} says something`)
        continue
      }
      const t = world.trainers[n.trainer!]
      assert.ok(t && n.trainer === n.id, `${n.id} trainer`)
      const arch = pop.trainerPools[rule.pool!].find((x) => x.classZh === t.classZh && x.sprite === t.sprite)
      assert.ok(arch, `${n.id}: class ${t.classZh} not in pool ${rule.pool}`)
      assert.ok(!arch.biomes || arch.biomes.includes(region.biome), `${n.id}: ${t.classZh} out of its biomes in ${region.biome}`)
      const [sMin, sMax] = rule.sightRange ?? [0, 0]
      if (sMax === 0) assert.equal(n.sightRange, undefined, `${n.id} is talk-only`)
      else assert.ok(n.sightRange! >= sMin && n.sightRange! <= sMax, `${n.id} sight ${n.sightRange}`)
      const [pMin, pMax] = rule.party ?? [1, 1]
      assert.ok(t.party.length >= pMin && t.party.length <= pMax, `${n.id} party size ${t.party.length}`)
      const bonus = rule.levelBonus ?? 0
      const lo = Math.min(cap, region.levelRange![0] + bonus), hi = Math.min(cap, region.levelRange![1] + bonus)
      for (const p of t.party) assert.ok(p.level >= lo && p.level <= hi, `${n.id} level ${p.level} outside ${lo}-${hi}`)
      assert.equal(Math.max(...t.party.map((p) => p.level)), hi, `${n.id}: ace at the top of the spot's band`)
      assert.ok(t.party.some((p) => CONTENT.species[p.species!].types.some((ty) => arch.types.includes(ty))), `${n.id}: party off-theme`)
    }
  }
  assert.ok(byRule.get('wild-trainer')!.length >= MIN_WILD_TRAINERS, 'wild trainers')
})

test('population: every dungeon has a talk-only guardian with a one-time reward', () => {
  const dungeons = worldBuildInfo(world).features.dungeons
  assert.ok(dungeons.length > 0)
  for (const d of dungeons) {
    const boss = Object.keys(anchors).find((k) => k.startsWith(`dungeon:${d.id}:`) && k.endsWith(':boss'))
    assert.ok(boss, `${d.id}: boss anchor`)
    const a = anchors[boss]
    const n = npcs.find((x) => x.map === a.map && x.x === a.x && x.y === a.y)
    assert.ok(n && n.trainer && n.sightRange === undefined, `${d.id}: guardian on ${boss}`)
    const steps = allSteps(n)
    const give = steps.find((s) => s.op === 'giveItem') as Extract<ScriptStep, { op: 'giveItem' }> | undefined
    assert.ok(give && CONTENT.items[give.item], `${n.id} rewards an item`)
    assert.ok(steps.some((s) => s.op === 'ifFlag' && s.flag === `${STORY_CONTENT.meta.flags.trainerWon}${n.trainer}`), `${n.id} reward guarded by the win flag`)
  }
})

test('endgame: villains, champion and the one-time legend', () => {
  const boss = npcs.find((n) => n.sprite === 'villain_boss')
  assert.ok(boss && boss.trainer, 'villain boss placed')
  const champ = npcs.find((n) => n.role === 'champion')
  assert.ok(champ && champ.trainer)
  const ace = Math.max(...world.trainers[champ.trainer].party.map((p) => p.level))
  assert.ok(ace >= CHAMPION_ACE[0] && ace <= CHAMPION_ACE[1], `champion ace ${ace}`)
  // The main-story legend: the wildBattle of the NPC that sets the `legend` flag (legend chains are tested below).
  const setsLegend = (n: NpcDef) => allSteps(n).some((x) => x.op === 'setFlag' && x.flag === 'legend')
  const legend = everyStep.filter(({ s, n }) => s.op === 'wildBattle' && setsLegend(n))
  assert.ok(legend.length > 0)
  const mythic = CONTENT.speciesList.some((s) => s.rarity === 'MYTHIC')
  for (const { s, n } of legend) {
    const sp = CONTENT.species[(s as { species: string }).species]
    if (mythic) assert.equal(sp.rarity, 'MYTHIC', `${n.id} legend rarity`)
    // Guarded: the flag set after the battle is checked before it.
    const flags = allSteps(n).filter((x) => x.op === 'setFlag').map((x) => (x as { flag: string }).flag)
    assert.ok(flags.some((f) => allSteps(n).some((x) => x.op === 'ifFlag' && x.flag === f)), `${n.id}: legend not one-time`)
  }
  const species = new Set(legend.map(({ s }) => (s as { species: string }).species))
  assert.equal(species.size, 1, 'every path meets the same legend')
})

const npcAt = (name: string) => {
  const a = anchors[name]
  return a ? npcs.find((n) => n.map === a.map && n.x === a.x && n.y === a.y) : undefined
}
const regionOf = (n: { map: string; x: number; y: number }) => {
  const m = world.maps[n.map]
  return m.regions[m.region[n.y * m.width + n.x]]
}

test('legend chains: 3-5 landmark tablets read in order, then a hidden seer with a one-time rare encounter', () => {
  const lf = STORY_CONTENT.legends
  const placed = storyFeatures(world).legends
  assert.equal(placed.length, lf.chains.length, 'every chain fits the default seed')
  const pois = new Map(worldBuildInfo(world).features.pois.map((p) => [p.id, p]))
  const species = new Set<string>()
  for (const l of placed) {
    const chain = lf.chains.find((c) => c.id === l.id)!
    assert.ok(l.tablets.length >= Math.max(LEGEND_TABLETS[0], chain.steps[0]) && l.tablets.length <= Math.min(LEGEND_TABLETS[1], chain.steps[1]), `${l.id}: ${l.tablets.length} tablets`)
    const siteRe = new RegExp(chain.sites)
    const flags: string[] = []
    l.tablets.forEach((t, k) => {
      const poi = t.split(':')[1]
      assert.ok(siteRe.test(poi) && pois.get(poi) && !pois.get(poi)!.island, `${l.id} tablet ${k} on ${poi}`)
      const n = npcAt(t)
      assert.ok(n, `${l.id} tablet ${k} keeper`)
      const steps = allSteps(n)
      const flag = steps.find((s) => s.op === 'setFlag') as { flag: string } | undefined
      assert.ok(flag, `${l.id} tablet ${k} sets a flag`)
      flags.push(flag.flag)
      if (k > 0) assert.ok(steps.some((s) => s.op === 'ifFlag' && s.flag === flags[k - 1]), `${l.id} tablet ${k} requires tablet ${k - 1}`)
      assert.ok(steps.some((s) => s.op === 'quest' && s.quest === l.id && s.stage === k && !s.done), `${l.id} tablet ${k} advances the quest`)
      if (k > 0) {
        const d = Math.hypot(anchors[t].x - anchors[l.tablets[k - 1]].x, anchors[t].y - anchors[l.tablets[k - 1]].y)
        assert.ok(d <= lf.spacing[1] + 2 * WORLD_CONTENT.pois.templates[poi.replace(/-\d+$/, '')].radius + 2, `${l.id}: hop ${k} is ${Math.round(d)} tiles`)
      }
    })
    assert.ok(new RegExp(chain.final).test(l.final.split(':')[1]), `${l.id} final site`)
    const seer = npcAt(l.final)
    assert.ok(seer, `${l.id} seer`)
    assert.equal(seer.hiddenUnlessFlag, flags[flags.length - 1], `${l.id} seer appears once the last tablet is read`)
    const steps = allSteps(seer)
    const battle = steps.find((s) => s.op === 'wildBattle') as Extract<ScriptStep, { op: 'wildBattle' }> | undefined
    assert.ok(battle && CONTENT.species[battle.species!], `${l.id} encounter`)
    const pick = (chain.encounter.find((s) => s.op === 'wildBattle') as { pick?: { rarities?: string[] } }).pick
    if (pick?.rarities && CONTENT.speciesList.some((s) => pick.rarities!.includes(s.rarity))) {
      assert.ok(pick.rarities.includes(CONTENT.species[battle.species!].rarity), `${l.id} encounter rarity`)
    }
    assert.ok(battle.level > regionOf({ ...anchors[l.final] }).levelRange![1], `${l.id}: encounter Lv.${battle.level} above its region`)
    species.add(battle.species!)
    const set = steps.filter((s) => s.op === 'setFlag').map((s) => (s as { flag: string }).flag)
    assert.ok(set.some((f) => steps.some((s) => s.op === 'ifFlag' && s.flag === f)), `${l.id}: encounter not one-time`)
    const q = world.quests.find((x) => x.id === l.id)
    assert.ok(q && q.kind === 'side' && q.stages.length === l.tablets.length && q.stages.every((st) => st.target), `${l.id} quest`)
    assert.ok(steps.some((s) => s.op === 'quest' && s.quest === l.id && s.done), `${l.id} finishes its quest`)
  }
  assert.equal(species.size, placed.length, 'each chain ends in its own legend')
  const sites = placed.flatMap((l) => [...l.tablets, l.final].map((t) => t.split(':')[1]))
  assert.equal(new Set(sites).size, sites.length, 'chains never share a landmark')
  // Hamlet villagers can point at a chain start.
  assert.ok(everyStep.some(({ s }) => s.op === 'say' && placed.some((l) => s.text.includes(`「${worldBuildInfo(world).features.pois.find((p) => p.id === l.tablets[0].split(':')[1])!.nameZh}」`))), 'someone mentions a legend start')
})

test('bounties: 15+ template quests at hamlets and landmarks with partners, targets and rewards', () => {
  const bf = STORY_CONTENT.bounties
  const placed = storyFeatures(world).bounties
  assert.ok(placed.length >= MIN_BOUNTIES, `${placed.length} bounties`)
  assert.deepEqual(new Set(placed.map((b) => b.kind)), new Set(Object.keys(bf.kinds)), 'every bounty kind appears')
  const giverRes = bf.givers.map((g) => new RegExp(g))
  const walk = worldBuildInfo(world).walkReach
  const sites = new Set<string>()
  for (const b of placed) {
    const kind = bf.kinds[b.kind]
    assert.ok(giverRes.some((re) => re.test(b.giver)), `${b.quest} giver spot ${b.giver}`)
    const site = b.giver.split(':')[1]
    assert.ok(!sites.has(site), `${b.quest}: second bounty at ${site}`)
    sites.add(site)
    const giver = npcAt(b.giver)
    assert.ok(giver && giver.role === 'questGiver', `${b.quest} giver`)
    const gs = allSteps(giver)
    assert.ok(gs.some((s) => s.op === 'quest' && s.quest === b.quest && s.stage === 0 && !s.done), `${b.quest} giver starts the quest`)
    const q = world.quests.find((x) => x.id === b.quest)
    assert.ok(q && q.kind === 'side' && q.stages.length === kind.stages.length && q.stages.every((st) => st.target), `${b.quest} quest`)
    assert.ok((q.reward?.money ?? 0) > 0 && Object.keys(q.reward?.items ?? {}).every((it) => CONTENT.items[it]), `${b.quest} reward`)
    if (!kind.target) { assert.equal(b.target, undefined); continue }
    assert.ok(b.target && new RegExp(kind.targets!).test(b.target), `${b.quest} target ${b.target}`)
    const a = anchors[b.target], g = anchors[b.giver]
    assert.equal(a.map, ow.id)
    const d = Math.hypot(a.x - g.x, a.y - g.y)
    assert.ok(d >= bf.distance[0] && d <= bf.distance[1], `${b.quest} target distance ${Math.round(d)}`)
    assert.equal(walk[a.y * ow.width + a.x], 1, `${b.quest} target reachable on foot`)
    assert.ok(regionOf({ map: a.map, x: a.x, y: a.y }).levelRange![0] <= regionOf({ map: g.map, x: g.x, y: g.y }).levelRange![1] + bf.levelSlack, `${b.quest} target level`)
    const t = npcAt(b.target)
    assert.ok(t, `${b.quest} target npc`)
    if (kind.target === 'trainer') {
      assert.ok(t.trainer && t.sightRange === undefined, `${b.quest} target is a talk-only trainer`)
      assert.ok(gs.some((s) => s.op === 'ifFlag' && s.flag === `${STORY_CONTENT.meta.flags.trainerWon}${t.trainer}`), `${b.quest} giver checks the win`)
    } else {
      assert.ok(!t.trainer && allSteps(t).some((s) => s.op === 'quest' && s.quest === b.quest), `${b.quest} partner moves the quest`)
    }
  }
})

test('wild trainers: 150+, biome-themed parties and rewards scaled by danger tier', () => {
  const got = populated(world).get('wild-trainer')!
  assert.ok(got.length >= MIN_WILD_TRAINERS, `${got.length} wild trainers`)
  const rule = STORY_CONTENT.population.rules.find((r) => r.id === 'wild-trainer')!
  const mul = STORY_CONTENT.population.dangerReward
  let local = 0, members = 0
  const dangers = new Set<number>()
  for (const [, n] of got) {
    const region = regionOf(n)
    const danger = region.danger ?? 0
    dangers.add(danger)
    const t = world.trainers[n.trainer!]
    const ace = Math.max(...t.party.map((p) => p.level))
    assert.equal(t.reward, Math.round((rule.rewardPerLevel ?? STORY_CONTENT.meta.trainers.rewardPerLevel) * ace * mul[Math.min(mul.length - 1, danger)]), `${n.id} reward`)
    for (const p of t.party) { members++; if (CONTENT.species[p.species!].habitats.includes(region.biome)) local++ }
  }
  assert.ok(dangers.size >= 2, 'trainers across danger tiers')
  assert.ok(local / members >= 0.6, `only ${local}/${members} party members live in their spot's biome`)
})

test('hermit tutors teach level-appropriate chips; every nest has a guardian with a one-time gift', () => {
  const rule = STORY_CONTENT.population.rules.find((r) => r.id === 'hermit')!
  const got = populated(world).get('hermit')!
  assert.ok(got.length >= MIN_HERMITS, `${got.length} hermits`)
  for (const [, n] of got) {
    assert.equal(n.role, 'tutor')
    const steps = allSteps(n)
    const chips = steps.filter((s) => s.op === 'giveItem').map((s) => (s as { item: string }).item)
    const set = rule.paramSets!.find((ps) => Object.entries(ps.params).filter(([k]) => k.startsWith('chip')).every(([, c]) => chips.includes(c)))
    assert.ok(set && (set.minLevel ?? 0) <= regionOf(n).levelRange![0], `${n.id} offers chips of its level`)
    for (const s of steps) if (s.op === 'takeMoney') assert.ok(typeof s.amount === 'number' && s.amount > 0, `${n.id} price`)
  }
  const claimed = storyClaimed(world)
  const nests = Object.keys(anchors).filter((k) => /^poi:nest-\d+:spot:\d+$/.test(k) && !claimed.has(k))
  assert.ok(nests.length > 0)
  for (const k of nests) {
    const n = npcAt(k)
    assert.ok(n && n.trainer && n.sightRange === undefined, `${k}: guardian`)
    const steps = allSteps(n)
    assert.ok(steps.some((s) => s.op === 'giveItem' && CONTENT.items[s.item]), `${n.id} gift`)
    assert.ok(steps.some((s) => s.op === 'ifFlag' && s.flag === `${STORY_CONTENT.meta.flags.trainerWon}${n.trainer}`), `${n.id} gift is one-time`)
  }
})

test('hints: compass directions and nearest-place names are real', () => {
  const cfg = STORY_CONTENT.population.hints
  const features = worldBuildInfo(world).features
  const hi = new HintIndex(cfg, world, features)
  const o = { x: 100, y: 100 }
  const dirs = [[0, -10], [10, -10], [10, 0], [10, 10], [0, 10], [-10, 10], [-10, 0], [-10, -10]]
  dirs.forEach(([dx, dy], k) => assert.equal(hi.direction(o, { x: o.x + dx, y: o.y + dy }), cfg.directions[k]))
  assert.equal(hi.direction(o, { x: 103, y: 90 }), cfg.directions[0], 'shallow angles stay cardinal')
  assert.equal(hi.distance(o, { x: 100, y: 101 }), cfg.distances[0].text)
  // Nobody falls back to the "unknown place" text on the default seed.
  for (const { s, n } of everyStep) if (s.op === 'say') assert.ok(!s.text.includes(cfg.unknown), `${n.id}: "${s.text}"`)
  // Every hamlet guide points at a nest / dungeon / landmark / hamlet / town that exists.
  const names = [...features.pois.map((p) => p.nameZh), ...features.dungeons.map((d) => d.nameZh), ...features.hamlets.map((h) => h.nameZh), ...world.towns.map((t) => t.nameZh)]
  const guides = populated(world).get('hamlet-guide')!
  assert.ok(guides.length >= features.hamlets.length, `${guides.length} hamlet guides`)
  for (const [, n] of guides) {
    const says = allSteps(n).filter((s) => s.op === 'say').map((s) => (s as { text: string }).text)
    assert.ok(says.some((t) => names.some((nm) => t.includes(`「${nm}」`))), `${n.id} names no real place: ${says.join(' / ')}`)
  }
})

test('story layer is deterministic on a fresh copy and cheap on top of buildWorld', () => {
  const fresh: World = { ...world, trainers: {}, quests: [], maps: Object.fromEntries(Object.entries(world.maps).map(([k, m]) => [k, { ...m, npcs: [] }])) }
  const t0 = performance.now()
  applyStory(fresh)
  const ms = performance.now() - t0
  assert.deepEqual(storyProblems(fresh), [])
  assert.equal(storyDigest(fresh), storyDigest(world))
  assert.ok(ms < STORY_BUDGET_MS, `applyStory took ${Math.round(ms)} ms`)
})

test('applyStory is deterministic and works on another seed', () => {
  assert.equal(storyDigest(buildWorld()), storyDigest(world))
  const other = buildWorld(CONTENT.config.world.seed + 7)
  assert.deepEqual(storyProblems(other), [], storyProblems(other).join('\n'))
  assert.ok([...populated(other).values()].every((l) => l.length > 0), 'every rule populates the other seed too')
  const of = storyFeatures(other)
  assert.ok(of.bounties.length >= MIN_BOUNTIES && of.legends.length >= 1, `other seed: ${of.bounties.length} bounties, ${of.legends.length} legends`)
  // Permanent NPCs (authored + populated) never cut a town, hamlet or landmark off on the other seed either.
  const o = other.maps[other.startMap]
  const hidden = new Set(Object.values(other.maps).flatMap((m) => m.npcs).flatMap((n) => { const out: string[] = []; walkSteps(n.script, (s) => { if (s.op === 'hideNpc') out.push(s.npc) }); return out }))
  const blocked = new Set(o.npcs.filter((n) => !n.hiddenIfFlag && !hidden.has(n.id)).map((n) => n.y * o.width + n.x))
  const reach = floodReach(o, buildCollision(o), o.spawn.x, o.spawn.y, true, blocked)
  for (const t of other.towns) {
    if (t.map !== o.id) continue
    assert.ok([[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => reach[(t.y + dy) * o.width + t.x + dx] === 1), `${t.id} sealed on seed ${other.seed}`)
  }
})

test('applyStory reports bad story content instead of throwing', () => {
  const fresh: World = {
    ...world, trainers: {}, quests: [],
    maps: Object.fromEntries(Object.entries(world.maps).map(([k, m]) => [k, { ...m, npcs: [] }])),
  }
  const sc: StoryContent = {
    ...STORY_CONTENT,
    services: { ...STORY_CONTENT.services, npcs: [] },
    trainerGroups: { bad: { trainers: [{ id: 'x', nameZh: 'X', classZh: 'X', sprite: 'nope', party: [{ pick: {}, level: 5 }], introText: ['a'], defeatText: ['b'], at: 'no-such-anchor' }] } },
    npcGroups: {
      bad: [
        { id: 'n1', at: 'spawn', sprite: 'villager_kid', nameZh: 'N', role: 'villager', script: [{ op: 'battle', trainer: 'ghost' }, { op: 'include', script: 'missing' }, { op: 'say', text: '{item:ghost}' }] },
        { id: 'n1', at: 'town:origin:npc-1', sprite: 'villager_kid', nameZh: 'N', role: 'villager' },
      ],
    },
    quests: [],
    population: {
      ...STORY_CONTENT.population,
      rarityBands: [{ maxLevel: 100, rarities: ['NOPE'] }],
      rules: [
        { id: 'r-regex', kind: 'npc', anchors: '(unclosed', pool: 'hamlet' },
        { id: 'r-pool', kind: 'trainer', anchors: '^wild:', pool: 'no-such-pool' },
        { id: 'r-svc', kind: 'services', anchors: '^hamlet:[^:]+:center-door$' },
      ],
      npcPools: { hamlet: [{ sprite: 'ghost-sprite', names: [], dialogues: [[]] }] },
      trainerPools: { field: [{ classZh: 'X', sprite: 'trainer_hiker', names: ['x'], types: ['no-type'], introText: [['a']], defeatText: [['b']], after: ['c'] }] },
    },
  }
  applyStory(fresh, sc)
  const p = storyProblems(fresh).join('\n')
  for (const needle of [
    'unknown anchor "no-such-anchor"', 'unknown sprite "nope"', 'unknown trainer "ghost"', 'unknown script "missing"', 'unresolved text lookup {item:ghost}',
    'duplicate NPC id', 'arrival tile', 'bad anchors pattern "(unclosed"', 'unknown or empty trainer pool "no-such-pool"', 'needs a (?<town>…) group',
    'unknown rarity "NOPE"', 'unknown sprite "ghost-sprite"', 'no names', 'empty dialogue', 'unknown type "no-type"',
  ]) {
    assert.ok(p.includes(needle), `expected problem: ${needle}\n${p}`)
  }
})

// ---------------------------------------------------------------------------
// resolvePick on a synthetic roster
// ---------------------------------------------------------------------------

function synthetic(): Content {
  const base = CONTENT.speciesList[0]
  const mk = (id: string, dexNo: number, o: Partial<SpeciesDef>): SpeciesDef => ({
    ...base, id, dexNo, nameZh: id, nameEn: id, family: id, stage: 1, types: ['code'], rarity: 'N', country: 'US',
    evolvesTo: undefined, evolvesFrom: undefined, starter: undefined, ...o,
  })
  const list: SpeciesDef[] = [
    mk('a1', 1, { family: 'a', evolvesTo: { id: 'a2', level: 16 } }),
    mk('a2', 2, { family: 'a', stage: 2, evolvesFrom: 'a1', evolvesTo: { id: 'a3', level: 36 }, rarity: 'R' }),
    mk('a3', 3, { family: 'a', stage: 3, evolvesFrom: 'a2', rarity: 'SR' }),
    mk('b1', 4, { family: 'b', types: ['vision'], country: 'CN' }),
    mk('c1', 5, { family: 'c', types: ['vision'], rarity: 'R' }),
    mk('s1', 6, { family: 's', types: ['logic'], starter: true }),
    mk('u1', 7, { family: 'u', types: ['logic'], rarity: 'UR' }),
    mk('m1', 8, { family: 'm', types: ['chat'], rarity: 'MYTHIC' }),
  ]
  return { ...CONTENT, speciesList: list, species: Object.fromEntries(list.map((s) => [s.id, s])) }
}

test('resolvePick: filters, level-appropriate stage, determinism and fallbacks', () => {
  const c = synthetic()
  assert.equal(resolvePick({ types: ['code'] }, 5, 'k', c), 'a1')
  assert.equal(resolvePick({ types: ['code'] }, 20, 'k', c), 'a2')
  assert.equal(resolvePick({ types: ['code'] }, 50, 'k', c), 'a3')
  assert.equal(resolvePick({ families: ['a'], stages: [3] }, 5, 'k', c), 'a3', 'explicit stages are honoured')
  assert.equal(resolvePick({ types: ['vision'], countries: ['CN'] }, 5, 'k', c), 'b1')
  for (let i = 0; i < 20; i++) assert.equal(resolvePick({ types: ['vision'] }, 5, `k${i}`, c), resolvePick({ types: ['vision'] }, 5, `k${i}`, c))
  const seen = new Set(Array.from({ length: 40 }, (_, i) => resolvePick({ types: ['vision'], salt: String(i) }, 5, 'k', c)))
  assert.deepEqual([...seen].sort(), ['b1', 'c1'], 'salt spreads identical picks')
  // Starters, UR and MYTHIC are excluded by default and only chosen when asked for.
  for (let i = 0; i < 30; i++) assert.notEqual(resolvePick({ types: ['logic'] }, 5, `s${i}`, c), 's1')
  assert.equal(resolvePick({ types: ['logic'], rarities: ['UR'] }, 5, 'k', c), 'u1')
  assert.equal(resolvePick({ rarities: ['MYTHIC'] }, 70, 'k', c), 'm1')
  // Missing rarity widens to the nearest order; missing type relaxes last.
  assert.equal(resolvePick({ types: ['chat'], rarities: ['SSR'] }, 70, 'k', c), 'm1')
  assert.ok(c.species[resolvePick({ types: ['sound'] }, 5, 'k', c)])
  assert.equal(resolvePickAvoiding({ types: ['vision'] }, 5, 'k', new Set(['b1']), c), 'c1')
  assert.equal(resolvePickAvoiding({ types: ['vision'], rarities: ['N'] }, 5, 'k', new Set(['b1']), c), 'c1', 'widens one rarity before repeating')
  assert.equal(resolvePickAvoiding({ types: ['vision'] }, 5, 'k', new Set(['b1', 'c1']), c).length > 0, true)
  assert.throws(() => resolvePick({}, 5, 'k', { ...c, speciesList: [], species: {} }))
})
