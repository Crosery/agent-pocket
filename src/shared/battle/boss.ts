// Boss battles: a data-driven director (content/bosses.json) that the singles engine consults through a few hooks.
// All boss logic lives here as plain functions over BossState plus a BossDirector that owns the boss creature's
// form, phases, meters, charged attacks and enrage. The engine only supplies primitives through BossHost, so the
// same rules can later run one instance per player of a co-op raid (docs/bosses.md).
// Randomness comes from the engine's Rng (the caller passes it), so a boss fight replays from the seed.
import type {
  BattleEvent, BossCond, BossDef, BossFormDef, BossHud, BossOp, BossRule, BossState, BossTakenMul, BossTrigger, Creature,
  CreatureView, MoveDef, MoveSlot, SideIndex, StatChanges, Stats, StatusId, TypeId,
} from '../types.ts'
import type { IRng } from '../contracts.ts'
import { creatureName } from '../creature.ts'
import type { Content } from '../content/index.ts'
import { typeEffectiveness } from '../content/index.ts'
import { isDamaging } from './formulas.ts'

/** The boss always fights on the enemy side of the singles engine. */
export const BOSS_SIDE: SideIndex = 1
export const FOE_SIDE: SideIndex = 0
/** Pattern entry that stands for "one of the moves copied from the foe". */
export const BORROWED = '$borrowed'

type Core = Pick<BossState, 'form' | 'formTurn' | 'fired' | 'phase' | 'meters' | 'enrage' | 'charge' | 'skip' | 'borrowed'
  | 'lastFoeType' | 'lastFoeMove' | 'seenTypes'>

/** Engine primitives the director needs. Implemented by BattleEngine; everything is on the boss side's terms. */
export interface BossHost {
  readonly c: Content
  /** Battle turn number (0 before the first turn). */
  turn(): number
  /** Adopts the boss clock of a restored BossState (a raid keeps one clock for every player's engine). */
  setTurn(n: number): void
  /** The boss creature is the one currently fighting on its side. */
  active(): boolean
  say(key: string, params?: Record<string, string | number>): void
  emit(e: BattleEvent): void
  view(cr: Creature): CreatureView
  /** Max hp at the battle level, boss rules included / excluded. */
  maxHp(cr: Creature): number
  plainMaxHp(cr: Creature): number
  foe(): Creature
  heal(side: SideIndex, amount: number): void
  stages(side: SideIndex, changes: StatChanges): void
  clearStages(side: SideIndex): void
  status(side: SideIndex, id: StatusId): void
  cure(side: SideIndex): void
  volatile(side: SideIndex, id: string): void
  /** The field weather ('none' = clear) and a way to change it. */
  weather(): string
  setWeather(id: string, turns?: number): void
  /** A roll of the battle's rng: true with probability p. */
  roll(p: number): boolean
  battler(): { stages: Record<string, number>; volatiles: Record<string, number>; recharging: boolean }
  setBattler(b: { stages: Record<string, number>; volatiles: Record<string, number>; recharging: boolean }): void
}

/** What the boss's decision needs to know about its opponent. */
export interface BossFoeView { status: StatusId | null; country: string; company: string; released: string; weather: string }
export interface BossDecision { moveId: string; forced: boolean }

interface CondCtx { core: Core; hpRatio: number; foe: BossFoeView; turn: number }

const hit = (n: number | undefined): number => n ?? 0

