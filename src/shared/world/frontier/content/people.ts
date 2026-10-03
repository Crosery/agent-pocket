// Frontier people: villager / resident dialogue built from villagers.json archetypes, biome and distance lines,
// gossip that hands out gameplay-core rumors (setting their `rumor:<event>` flags, gated like availableRumors),
// sages with MYTHIC chain clues (nested on the chain's step flags), rarity / type behaviour tips derived from
// rarities.json and events/spawn.json, and one-time gifts.
import type { ScriptStep, WorldEventDef } from '../../../types.ts'
import { CONTENT, t } from '../../../content/index.ts'
import { GAMEPLAY } from '../../../gameplay/data.ts'
import { eventParams, rumorFlag } from '../../../gameplay/events.ts'
import type { Rng } from '../../random.ts'
import { FRONTIER_PACK } from './data.ts'
import type { Lines, VillagerArchetype } from './schema.ts'
import { gated, personName, pickLines, rollItem, sayAll, text, timeName, typeName, weatherName, type Params } from './util.ts'

export interface Locale {
  /** Region biome id. */
  biome: string
  dist: number
  /** Place refs nearby (site templates + aliases) for rumor weighting. */
  nearRefs: readonly string[]
}

const rumorText = (def: WorldEventDef): string => t(def.rumor!, eventParams(def))

/** The rumor tell: first time sets the flag, later repeats with the "heard" prefix. */
export function tellRumor(def: WorldEventDef, params: Params): ScriptStep[] {
  const G = FRONTIER_PACK.villagers.gossip
  const flag = rumorFlag(def.id)
  const said = rumorText(def)
  return [{ op: 'ifFlag', flag, then: [{ op: 'say', text: text(G.heard, { ...params, rumor: said }) }], else: [{ op: 'say', text: said }, { op: 'setFlag', flag }] }]
}

/** Condition under which a rumor may be told (rumorWhen, else the event's progress gates; rumor flags ignored). */
export function rumorGate(def: WorldEventDef, then: ScriptStep[], otherwise: ScriptStep[]): ScriptStep[] | null {
  return gated(def.rumorWhen ?? def.when, then, otherwise, GAMEPLAY.spawn.rumor.flagPrefix)
}

const refsOf = (def: WorldEventDef): string[] => [...(def.when.nearPlace ?? []), ...(def.when.anyOf ?? []).flatMap((c) => c.nearPlace ?? [])]

/** Weighted rumor candidates for a locale (tags from villagers.json gossip.tagWeights). */
export function rumorCandidates(loc: Locale, count: number, rng: Rng, filter?: (d: WorldEventDef) => boolean): WorldEventDef[] {
  const G = FRONTIER_PACK.villagers.gossip
  const habitats = CONTENT.biomeById[loc.biome]?.encounterHabitats ?? []
  const pool: { def: WorldEventDef; w: number }[] = []
  for (const def of GAMEPLAY.events) {
    if (!def.rumor || !def.tag || (filter && !filter(def))) continue
    let w = G.tagWeights[def.tag] ?? 0
    if (w <= 0) continue
    const bs = def.when.biomes ?? []
    if (bs.includes(loc.biome) || habitats.some((h) => bs.includes(h))) w *= G.biomeMatch
    if (refsOf(def).some((r) => loc.nearRefs.includes(r))) w *= G.placeMatch
    if (def.when.minDistance !== undefined && loc.dist < def.when.minDistance) continue
    if (!rumorGate(def, [], [])) continue
    pool.push({ def, w })
  }
  const out: WorldEventDef[] = []
  while (out.length < count && pool.length) {
    const p = rng.weighted(pool, (x) => x.w)
    out.push(p.def)
    pool.splice(pool.indexOf(p), 1)
  }
  return out
}

/** Gossip block: the first candidate whose gate holds is told, otherwise a "nothing new" line. */
export function gossipSteps(loc: Locale, rng: Rng, params: Params): ScriptStep[] {
  const G = FRONTIER_PACK.villagers.gossip
  const cands = rumorCandidates(loc, G.candidates, rng)
  let acc: ScriptStep[] = sayAll(pickLines(G.none, rng), params)
  for (let i = cands.length - 1; i >= 0; i--) acc = rumorGate(cands[i], tellRumor(cands[i], params), acc) ?? acc
  return [...sayAll(pickLines(G.intro, rng), params), ...acc, ...sayAll(pickLines(G.outro, rng), params)]
}

/** MYTHIC chain clue block: nested on the chain's step flags (the latest solved step decides the clue). */
export function sageSteps(rng: Rng, params: Params): ScriptStep[] {
  const S = FRONTIER_PACK.villagers.sage
  const chains = GAMEPLAY.chains.filter((c) => c.steps.length)
  if (!chains.length) return []
  const chain = rng.pick(chains)
  const clue = (k: number): ScriptStep[] => [{ op: 'say', text: t(chain.steps[k].clue) }]
  let acc = gated(chain.requires, clue(0), sayAll(pickLines(S.notReady, rng), params)) ?? sayAll(pickLines(S.notReady, rng), params)
  for (let k = 0; k + 1 < chain.steps.length; k++) acc = [{ op: 'ifFlag', flag: chain.steps[k].flag, then: clue(k + 1), else: acc }]
  return [...sayAll(pickLines(S.intro, rng), params), { op: 'ifFlag', flag: chain.doneFlag, then: sayAll(pickLines(S.done, rng), params), else: acc }]
}

