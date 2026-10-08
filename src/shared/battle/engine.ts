// Singles battle engine (IBattleEngine). Deterministic: all randomness comes from Rng(init.seed).
// Statuses, volatiles, weathers and abilities are interpreted generically from their content definitions;
// there is no per-id logic. Every message is a t('battle.*') template from content/text/zh-CN/battle.json.
import type {
  BattleAction, BattleEvent, BattleInit, BattleRequest, BattleResult, BattleSideInit, BossState, Creature, CreatureView, ItemDef,
  MoveDef, SideIndex, StatChanges, Stats, WeatherId,
} from '../types.ts'
import type { IBattleEngine } from '../contracts.ts'
import { CONTENT, t, typeEffectiveness, type Content } from '../content/index.ts'
import { Rng } from '../rng.ts'
import { calcStats, creatureName, evolutionTarget, expYield, gainExp } from '../creature.ts'
import { RULES, type BattleRules } from './rules.ts'
import {
  BATTLE_STAT_KEYS, PERCENT, catchShakes, clamp, computeDamage, condHolds, critChance, effectsOn, emptyStages, hasEffect, hitChance,
  escapes, isDamaging, priorityOf, speciesTypes, speedOf, type Fighter, type Stages,
} from './formulas.ts'
import { fill, msgEvent, perspective, type Render } from './messages.ts'
import { chooseAiAction, chooseAiReplacement, type AiIntrospection } from './ai.ts'
import { BOSS_SIDE, BossDirector, type BossHost } from './boss.ts'

export { perspective }

/** Schema sentinel for "no weather" (types.ts WeatherId). */
const CLEAR: WeatherId = 'none'
/** Countdown value meaning "no fixed duration" (volatiles last until switch-out; field weather all battle). */
const INDEFINITE = -1

type Queued =
  | { kind: 'move'; moveIndex: number; struggle: boolean; forced?: string }
  | { kind: 'switch'; partyIndex: number }
  | { kind: 'item'; itemId: string; partyIndex: number }
  | { kind: 'run' }
  | { kind: 'forfeit' }
  | { kind: 'recharge' }

interface Battler {
  stages: Stages
  /** volatile id -> remaining end-of-turn ticks (INDEFINITE = indefinite). */
  volatiles: Map<string, number>
  protectChain: number
  protectedThisTurn: boolean
  recharging: boolean
  acted: boolean
  faintHandled: boolean
}

interface SideState {
  idx: SideIndex
  init: BattleSideInit
  party: Creature[]
  active: number
  b: Battler
  items: Record<string, number>
  action: Queued | null
  mustSwitch: boolean
  runAttempts: number
  /** Wild flee window already announced (BattleSideInit.flee). */
  fleeWarned: boolean
}

type Param = string | number | Render
type ParamMap = Record<string, Param>

const newBattler = (): Battler => ({
  stages: emptyStages(), volatiles: new Map(), protectChain: 0, protectedThisTurn: false, recharging: false, acted: false, faintHandled: false,
})

const other = (s: SideIndex): SideIndex => (s === 0 ? 1 : 0)
const SIDES: readonly SideIndex[] = [0, 1]

export class BattleEngine implements IBattleEngine, AiIntrospection {
  readonly init: BattleInit
  private readonly c: Content
  private readonly rng: Rng
  private readonly sides: [SideState, SideState]
  private out: BattleEvent[] = []
  private started = false
  private phase: 'action' | 'switch' = 'action'
  private turnNo = 0
  private done = false
  private outcome: BattleResult | null = null
  private weatherId: WeatherId = CLEAR
  private weatherLeft = INDEFINITE
  private caughtCr: Creature | null = null
  /** Boss rules of the enemy side's boss creature (BattleSideInit.boss), if any. */
  private boss: BossDirector | null = null
  /** side-1 party index -> side-0 party indices that battled it (exp split). */
  private readonly faced = new Map<number, Set<number>>()
  private readonly leveled = new Set<number>()
  /** Creatures whose hp was rescaled to the level cap (restored when the battle ends). */
  private readonly capScaled: { cr: Creature; full: number; capped: number }[] = []

  constructor(init: BattleInit, c: Content = CONTENT) {
    this.init = init
    this.c = c
    this.rng = new Rng(init.seed)
    const mk = (idx: SideIndex): SideState => {
      const s = init.sides[idx]
      const first = s.party.findIndex((cr) => cr.hp > 0)
      return {
        idx, init: s, party: s.party, active: Math.max(0, first), b: newBattler(), items: { ...(s.items ?? {}) },
        action: null, mustSwitch: false, runAttempts: 0, fleeWarned: false,
      }
    }
    this.sides = [mk(0), mk(1)]
    this.applyLevelCap()
    this.attachBoss()
  }

  // ------------------------------------------------------------------ public state

  get turn(): number { return this.turnNo }
  get finished(): boolean { return this.done }
  get result(): BattleResult | null { return this.outcome }
  get weather(): WeatherId { return this.weatherId }
  get caught(): Creature | null { return this.caughtCr }

  party(side: SideIndex): Creature[] { return this.sides[side].party }
  activeIndex(side: SideIndex): number { return this.sides[side].active }
  activeView(side: SideIndex): CreatureView { return this.viewOf(this.act(side)) }
  stages(side: SideIndex): Record<string, number> { return { ...this.sides[side].b.stages } }
  volatiles(side: SideIndex): string[] { return [...this.sides[side].b.volatiles.keys()] }
  itemsLeft(side: SideIndex): Readonly<Record<string, number>> { return { ...this.sides[side].items } }
  /** Stats of a side's active creature in this battle (boss multipliers included). */
  fighterStats(side: SideIndex): Stats { return this.statsOf(this.act(side)) }
  /** Boss contract (docs/bosses.md): everything that makes the boss fight resumable, or null without a boss. */
  extractBossState(): BossState | null { return this.boss ? this.boss.extract() : null }
  applyBossState(state: BossState): void { this.boss?.apply(state) }
  /** Max hp of a party member at the battle level. */
  battleMaxHp(side: SideIndex, partyIndex: number): number { return this.maxHpOf(this.sides[side].party[partyIndex]) }

  start(): BattleEvent[] {
    if (this.started) return []
    this.started = true
    this.out = []
    const foeKind = this.sides[1].init.kind
    if (foeKind === 'trainer') this.sayFn((v) => t('battle.trainerChallenge', { trainer: this.label(other(v)) }, this.c))
    else if (foeKind !== 'wild') this.sayFn((v) => t('battle.pvpStart', { trainer: this.label(other(v)) }, this.c))
    for (const s of [1, 0] as const) if (this.hasUsable(s)) this.sendOut(s)
    this.markFaced()
    if (this.checkEnd()) return this.flush()
    const w = this.init.weather
    if (w && w !== CLEAR && this.c.weatherById[w]) this.setWeather(w, INDEFINITE)
    for (const s of this.speedOrder()) this.switchInAbilities(s)
    this.boss?.start()
    return this.flush()
  }

  request(side: SideIndex): BattleRequest {
    const wait: BattleRequest = { kind: 'wait' }
    if (!this.started || this.done) return wait
    const sd = this.sides[side]
    if (sd.action) return wait
    if (this.phase === 'switch') return sd.mustSwitch ? { kind: 'switch', forced: true } : wait
    if (sd.b.recharging) return wait
    return { kind: 'action', canSwitch: this.canSwitch(side), canRun: this.canRun(side), canItem: this.canItem(side) }
  }

  choose(side: SideIndex, action: BattleAction): string | null {
    if (this.done) return this.err('finished')
    if (!this.started) return this.err('notYourTurn')
    if ((side !== 0 && side !== 1) || !action || typeof action !== 'object') return this.err('badAction')
    const sd = this.sides[side]
    if (action.kind === 'forfeit') {
      sd.action = { kind: 'forfeit' }
      return null
    }
    const req = this.request(side)
    if (req.kind === 'wait') return this.err('notYourTurn')
    if (req.kind === 'switch') {
      if (action.kind !== 'switch') return this.err('mustSwitch')
      const e = this.switchError(side, action.partyIndex)
      if (e) return e
      sd.action = { kind: 'switch', partyIndex: action.partyIndex }
      return null
    }
    switch (action.kind) {
      case 'move': {
        const usable = this.usableMoves(side)
        if (usable.length === 0) {
          sd.action = { kind: 'move', moveIndex: Number.isInteger(action.moveIndex) ? action.moveIndex : 0, struggle: true }
          return null
        }
        const e = this.moveError(side, action.moveIndex)
        if (e) return e
        sd.action = { kind: 'move', moveIndex: action.moveIndex, struggle: false }
        return null
      }
      case 'switch': {
        if (!req.canSwitch) return this.err('cantSwitch')
        const e = this.switchError(side, action.partyIndex)
        if (e) return e
        sd.action = { kind: 'switch', partyIndex: action.partyIndex }
        return null
      }
      case 'item': {
        if (!req.canItem) return this.err('cantItem')
        const idx = action.partyIndex ?? sd.active
        const e = this.itemError(side, action.itemId, idx)
        if (e) return e
        sd.action = { kind: 'item', itemId: action.itemId, partyIndex: idx }
        return null
      }
      case 'run':
        if (!req.canRun) return this.err('cantRun')
        sd.action = { kind: 'run' }
        return null
      default:
        return this.err('badAction')
    }
  }

