// Acceptance checks for the generated roster (content/species.json, built by tools/data/build_species.py).
// Iterates CONTENT generically; the constants below are acceptance criteria, not game data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { CONTENT, typeEffectiveness, validateContent } from '../src/shared/content/index.ts'
import type { SpeciesDef, StatKey } from '../src/shared/types.ts'
import rules from '../tools/data/species_rules.json' with { type: 'json' }

const ROSTER_SIZE = 310
const STARTER_COUNT = 3
const LEARNSET_SIZE: [number, number] = [10, 16]
const LEVEL1_MOVES = 2
const TEACHABLE_SIZE: [number, number] = [4, 12]
const ABILITIES: [number, number] = [1, 2]
const STAT_KEYS: StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const list = CONTENT.speciesList
const byId = CONTENT.species
const within = (v: number, [lo, hi]: readonly number[]) => v >= lo && v <= hi
const bst = (s: SpeciesDef) => STAT_KEYS.reduce((n, k) => n + s.baseStats[k], 0)
/** Max multiplier any of a's types gets against b. */
const beats = (a: SpeciesDef, b: SpeciesDef) => Math.max(...a.types.map((t) => typeEffectiveness(t, b.types)))

test('roster validates and has the full researched size', () => {
  assert.deepEqual(validateContent(), [])
  assert.equal(list.length, ROSTER_SIZE)
  for (const s of list) assert.match(s.id, KEBAB, s.id)
})

test('dex numbers are 1..n and every family is contiguous', () => {
  assert.deepEqual(list.map((s) => s.dexNo), list.map((_, i) => i + 1))
  const closed = new Set<string>()
  list.forEach((s, i) => {
    const prev = list[i - 1]
    if (prev && prev.family !== s.family) closed.add(prev.family)
    assert.ok(!closed.has(s.family), `family ${s.family} split around #${s.dexNo}`)
  })
})

test('exactly three stage-1 starters forming a type triangle', () => {
  const starters = list.filter((s) => s.starter)
  assert.equal(starters.length, STARTER_COUNT)
  assert.deepEqual(new Set(starters.map((s) => s.id)), new Set(rules.starters))
  for (const s of starters) {
    assert.equal(s.stage, 1, `${s.id} stage`)
    assert.ok(!s.evolvesFrom, `${s.id} has a pre-evolution`)
    assert.ok(s.evolvesTo, `${s.id} should evolve`)
  }
  const [a, b, c] = starters
  const cycle = (x: SpeciesDef, y: SpeciesDef, z: SpeciesDef) =>
    beats(x, y) === 2 && beats(y, z) === 2 && beats(z, x) === 2 && beats(y, x) < 2 && beats(z, y) < 2 && beats(x, z) < 2
  assert.ok(cycle(a, b, c) || cycle(a, c, b), `starters ${starters.map((s) => s.types.join('/')).join(', ')} are not a triangle`)
})

test('evolution chains are consistent', () => {
  for (const s of list) {
    if (s.evolvesTo) {
      const to = byId[s.evolvesTo.id]
      assert.ok(to, `${s.id} -> missing ${s.evolvesTo.id}`)
      assert.equal(to.evolvesFrom, s.id, `${to.id}.evolvesFrom`)
      assert.equal(to.stage, s.stage + 1, `${to.id} stage`)
      assert.equal(to.family, s.family, `${to.id} family`)
      assert.ok(s.evolvesTo.level > 1 && s.evolvesTo.level <= CONTENT.config.party.maxLevel, `${s.id} evolve level`)
      assert.equal(s.evolvesTo.kind, 'post-training', `${s.id}: evolution should remain playable as post-training`)
      if (s.evolvesFrom) assert.ok(s.evolvesTo.level > byId[s.evolvesFrom].evolvesTo!.level, `${s.id}: evolve levels must increase`)
    }
    if (s.evolvesFrom) {
      const from = byId[s.evolvesFrom]
      assert.ok(from, `${s.id} <- missing ${s.evolvesFrom}`)
      assert.equal(from.evolvesTo?.id, s.id, `${from.id}.evolvesTo`)
    } else assert.equal(s.stage, 1, `${s.id}: stage ${s.stage} without a pre-evolution`)
  }
})

test('no evolution leads into a species that is only reachable through its MYTHIC chain', () => {
  const eventOnly = new Set(CONTENT.rarities.filter((r) => r.behavior?.spawn.length === 1 && r.behavior.spawn[0] === 'event').map((r) => r.id))
  assert.ok(eventOnly.size > 0, 'event-only rarity tier')
  for (const s of list) {
    if (s.evolvesTo) assert.ok(!eventOnly.has(byId[s.evolvesTo.id].rarity), `${s.id} -> ${s.evolvesTo.id} bypasses the hidden chain`)
  }
})

test('every evolved form is reachable from a stage-1 root of its family', () => {
  for (const s of list.filter((x) => x.stage > 1)) {
    const seen = new Set<string>()
    let cur = s
    while (cur.evolvesFrom && !seen.has(cur.id)) { seen.add(cur.id); cur = byId[cur.evolvesFrom] }
    assert.equal(cur.stage, 1, `${s.id}: root ${cur.id}`)
    assert.equal(cur.family, s.family, `${s.id}: root family`)
    assert.equal(seen.size, s.stage - 1, `${s.id}: chain depth`)
  }
})

