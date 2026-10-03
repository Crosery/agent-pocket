// Client side of PvP: outgoing challenges, incoming challenge prompts, party submission, and a BattleChannel
// over the socket that ctx.battle.run(init, { kind: 'pvp', channel }) drives. The server is authoritative:
// the local BattleInit is display data only and the player's save is never changed by a PvP battle
// (apart from stats.pvpWins / pvpLosses). Rules: content/multiplayer.json (pvp); texts: t('multiplayer.*').
import type { BattleChannel, EventBus, GameContext, GameEvents, NetClient } from '../contracts.ts'
import type { ServerMsg } from '../../shared/protocol.ts'
import type {
  BattleAction, BattleEvent, BattleInit, BattleRequest, Creature, CreatureView, SaveData, StatKey, Stats, TimeOfDay,
} from '../../shared/types.ts'
import { CONTENT, t, type Content } from '../../shared/content/index.ts'
import { STAT_KEYS, calcStats, expForLevel, healFull } from '../../shared/creature.ts'
import multiplayerJson from '../../../content/multiplayer.json' with { type: 'json' }
import {
  isMultiplayerBusy, loadWidgets, markWithdrawn, onceSession, reportError, setMultiplayerBusy, showWaitPanel, takeWithdrawn,
  trackOnlineRoster, type WaitHandle,
} from './trade-flow.ts'

type ToastKind = 'info' | 'success' | 'warn' | 'error'
type PvpStart = Extract<ServerMsg, { t: 'pvp.start' }>
type PvpBegin = Extract<ServerMsg, { t: 'pvp.begin' }>
type PvpEvents = Extract<ServerMsg, { t: 'pvp.events' }>
type PvpEnd = Extract<ServerMsg, { t: 'pvp.end' }>
export type PvpResult = PvpEnd['result']
export type PvpOutcome = 'win' | 'loss' | 'draw'

/** Client view of content/multiplayer.json → pvp. */
export interface PvpClientRules {
  challengeSeconds: number
  partySeconds: number
  healParty: boolean
  clientSlackSeconds: number
  arena: { biomes: string[]; timeOfDay: TimeOfDay[]; weather?: string }
  /** Error codes that end an outgoing challenge. */
  challengeAbortErrors: string[]
  /** Error codes that invalidate an incoming challenge while its prompt is open. */
  inviteStaleErrors: string[]
  /** Error codes answering our pvp.respond (accept) instead of a pvp.start. */
  respondErrors: string[]
  resultOutcome: Record<PvpResult, PvpOutcome>
  outcomeToast: Record<PvpOutcome, ToastKind>
  sfx: { challenged: string; accepted: string }
}

export const PVP_CLIENT_RULES: PvpClientRules = (multiplayerJson as unknown as { pvp: PvpClientRules }).pvp
const R = PVP_CLIENT_RULES
const WAIT: BattleRequest = { kind: 'wait' }

/** Same deterministic arena as the server (src/server/pvp.ts arenaFor) for the battle seed. */
export function arenaFor(seed: number, rules: Pick<PvpClientRules, 'arena'> = R, c: Content = CONTENT): { biome: string; timeOfDay: TimeOfDay } {
  const biomes = rules.arena.biomes.filter((b) => c.biomeById[b])
  const times = rules.arena.timeOfDay
  const n = Math.abs(Math.floor(seed))
  return {
    biome: biomes.length ? biomes[n % biomes.length] : (c.biomes[0]?.id ?? ''),
    timeOfDay: times.length ? times[Math.floor(n / Math.max(1, biomes.length)) % times.length] : 'day',
  }
}

/** The party sent to the server (independent clones), or null when nobody could battle. */
export function pvpParty(save: Pick<SaveData, 'party'>, rules: Pick<PvpClientRules, 'healParty'> = R, c: Content = CONTENT): Creature[] | null {
  const party = save.party.slice(0, c.config.party.maxParty).map((cr) => structuredClone(cr))
  if (!party.length) return null
  if (rules.healParty) return party
  return party.some((cr) => cr.hp > 0) ? party : null
}

/** Outcome of a pvp.end result for the receiving player. */
export const outcomeOf = (r: PvpResult, rules: Pick<PvpClientRules, 'resultOutcome'> = R): PvpOutcome => rules.resultOutcome[r] ?? 'draw'

/** Result implied by an end event in our own perspective (fallback when pvp.end never arrives). */
export function resultFromEnd(e: Extract<BattleEvent, { t: 'end' }>): PvpResult {
  if (e.winner === -1) return 'draw'
  if (e.winner === 0) return 'win'
  return e.result === 'forfeit' ? 'forfeit' : 'lose'
}

