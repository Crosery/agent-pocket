// Landmark roles on frontier POI / dungeon sites (landmarks.json + trainers.json guardians): guardians (strong
// trainers with a one-time prize), keepers (procedural inscriptions, a rumor clue for a hidden event and a map
// reveal of the place it points to), hermits (teach a move as a skill chip once you have caught enough of their
// type), rare merchants (time / weather gated stalls, local chips, valuable exchange), nest watchers (rarest local
// species, its spawn conditions, a research note) and the travellers 'visit' bounties send the player to.
// Roles and every trainer here are pure functions of (seed, site) — the id resolvers rebuild them from the id.
import type { EventCondition, NpcDef, ScriptStep, SpeciesDef, WorldEventDef } from '../../../types.ts'
import { CONTENT } from '../../../content/index.ts'
import { GAMEPLAY } from '../../../gameplay/data.ts'
import type { Rng } from '../../random.ts'
import type { ChunkDecorContext, DecorSite, FrontierLookup } from '../decorate.ts'
import type { SiteLayout } from '../layout.ts'
import type { FrontierSite } from '../sites.ts'
import { bountyPlans, hamletBounties, sitesAround, visitPartnerNpc } from './bounties.ts'
import { FRONTIER_PACK } from './data.ts'
import { localeOf, siteParams } from './hamlets.ts'
import { rumorCandidates, rumorGate, tellRumor, tipSteps, type Locale } from './people.ts'
import type { ChallengeRole, MerchantType, SiteChances } from './schema.ts'
import { classesFor, classTrainer, trainerNpc, trainerWonFlag, type TrainerBuild } from './teams.ts'
import {
  bearing, biomeName, curveAt, farness, findSpot, fitsProp, memo, pickLines, ringPoint, rollItem, say, sayAll, siteRngOf, spotOk, text, timeName,
  typeName, weatherName, type Params, type Pt,
} from './util.ts'

const chanceFor = (sites: SiteChances, site: FrontierSite): number => sites[site.template] ?? sites[site.kind.id] ?? 0

export interface SiteRoles { guardian: boolean; keeper: boolean; watcher: boolean; hermit: boolean; merchant: MerchantType | null }

/** Which roles a POI / dungeon site has (every roll is always drawn, so adding data never reshuffles others). */
export function siteRoles(seed: number, site: FrontierSite): SiteRoles {
  if (site.type === 'hamlet') return { guardian: false, keeper: false, watcher: false, hermit: false, merchant: null }
  return memo(seed, `roles:${site.id}`, () => {
    const T = FRONTIER_PACK.trainers.guardians, L = FRONTIER_PACK.landmarks
    const rng = siteRngOf(seed, site.id, 'roles')
    const g = rng.next(), k = rng.next(), w = rng.next(), h = rng.next(), m = rng.next()
    const types = L.merchant.types
    const mt = types.length ? rng.weighted(types, (x) => x.weight) : null
    return {
      guardian: site.dist >= T.minDistance && g < chanceFor(T.sites, site),
      keeper: k < chanceFor(L.keeper.sites, site),
      watcher: w < chanceFor(L.watcher.sites, site),
      hermit: site.dist >= L.hermit.minDistance && h < chanceFor(L.hermit.sites, site),
      merchant: site.dist >= L.merchant.minDistance && m < chanceFor(L.merchant.sites, site) ? mt : null,
    }
  })
}

const biomeOf = (ds: DecorSite): string => ds.region?.biome ?? CONTENT.biomes[ds.site.biome]?.id ?? ''

function bagFor(role: ChallengeRole, dist: number): Record<string, number> | undefined {
  let items: Record<string, number> | undefined
  for (const t of role.items) if (dist >= t.minDistance) items = t.items
  return items
}