test('learnsets: sorted, valid, unique, with level-1 moves', () => {
  for (const s of list) {
    const ls = s.learnset
    assert.ok(within(ls.length, LEARNSET_SIZE), `${s.id}: ${ls.length} entries`)
    for (let i = 1; i < ls.length; i++) assert.ok(ls[i].level >= ls[i - 1].level, `${s.id}: unsorted at ${i}`)
    for (const e of ls) {
      assert.ok(CONTENT.moves[e.move], `${s.id}: ${e.move}`)
      assert.ok(Number.isInteger(e.level) && e.level >= 0 && e.level <= CONTENT.config.party.maxLevel, `${s.id}: level ${e.level}`)
      if (e.level === 0) assert.ok(s.evolvesFrom, `${s.id}: evolution move without a pre-evolution`)
    }
    assert.equal(new Set(ls.map((e) => e.move)).size, ls.length, `${s.id}: duplicate learnset move`)
    const l1 = ls.filter((e) => e.level === 1).map((e) => CONTENT.moves[e.move])
    assert.ok(l1.length >= LEVEL1_MOVES, `${s.id}: ${l1.length} level-1 moves`)
    assert.ok(l1.some((m) => m.category !== 'status'), `${s.id}: no level-1 damaging move`)
    assert.ok(l1.some((m) => m.category === 'status'), `${s.id}: no level-1 status move`)
    for (const t of s.types) {
      assert.ok(ls.some((e) => CONTENT.moves[e.move].type === t && CONTENT.moves[e.move].category !== 'status'), `${s.id}: no ${t} STAB move`)
    }
  }
})

test('learnset power grows with level', () => {
  for (const s of list) {
    const dmg = s.learnset.map((e) => ({ level: e.level, power: CONTENT.moves[e.move].power })).filter((x) => x.power > 0)
    const half = Math.floor(dmg.length / 2)
    const mean = (xs: typeof dmg) => xs.reduce((n, x) => n + x.power, 0) / xs.length
    assert.ok(mean(dmg.slice(half)) > mean(dmg.slice(0, half)), `${s.id}: late moves not stronger`)
    assert.ok(Math.max(...dmg.map((x) => x.power)) > Math.max(...dmg.filter((x) => x.level === 1).map((x) => x.power), 0), `${s.id}: strongest move is a level-1 move`)
  }
})

test('pre-evolution learnset carries into the evolved form', () => {
  for (const s of list.filter((x) => x.evolvesFrom)) {
    const pre = byId[s.evolvesFrom!]
    const own = new Set(s.learnset.map((e) => e.move))
    for (const e of pre.learnset.filter((x) => x.level === 1)) assert.ok(own.has(e.move), `${s.id} lost ${pre.id}'s starting move ${e.move}`)
  }
})

test('teachables are chip moves the species is compatible with', () => {
  const chipMoves = new Set(CONTENT.itemList.flatMap((i) => (i.effect.kind === 'chip' ? [i.effect.move] : [])))
  const tr = rules.teachable as { compatByCategory: Record<string, string[]> }
  const lr = rules.learnset as { coverageByCategory: Record<string, string[]>; coverageByFamily: Record<string, string[]>; universalTypes: string[] }
  for (const s of list) {
    assert.ok(within(s.teachable.length, TEACHABLE_SIZE), `${s.id}: ${s.teachable.length} teachables`)
    assert.equal(new Set(s.teachable).size, s.teachable.length, `${s.id}: duplicate teachable`)
    const ok = new Set([...s.types, ...(tr.compatByCategory[s.category] ?? []), ...(lr.coverageByFamily[s.family] ?? lr.coverageByCategory[s.category] ?? []), ...lr.universalTypes])
    for (const m of s.teachable) {
      assert.ok(chipMoves.has(m), `${s.id}: ${m} has no chip`)
      assert.ok(ok.has(CONTENT.moves[m].type), `${s.id}: ${m} (${CONTENT.moves[m].type}) not compatible`)
    }
  }
})

test('stats, catch rates and numbers sit inside their rarity bands', () => {
  for (const s of list) {
    const r = CONTENT.rarityById[s.rarity]
    assert.ok(within(bst(s), r.bst), `${s.id}: BST ${bst(s)} outside ${s.rarity} ${r.bst}`)
    assert.ok(within(s.catchRate, r.catchRate), `${s.id}: catchRate ${s.catchRate} outside ${r.catchRate}`)
    assert.ok(within(s.abilities.length, ABILITIES) && new Set(s.abilities).size === s.abilities.length, `${s.id}: abilities`)
    assert.ok(s.baseExp > 0 && Number.isInteger(s.baseExp), `${s.id}: baseExp`)
    assert.ok(within(s.size, [rules.size.min, rules.size.max]), `${s.id}: size ${s.size}`)
    assert.ok(s.habitats.length > 0, `${s.id}: no habitat`)
    assert.ok(s.dexEntry && s.personality && s.designPrompt && s.releaseDate && s.company && s.country, `${s.id}: missing text`)
  }
})

test('evolution lowers catch rate and raises base exp; growth is family-wide', () => {
  for (const s of list.filter((x) => x.evolvesTo)) {
    const to = byId[s.evolvesTo!.id]
    assert.ok(to.catchRate < s.catchRate, `${to.id} catchRate ${to.catchRate} >= ${s.id} ${s.catchRate}`)
    assert.ok(to.baseExp > s.baseExp, `${to.id} baseExp`)
    assert.equal(to.growth, s.growth, `${to.id} growth differs from ${s.id}`)
  }
})

let python = true
try { execFileSync('python3', ['--version'], { stdio: 'ignore' }) } catch { python = false }
test('content/species.json and docs/roster.md are in sync with the generator', { skip: !python && 'python3 unavailable' }, () => {
  execFileSync('python3', [new URL('../tools/data/build_species.py', import.meta.url).pathname, '--check'], { stdio: 'pipe' })
})
