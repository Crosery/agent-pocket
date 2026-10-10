// Pure onboarding logic: condition evaluation, objective selection, arrow target resolution, tip eligibility.
import type { BattleEvent, GameMap, QuestDef, SaveData, World } from '../../shared/types.ts'
import { CONTENT } from '../../shared/content/index.ts'
import { bankLevels } from '../../shared/gameplay/bosscard.ts'
import { TIP_FLAG_PREFIX, TUTORIAL, type Cond, type LessonDef, type Matcher, type ObjectiveRule, type TipDef, type TutorialConfig } from './config.ts'

const truthy = (v: boolean | number | string | undefined) => v !== undefined && v !== false && v !== 0 && v !== ''

export type ProgressView = Pick<SaveData, 'flags' | 'badges' | 'party' | 'stats' | 'quests'> & Partial<Pick<SaveData, 'bag'>>

/** State that is not part of the save (the clock). */
export interface LiveView { timeOfDay?: string }

export function condHolds(c: Cond | undefined, s: ProgressView, live: LiveView = {}): boolean {
  if (!c) return true
  const have = (id: string) => (s.bag?.[id] ?? 0) > 0
  if (c.hasItem?.some((id) => !have(id))) return false
  if (c.hasCategory && !c.hasCategory.some((cat) => CONTENT.itemList.some((it) => it.category === cat && have(it.id)))) return false
  if (c.timeOfDay && !(live.timeOfDay && c.timeOfDay.includes(live.timeOfDay))) return false
  if (c.flag?.some((f) => !truthy(s.flags[f]))) return false
  if (c.noFlag?.some((f) => truthy(s.flags[f]))) return false
  if (c.minBadges !== undefined && s.badges.length < c.minBadges) return false
  if (c.maxBadges !== undefined && s.badges.length > c.maxBadges) return false
  if (c.minParty !== undefined && s.party.length < c.minParty) return false
  if (c.maxParty !== undefined && s.party.length > c.maxParty) return false
  if (c.minBossBank !== undefined && !s.party.some((cr) => bankLevels(cr) >= c.minBossBank!)) return false
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

/** The overworld reports the terrain by its display name (nameZh), not its key. */
export function isTallGrassName(nameZh: string): boolean {
  return CONTENT.terrain.some((t) => t.nameZh === nameZh && !!t.tallGrass)
}

export function tipSeen(s: ProgressView, id: string): boolean {
  return truthy(s.flags[tipFlag(id)])
}

/** A tip that was never shown but whose lesson the save already moved past is not worth showing. */
export function tipLive(tip: TipDef, s: ProgressView): boolean {
  return !tipSeen(s, tip.id) && !(tip.expires && condHolds(tip.expires, s))
}

/** Every `after` tip was shown or no longer applies (its own expiry), so teaching order holds across reloads. */
export function afterDone(tip: TipDef, list: readonly TipDef[], s: ProgressView): boolean {
  return (tip.after ?? []).every((id) => {
    const prior = list.find((x) => x.id === id)
    return !prior || tipSeen(s, id) || !tipLive(prior, s)
  })
}

// -- `on` triggers: bus payloads and battle cues ---------------------------------------------------------------

function matchOne(m: Matcher, v: unknown): boolean {
  if (typeof m !== 'object') return v === m
  if (typeof v === 'number') return (m.min === undefined || v >= m.min) && (m.max === undefined || v <= m.max) && (!m.in || m.in.includes(v))
  if (typeof v !== 'string') return false
  return (m.startsWith === undefined || v.startsWith(m.startsWith)) && (m.endsWith === undefined || v.endsWith(m.endsWith)) && (!m.in || m.in.includes(v))
}

export function matchPayload(match: Record<string, Matcher> | undefined, payload: Record<string, unknown>): boolean {
  return Object.entries(match ?? {}).every(([k, m]) => matchOne(m, payload[k]))
}

/** Adds derived fields the data may test: rarityOrder for dex events, mapKind for map:entered. */
export function enrich(name: string, payload: Record<string, unknown>, world: World): Record<string, unknown> {
  if (name === 'dex:seen' || name === 'dex:caught') {
    const rarity = CONTENT.species[String(payload.speciesId)]?.rarity
    return { ...payload, rarityOrder: CONTENT.rarityById[rarity ?? '']?.order ?? 0 }
  }
  if (name === 'map:entered') return { ...payload, mapKind: world.maps[String(payload.mapId)]?.kind ?? '' }
  return payload
}

export interface Cue { cue: string; payload: Record<string, unknown> }

/** Teachable moments in a batch of battle events (side 0 = the local player). */
export function battleCues(events: readonly BattleEvent[]): Cue[] {
  const out: Cue[] = []
  const immune = noEffectPattern()
  for (const e of events) {
    switch (e.t) {
      case 'turn': out.push({ cue: 'turn', payload: { turn: e.turn } }); break
      case 'damage': {
        const side = e.side
        const eff = e.effectiveness
        if (eff > 1) out.push({ cue: side === 1 ? 'superEffective' : 'takenSuper', payload: { side, effectiveness: eff } })
        if (eff >= 4) out.push({ cue: 'doubleSuper', payload: { side, effectiveness: eff } })
        if (eff > 0 && eff < 1) out.push({ cue: 'resisted', payload: { side, effectiveness: eff } })
        if (eff > 0 && eff <= 0.25) out.push({ cue: 'doubleResist', payload: { side, effectiveness: eff } })
        if (e.crit) out.push({ cue: 'crit', payload: { side } })
        break
      }
      case 'msg': if (immune?.test(e.text)) out.push({ cue: 'immune', payload: {} }); break
      case 'miss': out.push({ cue: 'miss', payload: { side: e.side } }); break
      case 'status': if (e.status) out.push({ cue: 'status', payload: { side: e.side, status: e.status } }); break
      case 'volatile': if (e.on) out.push({ cue: 'volatile', payload: { side: e.side } }); break
      case 'stat': out.push({ cue: 'stat', payload: { side: e.side, delta: e.delta } }); break
      case 'weather': out.push({ cue: 'weather', payload: {} }); break
      case 'ability': out.push({ cue: 'ability', payload: { side: e.side } }); break
      case 'faint': out.push({ cue: e.side === 0 ? 'faintOwn' : 'faintFoe', payload: {} }); break
      case 'levelUp': out.push({ cue: 'levelUp', payload: { level: e.level } }); break
      case 'moveLearnable': out.push({ cue: 'moveLearnable', payload: {} }); break
      case 'evolveReady': out.push({ cue: 'evolveReady', payload: {} }); break
      case 'catch': out.push({ cue: e.success ? 'caught' : 'catchFail', payload: {} }); break
      default: break
    }
  }
  return out
}

let noEffectRe: RegExp | null | undefined
/** The engine reports immunity only as a rendered message; recognise it from the same text template. */
function noEffectPattern(): RegExp | null {
  if (noEffectRe !== undefined) return noEffectRe
  const tpl = CONTENT.text['battle.noEffect']
  noEffectRe = typeof tpl === 'string' && tpl.length > 4
    ? new RegExp(tpl.split(/\{\w+\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+'))
    : null
  return noEffectRe
}

/** A lesson counts as learnt once an NPC taught it (`teach`) or one of its tips was shown. */
export function lessonLearned(lesson: LessonDef, s: Pick<ProgressView, 'flags'>, cfg: TutorialConfig = TUTORIAL): boolean {
  return truthy(s.flags[`${cfg.curriculum.flagPrefix}${lesson.id}`]) || (lesson.tips ?? []).some((id) => tipSeen(s as ProgressView, id))
}
