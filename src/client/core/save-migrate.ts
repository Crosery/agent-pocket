// Save migrations: raw (untrusted) save -> the current schema version (`save.version`) and content revision
// (`save.contentRev`), run before sanitizeSaveData. Schema steps (v1 -> v2 -> v3) and declarative content revisions
// (content/world/story/migrations.json) are pure over a copy and idempotent.
import type { Content } from '../../shared/content/index.ts'
import { CONTENT } from '../../shared/content/index.ts'
import {
  MIGRATIONS,
  type ContentMigrationOp,
  type MigrationCond,
  type MigrationsFile,
} from '../../shared/world/story.ts'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const truthy = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== 0 && v !== ''

function ensureObj(parent: Obj, key: string): Obj {
  const cur = parent[key]
  if (isObj(cur)) return cur
  const next: Obj = {}
  parent[key] = next
  return next
}

/** True when a raw save carries any player progress (as opposed to a brand-new unstarted save). */
export function hasSaveProgress(raw: Obj): boolean {
  if (typeof raw.playTimeSec === 'number' && raw.playTimeSec > 0) return true
  if (Array.isArray(raw.badges) && raw.badges.length > 0) return true
  if (Array.isArray(raw.party) && raw.party.length > 0) return true
  if (Array.isArray(raw.dexCaught) && raw.dexCaught.length > 0) return true
  if (isObj(raw.quests) && Object.keys(raw.quests).length > 0) return true
  if (isObj(raw.flags) && Object.keys(raw.flags).length > 0) return true
  if (isObj(raw.instances) && Object.keys(raw.instances).length > 0) return true
  return false
}

/**
 * Infers the content revision a raw save was last synced to when `raw.contentRev` is absent:
 * - schema v1 without `anchors`/`events` -> rev 0 (0.1.x);
 * - schema v1 with `anchors`/`events` -> rev 1 (0.2.0-rc.5);
 * - schema v2 -> rev 2 (0.2.0-rc.12);
 * - schema v3 with progress and no `contentRev` -> rev 3 (0.2.0-rc.16);
 * - brand-new or future saves -> `targetRev`.
 */
export function inferContentRev(raw: Obj, targetVer: number, targetRev: number): number {
  if (typeof raw.contentRev === 'number' && Number.isFinite(raw.contentRev)) {
    return raw.contentRev < 0 ? 0 : Math.floor(raw.contentRev)
  }
  const ver = typeof raw.version === 'number' && Number.isFinite(raw.version) ? Math.floor(raw.version) : 1
  if (ver <= 1) {
    const hasRc5Fields = 'anchors' in raw || 'events' in raw || 'research' in raw || 'legends' in raw
    return Math.min(targetRev, hasRc5Fields ? 1 : 0)
  }
  if (ver === 2) return Math.min(targetRev, 2)
  if (ver === 3 && ver <= targetVer) return hasSaveProgress(raw) ? Math.min(targetRev, 3) : targetRev
  return targetRev
}