  ready(): boolean {
    if (!this.started || this.done) return false
    if (this.sides.some((sd) => sd.action?.kind === 'forfeit')) return true
    return SIDES.every((s) => this.isAi(s) || this.request(s).kind === 'wait')
  }

  step(): BattleEvent[] {
    if (this.done) return []
    if (!this.started) return this.start()
    if (!this.ready()) return []
    this.out = []
    const quitter = this.sides.find((sd) => sd.action?.kind === 'forfeit')
    if (quitter) {
      const q = quitter.idx
      this.sayFn((v) => (v === q ? t('battle.youForfeit', undefined, this.c) : t('battle.foeForfeit', { trainer: this.label(q) }, this.c)))
      this.finish('forfeit', other(q))
      return this.flush()
    }
    this.fillAiActions()
    if (this.phase === 'switch') this.resolveForcedSwitches()
    else this.runTurn()
    return this.flush()
  }

  // ------------------------------------------------------------------ helpers: state

  private act(s: SideIndex): Creature { const sd = this.sides[s]; return sd.party[sd.active] }
  private isAi(s: SideIndex): boolean { const k = this.sides[s].init.kind; return k === 'wild' || k === 'trainer' }
  private hasUsable(s: SideIndex): boolean { return this.sides[s].party.some((cr) => cr.hp > 0) }
  private lvl(cr: Creature): number {
    const cap = this.init.levelCap
    return cap !== undefined && cap > 0 ? Math.min(cr.level, cap) : cr.level
  }
  private plainStats(cr: Creature): Stats { return calcStats({ speciesId: cr.speciesId, ivs: cr.ivs, level: this.lvl(cr) }, this.c) }
  private statsOf(cr: Creature): Stats {
    const base = this.plainStats(cr)
    return this.boss ? this.boss.adjustStats(cr, base) : base
  }
  private maxHpOf(cr: Creature): number { return this.statsOf(cr).hp }

  private fighter(s: SideIndex): Fighter {
    const sd = this.sides[s]
    const cr = this.act(s)
    let critStageAdd = 0
    for (const id of sd.b.volatiles.keys()) critStageAdd += this.c.volatileById[id]?.critStageAdd ?? 0
    return { creature: cr, level: this.lvl(cr), stats: this.statsOf(cr), stages: sd.b.stages, critStageAdd }
  }

  private viewOf(cr: Creature): CreatureView {
    return {
      uid: cr.uid, speciesId: cr.speciesId, nickname: cr.nickname, level: this.lvl(cr), hp: cr.hp,
      maxHp: this.maxHpOf(cr), status: cr.status, shiny: cr.shiny,
    }
  }

  private applyLevelCap(): void {
    for (const sd of this.sides) {
      for (const cr of sd.party) {
        const capped = this.maxHpOf(cr)
        if (this.lvl(cr) < cr.level) {
          const full = calcStats(cr, this.c).hp
          this.capScaled.push({ cr, full, capped })
          cr.hp = cr.hp > 0 ? clamp(Math.round((cr.hp * capped) / full), 1, capped) : 0
        } else cr.hp = clamp(cr.hp, 0, capped)
      }
    }
  }

  private restoreLevelCap(): void {
    for (const { cr, full, capped } of this.capScaled) {
      const fullNow = Math.max(full, calcStats(cr, this.c).hp)
      cr.hp = cr.hp > 0 ? clamp(Math.round((cr.hp * fullNow) / capped), 1, fullNow) : 0
    }
    this.capScaled.length = 0
  }

  private markFaced(): void {
    const a0 = this.sides[0].active
    const a1 = this.sides[1].active
    if (this.sides[0].party[a0]?.hp > 0 && this.sides[1].party[a1]?.hp > 0) {
      const set = this.faced.get(a1) ?? new Set<number>()
      set.add(a0)
      this.faced.set(a1, set)
    }
  }

  private speedOrder(): SideIndex[] {
    const s0 = speedOf(this.fighter(0), this.c)
    const s1 = speedOf(this.fighter(1), this.c)
    if (s0 !== s1) return s0 > s1 ? [0, 1] : [1, 0]
    return this.rng.chance(0.5) ? [0, 1] : [1, 0]
  }

  // ------------------------------------------------------------------ boss hooks (rules live in boss.ts)

  private attachBoss(): void {
    const id = this.sides[BOSS_SIDE].init.boss
    const def = id ? this.c.bosses[id] : undefined
    const cr = def ? this.sides[BOSS_SIDE].party.find((x) => x.speciesId === def.species) : undefined
    if (!def || !cr) return
    this.boss = new BossDirector(def, cr, this.bossHost())
    this.boss.begin()
  }

  private bossHost(): BossHost {
    const stageOf = (side: SideIndex) => this.sides[side].b
    return {
      c: this.c,
      turn: () => this.turnNo,
      setTurn: (n) => { this.turnNo = n },
      active: () => this.boss !== null && this.act(BOSS_SIDE) === this.boss.cr,
      say: (key, params) => this.say(key, params),
      emit: (e) => this.emit(e),
      view: (cr) => this.viewOf(cr),
      maxHp: (cr) => this.maxHpOf(cr),
      plainMaxHp: (cr) => this.plainStats(cr).hp,
      foe: () => this.act(other(BOSS_SIDE)),
      heal: (side, amount) => { if (this.heal(side, amount) > 0) this.say('battle.healed', { name: this.nameRef(side) }) },
      stages: (side, changes) => { this.applyStats(side, changes, BOSS_SIDE, true) },
      clearStages: (side) => {
        const b = stageOf(side)
        for (const k of BATTLE_STAT_KEYS) {
          if (!b.stages[k]) continue
          this.emit({ t: 'stat', side, stat: k, delta: -b.stages[k] })
          b.stages[k] = 0
        }
      },
      status: (side, id) => { this.applyStatus(side, id, BOSS_SIDE, true) },
      cure: (side) => { if (this.act(side).status) this.cureStatus(side) },
      volatile: (side, id) => { this.applyVolatile(side, id, BOSS_SIDE, true) },
      battler: () => {
        const b = stageOf(BOSS_SIDE)
        return { stages: { ...b.stages }, volatiles: Object.fromEntries(b.volatiles), recharging: b.recharging }
      },
      setBattler: (st) => {
        const b = stageOf(BOSS_SIDE)
        b.stages = { ...emptyStages(), ...st.stages }
        b.volatiles = new Map(Object.entries(st.volatiles))
        b.recharging = st.recharging
      },
    }
  }

  /** Queues the boss's action from its pattern (or a pending charged attack); false = use the ordinary AI. */
  private bossAction(): boolean {
    const b = this.boss
    if (!b || !b.active || this.request(BOSS_SIDE).kind !== 'action') return false
    const d = b.decide(this.rng)
    if (!d) return false
    if (d.forced) {
      this.sides[BOSS_SIDE].action = { kind: 'move', moveIndex: -1, struggle: false, forced: d.moveId }
      return true
    }
    const i = this.act(BOSS_SIDE).moves.findIndex((m) => m.id === d.moveId && m.pp > 0)
    return i >= 0 && this.choose(BOSS_SIDE, { kind: 'move', moveIndex: i }) === null
  }

  /** Bosses with an extraAction rule act a second time at the end of the turn. */
  private bossExtraAction(): void {
    const b = this.boss
    if (!b || !b.extraActionDue(this.turnNo) || this.act(BOSS_SIDE).hp <= 0 || this.act(other(BOSS_SIDE)).hp <= 0) return
    const d = b.decide(this.rng)
    const i = d && !d.forced ? this.act(BOSS_SIDE).moves.findIndex((m) => m.id === d.moveId && m.pp > 0) : -1
    if (i < 0) return
    this.say('battle.bossExtraAction', { name: this.nameRef(BOSS_SIDE) })
    this.executeMove(BOSS_SIDE, { kind: 'move', moveIndex: i, struggle: false })
    this.resolveFaints([other(BOSS_SIDE), BOSS_SIDE])
    if (!this.done) b.afterAction()
  }

  private bossLoot(b: BossDirector): void {
    const r = b.def.reward
    if (r.money && r.money > 0) {
      this.emit({ t: 'money', amount: r.money })
      this.say('battle.moneyWon', { amount: r.money, currency: t('common.money', undefined, this.c) })
    }
    for (const [itemId, qty] of Object.entries(r.items ?? {})) {
      this.emit({ t: 'loot', itemId, qty })
      this.say('battle.lootGot', { item: this.c.items[itemId]?.nameZh ?? itemId, qty })
    }
  }

