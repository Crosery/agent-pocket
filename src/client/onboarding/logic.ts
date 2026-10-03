// Pure onboarding logic: condition evaluation, objective selection, arrow target resolution, tip eligibility.
import type { GameMap, QuestDef, SaveData, World } from '../../shared/types.ts'
import { TIP_FLAG_PREFIX, TUTORIAL, type Cond, type ObjectiveRule, type TipDef, type TutorialConfig } from './config.ts'

const truthy = (v: boolean | number | string | undefined) => v !== undefined && v !== false && v !== 0 && v !== ''

export type ProgressView = Pick<SaveData, 'flags' | 'badges' | 'party' | 'stats' | 'quests'>

export function condHolds(c: Cond | undefined, s: ProgressView): boolean {
  if (!c) return true
  if (c.flag?.some((f) => !truthy(s.flags[f]))) return false
  if (c.noFlag?.some((f) => truthy(s.flags[f]))) return false
  if (c.minBadges !== undefined && s.badges.length < c.minBadges) return false
  if (c.maxBadges !== undefined && s.badges.length > c.maxBadges) return false
  if (c.minParty !== undefined && s.party.length < c.minParty) return false
  if (c.maxParty !== undefined && s.party.length > c.maxParty) return false
  const stat = (k: string) => (s.stats as unknown as Record<string, number>)[k] ?? 0
  for (const [k, n] of Object.entries(c.minStat ?? {})) if (stat(k) < n) return false
  for (const [k, n] of Object.entries(c.maxStat ?? {})) if (stat(k) > n) return false
  return true
}

export interface ObjectiveView {
  ruleId: string
  /** Text key and its params. */
  textKey: string
  params: Record<string, string>
  /** Anchor names to point at (resolved by nearestTarget). */
  targets: string[]
  /** Quest-stage target already resolved by the world (fromQuest rules). */
  questTarget?: { map: string; x: number; y: number }
}

function openQuestStage(world: World, id: string, s: ProgressView): { def: QuestDef; stage: number } | null {
  const def = world.quests.find((q) => q.id === id)
  const st = s.quests[id]
  if (!def || !st || st.done) return null
  return { def, stage: Math.min(st.stage, def.stages.length - 1) }
}

/** First matching rule wins; a fromQuest rule falls back to its textDone line when the quest is finished. */
export function pickObjective(world: World, s: ProgressView, cfg: TutorialConfig = TUTORIAL): ObjectiveView {
  for (const r of cfg.objective.rules) {
    if (!condHolds(r.when, s)) continue
    return viewOf(world, r, s)
  }
  const last = cfg.objective.rules[cfg.objective.rules.length - 1]
  return viewOf(world, last, s)
}

function viewOf(world: World, r: ObjectiveRule, s: ProgressView): ObjectiveView {
  if (r.fromQuest) {
    const q = openQuestStage(world, r.fromQuest, s)
    if (!q) return { ruleId: r.id, textKey: r.textDone ?? r.text, params: {}, targets: [] }
    const st = q.def.stages[q.stage]
    return { ruleId: r.id, textKey: r.text, params: { stage: st?.text ?? '' }, targets: [], ...(st?.target ? { questTarget: st.target } : {}) }
  }
  return { ruleId: r.id, textKey: r.text, params: {}, targets: r.target ?? [] }
}

export interface Place { map: string; x: number; y: number }

/**
 * Where to point from `from`: the nearest candidate on the same map; across maps the door of the current map
 * that leads to the target's map (or out to the parent map).
 */
export function nearestTarget(world: World, from: Place, candidates: readonly Place[]): Place | null {
  if (!candidates.length) return null
  const dist = (a: Place, b: Place) => Math.hypot(a.x - b.x, a.y - b.y)
  const here = candidates.filter((c) => c.map === from.map)
  if (here.length) return here.reduce((a, b) => (dist(from, a) <= dist(from, b) ? a : b))
  const map: GameMap | undefined = world.maps[from.map]
  if (!map) return null
  const want = new Set(candidates.map((c) => c.map))
  const doors = map.warps.filter((w) => want.has(w.toMap))
  const exits = doors.length ? doors : map.parent ? map.warps.filter((w) => w.toMap === map.parent) : []
  if (!exits.length) return null
  const best = exits.reduce((a, b) => (Math.hypot(a.x - from.x, a.y - from.y) <= Math.hypot(b.x - from.x, b.y - from.y) ? a : b))
  return { map: from.map, x: best.x, y: best.y }
}

/** Screen-space angle (radians, 0 = east, clockwise) and tile distance. */
export function bearing(from: Place, to: Place): { angle: number; tiles: number } {
  const dx = to.x + 0.5 - from.x
  const dy = to.y + 0.5 - from.y
  return { angle: Math.atan2(dy, dx), tiles: Math.round(Math.hypot(dx, dy)) }
}

export const tipFlag = (id: string) => `${TIP_FLAG_PREFIX}${id}`

export function tipSeen(s: ProgressView, id: string): boolean {
  return truthy(s.flags[tipFlag(id)])
}

/** A tip that was never shown but whose lesson the save already moved past is not worth showing. */
export function tipLive(tip: TipDef, s: ProgressView): boolean {
  return !tipSeen(s, tip.id) && !(tip.expires && condHolds(tip.expires, s))
}
