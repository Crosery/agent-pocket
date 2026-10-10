// Typed view of content/tutorial.json (objective rules + one-time tips) and its validator.
import type { ScriptStep, World } from '../../shared/types.ts'
import { CONTENT } from '../../shared/content/index.ts'
import tutorialJson from '../../../content/tutorial.json' with { type: 'json' }
import type { NavigationRules } from '../world/quest-navigation.ts'
import { walkSteps } from '../../shared/world/story.ts'
import { ATTENTION } from '../attention/config.ts'

export interface Cond {
  flag?: string[]
  noFlag?: string[]
  minBadges?: number
  maxBadges?: number
  minParty?: number
  maxParty?: number
  /** Some boss card in the party holds at least this many banked levels (exp past its badge cap). */
  minBossBank?: number
  minStat?: Record<string, number>
  maxStat?: Record<string, number>
  /** Every listed item is in the bag. */
  hasItem?: string[]
  /** At least one item of any listed category is in the bag. */
  hasCategory?: string[]
  /** Live state: the clock is in one of these times of day. */
  timeOfDay?: string[]
}

/** Payload field test of an `on` trigger: literal equality or a small operator object. */
export type Matcher = string | number | boolean | { min?: number; max?: number; startsWith?: string; endsWith?: string; in?: (string | number)[] }

export interface ObjectiveRule {
  id: string
  when?: Cond
  /** Text key; {stage} / {n} are filled in, {confirm} etc. become key caps. */
  text: string
  /** Anchor names (world anchors); the nearest one on the player's map is pointed at. */
  target?: string[]
  /** Use the current stage text of this quest as {stage}; the rule matches while the quest is open. */
  fromQuest?: string
  textDone?: string
}

/** Game-bus events an `on` trigger may listen to (payload fields are what `match` tests; see logic.ts enrich). */
export const ON_EVENTS = [
  'screen:opened', 'badge:earned', 'quest:updated', 'dex:seen', 'dex:caught', 'party:changed', 'map:entered', 'region:entered',
  'net:status', 'world:event', 'battle:end', 'bag:changed', 'attention:raised',
] as const

/** Moments inside a battle derived from its event stream (logic.ts battleCues). */
export const BATTLE_CUES = [
  'turn', 'superEffective', 'resisted', 'immune', 'takenSuper', 'doubleSuper', 'doubleResist', 'crit', 'miss', 'status', 'stat', 'weather',
  'ability', 'volatile', 'faintOwn', 'faintFoe', 'levelUp', 'moveLearnable', 'evolveReady', 'caught', 'catchFail',
] as const

export type TipTrigger =
  | { kind: 'free'; delaySec?: number; needs?: Cond }
  | { kind: 'npcNear'; radius: number }
  | { kind: 'tallGrass' }
  | { kind: 'hurt'; hpBelow: number; delaySec?: number }
  | { kind: 'battle'; delaySec?: number; battleKinds?: string[]; needs?: Cond }
  | { kind: 'menu'; delaySec?: number }
  /** A sign / ground item within `radius` tiles of the player. */
  | { kind: 'near'; what: 'sign' | 'item'; radius: number }
  /**
   * A bus event (ON_EVENTS) or a battle cue (BATTLE_CUES) whose payload satisfies `match`.
   * phase: battle = shown while the fight is up and dropped when it ends; field = shown once the player is free in the
   * world; screen = shown while a full-screen panel is up (dropped when it closes).
   */
  | { kind: 'on'; on: string; match?: Record<string, Matcher>; delaySec?: number; phase: 'battle' | 'field' | 'screen'; needs?: Cond }

/** Where a tip card or manual page can send the player: the type chart, on a view and optionally a type. */
export interface ChartLink {
  view?: 'type' | 'grid' | 'loops'
  type?: string
}

export interface LoopDef {
  id: string
  /** Types in order: each one's moves are super effective (x2) against the next, the last against the first. */
  types: string[]
  /** The ring is the starter triangle (shown with that tag). */
  starter?: boolean
}

export interface TipDef {
  id: string
  trigger: TipTrigger
  /** Text namespace key: <text>.title / <text>.body. */
  text: string
  expires?: Cond
  /** Tips that must have been shown (or have expired) before this one may appear. */
  after?: string[]
  /** Screen edge the card sits on (default bottom; battle tips sit right, above the player's status panel). */
  place?: 'top' | 'bottom' | 'right'
  /** The tip closes by itself once the player does what it explains. */
  doneOn?: 'moved' | 'dialogue'
  /** The tip is only worth showing while this attention source (content/ui.json attention) still has something waiting. */
  whileAttention?: string
  /** Offers a screen: a button on the card and a key (battle tips only, the card is out of the way of the battle UI). */
  open?: { screen: 'typeChart'; action: (typeof KEY_PLACEHOLDERS)[number]; /** Button label key; <text>Touch is the phone variant (no key cap). */ text: string }
}

