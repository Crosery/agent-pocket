// Team builder: turns an archetype definition (tools/balance/archetypes.json) into concrete teams of real species.
// Members are picked by stat-shape predicates and a score, movesets by slot kinds (attack / heal / boost / inflict ...),
// under the team-building law (type clause, rarity cap, shared BST window). Nothing here names a species, so new species
// join the pools automatically. `variant` > 0 samples among the best candidates for Monte Carlo over team instances.
import type { MoveDef, SpeciesDef, TypeId } from '../../src/shared/types.ts'
import { typeEffectiveness } from '../../src/shared/content/index.ts'
import { legalMoves } from '../../src/shared/creature.ts'
import { Rng } from '../../src/shared/rng.ts'
import { C, RULES, bst, isDamagingMove } from './lib.ts'
import { damageValue } from './moves.ts'
import type { MemberSpec, TeamSpec } from './sim.ts'
import defsJson from './archetypes.json' with { type: 'json' }

export type SlotKind = 'attack' | 'priority' | 'heal' | 'protect' | 'boost' | 'inflict' | 'confuse' | 'weather' | 'drop' | 'cure'

export interface Cond { stat: string; min?: number; max?: number }
export interface RoleDef {
  id: string
  nameZh: string
  plan: string
  /** Stat-shape predicates (derived stats: off, bulk, spe, hp, atk, def, spa, spd, physShare) all must hold. */
  where: Cond[]
  /** Candidate ranking weights over derived stats. */
  score: Record<string, number>
  /** Each slot lists acceptable kinds in preference order; an unfillable slot falls through to the next kind. */
  slots: SlotKind[][]
  /** Weather the team plays around: members must have a boosted type, one carries the setter. */
  weather?: string
  /** Overrides law.maxPerType (a weather team shares the boosted types). */
  maxPerType?: number
  /** Candidate pool size (best-scoring species passing `where`); defaults to law.pool. */
  pool?: number
  /** Preferred status ids for `inflict` slots, best first. */
  inflict?: string[]
}
export interface Law {
  members: number
  minTeamBst: number
  maxTeamBst: number
  minRarityOrder: number
  maxRarityOrder: number
  /** At most this many members share any one type (primary or secondary). */
  maxPerType: number
  minDistinctTypes: number
  /** Attack slots only use moves scoring at least this fraction of the creature's best attack. */
  attackFloor: number
  /** Default candidate pool size per role. */
  pool: number
  /** Variants pick among this many top-ranked candidates. */
  pickFrom: number
  tries: number
}
export interface Defs { law: Law; roles: RoleDef[] }
export const DEFS: Defs = defsJson as unknown as Defs

const derive = (sp: SpeciesDef): Record<string, number> => {
  const b = sp.baseStats
  const t = bst(sp)
  return {
    ...b, off: Math.max(b.atk, b.spa), bulk: (b.hp + b.def + b.spd) / t, bst: t,
    physShare: b.atk / (b.atk + b.spa), offShare: Math.max(b.atk, b.spa) / t, speShare: b.spe / t,
  }
}

const holds = (d: Record<string, number>, c: Cond): boolean => (c.min === undefined || d[c.stat] >= c.min) && (c.max === undefined || d[c.stat] <= c.max)

// ---------------------------------------------------------------------------------------------------------------- moves

function kindsOf(m: MoveDef): Set<SlotKind> {
  const out = new Set<SlotKind>()
  if (isDamagingMove(m) && m.category !== 'status') { out.add('attack'); if (m.priority > 0) out.add('priority') }
  for (const e of m.effects) {
    if (e.kind === 'heal' && e.fraction >= 0.5) out.add('heal')
    if (e.kind === 'weather') out.add('weather')
    if (e.kind === 'cureStatus' && e.target === 'self') out.add('cure')
    if (e.kind === 'stat' && e.target === 'self' && Object.entries(e.stats).some(([k, v]) => (v ?? 0) > 0 && (k === 'atk' || k === 'spa' || k === 'spe')) && m.category === 'status') out.add('boost')
    if (e.kind === 'stat' && e.target === 'enemy' && m.category === 'status') out.add('drop')
    if (e.kind === 'status' && e.target === 'enemy' && e.chance === 100 && m.category === 'status') out.add('inflict')
    if (e.kind === 'volatile' && e.target === 'enemy' && m.category === 'status' && (e.volatile === 'confusion' || e.volatile === 'leech')) out.add('confuse')
    if (e.kind === 'volatile' && e.target === 'self' && e.volatile === 'protect') out.add('protect')
  }
  return out
}

const poolCache = new Map<string, MoveDef[]>()
function poolOf(sp: SpeciesDef): MoveDef[] {
  let p = poolCache.get(sp.id)
  if (!p) {
    p = [...legalMoves(sp.id, RULES.sim.level, C)].map((id) => C.moves[id]).filter(Boolean)
    poolCache.set(sp.id, p)
  }
  return p
}

