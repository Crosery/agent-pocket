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
  description: string
  value?: string
  polarity: BattleEffectPolarity
}

export interface BattleStatGlossary {
  key: string
  label: string
  description: string
}

const BATTLE_STAT_ORDER: readonly BattleStatKey[] = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva']

function multiplierText(stage: number): string {
  const value = stageMul(stage, 2)
  const formatted = value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return t('battleui.effects.multiplier', { n: formatted })
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
      description: def.desc,
      value: t('battleui.effects.stageValue', {
        sign: stage > 0 ? '+' : '-',
        n: Math.abs(stage),
        multiplier: multiplierText(stage),
      }),
      polarity: stage > 0 ? 'buff' : 'debuff',
    })
  }
  return rows
}

export function effectCount(snapshot: BattleStatusSnapshot): number {
  return Number(!!snapshot.status) + snapshot.volatiles.length + Object.values(snapshot.stages).filter(Boolean).length
}