// ---------------------------------------------------------------------------
// Local display BattleInit
// ---------------------------------------------------------------------------

/** IVs that reproduce a view's max hp at its level (stats other than hp share the value). */
function ivsFor(view: CreatureView, c: Content): Stats {
  const make = (iv: number) => Object.fromEntries(STAT_KEYS.map((k: StatKey) => [k, iv])) as Stats
  for (let iv = 0; iv <= c.config.creature.ivMax; iv++) {
    if (calcStats({ speciesId: view.speciesId, level: view.level, ivs: make(iv) }, c).hp >= view.maxHp) return make(iv)
  }
  return make(c.config.creature.ivMax)
}

/** Minimal creature for an opponent we only know through a CreatureView. */
export function creatureFromView(view: CreatureView, owner: { id: string; name: string }, c: Content = CONTENT): Creature {
  const sp = c.species[view.speciesId]
  const cr: Creature = {
    uid: view.uid, speciesId: view.speciesId, level: view.level,
    exp: sp ? expForLevel(sp.growth, view.level, c) : 0,
    ivs: ivsFor(view, c), moves: [], hp: Math.max(0, Math.min(view.hp, view.maxHp)), status: view.status, statusTurns: 0,
    abilityId: sp?.abilities[0] ?? '', shiny: view.shiny, friendship: 0, ballId: '', caughtMap: '', otName: owner.name, otId: owner.id,
  }
  if (view.nickname) cr.nickname = view.nickname
  return cr
}

/**
 * BattleInit for the local battle presentation. Side 0 = us (clones of what we sent, adjusted to the server's
 * level-capped views); side 1 = the opponent's lead plus unrevealed bench slots (filled by 'switch' events).
 */
export function buildPvpInit(
  save: Pick<SaveData, 'name'>, start: PvpStart, begin: PvpBegin, sent: readonly Creature[], c: Content = CONTENT,
): BattleInit {
  const byUid = new Map(sent.map((cr) => [cr.uid, cr]))
  const mine = begin.yourParty.map((v) => {
    const base = byUid.get(v.uid)
    if (!base) return creatureFromView(v, { id: '', name: save.name }, c)
    const cr = structuredClone(base)
    if (R.healParty) healFull(cr, c)
    if (cr.level > v.level) {
      cr.level = v.level
      const sp = c.species[cr.speciesId]
      if (sp) cr.exp = expForLevel(sp.growth, v.level, c)
    }
    cr.hp = v.hp
    cr.status = v.status
    return cr
  })
  const owner = { id: start.opponent.id, name: start.opponent.name }
  const lead = creatureFromView(begin.theirLead, owner, c)
  const theirs = [lead]
  for (let i = 1; i < begin.theirPartySize; i++) {
    const bench = creatureFromView({ ...begin.theirLead, uid: `${begin.theirLead.uid}#${i}`, hp: begin.theirLead.maxHp, status: null }, owner, c)
    theirs.push(bench)
  }
  const arena = arenaFor(begin.seed, R, c)
  const weather = R.arena.weather
  return {
    seed: begin.seed,
    sides: [
      { kind: 'player', name: save.name, party: mine },
      { kind: 'remote', name: start.opponent.name, party: theirs, sprite: start.opponent.avatar },
    ],
    isWild: false,
    canRun: false,
    canCatch: false,
    biome: arena.biome,
    timeOfDay: arena.timeOfDay,
    ...(weather && c.weatherById[weather] ? { weather } : {}),
    expGain: false,
    levelCap: start.levelCap,
  }
}

// ---------------------------------------------------------------------------
// BattleChannel over the socket
// ---------------------------------------------------------------------------

export interface PvpChannel extends BattleChannel {
  /** Final result for us (pvp.end, or derived from the end event / a lost connection); null while running. */
  readonly result: PvpResult | null
  /** True when our own connection dropped mid-battle (the server counts it as a loss). */
  readonly connectionLost: boolean
  /** True once the battle is over (end event, pvp.end or lost connection). */
  readonly ended: boolean
  /** Resolves when pvp.end arrived (or after `ms`), returning the final result. */
  waitResult(ms: number): Promise<PvpResult | null>
  /** Unsubscribes; with `forfeit` (default) a still-running battle is forfeited on the server. */
  dispose(forfeit?: boolean): void
}

