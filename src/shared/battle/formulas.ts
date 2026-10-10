// Pure battle math shared by the engine (rolled values) and the AI (expected values).
// Abilities are read as the declarative AbilityEffect DSL; every constant comes from content.
import type {
  AbilityCondition, AbilityEffect, BattleStatKey, Creature, MoveCategory, MoveDef, Stats, TypeId, WeatherId,
} from '../types.ts'
import type { IRng } from '../contracts.ts'
import { typeEffectiveness, type Content } from '../content/index.ts'
import { RULES } from './rules.ts'

/** Scale of percentage fields in the schema (MoveDef.accuracy, MoveEffect.chance, ability `chance`). */
export const PERCENT = 100

export type Stages = Record<BattleStatKey, number>
export const BATTLE_STAT_KEYS: readonly BattleStatKey[] = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva']
export const emptyStages = (): Stages => ({ atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 })

export function toStages(r: Readonly<Record<string, number>> | undefined): Stages {
  const s = emptyStages()
  if (r) for (const k of BATTLE_STAT_KEYS) s[k] = r[k] ?? 0
  return s
}

/** A creature as it stands in battle. */
export interface Fighter {
  creature: Creature
  /** Battle level (level cap applied). */
  level: number
  /** calcStats at `level`. */
  stats: Stats
  stages: Stages
  /** Crit stages from volatiles (VolatileDef.critStageAdd). */
  critStageAdd: number
}

export interface MoveCtx { type: TypeId | null; category: MoveCategory; effectiveness?: number }

/** Deals damage: any non-status move, plus fixed-damage moves whatever their category. */
export const isDamaging = (m: MoveDef): boolean => m.category !== 'status' || m.effects.some((e) => e.kind === 'fixedDamage')

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function effectsOn<K extends AbilityEffect['on']>(cr: Creature, on: K, c: Content): Extract<AbilityEffect, { on: K }>[] {
  const all = c.abilities[cr.abilityId]?.effects ?? []
  return all.filter((e): e is Extract<AbilityEffect, { on: K }> => e.on === on)
}

export const hasEffect = (cr: Creature, on: AbilityEffect['on'], c: Content): boolean =>
  (c.abilities[cr.abilityId]?.effects ?? []).some((e) => e.on === on)

export const speciesTypes = (cr: Creature, c: Content): readonly TypeId[] => c.species[cr.speciesId]?.types ?? []

/** `turn` is the battle's turn number (0 = before the first turn); only `turnCycle` reads it. */
export function condHolds(cond: AbilityCondition | undefined, holder: Fighter, move: MoveCtx | null, weather: WeatherId, c: Content, turn = 0): boolean {
  if (!cond) return true
  const hp = holder.creature.hp
  const max = holder.stats.hp
  if (cond.hpBelow !== undefined && !(max > 0 && hp / max <= cond.hpBelow)) return false
  if (cond.hpFull && hp < max) return false
  if (cond.weather && !cond.weather.includes(weather)) return false
  if (cond.turnCycle) {
    const i = (Math.max(1, turn) - 1) % cond.turnCycle.period
    if (!(i >= cond.turnCycle.from && i < cond.turnCycle.to)) return false
  }
  const needsMove = cond.moveTypes || cond.moveNotOwnType || cond.moveCategory || cond.superEffective
  if (!needsMove) return true
  if (!move) return false
  if (cond.moveTypes && (move.type === null || !cond.moveTypes.includes(move.type))) return false
  if (cond.moveNotOwnType && (move.type === null || speciesTypes(holder.creature, c).includes(move.type))) return false
  if (cond.moveCategory) {
    const ok = cond.moveCategory === 'damaging' ? move.category !== 'status' : move.category === cond.moveCategory
    if (!ok) return false
  }
  if (cond.superEffective && !((move.effectiveness ?? 1) > 1)) return false
  return true
}

/** Conditions tied to the battle situation (worth announcing when they kick in). */
export const situational = (cond: AbilityCondition | undefined): boolean =>
  !!cond && (cond.hpBelow !== undefined || !!cond.hpFull || !!cond.superEffective || !!cond.weather)

export function stageMul(stage: number, base: number): number {
  return stage >= 0 ? (base + stage) / base : base / (base - stage)
}

