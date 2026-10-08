// A competent-player policy for the simulator: expected-damage move choice, status / setup / recovery when they pay,
// switching out of bad matchups. It reads only public battle state plus the foe's known moves (like a player who knows
// the dex). Every weight is in tools/balance/pilot.json.
import type { BattleAction, Creature, MoveDef, SideIndex, StatKey } from '../../src/shared/types.ts'
import type { BattleEngine } from '../../src/shared/battle/engine.ts'
import { typeEffectiveness } from '../../src/shared/content/index.ts'
import { calcStats } from '../../src/shared/creature.ts'
import { Rng } from '../../src/shared/rng.ts'
import {
  PERCENT, effectsOn, estimateDamage, hasEffect, hitChance, isDamaging, speedOf, toStages, type Fighter,
} from '../../src/shared/battle/formulas.ts'
import { C } from './lib.ts'
import pilotJson from './pilot.json' with { type: 'json' }

const P = pilotJson as unknown as {
  statusValue: Record<string, number>
  volatileValue: Record<string, number>
  boostValue: Record<string, number>
  dropValue: Record<string, number>
  boostStageCap: number
  boostSurviveHits: number
  healBelow: number
  healValue: number
  healSaveValue: number
  healOutpace: number
  weatherValue: number
  weatherMaxThreat: number
  weatherMinGain: number
  cureValue: number
  protectValue: number
  koBonus: number
  priorityKoBonus: number
  switchDangerFraction: number
  switchResistMax: number
  switchGain: number
  switchPenaltyPerUse: number
  maxSwitches: number
  recoilPenalty: number
  selfFaintPenalty: number
  noise: number
}

const other = (s: SideIndex): SideIndex => (s === 0 ? 1 : 0)

function fighter(e: BattleEngine, side: SideIndex, idx = e.activeIndex(side)): Fighter {
  const cr = e.party(side)[idx]
  const cap = e.init.levelCap
  const level = cap !== undefined && cap > 0 ? Math.min(cr.level, cap) : cr.level
  const stages = idx === e.activeIndex(side) ? toStages(e.stages(side)) : toStages(undefined)
  return { creature: cr, level, stats: calcStats({ speciesId: cr.speciesId, ivs: cr.ivs, level }, C), stages, critStageAdd: 0 }
}

const hpOf = (f: Fighter): number => f.creature.hp / f.stats.hp

/** Expected damage (absolute hp) of a move, accuracy and multi-hit included. */
function expectedDamage(att: Fighter, def: Fighter, mv: MoveDef, weather: string): number {
  if (!isDamaging(mv)) return 0
  const fixed = mv.effects.find((x) => x.kind === 'fixedDamage')
  const multi = mv.effects.find((x) => x.kind === 'multiHit')
  const hits = multi ? (multi.min + multi.max) / 2 : 1
  const sure = mv.accuracy === 0 || mv.effects.some((x) => x.kind === 'alwaysHit')
  const acc = sure ? 1 : Math.min(1, hitChance(att, def, mv, C) / PERCENT)
  if (fixed) {
    if (typeEffectiveness(mv.type, C.species[def.creature.speciesId].types, C) === 0) return 0
    return (fixed.amount === 'level' ? att.level : fixed.amount) * acc
  }
  const est = estimateDamage(att, def, mv, weather as never, C)
  if (est.effectiveness === 0) return 0
  const absorb = effectsOn(def.creature, 'absorbType', C).some((x) => x.types.includes(mv.type))
  return absorb ? 0 : est.avg * hits * acc
}

/** The foe's best expected damage per turn against `def` (as a fraction of def's remaining hp). */
function threat(e: BattleEngine, att: Fighter, def: Fighter): number {
  let best = 0
  for (const m of att.creature.moves) {
    const mv = C.moves[m.id]
    if (!mv || m.pp <= 0) continue
    best = Math.max(best, expectedDamage(att, def, mv, e.weather))
  }
  return best / Math.max(1, def.creature.hp)
}

const statusBlocked = (target: Creature, statusId: string): boolean =>
  (C.statusImmunities[statusId] ?? []).some((ty) => C.species[target.speciesId].types.includes(ty))
  || effectsOn(target, 'immune', C).some((x) => x.statuses?.includes(statusId))

