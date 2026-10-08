// Battle AI with levels 0..3. Which behaviour each level unlocks (scored moves, status moves, items, switching,
// damage estimation) and every weight/threshold come from content/battle_rules.json (ai).
import type { BattleAction, BattleSideInit, Creature, MoveDef, SideIndex, Stats, TypeId } from '../types.ts'
import type { IBattleEngine, IRng } from '../contracts.ts'
import { CONTENT, typeEffectiveness, type Content } from '../content/index.ts'
import { calcStats } from '../creature.ts'
import { RULES, type AiTuning } from './rules.ts'
import {
  PERCENT, effectsOn, estimateDamage, hasEffect, isDamaging, hitChance, speciesTypes, speedOf, stabOf, toStages, type Fighter,
} from './formulas.ts'

/** Optional engine extras the AI uses when available (BattleEngine provides them). */
export interface AiIntrospection {
  itemsLeft(side: SideIndex): Readonly<Record<string, number>>
  volatiles(side: SideIndex): string[]
  /** Battle stats of the active creature (boss multipliers included). */
  fighterStats(side: SideIndex): Stats
}

type AiLevel = NonNullable<BattleSideInit['aiLevel']>
const MAX_LEVEL: AiLevel = 3
const asLevel = (n: number): AiLevel => Math.max(0, Math.min(MAX_LEVEL, Math.round(n))) as AiLevel
const unlocked = (level: AiLevel, feature: keyof AiTuning['featureLevel']): boolean => level >= RULES.ai.featureLevel[feature]
const other = (s: SideIndex): SideIndex => (s === 0 ? 1 : 0)

export function aiLevelOf(engine: IBattleEngine, side: SideIndex, c: Content = CONTENT): AiLevel {
  const init = engine.init.sides[side]
  if (init.aiLevel !== undefined) return asLevel(init.aiLevel)
  if (init.kind === 'wild') {
    const cr = engine.party(side)[engine.activeIndex(side)]
    const order = c.rarityById[c.species[cr?.speciesId ?? '']?.rarity ?? '']?.order ?? 0
    const table = RULES.ai.wildLevelByRarityOrder
    return asLevel(table.length ? table[Math.min(order, table.length - 1)] : RULES.ai.defaultLevel)
  }
  return asLevel(RULES.ai.defaultLevel)
}

interface Ctx {
  engine: IBattleEngine
  c: Content
  side: SideIndex
  level: AiLevel
  me: Creature
  them: Creature
  meF: Fighter
  themF: Fighter
  myVolatiles: string[]
  theirVolatiles: string[]
  items: Readonly<Record<string, number>>
}

const extras = (engine: IBattleEngine): Partial<AiIntrospection> => engine as Partial<AiIntrospection>

function fighterOf(engine: IBattleEngine, side: SideIndex, c: Content): Fighter {
  const cr = engine.party(side)[engine.activeIndex(side)]
  const cap = engine.init.levelCap
  const level = cap !== undefined && cap > 0 ? Math.min(cr.level, cap) : cr.level
  const stats = extras(engine).fighterStats?.(side) ?? calcStats({ speciesId: cr.speciesId, ivs: cr.ivs, level }, c)
  return { creature: cr, level, stats, stages: toStages(engine.stages(side)), critStageAdd: 0 }
}

function makeCtx(engine: IBattleEngine, side: SideIndex, c: Content): Ctx {
  const foe = other(side)
  const meF = fighterOf(engine, side, c)
  const themF = fighterOf(engine, foe, c)
  const x = extras(engine)
  return {
    engine, c, side, level: aiLevelOf(engine, side, c), me: meF.creature, them: themF.creature, meF, themF,
    myVolatiles: x.volatiles?.(side) ?? [],
    theirVolatiles: x.volatiles?.(foe) ?? [],
    items: x.itemsLeft?.(side) ?? engine.init.sides[side].items ?? {},
  }
}

const hpRatio = (f: Fighter): number => (f.stats.hp > 0 ? f.creature.hp / f.stats.hp : 0)

function usableMoves(ctx: Ctx): number[] {
  const blocked = ctx.myVolatiles.some((v) => ctx.c.volatileById[v]?.blocksStatusMoves)
  const out: number[] = []
  ctx.me.moves.forEach((m, i) => {
    const def = ctx.c.moves[m.id]
    if (def && m.pp > 0 && !(blocked && def.category === 'status')) out.push(i)
  })
  return out
}

/** Best type effectiveness among `attacker`'s known damaging moves against `defender` (0 if none). */
function bestEffectiveness(attacker: Creature, defender: Creature, c: Content): number {
  let best = 0
  const defTypes = speciesTypes(defender, c)
  for (const m of attacker.moves) {
    const def = c.moves[m.id]
    if (!def || !isDamaging(def)) continue
    best = Math.max(best, typeEffectiveness(def.type, defTypes, c))
  }
  return best
}

function statusBlocked(target: Creature, statusId: string, c: Content): boolean {
  const types = speciesTypes(target, c)
  if ((c.statusImmunities[statusId] ?? []).some((ty) => types.includes(ty))) return true
  return effectsOn(target, 'immune', c).some((e) => e.statuses?.includes(statusId))
}

