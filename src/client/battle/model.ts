// Pure battle-presentation state: what the screen currently shows for each side, folded from BattleEvents in
// display order (independent of the engine, which has already mutated the parties by the time events play),
// plus the small calculations the presenter needs (exp bar segments, level-up stat deltas, effectiveness hints,
// catch placement). No DOM, no three — unit-tested under Node.
import type {
  BattleEvent, BattleInit, BattleResult, BattleSideKind, BattleStatKey, BossHud, Creature, CreatureView, MoveDef, SaveData,
  SideIndex, StatKey, TypeId,
} from '../../shared/types.ts'
import { CONTENT, t, typeEffectiveness, type Content } from '../../shared/content/index.ts'
import { STAT_KEYS, calcStats, expForLevel } from '../../shared/creature.ts'
import type { EffCategory } from './config.ts'

export type SlotState = 'ok' | 'status' | 'fainted'
export interface SlotInfo { state: SlotState; status: string | null }

export interface SideModel {
  readonly kind: BattleSideKind
  /** Party index on the field (-1 before the first send-out). */
  active: number
  /** Displayed creature (level/hp at battle level). */
  view: CreatureView | null
  /** The creature sprite is on the field (false after faint / recall / capture). */
  onField: boolean
  /** Party ball indicators. */
  slots: SlotInfo[]
  volatiles: string[]
  stages: Partial<Record<BattleStatKey, number>>
}

export interface Progress { level: number; exp: number }

export interface BattleModel {
  readonly sides: [SideModel, SideModel]
  weather: string
  /** Displayed level / exp of each own party member (exp bar source). */
  readonly progress: Progress[]
  /** Evolutions announced by the engine: party index -> species id. */
  readonly evolutions: Map<number, string>
  end: { result: BattleResult; winner: SideIndex | -1 } | null
  money: number
  /** Latest boss HUD snapshot (null outside boss fights). */
  boss: BossHud | null
}

const slotOf = (cr: Pick<Creature, 'hp' | 'status'>): SlotInfo =>
  cr.hp <= 0 ? { state: 'fainted', status: null } : cr.status ? { state: 'status', status: cr.status } : { state: 'ok', status: null }

/** Initial model from the BattleInit, taken before the engine starts (the engine mutates parties in place). */
export function createBattleModel(init: BattleInit, clear: string): BattleModel {
  const side = (i: SideIndex): SideModel => ({
    kind: init.sides[i].kind,
    active: -1,
    view: null,
    onField: false,
    slots: init.sides[i].party.map(slotOf),
    volatiles: [],
    stages: {},
  })
  return {
    sides: [side(0), side(1)],
    weather: clear,
    progress: init.sides[0].party.map((cr) => ({ level: cr.level, exp: cr.exp })),
    evolutions: new Map(),
    end: null,
    money: 0,
    boss: null,
  }
}

function refreshSlot(s: SideModel): void {
  if (s.active < 0 || !s.view) return
  while (s.slots.length <= s.active) s.slots.push({ state: 'ok', status: null })
  s.slots[s.active] = slotOf(s.view)
}

/** Folds one event into the model (call in display order, after its animation decided what it needs). */
export function applyEvent(m: BattleModel, e: BattleEvent): void {
  switch (e.t) {
    case 'switch': {
      const s = m.sides[e.side]
      s.active = e.partyIndex
      s.view = { ...e.creature }
      s.onField = e.creature.hp > 0
      s.volatiles = []
      s.stages = {}
      refreshSlot(s)
      break
    }
    case 'damage':
    case 'heal': {
      const s = m.sides[e.side]
      if (s.view) { s.view.hp = e.hp; s.view.maxHp = e.maxHp }
      refreshSlot(s)
      break
    }
    case 'status': {
      const s = m.sides[e.side]
      if (s.view) s.view.status = e.status
      refreshSlot(s)
      break
    }
    case 'faint': {
      const s = m.sides[e.side]
      if (s.view) { s.view.hp = 0; s.view.status = null }
      s.onField = false
      s.volatiles = []
      s.stages = {}
      refreshSlot(s)
      break
    }
    case 'volatile': {
      const s = m.sides[e.side]
      s.volatiles = s.volatiles.filter((v) => v !== e.volatile)
      if (e.on) s.volatiles.push(e.volatile)
      break
    }
    case 'stat': {
      const s = m.sides[e.side]
      s.stages[e.stat] = (s.stages[e.stat] ?? 0) + e.delta
      if (s.stages[e.stat] === 0) delete s.stages[e.stat]
      break
    }
    case 'weather':
      m.weather = e.weather
      break
    case 'boss':
      m.boss = e.hud
      break
    case 'form': {
      // Same battler, new body: stat stages and volatiles are announced by their own events.
      const s = m.sides[e.side]
      s.view = { ...e.creature }
      s.onField = e.creature.hp > 0
      refreshSlot(s)
      break
    }
    case 'catch':
      if (e.success) m.sides[1].onField = false
      break
    case 'exp': {
      const p = m.progress[e.partyIndex]
      if (p) { p.level = e.level; p.exp = e.exp } else m.progress[e.partyIndex] = { level: e.level, exp: e.exp }
      break
    }
    case 'evolveReady':
      m.evolutions.set(e.partyIndex, e.toSpeciesId)
      break
    case 'money':
      m.money += e.amount
      break
    case 'end':
      m.end = { result: e.result, winner: e.winner }
      break
    default:
      break
  }
}

