// Load-time save reconciliation and one-time content update notices.
// Reconciles derived progression state from authoritative save facts (badges, flags, contracted/defeated bosses,
// side-quest / legend-chain / bounty flags, and expired or retired world events) without ever regressing progress
// or re-granting one-time rewards.
import type { Content } from '../../shared/content/index.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import type { SaveData, World } from '../../shared/types.ts'
import type { GameContext } from '../contracts.ts'
import { GAMEPLAY } from '../../shared/gameplay/data.ts'
import { activeEvents, dayOf } from '../../shared/gameplay/events.ts'
import { instanceOfBoss, progressOf } from '../../shared/gameplay/instances.ts'
import {
  MIGRATIONS,
  STORY_CONTENT,
  starterSpecies,
  type ContentRevision,
  type MigrationsFile,
} from '../../shared/world/story.ts'
import { migrationCondHolds } from './save-migrate.ts'

const truthy = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== 0 && v !== ''

const BOSS_WON_PREFIX = 'boss:won:'

function inferStarterSpeciesId(save: SaveData, c: Content): string | null {
  const starters = starterSpecies(c)
  const byFamily = new Map(starters.map((s) => [s.family, s.id]))
  for (const cr of [...save.party, ...save.boxes.flat()]) {
    const fam = c.species[cr.speciesId]?.family
    if (fam && byFamily.has(fam)) return byFamily.get(fam)!
  }
  return starters[0]?.id ?? null
}

/**
 * Reconciles a sanitized `SaveData` against the generated `World` and `Content`:
 * 1. Badges <-> `badge:<type>` and `trainer:<leader>` flags;
 * 2. Boss cards and instance progress <-> `boss:won:<id>`, `instances[id].clears`, and prologue clear flags;
 * 3. Prologue gates (`ds:gateOpen`, `ds:certFull`, `ds:legacy`) for saves that already progressed past the opening;
 * 4. Main quest stage (`quests.main`) and side / legend / bounty quests from flags and badges, reopening quests
 *    only when new stages were appended past a previously completed final stage;
 * 5. World event state (`save.events`) and runtime `evspawn:` / `evitem:` / `trainer:ev:` flags for expired/retired events.
 *
 * Purely monotonic and idempotent: running `reconcileSave` twice yields an identical `SaveData`.
 */