function volatileBlocked(target: Creature, volatileId: string, c: Content): boolean {
  return effectsOn(target, 'immune', c).some((e) => e.volatiles?.includes(volatileId))
}

function absorbs(target: Creature, type: TypeId, c: Content): boolean {
  return effectsOn(target, 'absorbType', c).some((e) => e.types.includes(type))
}

function damageScore(ctx: Ctx, mv: MoveDef): number {
  const { c, meF, themF, them } = ctx
  const ai = RULES.ai
  const eff = typeEffectiveness(mv.type, speciesTypes(them, c), c)
  if (eff === 0) return 0
  if (unlocked(ctx.level, 'statusMoves') && absorbs(them, mv.type, c)) return 0
  const sure = mv.accuracy === 0 || mv.effects.some((e) => e.kind === 'alwaysHit')
  const acc = sure ? 1 : Math.min(1, hitChance(meF, themF, mv, c) / PERCENT)
  const multi = mv.effects.find((e) => e.kind === 'multiHit')
  const fixed = mv.effects.find((e) => e.kind === 'fixedDamage')
  const avgHits = multi ? (multi.min + multi.max) / 2 : 1
  const minHits = multi ? multi.min : 1
  const fixedAmount = fixed ? (fixed.amount === 'level' ? meF.level : fixed.amount) : 0
  let score: number
  if (unlocked(ctx.level, 'damageEstimate')) {
    const est = fixed ? { min: fixedAmount, avg: fixedAmount } : estimateDamage(meF, themF, mv, ctx.engine.weather, c)
    const foeHp = Math.max(1, them.hp)
    score = Math.min(1, (est.avg * avgHits) / foeHp) * ai.damageScore * acc
    if (est.min * minHits >= them.hp) {
      score += ai.koBonus * acc
      if (mv.priority > 0 && speedOf(themF, c) >= speedOf(meF, c)) score += ai.priorityKoBonus
    }
  } else {
    const weatherMul = c.weatherById[ctx.engine.weather]?.powerMul[mv.type] ?? 1
    score = fixed ? fixedAmount * acc * avgHits : mv.power * eff * stabOf(ctx.me, mv.type, c) * weatherMul * acc * avgHits
  }
  const recoil = mv.effects.find((e) => e.kind === 'recoil')
  if (recoil) score *= Math.max(0, 1 - recoil.fraction * ai.recoilPenalty)
  if (mv.effects.some((e) => e.kind === 'selfFaint') && hpRatio(meF) > ai.selfFaintMaxHpRatio) score *= ai.selfFaintPenalty
  return score
}

function statusScore(ctx: Ctx, mv: MoveDef): number {
  const { c, meF, themF, me, them } = ctx
  const ai = RULES.ai
  if (!unlocked(ctx.level, 'statusMoves')) return ai.basicStatusScore
  let score = 0
  let targetsFoe = false
  for (const e of mv.effects) {
    switch (e.kind) {
      case 'status':
        if (e.target === 'enemy') {
          targetsFoe = true
          if (!them.status && !statusBlocked(them, e.status, c)) score += ai.statusInflictScore * e.chance / PERCENT
        }
        break
      case 'volatile': {
        const def = c.volatileById[e.volatile]
        if (!def) break
        if (e.target === 'enemy') {
          targetsFoe = true
          if (!ctx.theirVolatiles.includes(e.volatile) && !volatileBlocked(them, e.volatile, c)) score += ai.volatileInflictScore * e.chance / PERCENT
        } else if (def.protects) score += ai.protectScore
        else if (!ctx.myVolatiles.includes(e.volatile)) score += ai.selfVolatileScore * e.chance / PERCENT
        break
      }
      case 'stat':
        for (const [k, d] of Object.entries(e.stats)) {
          if (!d) continue
          if (e.target === 'self' && d > 0 && (meF.stages[k as keyof typeof meF.stages] ?? 0) < ai.boostStageCap && hpRatio(meF) >= ai.boostMinHpRatio) {
            score += ai.selfBoostScore * e.chance / PERCENT
          }
          if (e.target === 'enemy') {
            targetsFoe = true
            if (d < 0 && (themF.stages[k as keyof typeof themF.stages] ?? 0) > -ai.boostStageCap && !hasEffect(them, 'noStatDrops', c)) {
              score += ai.foeDropScore * e.chance / PERCENT
            }
          }
        }
        break
      case 'heal':
        if (hpRatio(meF) < ai.healMoveBelowHpRatio) score += ai.healMoveScore * (1 - hpRatio(meF))
        break
      case 'cureStatus':
        if (e.target === 'self' && me.status) score += ai.cureStatusScore
        break
      case 'weather': {
        const w = c.weatherById[e.weather]
        if (!w || ctx.engine.weather === e.weather) break
        const mine = speciesTypes(me, c)
        const helps = mine.some((ty) => (w.powerMul[ty] ?? 1) > 1) || (w.heal?.types ?? []).some((ty) => mine.includes(ty))
        if (helps) score += ai.weatherScore
        break
      }
      default:
        break
    }
  }
  if (targetsFoe) {
    if (absorbs(them, mv.type, c)) return 0
    for (const e of effectsOn(them, 'blockFoeStatusMoves', c)) score *= Math.max(0, 1 - e.chance / PERCENT)
    if (mv.accuracy !== 0 && !mv.effects.some((e) => e.kind === 'alwaysHit')) score *= Math.min(1, hitChance(meF, themF, mv, c) / PERCENT)
  }
  return score
}

