// Boss instances (content/world/instances.json): lookup by boss and the per-save progress record. Pure helpers shared
// by the client flows (world/battles.ts, battle/capture.ts), coop protocol, server and tests.
import type { BattleSummary, InstanceDef, InstanceDefaults, InstanceLossHint, InstancePeriodConfig, InstanceProgress, InstanceTierDef, SaveData } from '../types.ts'
import { CONTENT, type Content } from '../content/index.ts'
import { GAMEPLAY } from './data.ts'

/** The instance that runs `bossId`'s fights (first match), or null. */
export function instanceOfBoss(bossId: string): { id: string; def: InstanceDef } | null {
  for (const [id, def] of Object.entries(GAMEPLAY.instances)) if (def.boss === bossId) return { id, def }
  return null
}

export const emptyProgress = (): InstanceProgress => ({
  clears: {},
  captures: {},
  runSeq: 0,
  losses: {},
  pity: {},
  lastRollRun: {},
  achievements: [],
})

/** The progress of one instance, created in the save on first use. */
export function progressOf(save: Pick<SaveData, 'instances'>, instanceId: string): InstanceProgress {
  save.instances ??= {}
  const prog = (save.instances[instanceId] ??= emptyProgress())
  prog.clears ??= {}
  prog.captures ??= {}
  prog.losses ??= {}
  prog.pity ??= {}
  prog.lastRollRun ??= {}
  prog.achievements ??= []
  return prog
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonNeg = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 0xffffffff) : 0)

function counts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isObj(raw)) return out
  for (const [k, v] of Object.entries(raw)) if (/^[A-Za-z0-9_-]{1,40}$/.test(k)) out[k] = nonNeg(v)
  return out
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x))
}

/** Cleans untrusted instance progress: known ids only, every counter a non-negative integer. */
export function sanitizeInstances(raw: unknown): Record<string, InstanceProgress> {
  const out: Record<string, InstanceProgress> = {}
  if (!isObj(raw)) return out
  for (const [id, v] of Object.entries(raw)) {
    if (!GAMEPLAY.instances[id] || !isObj(v)) continue
    const prog: InstanceProgress = {
      clears: counts(v.clears),
      captures: counts(v.captures),
      runSeq: nonNeg(v.runSeq),
      losses: counts(v.losses),
      pity: counts(v.pity),
      lastRollRun: counts(v.lastRollRun),
      achievements: stringList(v.achievements),
    }
    if (isObj(v.day) && typeof v.day.key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.day.key)) {
      prog.day = {
        key: v.day.key,
        rolls: nonNeg(v.day.rolls),
        rewards: nonNeg(v.day.rewards),
      }
    }
    out[id] = prog
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

/** Parses UTC offset like "+08:00" or "-05:00" into milliseconds. Defaults to +8h (+08:00). */
export function parseUtcOffsetMs(offset?: string): number {
  if (!offset) return 8 * 3600_000
  const m = /^[+-](\d{2}):(\d{2})$/.exec(offset)
  if (!m) return 8 * 3600_000
  const sign = offset.startsWith('-') ? -1 : 1
  const hours = Number(m[1])
  const mins = Number(m[2])
  return sign * (hours * 3600_000 + mins * 60_000)
}

/**
 * Calculates current period key (YYYY-MM-DD for daily or YYYY-Www for weekly)
 * adjusted for UTC offset and day-start hour (default 5:00 AM).
 */
export function instancePeriodKey(
  cadence: 'daily' | 'weekly' = 'daily',
  period?: InstancePeriodConfig,
  nowMs = Date.now(),
): string {
  const cfg = period ?? GAMEPLAY.instancePeriod ?? { utcOffset: '+08:00', dayStartHour: 5 }
  const offsetMs = parseUtcOffsetMs(cfg.utcOffset)
  const dayStartHour = cfg.dayStartHour ?? 5
  // Shift by offset and subtract dayStartHour hours so a day rolls at dayStartHour:00
  const shifted = new Date(nowMs + offsetMs - dayStartHour * 3600_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  if (cadence === 'daily') return `${y}-${m}-${d}`

  // ISO-8601 week calculation
  const target = new Date(Date.UTC(y, shifted.getUTCMonth(), shifted.getUTCDate()))
  const dayNr = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThursday = target.getTime()
  target.setUTCMonth(0, 1)
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7))
  }
  const weekNr = 1 + Math.ceil((firstThursday - target.getTime()) / 604800000)
  return `${y}-W${String(weekNr).padStart(2, '0')}`
}

/**
 * Calculates Boss Max HP scaled by N^exp where N is number of players.
 */
export function scaleBossHp(baseHp: number, playerCount: number, exp = 0.8): number {
  const n = Math.max(1, playerCount)
  const mul = Math.pow(n, exp)
  return Math.round(baseHp * mul)
}

/**
 * Checks whether current time qualifies for off-peak double events.
 * Reads hour range from GAMEPLAY.instanceDefaults.offPeakDouble.hours (default 22:00 - 08:00).
 */
export function isOffPeakDouble(nowMs = Date.now(), period?: InstancePeriodConfig): boolean {
  const cfg = period ?? GAMEPLAY.instancePeriod ?? { utcOffset: '+08:00', dayStartHour: 5 }
  const offsetMs = parseUtcOffsetMs(cfg.utcOffset)
  const localDate = new Date(nowMs + offsetMs)
  const hour = localDate.getUTCHours()
  const hours = GAMEPLAY.instanceDefaults?.offPeakDouble?.hours ?? [22, 8]
  const [start, end] = hours
  if (start > end) {
    return hour >= start || hour < end
  }
  return hour >= start && hour < end
}

/**
 * Checks if a dungeon tier is unlocked given player badges, world story flags, and party size.
 */