export function bossCondHolds(cond: BossCond | undefined, x: CondCtx): boolean {
  if (!cond) return true
  const s = x.core
  if (cond.form && !cond.form.includes(s.form)) return false
  if (cond.notForm?.includes(s.form)) return false
  if (cond.phase !== undefined && !(hit(s.fired[cond.phase]) > 0)) return false
  if (cond.notPhase !== undefined && hit(s.fired[cond.notPhase]) > 0) return false
  if (cond.hpBelow !== undefined && !(x.hpRatio <= cond.hpBelow)) return false
  if (cond.hpAbove !== undefined && !(x.hpRatio > cond.hpAbove)) return false
  if (cond.turnAtLeast !== undefined && x.turn < cond.turnAtLeast) return false
  if (cond.turnAtMost !== undefined && x.turn > cond.turnAtMost) return false
  if (cond.formTurnAtLeast !== undefined && s.formTurn < cond.formTurnAtLeast) return false
  if (cond.turnCycle) {
    const i = (x.turn - 1) % cond.turnCycle.period
    if (!(i >= cond.turnCycle.from && i < cond.turnCycle.to)) return false
  }
  if (cond.meter) {
    const v = hit(s.meters[cond.meter.id])
    if (cond.meter.atLeast !== undefined && v < cond.meter.atLeast) return false
    if (cond.meter.atMost !== undefined && v > cond.meter.atMost) return false
  }
  if (cond.hasBorrowed !== undefined && cond.hasBorrowed !== s.borrowed.length > 0) return false
  if (cond.foeStatus !== undefined) {
    if (cond.foeStatus === true ? !x.foe.status : cond.foeStatus === false ? !!x.foe.status : x.foe.status !== cond.foeStatus) return false
  }
  if (cond.foeCountry && !cond.foeCountry.includes(x.foe.country)) return false
  if (cond.foeCompany && !cond.foeCompany.includes(x.foe.company)) return false
  if (cond.foeNotCountry?.includes(x.foe.country)) return false
  if (cond.foeReleasedBefore !== undefined && !(x.foe.released !== '' && x.foe.released < cond.foeReleasedBefore)) return false
  if (cond.foeReleasedFrom !== undefined && !(x.foe.released !== '' && x.foe.released >= cond.foeReleasedFrom)) return false
  if (cond.weather && !cond.weather.includes(x.foe.weather)) return false
  if (cond.notWeather?.includes(x.foe.weather)) return false
  return true
}

const triggerEvents = (tr: BossTrigger): string[] => (Array.isArray(tr.on) ? tr.on : [tr.on])

/** Conditions of a trigger that do not depend on boss hp (gates must not stay shut because of them). */
const withoutHp = (c: BossCond | undefined): BossCond | undefined => {
  if (!c) return c
  const { hpBelow: _b, hpAbove: _a, ...rest } = c
  return rest
}

/**
 * The boss's next move as a pure function of its state: a pending charged attack, else a weighted pick from the
 * form's pattern among moves with PP left. Null = nothing usable (the engine falls back to Struggle).
 * Conditions that look at the foe (foeStatus, foeCountry) only make sense for a single opponent.
 */
export function chooseBossAction(state: BossState, def: BossDef, foe: BossFoeView, rng: IRng): BossDecision | null {
  if (state.charge) return { moveId: state.charge.move, forced: true }
  const form = def.forms[state.form]
  if (!form) return null
  const usable = new Set(state.moves.filter((m) => m.pp > 0).map((m) => m.id))
  const borrowed = state.borrowed.filter((id) => usable.has(id))
  const ctx: CondCtx = { core: state, hpRatio: state.maxHp > 0 ? state.hp / state.maxHp : 0, foe, turn: Math.max(1, state.turn) }
  const options = form.pattern.filter((e) => bossCondHolds(e.if, ctx) && (e.move === BORROWED ? borrowed.length > 0 : usable.has(e.move)))
  if (!options.length) return null
  const pick = rng.weighted(options, (e) => e.weight)
  return { moveId: pick.move === BORROWED ? rng.pick(borrowed) : pick.move, forced: false }
}

const slotOf = (id: string, c: Content): MoveSlot => ({ id, pp: c.moves[id]?.pp ?? 1, ppMax: c.moves[id]?.pp ?? 1 })
const emptyStageRecord = (): Record<string, number> => ({ atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 })

