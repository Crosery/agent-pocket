// Pure battle-state descriptions shared by the compact HUD and the readable inspector.
// The engine keeps the values terse (ids and stage deltas); this module turns them into player-facing rows.
import type { BattleStatKey } from '../../shared/types.ts'
import { stageMul } from '../../shared/battle/formulas.ts'
import { CONTENT, t } from '../../shared/content/index.ts'

export type BattleEffectGroup = 'ability' | 'status' | 'volatile' | 'stage'
export type BattleEffectPolarity = 'buff' | 'debuff' | 'neutral'

export interface BattleStatusSnapshot {
  name: string
  abilityId: string | null
  types: readonly string[]
  status: string | null
  volatiles: readonly string[]
  stages: Partial<Record<BattleStatKey, number>>
}

export interface BattleEffectDetail {
  id: string
  group: BattleEffectGroup
  label: string
  /** Compact form for the HUD tag row ("推理+2"); the label for statuses and volatiles. */
  short: string
  description: string
  value?: string
  /** Stage rows only: signed step ("+2") and the multiplier it gives ("×2"), for the compact stage chips. */
  delta?: string
  factor?: string
  polarity: BattleEffectPolarity
}

export interface BattleStatGlossary {
  key: string
  label: string
  description: string
}

const BATTLE_STAT_ORDER: readonly BattleStatKey[] = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva']

function factorNumber(stage: number): string {
  return stageMul(stage, 2).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function volatilePolarity(id: string): BattleEffectPolarity {
  const def = CONTENT.volatileById[id]
  return def?.protects || (def?.critStageAdd ?? 0) > 0 ? 'buff' : 'debuff'
}

export function battleStatGlossary(): BattleStatGlossary[] {
  return CONTENT.stats.map((stat) => ({
    key: stat.key,
    label: stat.nameZh,
    description: stat.desc,
  }))
}

export function describeBattleEffects(snapshot: BattleStatusSnapshot): BattleEffectDetail[] {
  const rows: BattleEffectDetail[] = []
  if (snapshot.abilityId) {
    const ability = CONTENT.abilities[snapshot.abilityId]
    if (ability) rows.push({
      id: `ability:${snapshot.abilityId}`,
      group: 'ability',
      label: ability.nameZh,
      short: ability.nameZh,
      description: ability.description,
      polarity: 'neutral',
    })
  }
  if (snapshot.status) {
    const def = CONTENT.statusById[snapshot.status]
    if (def) rows.push({
      id: `status:${snapshot.status}`,
      group: 'status',
      label: def.nameZh,
      short: def.nameZh,
      description: t(`battleui.effects.status.${snapshot.status}`),
      polarity: 'debuff',
    })
  }
  for (const id of snapshot.volatiles) {
    const def = CONTENT.volatileById[id]
    if (!def) continue
    rows.push({
      id: `volatile:${id}`,
      group: 'volatile',
      label: def.nameZh,
      short: def.nameZh,
      description: t(`battleui.effects.volatile.${id}`),
      polarity: volatilePolarity(id),
    })
  }
  for (const stat of BATTLE_STAT_ORDER) {
    const stage = snapshot.stages[stat] ?? 0
    if (!stage) continue
    const def = CONTENT.statByKey[stat]
    if (!def) continue
    rows.push({
      id: `stage:${stat}`,
      group: 'stage',
      label: def.nameZh,
      short: t('battleui.hud.stage', { stat: def.nameZh, sign: t(stage > 0 ? 'battleui.hud.plus' : 'battleui.hud.minus'), n: Math.abs(stage) }),
      description: def.desc,
      value: t('battleui.effects.stageValue', {
        sign: stage > 0 ? '+' : '-',
        n: Math.abs(stage),
        multiplier: t('battleui.effects.multiplier', { n: factorNumber(stage) }),
      }),
      delta: `${stage > 0 ? '+' : '-'}${Math.abs(stage)}`,
      factor: t('battleui.effects.factor', { n: factorNumber(stage) }),
      polarity: stage > 0 ? 'buff' : 'debuff',
    })
  }
  return rows
}

export function effectCount(snapshot: BattleStatusSnapshot): number {
  return Number(!!snapshot.status) + snapshot.volatiles.length + Object.values(snapshot.stages).filter(Boolean).length
}

/** Buffs and debuffs among the status, volatile and stage effects (the passive ability is neither). */
export function effectBalance(snapshot: BattleStatusSnapshot): { buff: number; debuff: number } {
  let buff = 0, debuff = 0
  for (const row of describeBattleEffects(snapshot)) {
    if (row.polarity === 'buff') buff++
    else if (row.polarity === 'debuff') debuff++
  }
  return { buff, debuff }
}

/** HUD tag order: the status condition first (it decides whether the creature can act), then gains, then losses. */
export function hudEffects(snapshot: BattleStatusSnapshot): BattleEffectDetail[] {
  const rows = describeBattleEffects(snapshot).filter((row) => row.group !== 'ability')
  const rank = (row: BattleEffectDetail) => (row.group === 'status' ? 0 : row.polarity === 'buff' ? 1 : 2)
  return rows.map((row, i) => ({ row, i })).sort((a, b) => rank(a.row) - rank(b.row) || a.i - b.i).map(({ row }) => row)
}
