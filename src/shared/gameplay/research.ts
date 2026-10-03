// Dex research (content/research.json): per-species task progress by rarity tier, research points, the global
// research level and its rewards. A species whose points reach completePoints[rarity] counts as complete
// (shiny odds x shinyMultiplierOnComplete in spawns.ts). Pure; state is SaveData.research.
//
// Runtime API (client):
//   tasksFor(species)                         ResearchTaskDef[] for the species' rarity (byRarity).
//   recordResearch(state, species, event)     one ResearchEvent -> { state, gains }.
//   addTaskProgress(state, species, task, n)  ScriptStep 'research' (direct task id).
//   researchFromBattle(input)                 list of { species, event } produced by a finished battle.
//   applyResearch(state, items)               record many + level/rewards delta (grant `rewards` once).
//   speciesResearch / researchComplete        dex page data.
//   researchPoints / researchLevel / levelRewards
//   sanitizeResearch(raw)
//
// Event kinds (ResearchEvent.kind) and their param:
//   see / seeAtTime(timeOfDay) / seeInWeather(field weather)   when a wild battle starts (the foe species)
//   catch / catchAtTime / catchInWeather / catchInBiome(biome) / catchShiny     on 'caught'
//   defeat / defeatRoaming                                      foe fainted (roaming = UR legend battle)
//   useMoveType(move type)                                      a foe of that species used a move of the type
//   evolve / trade                                              own creature evolved into / traded for the species
//   befriend(amount = friendship, set)                          progress = max(progress, friendship)
//   chainStep                                                   a MYTHIC chain step solved (species of the chain)
import type { BattleResult, FieldWeatherKind, ResearchTaskDef, ResearchTaskKind, TimeOfDay, TypeId } from '../types.ts'
import { CONTENT, type Content } from '../content/index.ts'
import { GAMEPLAY } from './data.ts'
import type { GameplayData } from './schema.ts'

export type ResearchState = Record<string, Record<string, number>>

export interface ResearchEvent {
  kind: ResearchTaskKind
  param?: string
  /** Default 1. */
  amount?: number
  /** progress = max(progress, amount) instead of adding (befriend). */
  set?: boolean
}

export interface ResearchGain {
  species: string
  task: string
  from: number
  to: number
  /** Thresholds newly reached. */
  reached: number
  points: number
}

export function tasksFor(speciesId: string, g: GameplayData = GAMEPLAY, c: Content = CONTENT): ResearchTaskDef[] {
  const rarity = c.species[speciesId]?.rarity
  if (!rarity) return []
  const byId = new Map(g.research.tasks.map((x) => [x.id, x]))
  return (g.research.byRarity[rarity] ?? []).map((id) => byId.get(id)).filter((x): x is ResearchTaskDef => !!x)
}

function paramMatches(task: ResearchTaskDef, ev: ResearchEvent, types: readonly TypeId[], g: GameplayData): boolean {
  if (task.param === undefined) return true
  if (ev.param === undefined) return false
  if (task.param === 'own') return types.includes(ev.param)
  if (task.param === '*') return !(g.research.wildcardIgnore ?? []).includes(ev.param)
  return task.param === ev.param
}

const reachedCount = (task: ResearchTaskDef, progress: number): number => task.thresholds.filter((th) => progress >= th).length
const cap = (task: ResearchTaskDef): number => task.thresholds.reduce((m, th) => Math.max(m, th), 0)

export function taskPoints(task: ResearchTaskDef, speciesId: string, g: GameplayData = GAMEPLAY, c: Content = CONTENT): number {
  const rarity = c.species[speciesId]?.rarity ?? ''
  return task.points * (g.research.rarityPointMul?.[rarity] ?? 1)
}

function bump(state: ResearchState, speciesId: string, task: ResearchTaskDef, to: number, g: GameplayData, c: Content): { state: ResearchState; gain: ResearchGain | null } {
  const from = state[speciesId]?.[task.id] ?? 0
  const capped = Math.min(cap(task), Math.max(from, Math.floor(to)))
  if (capped === from) return { state, gain: null }
  const reached = reachedCount(task, capped) - reachedCount(task, from)
  const next = { ...state, [speciesId]: { ...(state[speciesId] ?? {}), [task.id]: capped } }
  return { state: next, gain: { species: speciesId, task: task.id, from, to: capped, reached, points: reached * taskPoints(task, speciesId, g, c) } }
}