export function reconcileSave(
  save: SaveData,
  world: World | null,
  c: Content = CONTENT,
  mig: MigrationsFile = MIGRATIONS,
): SaveData {
  const trainerPrefix = STORY_CONTENT.meta.flags.trainerWon

  // 1. Badges <-> badge:<type> & gym leader trainer flags
  if (world) {
    for (const b of world.badges) {
      const badgeFlag = `badge:${b.type}`
      const leaderFlag = `${trainerPrefix}${b.leader}`
      const hasBadge = save.badges.includes(b.id)
      const hasFlag = truthy(save.flags[badgeFlag]) || (Boolean(b.leader) && truthy(save.flags[leaderFlag]))
      if (hasBadge || hasFlag) {
        if (!hasBadge) save.badges.push(b.id)
        save.flags[badgeFlag] = true
        if (b.leader && world.trainers[b.leader]) save.flags[leaderFlag] = true
      }
    }
  }

  // 2. Boss creatures & instance clears <-> boss flags and story completion
  for (const cr of [...save.party, ...save.boxes.flat()]) {
    const bossId = cr.origin?.boss ?? c.bossBySpecies[cr.speciesId]?.id
    if (!bossId || !c.bosses[bossId]) continue
    save.flags[`${BOSS_WON_PREFIX}${bossId}`] = true
    if (cr.origin?.kind === 'boss') {
      const inst = instanceOfBoss(bossId)
      if (inst) {
        const prog = progressOf(save, inst.id)
        const tier = cr.origin.tier && inst.def.tiers[cr.origin.tier] ? cr.origin.tier : 'story'
        if ((prog.clears[tier] ?? 0) < 1) prog.clears[tier] = 1
        if ((prog.captures[tier] ?? 0) < 1) prog.captures[tier] = 1
        if (prog.runSeq < 1) prog.runSeq = 1
      }
    }
  }
  for (const [instId, prog] of Object.entries(save.instances ?? {})) {
    const def = GAMEPLAY.instances[instId]
    if (!def) continue
    if (Object.values(prog.clears).some((n) => n > 0)) {
      save.flags[`${BOSS_WON_PREFIX}${def.boss}`] = true
      if (def.boss === 'deepseek' && (prog.clears.story ?? 0) > 0) {
        save.flags['ds:done'] = true
        save.flags['ds:gateOpen'] = true
        save.flags['ds:certFull'] = true
      }
    }
  }

  // 3 & 4. Story progression and quest reconciliation (only when the world has the story layer applied)
  const mainDef = world?.quests.find((q) => q.id === 'main')
  if (world && mainDef) {
    const pastOpening = save.badges.length > 0
      || truthy(save.flags.champion)
      || truthy(save.flags.legend)
      || truthy(save.flags['villain:swamp'])
      || truthy(save.flags['villain:boss'])
    if (pastOpening) {
      if (!truthy(save.flags.starter)) {
        const inferred = inferStarterSpeciesId(save, c)
        if (inferred) save.flags.starter = inferred
      }
      save.flags['ds:gateOpen'] = true
      save.flags['ds:certFull'] = true
      if (!truthy(save.flags['ds:done'])) save.flags['ds:legacy'] = true
    }

    const saveAsObj = save as unknown as Record<string, unknown>
    const mainRule = (mig.reconcile?.mainStages ?? []).find((r) => migrationCondHolds(r.when, saveAsObj))
    if (mainRule || save.quests.main) {
      for (const f of mainRule?.implyFlags ?? []) save.flags[f] = true
      const maxStage = Math.max(0, mainDef.stages.length - 1)
      const prev = save.quests.main
      const factStage = mainRule ? Math.min(maxStage, mainRule.stage) : 0
      if (prev?.done && prev.stage < maxStage && !mainRule?.done) {
        save.flags[`${mig.noticeFlags.questRewardPrefix}main`] = true
        save.flags[`main:reopenedFrom:${prev.stage}`] = true
        save.quests.main = { stage: Math.min(maxStage, Math.max(prev.stage + 1, factStage)), done: false }
      } else {
        const nextStage = Math.min(maxStage, Math.max(prev?.stage ?? 0, factStage))
        const done = (prev?.done ?? false) || Boolean(mainRule?.done)
        save.quests.main = { stage: nextStage, done }
        if (done) save.flags[`${mig.noticeFlags.questRewardPrefix}main`] = true
      }
    }

    for (const entry of mig.reconcile?.sideQuests ?? []) {
      const qDef = world.quests.find((q) => q.id === entry.quest)
      if (!qDef) continue
      const maxStage = Math.max(0, qDef.stages.length - 1)
      const matched = entry.rules.find((rl) => migrationCondHolds(rl.when, saveAsObj))
      const prev = save.quests[entry.quest]
      if (!matched && !prev) continue
      const factStage = matched ? Math.min(maxStage, matched.stage) : 0
      if (prev?.done && prev.stage < maxStage && !matched?.done) {
        save.flags[`${mig.noticeFlags.questRewardPrefix}${entry.quest}`] = true
        save.quests[entry.quest] = { stage: Math.min(maxStage, Math.max(prev.stage + 1, factStage)), done: false }
      } else {
        const nextStage = Math.min(maxStage, Math.max(prev?.stage ?? 0, factStage))
        const done = (prev?.done ?? false) || Boolean(matched?.done)
        save.quests[entry.quest] = { stage: nextStage, done }
        if (done) save.flags[`${mig.noticeFlags.questRewardPrefix}${entry.quest}`] = true
      }
    }

    for (const qDef of world.quests) {
      const maxStage = Math.max(0, qDef.stages.length - 1)
      const prev = save.quests[qDef.id]
      let factStage = -1
      let factDone = false
      if (truthy(save.flags[`${qDef.id}:done`])) {
        factStage = maxStage
        factDone = true
      } else if (qDef.id.startsWith('lg-')) {
        for (let k = maxStage; k >= 0; k--) {
          if (truthy(save.flags[`${qDef.id}:t${k}`])) { factStage = k; break }
        }
      } else if (truthy(save.flags[`${qDef.id}:found`]) || truthy(save.flags[`${qDef.id}:rescued`])) {
        factStage = Math.min(maxStage, 1)
      } else if (truthy(save.flags[`${qDef.id}:started`]) || truthy(save.flags[`${qDef.id}:given`])) {
        factStage = 0
      }

      if (factStage >= 0 || prev) {
        if (prev?.done && prev.stage < maxStage && !factDone && qDef.id !== 'main') {
          save.flags[`${mig.noticeFlags.questRewardPrefix}${qDef.id}`] = true
          save.quests[qDef.id] = { stage: Math.min(maxStage, Math.max(prev.stage + 1, factStage)), done: false }
        } else if (factStage >= 0) {
          const nextStage = Math.min(maxStage, Math.max(prev?.stage ?? 0, factStage))
          const done = (prev?.done ?? false) || factDone
          save.quests[qDef.id] = { stage: nextStage, done }
        }
      }
      if (save.quests[qDef.id]?.done) {
        save.flags[`${mig.noticeFlags.questRewardPrefix}${qDef.id}`] = true
      }
    }

    if (save.quests['ds-legacy']) {
      save.flags['trig:ds-legacy-start'] = true
      save.flags['trig:ds-legacy-load'] = true
    }

    if (save.trackedQuest && (!save.quests[save.trackedQuest] || save.quests[save.trackedQuest].done)) {
      delete save.trackedQuest
    }
    if (!save.trackedQuest) {
      const open = world.quests.filter((q) => save.quests[q.id] && !save.quests[q.id].done)
      const pick = (open.find((q) => q.kind === 'main') ?? open[0])?.id
      if (pick) save.trackedQuest = pick
    }
  }

  // 5. World event state & runtime flag cleanup
  reconcileEventsOnSave(save)

  return save
}