/**
 * Buffers pvp.events for `battleId` from the moment it is created. start()/submit() resolve with every batch
 * received until the server asks us for a decision (batches whose request is 'wait' are merged into the next
 * one) or the battle ends. A submit made after the server already moved on (turn timer auto-pick) is not sent;
 * it resolves with the pending batches instead.
 */
export function createPvpChannel(
  net: Pick<NetClient, 'on' | 'send' | 'status'>, battleId: string, events?: Pick<EventBus<GameEvents>, 'on'>,
): PvpChannel {
  const inbox: PvpEvents[] = []
  let endMsg: PvpEnd | null = null
  let endEvent: Extract<BattleEvent, { t: 'end' }> | null = null
  let lost = false
  let delivered = false
  let disposed = false
  let wake: (() => void) | null = null
  const endWaiters = new Set<() => void>()

  const poke = () => { const w = wake; wake = null; w?.() }
  const offs: (() => void)[] = [
    net.on('pvp.events', (m) => { if (m.battleId === battleId) { inbox.push(m); poke() } }),
    net.on('pvp.end', (m) => {
      if (m.battleId !== battleId) return
      endMsg = m
      for (const w of [...endWaiters]) w()
      poke()
    }),
  ]
  if (events) offs.push(events.on('net:status', ({ status }) => { if (status !== 'online' && !channel.ended) { lost = true; poke() } }))

  async function collect(): Promise<{ events: BattleEvent[]; request: BattleRequest }> {
    const out: BattleEvent[] = []
    let request: BattleRequest = WAIT
    let got = false
    for (;;) {
      while (inbox.length) {
        const m = inbox.shift()!
        got = true
        out.push(...m.events)
        request = m.request
        const end = m.events.findLast((e): e is Extract<BattleEvent, { t: 'end' }> => e.t === 'end')
        if (end) endEvent = end
      }
      if (endEvent) { delivered = true; return { events: out, request: WAIT } }
      if (got && request.kind !== 'wait') return { events: out, request }
      if (endMsg || lost || disposed) {
        // Ended without a final batch (connection loss on either side): close the battle for the presenter.
        const text = lost || disposed ? t('multiplayer.pvp.connectionLost') : t('multiplayer.pvp.cancelled')
        endEvent = { t: 'end', result: lost ? 'forfeit' : 'draw', winner: lost ? 1 : -1 }
        out.push({ t: 'msg', text }, endEvent)
        delivered = true
        return { events: out, request: WAIT }
      }
      await new Promise<void>((r) => { wake = r })
    }
  }

  const channel: PvpChannel = {
    get result() {
      if (endMsg) return endMsg.result
      if (lost) return 'lose'
      return endEvent ? resultFromEnd(endEvent) : null
    },
    get connectionLost() { return lost },
    get ended() { return delivered || endMsg !== null || lost },
    start: () => collect(),
    submit(action: BattleAction) {
      if (delivered) return Promise.resolve({ events: [], request: WAIT })
      if (inbox.length === 0 && !endMsg && !lost && net.status === 'online') net.send({ t: 'pvp.action', battleId, action })
      return collect()
    },
    waitResult(ms: number) {
      if (endMsg || lost) return Promise.resolve(channel.result)
      return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); endWaiters.delete(done); resolve(channel.result) }
        const timer = setTimeout(done, ms)
        endWaiters.add(done)
      })
    },
    dispose(forfeit = true) {
      if (disposed) return
      // Leaving a running battle (presenter aborted) is a forfeit; the server would otherwise wait for AFK.
      if (forfeit && !channel.ended && net.status === 'online') net.send({ t: 'pvp.forfeit', battleId })
      disposed = true
      for (const off of offs) off()
      poke()
    },
  }
  return channel
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

/** Restores party membership, order and every field after a battle (identity of creature objects is kept). */
function snapshotParty(save: SaveData): () => void {
  const order = save.party.slice()
  const fields = new Map(order.map((cr) => [cr, structuredClone(cr)]))
  return () => {
    save.party.splice(0, save.party.length, ...order)
    for (const [cr, snap] of fields) {
      const bag = cr as unknown as Record<string, unknown>
      for (const k of Object.keys(bag)) if (!(k in snap)) delete bag[k]
      Object.assign(cr, snap)
    }
  }
}

