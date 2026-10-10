// Boss instances (content/world/instances.json): lookup by boss and the per-save progress record. Pure helpers shared
// by the client flows (world/battles.ts, battle/capture.ts), the save sanitizer and tests.
import type { BattleSummary, InstanceDef, InstanceDefaults, InstanceLossHint, InstanceProgress, SaveData } from '../types.ts'
import { CONTENT, type Content } from '../content/index.ts'
import { GAMEPLAY } from './data.ts'

/** The instance that runs `bossId`'s fights (first match), or null. */
export function instanceOfBoss(bossId: string): { id: string; def: InstanceDef } | null {
  for (const [id, def] of Object.entries(GAMEPLAY.instances)) if (def.boss === bossId) return { id, def }
  return null
}

export const emptyProgress = (): InstanceProgress => ({ clears: {}, captures: {}, runSeq: 0, losses: {} })

/** The progress of one instance, created in the save on first use. */
export function progressOf(save: Pick<SaveData, 'instances'>, instanceId: string): InstanceProgress {
  save.instances ??= {}
  return (save.instances[instanceId] ??= emptyProgress())
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonNeg = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 0xffffffff) : 0)

function counts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isObj(raw)) return out
  for (const [k, v] of Object.entries(raw)) if (/^[A-Za-z0-9_-]{1,40}$/.test(k)) out[k] = nonNeg(v)
  return out
}

/** Cleans untrusted instance progress: known ids only, every counter a non-negative integer. */
export function sanitizeInstances(raw: unknown): Record<string, InstanceProgress> {
  const out: Record<string, InstanceProgress> = {}
  if (!isObj(raw)) return out
  for (const [id, v] of Object.entries(raw)) {
    if (!GAMEPLAY.instances[id] || !isObj(v)) continue
    out[id] = { clears: counts(v.clears), captures: counts(v.captures), runSeq: nonNeg(v.runSeq), losses: counts(v.losses) }
  }
  return out
}

function lossHintHolds(cond: InstanceLossHint['if'], summary: BattleSummary | undefined, bag: Readonly<Record<string, number>>, c: Content): boolean {
  if (!cond) return true
  if (!summary) return false
  if (cond.peakDamageShare !== undefined) {
    const byState = summary.damageByMeterState.tide ?? Object.values(summary.damageByMeterState)[0] ?? {}
    const peak = byState[0] ?? 0
    const total = Object.values(byState).reduce((a, b) => a + b, 0)
    if (!(total > 0 && peak / total >= cond.peakDamageShare)) return false
  }
  if (cond.unusedBaitTag !== undefined) {
    const tag = cond.unusedBaitTag
    const had = Object.entries(bag).some(([id, n]) => n > 0 && c.items[id]?.effect.kind === 'bait' && c.items[id].effect.tag === tag)
    if (!had || summary.baitTagsUsed.includes(tag)) return false
  }
  if (cond.faintedInMeterState !== undefined) {
    const f = cond.faintedInMeterState
    if (!((summary.faintedByMeterState[f.meter]?.[f.value] ?? 0) >= f.atLeast)) return false
  }
  if (cond.noHealItem !== undefined && (summary.healItemsUsed === 0) !== cond.noHealItem) return false
  if (cond.enraged !== undefined && summary.enraged !== cond.enraged) return false
  return true
}

/** Picks the first matching post-loss analysis line key for an instance (falls back to `boss.<id>.loss.default`). */
export function pickLossHint(
  inst: Pick<InstanceDef, 'boss' | 'lossHints'>, summary: BattleSummary | undefined, bag: Readonly<Record<string, number>>, c: Content = CONTENT,
): string {
  for (const h of inst.lossHints ?? []) if (lossHintHolds(h.if, summary, bag, c)) return h.text
  return `boss.${inst.boss}.loss.default`
}

/** Whether the instance should offer assist ("减负") mode after a loss: N losses in a row, or an early wipe (`assistEarly`). */
export function shouldOfferAssist(defaults: InstanceDefaults, losses: number, summary?: BattleSummary): boolean {
  if (losses >= defaults.assistAfterLosses) return true
  const early = defaults.assistEarly
  if (!early || !summary) return false
  return losses >= early.losses && summary.foeHpLeft >= early.foeHpLeftAtLeast && summary.turns <= early.maxTurns
}