/** Every behaviour tip the data supports (rarity spawn / flee rules, type affinities). */
export function behaviourTips(): string[] {
  const T = FRONTIER_PACK.villagers.tips
  const out: string[] = []
  for (const r of CONTENT.rarities) {
    const b = r.behavior
    if (!b) continue
    const p: Params = { rarity: r.nameZh, turn: b.fleeAfterTurn, chance: Math.round(b.fleeChancePerTurn * 100), distance: b.minDistance }
    if (b.fleeChancePerTurn > 0) out.push(text(T.flee, p))
    if (b.minDistance > 0) out.push(text(T.minDistance, p))
    if (!b.spawn.includes('grass') && b.spawn.includes('visible')) out.push(text(T.noGrass, p))
    if (b.avoidPlayer && b.spawn.includes('visible')) out.push(text(T.avoid, p))
    if (b.spawn.includes('legend')) out.push(text(T.legend, p))
    if (b.spawn.length === 1 && b.spawn[0] === 'event') out.push(text(T.eventOnly, p))
  }
  const aff = GAMEPLAY.spawn.typeAffinity
  for (const [tod, m] of Object.entries(aff.time)) for (const [ty, v] of Object.entries(m ?? {})) if (v > 1) out.push(text(T.affinityTime, { time: timeName(tod), type: typeName(ty) }))
  for (const [w, m] of Object.entries(aff.weather)) for (const [ty, v] of Object.entries(m ?? {})) if (v > 1) out.push(text(T.affinityWeather, { weather: weatherName(w), type: typeName(ty) }))
  return out
}

let TIPS: string[] | null = null
export function tipSteps(rng: Rng): ScriptStep[] {
  if (!TIPS) TIPS = behaviourTips()
  return TIPS.length ? [{ op: 'say', text: rng.pick(TIPS) }] : []
}

export function giftSteps(npcId: string, dist: number, rng: Rng, params: Params): ScriptStep[] {
  const G = FRONTIER_PACK.villagers.gift
  const roll = rollItem(G.tiers, dist, rng)
  if (!roll) return []
  const flag = `${npcId}:gift`
  return [{
    op: 'ifFlag', flag, then: sayAll(pickLines(G.after, rng), params),
    else: [...sayAll(pickLines(G.intro, rng), params), { op: 'giveItem', item: roll.item, qty: roll.qty }, { op: 'setFlag', flag }],
  }]
}

function flavour(loc: Locale, rng: Rng, params: Params): ScriptStep[] {
  const V = FRONTIER_PACK.villagers
  const out: ScriptStep[] = []
  if (rng.chance(V.lineChance.biome)) out.push(...sayAll(pickLines(V.biomeLines[loc.biome] ?? V.biomeLines.default ?? [], rng), params))
  if (rng.chance(V.lineChance.distance)) {
    let tier: Lines[] = []
    for (const d of V.distanceLines) if (loc.dist >= d.minDistance) tier = d.lines
    out.push(...sayAll(pickLines(tier, rng), params))
  }
  return out
}

export function archetypesFor(loc: Locale): VillagerArchetype[] {
  return FRONTIER_PACK.villagers.archetypes.filter((a) => loc.dist >= (a.minDistance ?? 0) && (!a.biomes || a.biomes.includes(loc.biome)))
}

/** A hamlet villager: persona + greeting + optional biome / distance line + its role block. */
export function villagerScript(npcId: string, arch: VillagerArchetype, loc: Locale, rng: Rng, params: Params): { name: string; sprite: string; script: ScriptStep[] } {
  const name = personName(rng.pick(arch.names), rng)
  const p = { ...params, name }
  const script: ScriptStep[] = [...sayAll(pickLines(arch.lines, rng), p), ...flavour(loc, rng, p)]
  if (arch.role === 'gossip') script.push(...gossipSteps(loc, rng, p))
  else if (arch.role === 'sage') script.push(...sageSteps(rng, p))
  else if (arch.role === 'tips') script.push(...tipSteps(rng))
  else if (arch.role === 'gift') script.push(...giftSteps(npcId, loc.dist, rng, p))
  return { name, sprite: rng.pick(arch.sprites), script }
}

/** A house resident (interiors): biome-aware lines plus a chance of gossip / a gift / a tip. */
export function residentScript(npcId: string, loc: Locale, rng: Rng, params: Params): { name: string; sprite: string; script: ScriptStep[] } {
  const R = FRONTIER_PACK.villagers.residents
  const name = rng.pick(R.names)
  const p = { ...params, name }
  const script: ScriptStep[] = sayAll(pickLines(R.lines, rng), p)
  const bl = R.biomeLines[loc.biome]
  if (bl?.length) script.push(...sayAll(rng.pick(bl), p))
  const roll = rng.next()
  if (roll < R.gossipChance) script.push(...gossipSteps(loc, rng, p))
  else if (roll < R.gossipChance + R.giftChance) script.push(...giftSteps(npcId, loc.dist, rng, p))
  else if (roll < R.gossipChance + R.giftChance + R.tipsChance) script.push(...tipSteps(rng))
  return { name, sprite: rng.pick(R.sprites), script }
}