export function migrationCondHolds(cond: MigrationCond | undefined, save: Obj): boolean {
  if (!cond) return true
  const flags = isObj(save.flags) ? save.flags : {}
  const quests = isObj(save.quests) ? save.quests : {}
  const bag = isObj(save.bag) ? save.bag : {}
  const badges = Array.isArray(save.badges) ? save.badges.length : 0
  const dexCaught = Array.isArray(save.dexCaught) ? save.dexCaught.length : 0

  if (cond.flag?.some((f) => !truthy(flags[f]))) return false
  if (cond.noFlag?.some((f) => truthy(flags[f]))) return false
  if (cond.flagEquals) {
    for (const [k, want] of Object.entries(cond.flagEquals)) if (flags[k] !== want) return false
  }
  if (cond.minBadges !== undefined && badges < cond.minBadges) return false
  if (cond.maxBadges !== undefined && badges > cond.maxBadges) return false
  if (cond.minDexCaught !== undefined && dexCaught < cond.minDexCaught) return false
  if (cond.questStarted?.some((q) => !isObj(quests[q]))) return false
  if (cond.questNotStarted?.some((q) => isObj(quests[q]))) return false
  if (cond.questDone?.some((q) => !(isObj(quests[q]) && quests[q].done === true))) return false
  if (cond.questNotDone?.some((q) => isObj(quests[q]) && quests[q].done === true)) return false
  if (cond.questStageAtLeast) {
    for (const [q, min] of Object.entries(cond.questStageAtLeast)) {
      const st = isObj(quests[q]) && typeof quests[q].stage === 'number' ? quests[q].stage : -1
      if (st < min) return false
    }
  }
  if (cond.questStageBelow) {
    for (const [q, max] of Object.entries(cond.questStageBelow)) {
      const st = isObj(quests[q]) && typeof quests[q].stage === 'number' ? quests[q].stage : -1
      if (!(st >= 0 && st < max)) return false
    }
  }
  if (cond.hasItem?.some((id) => !(typeof bag[id] === 'number' && bag[id] > 0))) return false
  if (cond.lacksItem?.some((id) => typeof bag[id] === 'number' && bag[id] > 0)) return false
  return true
}

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
  const flags = ensureObj(save, 'flags')
  if (!flags[q.flags.legacyGift]) {
    const bag = ensureObj(save, 'bag')
    for (const [id, qty] of Object.entries(q.legacyGift)) bag[id] = (typeof bag[id] === 'number' ? (bag[id] as number) : 0) + qty
    flags[q.flags.legacyGift] = true
  }
}

/**
 * v2 -> v3 (the new prologue shifts every main stage from 1 up by 7): a save that already chose a starter keeps the whole
 * world open (`ds:gateOpen`) and gets the DeepSeek simulator terminal as an optional quest (`ds:legacy`).
 */
function v2to3(save: Obj, _c: Content, mig: MigrationsFile): void {
  const flags = ensureObj(save, 'flags')
  const quests = isObj(save.quests) ? save.quests : null
  const main = quests && isObj(quests.main) ? quests.main : null
  const badges = Array.isArray(save.badges) ? save.badges : []

  if (flags.starter) {
    flags['ds:gateOpen'] = true
    flags['ds:legacy'] = true
    flags['ds:certFull'] = true
    flags['ds:stamp:starter'] = true
    flags['ds:stamp:types'] = true
    flags['ds:stamp:catch'] = true
    flags['lesson:typeChart'] = true
  }

  if (badges.length > 0) {
    flags['lic:settled'] = true
  }

  const shift = mig.mainStage?.['3']
  if (shift && main && typeof main.stage === 'number' && main.stage >= shift.from) {
    main.stage += shift.add
  }

  const ruins = quests && isObj(quests['sq-ruins']) ? quests['sq-ruins'] : null
  if (ruins && !ruins.done && flags['sq-ruins:a'] && flags['sq-ruins:b'] && typeof ruins.stage === 'number' && ruins.stage < 2) {
    ruins.stage = 2
  }
}

/** Schema steps by the version they produce, applied in ascending order while `save.version < c.config.save.version`. */
const STEPS: Record<number, (save: Obj, c: Content, mig: MigrationsFile) => void> = { 2: v1to2, 3: v2to3 }