function scoreMove(ctx: Ctx, idx: number): number {
  const mv = ctx.c.moves[ctx.me.moves[idx].id]
  return isDamaging(mv) ? damageScore(ctx, mv) : statusScore(ctx, mv)
}

function pickItem(ctx: Ctx, rng: IRng): BattleAction | null {
  const { c, me, meF } = ctx
  const ai = RULES.ai
  const owned = Object.entries(ctx.items).filter(([id, n]) => n > 0 && c.items[id]?.usableInBattle)
  const partyIndex = ctx.engine.activeIndex(ctx.side)
  if (hpRatio(meF) < ai.healItemBelowHpRatio) {
    let best: string | null = null
    let bestAmount = 0
    for (const [id] of owned) {
      const e = c.items[id].effect
      const amount = e.kind === 'healCure' || (e.kind === 'heal' && e.amount === 'full') ? meF.stats.hp : e.kind === 'heal' ? (e.amount as number) : 0
      if (amount > bestAmount) { best = id; bestAmount = amount }
    }
    if (best && rng.chance(ai.healItemChance)) return { kind: 'item', itemId: best, partyIndex }
  }
  if (me.status) {
    const cure = owned.find(([id]) => {
      const e = c.items[id].effect
      return e.kind === 'healCure' || (e.kind === 'cure' && (e.status === 'all' || e.status === me.status))
    })
    if (cure && rng.chance(ai.cureItemChance)) return { kind: 'item', itemId: cure[0], partyIndex }
  }
  return null
}

function pickDefensiveSwitch(ctx: Ctx, rng: IRng): BattleAction | null {
  const { c, me, them, engine, side } = ctx
  const ai = RULES.ai
  if (bestEffectiveness(them, me, c) < ai.switchThreatEffectiveness) return null
  if (bestEffectiveness(me, them, c) > 1) return null
  const party = engine.party(side)
  const active = engine.activeIndex(side)
  let best = -1
  let bestThreat = Infinity
  party.forEach((cr, i) => {
    if (i === active || cr.hp <= 0) return
    const threat = bestEffectiveness(them, cr, c)
    if (threat < 1 && threat < bestThreat) { best = i; bestThreat = threat }
  })
  if (best < 0 || !rng.chance(ai.switchChance)) return null
  return { kind: 'switch', partyIndex: best }
}

export function chooseAiAction(engine: IBattleEngine, side: SideIndex, rng: IRng, c: Content = CONTENT): BattleAction {
  const req = engine.request(side)
  if (req.kind === 'switch') return { kind: 'switch', partyIndex: chooseAiReplacement(engine, side, rng, c) }
  const ctx = makeCtx(engine, side, c)
  if (req.kind === 'action') {
    const item = req.canItem && unlocked(ctx.level, 'items') ? pickItem(ctx, rng) : null
    if (item) return item
    const sw = req.canSwitch && unlocked(ctx.level, 'switching') ? pickDefensiveSwitch(ctx, rng) : null
    if (sw) return sw
  }
  const usable = usableMoves(ctx)
  if (usable.length === 0) return { kind: 'move', moveIndex: 0 }
  if (!unlocked(ctx.level, 'scoredMoves')) return { kind: 'move', moveIndex: rng.pick(usable) }
  const noise = RULES.ai.noise[ctx.level] ?? 0
  let best = usable[0]
  let bestScore = -Infinity
  for (const i of usable) {
    const score = scoreMove(ctx, i) * (1 + rng.next() * noise)
    if (score > bestScore) { best = i; bestScore = score }
  }
  return { kind: 'move', moveIndex: best }
}

/** Party index to send in after the active creature fainted. */
export function chooseAiReplacement(engine: IBattleEngine, side: SideIndex, rng: IRng, c: Content = CONTENT): number {
  const party = engine.party(side)
  const active = engine.activeIndex(side)
  const alive = party.map((_, i) => i).filter((i) => i !== active && party[i].hp > 0)
  if (alive.length === 0) return active
  const level = aiLevelOf(engine, side, c)
  if (!unlocked(level, 'orderedReplacement')) return rng.pick(alive)
  if (!unlocked(level, 'matchupReplacement')) return alive[0]
  const foe = engine.party(other(side))[engine.activeIndex(other(side))]
  let best = alive[0]
  let bestScore = -Infinity
  for (const i of alive) {
    const cr = party[i]
    const max = calcStats(cr, c).hp
    const score = bestEffectiveness(cr, foe, c) - bestEffectiveness(foe, cr, c) + (max > 0 ? cr.hp / max : 0)
    if (score > bestScore) { best = i; bestScore = score }
  }
  return best
}
