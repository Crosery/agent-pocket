// Formula structure constants and AI tuning for the battle engine and creature math.
// Data lives in content/battle_rules.json; this module only declares its shape.
import type { MoveAnim } from '../types.ts'
import rulesJson from '../../../content/battle_rules.json' with { type: 'json' }

export interface BattleRules {
  /** hp = floor((baseMul*B + IV) * L / levelDivisor) + L + hpFlat ; other = ... + otherFlat */
  statFormula: { baseMul: number; levelDivisor: number; hpFlat: number; otherFlat: number }
  /** exp(level) = config.growth[g].mul * level^growthExponent */
  growthExponent: number
  /** base = floor(floor(floor(levelMul*L/levelDivisor + levelAdd) * P * A / D) / divisor) + add */
  damageFormula: { levelMul: number; levelDivisor: number; levelAdd: number; divisor: number; add: number; minDamage: number }
  /** Stage multiplier: (base+s)/base for s >= 0, base/(base-s) otherwise. */
  stageBase: { stat: number; accEva: number }
  /** Crit stages granted by a move's 'highCrit' effect. */
  highCritStages: number
  /** Smallest non-zero hp change from fractional damage/heal (chip, dot, recoil, drain, heal). */
  minHpChange: number
  /** a = ((hpMaxMul*M - hpCurMul*H) * rate * ball) / (hpMaxMul*M) * status ; caught outright when a >= rateMax */
  catchFormula: { hpMaxMul: number; hpCurMul: number; rateMax: number }
  /** Escape roll range: success when int(0, runRollMax-1) < odds. */
  runRollMax: number
  /** Resolution order of action kinds within a turn (moves are further ordered by priority and speed). */
  actionOrder: ('switch' | 'item' | 'run' | 'move')[]
  /** Synthetic move used when no move is usable. Power/recoil come from config.battle.struggle. */
  struggle: { moveId: string; anim: MoveAnim; displayType: string; priority: number }
  creature: { minLevel: number; friendshipMax: number; nicknameMaxLen: number; uidLength: number; idMaxLen: number }
  ai: AiTuning
}

export interface AiTuning {
  /** AI level (0..3) of wild creatures indexed by rarity order (clamped to the last entry). */
  wildLevelByRarityOrder: number[]
  /** AI level when a side has no aiLevel and is not wild. */
  defaultLevel: number
  /** Lowest AI level (0..3) that enables each behaviour. */
  featureLevel: {
    /** Score moves (effectiveness, STAB, power) instead of picking randomly. */
    scoredMoves: number
    /** Replace fainted creatures in party order instead of randomly. */
    orderedReplacement: number
    /** Evaluate status moves by their effects (otherwise basicStatusScore). */
    statusMoves: number
    items: number
    switching: number
    /** Replace fainted creatures by type matchup. */
    matchupReplacement: number
    /** Score by estimated damage share of the foe's hp, seek KOs. */
    damageEstimate: number
  }
  /** Random score jitter per AI level: score *= 1 + rand * noise[level]. */
  noise: number[]
  /** Score of any status move below featureLevel.statusMoves. */
  basicStatusScore: number
  statusInflictScore: number
  volatileInflictScore: number
  selfVolatileScore: number
  protectScore: number
  selfBoostScore: number
  foeDropScore: number
  boostStageCap: number
  boostMinHpRatio: number
  healMoveBelowHpRatio: number
  healMoveScore: number
  cureStatusScore: number
  weatherScore: number
  healItemBelowHpRatio: number
  healItemChance: number
  cureItemChance: number
  switchThreatEffectiveness: number
  switchChance: number
  /** Level 3: score of a move dealing 100% of the foe's remaining hp. */
  damageScore: number
  koBonus: number
  priorityKoBonus: number
  selfFaintMaxHpRatio: number
  selfFaintPenalty: number
  recoilPenalty: number
}

export const RULES: BattleRules = rulesJson as unknown as BattleRules