/**
 * Cleans expired `activeUntil` timestamps, clamps future `lastDay` / `startedAt`, drops unknown event ids,
 * and deletes orphaned `evspawn:ev:<id>:` / `evitem:ev:<id>:` / `trainer:ev:<id>:` flags for non-active events.
 */
export function reconcileEventsOnSave(save: Pick<SaveData, 'events' | 'flags' | 'clockMinutes'>): void {
  const now = save.clockMinutes
  const curDay = dayOf(now)
  if (save.events) {
    for (const [id, st] of Object.entries(save.events)) {
      if (!GAMEPLAY.eventById[id]) {
        delete save.events[id]
        continue
      }
      if (st.lastDay > curDay) st.lastDay = curDay
      if (st.startedAt !== undefined && st.startedAt > now) st.startedAt = now
      if (st.activeUntil !== undefined && st.activeUntil <= now) {
        delete st.activeUntil
      }
    }
  }
  const activeIds = new Set(activeEvents(save.events ?? {}, now).map((e) => e.id))
  for (const k of Object.keys(save.flags)) {
    const mRuntime = /^(?:evspawn:|evitem:|trainer:)ev:([^:]+):/.exec(k)
    if (mRuntime && !activeIds.has(mRuntime[1])) {
      delete save.flags[k]
      continue
    }
    const mMeta = /^(?:news:|rumor:)(.+)$/.exec(k)
    if (mMeta && !GAMEPLAY.eventById[mMeta[1]]) {
      delete save.flags[k]
    }
  }
}

export function hasPendingContentUpdate(
  save: Pick<SaveData, 'flags'>,
  mig: MigrationsFile = MIGRATIONS,
): boolean {
  const pending = save.flags[mig.noticeFlags.pendingRev]
  const seen = save.flags[mig.noticeFlags.seenRev]
  const pendingNum = typeof pending === 'number' && Number.isFinite(pending) ? Math.floor(pending) : 0
  const seenNum = typeof seen === 'number' && Number.isFinite(seen) ? Math.floor(seen) : 0
  return pendingNum > seenNum
}