  // ------------------------------------------------------------------ helpers: text

  private flush(): BattleEvent[] { const o = this.out; this.out = []; return o }
  private emit(e: BattleEvent): void { this.out.push(e) }
  private err(key: string, params?: Record<string, string | number>): string { return t(`battle.err.${key}`, params, this.c) }

  private sayFn(render: Render): void { this.out.push(msgEvent(render)) }
  private say(key: string, params: ParamMap = {}): void {
    this.sayFn((v) => {
      const p: Record<string, string | number> = {}
      for (const [k, x] of Object.entries(params)) p[k] = typeof x === 'function' ? x(v) : x
      return t(key, p, this.c)
    })
  }

  /** Display name of a side's creature for a viewer: own creatures plain, foes prefixed. */
  private nameRef(s: SideIndex, cr: Creature = this.act(s)): Render {
    const base = creatureName(cr, this.c)
    const wild = this.sides[s].init.kind === 'wild'
    return (v) => (v === s ? base : t(wild ? 'battle.wildName' : 'battle.foeName', { name: base }, this.c))
  }

  private label(s: SideIndex): string {
    const i = this.sides[s].init
    return i.trainerClass ? t('battle.trainerLabel', { class: i.trainerClass, name: i.name }, this.c) : i.name
  }

  /** Optional per-id flavour text (battle.<group>.<id>.<event>) falling back to the generic template. */
  private flavor(group: 'statusText' | 'volatileText', id: string, event: string, fallback: string): string {
    const k = `battle.${group}.${id}.${event}`
    return k in this.c.text ? k : fallback
  }

  private statName(stat: string): string { return this.c.statByKey[stat]?.nameZh ?? stat }

  /** '<prefix>.<n>' for the largest n <= magnitude that has a template (wording tiers live in the text file). */
  private magnitudeKey(prefix: string, magnitude: number): string {
    for (let m = magnitude; m > 1; m--) if (`${prefix}.${m}` in this.c.text) return `${prefix}.${m}`
    return `${prefix}.1`
  }

  // ------------------------------------------------------------------ validation

  private canSwitch(s: SideIndex): boolean {
    const sd = this.sides[s]
    if (sd.init.kind === 'wild') return false
    return sd.party.some((cr, i) => i !== sd.active && cr.hp > 0)
  }
  private canRun(s: SideIndex): boolean {
    return this.init.isWild && this.init.canRun && !this.isAi(s)
  }
  private canItem(s: SideIndex): boolean {
    const sd = this.sides[s]
    if (sd.init.kind === 'player') {
      const foe = this.sides[other(s)].init.kind
      return foe === 'wild' || foe === 'trainer'
    }
    if (sd.init.kind === 'trainer') return Object.values(sd.items).some((n) => n > 0)
    return false
  }

  private statusMoveBlocker(s: SideIndex): string | null {
    for (const id of this.sides[s].b.volatiles.keys()) if (this.c.volatileById[id]?.blocksStatusMoves) return id
    return null
  }

  private usableMoves(s: SideIndex): number[] {
    const cr = this.act(s)
    const blocked = this.statusMoveBlocker(s) !== null
    const out: number[] = []
    cr.moves.forEach((m, i) => {
      const def = this.c.moves[m.id]
      if (def && m.pp > 0 && !(blocked && def.category === 'status')) out.push(i)
    })
    return out
  }

  private moveError(s: SideIndex, idx: number): string | null {
    const cr = this.act(s)
    if (!Number.isInteger(idx) || idx < 0 || idx >= cr.moves.length) return this.err('badMove')
    const slot = cr.moves[idx]
    const def = this.c.moves[slot.id]
    if (!def) return this.err('badMove')
    if (slot.pp <= 0) return this.err('noPp')
    const blocker = this.statusMoveBlocker(s)
    if (blocker && def.category === 'status') {
      return this.err('blocked', { name: creatureName(cr, this.c), volatile: this.c.volatileById[blocker]?.nameZh ?? blocker })
    }
    return null
  }

  private switchError(s: SideIndex, idx: number): string | null {
    const sd = this.sides[s]
    if (!Number.isInteger(idx) || idx < 0 || idx >= sd.party.length) return this.err('badSwitch')
    const cr = sd.party[idx]
    if (idx === sd.active) return this.err('alreadyActive', { name: creatureName(cr, this.c) })
    if (cr.hp <= 0) return this.err('fainted', { name: creatureName(cr, this.c) })
    return null
  }

  private itemError(s: SideIndex, itemId: string, idx: number): string | null {
    const sd = this.sides[s]
    const item = typeof itemId === 'string' ? this.c.items[itemId] : undefined
    if (!item || !item.usableInBattle) return this.err('badItem')
    if (this.isAi(s) && !((sd.items[itemId] ?? 0) > 0)) return this.err('noItem')
    if (!Number.isInteger(idx) || idx < 0 || idx >= sd.party.length) return this.err('itemNoTarget')
    const cr = sd.party[idx]
    const max = this.maxHpOf(cr)
    const e = item.effect
    const bad = this.err('itemNoTarget')
    switch (e.kind) {
      case 'ball':
        return s === 0 && this.init.isWild && this.init.canCatch && this.act(1).hp > 0 ? null : this.err('cantCatch')
      case 'heal':
        return cr.hp > 0 && cr.hp < max ? null : bad
      case 'cure':
        return cr.hp > 0 && cr.status && (e.status === 'all' || e.status === cr.status) ? null : bad
      case 'healCure':
        return cr.hp > 0 && (cr.hp < max || cr.status) ? null : bad
      case 'revive':
        return cr.hp <= 0 ? null : bad
      case 'pp':
        return cr.moves.some((m) => m.pp < m.ppMax) ? null : bad
      case 'battleBoost':
        return idx === sd.active ? null : bad
      case 'bait':
        return s !== BOSS_SIDE && this.boss?.acceptsBait(e.tag) ? null : this.err('baitNoEffect')
      case 'escape':
        return this.init.isWild ? null : this.err('cantRun')
      default:
        return this.err('badItem')
    }
  }

  // ------------------------------------------------------------------ turn flow

  private fillAiActions(): void {
    for (const s of SIDES) {
      if (!this.isAi(s) || this.request(s).kind === 'wait') continue
      if (s === BOSS_SIDE && this.bossAction()) continue
      const pick = chooseAiAction(this, s, this.rng, this.c)
      if (this.choose(s, pick) === null) continue
      // AI produced something invalid for the current state: fall back to the first legal option.
      const usable = this.usableMoves(s)
      if (this.request(s).kind === 'switch') {
        const idx = this.sides[s].party.findIndex((cr, i) => i !== this.sides[s].active && cr.hp > 0)
        this.choose(s, { kind: 'switch', partyIndex: idx })
      } else this.choose(s, { kind: 'move', moveIndex: usable[0] ?? 0 })
    }
  }

  private runTurn(): void {
    this.turnNo += 1
    this.emit({ t: 'turn', turn: this.turnNo })
    this.boss?.turnStart()
    for (const sd of this.sides) {
      sd.b.acted = false
      sd.b.protectedThisTurn = false
      if (!sd.action && sd.b.recharging) sd.action = { kind: 'recharge' }
    }
    for (const s of this.orderActions()) {
      if (this.done) break
      const sd = this.sides[s]
      const a = sd.action
      if (!a) continue
      if (a.kind === 'switch') this.doSwitch(s, a.partyIndex, true)
      else if (a.kind === 'item') this.useItem(s, a.itemId, a.partyIndex)
      else if (a.kind === 'run') this.tryRun(s)
      else if ((a.kind === 'move' || a.kind === 'recharge') && this.act(s).hp > 0) this.executeMove(s, a)
      sd.b.acted = true
      if (!this.done) this.resolveFaints([other(s), s])
      if (!this.done) this.boss?.afterAction()
    }
    if (!this.done) this.bossExtraAction()
    if (!this.done) this.endOfTurn()
    if (!this.done) this.wildFlee()
    for (const sd of this.sides) sd.action = null
    if (!this.done) this.prepareReplacements()
  }

  private orderActions(): SideIndex[] {
    const acting = SIDES.filter((s) => this.sides[s].action)
    if (acting.length < 2) return acting
    const cmp = this.compareActions(0, 1)
    if (cmp !== 0) return cmp < 0 ? [0, 1] : [1, 0]
    return this.rng.chance(0.5) ? [0, 1] : [1, 0]
  }

