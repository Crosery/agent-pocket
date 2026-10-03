import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import type { MapChunk, NpcDef, ScriptStep, TrainerDef, World } from '../src/shared/types.ts'
import { buildWorld, worldBuildInfo } from '../src/shared/world/index.ts'
import { collisionField, getMap } from '../src/shared/world/worldapi.ts'
import { COLLISION_FREE } from '../src/shared/world/collision.ts'
import { FrontierProvider } from '../src/shared/world/frontier/provider.ts'
import { formAtLevel } from '../src/shared/gameplay/picks.ts'
import {
  FRONTIER_PACK, bountyPlans, chunkTrainers, frontierPlaceRefs, frontierQuest, frontierTrainer, hamletBounties, lookupOf, registerFrontierRefs,
  restoreFrontierQuests, siteRoles, validateFrontierPack,
} from '../src/shared/world/frontier/content/index.ts'
import type { FrontierSite } from '../src/shared/world/frontier/sites.ts'

const world = buildWorld()
const ow = world.maps[world.startMap]
const P = ow.infinite as FrontierProvider
const S = P.size
const gates = worldBuildInfo(world).features.gates
const fresh = () => new FrontierProvider({ seed: world.seed, overworldId: ow.id, core: ow, gates, origin: { x: ow.spawn.x, y: ow.spawn.y }, corePlaces: () => world.towns })
/** A second world sharing nothing with `world` but the seed (resolvers must rebuild everything from ids). */
const otherWorld = (): World => buildWorld()

// Sample: 7x7 chunks around every causeway gateway + a far-frontier block (danger tiers 3+).
const near: [number, number][] = []
for (const g of gates) {
  const cx = Math.floor(g.x / S), cy = Math.floor(g.y / S)
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (!P.inCoreChunk(cx + dx, cy + dy)) near.push([cx + dx, cy + dy])
}
const far: [number, number][] = []
for (let cy = 70; cy < 76; cy++) for (let cx = 60; cx < 66; cx++) far.push([cx, cy])
const sample = [...new Map([...near, ...far].map((k) => [k.join(','), k])).values()]

const chunks = new Map<string, MapChunk>()
for (const [cx, cy] of sample) chunks.set(`${cx},${cy}`, P.chunk(cx, cy))
const allNpcs = (): NpcDef[] => [...chunks.values()].flatMap((c) => c.npcs)

function walk(steps: readonly ScriptStep[], visit: (s: ScriptStep) => void): void {
  for (const s of steps) {
    visit(s)
    if (s.op === 'choice') for (const b of s.branches) walk(b, visit)
    else if ('then' in s) { walk(s.then, visit); if (s.else) walk(s.else, visit) }
  }
}

function contentDigest(ch: MapChunk): string {
  return JSON.stringify([ch.npcs, ch.signs, ch.items, ch.props, chunkTrainers(ch)])
}

test('content pack validates and is wired into validateWorldContent', () => {
  assert.deepEqual(validateFrontierPack(), [])
  assert.ok(FRONTIER_PACK.trainers.classes.length >= 20, 'trainer classes')
  assert.ok(FRONTIER_PACK.villagers.archetypes.length >= 12, 'villager archetypes')
})

test('frontier content is deterministic and independent of generation order', () => {
  const q = fresh()
  const order = sample.slice().reverse()
  // Touch far-away chunks first so caches / memo state differ from P.
  q.chunk(-90, -90); q.chunk(120, 40)
  for (const [cx, cy] of order) {
    const a = chunks.get(`${cx},${cy}`)!
    const b = q.chunk(cx, cy)
    assert.equal(contentDigest(b), contentDigest(a), `chunk ${cx},${cy}`)
    assert.equal(contentDigest(q.generate(cx, cy)), contentDigest(a), `uncached chunk ${cx},${cy}`)
  }
})