function challengeBuild(seed: number, id: string, role: ChallengeRole, site: FrontierSite, params: Params, levelRange: [number, number], biome: string, title: string | null): TrainerBuild | null {
  const rng = siteRngOf(seed, id, 'trainer')
  const classes = classesFor(role.classes, biome, site.dist)
  if (!classes.length) return null
  const cls = rng.weighted(classes, (c) => c.weight)
  const b = classTrainer(id, cls, {
    biome, levelRange, dist: site.dist, types: cls.types, levelBonus: role.levelBonus + (cls.levelBonus ?? 0), sizeBonus: role.sizeBonus, rarity: role.rarity,
  }, rng, params, { aiLevel: role.aiLevel as 0 | 1 | 2 | 3, rewardMul: role.rewardMul, music: role.music, items: bagFor(role, site.dist) })
  if (title) b.def.classZh = text(title, { ...params, class: cls.classZh })
  return b.def.party.length ? b : null
}

export const guardianId = (site: FrontierSite): string => `${site.id}:guardian`
export const bossId = (site: FrontierSite): string => `${site.id}:boss`

/** The landmark guardian of a site (null when the site has none). */
export function guardianBuild(seed: number, look: FrontierLookup, site: FrontierSite): TrainerBuild | null {
  if (!siteRoles(seed, site).guardian) return null
  return memo(seed, `guardian:${site.id}`, () => {
    const G = FRONTIER_PACK.trainers.guardians
    const ds = look.decorSite(site)
    const params = { ...siteParams(ds), landmark: ds.layout.nameZh }
    return challengeBuild(seed, guardianId(site), G, site, params, ds.layout.levelRange, biomeOf(ds), G.titles[site.template] ?? G.titles.default ?? null)
  })
}

/** The boss waiting on a frontier dungeon's last floor (a function of the site layout only). */
export function bossBuild(seed: number, site: FrontierSite, layout: SiteLayout): TrainerBuild | null {
  if (site.type !== 'dungeon') return null
  return memo(seed, `boss:${site.id}`, () => {
    const floors = layout.dungeon?.floors ?? []
    const last = floors[floors.length - 1]
    if (!last) return null
    const params: Params = { place: layout.nameZh, landmark: layout.nameZh, biome: biomeName(last.biome), distance: Math.round(site.dist), level: last.levelRange[0], floors: floors.length }
    return challengeBuild(seed, bossId(site), FRONTIER_PACK.trainers.bosses, site, params, last.levelRange, last.biome, null)
  })
}

/** Talk -> accept the challenge -> battle -> one-time prize; afterwards the trainer's after-line. */
export function challengeScript(seed: number, role: ChallengeRole, b: TrainerBuild, dist: number): ScriptStep[] {
  const id = b.def.id
  const rng = siteRngOf(seed, id, 'prize')
  const prize = rollItem(role.prizes, dist, rng)
  const p: Params = { ...b.params, ...(prize ? { prize: prize.item, qty: prize.qty } : {}) }
  const win: ScriptStep[] = prize ? [say(role.prizeLine, p), { op: 'giveItem', item: prize.item, qty: prize.qty }] : []
  return [{
    op: 'ifFlag', flag: trainerWonFlag(id), then: [{ op: 'say', text: String(b.params.after ?? '') }],
    else: [{
      op: 'choice', text: text(role.challenge, p), options: role.options.slice(),
      branches: [[{ op: 'battle', trainer: id }, { op: 'ifFlag', flag: trainerWonFlag(id), then: win }], sayAll(pickLines(role.decline, rng), p)],
    }],
  }]
}

// ---------------------------------------------------------------------------------------------- keepers

const refsOfEvent = (def: WorldEventDef): string[] => [...(def.when.nearPlace ?? []), ...(def.when.anyOf ?? []).flatMap((c) => c.nearPlace ?? [])]
const siteRefs = (s: FrontierSite): string[] => [s.template, ...(FRONTIER_PACK.common.templateAliases[s.template] ?? [])]

function loreLines(rng: Rng, params: Params): string[] {
  const L = FRONTIER_PACK.landmarks.keeper.lore
  const n = rng.int(L.lines[0], L.lines[1])
  const out: string[] = []
  for (let k = 0; k < n && L.patterns.length; k++) {
    const pattern = rng.pick(L.patterns)
    out.push(text(pattern.replace(/\{(\w+)\}/g, (m, w: string) => (L.words[w]?.length ? rng.pick(L.words[w]) : m)), params))
  }
  return out
}