export interface LessonDef {
  id: string
  group: string
  /** Tips that teach it in play; the manual page is t('tutorial.manual.<id>.title|body'). */
  tips?: string[]
  /** NPCs whose script runs {op:'teach', lesson: <id>}. */
  npcs?: string[]
  /** The manual page offers a button that opens the type chart here. */
  chart?: ChartLink
}

export interface TutorialConfig {
  objective: {
    refreshSec: number
    collapseSec: number
    arrow: { minDistance: number; stepsPerTile: number }
    navigation: NavigationRules
    markers: { flag: string; on: 'region:entered'; region: string }[]
    rules: ObjectiveRule[]
  }
  tips: { layer: { ttlSec: number; fadeMs: number; gapSec: number; staleSec: number }; list: TipDef[] }
  curriculum: { flagPrefix: string; groups: { id: string }[]; lessons: LessonDef[] }
  /** One-time notices: the migrated-save gift toast waits this long so the arrival toasts (anchor, rumour) do not push it off the stack. */
  notices: { legacyDelaySec: number }
  /** The memory loops the type chart screen draws as rings (every edge must be x2 in content/types.json). */
  typeChart: { loops: LoopDef[] }
}

export const TUTORIAL = tutorialJson as unknown as TutorialConfig

export const TIP_FLAG_PREFIX = 'tip:'

/** Placeholders that render as key caps ({confirm} -> Z / A / ...) plus {move}. */
export const KEY_PLACEHOLDERS = ['confirm', 'cancel', 'menu', 'run', 'map', 'minimap', 'chat', 'bike', 'quickSave'] as const

const COND_KEYS = new Set(['flag', 'noFlag', 'minBadges', 'maxBadges', 'minParty', 'maxParty', 'minBossBank', 'minStat', 'maxStat', 'hasItem', 'hasCategory', 'timeOfDay'])

export function validateTutorial(world: World, anchors: Record<string, unknown>, cfg: TutorialConfig = TUTORIAL): string[] {
  const errs: string[] = []
  if (!(cfg.notices.legacyDelaySec >= 0)) errs.push('notices.legacyDelaySec must be a number >= 0')
  const text = (key: string, where: string) => { if (!(key in CONTENT.text)) errs.push(`${where}: missing text "${key}"`) }
  const cond = (c: Cond | undefined, where: string) => {
    for (const k of Object.keys(c ?? {})) if (!COND_KEYS.has(k)) errs.push(`${where}: unknown condition "${k}"`)
  }
  text('tutorial.objective.title', 'objective')
  text('tutorial.objective.distance', 'objective')
  for (const [key, value] of Object.entries(cfg.objective.navigation)) {
    if (!Number.isFinite(value) || value <= 0) errs.push(`objective.navigation.${key}: must be positive`)
  }
  for (const [where, value] of [
    ['objective.collapseSec', cfg.objective.collapseSec],
    ['tips.layer.ttlSec', cfg.tips.layer.ttlSec],
    ['tips.layer.fadeMs', cfg.tips.layer.fadeMs],
  ] as const) if (!Number.isFinite(value) || value <= 0) errs.push(`${where}: must be positive`)
  const ids = new Set<string>()
  for (const r of cfg.objective.rules) {
    const where = `objective rule ${r.id}`
    if (ids.has(r.id)) errs.push(`${where}: duplicate id`)
    ids.add(r.id)
    text(r.text, where)
    text(r.text.replace('tutorial.objective.', 'tutorial.objective.short.'), where)
    if (r.textDone) text(r.textDone, where)
    if (r.textDone) text(r.textDone.replace('tutorial.objective.', 'tutorial.objective.short.'), where)
    cond(r.when, where)
    for (const a of r.target ?? []) if (!anchors[a]) errs.push(`${where}: unknown anchor "${a}"`)
    if (r.fromQuest && !world.quests.some((q) => q.id === r.fromQuest)) errs.push(`${where}: unknown quest "${r.fromQuest}"`)
  }
  const last = cfg.objective.rules[cfg.objective.rules.length - 1]
  if (!last || last.when) errs.push('objective: the last rule must be an unconditional fallback')
  for (const m of cfg.objective.markers) {
    if (!world.maps[world.startMap]?.regions.some((r) => r.id === m.region)) errs.push(`marker ${m.flag}: unknown region "${m.region}"`)
  }
  const tipIds = new Set<string>()
  for (const tip of cfg.tips.list) {
    const where = `tip ${tip.id}`
    if (tipIds.has(tip.id)) errs.push(`${where}: duplicate id`)
    tipIds.add(tip.id)
    text(`${tip.text}.title`, where)
    text(`${tip.text}.body`, where)
    cond(tip.expires, where)
    if (tip.whileAttention && !ATTENTION.sources.some((a) => a.id === tip.whileAttention)) errs.push(`${where}: unknown attention source "${tip.whileAttention}"`)
    if (tip.trigger.kind === 'free') cond(tip.trigger.needs, where)
    const tr = tip.trigger
    for (const a of tip.after ?? []) if (!cfg.tips.list.some((x) => x.id === a)) errs.push(`${where}: unknown "after" tip "${a}"`)
    if (tip.open) {
      if (!(KEY_PLACEHOLDERS as readonly string[]).includes(tip.open.action)) errs.push(`${where}: open.action "${tip.open.action}" is not a key placeholder`)
      if (tr.kind !== 'battle' && !(tr.kind === 'on' && tr.phase === 'battle')) errs.push(`${where}: open is for battle tips only`)
      text(tip.open.text, where)
      text(`${tip.open.text}Touch`, where)
    }
    if (tr.kind === 'battle') cond(tr.needs, where)
    if (tr.kind === 'on') {
      cond(tr.needs, where)
      if (!(ON_EVENTS as readonly string[]).includes(tr.on) && !(BATTLE_CUES as readonly string[]).includes(tr.on)) errs.push(`${where}: unknown event "${tr.on}"`)
    }
  }
  errs.push(...validateCurriculum(world, cfg))
  for (const d of ['keyboard', 'gamepad', 'touch']) text(`tutorial.device.${d}.move`, 'device')
  text('tutorial.tip.skip', 'tips')
  text('tutorial.tip.skipTouch', 'tips')
  text('tutorial.tip.close', 'tips')
  errs.push(...validateTypeChartTeaching(cfg))
  return errs
}