  /** Negative when side x acts before side y. */
  private compareActions(x: SideIndex, y: SideIndex): number {
    const kx = this.orderKind(this.sides[x].action!)
    const ky = this.orderKind(this.sides[y].action!)
    const rank = RULES.actionOrder.indexOf(kx) - RULES.actionOrder.indexOf(ky)
    if (rank !== 0) return rank
    if (kx === 'move') {
      const p = this.queuedPriority(y) - this.queuedPriority(x)
      if (p !== 0) return p
      const lx = hasEffect(this.act(x), 'moveLast', this.c) ? 1 : 0
      const ly = hasEffect(this.act(y), 'moveLast', this.c) ? 1 : 0
      if (lx !== ly) return lx - ly
    }
    return speedOf(this.fighter(y), this.c) - speedOf(this.fighter(x), this.c)
  }

  /** Action kind as ranked by RULES.actionOrder (a recharge turn is a move turn). */
  private orderKind(a: Queued): BattleRules['actionOrder'][number] {
    return a.kind === 'recharge' || a.kind === 'forfeit' ? 'move' : a.kind
  }

  private queuedPriority(s: SideIndex): number {
    const a = this.sides[s].action
    if (!a || a.kind !== 'move') return 0
    if (a.struggle) return RULES.struggle.priority
    const def = this.c.moves[this.act(s).moves[a.moveIndex]?.id ?? '']
    return def ? priorityOf(this.fighter(s), def, this.weatherId, this.c) : 0
  }

  // ------------------------------------------------------------------ moves

  private struggleMove(): MoveDef {
    const st = RULES.struggle
    return {
      id: st.moveId, nameZh: t('battle.struggleName', undefined, this.c), nameEn: '', type: st.displayType, category: 'physical',
      power: this.c.config.battle.struggle.power, accuracy: 0, pp: 1, priority: st.priority, effects: [], description: '', anim: st.anim,
    }
  }

  private executeMove(s: SideIndex, a: Extract<Queued, { kind: 'move' | 'recharge' }>): void {
    const b = this.sides[s].b
    const me = this.act(s)
    if (a.kind === 'recharge') {
      b.recharging = false
      b.protectChain = 0
      this.say('battle.mustRecharge', { name: this.nameRef(s) })
      return
    }
    if (!this.statusGate(s) || !this.volatileGate(s) || me.hp <= 0) {
      b.protectChain = 0
      return
    }
    if (s === BOSS_SIDE && this.boss?.takeSkip()) {
      this.say('battle.bossIdle', { name: this.nameRef(s) })
      b.protectChain = 0
      return
    }
    const forcedDef = a.forced ? this.c.moves[a.forced] : undefined
    const slot = a.struggle || forcedDef ? undefined : me.moves[a.moveIndex]
    const def = slot && slot.pp > 0 ? this.c.moves[slot.id] : undefined
    const struggle = !forcedDef && (!slot || !def)
    let move: MoveDef
    if (forcedDef) {
      move = forcedDef
      this.boss?.clearCharge()
    } else if (!slot || !def) {
      this.say('battle.noMovesLeft', { name: this.nameRef(s) })
      move = this.struggleMove()
    } else {
      const blocker = this.statusMoveBlocker(s)
      if (def.category === 'status' && blocker) {
        this.say(this.flavor('volatileText', blocker, 'blocked', 'battle.volatileBlocked'), {
          name: this.nameRef(s), volatile: this.c.volatileById[blocker]?.nameZh ?? blocker, move: def.nameZh,
        })
        b.protectChain = 0
        return
      }
      slot.pp -= 1
      if (s !== BOSS_SIDE && this.boss) slot.pp = Math.max(0, slot.pp - this.boss.foePpCost())
      move = def
    }
    this.say('battle.usedMove', { name: this.nameRef(s), move: move.nameZh })
    this.emit({ t: 'move', side: s, moveId: move.id, anim: move.anim, type: move.type })
    const hit = this.runMove(s, move, struggle)
    if (s !== BOSS_SIDE) this.boss?.onFoeMove(move)
    if (hit && move.effects.some((e) => e.kind === 'recharge')) b.recharging = true
    if (move.effects.some((e) => e.kind === 'selfFaint') && me.hp > 0) this.hurt(s, me.hp)
    b.protectChain = b.protectedThisTurn ? b.protectChain + 1 : 0
  }

  /** Major-status gate before acting (cure chance, timed statuses, skip chance). */
  private statusGate(s: SideIndex): boolean {
    const cr = this.act(s)
    if (!cr.status) return true
    const def = this.c.statusById[cr.status]
    if (!def) {
      cr.status = null
      cr.statusTurns = 0
      return true
    }
    if (def.cureChancePerTurn !== undefined && this.rng.chance(def.cureChancePerTurn)) {
      this.cureStatus(s)
      return true
    }
    if (def.durationMin !== undefined || def.durationMax !== undefined) {
      if (cr.statusTurns <= 0) {
        this.cureStatus(s)
        return true
      }
      cr.statusTurns -= 1
    }
    if (def.skipChance !== undefined && this.rng.chance(def.skipChance)) {
      this.say(this.flavor('statusText', def.id, 'skip', 'battle.statusSkip'), { name: this.nameRef(s), status: def.nameZh })
      return false
    }
    return true
  }

  /** Volatile gate before acting (flinch, confusion-like self hits). */
  private volatileGate(s: SideIndex): boolean {
    const b = this.sides[s].b
    for (const id of b.volatiles.keys()) {
      const def = this.c.volatileById[id]
      if (def?.flinch) {
        this.say(this.flavor('volatileText', id, 'skip', 'battle.volatileSkip'), { name: this.nameRef(s), volatile: def.nameZh })
        return false
      }
    }
    for (const id of b.volatiles.keys()) {
      const def = this.c.volatileById[id]
      if (!def?.selfHitChance) continue
      this.say(this.flavor('volatileText', id, 'active', 'battle.volatileActive'), { name: this.nameRef(s), volatile: def.nameZh })
      if (!this.rng.chance(def.selfHitChance)) continue
      const f = this.fighter(s)
      const dmg = computeDamage(f, f, { power: this.c.config.battle.confusionSelfHitPower, category: 'physical', type: null, plain: true },
        this.weatherId, { crit: false, random: this.rollRandom() }, this.c).damage
      this.hurt(s, dmg)
      this.say(this.flavor('volatileText', id, 'selfHit', 'battle.volatileSelfHit'), { name: this.nameRef(s), volatile: def.nameZh })
      return false
    }
    return true
  }

  /** Resolves a move after it was announced. Returns whether it connected. */
  private runMove(s: SideIndex, move: MoveDef, struggle: boolean): boolean {
    const f = other(s)
    const user = this.act(s)
    const target = this.act(f)
    const damaging = isDamaging(move)
    const targetsFoe = damaging || move.effects.some((e) => 'target' in e && e.target === 'enemy')
    const mark = this.out.length
    if (targetsFoe) {
      if (target.hp <= 0) {
        this.say('battle.noTarget')
        return false
      }
      const guard = this.protector(f)
      if (guard) {
        if (hasEffect(user, 'ignoreProtect', this.c)) this.abilityTriggered(s)
        else {
          this.say(this.flavor('volatileText', guard, 'blockedHit', 'battle.protected'), { name: this.nameRef(f) })
          return false
        }
      }
      if (!damaging) {
        for (const e of effectsOn(target, 'blockFoeStatusMoves', this.c)) {
          if (!this.rollPct(e.chance)) continue
          this.abilityTriggered(f)
          this.say('battle.statusMoveBlocked', { name: this.nameRef(f) })
          return false
        }
      }
      if (!this.rollHit(s, f, move, struggle)) {
        this.emit({ t: 'miss', side: s })
        this.say('battle.missed', { name: this.nameRef(s) })
        return false
      }
      if (!struggle) {
        const absorb = effectsOn(target, 'absorbType', this.c).find((e) => e.types.includes(move.type))
        if (absorb) {
          this.abilityTriggered(f)
          this.heal(f, this.fraction(this.maxHpOf(target), absorb.healFraction))
          this.say('battle.absorbed', { name: this.nameRef(f) })
          return false
        }
      }
    }
    let dealt = 0
    if (damaging) {
      const r = this.strike(s, f, move, struggle)
      if (!r.hit) return false
      dealt = r.dealt
    }
    this.applyMoveEffects(s, f, move, damaging, dealt)
    if (struggle && user.hp > 0) {
      this.hurt(s, this.fraction(this.maxHpOf(user), this.c.config.battle.struggle.recoilFraction))
      this.say('battle.recoil', { name: this.nameRef(s) })
    }
    if (!damaging && this.out.length === mark) this.say('battle.failed')
    return true
  }

  private protector(s: SideIndex): string | null {
    for (const id of this.sides[s].b.volatiles.keys()) if (this.c.volatileById[id]?.protects) return id
    return null
  }