export function statMulOf(f: Fighter, stat: BattleStatKey, c: Content): number {
  return effectsOn(f.creature, 'statMul', c).reduce((m, e) => (e.stat === stat ? m * e.mul : m), 1)
}

export function battleStat(
  f: Fighter, stat: 'atk' | 'def' | 'spa' | 'spd' | 'spe', opts: { ignorePositive?: boolean; ignoreNegative?: boolean }, c: Content,
): number {
  let st = f.stages[stat]
  if (opts.ignorePositive) st = Math.min(st, 0)
  if (opts.ignoreNegative) st = Math.max(st, 0)
  return f.stats[stat] * stageMul(st, RULES.stageBase.stat) * statMulOf(f, stat, c)
}

export function speedOf(f: Fighter, c: Content): number {
  const st = f.creature.status ? c.statusById[f.creature.status] : undefined
  return battleStat(f, 'spe', {}, c) * (st?.speedMul ?? 1)
}

export function priorityOf(f: Fighter, move: MoveDef, weather: WeatherId, c: Content, turn = 0): number {
  const ctx: MoveCtx = { type: move.type, category: move.category }
  return effectsOn(f.creature, 'priority', c).reduce((p, e) => (condHolds(e.if, f, ctx, weather, c, turn) ? p + e.add : p), move.priority)
}

export function critChance(att: Fighter, highCrit: boolean, c: Content): number {
  const table = c.config.battle.critChanceByStage
  if (table.length === 0) return 0
  const stage = (highCrit ? RULES.highCritStages : 0)
    + effectsOn(att.creature, 'critStage', c).reduce((s, e) => s + e.add, 0)
    + att.critStageAdd
  return table[clamp(Math.floor(stage), 0, table.length - 1)]
}

/** Hit chance in percent (may exceed 100). Callers handle accuracy 0 / alwaysHit. */
export function hitChance(att: Fighter, def: Fighter, move: MoveDef, c: Content): number {
  const lim = c.config.battle.statStageLimit
  const acc = effectsOn(att.creature, 'accuracyMul', c)
  const ignoreEva = acc.some((e) => e.ignoreEvasion) || hasEffect(att.creature, 'ignoreFoeBoosts', c)
  const eva = ignoreEva ? Math.min(def.stages.eva, 0) : def.stages.eva
  const net = clamp(att.stages.acc - eva, -lim, lim)
  let p = move.accuracy * stageMul(net, RULES.stageBase.accEva)
  for (const e of acc) p *= e.mul
  return p * statMulOf(att, 'acc', c) / statMulOf(def, 'eva', c)
}

export function stabOf(cr: Creature, type: TypeId | null, c: Content): number {
  if (type === null || !speciesTypes(cr, c).includes(type)) return 1
  const over = effectsOn(cr, 'stab', c)
  return over.length ? over[over.length - 1].value : c.config.battle.stab
}

export interface AttackSpec {
  power: number
  category: 'physical' | 'special'
  /** null = typeless (Struggle, confusion self-hit). */
  type: TypeId | null
  /** Only stats/stages and the random roll apply (confusion self-hit). */
  plain?: boolean
}
export interface DamageRoll { crit: boolean; random: number }
export interface DamageOutcome {
  damage: number
  effectiveness: number
  /** Abilities whose situational modifier applied (for announcement). */
  triggered: { by: 'attacker' | 'defender'; abilityId: string }[]
}