test('frontier NPCs and items stand on free tiles and never share one', (t) => {
  const field = collisionField(ow)
  let npcs = 0
  for (const ch of chunks.values()) {
    const taken = new Map<string, string>()
    for (const n of ch.npcs) {
      npcs++
      const k = `${n.x},${n.y}`
      assert.equal(field.at(n.x, n.y), COLLISION_FREE, `npc ${n.id} on a free tile`)
      assert.ok(!taken.has(k), `npc ${n.id} shares ${k} with ${taken.get(k)}`)
      taken.set(k, n.id)
      // At least one walkable neighbour so the player can reach / talk to it.
      const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => field.at(n.x + dx, n.y + dy) === COLLISION_FREE).length
      assert.ok(open >= 1, `npc ${n.id} boxed in`)
    }
    for (const it of ch.items) {
      assert.equal(field.at(it.x, it.y), COLLISION_FREE, `item ${it.id} on a free tile`)
      assert.ok(!taken.has(`${it.x},${it.y}`), `item ${it.id} under an npc`)
    }
    for (const s of ch.signs) assert.ok(!taken.has(`${s.x},${s.y}`), `sign at ${s.x},${s.y} under an npc`)
    const ids = ch.npcs.map((n) => n.id)
    assert.equal(new Set(ids).size, ids.length, 'npc ids unique in a chunk')
  }
  t.diagnostic(`${chunks.size} chunks, ${npcs} npcs, ${[...chunks.values()].reduce((a, c) => a + c.items.length, 0)} items, ${[...chunks.values()].reduce((a, c) => a + c.signs.length, 0)} signs`)
  assert.ok(npcs > 50, `frontier npcs in the sample: ${npcs}`)
  const ids = allNpcs().map((n) => n.id)
  assert.equal(new Set(ids).size, ids.length, 'npc ids unique across chunks')
})

function checkTrainer(t: TrainerDef, where: string): void {
  const max = CONTENT.config.party.maxLevel
  assert.ok(t.party.length >= 1 && t.party.length <= CONTENT.config.party.maxParty, `${where}: party size ${t.party.length}`)
  assert.ok(CONTENT.characterById[t.sprite], `${where}: sprite ${t.sprite}`)
  assert.ok(t.aiLevel >= 0 && t.aiLevel <= 3, `${where}: aiLevel`)
  assert.ok(t.reward > 0, `${where}: reward`)
  assert.ok(t.introText.length && t.defeatText.length, `${where}: intro / defeat texts`)
  for (const s of [...t.introText, ...t.defeatText]) assert.ok(!/\{\w+\}/.test(s), `${where}: unformatted "${s}"`)
  assert.ok(!t.classZh.includes('{') && !t.nameZh.includes('{'), `${where}: names formatted`)
  const species = new Set<string>()
  for (const p of t.party) {
    const sp = CONTENT.species[p.species!]
    assert.ok(sp, `${where}: species ${p.species}`)
    assert.ok(p.level >= 1 && p.level <= max, `${where}: level ${p.level}`)
    assert.equal(formAtLevel(sp, p.level).id, sp.id, `${where}: ${sp.id} is the legal form at Lv.${p.level}`)
    assert.ok(!['UR', 'MYTHIC'].includes(sp.rarity), `${where}: no legend in a trainer team (${sp.id})`)
    assert.ok(!sp.starter, `${where}: no starter`)
    assert.ok(!species.has(sp.id), `${where}: duplicate ${sp.id}`)
    species.add(sp.id)
  }
  for (const id of Object.keys(t.items ?? {})) assert.ok(CONTENT.items[id], `${where}: bag item ${id}`)
}

test('every trainer / quest / item referenced by frontier NPCs resolves and is valid', (t) => {
  let trainers = 0, quests = 0
  for (const n of allNpcs()) {
    const refs: { kind: 'trainer' | 'quest'; id: string }[] = []
    if (n.trainer) refs.push({ kind: 'trainer', id: n.trainer })
    walk(n.script, (s) => {
      if (s.op === 'battle') refs.push({ kind: 'trainer', id: s.trainer })
      if (s.op === 'quest') refs.push({ kind: 'quest', id: s.quest })
      if (s.op === 'giveItem' || s.op === 'takeItem' || s.op === 'ifItem') assert.ok(CONTENT.items[s.item], `${n.id}: item ${s.item}`)
      if (s.op === 'shop') for (const it of s.items) assert.ok(CONTENT.items[it], `${n.id}: shop item ${it}`)
      if (s.op === 'say') assert.ok(!/\{(?!day\}|year\})\w+\}/.test(s.text), `${n.id}: unformatted text "${s.text}"`)
      if (s.op === 'research') assert.ok(CONTENT.species[s.species], `${n.id}: research species`)
      if (s.op === 'ifCaught' && s.type) assert.ok(CONTENT.typeById[s.type], `${n.id}: type ${s.type}`)
    })
    for (const r of refs) {
      if (r.kind === 'trainer') {
        if (world.trainers[r.id] && !r.id.includes(':')) continue
        const t = frontierTrainer(world, r.id)
        assert.ok(t, `${n.id}: trainer ${r.id} resolves`)
        checkTrainer(t!, r.id)
        trainers++
      } else if (r.id.includes(':bounty-')) {
        const q = frontierQuest(world, r.id)
        assert.ok(q && q.stages.length >= 1 && q.reward, `${n.id}: quest ${r.id} resolves`)
        quests++
      }
    }
  }
  t.diagnostic(`trainer refs checked ${trainers}, bounty refs ${quests}`)
  assert.ok(trainers > 20, `frontier trainers checked: ${trainers}`)
  assert.ok(quests > 5, `frontier quests checked: ${quests}`)
})