/** The loops the chart screen draws and the manual links to: real types, closed rings, and every arrow a real x2. */
export function validateTypeChartTeaching(cfg: TutorialConfig = TUTORIAL, c: typeof CONTENT = CONTENT): string[] {
  const errs: string[] = []
  const ids = new Set<string>()
  for (const loop of cfg.typeChart.loops) {
    const where = `typeChart loop ${loop.id}`
    if (ids.has(loop.id)) errs.push(`${where}: duplicate id`)
    ids.add(loop.id)
    if (!(`screens.typeChart.loops.${loop.id}.title` in c.text)) errs.push(`${where}: missing title text`)
    if (loop.types.length < 3 || new Set(loop.types).size !== loop.types.length) errs.push(`${where}: needs at least three different types`)
    for (const id of loop.types) if (!c.typeById[id]) errs.push(`${where}: unknown type "${id}"`)
    loop.types.forEach((from, i) => {
      const to = loop.types[(i + 1) % loop.types.length]
      if (c.typeById[from] && c.typeById[to] && (c.typeChart[from]?.[to] ?? 1) !== 2) errs.push(`${where}: ${from} -> ${to} is not super effective`)
    })
  }
  for (const l of cfg.curriculum.lessons) {
    if (!l.chart) continue
    if (l.chart.type && !c.typeById[l.chart.type]) errs.push(`lesson ${l.id}: chart type "${l.chart.type}" is unknown`)
    if (l.chart.view && !['type', 'grid', 'loops'].includes(l.chart.view)) errs.push(`lesson ${l.id}: chart view "${l.chart.view}" is unknown`)
  }
  return errs
}

/** The 「必要知识」 checklist: every lesson has a manual page and at least one in-play trigger; no tip is orphaned. */
export function validateCurriculum(world: World, cfg: TutorialConfig = TUTORIAL): string[] {
  const errs: string[] = []
  const groups = new Set(cfg.curriculum.groups.map((g) => g.id))
  for (const g of groups) if (!(`tutorial.group.${g}` in CONTENT.text)) errs.push(`group ${g}: missing text`)
  const tipIds = new Set(cfg.tips.list.map((x) => x.id))
  const taught = new Map<string, Set<string>>()
  for (const map of Object.values(world.maps)) {
    for (const n of map.npcs) walkSteps(n.script as ScriptStep[], (st) => {
      const s = st as { op: string; lesson?: string }
      if (s.op === 'teach' && s.lesson) (taught.get(s.lesson) ?? taught.set(s.lesson, new Set()).get(s.lesson)!).add(n.id)
    })
  }
  const ids = new Set<string>()
  const used = new Set<string>()
  for (const l of cfg.curriculum.lessons) {
    const where = `lesson ${l.id}`
    if (ids.has(l.id)) errs.push(`${where}: duplicate id`)
    ids.add(l.id)
    if (!groups.has(l.group)) errs.push(`${where}: unknown group "${l.group}"`)
    for (const k of ['title', 'body']) if (!(`tutorial.manual.${l.id}.${k}` in CONTENT.text)) errs.push(`${where}: missing manual ${k}`)
    if (!(l.tips?.length || l.npcs?.length)) errs.push(`${where}: no trigger (needs a tip or an npc)`)
    for (const id of l.tips ?? []) { used.add(id); if (!tipIds.has(id)) errs.push(`${where}: unknown tip "${id}"`) }
    for (const id of l.npcs ?? []) if (!taught.get(l.id)?.has(id)) errs.push(`${where}: npc "${id}" has no teach step for it`)
  }
  for (const id of tipIds) if (!used.has(id)) errs.push(`tip ${id}: not part of any lesson`)
  for (const lesson of taught.keys()) if (!ids.has(lesson)) errs.push(`teach step names unknown lesson "${lesson}"`)
  return errs
}