const allTypeSets = (): TypeId[][] => {
  const seen = new Map<string, TypeId[]>()
  for (const s of C.speciesList) seen.set([...s.types].sort().join('/'), s.types)
  return [...seen.values()]
}
let typeSets: TypeId[][] | null = null

/** Mean best multiplier over all defender type sets: how much of the dex the move set can hit hard. */
function coverage(moves: MoveDef[]): number {
  typeSets ??= allTypeSets()
  let sum = 0
  for (const d of typeSets) sum += Math.max(0.5, ...moves.map((m) => typeEffectiveness(m.type, d, C)))
  return sum / typeSets.length
}

function attackScore(sp: SpeciesDef, m: MoveDef, weather?: string): number {
  const b = sp.baseStats
  const stab = sp.types.includes(m.type) ? C.config.battle.stab : 1
  const match = m.category === 'physical' ? b.atk : m.category === 'special' ? b.spa : Math.max(b.atk, b.spa)
  const fit = match / Math.max(b.atk, b.spa)
  const wmul = weather ? (C.weatherById[weather]?.powerMul[m.type] ?? 1) : 1
  return damageValue(m) * stab * fit * fit * wmul
}

function pickAttacks(sp: SpeciesDef, count: number, usedIds: Set<string>, weather?: string): MoveDef[] {
  const chosen: MoveDef[] = []
  const all = poolOf(sp).filter((m) => kindsOf(m).has('attack') && !usedIds.has(m.id) && !m.effects.some((e) => e.kind === 'selfFaint'))
  // A slot is never spent on a move far below the creature's best: coverage may cost some power, not most of it.
  const top = Math.max(...all.map((m) => attackScore(sp, m, weather)))
  const attacks = all.filter((m) => attackScore(sp, m, weather) >= top * DEFS.law.attackFloor)
  while (chosen.length < count) {
    let best: MoveDef | null = null
    let bestV = -Infinity
    const base = chosen.length ? coverage(chosen) : 1
    for (const m of attacks) {
      if (chosen.includes(m)) continue
      const gain = chosen.length ? coverage([...chosen, m]) / base : 1
      const v = attackScore(sp, m, weather) * (chosen.length ? gain ** 3 : 1)
      if (v > bestV) { bestV = v; best = m }
    }
    if (!best) break
    chosen.push(best)
  }
  return chosen
}

function pickUtility(sp: SpeciesDef, kind: SlotKind, role: RoleDef, used: Set<string>): MoveDef | null {
  const cands = poolOf(sp).filter((m) => kindsOf(m).has(kind) && !used.has(m.id))
  if (!cands.length) return null
  const score = (m: MoveDef): number => {
    const acc = m.accuracy === 0 ? 100 : m.accuracy
    let v = acc / 100
    if (kind === 'inflict') {
      const st = m.effects.find((e) => e.kind === 'status')
      const rank = st && st.kind === 'status' ? (role.inflict ?? []).indexOf(st.status) : -1
      v += rank >= 0 ? 3 - rank * 0.4 : 0
    }
    if (kind === 'boost') {
      const e = m.effects.find((x) => x.kind === 'stat')
      if (e && e.kind === 'stat') {
        const wantPhys = sp.baseStats.atk >= sp.baseStats.spa
        const sum = Object.entries(e.stats).reduce((a, [k, d]) => a + (((k === 'atk' && wantPhys) || (k === 'spa' && !wantPhys)) ? (d ?? 0) * 2 : k === 'spe' ? (d ?? 0) : 0), 0)
        v += sum
      }
    }
    if (kind === 'heal') v += m.pp / 40
    if (kind === 'protect') v += m.priority / 10
    return v
  }
  return cands.reduce((a, b) => (score(b) > score(a) ? b : a))
}

export function movesetFor(sp: SpeciesDef, role: RoleDef, weather: string | undefined, setter: boolean): string[] {
  const used = new Set<string>()
  const out: MoveDef[] = []
  const slotKinds: SlotKind[][] = role.slots.map((s) => [...s])
  if (setter) slotKinds.unshift(['weather'])
  const attackSlots = slotKinds.filter((ks) => ks[0] === 'attack').length
  const attacks = pickAttacks(sp, attackSlots + 2, used, weather)
  let ai = 0
  for (const kinds of slotKinds.slice(0, C.config.party.maxMoves)) {
    let got: MoveDef | null = null
    for (const k of kinds) {
      if (k === 'attack') { while (ai < attacks.length && used.has(attacks[ai].id)) ai++; if (ai < attacks.length) { got = attacks[ai++]; break } }
      else if (k === 'priority') got = poolOf(sp).filter((m) => kindsOf(m).has('priority') && !used.has(m.id)).sort((a, b) => attackScore(sp, b) - attackScore(sp, a))[0] ?? null
      else got = pickUtility(sp, k, role, used)
      if (got) break
    }
    if (!got) { while (ai < attacks.length && used.has(attacks[ai].id)) ai++; got = attacks[ai++] ?? null }
    if (got) { used.add(got.id); out.push(got) }
  }
  return out.map((m) => m.id)
}