export function recordResearch(state: ResearchState, speciesId: string, ev: ResearchEvent, g: GameplayData = GAMEPLAY, c: Content = CONTENT): { state: ResearchState; gains: ResearchGain[] } {
  const types = c.species[speciesId]?.types ?? []
  const amount = ev.amount ?? 1
  const gains: ResearchGain[] = []
  let cur = state
  for (const task of tasksFor(speciesId, g, c)) {
    if (task.kind !== ev.kind || !paramMatches(task, ev, types, g)) continue
    const from = cur[speciesId]?.[task.id] ?? 0
    const r = bump(cur, speciesId, task, ev.set ? Math.max(from, amount) : from + amount, g, c)
    cur = r.state
    if (r.gain) gains.push(r.gain)
  }
  return { state: cur, gains }
}

/** ScriptStep { op: 'research', species, task, amount }: adds to one task id (if it applies to the species). */
export function addTaskProgress(state: ResearchState, speciesId: string, taskId: string, amount: number, g: GameplayData = GAMEPLAY, c: Content = CONTENT): { state: ResearchState; gains: ResearchGain[] } {
  const task = tasksFor(speciesId, g, c).find((x) => x.id === taskId)
  if (!task) return { state, gains: [] }
  const r = bump(state, speciesId, task, (state[speciesId]?.[taskId] ?? 0) + amount, g, c)
  return { state: r.state, gains: r.gain ? [r.gain] : [] }
}

export interface SpeciesResearch {
  points: number
  completeAt: number
  complete: boolean
  tasks: { def: ResearchTaskDef; progress: number; reached: number; next: number | null; points: number }[]
}

export function speciesResearch(state: ResearchState, speciesId: string, g: GameplayData = GAMEPLAY, c: Content = CONTENT): SpeciesResearch {
  const rarity = c.species[speciesId]?.rarity ?? ''
  const tasks = tasksFor(speciesId, g, c).map((def) => {
    const progress = state[speciesId]?.[def.id] ?? 0
    const reached = reachedCount(def, progress)
    return { def, progress, reached, next: def.thresholds.find((th) => th > progress) ?? null, points: reached * taskPoints(def, speciesId, g, c) }
  })
  const points = tasks.reduce((s, x) => s + x.points, 0)
  const completeAt = g.research.completePoints?.[rarity] ?? Infinity
  return { points, completeAt, complete: points >= completeAt, tasks }
}

export function researchComplete(state: ResearchState, speciesId: string, g: GameplayData = GAMEPLAY, c: Content = CONTENT): boolean {
  return speciesResearch(state, speciesId, g, c).complete
}

export function researchPoints(state: ResearchState, g: GameplayData = GAMEPLAY, c: Content = CONTENT): number {
  let total = 0
  for (const id of Object.keys(state)) if (c.species[id]) total += speciesResearch(state, id, g, c).points
  return total
}

/** levels[i].points = cumulative points for level i+1. */
export function researchLevel(points: number, g: GameplayData = GAMEPLAY): { level: number; nextAt: number | null; prevAt: number } {
  const lv = g.research.levels
  let level = 0
  while (level < lv.length && points >= lv[level].points) level++
  return { level, nextAt: level < lv.length ? lv[level].points : null, prevAt: level > 0 ? lv[level - 1].points : 0 }
}

/** Rewards of levels (from, to]. */
export function levelRewards(from: number, to: number, g: GameplayData = GAMEPLAY): { money: number; items: Record<string, number> } {
  const out = { money: 0, items: {} as Record<string, number> }
  for (let l = Math.max(0, from); l < Math.min(to, g.research.levels.length); l++) {
    const r = g.research.levels[l].reward
    if (!r) continue
    out.money += r.money ?? 0
    for (const [id, n] of Object.entries(r.items ?? {})) out.items[id] = (out.items[id] ?? 0) + n
  }
  return out
}