  private rollHit(s: SideIndex, f: SideIndex, move: MoveDef, struggle: boolean): boolean {
    if (struggle || move.accuracy === 0 || move.effects.some((e) => e.kind === 'alwaysHit')) return true
    return this.rng.next() * PERCENT < hitChance(this.fighter(s), this.fighter(f), move, this.c)
  }

  private rollPct(pct: number): boolean {
    if (pct >= PERCENT) return true
    return pct > 0 && this.rng.chance(pct / PERCENT)
  }

  private rollRandom(): number {
    const b = this.c.config.battle
    return b.randomMin + this.rng.next() * (b.randomMax - b.randomMin)
  }

  private fraction(max: number, frac: number): number {
    return Math.max(RULES.minHpChange, Math.floor(max * frac))
  }

  /** Damage phase of an attacking move: hits, crits, effectiveness, reactive abilities. */
  private strike(s: SideIndex, f: SideIndex, move: MoveDef, struggle: boolean): { hit: boolean; dealt: number } {
    const user = this.act(s)
    const target = this.act(f)
    const type = struggle ? null : move.type
    const eff = type === null ? 1 : typeEffectiveness(type, speciesTypes(target, this.c), this.c)
    if (eff === 0) {
      this.say('battle.noEffect', { name: this.nameRef(f) })
      return { hit: false, dealt: 0 }
    }
    const fixed = move.effects.find((e) => e.kind === 'fixedDamage')
    const multi = move.effects.find((e) => e.kind === 'multiHit')
    const highCrit = move.effects.some((e) => e.kind === 'highCrit')
    const hits = multi ? this.rng.int(multi.min, multi.max) : 1
    const announced = new Set<string>()
    let dealt = 0
    let landed = 0
    for (let i = 0; i < hits && target.hp > 0 && user.hp > 0; i++) {
      let dmg: number
      let crit = false
      if (fixed) dmg = fixed.amount === 'level' ? this.lvl(user) : fixed.amount
      else {
        const att = this.fighter(s)
        const def = this.fighter(f)
        crit = this.rng.chance(critChance(att, highCrit, this.c))
        const r = computeDamage(att, def, { power: move.power, category: move.category === 'special' ? 'special' : 'physical', type },
          this.weatherId, { crit, random: this.rollRandom() }, this.c)
        dmg = r.damage
        for (const tr of r.triggered) {
          const key = `${tr.by}:${tr.abilityId}`
          if (announced.has(key)) continue
          announced.add(key)
          this.abilityTriggered(tr.by === 'attacker' ? s : f)
        }
      }
      if (this.boss) dmg = this.boss.filterHit(s, move, dmg)
      dealt += this.hurt(f, dmg, fixed ? 1 : eff, crit)
      landed += 1
      if (crit) this.say('battle.crit')
    }
    if (hits > 1) this.say('battle.hitTimes', { count: landed })
    if (!fixed && eff > 1) this.say('battle.superEffective')
    else if (!fixed && eff < 1) this.say('battle.notVeryEffective')

    const mctx = { type, category: move.category, effectiveness: eff }
    if (target.hp > 0 && dealt > 0) {
      for (const e of effectsOn(target, 'afterHitBy', this.c)) {
        if (!condHolds(e.if, this.fighter(f), mctx, this.weatherId, this.c)) continue
        this.abilityTriggered(f)
        this.applyStats(f, e.stats, f, false)
      }
    }
    if (dealt > 0 && user.hp > 0) this.dealDamageAbilities(s, f, dealt)
    if (target.hp <= 0 && user.hp > 0) {
      for (const e of effectsOn(user, 'knockOut', this.c)) {
        this.abilityTriggered(s)
        this.applyStats(s, e.stats, s, false)
      }
    }
    return { hit: true, dealt }
  }

  private dealDamageAbilities(s: SideIndex, f: SideIndex, dealt: number): void {
    const user = this.act(s)
    const target = this.act(f)
    for (const e of effectsOn(user, 'dealDamage', this.c)) {
      if (e.volatile && target.hp > 0 && this.canReceiveVolatile(f, e.volatile.id) && this.rollPct(e.volatile.chance)) {
        this.abilityTriggered(s)
        this.applyVolatile(f, e.volatile.id, s, false)
      }
      if (e.status && target.hp > 0 && this.canReceiveStatus(f, e.status.id) && this.rollPct(e.status.chance)) {
        this.abilityTriggered(s)
        this.applyStatus(f, e.status.id, s, false)
      }
      if (e.drainFraction && user.hp > 0 && user.hp < this.maxHpOf(user)) {
        this.abilityTriggered(s)
        this.heal(s, this.fraction(dealt, e.drainFraction))
      }
      if (e.selfDamageFraction && user.hp > 0) {
        this.emit({ t: 'ability', side: s, abilityId: user.abilityId })
        this.hurt(s, this.fraction(this.maxHpOf(user), e.selfDamageFraction))
        this.say('battle.abilitySelfDamage', { name: this.nameRef(s), ability: this.abilityName(user) })
      }
    }
  }

  private applyMoveEffects(s: SideIndex, f: SideIndex, move: MoveDef, damaging: boolean, dealt: number): void {
    const verbose = !damaging
    const user = this.act(s)
    for (const e of move.effects) {
      switch (e.kind) {
        case 'status':
          if (this.rollPct(e.chance)) this.applyStatus(e.target === 'self' ? s : f, e.status, s, verbose)
          break
        case 'stat':
          if (this.rollPct(e.chance)) this.applyStats(e.target === 'self' ? s : f, e.stats, s, verbose)
          break
        case 'volatile':
          if (this.rollPct(e.chance)) this.applyVolatile(e.target === 'self' ? s : f, e.volatile, s, verbose)
          break
        case 'heal': {
          if (user.hp <= 0) break
          if (this.heal(s, this.fraction(this.maxHpOf(user), e.fraction)) > 0) this.say('battle.healed', { name: this.nameRef(s) })
          else if (verbose) this.say('battle.hpFull', { name: this.nameRef(s) })
          break
        }
        case 'drain':
          if (dealt > 0 && user.hp > 0 && this.heal(s, this.fraction(dealt, e.fraction)) > 0) this.say('battle.drained', { name: this.nameRef(f) })
          break
        case 'recoil':
          if (dealt > 0 && user.hp > 0) {
            this.hurt(s, this.fraction(dealt, e.fraction))
            this.say('battle.recoil', { name: this.nameRef(s) })
          }
          break
        case 'weather':
          this.setWeather(e.weather, this.c.config.battle.weatherTurns)
          break
        case 'cureStatus': {
          const tgt = e.target === 'self' ? s : f
          if (this.act(tgt).status && this.act(tgt).hp > 0) this.cureStatus(tgt)
          break
        }
        default:
          // multiHit, fixedDamage, highCrit, alwaysHit, recharge, selfFaint act around the hit itself.
          break
      }
    }
  }

  // ------------------------------------------------------------------ effects

  private abilityName(cr: Creature): string { return this.c.abilities[cr.abilityId]?.nameZh ?? cr.abilityId }

  private abilityTriggered(s: SideIndex): void {
    const cr = this.act(s)
    if (!cr.abilityId) return
    this.emit({ t: 'ability', side: s, abilityId: cr.abilityId })
    this.say('battle.abilityActivated', { name: this.nameRef(s), ability: this.abilityName(cr) })
  }

  /** Applies hp loss to the active creature; returns hp actually lost. */
  private hurt(s: SideIndex, amount: number, effectiveness = 1, crit = false): number {
    const cr = this.act(s)
    const lost = clamp(Math.floor(amount), 0, cr.hp)
    cr.hp -= lost
    this.emit({ t: 'damage', side: s, amount: lost, hp: cr.hp, maxHp: this.maxHpOf(cr), effectiveness, crit })
    return lost
  }

  /** Restores hp of the active creature; returns hp actually gained. */
  private heal(s: SideIndex, amount: number): number {
    const cr = this.act(s)
    if (cr.hp <= 0) return 0
    const max = this.maxHpOf(cr)
    const gained = clamp(Math.floor(amount), 0, max - cr.hp)
    if (gained <= 0) return 0
    cr.hp += gained
    this.emit({ t: 'heal', side: s, amount: gained, hp: cr.hp, maxHp: max })
    return gained
  }

  private statusImmune(cr: Creature, id: string): 'type' | 'ability' | null {
    if (this.boss?.cr === cr && this.boss.blocksStatus()) return 'type'
    const types = speciesTypes(cr, this.c)
    if ((this.c.statusImmunities[id] ?? []).some((ty) => types.includes(ty))) return 'type'
    if (effectsOn(cr, 'immune', this.c).some((e) => e.statuses?.includes(id))) return 'ability'
    return null
  }

  private canReceiveStatus(s: SideIndex, id: string): boolean {
    const cr = this.act(s)
    return !!this.c.statusById[id] && cr.hp > 0 && !cr.status && !this.statusImmune(cr, id)
  }