export function isTierUnlocked(
  tier: InstanceTierDef,
  badges: readonly string[] = [],
  flags: Readonly<Record<string, boolean>> = {},
  partySize = 1,
): { unlocked: boolean; reason?: string } {
  const req = tier.unlock
  if (!req) return { unlocked: true }
  if (req.badgesAtLeast !== undefined && badges.length < req.badgesAtLeast) {
    return { unlocked: false, reason: `需要至少 ${req.badgesAtLeast} 枚道馆徽章` }
  }
  if (req.flag && !flags[req.flag]) {
    return { unlocked: false, reason: '尚未完成前置剧情任务' }
  }
  if (req.minPlayers !== undefined && partySize < req.minPlayers) {
    return { unlocked: false, reason: `该难度至少需要 ${req.minPlayers} 人组队` }
  }
  if (req.maxPlayers !== undefined && partySize > req.maxPlayers) {
    return { unlocked: false, reason: `该难度最多容纳 ${req.maxPlayers} 人组队` }
  }
  return { unlocked: true }
}

export interface ContractOddsResult {
  chance: number
  guaranteed: boolean
  pity: number
  maxPity: number
  avgAttempts: number
}

/**
 * Computes signing odds, pity progress and average attempts for a contract roll.
 */
export function contractOdds(
  tier: InstanceTierDef,
  ballBonus = 0,
  isRepeat = false,
  currentPity = 0,
): ContractOddsResult {
  const base = isRepeat ? (tier.capture.repeat ?? tier.capture.first) : tier.capture.first
  const maxPity = tier.capture.pity ?? 0
  const guaranteed = maxPity > 0 && currentPity >= maxPity
  const chance = guaranteed ? 1.0 : Math.min(1.0, Math.max(0, base + ballBonus))

  // Theoretical average attempts under pity rule:
  // E = sum_{k=1}^{M-1} (1-p)^{k-1} + (1-p)^{M-1}
  // When p is 0.35 with pity 3 -> 2.35; 0.25 with pity 4 -> 3.05; 0.15 with pity 5 -> 4.15
  let avgAttempts = 1.0
  if (chance > 0) {
    if (maxPity > 0 && (isRepeat || base < 1)) {
      let sum = 0
      let failAcc = 1
      for (let k = 1; k <= maxPity; k++) {
        if (k === maxPity) {
          sum += k * failAcc
        } else {
          sum += k * failAcc * chance
          failAcc *= 1 - chance
        }
      }
      avgAttempts = Number(sum.toFixed(2))
    } else {
      avgAttempts = Number((1 / chance).toFixed(2))
    }
  }
  return { chance, guaranteed, pity: currentPity, maxPity, avgAttempts }
}

/**
 * Rolls whether a contract succeeds using a random number generator.
 */
export function rollContractOutcome(
  rng: { nextFloat?: () => number; next?: () => number },
  chance: number,
): boolean {
  if (chance >= 1.0) return true
  if (chance <= 0) return false
  const r = typeof rng.nextFloat === 'function' ? rng.nextFloat() : (rng.next?.() ?? 0) / 0xffffffff
  return r < chance
}

/**
 * Checks and updates daily lockout status for online/bounded runs.
 */
export function dailyLockoutStatus(
  prog: InstanceProgress,
  periodKey: string,
  rollLimit = GAMEPLAY.instanceDefaults.dailyRollLimit ?? 0,
  rewardLimit = GAMEPLAY.instanceDefaults.dailyRewardLimit ?? 0,
): { canRoll: boolean; rollsLeft: number; canReward: boolean; rewardsLeft: number } {
  if (prog.day?.key !== periodKey) {
    prog.day = { key: periodKey, rolls: 0, rewards: 0 }
  }
  const rolls = prog.day.rolls ?? 0
  const rewards = prog.day.rewards ?? 0
  return {
    canRoll: rolls < rollLimit,
    rollsLeft: Math.max(0, rollLimit - rolls),
    canReward: rewards < rewardLimit,
    rewardsLeft: Math.max(0, rewardLimit - rewards),
  }
}

export function recordDailyRoll(prog: InstanceProgress, periodKey: string): void {
  if (prog.day?.key !== periodKey) {
    prog.day = { key: periodKey, rolls: 0, rewards: 0 }
  }
  prog.day.rolls = (prog.day.rolls ?? 0) + 1
}

export function recordDailyReward(prog: InstanceProgress, periodKey: string): void {
  if (prog.day?.key !== periodKey) {
    prog.day = { key: periodKey, rolls: 0, rewards: 0 }
  }
  prog.day.rewards = (prog.day.rewards ?? 0) + 1
}

/**
 * Checks instance achievements upon victory and returns newly awarded achievement ids.
 */
export function checkInstanceAchievements(
  prog: InstanceProgress,
  inst: InstanceDef,
  ctx: { tierId: string; win: boolean; turns?: number; damageTaken?: number; partySize?: number },
): string[] {
  if (!inst.achievements || !ctx.win) return []
  prog.achievements ??= []
  const awarded: string[] = []

  for (const achId of Object.keys(inst.achievements)) {
    if (prog.achievements.includes(achId)) continue
    let ok = false
    if (achId === 'clear-story' && ctx.tierId === 'story') ok = true
    if (achId === 'clear-hard' && ctx.tierId === 'hard') ok = true
    if (achId === 'clear-cluster' && ctx.tierId === 'cluster' && (ctx.partySize ?? 1) >= 2) ok = true
    if (achId === 'flawless' && (ctx.damageTaken ?? 1) === 0) ok = true
    if (achId === 'speed-clear' && (ctx.turns ?? 99) <= 8) ok = true

    if (ok) {
      prog.achievements.push(achId)
      awarded.push(achId)
    }
  }
  return awarded
}