export interface BattleResearchInput {
  /** Foe species seen this battle (each counts once). */
  seen: readonly string[]
  /** Foe species that fainted. */
  defeated: readonly string[]
  result: BattleResult
  caught?: { speciesId: string; shiny: boolean } | null
  /** Move types used by foe species (from 'move' events of side 1). */
  foeMoves: readonly { species: string; type: TypeId }[]
  timeOfDay: TimeOfDay
  weather: FieldWeatherKind
  biome: string | null
  /** The wild was a roaming UR legend. */
  roamingLegend?: boolean
}

export function researchFromBattle(input: BattleResearchInput): { species: string; event: ResearchEvent }[] {
  const out: { species: string; event: ResearchEvent }[] = []
  for (const s of new Set(input.seen)) {
    out.push({ species: s, event: { kind: 'see' } })
    out.push({ species: s, event: { kind: 'seeAtTime', param: input.timeOfDay } })
    out.push({ species: s, event: { kind: 'seeInWeather', param: input.weather } })
  }
  for (const s of input.defeated) {
    out.push({ species: s, event: { kind: 'defeat' } })
    if (input.roamingLegend) out.push({ species: s, event: { kind: 'defeatRoaming' } })
  }
  for (const m of input.foeMoves) out.push({ species: m.species, event: { kind: 'useMoveType', param: m.type } })
  const cr = input.result === 'caught' ? input.caught : null
  if (cr) {
    const s = cr.speciesId
    out.push({ species: s, event: { kind: 'catch' } })
    out.push({ species: s, event: { kind: 'catchAtTime', param: input.timeOfDay } })
    out.push({ species: s, event: { kind: 'catchInWeather', param: input.weather } })
    if (input.biome) out.push({ species: s, event: { kind: 'catchInBiome', param: input.biome } })
    if (cr.shiny) out.push({ species: s, event: { kind: 'catchShiny' } })
  }
  return out
}

export interface ApplyResult {
  state: ResearchState
  gains: ResearchGain[]
  pointsBefore: number
  pointsAfter: number
  levelBefore: number
  levelAfter: number
  /** Rewards for the levels gained by this call (grant them once). */
  rewards: { money: number; items: Record<string, number> }
  /** Species that became complete with this call. */
  completed: string[]
}

export function applyResearch(state: ResearchState, items: readonly { species: string; event: ResearchEvent }[], g: GameplayData = GAMEPLAY, c: Content = CONTENT): ApplyResult {
  const pointsBefore = researchPoints(state, g, c)
  const touched = new Set(items.map((x) => x.species))
  const wasComplete = new Set([...touched].filter((s) => researchComplete(state, s, g, c)))
  let cur = state
  const gains: ResearchGain[] = []
  for (const it of items) {
    const r = recordResearch(cur, it.species, it.event, g, c)
    cur = r.state
    gains.push(...r.gains)
  }
  const pointsAfter = pointsBefore + gains.reduce((s, x) => s + x.points, 0)
  const levelBefore = researchLevel(pointsBefore, g).level
  const levelAfter = researchLevel(pointsAfter, g).level
  return {
    state: cur, gains, pointsBefore, pointsAfter, levelBefore, levelAfter, rewards: levelRewards(levelBefore, levelAfter, g),
    completed: [...touched].filter((s) => !wasComplete.has(s) && researchComplete(cur, s, g, c)),
  }
}

/** Keeps non-negative integer progress for known species / task ids. */
export function sanitizeResearch(raw: unknown, g: GameplayData = GAMEPLAY, c: Content = CONTENT): ResearchState {
  const out: ResearchState = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const taskIds = new Set(g.research.tasks.map((x) => x.id))
  for (const [sp, row] of Object.entries(raw as Record<string, unknown>)) {
    if (!c.species[sp] || !row || typeof row !== 'object' || Array.isArray(row)) continue
    const r: Record<string, number> = {}
    for (const [task, v] of Object.entries(row as Record<string, unknown>)) {
      if (taskIds.has(task) && typeof v === 'number' && Number.isFinite(v) && v > 0) r[task] = Math.floor(v)
    }
    if (Object.keys(r).length) out[sp] = r
  }
  return out
}