export class BossDirector {
  readonly def: BossDef
  readonly cr: Creature
  private readonly host: BossHost
  private core: Core
  private readonly original: { speciesId: string; abilityId: string; moves: MoveSlot[] }
  private lastHud = ''
  private restored = false
  /** Notes already said during the current action (one line per rule per action). */
  private readonly noted = new Set<string>()
  private readonly phaseCount: number
  /** The charged attack being fired right now (its damage multiplier applies to that move only). */
  private firing: { move: string; mul: number } | null = null

  constructor(def: BossDef, cr: Creature, host: BossHost) {
    this.def = def
    this.cr = cr
    this.host = host
    this.original = { speciesId: cr.speciesId, abilityId: cr.abilityId, moves: cr.moves.map((m) => ({ ...m })) }
    this.phaseCount = def.triggers.filter((tr) => tr.phase).length
    this.core = {
      form: def.initialForm, formTurn: 0, fired: {}, phase: 0, enrage: 0, charge: null, skip: 0, borrowed: [], lastFoeType: null,
      lastFoeMove: null, seenTypes: [], meters: Object.fromEntries(def.meters.map((m) => [m.id, m.start ?? 0])),
    }
  }

  // ------------------------------------------------------------------ setup / teardown

  /** Puts the boss into its opening form without events and scales hp to the boss pool (hp ratio is kept). */
  begin(): void {
    const ratio = this.cr.hp / Math.max(1, this.host.plainMaxHp(this.cr))
    this.wear(this.formDef(), false)
    const max = this.host.maxHp(this.cr)
    this.cr.hp = this.cr.hp > 0 ? Math.min(max, Math.max(1, Math.round(ratio * max))) : 0
  }

  /** Back to the creature it was before the fight (hp ratio kept), e.g. for a catch or the party save. */
  restore(): void {
    const max = this.host.maxHp(this.cr)
    const ratio = max > 0 ? this.cr.hp / max : 0
    this.cr.speciesId = this.original.speciesId
    this.cr.abilityId = this.original.abilityId
    this.cr.moves = this.original.moves.map((m) => ({ ...m }))
    this.restored = true
    const plain = this.host.plainMaxHp(this.cr)
    this.cr.hp = this.cr.hp > 0 ? Math.min(plain, Math.max(1, Math.round(ratio * plain))) : 0
  }

  // ------------------------------------------------------------------ queries used by the engine

  get active(): boolean { return this.host.active() }
  formDef(): BossFormDef { return this.def.forms[this.core.form] ?? this.def.forms[this.def.initialForm] }

  private foeView(): BossFoeView {
    const foe = this.host.foe()
    const sp = this.host.c.species[foe.speciesId]
    return { status: foe.status, country: sp?.country ?? '', company: sp?.company ?? '', released: sp?.releaseDate ?? '', weather: this.host.weather() }
  }

  private ctx(hpMax?: number): CondCtx {
    const max = hpMax ?? this.host.maxHp(this.cr)
    return { core: this.core, hpRatio: max > 0 ? this.cr.hp / max : 0, foe: this.foeView(), turn: Math.max(1, this.host.turn()) }
  }

  private rules(ctx: CondCtx): BossRule[] {
    return (this.formDef().rules ?? []).filter((r) => bossCondHolds(r.if, ctx))
  }

  /** Stats of the boss creature: the form's multipliers, then the active rules' (hp only from the form). */
  adjustStats(cr: Creature, stats: Stats): Stats {
    if (cr !== this.cr || this.restored) return stats
    const form = this.formDef().statMul ?? {}
    const out = { ...stats }
    for (const k of Object.keys(form) as (keyof Stats)[]) out[k] = Math.max(1, Math.floor(stats[k] * (form[k] ?? 1)))
    if (this.active) {
      for (const r of this.rules(this.ctx(out.hp))) {
        for (const [k, m] of Object.entries(r.statMul ?? {}) as [keyof Stats, number][]) out[k] = Math.max(1, Math.floor(out[k] * m))
      }
    }
    return out
  }