/** Rumor clue of a keeper: the hidden event tied to this kind of place (or the local biome) + where to go. */
function clueSteps(seed: number, look: FrontierLookup, ds: DecorSite, rng: Rng, params: Params): ScriptStep[] {
  const K = FRONTIER_PACK.landmarks.keeper.clue
  const own = siteRefs(ds.site)
  const loc: Locale = { biome: biomeOf(ds), dist: ds.site.dist, nearRefs: own }
  const [ev] = rumorCandidates(loc, 1, rng)
  const none = sayAll(pickLines(K.none, rng), params)
  if (!ev) return none
  const refs = refsOfEvent(ev)
  const where: ScriptStep[] = []
  if (refs.some((r) => own.includes(r))) where.push(say(K.here, params))
  else if (refs.length) {
    const target = sitesAround(look, ds.site, FRONTIER_PACK.landmarks.clueCells, (s) => s.type === 'poi' && siteRefs(s).some((r) => refs.includes(r)))[0]
    if (target) {
      const c = look.decorSite(target).layout.center
      const home = ds.layout.center
      where.push({ op: 'revealPlace', place: target.id }, say(K.reveal, { ...params, name: look.decorSite(target).layout.nameZh, dir: bearing(home, c), dist: farness(home, c) }))
    } else where.push(say(K.far, params))
  }
  return [...sayAll(pickLines(K.intro, rng), params), ...(rumorGate(ev, [...tellRumor(ev, params), ...where], none) ?? none)]
}

function keeperNpc(ctx: ChunkDecorContext, ds: DecorSite, at: Pt): NpcDef {
  const K = FRONTIER_PACK.landmarks.keeper
  const site = ds.site
  const rng = siteRngOf(ctx.seed, site.id, 'keeper')
  const name = rng.pick(K.names)
  const params = { ...siteParams(ds), landmark: ds.layout.nameZh, name }
  const lore = loreLines(rng, params)
  const script: ScriptStep[] = [
    ...sayAll(pickLines(K.intro, rng), params),
    ...lore.map((l) => ({ op: 'say', text: l }) as ScriptStep),
    ...clueSteps(ctx.seed, ctx.lookup, ds, rng, params),
    { op: 'setFlag', flag: text(FRONTIER_PACK.bounties.flags.scouted, { site: site.id }) },
  ]
  // Plaque with the inscription beside the keeper.
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, -1], [0, 1]]) {
    const x = at.x + dx, y = at.y + dy
    if (!lore.length || !fitsProp(ctx, x, y, 1, 1) || !spotOk(ctx, x, y, { neighbours: 2, spacing: 0 })) continue
    ctx.chunk.props.push({ prop: K.plaque.prop, x, y, rot: 0 })
    ctx.chunk.signs.push({ x, y, text: text(K.plaque.format, { ...params, lore: lore.join('\n') }), kind: 'plaque' })
    ctx.occupy(x, y)
    break
  }
  return { id: `${site.id}:keeper`, x: at.x, y: at.y, facing: 'down', sprite: rng.pick(K.sprites), nameZh: name, role: 'villager', script }
}

// ---------------------------------------------------------------------------------------------- hermits / merchants

interface ChipInfo { item: string; move: string; type: string; price: number }
let CHIPS: ChipInfo[] | null = null
function chips(): ChipInfo[] {
  if (CHIPS) return CHIPS
  CHIPS = []
  for (const it of CONTENT.itemList) {
    const move = (it.effect as { move?: string }).move
    if (it.effect.kind !== 'chip' || !move || !CONTENT.moves[move]) continue
    CHIPS.push({ item: it.id, move, type: CONTENT.moves[move].type, price: it.price })
  }
  return CHIPS
}

