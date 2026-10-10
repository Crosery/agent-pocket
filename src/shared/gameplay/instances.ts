// Boss instances (content/world/instances.json): lookup by boss and the per-save progress record. Pure helpers shared
// by the client flows (world/battles.ts, battle/capture.ts), the save sanitizer and tests.
import type { InstanceDef, InstanceProgress, SaveData } from '../types.ts'
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
