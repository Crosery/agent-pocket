// Difficulty tiers of a boss (content/bosses.json `tiers`): folds one tier into a plain BossDef so the engine never has
// to know tiers exist. Pure; the input definition is never modified.
import type { BossDef, BossRule, BossRuleTweak, BossTakenMul, BossTierDef } from '../types.ts'

export interface TierPick {
  /** Species of the player's lead creature: selects `byStarter`. */
  starter?: string
  /** Assist ("减负") numbers apply on top of the tier. */
  assist?: boolean
}

/** The tier fields that can appear at every layer (the tier itself, byStarter, assist, assist.byStarter). */
type Layer = Omit<BossTierDef, 'level' | 'byStarter' | 'assist'>

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** takenMul given as one number replaces the multiplier of the rule's first entry (its note and filters stay). */
function tweakRule(rule: BossRule, tweak: BossRuleTweak): BossRule {
  const out = copy(rule)
  if (tweak.dealtMul !== undefined) out.dealtMul = tweak.dealtMul
  if (tweak.takenMul !== undefined) {
    const first: BossTakenMul = out.takenMul?.[0] ?? { mul: tweak.takenMul }
    out.takenMul = [{ ...first, mul: tweak.takenMul }, ...(out.takenMul?.slice(1) ?? [])]
  }
  return out
}

function applyLayer(def: BossDef, layer: Layer): void {
  const form = def.forms[def.initialForm]
  if (layer.expMul !== undefined) def.expMul = layer.expMul
  if (layer.statMul) form.statMul = { ...form.statMul, ...layer.statMul }
  if (layer.moves) form.moves = [...layer.moves]
  if (layer.pattern) form.pattern = layer.pattern.map((p) => ({ ...p }))
  if (layer.rules) {
    form.rules = (form.rules ?? []).map((r) => (layer.rules![r.id] ? tweakRule(r, layer.rules![r.id]) : r))
  }
  if (layer.addRules) {
    const have = new Set((form.rules ?? []).map((r) => r.id))
    form.rules = [...(form.rules ?? []), ...copy(layer.addRules).filter((r) => !have.has(r.id))]
  }
  if (layer.residualMul !== undefined) def.residualMul = layer.residualMul
  if (layer.enrage && def.enrage) def.enrage = { ...def.enrage, ...layer.enrage }
}

/**
 * The boss as fought in `tierId`: the tier's numbers merged over the base definition, then `byStarter[starter]`, then
 * (when `assist`) the tier's `assist` layer and its own `byStarter`. Unknown tiers return the definition unchanged.
 * `level` becomes the tier's level; `reward` is emptied (see below).
 */
export function resolveBossDef(def: BossDef, tierId: string | undefined, pick: TierPick = {}): BossDef {
  const tier = tierId ? def.tiers?.[tierId] : undefined
  if (!tier) return def
  const out = copy(def)
  delete out.tiers
  out.level = tier.level
  // A tier fight pays nothing itself: the boss instance (content/world/instances.json) hands out its rewards.
  out.reward = {}
  applyLayer(out, tier)
  if (pick.starter && tier.byStarter?.[pick.starter]) applyLayer(out, tier.byStarter[pick.starter])
  if (pick.assist && tier.assist) {
    applyLayer(out, tier.assist)
    if (pick.starter && tier.assist.byStarter?.[pick.starter]) applyLayer(out, tier.assist.byStarter[pick.starter])
  }
  return out
}

/** Level the boss creature is built at in `tierId` (the definition's own level when the tier is unknown). */
export const tierLevel = (def: BossDef, tierId: string | undefined): number => (tierId ? def.tiers?.[tierId]?.level : undefined) ?? def.level