function applyMigrationOp(
  save: Obj,
  step: ContentMigrationOp,
  c: Content,
  mig: MigrationsFile,
  shiftedMainInSchema: boolean,
): void {
  const flags = ensureObj(save, 'flags')
  switch (step.op) {
    case 'setFlags':
      for (const k of step.clear ?? []) delete flags[k]
      for (const [k, v] of Object.entries(step.set ?? {})) flags[k] = v
      break
    case 'giveItems': {
      if (truthy(flags[step.onceFlag])) break
      const bag = ensureObj(save, 'bag')
      for (const [id, qty] of Object.entries(step.items)) {
        if (!c.items[id] || !(qty > 0)) continue
        bag[id] = (typeof bag[id] === 'number' && Number.isFinite(bag[id]) ? Math.max(0, Math.floor(bag[id] as number)) : 0) + Math.floor(qty)
      }
      flags[step.onceFlag] = true
      break
    }
    case 'giveMoney':
      if (truthy(flags[step.onceFlag])) break
      save.money = (typeof save.money === 'number' && Number.isFinite(save.money) ? Math.max(0, Math.floor(save.money)) : 0) + Math.floor(step.amount)
      flags[step.onceFlag] = true
      break
    case 'startQuest': {
      const quests = ensureObj(save, 'quests')
      if (isObj(quests[step.quest]) || truthy(flags[`${step.quest}:done`])) break
      quests[step.quest] = { stage: Math.max(0, Math.floor(step.stage ?? 0)), done: false }
      if (step.trackIfNone && typeof save.trackedQuest !== 'string') save.trackedQuest = step.quest
      break
    }
    case 'shiftQuestStages': {
      if (step.quest === 'main' && shiftedMainInSchema) break
      if (step.onceFlag && truthy(flags[step.onceFlag])) break
      const quests = isObj(save.quests) ? save.quests : null
      const q = quests && isObj(quests[step.quest]) ? (quests[step.quest] as Obj) : null
      if (q && typeof q.stage === 'number' && q.stage >= step.from) {
        q.stage = Math.max(0, Math.floor(q.stage + step.add))
      }
      if (step.onceFlag) flags[step.onceFlag] = true
      break
    }
    case 'reopenQuest': {
      const quests = ensureObj(save, 'quests')
      const q = isObj(quests[step.quest]) ? (quests[step.quest] as Obj) : null
      if (!q || typeof q.stage !== 'number') break
      if ((q.done === true && q.stage >= step.fromStage) || (q.done === true && q.stage >= step.newStage)) {
        if (step.archiveFlag) flags[step.archiveFlag] = true
        flags[`${mig.noticeFlags.questRewardPrefix}${step.quest}`] = true
        for (const f of step.clearFlags ?? []) delete flags[f]
        for (const [k, v] of Object.entries(step.setFlags ?? {})) flags[k] = v
        q.stage = Math.max(q.stage, step.newStage)
        q.done = false
        if (typeof save.trackedQuest !== 'string') save.trackedQuest = step.quest
      }
      break
    }
    case 'cleanEvents': {
      if (!isObj(save.events)) break
      const events = save.events
      for (const id of step.dropIds ?? []) delete events[id]
      for (const id of step.resetActiveIds ?? []) {
        const st = events[id]
        if (isObj(st)) delete st.activeUntil
      }
      break
    }
  }
}

export function migrateSave(raw: unknown, c: Content = CONTENT, mig: MigrationsFile = MIGRATIONS): unknown {
  if (!isObj(raw) || typeof raw.version !== 'number' || !Number.isFinite(raw.version) || raw.version < 1) return raw
  const targetVer = c.config.save.version
  const targetRev = c.config.save.contentRev ?? mig.contentRev
  const rawVer = Math.floor(raw.version)
  const fromRev = inferContentRev(raw, targetVer, targetRev)

  if (rawVer === targetVer && raw.contentRev === targetRev) return raw

  const save = structuredClone(raw)
  if (rawVer > targetVer && fromRev >= targetRev) {
    save.version = targetVer
    save.contentRev = targetRev
    return save
  }

  let shiftedMainInSchema = false
  if (rawVer < targetVer) {
    for (let v = Math.max(1, rawVer) + 1; v <= targetVer; v++) {
      if (v === 3) shiftedMainInSchema = true
      STEPS[v]?.(save, c, mig)
    }
    save.version = targetVer
  } else if (rawVer > targetVer) {
    save.version = targetVer
  }

  if (fromRev < targetRev) {
    const ordered = (mig.revisions ?? [])
      .filter((r) => r.rev > fromRev && r.rev <= targetRev)
      .slice()
      .sort((a, b) => a.rev - b.rev)
    for (const rev of ordered) {
      for (const step of rev.steps ?? []) {
        if (migrationCondHolds(step.when, save)) {
          applyMigrationOp(save, step, c, mig, shiftedMainInSchema)
        }
      }
    }
    const progressed = hasSaveProgress(raw) || rawVer < targetVer || (typeof raw.contentRev === 'number' && raw.contentRev < targetRev)
    if (progressed) {
      const flags = ensureObj(save, 'flags')
      if (typeof flags[mig.noticeFlags.fromRev] !== 'number') flags[mig.noticeFlags.fromRev] = fromRev
      flags[mig.noticeFlags.pendingRev] = targetRev
    }
  }

  save.contentRev = targetRev
  return save
}
