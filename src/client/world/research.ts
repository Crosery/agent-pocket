// Client side of dex research (rules: src/shared/gameplay/research.ts, data: content/research.json). Applies
// research items to SaveData.research with HUD toasts, implements ScriptStep 'research', level-reward claiming (the
// highest claimed level lives in SaveData.flags[GPC.research.claimFlag]) and a battle observer that turns the
// 'battle:events' stream into research (see / defeat / catch / foe move types / roaming legends) plus evolve /
// trade / befriend tracking from party changes. DOM-free.
import type { BattleResult, Creature, FieldWeatherKind, SaveData, TimeOfDay, TypeId } from '../../shared/types.ts'
import type { BattleKind, GameContext } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { GAMEPLAY } from '../../shared/gameplay/data.ts'
import {
  addTaskProgress, applyResearch, levelRewards, researchComplete, researchFromBattle, researchLevel, researchPoints,
  type ResearchEvent, type ResearchGain, type ResearchState,
} from '../../shared/gameplay/research.ts'
import { GPC } from './gameplay-config.ts'
import { addItem, changeMoney } from './save-ops.ts'

export type ResearchCtx = Pick<GameContext, 'save' | 'ui' | 'events' | 'data'>

export interface Rewards { money: number; items: Record<string, number> }

export interface ResearchSummary {
  points: number
  level: number
  /** Cumulative points of the next level (null at the cap). */
  nextAt: number | null
  prevAt: number
  maxLevel: number
  /** Highest level whose reward was claimed. */
  claimed: number
  /** Rewards of the levels (claimed, level]. */
  claimable: Rewards
  canClaim: boolean
}

export const researchState = (save: Pick<SaveData, 'research'>): ResearchState => save.research ?? {}

