// Save migrations: raw (untrusted) save -> the current schema version, run before sanitizeSaveData. Each step is a
// pure function over a copy and is idempotent, so a save migrated twice (or importing a current one) comes out the same.
import type { Content } from '../../shared/content/index.ts'
import { CONTENT } from '../../shared/content/index.ts'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** v1 -> v2: every creature gets a nature / origin / finetune count, and the one-time persona-card gift is handed out. */
function v1to2(save: Obj, c: Content): void {
  const q = c.quality
  const fix = (cr: unknown) => {
    if (!isObj(cr)) return
    if (cr.nature === undefined || cr.nature === null) cr.nature = q.legacyNature
    if (cr.origin === undefined || cr.origin === null) {
      const boss = typeof cr.speciesId === 'string' ? c.bossBySpecies[cr.speciesId] : undefined
      cr.origin = { kind: 'legacy', ...(boss ? { boss: boss.id } : {}) }
    }
    if (cr.finetuned === undefined || cr.finetuned === null) cr.finetuned = 0
  }
  if (Array.isArray(save.party)) save.party.forEach(fix)
  if (Array.isArray(save.boxes)) for (const box of save.boxes) if (Array.isArray(box)) box.forEach(fix)
  const flags = isObj(save.flags) ? save.flags : (save.flags = {}) as Obj
  if (!flags[q.flags.legacyGift]) {
    const bag = isObj(save.bag) ? save.bag : (save.bag = {}) as Obj
    for (const [id, qty] of Object.entries(q.legacyGift)) bag[id] = (typeof bag[id] === 'number' ? (bag[id] as number) : 0) + qty
    flags[q.flags.legacyGift] = true
  }
}

/** Steps by the version they produce, applied in ascending order while the save is older than the content's version. */
const STEPS: Record<number, (save: Obj, c: Content) => void> = { 2: v1to2 }

export function migrateSave(raw: unknown, c: Content = CONTENT): unknown {
  if (!isObj(raw) || typeof raw.version !== 'number') return raw
  const target = c.config.save.version
  if (raw.version >= target) return raw
  const save = structuredClone(raw)
  for (let v = Math.max(1, Math.floor(raw.version)) + 1; v <= target; v++) STEPS[v]?.(save, c)
  save.version = target
  return save
}