/** Waits for pvp.begin after our party was sent; null when the session ended first (both sides notified by errors). */
function waitBegin(ctx: GameContext, battleId: string): Promise<PvpBegin | null> {
  return new Promise((resolve) => {
    const offs: (() => void)[] = []
    let wait: WaitHandle | null = null
    let settled = false
    const done = (v: PvpBegin | null) => {
      if (settled) return
      settled = true
      for (const off of offs) off()
      clearTimeout(timer)
      wait?.close()
      resolve(v)
    }
    offs.push(ctx.net.on('pvp.begin', (m) => { if (m.battleId === battleId) done(m) }))
    offs.push(ctx.net.on('pvp.end', (m) => { if (m.battleId === battleId) done(null) }))
    offs.push(ctx.events.on('net:status', ({ status }) => { if (status !== 'online') { ctx.ui.toast(t('multiplayer.pvp.connectionLost'), 'warn'); done(null) } }))
    const timer = setTimeout(() => {
      ctx.net.send({ t: 'pvp.forfeit', battleId })
      ctx.ui.toast(t('multiplayer.pvp.cancelled'), 'warn')
      done(null)
    }, (R.partySeconds + R.clientSlackSeconds) * 1000)
    void showWaitPanel(ctx, {
      text: t('multiplayer.pvp.waitingOpponent'),
      seconds: R.partySeconds,
      onCancel: () => { ctx.net.send({ t: 'pvp.forfeit', battleId }); done(null) },
    }).then((h) => { if (settled) h.close(); else wait = h }, (err) => { reportError(err) })
  })
}

/** pvp.start handler shared by every listener: plays the session once, or cancels a start we withdrew from. */
function openPvp(ctx: GameContext, start: PvpStart): Promise<void> {
  return onceSession(ctx, `pvp:${start.battleId}`, async () => {
    if (takeWithdrawn(ctx, 'pvp', start.opponent.id)) { ctx.net.send({ t: 'pvp.forfeit', battleId: start.battleId }); return }
    setMultiplayerBusy(ctx, 'pvp', true)
    try { await playSession(ctx, start) } finally { setMultiplayerBusy(ctx, 'pvp', false) }
  })
}

async function playSession(ctx: GameContext, start: PvpStart): Promise<void> {
  const { battleId, opponent } = start
  const sent = pvpParty(ctx.save)
  // Subscribe before sending the party so no batch can slip past.
  const channel = createPvpChannel(ctx.net, battleId, ctx.events)
  if (!sent) {
    ctx.ui.toast(t('multiplayer.pvp.noParty'), 'warn')
    ctx.net.send({ t: 'pvp.forfeit', battleId })
    channel.dispose(false)
    return
  }
  ctx.audio.playSfx(R.sfx.accepted)
  ctx.ui.toast(t('multiplayer.pvp.preparing', { name: opponent.name }), 'info')
  ctx.net.send({ t: 'pvp.party', battleId, party: sent })
  const begin = await waitBegin(ctx, battleId)
  if (!begin) { channel.dispose(false); return }

  const init = buildPvpInit(ctx.save, start, begin, sent)
  const restore = snapshotParty(ctx.save)
  try {
    await ctx.battle.run(init, { kind: 'pvp', channel })
  } catch (err) {
    reportError(err)
  } finally {
    restore()
    channel.dispose()
  }
  const result = (await channel.waitResult(R.clientSlackSeconds * 1000)) ?? 'draw'
  const outcome = outcomeOf(result)
  if (outcome === 'win') ctx.save.stats.pvpWins += 1
  else if (outcome === 'loss') ctx.save.stats.pvpLosses += 1
  const text = channel.connectionLost ? t('multiplayer.pvp.connectionLost') : t(`multiplayer.pvp.result.${result}`, { name: opponent.name })
  ctx.ui.toast(text, R.outcomeToast[outcome])
  ctx.events.emit('party:changed', {})
  ctx.persist('pvp')
}