  private applyStatus(s: SideIndex, id: string, source: SideIndex, verbose: boolean): boolean {
    const cr = this.act(s)
    const def = this.c.statusById[id]
    if (!def || cr.hp <= 0) return false
    const params = { name: this.nameRef(s), status: def.nameZh }
    if (cr.status) {
      if (verbose) this.say(this.flavor('statusText', id, 'already', 'battle.statusAlready'), { name: this.nameRef(s), status: this.c.statusById[cr.status]?.nameZh ?? cr.status })
      return false
    }
    const immune = this.statusImmune(cr, id)
    if (immune) {
      if (verbose && immune === 'ability') this.abilityTriggered(s)
      if (verbose) this.say(this.flavor('statusText', id, 'immune', 'battle.statusImmune'), params)
      return false
    }
    cr.status = id
    cr.statusTurns = def.durationMin !== undefined || def.durationMax !== undefined
      ? this.rng.int(def.durationMin ?? def.durationMax ?? 0, def.durationMax ?? def.durationMin ?? 0)
      : 0
    this.emit({ t: 'status', side: s, status: id })
    this.say(this.flavor('statusText', id, 'applied', 'battle.statusApplied'), params)
    return true
  }

  private cureStatus(s: SideIndex): void {
    const cr = this.act(s)
    const id = cr.status
    if (!id) return
    cr.status = null
    cr.statusTurns = 0
    this.emit({ t: 'status', side: s, status: null })
    this.say(this.flavor('statusText', id, 'cured', 'battle.statusCured'), { name: this.nameRef(s), status: this.c.statusById[id]?.nameZh ?? id })
  }

  private canReceiveVolatile(s: SideIndex, id: string): boolean {
    const cr = this.act(s)
    const b = this.sides[s].b
    const def = this.c.volatileById[id]
    if (!def || cr.hp <= 0 || b.volatiles.has(id)) return false
    if (def.flinch && b.acted) return false
    return !effectsOn(cr, 'immune', this.c).some((e) => e.volatiles?.includes(id))
  }

  private applyVolatile(s: SideIndex, id: string, source: SideIndex, verbose: boolean): boolean {
    const cr = this.act(s)
    const b = this.sides[s].b
    const def = this.c.volatileById[id]
    if (!def || cr.hp <= 0) return false
    const params = { name: this.nameRef(s), volatile: def.nameZh }
    if (b.volatiles.has(id)) {
      if (verbose) this.say(this.flavor('volatileText', id, 'already', 'battle.volatileAlready'), params)
      return false
    }
    if (effectsOn(cr, 'immune', this.c).some((e) => e.volatiles?.includes(id))) {
      if (verbose) {
        this.abilityTriggered(s)
        this.say(this.flavor('volatileText', id, 'immune', 'battle.volatileImmune'), params)
      }
      return false
    }
    if (def.flinch && b.acted) return false
    if (def.protects) {
      if (!this.rng.chance(Math.pow(this.c.config.battle.protectChainDecay, b.protectChain))) {
        b.protectChain = 0
        this.say('battle.failed')
        return false
      }
      b.protectedThisTurn = true
    }
    const timed = def.durationMin !== undefined || def.durationMax !== undefined
    const turns = timed ? this.rng.int(def.durationMin ?? def.durationMax ?? 1, def.durationMax ?? def.durationMin ?? 1) : INDEFINITE
    b.volatiles.set(id, turns)
    this.emit({ t: 'volatile', side: s, volatile: id, on: true })
    if (!def.flinch) this.say(this.flavor('volatileText', id, 'start', 'battle.volatileStart'), params)
    return true
  }

  private removeVolatile(s: SideIndex, id: string, announce: boolean): void {
    const b = this.sides[s].b
    if (!b.volatiles.delete(id)) return
    this.emit({ t: 'volatile', side: s, volatile: id, on: false })
    const def = this.c.volatileById[id]
    if (announce && def) this.say(this.flavor('volatileText', id, 'end', 'battle.volatileEnd'), { name: this.nameRef(s), volatile: def.nameZh })
  }

  private applyStats(s: SideIndex, changes: StatChanges, source: SideIndex, verbose: boolean): boolean {
    const cr = this.act(s)
    if (cr.hp <= 0) return false
    const b = this.sides[s].b
    const lim = this.c.config.battle.statStageLimit
    let any = false
    let dropBlocked = false
    for (const stat of BATTLE_STAT_KEYS) {
      const delta = changes[stat]
      if (!delta) continue
      const params = { name: this.nameRef(s), stat: this.statName(stat) }
      if (delta < 0 && source !== s && hasEffect(cr, 'noStatDrops', this.c)) {
        if (!dropBlocked) {
          this.abilityTriggered(s)
          this.say('battle.statDropBlocked', { name: this.nameRef(s) })
        }
        dropBlocked = true
        continue
      }
      const cur = b.stages[stat]
      const next = clamp(cur + delta, -lim, lim)
      const d = next - cur
      if (d === 0) {
        if (verbose) this.say(delta > 0 ? 'battle.statMaxed' : 'battle.statMinned', params)
        continue
      }
      b.stages[stat] = next
      this.emit({ t: 'stat', side: s, stat, delta: d })
      this.say(this.magnitudeKey(d > 0 ? 'battle.statUp' : 'battle.statDown', Math.abs(d)), params)
      any = true
    }
    return any
  }

  private setWeather(id: WeatherId, turns: number): boolean {
    const w = this.c.weatherById[id]
    if (!w || this.weatherId === id) return false
    this.weatherId = id
    this.weatherLeft = turns
    this.emit({ t: 'weather', weather: id })
    this.sayFn(() => fill(w.startText, { weather: w.nameZh }))
    return true
  }

  // ------------------------------------------------------------------ switching

  private sendOut(s: SideIndex): void {
    const sd = this.sides[s]
    const cr = this.act(s)
    const name = creatureName(cr, this.c)
    const ev: BattleEvent = { t: 'switch', side: s, partyIndex: sd.active, creature: this.viewOf(cr) }
    const wild = sd.init.kind === 'wild'
    if (wild) this.emit(ev)
    this.sayFn((v) => {
      if (v === s) return t('battle.sendOut', { name }, this.c)
      return wild ? t('battle.wildAppeared', { name }, this.c) : t('battle.trainerSendOut', { trainer: this.label(s), name }, this.c)
    })
    if (!wild) this.emit(ev)
  }

  /** Puts party[idx] in. `withdraw` = the previous creature is still standing and leaves voluntarily. */
  private doSwitch(s: SideIndex, idx: number, withdraw: boolean, abilities = true): void {
    const sd = this.sides[s]
    const out = this.act(s)
    if (withdraw && out.hp > 0) {
      const name = creatureName(out, this.c)
      this.sayFn((v) => (v === s ? t('battle.withdraw', { name }, this.c) : t('battle.trainerWithdraw', { trainer: this.label(s), name }, this.c)))
      for (const e of effectsOn(out, 'switchOut', this.c)) {
        if (out.hp >= this.maxHpOf(out)) continue
        this.abilityTriggered(s)
        this.heal(s, this.fraction(this.maxHpOf(out), e.healFraction))
      }
    }
    sd.b = newBattler()
    sd.active = idx
    this.sendOut(s)
    this.markFaced()
    if (abilities) this.switchInAbilities(s)
    if (s !== BOSS_SIDE) this.boss?.onFoeSwitch(withdraw)
  }

  private switchInAbilities(s: SideIndex): void {
    const cr = this.act(s)
    if (cr.hp <= 0) return
    for (const e of effectsOn(cr, 'switchIn', this.c)) {
      const target = e.target === 'self' ? s : other(s)
      if (this.act(target).hp <= 0) continue
      const changes: StatChanges = { ...(e.stats ?? {}) }
      if (e.highestOf?.length && e.stages) {
        const stats = this.statsOf(cr)
        let best: (typeof e.highestOf)[number] | null = null
        let bestVal = -Infinity
        for (const k of e.highestOf) {
          if (k === 'acc' || k === 'eva') continue
          if (stats[k] > bestVal) { best = k; bestVal = stats[k] }
        }
        if (best) changes[best] = (changes[best] ?? 0) + e.stages
      }
      if (!Object.values(changes).some((d) => d)) continue
      this.abilityTriggered(s)
      this.applyStats(target, changes, s, false)
    }
  }

  private resolveForcedSwitches(): void {
    const switched: SideIndex[] = []
    for (const s of SIDES) {
      const sd = this.sides[s]
      if (!sd.mustSwitch || sd.action?.kind !== 'switch') continue
      this.doSwitch(s, sd.action.partyIndex, false, false)
      sd.mustSwitch = false
      sd.action = null
      switched.push(s)
    }
    this.phase = 'action'
    for (const s of this.speedOrder()) if (switched.includes(s)) this.switchInAbilities(s)
    this.resolveFaints()
    if (!this.done) this.prepareReplacements()
  }