  /** Damage dealt by the boss / taken by the boss after the rules (called for every damaging hit). */
  filterHit(attacker: SideIndex, move: MoveDef, dmg: number): number {
    if (!this.active) return dmg
    const ctx = this.ctx()
    const rules = this.rules(ctx)
    if (attacker === BOSS_SIDE) {
      let mul = this.firing && this.firing.move === move.id ? this.firing.mul : 1
      for (const r of rules) mul *= r.dealtMul ?? 1
      return mul === 1 ? dmg : Math.max(1, Math.floor(dmg * mul))
    }
    if (dmg <= 0) return dmg
    const max = this.host.maxHp(this.cr)
    let mul = 1
    let cap = Infinity
    for (const r of rules) {
      for (const e of r.takenMul ?? []) {
        if (!this.takenMatches(e, move)) continue
        mul *= e.mul
        if (e.note && !this.noted.has(e.note)) {
          this.noted.add(e.note)
          this.host.say(e.note, this.params())
        }
      }
      if (r.hitCap !== undefined) cap = Math.min(cap, Math.max(1, Math.floor(max * r.hitCap)))
    }
    let out = Math.max(1, Math.floor(dmg * mul))
    out = Math.min(out, cap)
    for (const g of this.def.gates) {
      const tr = this.def.triggers.find((x) => x.id === g.phase)
      if (!tr || hit(this.core.fired[g.phase]) > 0 || !bossCondHolds(withoutHp(tr.if), ctx)) continue
      out = Math.min(out, Math.max(0, this.cr.hp - Math.max(1, Math.floor(max * g.floor))))
    }
    return out
  }

  private takenMatches(e: BossTakenMul, move: MoveDef): boolean {
    if (e.moveTypes && !e.moveTypes.includes(move.type)) return false
    if (e.notMoveTypes?.includes(move.type)) return false
    if (e.categories && !e.categories.includes(move.category)) return false
    if (e.moves && !e.moves.includes(move.id)) return false
    if (e.sameTypeAsLast && move.type !== this.core.lastFoeType) return false
    if (e.effectiveness) {
      const eff = typeEffectiveness(move.type, this.host.c.species[this.cr.speciesId]?.types ?? [], this.host.c)
      if ((eff > 1 ? 'super' : eff < 1 ? 'resisted' : 'neutral') !== e.effectiveness) return false
    }
    return true
  }

  /** Extra PP the foe's moves cost right now. */
  foePpCost(): number {
    if (!this.active) return 0
    return this.rules(this.ctx()).reduce((n, r) => n + (r.foePpCost ?? 0), 0)
  }

  blocksStatus(): boolean {
    return this.active && this.rules(this.ctx()).some((r) => r.noStatus)
  }

  /** The boss gets a second action this turn. */
  extraActionDue(turn: number): boolean {
    if (!this.active) return false
    return this.rules(this.ctx()).some((r) => r.extraAction !== undefined && turn % r.extraAction.every === 0)
  }

  /** Consumes one forced skip; true when the boss loses this action. */
  takeSkip(): boolean {
    if (!this.active || this.core.skip <= 0) return false
    this.core.skip -= 1
    return true
  }

  /** The pending charged attack goes off now. */
  clearCharge(): void {
    if (!this.core.charge) return
    this.firing = { move: this.core.charge.move, mul: this.core.charge.mul }
    this.core.charge = null
    this.pushHud()
  }

  /** Whether a bait item with this tag would do anything right now (so it is not wasted). */
  acceptsBait(tag: string): boolean {
    if (!this.active) return false
    const ctx = this.ctx()
    return this.def.triggers.some((tr) => triggerEvents(tr).includes('foeItem') && tr.tag === tag && this.canFire(tr) && bossCondHolds(tr.if, ctx))
  }

  expMul(): number { return this.def.expMul }