export function pendingContentRevisions(
  save: Pick<SaveData, 'flags' | 'contentRev'>,
  mig: MigrationsFile = MIGRATIONS,
): ContentRevision[] {
  if (!hasPendingContentUpdate(save, mig)) return []
  const fromRaw = save.flags[mig.noticeFlags.fromRev]
  const toRaw = save.flags[mig.noticeFlags.pendingRev]
  const seenRaw = save.flags[mig.noticeFlags.seenRev]
  const fromRev = Math.max(
    typeof fromRaw === 'number' && Number.isFinite(fromRaw) ? Math.floor(fromRaw) : 0,
    typeof seenRaw === 'number' && Number.isFinite(seenRaw) ? Math.floor(seenRaw) : 0,
  )
  const toRev = typeof toRaw === 'number' && Number.isFinite(toRaw) ? Math.floor(toRaw) : (save.contentRev ?? mig.contentRev)
  return (mig.revisions ?? []).filter((r) => r.rev > fromRev && r.rev <= toRev).sort((a, b) => a.rev - b.rev)
}

export function syncedContentRevisions(
  save: Pick<SaveData, 'flags' | 'contentRev'>,
  mig: MigrationsFile = MIGRATIONS,
): ContentRevision[] {
  const fromRaw = save.flags[mig.noticeFlags.fromRev]
  if (typeof fromRaw !== 'number' || !Number.isFinite(fromRaw)) return []
  const toRev = save.contentRev ?? mig.contentRev
  return (mig.revisions ?? []).filter((r) => r.rev > Math.floor(fromRaw) && r.rev <= toRev).sort((a, b) => b.rev - a.rev)
}

export function contentUpdateSummaryText(
  save: Pick<SaveData, 'flags' | 'contentRev'>,
  c: Content = CONTENT,
  mig: MigrationsFile = MIGRATIONS,
): string {
  const revs = pendingContentRevisions(save, mig)
  const list = revs.length ? revs : syncedContentRevisions(save, mig)
  const parts = list.map((r) => t(r.summaryKey, undefined, c))
  const summary = parts.join(' ')
  return summary ? t('screens.update.toast', { summary }, c) : t('screens.update.rev.rc17ContentReconcile.summary', undefined, c)
}

export function acknowledgeContentUpdate(
  save: Pick<SaveData, 'flags' | 'contentRev'>,
  mig: MigrationsFile = MIGRATIONS,
): boolean {
  const pending = save.flags[mig.noticeFlags.pendingRev]
  const target = typeof pending === 'number' && Number.isFinite(pending) ? Math.floor(pending) : (save.contentRev ?? mig.contentRev)
  const seen = save.flags[mig.noticeFlags.seenRev]
  const changed = seen !== target || save.flags[mig.noticeFlags.toastSeen] !== target
  save.flags[mig.noticeFlags.seenRev] = target
  save.flags[mig.noticeFlags.toastSeen] = target
  return changed
}

/**
 * Emits `save:loaded` (and `content:updated` when the save was brought forward across content revisions).
 */
export function emitSaveLoaded(
  ctx: Pick<GameContext, 'save' | 'events'>,
  mig: MigrationsFile = MIGRATIONS,
): { fromRev: number; toRev: number; updated: boolean; revisions: string[] } {
  const toRev = ctx.save.contentRev ?? mig.contentRev
  const pending = pendingContentRevisions(ctx.save, mig)
  const updated = pending.length > 0
  const fromRaw = ctx.save.flags[mig.noticeFlags.fromRev]
  const fromRev = updated && typeof fromRaw === 'number' && Number.isFinite(fromRaw) ? Math.floor(fromRaw) : toRev
  const revisions = pending.map((r) => r.id)
  ctx.events.emit('save:loaded', { fromRev, toRev, updated })
  if (updated) {
    ctx.events.emit('content:updated', { fromRev, toRev, revisions })
  }
  return { fromRev, toRev, updated, revisions }
}
