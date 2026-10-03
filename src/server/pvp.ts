// PvP battle sessions (PvpModule for the hub): challenge → respond → pvp.start (side 0 = challenger) →
// both parties (sanitized clones) → BattleEngine (remote vs remote) → per-side perspective events →
// turn timer with auto-pick / AFK forfeit, forfeit, disconnect (= loss) → pvp.end + records.
// Challenge and acceptance both require host.inRange (when the host provides it).
// Rules and timings live in content/multiplayer.json (pvp) and CONTENT.config.net; texts in t('multiplayer.*').
import { randomInt } from 'node:crypto'
import type { ClientMsg, ServerMsg } from '../shared/protocol.ts'
import type {
  BattleAction, BattleEvent, BattleInit, BattleRequest, Creature, CreatureView, SideIndex, TimeOfDay,
} from '../shared/types.ts'
import { CONTENT, t } from '../shared/content/index.ts'
import { BattleEngine, perspective } from '../shared/battle/engine.ts'
import { healFull, sanitizeCreature } from '../shared/creature.ts'
import multiplayerJson from '../../content/multiplayer.json' with { type: 'json' }
import { maskBanned } from './moderation.ts'
import type { PvpHost, PvpInstance } from './pvp-hooks.ts'
import { isRecord, newSessionId } from './util.ts'

/** Server view of content/multiplayer.json → pvp. */
export interface PvpRules {
  challengeSeconds: number
  partySeconds: number
  /** Consecutive turn timeouts after which a side forfeits. */
  afkForfeitAfter: number
  /** Restore hp/pp/status of every submitted creature (the client's save is never touched either way). */
  healParty: boolean
  /** Safety bound on engine steps resolved for a single client input. */
  maxResolveSteps: number
  arena: { biomes: string[]; timeOfDay: TimeOfDay[]; weather?: string }
}

/** Timing/rule overrides (tests); turnSeconds defaults to CONTENT.config.net.pvpTurnSeconds. */
export type PvpOverrides = Partial<PvpRules> & { turnSeconds?: number }

export const PVP_RULES: PvpRules = (multiplayerJson as unknown as { pvp: PvpRules }).pvp

type PvpMsg = Extract<ClientMsg, { t: `pvp.${string}` }>
type EndResult = Extract<ServerMsg, { t: 'pvp.end' }>['result']
type EndEvent = Extract<BattleEvent, { t: 'end' }>

interface Seat { id: string; name: string; avatar: string; party: Creature[] | null; strikes: number }

interface Session {
  id: string
  seats: [Seat, Seat]
  engine: BattleEngine | null
  timer: ReturnType<typeof setTimeout> | null
  done: boolean
}

interface Challenge { from: string; to: string; fromName: string; toName: string; timer: ReturnType<typeof setTimeout> }

const SIDES: readonly SideIndex[] = [0, 1]
const other = (s: SideIndex): SideIndex => (s === 0 ? 1 : 0)
const WAIT: BattleRequest = { kind: 'wait' }

/** Deterministic arena (biome, time of day) for a battle seed; mirrored by the client (pvp-channel.ts arenaFor). */
export function arenaFor(seed: number, rules: PvpRules = PVP_RULES): { biome: string; timeOfDay: TimeOfDay } {
  const biomes = rules.arena.biomes.filter((b) => CONTENT.biomeById[b])
  const times = rules.arena.timeOfDay
  const n = Math.abs(Math.floor(seed))
  return {
    biome: biomes.length ? biomes[n % biomes.length] : (CONTENT.biomes[0]?.id ?? ''),
    timeOfDay: times.length ? times[Math.floor(n / Math.max(1, biomes.length)) % times.length] : 'day',
  }
}

/** Untrusted pvp.party payload → sanitized, moderated, independent clones (null = reject). */
export function sanitizePvpParty(raw: unknown, rules: PvpRules = PVP_RULES): Creature[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > CONTENT.config.party.maxParty) return null
  const out: Creature[] = []
  const uids = new Set<string>()
  for (const r of raw) {
    const cr = sanitizeCreature(r)
    if (!cr || uids.has(cr.uid)) return null
    uids.add(cr.uid)
    // Nicknames and OT names are shown to the opponent in battle text.
    if (cr.nickname) cr.nickname = maskBanned(cr.nickname)
    cr.otName = maskBanned(cr.otName)
    if (rules.healParty) healFull(cr)
    out.push(cr)
  }
  return out.some((cr) => cr.hp > 0) ? out : null
}