  /** Scale of lingering damage (leech drain, status damage) on the boss; 1 when the tier sets none. */
  residualMul(): number { return this.active ? (this.def.residualMul ?? 1) : 1 }

  /** The boss's action for the coming turn. */
  decide(rng: IRng): BossDecision | null {
    const state = this.extract()
    state.turn += 1
    return chooseBossAction(state, this.def, this.foeView(), rng)
  }

  // ------------------------------------------------------------------ events

  start(): void {
    if (!this.active) return
    for (const key of this.def.taunt) this.host.say(key, this.params())
    this.fire('start', {})
    this.pushHud(true)
  }

  turnStart(): void {
    if (!this.active) return
    this.core.formTurn += 1
    this.fire('turnStart', {})
    this.pushHud()
  }

  afterAction(): void {
    this.noted.clear()
    this.firing = null
    if (!this.active || this.cr.hp <= 0) return
    this.fire('afterAction', {})
    this.pushHud()
  }

  turnEnd(): void {
    if (!this.active || this.cr.hp <= 0) return
    this.fire('turnEnd', {})
    for (const m of this.def.meters) if (m.decay) this.core.meters[m.id] = Math.max(0, hit(this.core.meters[m.id]) - m.decay)
    this.tickEnrage()
    this.pushHud()
  }

  onFoeMove(move: MoveDef): void {
    if (!this.active || this.cr.hp <= 0) return
    const damaging = isDamaging(move)
    const novel = damaging && !this.core.seenTypes.includes(move.type)
    const last = this.core.lastFoeType
    const shift = damaging && last !== null && move.type !== last
    if (damaging) {
      this.core.lastFoeMove = move.id
      if (novel) this.core.seenTypes.push(move.type)
    }
    this.fire('foeMove', { move, novel, shift, repeat: damaging && last !== null && !shift })
    if (damaging) this.core.lastFoeType = move.type
    this.pushHud()
  }

  onFoeItem(tag: string | undefined): void {
    if (!this.active || this.cr.hp <= 0) return
    this.fire('foeItem', { tag })
    this.pushHud()
  }

  /** The foe healed, cured or refilled PP with an item. */
  onFoeMedicine(): void {
    if (!this.active || this.cr.hp <= 0) return
    this.fire('foeMedicine', {})
    this.pushHud()
  }

  onFoeSwitch(voluntary: boolean): void {
    if (!this.active || this.cr.hp <= 0) return
    this.fire('foeSwitch', { voluntary })
    this.pushHud()
  }

  // ------------------------------------------------------------------ triggers & ops

  private canFire(tr: BossTrigger): boolean {
    const times = tr.times ?? 1
    return times === 0 || hit(this.core.fired[tr.id]) < times
  }

  private fire(event: string, info: { move?: MoveDef; novel?: boolean; shift?: boolean; repeat?: boolean; voluntary?: boolean; tag?: string }): void {
    for (const tr of this.def.triggers) {
      if (!triggerEvents(tr).includes(event) || !this.canFire(tr)) continue
      if (tr.tag !== undefined && tr.tag !== info.tag) continue
      if (event === 'foeSwitch' && tr.voluntary && !info.voluntary) continue
      if (event === 'foeMove') {
        const mv = info.move
        if (!mv) continue
        if (tr.moveTypes && !tr.moveTypes.includes(mv.type)) continue
        if (tr.moves && !tr.moves.includes(mv.id)) continue
        if (tr.categories && !tr.categories.includes(mv.category)) continue
        if (tr.novelType && !info.novel) continue
        if (tr.typeShift !== undefined && (tr.typeShift ? !info.shift : !info.repeat)) continue
      }
      if (!bossCondHolds(tr.if, this.ctx())) continue
      if (tr.chance !== undefined && !this.host.roll(tr.chance)) continue
      this.core.fired[tr.id] = hit(this.core.fired[tr.id]) + 1
      if (tr.phase) this.core.phase += 1
      this.run(tr.do)
      if (this.cr.hp <= 0) return
    }
  }