/** Challenges `targetId`; plays the battle when accepted. Resolves when the whole flow is over. */
export async function challengePvp(ctx: GameContext, targetId: string, targetName: string): Promise<void> {
  if (ctx.net.status !== 'online') { ctx.ui.toast(t('multiplayer.status.notOnline'), 'warn'); return }
  if (isMultiplayerBusy(ctx)) { ctx.ui.toast(t('multiplayer.serverError.pvp_self_busy'), 'warn'); return }
  if (!pvpParty(ctx.save)) { ctx.ui.toast(t('multiplayer.pvp.noParty'), 'warn'); return }
  void loadWidgets()
  setMultiplayerBusy(ctx, 'pvpRequest', true)
  let start: PvpStart | null = null
  try {
    start = await new Promise<PvpStart | null>((resolve) => {
      const offs: (() => void)[] = []
      let wait: WaitHandle | null = null
      let settled = false
      const done = (v: PvpStart | null) => {
        if (settled) return
        settled = true
        for (const off of offs) off()
        clearTimeout(timer)
        wait?.close()
        resolve(v)
      }
      offs.push(ctx.net.on('pvp.start', (m) => { if (m.opponent.id === targetId) done(m) }))
      offs.push(ctx.net.on('error', (m) => { if (R.challengeAbortErrors.includes(m.code)) { ctx.ui.toast(m.message, 'warn'); done(null) } }))
      offs.push(ctx.events.on('net:status', ({ status }) => { if (status !== 'online') { ctx.ui.toast(t('multiplayer.pvp.connectionLost'), 'warn'); done(null) } }))
      const timer = setTimeout(() => done(null), (R.challengeSeconds + R.clientSlackSeconds) * 1000)
      void showWaitPanel(ctx, {
        text: t('multiplayer.pvp.challenging', { name: targetName }),
        seconds: R.challengeSeconds,
        onCancel: () => {
          markWithdrawn(ctx, 'pvp', targetId)
          ctx.net.send({ t: 'pvp.forfeit', battleId: '' })
          done(null)
        },
      }).then((h) => {
        if (settled) h.close()
        else { wait = h; ctx.net.send({ t: 'pvp.challenge', to: targetId }) }
      }, (err) => { reportError(err); done(null) })
    })
  } finally {
    setMultiplayerBusy(ctx, 'pvpRequest', false)
  }
  if (start) await openPvp(ctx, start)
}

/** Incoming challenges (accept/decline via ctx.ui.choose, auto-decline while busy) and pvp.start. Call once. */
export function installPvpHandlers(ctx: GameContext): () => void {
  trackOnlineRoster(ctx.net)
  const offs: (() => void)[] = [
    ctx.net.on('pvp.start', (m) => { void openPvp(ctx, m) }),
    ctx.net.on('pvp.challenged', (m) => { void onChallenged(ctx, m) }),
  ]
  return () => { for (const off of offs) off() }
}

async function onChallenged(ctx: GameContext, m: Extract<ServerMsg, { t: 'pvp.challenged' }>): Promise<void> {
  if (isMultiplayerBusy(ctx)) {
    ctx.net.send({ t: 'pvp.respond', from: m.from, accept: false })
    ctx.ui.toast(t('multiplayer.pvp.autoDeclined', { name: m.name }), 'info')
    return
  }
  if (!pvpParty(ctx.save)) {
    ctx.net.send({ t: 'pvp.respond', from: m.from, accept: false })
    ctx.ui.toast(t('multiplayer.pvp.noParty'), 'warn')
    return
  }
  setMultiplayerBusy(ctx, 'pvpInvite', true)
  let stale = false
  const offs = [
    ctx.net.on('error', (e) => { if (R.inviteStaleErrors.includes(e.code)) stale = true }),
    ctx.events.on('net:status', ({ status }) => { if (status !== 'online') stale = true }),
  ]
  ctx.audio.playSfx(R.sfx.challenged)
  let pick = 1
  try {
    pick = await ctx.ui.choose(
      t('multiplayer.pvp.incoming', { name: m.name }) + t('multiplayer.pvp.incomingRules', { cap: CONTENT.config.net.pvpLevelCap }),
      [t('multiplayer.pvp.accept'), t('multiplayer.pvp.decline')],
      { cancelIndex: 1 },
    )
  } finally {
    for (const off of offs) off()
    setMultiplayerBusy(ctx, 'pvpInvite', false)
  }
  if (stale) { if (pick === 0) ctx.ui.toast(t('multiplayer.pvp.inviteStale'), 'info'); return }
  if (pick !== 0) { ctx.net.send({ t: 'pvp.respond', from: m.from, accept: false }); return }
  // pvp.start (handled by installPvpHandlers) follows an accepted challenge; report why it doesn't come.
  const offs2: (() => void)[] = []
  const stop = () => { for (const off of offs2) off(); clearTimeout(timer) }
  const timer = setTimeout(stop, R.clientSlackSeconds * 1000)
  offs2.push(ctx.net.on('pvp.start', (s) => { if (s.opponent.id === m.from) stop() }))
  offs2.push(ctx.net.on('error', (e) => { if (R.respondErrors.includes(e.code)) { ctx.ui.toast(e.message, 'warn'); stop() } }))
  ctx.net.send({ t: 'pvp.respond', from: m.from, accept: true })
}
