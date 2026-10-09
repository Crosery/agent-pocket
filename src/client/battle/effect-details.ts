// Pure battle-state descriptions shared by the compact HUD and the readable inspector.
// The engine keeps the values terse (ids and stage deltas); this module turns them into player-facing rows.
import type { BattleStatKey } from '../../shared/types.ts'
import { stageMul } from '../../shared/battle/formulas.ts'
import { CONTENT, t } from '../../shared/content/index.ts'

export type BattleEffectGroup = 'ability' | 'status' | 'volatile' | 'stage'
export type BattleEffectPolarity = 'buff' | 'debuff' | 'neutral'

export interface BattleStatusSnapshot {
  name: string
  /** Shown in the status sheet's head; the HUD windows carry their own. */
  level?: number
  hp?: number
  maxHp?: number
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

const BATTLE_STAT_ORDER: readonly BattleStatKey[] = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva']

function factorNumber(stage: number): string {
  return stageMul(stage, 2).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function volatilePolarity(id: string): BattleEffectPolarity {
  const def = CONTENT.volatileById[id]
  return def?.protects || (def?.critStageAdd ?? 0) > 0 ? 'buff' : 'debuff'
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

// ---- the status sheet (effects-panel.ts): what each side is under right now, one short line each ----------------

export interface SheetChip {
  id: string
  label: string
  polarity: BattleEffectPolarity
  /** What the readout line shows when the chip is focused / tapped: "label：description". */
  tip: string
  /** Stage chips: signed step and multiplier ("▼1", "×0.67"). */
  delta?: string
  factor?: string
}

export interface SideSheet {
  /** The status condition with its one-line effect. */
  status: { id: string; label: string; line: string; tip: string } | null
  /** Non-zero stat stages in stat order. */
  stages: SheetChip[]
  volatiles: SheetChip[]
  /** The passive ability: name and its description (one line, ellipsised by the layout; the readout shows it whole). */
  ability: { label: string; line: string; tip: string } | null
  /** No status, stage or volatile. */
  quiet: boolean
}

export function sideSheet(snapshot: BattleStatusSnapshot): SideSheet {
  const tip = (label: string, description: string) => t('battleui.effects.tip', { label, description })
  const sheet: SideSheet = { status: null, stages: [], volatiles: [], ability: null, quiet: true }
  for (const row of describeBattleEffects(snapshot)) {
    const id = row.id.slice(row.id.indexOf(':') + 1)
    if (row.group === 'ability') sheet.ability = { label: row.label, line: row.description, tip: tip(row.label, row.description) }
    else if (row.group === 'status') sheet.status = { id, label: row.label, line: t(`battleui.effects.statusShort.${id}`), tip: tip(row.label, row.description) }
    else if (row.group === 'volatile') sheet.volatiles.push({ id, label: row.label, polarity: row.polarity, tip: tip(row.label, row.description) })
    else sheet.stages.push({
      id, label: row.label, polarity: row.polarity, tip: tip(row.label, `${row.description} ${row.value ?? ''}`.trim()),
      delta: `${row.polarity === 'buff' ? '▲' : '▼'}${row.delta?.slice(1) ?? ''}`, factor: row.factor,
    })
  }
  sheet.quiet = !sheet.status && !sheet.stages.length && !sheet.volatiles.length
  return sheet
}

export interface WeatherSheet { id: string; label: string; color: string; line: string }

/** The weather as one line: which types it boosts or weakens and the chip damage it deals each turn. */
export function weatherSheet(id: string | null | undefined): WeatherSheet | null {
  const def = id ? CONTENT.weatherById[id] : undefined
  if (!def) return null
  const byMul = new Map<number, string[]>()
  for (const [type, mul] of Object.entries(def.powerMul ?? {})) {
    const name = CONTENT.typeById[type]?.nameZh ?? type
    byMul.set(mul, [...(byMul.get(mul) ?? []), name])
  }
  const parts = [...byMul].sort((a, b) => b[0] - a[0]).map(([mul, names]) => t('battleui.effects.weatherPower', { types: names.join(t('battleui.effects.typesJoin')), n: String(mul) }))
  if (def.heal) parts.push(t('battleui.effects.weatherHeal', { types: def.heal.types.map((x) => CONTENT.typeById[x]?.nameZh ?? x).join(t('battleui.effects.typesJoin')), n: `1/${Math.round(1 / def.heal.fraction)}` }))
  if (def.chip) parts.push(t('battleui.effects.weatherChip', { n: `1/${Math.round(1 / def.chip.fraction)}` }))
  return { id: def.id, label: def.nameZh, color: def.color, line: parts.join(t('battleui.effects.weatherJoin')) }
}