  private params(): Record<string, string | number> {
    return { boss: creatureName(this.cr, this.host.c), foe: creatureName(this.host.foe(), this.host.c) }
  }

  private side(target: 'boss' | 'foe'): SideIndex { return target === 'boss' ? BOSS_SIDE : FOE_SIDE }

  private run(ops: readonly BossOp[]): void {
    for (const op of ops) this.exec(op)
  }

  private exec(op: BossOp): void {
    const h = this.host
    switch (op.op) {
      case 'say':
        h.say(op.text, this.params())
        break
      case 'form':
        this.switchForm(op.form)
        break
      case 'heal': {
        const cr = op.target === 'boss' ? this.cr : h.foe()
        if (cr.hp > 0) h.heal(this.side(op.target), Math.max(1, Math.floor(h.maxHp(cr) * op.fraction)))
        break
      }
      case 'stages':
        h.stages(this.side(op.target), op.stats)
        break
      case 'clearStages':
        h.clearStages(this.side(op.target))
        break
      case 'status':
        h.status(this.side(op.target), op.status)
        break
      case 'cure':
        h.cure(this.side(op.target))
        break
      case 'volatile':
        h.volatile(this.side(op.target), op.volatile)
        break
      case 'meter': {
        const def = this.def.meters.find((m) => m.id === op.id)
        const max = def?.max ?? Number.MAX_SAFE_INTEGER
        const base = op.set ?? hit(this.core.meters[op.id])
        this.core.meters[op.id] = Math.min(max, Math.max(0, base + (op.add ?? 0)))
        break
      }
      case 'loseTurn':
        this.core.skip += op.turns
        break
      case 'charge':
        this.core.charge = { move: op.move, warn: op.warn, mul: op.mul ?? 1 }
        h.emit({ t: 'telegraph', side: BOSS_SIDE, move: op.move })
        h.say(op.warn, { ...this.params(), move: h.c.moves[op.move]?.nameZh ?? op.move })
        break
      case 'cancelCharge':
        this.core.charge = null
        break
      case 'learn':
        this.learn(op.max, op.say)
        break
      case 'forgetTypes':
        this.core.seenTypes = []
        this.core.lastFoeType = null
        break
      case 'forget':
        this.forget()
        break
      case 'weather':
        h.setWeather(op.weather, op.turns)
        break
    }
  }

  private learn(max: number, say: string | undefined): void {
    const id = this.core.lastFoeMove
    const def = id ? this.host.c.moves[id] : undefined
    if (!id || !def || this.cr.moves.some((m) => m.id === id)) return
    this.cr.moves.push(slotOf(id, this.host.c))
    this.core.borrowed.push(id)
    while (this.core.borrowed.length > max) this.dropMove(this.core.borrowed.shift() as string)
    if (say) this.host.say(say, { ...this.params(), move: def.nameZh })
  }

  private forget(): void {
    for (const id of this.core.borrowed.splice(0)) this.dropMove(id)
  }

  private dropMove(id: string): void {
    const i = this.cr.moves.findIndex((m) => m.id === id)
    if (i >= 0) this.cr.moves.splice(i, 1)
  }

  private tickEnrage(): void {
    const e = this.def.enrage
    if (!e) return
    const turn = this.host.turn()
    if (e.warnBefore > 0 && turn === e.turn - e.warnBefore) this.host.say(e.warn, this.params())
    if (turn < e.turn || this.core.enrage >= e.max) return
    this.core.enrage += 1
    this.host.say(this.core.enrage === 1 ? e.start : e.tick, this.params())
    this.host.stages(BOSS_SIDE, e.stages)
  }

  // ------------------------------------------------------------------ forms