/**
 * Result reported to the caller. The presented end event wins, then the engine (the presentation may have stopped
 * early); a battle that never finished counts as fled (local) or forfeited (PvP) so a client error never makes the
 * caller black out.
 */
export function finalResult(shown: BattleResult | undefined, engine: BattleResult | null | undefined, remote: boolean): BattleResult {
  return shown ?? engine ?? (remote ? 'forfeit' : 'run')
}

// ---------------------------------------------------------------------------
// Exp bar & level-up panel
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v)

/** Fill ratio of the exp bar at (level, exp). Max level shows a full bar. */
export function expRatio(growth: string, level: number, exp: number, c: Content = CONTENT): number {
  if (level >= c.config.party.maxLevel) return 1
  const lo = expForLevel(growth, level, c)
  const hi = expForLevel(growth, level + 1, c)
  return hi > lo ? clamp01((exp - lo) / (hi - lo)) : 1
}

export interface ExpSegment { level: number; from: number; to: number }

/** Bar animation from one (level, exp) to another: one segment per level, every crossed level ends full. */
export function expSegments(growth: string, from: Progress, to: Progress, c: Content = CONTENT): ExpSegment[] {
  const out: ExpSegment[] = []
  let level = from.level
  let exp = from.exp
  const last = Math.max(from.level, to.level)
  while (level < last) {
    out.push({ level, from: expRatio(growth, level, exp, c), to: 1 })
    level += 1
    exp = expForLevel(growth, level, c)
  }
  out.push({ level, from: expRatio(growth, level, exp, c), to: expRatio(growth, level, Math.max(exp, to.exp), c) })
  return out
}

export interface StatDelta { key: StatKey; before: number; after: number }

/** Stats at fromLevel vs toLevel for the level-up panel. */
export function levelUpStats(cr: Pick<Creature, 'speciesId' | 'ivs'>, fromLevel: number, toLevel: number, c: Content = CONTENT): StatDelta[] {
  const a = calcStats({ speciesId: cr.speciesId, ivs: cr.ivs, level: fromLevel }, c)
  const b = calcStats({ speciesId: cr.speciesId, ivs: cr.ivs, level: toLevel }, c)
  return STAT_KEYS.map((key) => ({ key, before: a[key], after: b[key] }))
}

// ---------------------------------------------------------------------------
// Effectiveness, moves, capture
// ---------------------------------------------------------------------------

/** Structural classification of a type multiplier (no effect / resisted / neutral / super effective). */
export function effCategory(mul: number): EffCategory {
  if (mul <= 0) return 'immune'
  if (mul < 1) return 'weak'
  if (mul > 1) return 'super'
  return 'normal'
}

/** Effectiveness of a move against defending types; null for moves that deal no typed damage. */
export function moveEffectiveness(move: MoveDef, defTypes: readonly TypeId[], c: Content = CONTENT): EffCategory | null {
  if (move.category === 'status' || !defTypes.length) return null
  const mul = typeEffectiveness(move.type, defTypes, c)
  if (move.effects.some((e) => e.kind === 'fixedDamage')) return mul === 0 ? 'immune' : 'normal'
  return effCategory(mul)
}

export type CatchPlacement = { where: 'party' } | { where: 'box'; box: number } | null