export function computeDamage(att: Fighter, def: Fighter, spec: AttackSpec, weather: WeatherId, roll: DamageRoll, c: Content, turn = 0): DamageOutcome {
  const triggered: DamageOutcome['triggered'] = []
  const eff = spec.type === null ? 1 : typeEffectiveness(spec.type, speciesTypes(def.creature, c), c)
  if (eff === 0) return { damage: 0, effectiveness: 0, triggered }
  const physical = spec.category === 'physical'
  const ctx: MoveCtx = { type: spec.type, category: spec.category, effectiveness: eff }
  const ignoreBoosts = !spec.plain && hasEffect(att.creature, 'ignoreFoeBoosts', c)
  const A = battleStat(att, physical ? 'atk' : 'spa', { ignoreNegative: roll.crit }, c)
  const D = Math.max(1, battleStat(def, physical ? 'def' : 'spd', { ignorePositive: roll.crit || ignoreBoosts }, c))

  let power = spec.power
  if (!spec.plain) {
    for (const e of effectsOn(att.creature, 'powerMul', c)) {
      if (!condHolds(e.if, att, ctx, weather, c, turn)) continue
      power *= e.mul
      if (situational(e.if)) triggered.push({ by: 'attacker', abilityId: att.creature.abilityId })
    }
  }
  const f = RULES.damageFormula
  const levelFactor = Math.floor((f.levelMul * att.level) / f.levelDivisor + f.levelAdd)
  const base = Math.floor(Math.floor((levelFactor * power * A) / D) / f.divisor) + f.add

  let mod = roll.random * eff
  if (roll.crit) {
    const over = effectsOn(att.creature, 'critMul', c)
    mod *= over.length ? over[over.length - 1].value : c.config.battle.critMultiplier
  }
  if (!spec.plain) {
    if (spec.type !== null) {
      mod *= c.weatherById[weather]?.powerMul[spec.type] ?? 1
      mod *= stabOf(att.creature, spec.type, c)
    }
    const st = att.creature.status ? c.statusById[att.creature.status] : undefined
    if (physical && st?.physicalMul !== undefined) mod *= st.physicalMul
    for (const e of effectsOn(def.creature, 'damageTakenMul', c)) {
      if (!condHolds(e.if, def, ctx, weather, c, turn)) continue
      mod *= e.mul
      if (situational(e.if)) triggered.push({ by: 'defender', abilityId: def.creature.abilityId })
    }
  }
  return { damage: Math.max(f.minDamage, Math.floor(base * mod)), effectiveness: eff, triggered }
}

/** Deterministic estimate for AI: min roll without crit, and crit-weighted mean roll. */
export function estimateDamage(att: Fighter, def: Fighter, move: MoveDef, weather: WeatherId, c: Content, turn = 0): { min: number; avg: number; effectiveness: number } {
  const b = c.config.battle
  const spec: AttackSpec = { power: move.power, category: move.category === 'special' ? 'special' : 'physical', type: move.type }
  const lo = computeDamage(att, def, spec, weather, { crit: false, random: b.randomMin }, c, turn)
  if (lo.effectiveness === 0) return { min: 0, avg: 0, effectiveness: 0 }
  const mid = (b.randomMin + b.randomMax) / 2
  const normal = computeDamage(att, def, spec, weather, { crit: false, random: mid }, c, turn).damage
  const crit = computeDamage(att, def, spec, weather, { crit: true, random: mid }, c, turn).damage
  const p = critChance(att, move.effects.some((e) => e.kind === 'highCrit'), c)
  return { min: lo.damage, avg: normal * (1 - p) + crit * p, effectiveness: lo.effectiveness }
}

/**
 * Gen-3 catch: a = floor(((hpMaxMul*M - hpCurMul*H) * rate * ball) / (hpMaxMul*M)) * status. Caught outright when
 * a >= rateMax; otherwise each of `checks` shake checks passes with (a/rateMax)^(1/checks), so the overall chance is a/rateMax.
 * Returns the number of passed checks (caught when it equals `checks`).
 */
export function catchShakes(
  p: { maxHp: number; hp: number; catchRate: number; ballMul: number; statusBonus: number; checks: number }, rng: IRng,
): number {
  const f = RULES.catchFormula
  const a = Math.floor(((f.hpMaxMul * p.maxHp - f.hpCurMul * p.hp) * p.catchRate * p.ballMul) / (f.hpMaxMul * p.maxHp)) * p.statusBonus
  if (a >= f.rateMax) return p.checks
  const pass = Math.pow(Math.max(0, a) / f.rateMax, 1 / p.checks)
  let shakes = 0
  while (shakes < p.checks && rng.chance(pass)) shakes += 1
  return shakes
}

/** Gen-3 escape: always when at least as fast, else int(0, runRollMax-1) < floor(mine*runBase/theirs) + runAttemptBonus*attempts. */
export function escapes(mine: number, theirs: number, attempts: number, rng: IRng, c: Content): boolean {
  if (mine >= theirs || theirs <= 0) return true
  const b = c.config.battle
  const odds = Math.floor((mine * b.runBase) / theirs) + b.runAttemptBonus * attempts
  return rng.int(0, RULES.runRollMax - 1) < odds
}
