// Typed view of content/tutorial.json (objective rules + one-time tips) and its validator.
import type { World } from '../../shared/types.ts'
import { CONTENT } from '../../shared/content/index.ts'
import tutorialJson from '../../../content/tutorial.json' with { type: 'json' }

export interface Cond {
  flag?: string[]
  noFlag?: string[]
  minBadges?: number
  maxBadges?: number
  minParty?: number
  maxParty?: number
  minStat?: Record<string, number>
  maxStat?: Record<string, number>
}

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

export type TipTrigger =
  | { kind: 'free'; delaySec?: number; needs?: Cond }
  | { kind: 'npcNear'; radius: number }
  | { kind: 'tallGrass' }
  | { kind: 'hurt'; hpBelow: number; delaySec?: number }
  | { kind: 'battle'; delaySec?: number; battleKinds?: string[]; after?: string }
  | { kind: 'menu'; delaySec?: number }

export interface TipDef {
  id: string
  trigger: TipTrigger
  /** Text namespace key: <text>.title / <text>.body. */
  text: string
  expires?: Cond
  /** Screen edge the card sits on (default bottom; battle tips sit right, above the player's status panel). */
  place?: 'top' | 'bottom' | 'right'
  /** The tip closes by itself once the player does what it explains. */
  doneOn?: 'moved' | 'dialogue'
}

export interface TutorialConfig {
  objective: {
    refreshSec: number
    arrow: { minDistance: number; stepsPerTile: number }
    markers: { flag: string; on: 'region:entered'; region: string }[]
    rules: ObjectiveRule[]
  }
  tips: { layer: { ttlSec: number; fadeMs: number; gapSec: number }; list: TipDef[] }
}

export const TUTORIAL = tutorialJson as unknown as TutorialConfig

export const TIP_FLAG_PREFIX = 'tip:'

/** Placeholders that render as key caps ({confirm} -> Z / A / ...) plus {move}. */
export const KEY_PLACEHOLDERS = ['confirm', 'cancel', 'menu', 'run', 'map', 'minimap', 'chat', 'bike', 'quickSave'] as const

const COND_KEYS = new Set(['flag', 'noFlag', 'minBadges', 'maxBadges', 'minParty', 'maxParty', 'minStat', 'maxStat'])

export function validateTutorial(world: World, anchors: Record<string, unknown>, cfg: TutorialConfig = TUTORIAL): string[] {
  const errs: string[] = []
  const text = (key: string, where: string) => { if (!(key in CONTENT.text)) errs.push(`${where}: missing text "${key}"`) }
  const cond = (c: Cond | undefined, where: string) => {
    for (const k of Object.keys(c ?? {})) if (!COND_KEYS.has(k)) errs.push(`${where}: unknown condition "${k}"`)
  }
  text('tutorial.objective.title', 'objective')
  text('tutorial.objective.distance', 'objective')
  const ids = new Set<string>()
  for (const r of cfg.objective.rules) {
    const where = `objective rule ${r.id}`
    if (ids.has(r.id)) errs.push(`${where}: duplicate id`)
    ids.add(r.id)
    text(r.text, where)
    if (r.textDone) text(r.textDone, where)
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
    if (tip.trigger.kind === 'free') cond(tip.trigger.needs, where)
    const tr = tip.trigger
    if (tr.kind === 'battle' && tr.after && !cfg.tips.list.some((x) => x.id === tr.after)) errs.push(`${where}: unknown "after" tip`)
  }
  for (const d of ['keyboard', 'gamepad', 'touch']) text(`tutorial.device.${d}.move`, 'device')
  text('tutorial.tip.skip', 'tips')
  text('tutorial.tip.skipTouch', 'tips')
  return errs
}