interface PilotState { switches: [number, number]; lastWasSwitch: [boolean, boolean] }
const states = new WeakMap<BattleEngine, PilotState>()
const stateOf = (e: BattleEngine): PilotState => {
  let s = states.get(e)
  if (!s) { s = { switches: [0, 0], lastWasSwitch: [false, false] }; states.set(e, s) }
  return s
}

function scoreMove(e: BattleEngine, side: SideIndex, me: Fighter, foe: Fighter, mv: MoveDef, foeVol: string[], myVol: string[]): number {
  const foeHp = Math.max(1, foe.creature.hp)
  const myThreat = threat(e, foe, me)
  const meFaster = speedOf(me, C) >= speedOf(foe, C)
  if (isDamaging(mv)) {
    const dmg = expectedDamage(me, foe, mv, e.weather)
    let v = Math.min(1, dmg / foeHp)
    const sure = mv.accuracy === 0 || mv.effects.some((x) => x.kind === 'alwaysHit')
    const acc = sure ? 1 : Math.min(1, hitChance(me, foe, mv, C) / PERCENT)
    const lo = estimateDamage(me, foe, mv, e.weather, C).min
    if (lo >= foeHp && !mv.effects.some((x) => x.kind === 'fixedDamage')) {
      v += P.koBonus * acc
      if (mv.priority > 0 && !meFaster) v += P.priorityKoBonus
    }
    const recoil = mv.effects.find((x) => x.kind === 'recoil')
    if (recoil) v *= 1 - recoil.fraction * P.recoilPenalty
    if (mv.effects.some((x) => x.kind === 'selfFaint') && hpOf(me) > 0.3) v *= P.selfFaintPenalty
    // Secondary effects ride on top of the hit.
    for (const x of mv.effects) {
      if (x.kind === 'status' && x.target === 'enemy' && !foe.creature.status && !statusBlocked(foe.creature, x.status)) v += (P.statusValue[x.status] ?? 0) * x.chance / PERCENT * 0.5
      if (x.kind === 'volatile' && x.target === 'enemy' && !foeVol.includes(x.volatile)) v += (P.volatileValue[x.volatile] ?? 0) * x.chance / PERCENT * 0.5
      if (x.kind === 'drain') v += x.fraction * Math.min(1, dmg / foeHp) * 0.3
    }
    return v
  }
  let v = 0
  const survives = myThreat * P.boostSurviveHits < 1
  for (const x of mv.effects) {
    switch (x.kind) {
      case 'status':
        if (x.target === 'enemy' && !foe.creature.status && !statusBlocked(foe.creature, x.status) && hpOf(foe) > 0.35) {
          const speedMul = x.status === 'paralysis' && !meFaster ? 1.3 : 1
          v += (P.statusValue[x.status] ?? 0) * speedMul * x.chance / PERCENT
        }
        break
      case 'volatile': {
        const def = C.volatileById[x.volatile]
        if (x.target === 'enemy') {
          if (!foeVol.includes(x.volatile) && hpOf(foe) > 0.35) v += (P.volatileValue[x.volatile] ?? 0) * x.chance / PERCENT
        } else if (def?.protects) {
          const dotted = !!foe.creature.status || foeVol.includes('leech')
          if (dotted && hpOf(me) > 0.4) v += P.protectValue
        } else if (!myVol.includes(x.volatile) && survives) v += (P.volatileValue[x.volatile] ?? 0) * x.chance / PERCENT
        break
      }
      case 'stat':
        for (const [k, d] of Object.entries(x.stats)) {
          if (!d) continue
          const cur = me.stages[k as keyof typeof me.stages] ?? 0
          if (x.target === 'self' && d > 0 && survives && cur < P.boostStageCap && hpOf(me) > 0.5) v += (P.boostValue[k] ?? 0) * Math.min(d, P.boostStageCap - cur) / (1 + Math.max(0, cur))
          if (x.target === 'enemy' && d < 0 && (foe.stages[k as keyof typeof foe.stages] ?? 0) > -P.boostStageCap && !hasEffect(foe.creature, 'noStatDrops', C)) v += (P.dropValue[k] ?? 0) * Math.min(-d, 2)
        }
        break
      case 'heal': {
        const now = hpOf(me)
        const after = Math.min(1, now + x.fraction)
        // Healing is worth it when it turns a lethal hit into a survivable one, or outpaces the incoming damage.
        if (myThreat >= now && after > myThreat) v += P.healSaveValue
        else if (now < P.healBelow && myThreat < x.fraction * P.healOutpace) v += P.healValue * (after - now)
        break
      }
      case 'cureStatus':
        if (x.target === 'self' && me.creature.status) v += P.cureValue
        break
      case 'weather': {
        const w = C.weatherById[x.weather]
        if (!w || e.weather === x.weather) break
        const mine = e.party(side).filter((c) => c.hp > 0).flatMap((c) => C.species[c.speciesId].types)
        const theirs = e.party(other(side)).filter((c) => c.hp > 0).flatMap((c) => C.species[c.speciesId].types)
        const gain = mine.filter((t) => (w.powerMul[t] ?? 1) > 1).length - mine.filter((t) => (w.powerMul[t] ?? 1) < 1).length
        const loss = theirs.filter((t) => (w.powerMul[t] ?? 1) > 1).length - theirs.filter((t) => (w.powerMul[t] ?? 1) < 1).length
        if (gain - loss >= P.weatherMinGain && myThreat < P.weatherMaxThreat) v += P.weatherValue
        break
      }
      default:
        break
    }
  }
  return v
}