  private wear(form: BossFormDef, keepMoves: boolean): void {
    const c = this.host.c
    this.cr.speciesId = form.species
    if (form.ability !== undefined) this.cr.abilityId = form.ability
    else if (form.species !== this.original.speciesId) this.cr.abilityId = c.species[form.species]?.abilities[0] ?? this.cr.abilityId
    else this.cr.abilityId = this.original.abilityId
    if (!keepMoves) this.cr.moves = form.moves.map((id) => slotOf(id, c))
  }

  private switchForm(id: string): void {
    const form = this.def.forms[id]
    if (!form || id === this.core.form) return
    const ratio = this.cr.hp / Math.max(1, this.host.maxHp(this.cr))
    const from = this.cr.speciesId
    this.core.form = id
    this.core.formTurn = 0
    this.core.borrowed = []
    this.wear(form, false)
    if (!form.keepStages) this.host.clearStages(BOSS_SIDE)
    const max = this.host.maxHp(this.cr)
    this.cr.hp = this.cr.hp > 0 ? Math.min(max, Math.max(1, Math.round(ratio * max))) : 0
    this.host.emit({ t: 'form', side: BOSS_SIDE, form: id, fromSpeciesId: from, creature: this.host.view(this.cr) })
    if (form.banner) this.host.say(form.banner, this.params())
  }

  // ------------------------------------------------------------------ HUD & state

  hud(): BossHud {
    const meters: Record<string, number> = {}
    for (const m of this.def.meters) if (m.show) meters[m.id] = hit(this.core.meters[m.id])
    return {
      bossId: this.def.id, form: this.core.form, phase: 1 + this.core.phase, phases: 1 + this.phaseCount, meters,
      charge: this.core.charge?.move ?? null, enrage: this.core.enrage,
    }
  }

  private pushHud(force = false): void {
    const hud = this.hud()
    const key = JSON.stringify(hud)
    if (!force && key === this.lastHud) return
    this.lastHud = key
    this.host.emit({ t: 'boss', side: BOSS_SIDE, hud })
  }

  extract(): BossState {
    const b = this.host.battler()
    return JSON.parse(JSON.stringify({
      bossId: this.def.id, form: this.core.form, turn: this.host.turn(), formTurn: this.core.formTurn, fired: this.core.fired,
      phase: this.core.phase, meters: this.core.meters, enrage: this.core.enrage, charge: this.core.charge, skip: this.core.skip,
      borrowed: this.core.borrowed, lastFoeType: this.core.lastFoeType, lastFoeMove: this.core.lastFoeMove, seenTypes: this.core.seenTypes,
      speciesId: this.cr.speciesId, abilityId: this.cr.abilityId, hp: this.cr.hp, maxHp: this.host.maxHp(this.cr),
      stages: { ...emptyStageRecord(), ...b.stages }, status: this.cr.status, statusTurns: this.cr.statusTurns, volatiles: b.volatiles,
      moves: this.cr.moves, recharging: b.recharging,
    })) as BossState
  }

  /** Writes a state taken with extract() back, including the battle turn counter the boss rules are clocked by. */
  apply(s: BossState): void {
    if (s.bossId !== this.def.id) return
    const c = JSON.parse(JSON.stringify(s)) as BossState
    this.core = {
      form: c.form, formTurn: c.formTurn, fired: c.fired, phase: c.phase, meters: c.meters, enrage: c.enrage, charge: c.charge,
      skip: c.skip, borrowed: c.borrowed, lastFoeType: c.lastFoeType, lastFoeMove: c.lastFoeMove, seenTypes: c.seenTypes,
    }
    this.host.setTurn(Math.max(0, Math.floor(c.turn)))
    this.cr.speciesId = c.speciesId
    this.cr.abilityId = c.abilityId
    this.cr.moves = c.moves
    this.cr.status = c.status
    this.cr.statusTurns = c.statusTurns
    this.host.setBattler({ stages: c.stages, volatiles: c.volatiles, recharging: c.recharging })
    this.cr.hp = Math.max(0, Math.min(c.hp, this.host.maxHp(this.cr)))
    this.pushHud(true)
  }
}