export function claimedLevel(save: Pick<SaveData, 'flags'>): number {
  const v = save.flags[GPC.research.claimFlag]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

export function researchSummary(save: Pick<SaveData, 'research' | 'flags'>): ResearchSummary {
  const points = researchPoints(researchState(save))
  const lv = researchLevel(points)
  const claimed = Math.min(claimedLevel(save), lv.level)
  return {
    points, level: lv.level, nextAt: lv.nextAt, prevAt: lv.prevAt, maxLevel: GAMEPLAY.research.levels.length,
    claimed, claimable: levelRewards(claimed, lv.level), canClaim: lv.level > claimed,
  }
}

/** "道具×2、500 Token 币" (same wording as quest rewards). */
export function rewardLabel(r: Rewards, ctx: Pick<GameContext, 'data'>): string {
  const parts: string[] = []
  for (const [id, qty] of Object.entries(r.items)) {
    const item = ctx.data.items[id]
    if (item) parts.push(t('world.script.rewardItem', { item: item.nameZh, qty }))
  }
  if (r.money) parts.push(t('world.script.rewardMoney', { money: r.money, currency: t('common.money') }))
  return parts.join(t('world.script.rewardJoin'))
}

/** Grants the rewards of every unclaimed level; null when nothing is claimable. */
export function claimResearchRewards(ctx: ResearchCtx): Rewards | null {
  const s = researchSummary(ctx.save)
  if (!s.canClaim) return null
  if (s.claimable.money) changeMoney(ctx as GameContext, s.claimable.money)
  for (const [id, n] of Object.entries(s.claimable.items)) addItem(ctx as GameContext, id, n)
  ctx.save.flags[GPC.research.claimFlag] = s.level
  ctx.events.emit('save:changed', { reason: 'research-claim' })
  return s.claimable
}

const fmtPoints = (n: number): string => String(Math.round(n * 10) / 10)

interface Delta { gains: ResearchGain[]; levelBefore: number; levelAfter: number; completed: string[] }

function announce(ctx: ResearchCtx, d: Delta): void {
  const name = (id: string) => ctx.data.species[id]?.nameZh ?? id
  if (GPC.research.toastGains) {
    const bySpecies = new Map<string, number>()
    for (const g of d.gains) if (g.points > 0) bySpecies.set(g.species, (bySpecies.get(g.species) ?? 0) + g.points)
    for (const [sp, pts] of bySpecies) ctx.ui.toast(t('research.ui.gain', { species: name(sp), points: fmtPoints(pts) }), GPC.research.toastKind)
  }
  const mul = GAMEPLAY.research.shinyMultiplierOnComplete ?? 1
  for (const sp of d.completed) ctx.ui.toast(t('research.ui.speciesComplete', { species: name(sp), mul }), 'success')
  if (d.levelAfter > d.levelBefore) {
    ctx.ui.toast(t('research.ui.levelUp', { level: d.levelAfter }), 'success')
    ctx.ui.toast(t('research.ui.claimHint'), 'info')
  }
}

/** Records research items (battle results etc.) and announces gains / completions / level-ups. */
export function applyResearchItems(ctx: ResearchCtx, items: readonly { species: string; event: ResearchEvent }[]): Delta {
  const r = applyResearch(researchState(ctx.save), items)
  if (r.gains.length) ctx.save.research = r.state
  announce(ctx, r)
  return r
}

/** ScriptStep { op: 'research', species, task, amount }. */
export function scriptResearch(ctx: ResearchCtx, species: string, task: string, amount: number): Delta {
  const state = researchState(ctx.save)
  const before = researchPoints(state)
  const wasComplete = researchComplete(state, species)
  const r = addTaskProgress(state, species, task, amount)
  if (r.gains.length) ctx.save.research = r.state
  const after = before + r.gains.reduce((s, g) => s + g.points, 0)
  const d: Delta = {
    gains: r.gains, levelBefore: researchLevel(before).level, levelAfter: researchLevel(after).level,
    completed: !wasComplete && researchComplete(r.state, species) ? [species] : [],
  }
  announce(ctx, d)
  return d
}

// ---------------------------------------------------------------------------------------------- battle observer

export interface BattleEnvironment { timeOfDay: TimeOfDay; weather: FieldWeatherKind; biome: string | null }

export interface BattleTrace {
  kind: BattleKind
  result: BattleResult | null
  seen: string[]
  defeated: string[]
  foeMoves: { species: string; type: TypeId }[]
  caught: { speciesId: string; shiny: boolean } | null
  /** Last known hp per foe uid. */
  foeHp: Map<string, number>
  /** uid of the foe that was on the field last. */
  foeUid: string | null
  roamingLegend: boolean
}

interface PartyMark { species: string; friendship: number }

/**
 * Subscribes to battle:start / battle:events / battle:end and party:changed. `env()` is read when a battle starts.
 * Call expectLegend() right before starting a roaming-legend battle (defeatRoaming research).
 */
export function createResearchObserver(ctx: GameContext, env: () => BattleEnvironment) {
  let trace: BattleTrace | null = null
  let last: BattleTrace | null = null
  let at: BattleEnvironment | null = null
  let legendNext = false
  let foe: { uid: string; species: string; shiny: boolean } | null = null
  let marks: Map<string, PartyMark> | null = null
  let marksOf: SaveData | null = null

  const offStart = ctx.events.on('battle:start', ({ kind }) => {
    trace = { kind, result: null, seen: [], defeated: [], foeMoves: [], caught: null, foeHp: new Map(), foeUid: null, roamingLegend: legendNext }
    legendNext = false
    foe = null
    at = env()
  })

  const offEvents = ctx.events.on('battle:events', ({ events }) => {
    const tr = trace
    if (!tr) return
    for (const e of events) {
      switch (e.t) {
        case 'switch':
          if (e.side !== 1) break
          foe = { uid: e.creature.uid, species: e.creature.speciesId, shiny: e.creature.shiny }
          tr.foeUid = foe.uid
          tr.foeHp.set(foe.uid, e.creature.hp)
          if (!tr.seen.includes(foe.species)) tr.seen.push(foe.species)
          break
        case 'damage':
        case 'heal':
          if (e.side === 1 && foe) tr.foeHp.set(foe.uid, e.hp)
          break
        case 'faint':
          if (e.side === 1 && foe) { tr.defeated.push(foe.species); tr.foeHp.set(foe.uid, 0) }
          break
        case 'move':
          if (e.side === 1 && foe) tr.foeMoves.push({ species: foe.species, type: e.type })
          break
        case 'catch':
          if (e.success && foe) tr.caught = { speciesId: foe.species, shiny: foe.shiny }
          break
        case 'end':
          tr.result = e.result
          break
        default:
          break
      }
    }
  })

  const offEnd = ctx.events.on('battle:end', ({ kind, result }) => {
    const tr = trace
    trace = null
    if (!tr) return
    tr.result = result
    last = tr
    if (kind === 'pvp' || !at) return
    const items = researchFromBattle({
      seen: tr.seen, defeated: tr.defeated, result, caught: tr.caught, foeMoves: tr.foeMoves,
      timeOfDay: at.timeOfDay, weather: at.weather, biome: at.biome, roamingLegend: tr.roamingLegend,
    })
    if (items.length) applyResearchItems(ctx, items)
  })

  const allCreatures = (s: SaveData): Creature[] => [...s.party, ...s.boxes.flat()]

  /** Evolutions (species of a known uid changed), trades (new creature of another trainer) and friendship. */
  function scanParty(): void {
    const s = ctx.save
    if (marksOf !== s || !marks) {
      marksOf = s
      marks = new Map(allCreatures(s).map((cr) => [cr.uid, { species: cr.speciesId, friendship: cr.friendship }]))
      return
    }
    const items: { species: string; event: ResearchEvent }[] = []
    const party = new Set(s.party.map((cr) => cr.uid))
    for (const cr of allCreatures(s)) {
      const m = marks.get(cr.uid)
      if (!m) {
        if (cr.otId && cr.otId !== s.playerId) items.push({ species: cr.speciesId, event: { kind: 'trade' } })
      } else {
        if (m.species !== cr.speciesId) items.push({ species: cr.speciesId, event: { kind: 'evolve' } })
        if (party.has(cr.uid) && cr.friendship > m.friendship) items.push({ species: cr.speciesId, event: { kind: 'befriend', amount: cr.friendship, set: true } })
      }
      marks.set(cr.uid, { species: cr.speciesId, friendship: cr.friendship })
    }
    if (items.length) applyResearchItems(ctx, items)
  }

  const offParty = ctx.events.on('party:changed', () => scanParty())
  const offMap = ctx.events.on('map:entered', () => scanParty())

  return {
    expectLegend(): void { legendNext = true },
    /** The last finished battle (foe hp for roaming legends). */
    get last(): BattleTrace | null { return last },
    /** Direct record of one research event (e.g. befriend from a script). */
    record(species: string, event: ResearchEvent): void { applyResearchItems(ctx, [{ species, event }]) },
    dispose(): void { offStart(); offEvents(); offEnd(); offParty(); offMap() },
  }
}

export type ResearchObserver = ReturnType<typeof createResearchObserver>