/** Types of the species living in a locale's habitats, weighted by how many species have them (sorted by id). */
function localTypes(biome: string): [string, number][] {
  const habitats = CONTENT.biomeById[biome]?.encounterHabitats ?? [biome]
  const counts = new Map<string, number>()
  for (const s of CONTENT.speciesList) if (s.habitats.some((h) => habitats.includes(h))) for (const ty of s.types) counts.set(ty, (counts.get(ty) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

function describeCondition(c: EventCondition): string {
  const P = FRONTIER_PACK.landmarks.watcher.parts
  const parts: string[] = []
  if (c.timeOfDay?.length) parts.push(text(P.time, { list: c.timeOfDay.map(timeName).join(P.joiner) }))
  if (c.weather?.length) parts.push(text(P.weather, { list: c.weather.map(weatherName).join(P.joiner) }))
  if (c.biomes?.length) parts.push(text(P.biomes, { list: c.biomes.map(biomeName).join(P.joiner) }))
  if (c.hourRange) parts.push(text(P.hours, { from: c.hourRange[0], to: c.hourRange[1] }))
  return parts.join(P.sep)
}

function typeTip(type: string, rng: Rng): string {
  const H = FRONTIER_PACK.landmarks.hermit
  const conds = (GAMEPLAY.spawn.typeConditions[type] ?? []).map(describeCondition).filter(Boolean)
  return conds.length ? text(H.tip, { type: typeName(type), when: rng.pick(conds) }) : ''
}

/** A hermit's persona + script (shared by landmark hermits and wild hermit camps). */
export function hermitPerson(npcId: string, loc: Locale, rng: Rng, params: Params): { sprite: string; name: string; script: ScriptStep[] } | null {
  const H = FRONTIER_PACK.landmarks.hermit
  const cap = curveAt(FRONTIER_PACK.landmarks.merchantStock.maxChipPrice, loc.dist)
  const types = localTypes(loc.biome).filter(([ty]) => chips().some((c) => c.type === ty))
  if (!types.length) return null
  const type = rng.weighted(types, (e) => e[1])[0]
  const ofType = chips().filter((c) => c.type === type)
  const affordable = ofType.filter((c) => c.price <= cap)
  const chip = rng.pick(affordable.length ? affordable : ofType)
  const need = Math.max(1, Math.round(curveAt(H.requirement, loc.dist)))
  const fee = Math.max(0, Math.round((chip.price * H.priceMul) / H.priceRound) * H.priceRound)
  const name = rng.pick(H.names)
  const p: Params = { ...params, name, type: typeName(type), title: text(H.title, { type: typeName(type) }), chip: chip.item, move: CONTENT.moves[chip.move].nameZh, count: need, fee }
  const flag = `${npcId}:taught`
  const tip = typeTip(type, rng)
  const script: ScriptStep[] = [
    ...sayAll(pickLines(H.intro, rng), p),
    {
      op: 'ifFlag', flag, then: sayAll(pickLines(H.after, rng), p),
      else: [{
        op: 'ifCaught', type, atLeast: need,
        then: [{
          op: 'choice', text: text(H.offer, p), options: H.options.slice(), branches: [
            [...(fee > 0 ? [{ op: 'takeMoney', amount: fee, failText: text(H.noMoney, p) } as ScriptStep] : []), { op: 'giveItem', item: chip.item, qty: 1 }, { op: 'setFlag', flag }, say(H.taught, p)],
            sayAll(pickLines(H.decline, rng), p),
          ],
        }],
        else: [say(H.notEnough, p)],
      }],
    },
    ...(tip ? [{ op: 'say', text: tip } as ScriptStep] : []),
  ]
  return { sprite: rng.pick(H.sprites), name, script }
}

function stockFor(type: MerchantType, loc: Locale, rng: Rng): string[] {
  const S = FRONTIER_PACK.landmarks.merchantStock
  const n = rng.int(type.count[0], type.count[1])
  if (type.stock === 'rare') {
    let items: string[] = []
    for (const t of S.rare) if (loc.dist >= t.minDistance) items = t.items
    return rng.shuffle(items.filter((id) => CONTENT.items[id])).slice(0, n)
  }
  const cap = curveAt(S.maxChipPrice, loc.dist)
  const out: string[] = []
  const types = localTypes(loc.biome)
  for (let k = 0; k < n && types.length; k++) {
    const [ty] = rng.weighted(types, (e) => e[1])
    const cs = rng.shuffle(chips().filter((c) => c.type === ty && c.price <= cap && !out.includes(c.item))).slice(0, S.chipsPerType)
    out.push(...cs.map((c) => c.item))
  }
  return out.slice(0, Math.max(n, S.chipsPerType))
}

/** A merchant's persona + script (rare stall / chip dealer / valuables exchange; optional time / weather gate). */
export function merchantPerson(type: MerchantType, loc: Locale, rng: Rng, params: Params): { sprite: string; name: string; script: ScriptStep[] } | null {
  const X = FRONTIER_PACK.landmarks.exchange
  const name = rng.pick(type.names)
  const p: Params = { ...params, name }
  let main: ScriptStep[]
  if (type.stock === 'exchange') {
    const vals = X.valuables.filter((id) => CONTENT.items[id])
    const prize = rollItem(X.prizes, loc.dist, rng)
    if (!vals.length || !prize) return null
    const v = rng.pick(vals)
    const q: Params = { ...p, give: v, prize: prize.item, qty: prize.qty }
    main = [...sayAll(pickLines(type.intro, rng), q), {
      op: 'ifItem', item: v,
      then: [{ op: 'choice', text: text(X.offer, q), options: X.options.slice(), branches: [[{ op: 'takeItem', item: v, qty: 1 }, { op: 'giveItem', item: prize.item, qty: prize.qty }, say(X.done, q)], sayAll(pickLines(type.outro, rng), q)] }],
      else: sayAll(pickLines(X.lacking, rng), q),
    }]
  } else {
    const items = stockFor(type, loc, rng)
    if (!items.length) return null
    main = [...sayAll(pickLines(type.intro, rng), p), { op: 'shop', items }, ...sayAll(pickLines(type.outro, rng), p)]
  }
  const closed = sayAll(pickLines(type.closed ?? [], rng), p)
  let script = main
  if (type.weathers?.length) script = [{ op: 'ifWeather', weather: type.weathers as NonNullable<EventCondition['weather']>, then: script, else: closed }]
  if (type.times?.length) script = [{ op: 'ifTime', times: type.times, then: script, else: closed }]
  return { sprite: rng.pick(type.sprites), name, script }
}

// ---------------------------------------------------------------------------------------------- watchers

function rarest(slots: readonly { species: string; rare?: boolean }[]): SpeciesDef | null {
  let best: SpeciesDef | null = null
  for (const s of slots) {
    const sp = CONTENT.species[s.species]
    if (!sp) continue
    const o = CONTENT.rarityById[sp.rarity]?.order ?? 0
    if (!best || o > (CONTENT.rarityById[best.rarity]?.order ?? 0) || (o === (CONTENT.rarityById[best.rarity]?.order ?? 0) && sp.id < best.id)) best = sp
  }
  return best
}

function watcherNpc(ctx: ChunkDecorContext, ds: DecorSite, at: Pt): NpcDef | null {
  const W = FRONTIER_PACK.landmarks.watcher
  const site = ds.site
  const region = ctx.lookup.region(`${site.id}:nest`) ?? ds.region
  const sp = rarest(region?.encounters ?? [])
  if (!sp) return null
  const rng = siteRngOf(ctx.seed, site.id, 'watcher')
  const id = `${site.id}:watcher`
  const name = rng.pick(W.names)
  const p: Params = { ...siteParams(ds), landmark: ds.layout.nameZh, name, species: sp.nameZh, rarity: CONTENT.rarityById[sp.rarity]?.nameZh ?? sp.rarity }
  const conds = (GAMEPLAY.spawn.speciesConditions[sp.id] ?? GAMEPLAY.spawn.typeConditions[sp.types[0]] ?? []).map(describeCondition).filter(Boolean)
  const flag = `${id}:notes`
  const script: ScriptStep[] = [
    ...sayAll(pickLines(W.intro, rng), p),
    say(W.rare, p),
    say(conds.length ? W.conditions : W.noConditions, { ...p, when: conds.length ? rng.pick(conds) : '' }),
    ...(rng.chance(W.tipChance) ? tipSteps(rng) : []),
    { op: 'ifFlag', flag, then: sayAll(pickLines(W.notesDone, rng), p), else: [say(W.notes, p), { op: 'research', species: sp.id, task: W.researchTask, amount: 1 }, { op: 'setFlag', flag }] },
  ]
  return { id, x: at.x, y: at.y, facing: 'down', sprite: rng.pick(W.sprites), nameZh: name, role: 'villager', script }
}

// ---------------------------------------------------------------------------------------------- decorator

type LRole = 'guardian' | 'keeper' | 'watcher' | 'hermit' | 'merchant'
const ROLE_ORDER: readonly LRole[] = ['guardian', 'keeper', 'watcher', 'hermit', 'merchant']

function anchorsOf(seed: number, ds: DecorSite, roles: SiteRoles): { role: LRole; at: Pt }[] {
  const L = ds.layout
  const rng = siteRngOf(seed, ds.site.id, 'landmark-anchors')
  let si = 0
  const out: { role: LRole; at: Pt }[] = []
  for (const r of ROLE_ORDER) {
    const at = si < L.spots.length ? L.spots[si++] : ringPoint(L.center, rng)
    if (r === 'merchant' ? roles.merchant : roles[r]) out.push({ role: r, at })
  }
  return out
}

export function decorateLandmarks(ctx: ChunkDecorContext): void {
  const P = FRONTIER_PACK.common.place
  for (const ds of ctx.sites) {
    const site = ds.site
    if (site.type === 'hamlet') continue
    const roles = siteRoles(ctx.seed, site)
    const loc = localeOf(ctx.seed, ctx.lookup, ds)
    const params: Params = { ...siteParams(ds), landmark: ds.layout.nameZh }
    for (const { role, at: anchor } of anchorsOf(ctx.seed, ds, roles)) {
      if (!ctx.inChunk(anchor.x, anchor.y)) continue
      const at = findSpot(ctx, anchor.x, anchor.y, P.search, { away: ctx.chunk.npcs })
      if (!at) continue
      let npc: NpcDef | null = null
      if (role === 'guardian') {
        const b = guardianBuild(ctx.seed, ctx.lookup, site)
        if (b) npc = trainerNpc(b.def, at.x, at.y, 'down', challengeScript(ctx.seed, FRONTIER_PACK.trainers.guardians, b, site.dist), 0)
      } else if (role === 'keeper') npc = keeperNpc(ctx, ds, at)
      else if (role === 'watcher') npc = watcherNpc(ctx, ds, at)
      else if (role === 'hermit') {
        const id = `${site.id}:hermit`
        const h = hermitPerson(id, loc, siteRngOf(ctx.seed, site.id, 'hermit'), params)
        if (h) npc = { id, x: at.x, y: at.y, facing: 'down', sprite: h.sprite, nameZh: h.name, role: 'tutor', script: h.script }
      } else if (role === 'merchant' && roles.merchant) {
        const m = merchantPerson(roles.merchant, loc, siteRngOf(ctx.seed, site.id, 'merchant'), params)
        if (m) npc = { id: `${site.id}:merchant`, x: at.x, y: at.y, facing: 'down', sprite: m.sprite, nameZh: m.name, role: 'clerk', script: m.script }
      }
      if (!npc) continue
      ctx.chunk.npcs.push(npc)
      ctx.occupy(at.x, at.y)
    }
    placeVisitPartners(ctx, ds)
  }
}

/** Travellers that 'visit' bounties of nearby hamlets send the player to. */
function placeVisitPartners(ctx: ChunkDecorContext, ds: DecorSite): void {
  const B = FRONTIER_PACK.bounties
  const site = ds.site
  for (const g of sitesAround(ctx.lookup, site, B.neighbourCells, (s) => s.type === 'hamlet')) {
    const plans = bountyPlans(ctx.seed, ctx.lookup, g).filter((p) => p.kind === 'visit' && p.dest?.id === site.id && p.anchor && ctx.inChunk(p.anchor.x, p.anchor.y))
    if (!plans.length) continue
    for (const b of hamletBounties(ctx.seed, ctx.lookup, g, ctx.overworldId)) {
      if (b.kind !== 'visit' || b.dest?.id !== site.id || !b.anchor || !b.partner || !ctx.inChunk(b.anchor.x, b.anchor.y)) continue
      const at = findSpot(ctx, b.anchor.x, b.anchor.y, FRONTIER_PACK.common.place.search, { away: ctx.chunk.npcs })
      if (!at) continue
      ctx.chunk.npcs.push(visitPartnerNpc(b, ctx.seed, at.x, at.y))
      ctx.occupy(at.x, at.y)
    }
  }
}