/** Only the action shapes of the contract survive; the engine validates them against the battle state. */
function parseAction(raw: unknown): BattleAction | null {
  if (!isRecord(raw)) return null
  switch (raw.kind) {
    case 'move': return Number.isInteger(raw.moveIndex) ? { kind: 'move', moveIndex: raw.moveIndex as number } : null
    case 'switch': return Number.isInteger(raw.partyIndex) ? { kind: 'switch', partyIndex: raw.partyIndex as number } : null
    case 'item': {
      if (typeof raw.itemId !== 'string') return null
      return Number.isInteger(raw.partyIndex) ? { kind: 'item', itemId: raw.itemId, partyIndex: raw.partyIndex as number } : { kind: 'item', itemId: raw.itemId }
    }
    case 'run': return { kind: 'run' }
    case 'forfeit': return { kind: 'forfeit' }
    default: return null
  }
}

export function createPvp(host: PvpHost, overrides: PvpOverrides = {}): PvpInstance {
  const rules: PvpRules = { ...PVP_RULES, ...overrides }
  const turnSeconds = overrides.turnSeconds ?? CONTENT.config.net.pvpTurnSeconds
  const levelCap = CONTENT.config.net.pvpLevelCap
  const sessions = new Map<string, Session>()
  const sessionOf = new Map<string, Session>()
  const challengeFrom = new Map<string, Challenge>()
  const challengeTo = new Map<string, Challenge>()

  const fail = (id: string, code: string, params?: Record<string, string | number>) =>
    host.send(id, { t: 'error', code, message: t(`multiplayer.serverError.${code}`, params) })

  const later = (seconds: number, fn: () => void) => {
    const tm = setTimeout(fn, Math.max(0, seconds) * 1000)
    tm.unref?.()
    return tm
  }

  // ------------------------------------------------------------------ challenges

  function dropChallenge(ch: Challenge): void {
    clearTimeout(ch.timer)
    if (challengeFrom.get(ch.from) === ch) challengeFrom.delete(ch.from)
    if (challengeTo.get(ch.to) === ch) challengeTo.delete(ch.to)
  }

  const engaged = (id: string) => sessionOf.has(id) || challengeFrom.has(id) || challengeTo.has(id)

  function challenge(from: string, to: unknown): void {
    const me = host.getPlayer(from)
    if (!me) return
    if (typeof to !== 'string' || !to) { fail(from, 'pvp_not_found'); return }
    if (to === from) { fail(from, 'pvp_self'); return }
    const target = host.getPlayer(to)
    if (!target) { fail(from, 'pvp_not_found'); return }
    if (me.busy || sessionOf.has(from)) { fail(from, 'pvp_self_busy'); return }
    if (challengeFrom.has(from) || challengeTo.has(from)) { fail(from, 'pvp_pending'); return }
    if (target.busy || engaged(to)) { fail(from, 'pvp_busy'); return }
    if (host.inRange && !host.inRange(from, to)) { fail(from, 'pvp_too_far', { name: target.name }); return }
    const ch: Challenge = {
      from, to, fromName: me.name, toName: target.name,
      timer: later(rules.challengeSeconds, () => {
        dropChallenge(ch)
        fail(ch.from, 'pvp_expired')
        fail(ch.to, 'pvp_expired')
      }),
    }
    challengeFrom.set(from, ch)
    challengeTo.set(to, ch)
    host.send(to, { t: 'pvp.challenged', from, name: me.name })
  }

  function respond(me: string, from: unknown, accept: unknown): void {
    const ch = challengeTo.get(me)
    if (!ch || ch.from !== from) { fail(me, 'pvp_challenge_not_found'); return }
    dropChallenge(ch)
    if (accept !== true) { fail(ch.from, 'pvp_declined', { name: ch.toName }); return }
    const a = host.getPlayer(ch.from)
    const b = host.getPlayer(me)
    if (!b) return
    if (!a) { fail(me, 'pvp_opponent_left', { name: ch.fromName }); return }
    if (b.busy || sessionOf.has(b.id)) { fail(b.id, 'pvp_self_busy'); fail(a.id, 'pvp_busy'); return }
    if (a.busy || sessionOf.has(a.id)) { fail(b.id, 'pvp_busy'); fail(a.id, 'pvp_self_busy'); return }
    if (host.inRange && !host.inRange(a.id, b.id)) { fail(b.id, 'pvp_too_far', { name: a.name }); fail(a.id, 'pvp_too_far', { name: b.name }); return }
    open(a, b)
  }

  // ------------------------------------------------------------------ sessions

  function open(a: { id: string; name: string; avatar: string }, b: { id: string; name: string; avatar: string }): void {
    const seat = (p: typeof a): Seat => ({ id: p.id, name: p.name, avatar: p.avatar, party: null, strikes: 0 })
    const s: Session = { id: newSessionId(), seats: [seat(a), seat(b)], engine: null, timer: null, done: false }
    sessions.set(s.id, s)
    for (const st of s.seats) { sessionOf.set(st.id, s); host.setBusy(st.id, true) }
    for (const side of SIDES) {
      const o = s.seats[other(side)]
      host.send(s.seats[side].id, { t: 'pvp.start', battleId: s.id, side, opponent: { id: o.id, name: o.name, avatar: o.avatar }, levelCap })
    }
    arm(s, rules.partySeconds, () => partyTimeout(s))
  }

  function arm(s: Session, seconds: number, fn: () => void): void {
    if (s.timer) clearTimeout(s.timer)
    s.timer = later(seconds, () => { s.timer = null; if (!s.done) fn() })
  }

  function release(s: Session): void {
    s.done = true
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    sessions.delete(s.id)
    for (const st of s.seats) {
      if (sessionOf.get(st.id) === s) sessionOf.delete(st.id)
      host.setBusy(st.id, false)
    }
  }

  /**
   * Ends a session without a result record (before the battle began, or on an internal failure).
   * codes[side]: error explaining why to that seat (null = it caused the abort itself); {name} = the other seat.
   */
  function abort(s: Session, codes: [string | null, string | null], result: [EndResult, EndResult] = ['draw', 'draw']): void {
    if (s.done) return
    for (const side of SIDES) {
      const st = s.seats[side]
      const code = codes[side]
      if (code) fail(st.id, code, { name: s.seats[other(side)].name })
      host.send(st.id, { t: 'pvp.end', battleId: s.id, result: result[side] })
    }
    release(s)
  }

  /** [code for `side`, code for the other seat] laid out by seat index. */
  const bySide = <T>(side: SideIndex, mine: T, theirs: T): [T, T] => (side === 0 ? [mine, theirs] : [theirs, mine])

  function seatOf(id: string, battleId: unknown): { s: Session; side: SideIndex } | null {
    const s = sessionOf.get(id)
    if (!s || s.done || s.id !== battleId) return null
    return { s, side: s.seats[0].id === id ? 0 : 1 }
  }

  function partyTimeout(s: Session): void {
    const late = s.seats.map((st) => st.party === null)
    abort(s, [
      late[0] ? 'pvp_party_timeout' : 'pvp_opponent_timeout',
      late[1] ? 'pvp_party_timeout' : 'pvp_opponent_timeout',
    ])
  }

  function party(from: string, battleId: unknown, raw: unknown): void {
    const found = seatOf(from, battleId)
    if (!found) { fail(from, 'pvp_battle_not_found'); return }
    const { s, side } = found
    if (s.engine || s.seats[side].party) return
    const cleaned = sanitizePvpParty(raw, rules)
    if (!cleaned) {
      abort(s, bySide(side, 'pvp_party_invalid', 'pvp_cancelled'))
      return
    }
    s.seats[side].party = cleaned
    if (s.seats.every((st) => st.party)) begin(s)
  }

  function begin(s: Session): void {
    const seed = randomInt(0, 2 ** 31 - 1)
    const arena = arenaFor(seed, rules)
    const weather = rules.arena.weather
    const init: BattleInit = {
      seed,
      sides: [
        { kind: 'remote', name: s.seats[0].name, party: s.seats[0].party! },
        { kind: 'remote', name: s.seats[1].name, party: s.seats[1].party! },
      ],
      isWild: false,
      canRun: false,
      canCatch: false,
      biome: arena.biome,
      timeOfDay: arena.timeOfDay,
      ...(weather && CONTENT.weatherById[weather] ? { weather } : {}),
      expGain: false,
      levelCap,
    }
    let engine: BattleEngine
    try {
      engine = new BattleEngine(init)
    } catch {
      abort(s, ['pvp_error', 'pvp_error'])
      return
    }
    s.engine = engine
    for (const side of SIDES) {
      const foe = other(side)
      host.send(s.seats[side].id, {
        t: 'pvp.begin', battleId: s.id, seed,
        yourParty: partyViews(engine, side),
        theirLead: engine.activeView(foe),
        theirPartySize: engine.party(foe).length,
      })
    }
    deliver(s, engine.start(), [[], []])
  }

  function partyViews(e: BattleEngine, side: SideIndex): CreatureView[] {
    return e.party(side).map((cr, i) => ({
      uid: cr.uid, speciesId: cr.speciesId, nickname: cr.nickname, level: Math.min(cr.level, levelCap),
      hp: cr.hp, maxHp: e.battleMaxHp(side, i), status: cr.status, shiny: cr.shiny,
    }))
  }

  /** Sends one resolved batch (absolute events) to both seats in their own perspective, then schedules what's next. */
  function deliver(s: Session, events: BattleEvent[], notes: [BattleEvent[], BattleEvent[]]): void {
    const e = s.engine!
    for (const side of SIDES) {
      host.send(s.seats[side].id, {
        t: 'pvp.events', battleId: s.id, events: [...notes[side], ...perspective(events, side)], request: e.finished ? WAIT : e.request(side),
      })
    }
    if (e.finished) { finish(s, events.findLast((x): x is EndEvent => x.t === 'end') ?? null); return }
    if (SIDES.some((side) => e.request(side).kind !== 'wait')) arm(s, turnSeconds, () => turnTimeout(s))
  }

  /** Steps while every side that must act has acted (covers recharge turns where nobody chooses). */
  function resolve(s: Session, notes: [BattleEvent[], BattleEvent[]] = [[], []]): void {
    const e = s.engine!
    if (!e.ready()) return
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    const events: BattleEvent[] = []
    let steps = 0
    while (!e.finished && e.ready()) {
      if (steps++ >= rules.maxResolveSteps) { abort(s, ['pvp_error', 'pvp_error']); return }
      events.push(...e.step())
    }
    deliver(s, events, notes)
  }

  function finish(s: Session, end: EndEvent | null): void {
    const winner = end && end.winner !== -1 ? end.winner : null
    for (const side of SIDES) {
      let result: EndResult = 'draw'
      if (winner !== null) result = side === winner ? 'win' : end!.result === 'forfeit' ? 'forfeit' : 'lose'
      host.send(s.seats[side].id, { t: 'pvp.end', battleId: s.id, result })
    }
    if (winner !== null) host.recordPvp(s.seats[winner].id, s.seats[other(winner)].id)
    release(s)
  }

  function action(from: string, battleId: unknown, raw: unknown): void {
    const found = seatOf(from, battleId)
    if (!found || !found.s.engine) { fail(from, 'pvp_battle_not_found'); return }
    const { s, side } = found
    const e = found.s.engine
    if (e.finished) return
    const act = parseAction(raw)
    const reject = (text: string) => host.send(from, { t: 'pvp.events', battleId: s.id, events: [{ t: 'msg', text }], request: e.request(side) })
    if (!act) { reject(t('multiplayer.pvp.badAction')); return }
    const err = e.choose(side, act)
    if (err) { reject(err); return }
    s.seats[side].strikes = 0
    resolve(s)
  }

  function forfeit(from: string, battleId: unknown): void {
    if (battleId === '' || battleId === undefined) {
      // No battle yet: withdraw the caller's outgoing challenge.
      const ch = challengeFrom.get(from)
      if (!ch) { fail(from, 'pvp_challenge_not_found'); return }
      dropChallenge(ch)
      fail(ch.to, 'pvp_cancelled', { name: ch.fromName })
      return
    }
    const found = seatOf(from, battleId)
    if (!found) { fail(from, 'pvp_battle_not_found'); return }
    const { s, side } = found
    if (!s.engine) {
      abort(s, bySide<string | null>(side, null, 'pvp_cancelled'))
      return
    }
    if (s.engine.finished) return
    s.engine.choose(side, { kind: 'forfeit' })
    resolve(s)
  }

  /** Turn timer: auto-pick the first legal action for every side still deciding; repeated timeouts forfeit. */
  function turnTimeout(s: Session): void {
    const e = s.engine
    if (!e || e.finished) return
    const notes: [BattleEvent[], BattleEvent[]] = [[], []]
    for (const side of SIDES) {
      const req = e.request(side)
      if (req.kind === 'wait') continue
      const seat = s.seats[side]
      seat.strikes += 1
      if (seat.strikes >= rules.afkForfeitAfter || !autoPick(e, side, req)) {
        notes[side].push({ t: 'msg', text: t('multiplayer.pvp.afkForfeit') })
        e.choose(side, { kind: 'forfeit' })
        break
      }
      notes[side].push({ t: 'msg', text: t('multiplayer.pvp.timeout') })
    }
    resolve(s, notes)
  }

  function autoPick(e: BattleEngine, side: SideIndex, req: BattleRequest): boolean {
    const party = e.party(side)
    const trySwitch = () => party.some((_, i) => e.choose(side, { kind: 'switch', partyIndex: i }) === null)
    if (req.kind === 'switch') return trySwitch()
    const moves = party[e.activeIndex(side)]?.moves ?? []
    for (let i = 0; i < Math.max(1, moves.length); i++) if (e.choose(side, { kind: 'move', moveIndex: i }) === null) return true
    return trySwitch()
  }

  function disconnect(id: string): void {
    const out = challengeFrom.get(id)
    if (out) { dropChallenge(out); fail(out.to, 'pvp_cancelled', { name: out.fromName }) }
    const inc = challengeTo.get(id)
    if (inc) { dropChallenge(inc); fail(inc.from, 'pvp_opponent_left', { name: inc.toName }) }
    const s = sessionOf.get(id)
    if (!s || s.done) return
    const side: SideIndex = s.seats[0].id === id ? 0 : 1
    const left = s.seats[side]
    const stay = s.seats[other(side)]
    if (!s.engine || s.engine.finished) {
      abort(s, bySide<string | null>(side, null, 'pvp_opponent_left'), bySide<EndResult>(side, 'draw', 'disconnect'))
      return
    }
    host.send(stay.id, {
      t: 'pvp.events', battleId: s.id, request: WAIT,
      events: [{ t: 'msg', text: t('multiplayer.pvp.opponentLeft', { name: left.name }) }, { t: 'end', result: 'win', winner: 0 }],
    })
    host.send(stay.id, { t: 'pvp.end', battleId: s.id, result: 'disconnect' })
    host.recordPvp(stay.id, left.id)
    release(s)
  }

  return {
    handle(fromId: string, msg: ClientMsg) {
      const m = msg as PvpMsg
      switch (m.t) {
        case 'pvp.challenge': challenge(fromId, m.to); return
        case 'pvp.respond': respond(fromId, m.from, m.accept); return
        case 'pvp.party': party(fromId, m.battleId, m.party); return
        case 'pvp.action': action(fromId, m.battleId, m.action); return
        case 'pvp.forfeit': forfeit(fromId, m.battleId); return
        default: fail(fromId, 'pvp_bad_message')
      }
    },
    onDisconnect: disconnect,
    dispose() {
      for (const ch of [...challengeFrom.values()]) dropChallenge(ch)
      for (const s of [...sessions.values()]) release(s)
    },
  }
}