function bestSwitch(e: BattleEngine, side: SideIndex): { index: number; danger: number } | null {
  const foe = fighter(e, other(side))
  let best: { index: number; danger: number } | null = null
  e.party(side).forEach((cr, i) => {
    if (i === e.activeIndex(side) || cr.hp <= 0) return
    const f = fighter(e, side, i)
    const danger = threat(e, foe, f)
    if (!best || danger < best.danger) best = { index: i, danger }
  })
  return best
}

export function pilot(engine: BattleEngine, side: SideIndex, rng: Rng): BattleAction {
  const req = engine.request(side)
  const st = stateOf(engine)
  if (req.kind === 'switch') {
    // Forced replacement: the member that takes the least from the foe and hurts it the most.
    const foe = fighter(engine, other(side))
    let best = -1
    let bestScore = -Infinity
    engine.party(side).forEach((cr, i) => {
      if (i === engine.activeIndex(side) || cr.hp <= 0) return
      const f = fighter(engine, side, i)
      let offense = 0
      for (const m of cr.moves) {
        const mv = C.moves[m.id]
        if (mv && m.pp > 0) offense = Math.max(offense, expectedDamage(f, foe, mv, engine.weather))
      }
      const score = offense / Math.max(1, foe.creature.hp) - threat(engine, foe, f) + hpOf(f) * 0.3
      if (score > bestScore) { bestScore = score; best = i }
    })
    return { kind: 'switch', partyIndex: best }
  }
  const me = fighter(engine, side)
  const foe = fighter(engine, other(side))
  const myVol = engine.volatiles(side)
  const foeVol = engine.volatiles(other(side))
  const blocked = myVol.some((v) => C.volatileById[v]?.blocksStatusMoves)
  let bestIdx = -1
  let best = -Infinity
  me.creature.moves.forEach((m, i) => {
    const mv = C.moves[m.id]
    if (!mv || m.pp <= 0 || (blocked && mv.category === 'status')) return
    const s = scoreMove(engine, side, me, foe, mv, foeVol, myVol) * (1 + rng.next() * P.noise)
    if (s > best) { best = s; bestIdx = i }
  })
  if (req.kind === 'action' && req.canSwitch && st.switches[side] < P.maxSwitches && !st.lastWasSwitch[side]) {
    const danger = threat(engine, foe, me)
    const sw = bestSwitch(engine, side)
    // Leave when the foe threatens a KO-range hit, I cannot answer it, and a teammate takes it far better.
    if (sw && danger >= P.switchDangerFraction && sw.danger <= P.switchResistMax && sw.danger <= danger * P.switchGain && best < 0.5 + P.switchPenaltyPerUse * st.switches[side]) {
      st.switches[side] += 1
      st.lastWasSwitch[side] = true
      return { kind: 'switch', partyIndex: sw.index }
    }
  }
  st.lastWasSwitch[side] = false
  return { kind: 'move', moveIndex: Math.max(0, bestIdx) }
}

export type { StatKey }
