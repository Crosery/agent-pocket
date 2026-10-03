// Frontier trainer teams: species weighted by the region's habitats, the class's types and a rarity table that
// opens up with distance; levels from the region band (+ role bonus); evolution form matched to the level.
// Never references species ids — everything comes from CONTENT.speciesList and trainers.json.
import type { NpcDef, ScriptStep, SpeciesDef, TrainerDef, TrainerPartyEntry } from '../../../types.ts'
import { CONTENT } from '../../../content/index.ts'
import { formAtLevel } from '../../../gameplay/picks.ts'
import type { Rng } from '../../random.ts'
import type { Vec2 } from '../../schema.ts'
import { FRONTIER_PACK, STORY_META } from './data.ts'
import type { RarityTier, TrainerClass } from './schema.ts'
import { curveAt, text, type Params } from './util.ts'

export interface TeamSpec {
  biome: string
  levelRange: Vec2
  dist: number
  types: readonly string[]
  levelBonus: number
  sizeBonus: number
  rarity: readonly RarityTier[]
  /** Fixed size range instead of the distance curve. */
  size?: Vec2
}

let STARTER_FAMILIES: Set<string> | null = null
function starterFamilies(): Set<string> {
  if (!STARTER_FAMILIES) STARTER_FAMILIES = new Set(CONTENT.speciesList.filter((s) => s.starter).map((s) => s.family))
  return STARTER_FAMILIES
}

export function rarityWeights(tiers: readonly RarityTier[], dist: number): Record<string, number> {
  let w: Record<string, number> = {}
  for (const t of tiers) if (dist >= t.minDistance) w = t.weights
  return w
}

export function partyLevel(levelRange: Vec2, bonus: number, rng: Rng): number {
  const P = FRONTIER_PACK.trainers.party
  const max = CONTENT.config.party.maxLevel
  return Math.max(1, Math.min(max, levelRange[1] + bonus + rng.int(P.levelSpread[0], P.levelSpread[1])))
}

/** A deterministic party for the spec (1..maxSize members, distinct species, forms legal for their level). */
export function buildParty(spec: TeamSpec, rng: Rng): TrainerPartyEntry[] {
  const P = FRONTIER_PACK.trainers.party
  const maxParty = Math.min(P.maxSize, CONTENT.config.party.maxParty)
  const max = CONTENT.config.party.maxLevel
  const mean = curveAt(P.size, spec.dist)
  const size = spec.size
    ? rng.int(spec.size[0], spec.size[1])
    : Math.round(mean + (rng.next() * 2 - 1) * P.sizeJitter) + spec.sizeBonus
  const n = Math.max(1, Math.min(maxParty, size))
  const rw = rarityWeights(spec.rarity, spec.dist)
  const habitats = new Set(CONTENT.biomeById[spec.biome]?.encounterHabitats ?? [spec.biome])
  const banned = starterFamilies()
  const weightOf = (s: SpeciesDef): number => {
    const r = rw[s.rarity] ?? 0
    if (r <= 0 || banned.has(s.family)) return 0
    const home = s.habitats.some((h) => habitats.has(h)) ? P.habitatBias : 1
    const typed = spec.types.length && s.types.some((t) => spec.types.includes(t)) ? P.typeBias : 1
    return r * home * typed
  }
  const pool = CONTENT.speciesList.filter((s) => weightOf(s) > 0)
  const out: TrainerPartyEntry[] = []
  const used = new Set<string>()
  for (let k = 0; k < n && pool.length; k++) {
    const level = Math.max(1, Math.min(max, partyLevel(spec.levelRange, spec.levelBonus, rng) + (k === n - 1 ? P.aceBonus : 0)))
    let pick: SpeciesDef | null = null
    for (let tries = 0; tries < 12 && !pick; tries++) {
      const base = rng.weighted(pool, weightOf)
      const form = formAtLevel(base, level)
      if (used.has(form.id) || (rw[form.rarity] ?? 0) <= 0) continue
      pick = form
    }
    if (!pick) continue
    used.add(pick.id)
    out.push({ species: pick.id, level })
  }
  return out
}

export function aiLevelAt(dist: number): 0 | 1 | 2 | 3 {
  return Math.max(0, Math.min(3, Math.round(curveAt(FRONTIER_PACK.trainers.party.aiLevel, dist)))) as 0 | 1 | 2 | 3
}

export function rewardFor(party: readonly TrainerPartyEntry[], dist: number, mul: number): number {
  const P = FRONTIER_PACK.trainers.party
  const ace = party.reduce((m, p) => Math.max(m, p.level), 1)
  return Math.round(P.rewardPerLevel * ace * curveAt(P.rewardDistanceMul, dist) * mul)
}

export function classesFor(list: readonly TrainerClass[], biome: string, dist: number): TrainerClass[] {
  const ok = list.filter((c) => (c.biomes === 'any' || c.biomes.includes(biome)) && dist >= (c.minDistance ?? 0))
  return ok.length ? ok : list.filter((c) => c.biomes === 'any')
}

export interface TrainerBuild { def: TrainerDef; params: Params }

/** TrainerDef for a class persona (texts formatted with params, party from the spec). */
export function classTrainer(id: string, cls: TrainerClass, spec: TeamSpec, rng: Rng, params: Params, extra: { aiLevel?: 0 | 1 | 2 | 3; rewardMul?: number; music?: string; items?: Record<string, number> } = {}): TrainerBuild {
  const name = rng.pick(cls.names)
  const p: Params = { ...params, name, class: cls.classZh }
  const party = buildParty(spec, rng)
  const def: TrainerDef = {
    id,
    nameZh: name,
    classZh: cls.classZh,
    sprite: rng.pick(cls.sprites),
    party,
    reward: rewardFor(party, spec.dist, (cls.rewardMul ?? 1) * (extra.rewardMul ?? 1)),
    introText: (cls.intro.length ? rng.pick(cls.intro) : []).map((l) => text(l, p)),
    defeatText: (cls.defeat.length ? rng.pick(cls.defeat) : []).map((l) => text(l, p)),
    aiLevel: extra.aiLevel ?? aiLevelAt(spec.dist),
  }
  const items = extra.items ?? cls.items
  if (items && Object.keys(items).length) def.items = { ...items }
  if (extra.music) def.music = extra.music
  return { def, params: { ...p, after: cls.after.length ? text(rng.pick(cls.after), p) : '' } }
}

export const trainerWonFlag = (id: string): string => `${STORY_META.flags.trainerWon}${id}`

/** Story convention: after the win the trainer says its line, otherwise it battles. */
export function trainerScript(id: string, after: string, tail: ScriptStep[] = []): ScriptStep[] {
  return [{ op: 'ifFlag', flag: trainerWonFlag(id), then: [{ op: 'say', text: after }], else: [{ op: 'battle', trainer: id }, ...tail] }]
}

export function trainerNpc(def: TrainerDef, x: number, y: number, facing: NpcDef['facing'], script: ScriptStep[], sight: number): NpcDef {
  const npc: NpcDef = {
    id: def.id, x, y, facing, sprite: def.sprite, role: 'trainer', trainer: def.id, script,
    nameZh: text(FRONTIER_PACK.common.npcName, { class: def.classZh, name: def.nameZh }),
  }
  if (sight > 0) npc.sightRange = sight
  return npc
}