  /** After a turn: AI sides replace fainted creatures immediately; human sides get a forced-switch request. */
  private prepareReplacements(): void {
    const aiSwitched: SideIndex[] = []
    for (const s of SIDES) {
      const sd = this.sides[s]
      if (this.act(s).hp > 0 || !this.hasUsable(s)) continue
      if (this.isAi(s)) {
        let idx = chooseAiReplacement(this, s, this.rng, this.c)
        if (this.switchError(s, idx)) idx = sd.party.findIndex((cr, i) => i !== sd.active && cr.hp > 0)
        this.doSwitch(s, idx, false, false)
        aiSwitched.push(s)
      } else sd.mustSwitch = true
    }
    for (const s of this.speedOrder()) if (aiSwitched.includes(s)) this.switchInAbilities(s)
    if (aiSwitched.length) this.resolveFaints()
    if (this.sides.some((sd) => sd.mustSwitch)) this.phase = 'switch'
  }

  // ------------------------------------------------------------------ items, catching, running

  private useItem(s: SideIndex, itemId: string, idx: number): void {
    const sd = this.sides[s]
    const item = this.c.items[itemId]
    if (!item) return
    if (this.isAi(s)) sd.items[itemId] = Math.max(0, (sd.items[itemId] ?? 0) - 1)
    const e = item.effect
    if (e.kind === 'ball') {
      this.say('battle.throwBall', { trainer: this.label(s), item: item.nameZh })
      this.emit({ t: 'item', side: s, itemId })
      this.throwBall(item)
      return
    }
    this.say('battle.usedItem', { trainer: this.label(s), item: item.nameZh })
    this.emit({ t: 'item', side: s, itemId })
    const cr = sd.party[idx]
    if (!cr) return
    const isActive = idx === sd.active
    const max = this.maxHpOf(cr)
    const name: Render = isActive ? this.nameRef(s) : this.nameRef(s, cr)
    const restore = (amount: number): number => {
      if (isActive) return this.heal(s, amount)
      const gained = clamp(Math.floor(amount), 0, max - cr.hp)
      cr.hp += gained
      return gained
    }
    const cure = (): boolean => {
      if (!cr.status) return false
      if (isActive) this.cureStatus(s)
      else {
        const st = this.c.statusById[cr.status]
        this.say(this.flavor('statusText', cr.status, 'cured', 'battle.statusCured'), { name, status: st?.nameZh ?? cr.status })
        cr.status = null
        cr.statusTurns = 0
      }
      return true
    }
    let worked = false
    switch (e.kind) {
      case 'heal': {
        const got = cr.hp > 0 ? restore(e.amount === 'full' ? max : e.amount) : 0
        if (got > 0) this.say('battle.itemHealed', { name, amount: got, hp: this.statName('hp') })
        worked = got > 0
        break
      }
      case 'cure':
        worked = cr.hp > 0 && !!cr.status && (e.status === 'all' || e.status === cr.status) && cure()
        break
      case 'healCure': {
        if (cr.hp <= 0) break
        const got = restore(max)
        if (got > 0) this.say('battle.itemHealed', { name, amount: got, hp: this.statName('hp') })
        worked = cure() || got > 0
        break
      }
      case 'revive':
        if (cr.hp <= 0) {
          cr.hp = clamp(Math.floor(max * e.fraction), RULES.minHpChange, max)
          cr.status = null
          cr.statusTurns = 0
          this.say('battle.itemRevived', { name })
          worked = true
        }
        break
      case 'pp': {
        const slots = e.all ? cr.moves : [...cr.moves].sort((a, b) => (b.ppMax - b.pp) - (a.ppMax - a.pp)).slice(0, 1)
        for (const m of slots) {
          const before = m.pp
          m.pp = e.amount === 'full' ? m.ppMax : Math.min(m.ppMax, m.pp + e.amount)
          if (m.pp > before) worked = true
        }
        if (worked) this.say('battle.itemPp', { name })
        break
      }
      case 'battleBoost':
        worked = isActive && this.applyStats(s, { [e.stat]: e.stages }, s, true)
        break
      case 'bait':
        worked = true
        this.boss?.onFoeItem(e.tag)
        break
      case 'escape':
        if (this.init.isWild) {
          this.say('battle.ranAway')
          this.finish('run', -1)
          return
        }
        break
      default:
        break
    }
    if (!worked && e.kind !== 'battleBoost') this.say('battle.itemNoEffect')
  }

  private ballMultiplier(e: Extract<ItemDef['effect'], { kind: 'ball' }>, target: Creature): number {
    const bb = this.c.config.catch.ballBonus
    switch (e.bonus) {
      case 'night': return this.init.timeOfDay === 'night' ? bb.night : e.catchMultiplier
      case 'quick': return this.turnNo <= 1 ? bb.quick : e.catchMultiplier
      case 'status': return target.status ? bb.status : e.catchMultiplier
      case 'lowLevel': return target.level <= bb.lowLevelMax ? bb.lowLevel : e.catchMultiplier
      case 'rare': {
        const order = this.c.rarityById[this.c.species[target.speciesId]?.rarity ?? '']?.order ?? 0
        return order >= bb.rareMinRarityOrder ? bb.rare : e.catchMultiplier
      }
      default: return e.catchMultiplier
    }
  }

  private throwBall(item: ItemDef): void {
    const e = item.effect
    if (e.kind !== 'ball') return
    const target = this.act(1)
    const checks = Math.max(1, this.c.config.catch.shakeChecks)
    const shakes = e.bonus === 'master' ? checks : catchShakes({
      maxHp: this.maxHpOf(target),
      hp: target.hp,
      catchRate: (this.c.species[target.speciesId]?.catchRate ?? 0) * (this.init.mods?.catchRate ?? 1) * (this.boss?.cr === target ? this.boss.def.catchRateMul : 1),
      ballMul: this.ballMultiplier(e, target),
      statusBonus: target.status ? (this.c.statusById[target.status]?.catchBonus ?? 1) : 1,
      checks,
    }, this.rng)
    const success = shakes >= checks
    this.emit({ t: 'catch', ballId: item.id, shakes, success })
    const name = creatureName(target, this.c)
    if (!success) {
      const k = `battle.catchFail.${shakes}`
      this.say(k in this.c.text ? k : 'battle.catchFailDefault', { name })
      return
    }
    target.ballId = item.id
    if (!target.otName) target.otName = this.sides[0].init.name
    this.caughtCr = target
    this.say('battle.caught', { name })
    this.finish('caught', 0)
  }

  private tryRun(s: SideIndex): void {
    const sd = this.sides[s]
    let escaped: boolean
    if (hasEffect(this.act(s), 'alwaysEscape', this.c)) {
      this.abilityTriggered(s)
      escaped = true
    } else {
      sd.runAttempts += 1
      escaped = escapes(speedOf(this.fighter(s), this.c), speedOf(this.fighter(other(s)), this.c), sd.runAttempts, this.rng, this.c)
    }
    if (!escaped) {
      this.say('battle.runFailed')
      return
    }
    this.say('battle.ranAway')
    this.finish('run', -1)
  }

  // ------------------------------------------------------------------ end of turn, fainting, ending

  private endOfTurn(): void {
    const w = this.weatherId !== CLEAR ? this.c.weatherById[this.weatherId] : undefined
    if (w) {
      if (this.weatherLeft > 0) this.weatherLeft -= 1
      if (this.weatherLeft === 0) {
        this.weatherId = CLEAR
        this.weatherLeft = INDEFINITE
        this.emit({ t: 'weather', weather: CLEAR })
        this.sayFn(() => fill(w.endText, { weather: w.nameZh }))
      } else {
        this.sayFn(() => fill(w.continueText, { weather: w.nameZh }))
        for (const s of this.speedOrder()) {
          const cr = this.act(s)
          if (cr.hp <= 0) continue
          const types = speciesTypes(cr, this.c)
          if (w.chip && !types.some((ty) => w.chip!.exemptTypes.includes(ty))) {
            this.hurt(s, this.fraction(this.maxHpOf(cr), w.chip.fraction))
            this.say('battle.weatherChip', { name: this.nameRef(s), weather: w.nameZh })
          }
          if (w.heal && cr.hp > 0 && types.some((ty) => w.heal!.types.includes(ty)) && this.heal(s, this.fraction(this.maxHpOf(cr), w.heal.fraction)) > 0) {
            this.say('battle.weatherHeal', { name: this.nameRef(s), weather: w.nameZh })
          }
        }
      }
    }
    for (const s of this.speedOrder()) {
      const cr = this.act(s)
      const b = this.sides[s].b
      for (const id of [...b.volatiles.keys()]) {
        const def = this.c.volatileById[id]
        if (!def?.drainFraction || cr.hp <= 0) continue
        const lost = this.hurt(s, this.fraction(this.maxHpOf(cr), def.drainFraction))
        this.say(this.flavor('volatileText', id, 'drain', 'battle.volatileDrain'), { name: this.nameRef(s), volatile: def.nameZh })
        if (lost > 0) this.heal(other(s), lost)
      }
      const st = cr.status ? this.c.statusById[cr.status] : undefined
      if (st?.dotFraction && cr.hp > 0) {
        this.hurt(s, this.fraction(this.maxHpOf(cr), st.dotFraction))
        this.say(this.flavor('statusText', st.id, 'dot', 'battle.statusDot'), { name: this.nameRef(s), status: st.nameZh })
      }
      if (cr.hp > 0) this.turnEndAbilities(s)
    }
    for (const s of SIDES) {
      const b = this.sides[s].b
      for (const [id, left] of [...b.volatiles]) {
        const def = this.c.volatileById[id]
        // flinch/protect are turn-scoped by definition, whatever their duration fields say.
        const turnScoped = !!def?.flinch || !!def?.protects
        if (turnScoped) this.removeVolatile(s, id, false)
        else if (left !== INDEFINITE) {
          if (left <= 1) this.removeVolatile(s, id, this.act(s).hp > 0)
          else b.volatiles.set(id, left - 1)
        }
      }
    }
    this.boss?.turnEnd()
    this.resolveFaints()
  }