// ---------------------------------------------------------------------------------------------------------------- teams

function candidatesFor(role: RoleDef): { sp: SpeciesDef; score: number }[] {
  const law = DEFS.law
  const boosted = role.weather ? Object.entries(C.weatherById[role.weather]?.powerMul ?? {}).filter(([, v]) => v > 1).map(([k]) => k) : []
  const out: { sp: SpeciesDef; score: number }[] = []
  for (const sp of C.speciesList) {
    const order = C.rarityById[sp.rarity].order
    if (order < law.minRarityOrder || order > law.maxRarityOrder) continue
    const d = derive(sp)
    if (!role.where.every((c) => holds(d, c))) continue
    if (boosted.length && !sp.types.some((t) => boosted.includes(t))) continue
    let score = 0
    for (const [k, w] of Object.entries(role.score)) score += (d[k] ?? 0) * w
    out.push({ sp, score })
  }
  return out.sort((a, b) => b.score - a.score || a.sp.id.localeCompare(b.sp.id)).slice(0, role.pool ?? law.pool)
}

const cands = new Map<string, { sp: SpeciesDef; score: number }[]>()

export function buildArchetype(role: RoleDef, variant: number): TeamSpec | null {
  const law = DEFS.law
  let pool = cands.get(role.id)
  if (!pool) { pool = candidatesFor(role); cands.set(role.id, pool) }
  for (let attempt = 0; attempt < law.tries; attempt++) {
    const rng = new Rng(variant * 7919 + attempt * 104729 + role.id.length * 31)
    const typeCount = new Map<string, number>()
    const picked: SpeciesDef[] = []
    const rest = [...pool]
    while (picked.length < law.members && rest.length) {
      const window = variant === 0 && attempt === 0 ? 1 : law.pickFrom
      const legal = rest.filter((c) => c.sp.types.every((t) => (typeCount.get(t) ?? 0) < (role.maxPerType ?? law.maxPerType)) && !picked.some((p) => p.family === c.sp.family))
      if (!legal.length) break
      const choice = legal[Math.min(legal.length - 1, rng.int(0, window - 1))]
      picked.push(choice.sp)
      for (const t of choice.sp.types) typeCount.set(t, (typeCount.get(t) ?? 0) + 1)
      rest.splice(rest.indexOf(choice), 1)
    }
    if (picked.length < law.members) continue
    const total = picked.reduce((a, s) => a + bst(s), 0)
    if (total < law.minTeamBst || total > law.maxTeamBst) continue
    if (new Set(picked.flatMap((s) => s.types)).size < law.minDistinctTypes) continue
    // The weather setter: the member that can learn the setter move and has the least offence to lose.
    let setterId = ''
    if (role.weather) {
      const setters = picked.filter((s) => poolOf(s).some((m) => m.effects.some((e) => e.kind === 'weather' && e.weather === role.weather)))
      if (!setters.length) continue
      setterId = setters.reduce((a, b) => (derive(b).off < derive(a).off ? b : a)).id
    }
    const members: MemberSpec[] = picked.map((sp) => {
      const moves = movesetFor(sp, role, role.weather, sp.id === setterId)
      if (sp.id === setterId) {
        const w = poolOf(sp).find((m) => m.effects.some((e) => e.kind === 'weather' && e.weather === role.weather))
        if (w && !moves.includes(w.id)) moves[0] = w.id
      }
      return { species: sp.id, moves }
    })
    return { id: role.id, nameZh: role.nameZh, plan: role.plan, members, ...(setterId ? { lead: setterId } : {}) }
  }
  return null
}

export function teamsForVariant(variant: number): TeamSpec[] {
  return DEFS.roles.map((r) => {
    const t = buildArchetype(r, variant)
    if (!t) throw new Error(`archetype ${r.id}: no team satisfies the team-building law (variant ${variant})`)
    return t
  })
}

/** Team-building law check for a built team; returns problems (empty = legal). */
export function lawProblems(t: TeamSpec): string[] {
  const role = DEFS.roles.find((r) => r.id === t.id)
  const law = DEFS.law
  const out: string[] = []
  const sps = t.members.map((m) => C.species[m.species])
  const total = sps.reduce((a, s) => a + bst(s), 0)
  if (sps.length !== law.members) out.push(`${t.id}: ${sps.length} members`)
  if (total < law.minTeamBst || total > law.maxTeamBst) out.push(`${t.id}: team BST ${total} outside [${law.minTeamBst}, ${law.maxTeamBst}]`)
  const count = new Map<string, number>()
  for (const s of sps) for (const ty of s.types) count.set(ty, (count.get(ty) ?? 0) + 1)
  for (const [ty, n] of count) if (n > (role?.maxPerType ?? law.maxPerType)) out.push(`${t.id}: ${n} members share type ${ty}`)
  for (const m of t.members) {
    const pool = legalMoves(m.species, RULES.sim.level, C)
    for (const mv of m.moves ?? []) if (!pool.has(mv)) out.push(`${t.id}: ${m.species} cannot learn ${mv}`)
  }
  return out
}