test('resolvers rebuild trainers and quests from ids alone (fresh world, nothing loaded)', () => {
  const w2 = otherWorld()
  let n = 0
  for (const npc of allNpcs()) {
    if (!npc.trainer || !npc.trainer.includes(':')) continue
    const a = frontierTrainer(world, npc.trainer)
    const b = frontierTrainer(w2, npc.trainer)
    assert.deepEqual(b, a, `trainer ${npc.trainer}`)
    n++
  }
  assert.ok(n > 10)
  // Quest log restore after a reload.
  const started = Object.fromEntries(world.quests.filter((q) => q.id.includes(':bounty-')).map((q) => [q.id, { stage: 0, done: false }]))
  const w3 = otherWorld()
  assert.equal(restoreFrontierQuests(w3, { quests: started }), Object.keys(started).length)
  for (const id of Object.keys(started)) assert.deepEqual(w3.quests.find((q) => q.id === id), world.quests.find((q) => q.id === id))
  assert.ok(registerFrontierRefs(w3, allNpcs()) > 0)
})

function hamletsInSample(): FrontierSite[] {
  const out = new Map<string, FrontierSite>()
  for (const [cx, cy] of sample) for (const s of P.grid.sitesNear(cx * S, cy * S, (cx + 1) * S, (cy + 1) * S, 0)) if (s.type === 'hamlet') out.set(s.id, s)
  return [...out.values()]
}

test('bounties link givers, couriers, outlaws and travellers across chunks', (t) => {
  const look = lookupOf(P)
  const npcIn = (x: number, y: number, r: number, id: string): boolean => {
    for (let cy = Math.floor((y - r) / S); cy <= Math.floor((y + r) / S); cy++) for (let cx = Math.floor((x - r) / S); cx <= Math.floor((x + r) / S); cx++) {
      if (P.chunk(cx, cy).npcs.some((n) => n.id === id)) return true
    }
    return false
  }
  const kinds: Record<string, number> = {}
  let checked = 0, linked = 0, givers = 0, placedGivers = 0
  for (const site of hamletsInSample()) {
    for (const b of hamletBounties(world.seed, look, site, ow.id)) {
      kinds[b.kind] = (kinds[b.kind] ?? 0) + 1
      assert.ok(!b.nameZh.includes('{') && b.giver.name, `${b.id}: name / giver`)
      if (b.quest) for (const st of b.quest.stages) assert.ok(!/\{\w+\}/.test(st.text), `${b.id}: stage text "${st.text}"`)
      const R = P.decorSite(site).layout
      if (b.kind === 'deliver') {
        checked++
        const dest = P.decorSite(b.dest!).layout.center
        const courierId = `${b.dest!.id}:courier`
        let found = false
        for (let cy = Math.floor((dest.y - 24) / S); cy <= Math.floor((dest.y + 24) / S) && !found; cy++) for (let cx = Math.floor((dest.x - 24) / S); cx <= Math.floor((dest.x + 24) / S) && !found; cx++) {
          const c = P.chunk(cx, cy).npcs.find((n) => n.id === courierId)
          if (!c) continue
          walk(c.script, (s) => { if (s.op === 'quest' && s.quest === b.id && s.done) found = true })
        }
        if (found) linked++
      } else if (b.kind === 'hunt') {
        checked++
        if (npcIn(b.anchor!.x, b.anchor!.y, 8, b.outlaw!.def.id)) linked++
      } else if (b.kind === 'visit') {
        checked++
        if (npcIn(b.anchor!.x, b.anchor!.y, 8, `${b.id}:partner`)) linked++
      }
      givers++
      if (npcIn(R.center.x, R.center.y, 24, `${b.id}:giver`)) placedGivers++
    }
  }
  t.diagnostic(`bounties ${JSON.stringify(kinds)}, cross-site targets placed ${linked}/${checked}, givers ${placedGivers}/${givers}`)
  assert.ok(checked >= 4, `cross-site bounties sampled: ${checked} ${JSON.stringify(kinds)}`)
  assert.equal(linked, checked, 'every deliver courier / outlaw / traveller of a cross-site bounty is placed')
  assert.equal(placedGivers, givers, 'every bounty has a giver standing in its hamlet')
  // The cheap plan pass and the full pass agree (full bounties are a subset of the plans, same order).
  for (const site of hamletsInSample()) {
    const plans = bountyPlans(world.seed, look, site).map((p) => p.id)
    const full = hamletBounties(world.seed, look, site, ow.id).map((b) => b.id)
    assert.deepEqual(full, plans.filter((id) => full.includes(id)))
  }
})