/** Where a newly caught creature goes: the party while it has room, else the first box with space. */
export function catchPlacement(save: Pick<SaveData, 'party' | 'boxes'>, c: Content = CONTENT): CatchPlacement {
  const P = c.config.party
  if (save.party.length < P.maxParty) return { where: 'party' }
  for (let i = 0; i < P.boxCount; i++) {
    const box = save.boxes[i]
    if (!box || box.length < P.boxSize) return { where: 'box', box: i }
  }
  return null
}

/** Moves the new species learns on evolving (level 0 = "on evolution", or the current level) not yet known. */
export function evolutionMoves(cr: Pick<Creature, 'level' | 'moves'>, toSpeciesId: string, c: Content = CONTENT): string[] {
  const to = c.species[toSpeciesId]
  if (!to) return []
  const out: string[] = []
  for (const e of to.learnset) {
    if ((e.level !== 0 && e.level !== cr.level) || !c.moves[e.move]) continue
    if (cr.moves.some((m) => m.id === e.move) || out.includes(e.move)) continue
    out.push(e.move)
  }
  return out
}

// ---------------------------------------------------------------------------
// Boss HUD
// ---------------------------------------------------------------------------


/** The label cut to a display width (wide characters count 2): "支付" and "juice" both fit, "苹果订阅" becomes "苹果". */
export function fitLabel(label: string, width: number): string {
  let used = 0
  let out = ''
  for (const ch of label.trim().split(/\s+/)[0]) {
    const w = /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
    if (used + w > width) break
    used += w
    out += ch
  }
  return out
}

export type BossChipTone = 'neutral' | 'good' | 'warn' | 'bad'
export interface BossChip {
  id: string
  /** The one-line reading ("支付 1/3", "蓄力：…"). */
  text: string
  tone: BossChipTone
  /** Fill ratio for counter-like meters, null for state / alert chips. */
  fill: number | null
  alert: boolean
  /** The mechanic's name alone, for the compact tile. */
  label: string
  /** Full reading shown when the tile is hovered or tapped (same as `text`). */
  readout: string
  /** Counter meters: the maximum; null otherwise. */
  max: number | null
  /** State-word meters: the current state's word. */
  stateText: string | null
}
export interface BossPanelInfo { bossId: string; title: string; phase: number; phases: number; chips: BossChip[] }

/** The boss HUD before the first engine snapshot (shown the moment the boss appears). */
export function bossOpeningHud(bossId: string, c: Content = CONTENT): BossHud | null {
  const def = c.bosses[bossId]
  if (!def) return null
  const meters: Record<string, number> = {}
  for (const m of def.meters) if (m.show) meters[m.id] = m.start ?? 0
  return { bossId, form: def.initialForm, phase: 1, phases: 1 + def.triggers.filter((x) => x.phase).length, meters, charge: null, enrage: 0 }
}

/** What the foe status window shows for a boss snapshot: title, phase pips and the few chips worth reading mid-fight. */
export function bossPanelInfo(hud: BossHud, c: Content = CONTENT): BossPanelInfo | null {
  const def = c.bosses[hud.bossId]
  if (!def) return null
  const chips: BossChip[] = []
  for (const m of def.meters) {
    if (!m.show) continue
    const value = Math.min(m.max, Math.max(0, Math.round(hud.meters[m.id] ?? 0)))
    const label = t(m.label)
    if (m.states) {
      const word = t(m.states[value] ?? '')
      const text = `${label} ${word}`
      chips.push({ id: m.id, text, tone: m.tone ?? 'neutral', fill: null, alert: false, label, readout: text, max: null, stateText: word })
    } else {
      const text = t('battleui.boss.meter', { label, value, max: m.max })
      chips.push({ id: m.id, text, tone: m.tone ?? 'neutral', fill: value / m.max, alert: false, label, readout: text, max: m.max, stateText: null })
    }
  }
  if (hud.charge) {
    const text = t('battleui.boss.charge', { move: c.moves[hud.charge]?.nameZh ?? hud.charge })
    chips.push({ id: 'charge', text, tone: 'bad', fill: null, alert: true, label: t('battleui.boss.chargeLabel'), readout: text, max: null, stateText: null })
  }
  if (hud.enrage > 0) {
    const text = t('battleui.boss.enrage', { n: hud.enrage })
    chips.push({ id: 'enrage', text, tone: 'bad', fill: null, alert: false, label: t('battleui.boss.enrageLabel'), readout: text, max: null, stateText: `×${hud.enrage}` })
  }
  return { bossId: hud.bossId, title: t(def.title), phase: hud.phase, phases: hud.phases, chips }
}