  /**
   * Wild flee (BattleSideInit.flee): from turn `afterTurn` on, each turn end the wild's active creature rolls
   * chancePerTurn, scaled by (1 - skipChance) of its major status (a creature that cannot act cannot run either).
   * Rolls only happen for sides that carry `flee`, so battles without it consume the same rng sequence as before.
   */
  private wildFlee(): void {
    if (!this.init.isWild) return
    for (const s of SIDES) {
      const sd = this.sides[s]
      const f = sd.init.flee
      if (this.done || sd.init.kind !== 'wild' || !f || !(f.chancePerTurn > 0)) continue
      if (this.turnNo < f.afterTurn || sd.mustSwitch) continue
      const cr = this.act(s)
      if (cr.hp <= 0) continue
      if (!sd.fleeWarned) {
        sd.fleeWarned = true
        this.emit({ t: 'flee', side: s, stage: 'warn' })
        this.say('battle.fleeWarn', { name: this.nameRef(s) })
      }
      const skip = cr.status ? (this.c.statusById[cr.status]?.skipChance ?? 0) : 0
      if (!this.rng.chance(f.chancePerTurn * clamp(1 - skip, 0, 1))) continue
      this.emit({ t: 'flee', side: s, stage: 'fled' })
      this.say('battle.foeFled', { name: this.nameRef(s) })
      this.finish('fled', -1)
    }
  }

  private turnEndAbilities(s: SideIndex): void {
    const cr = this.act(s)
    for (const e of effectsOn(cr, 'turnEnd', this.c)) {
      if (cr.hp <= 0) return
      if (e.stats && this.wouldChangeStats(s, e.stats)) {
        this.abilityTriggered(s)
        this.applyStats(s, e.stats, s, false)
      }
      if (e.healFraction && cr.hp < this.maxHpOf(cr)) {
        this.abilityTriggered(s)
        this.heal(s, this.fraction(this.maxHpOf(cr), e.healFraction))
      }
      if (e.cureStatusChance && cr.status && this.rng.chance(e.cureStatusChance)) {
        this.abilityTriggered(s)
        this.cureStatus(s)
      }
    }
  }

  private wouldChangeStats(s: SideIndex, changes: StatChanges): boolean {
    const lim = this.c.config.battle.statStageLimit
    const st = this.sides[s].b.stages
    return BATTLE_STAT_KEYS.some((k) => {
      const d = changes[k] ?? 0
      return d !== 0 && clamp(st[k] + d, -lim, lim) !== st[k]
    })
  }

  private resolveFaints(order: readonly SideIndex[] = SIDES): void {
    for (const s of order) {
      const sd = this.sides[s]
      const cr = this.act(s)
      if (cr.hp > 0 || sd.b.faintHandled) continue
      sd.b.faintHandled = true
      sd.b.volatiles.clear()
      sd.b.stages = emptyStages()
      sd.b.recharging = false
      cr.status = null
      cr.statusTurns = 0
      this.emit({ t: 'faint', side: s })
      this.say('battle.fainted', { name: this.nameRef(s) })
      if (s === 1) this.awardExp(sd.active)
    }
    this.checkEnd()
  }

  private awardExp(foeIdx: number): void {
    const me = this.sides[0]
    if (!this.init.expGain || me.init.kind !== 'player') return
    const defeated = this.sides[1].party[foeIdx]
    const parts = [...(this.faced.get(foeIdx) ?? [])].filter((i) => me.party[i]?.hp > 0 && me.party[i].level < this.c.config.party.maxLevel)
    if (!defeated || parts.length === 0) return
    const total = Math.floor(expYield(defeated, this.sides[1].init.kind === 'trainer', this.c) * (this.boss?.cr === defeated ? this.boss.expMul() : 1))
    const each = Math.max(1, Math.floor(total / parts.length))
    const mods = this.init.mods
    for (const i of parts.sort((a, b) => a - b)) {
      const cr = me.party[i]
      const name = creatureName(cr, this.c)
      const mul = mods?.expByParty?.[i] ?? 1
      const gain = mul === 1 ? each : Math.max(1, Math.round(each * mul))
      const r = gainExp(cr, gain, this.c)
      const fmul = mods?.friendship ?? 1
      if (fmul !== 1 && r.levels.length) {
        const extra = Math.round(this.c.config.creature.levelUpFriendship * (fmul - 1)) * r.levels.length
        cr.friendship = Math.max(0, Math.min(RULES.creature.friendshipMax, cr.friendship + extra))
      }
      cr.hp = Math.min(cr.hp, this.maxHpOf(cr))
      this.say('battle.gainedExp', { name, exp: gain })
      this.emit({ t: 'exp', partyIndex: i, amount: gain, level: cr.level, exp: cr.exp })
      for (const level of r.levels) {
        this.leveled.add(i)
        this.emit({ t: 'levelUp', partyIndex: i, level })
        this.say('battle.levelUp', { name, level })
      }
      for (const moveId of r.learned) {
        this.emit({ t: 'learnMove', partyIndex: i, moveId })
        this.say('battle.learned', { name, move: this.c.moves[moveId]?.nameZh ?? moveId })
      }
      for (const moveId of r.learnable) {
        this.emit({ t: 'moveLearnable', partyIndex: i, moveId })
        this.say('battle.wantsToLearn', { name, move: this.c.moves[moveId]?.nameZh ?? moveId, max: this.c.config.party.maxMoves })
      }
    }
  }

  private checkEnd(): boolean {
    if (this.done) return true
    const a0 = this.hasUsable(0)
    const a1 = this.hasUsable(1)
    if (a0 && a1) return false
    if (!a0 && !a1) this.finish('draw', -1)
    else if (!a1) this.finish('win', 0)
    else this.finish('lose', 1)
    return true
  }

  private finish(result: BattleResult, winner: SideIndex | -1): void {
    if (this.done) return
    const foe = this.sides[1].init
    if (result === 'win' || result === 'lose') {
      const w = winner as SideIndex
      const loser = other(w)
      if (!this.isAi(loser)) this.say('battle.outOfCreatures', { trainer: this.label(loser) })
      if (foe.kind !== 'wild') this.sayFn((v) => t(v === w ? 'battle.youDefeated' : 'battle.youLost', { trainer: this.label(other(v)) }, this.c))
    }
    if (result === 'draw') this.say('battle.draw')
    if (result === 'win' && foe.kind === 'trainer' && this.sides[0].init.kind === 'player' && (this.init.rewardMoney ?? 0) > 0) {
      const amount = this.init.rewardMoney!
      this.emit({ t: 'money', amount })
      this.say('battle.moneyWon', { amount, currency: t('common.money', undefined, this.c) })
    }
    if (result === 'win' && this.boss) this.bossLoot(this.boss)
    if (result !== 'lose' && result !== 'forfeit' && result !== 'draw' && this.sides[0].init.kind === 'player') {
      for (const i of [...this.leveled].sort((a, b) => a - b)) {
        const cr = this.sides[0].party[i]
        const to = cr && cr.hp > 0 ? evolutionTarget(cr, this.c) : null
        if (to) this.emit({ t: 'evolveReady', partyIndex: i, toSpeciesId: to })
      }
    }
    this.boss?.restore()
    this.restoreLevelCap()
    this.done = true
    this.outcome = result
    for (const sd of this.sides) {
      sd.action = null
      sd.mustSwitch = false
    }
    this.emit({ t: 'end', result, winner })
  }
}