test('trainer strength and rarity scale with distance from the origin', (t) => {
  const stats = (pts: [number, number][]) => {
    let ace = 0, n = 0, size = 0, rare = 0, members = 0
    for (const [cx, cy] of pts) for (const t of chunkTrainers(chunks.get(`${cx},${cy}`)!)) {
      n++
      ace += Math.max(...t.party.map((p) => p.level))
      size += t.party.length
      for (const p of t.party) { members++; if (['SR', 'SSR'].includes(CONTENT.species[p.species!].rarity)) rare++ }
    }
    return { n, ace: ace / Math.max(1, n), size: size / Math.max(1, n), rare: rare / Math.max(1, members) }
  }
  const a = stats(near), b = stats(far)
  t.diagnostic(`near ${JSON.stringify(a)} far ${JSON.stringify(b)}`)
  assert.ok(a.n > 5 && b.n > 5, `wanderers near ${a.n} / far ${b.n}`)
  assert.ok(b.ace > a.ace + 10, `ace level near ${a.ace.toFixed(1)} -> far ${b.ace.toFixed(1)}`)
  assert.ok(b.size > a.size, `party size near ${a.size.toFixed(2)} -> far ${b.size.toFixed(2)}`)
  assert.ok(b.rare > a.rare, `SR/SSR share near ${a.rare.toFixed(2)} -> far ${b.rare.toFixed(2)}`)
})

test('landmark roles, dungeon bosses, residents and place refs', (t) => {
  let guardians = 0, bosses = 0, residents = 0
  const sites = new Map<string, FrontierSite>()
  for (const [cx, cy] of sample) for (const s of P.grid.sitesNear(cx * S, cy * S, (cx + 1) * S, (cy + 1) * S, 0)) sites.set(s.id, s)
  for (const s of sites.values()) {
    const r = siteRoles(world.seed, s)
    if (r.guardian) {
      const t = frontierTrainer(world, `${s.id}:guardian`)
      if (t) { checkTrainer(t, `${s.id}:guardian`); guardians++ }
    }
    if (s.type === 'dungeon') {
      const plan = P.decorSite(s).layout.dungeon
      if (!plan) continue
      const last = getMap(world, plan.floors[plan.floors.length - 1].id)!
      const boss = last.npcs.find((n) => n.id === `${s.id}:boss`)
      assert.ok(boss, `${s.id}: boss on the last floor`)
      assert.equal(collisionField(last).at(boss!.x, boss!.y), COLLISION_FREE)
      checkTrainer(frontierTrainer(world, boss!.trainer!)!, boss!.id)
      bosses++
    }
    if (s.type === 'hamlet') {
      for (const d of P.decorSite(s).layout.doors) {
        const m = getMap(world, d.mapId)
        for (const n of m?.npcs ?? []) if (n.id.endsWith(':resident')) { residents++; assert.ok(n.script.length >= 1) }
      }
    }
    if (s.type === 'poi') assert.ok(frontierPlaceRefs(world, s.id).includes(`${s.template}-${s.id}`))
  }
  t.diagnostic(`guardians ${guardians}, bosses ${bosses}, residents ${residents}`)
  assert.ok(guardians >= 1, `guardians ${guardians}`)
  assert.ok(bosses >= 1, `dungeon bosses ${bosses}`)
  assert.ok(residents >= 1, `residents ${residents}`)
})

test('rumors and clues use gameplay-core flags; hermits / merchants trade real items', (t) => {
  let rumors = 0, clues = 0, chips = 0, shops = 0
  for (const n of allNpcs()) {
    walk(n.script, (s) => {
      if (s.op === 'setFlag' && s.flag.startsWith('rumor:')) rumors++
      if (s.op === 'revealPlace') { clues++; assert.ok(P.place(s.place), `${n.id}: reveals a real place ${s.place}`) }
      if (s.op === 'giveItem' && CONTENT.items[s.item]?.category === 'chip') chips++
      if (s.op === 'shop') shops++
    })
  }
  t.diagnostic(`rumor tells ${rumors}, reveals ${clues}, chip gifts ${chips}, shops ${shops}`)
  assert.ok(rumors >= 3, `rumor tells ${rumors}`)
  assert.ok(chips >= 1, `chip teachers / prizes ${chips}`)
  assert.ok(shops >= 1 || clues >= 1, `merchants ${shops}, reveals ${clues}`)
})
