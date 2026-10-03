// One-for-one creature trades: request → respond → start → offers (validated) → both confirm → complete.
// Any offer change resets both confirmations. Sessions end on cancel, disconnect, timeout or shutdown.
// Both the request and the acceptance require the players to be in trade range (deps.inRange).
import type { Creature } from '../shared/types.ts'
import type { ClientMsg } from '../shared/protocol.ts'
import { CONTENT, t } from '../shared/content/index.ts'
import { NET } from './config.ts'
import type { HubCore, Player } from './core.ts'
import { maskBanned } from './moderation.ts'
import { newSessionId } from './util.ts'

export type SanitizeCreature = (raw: unknown) => Creature | null

type TradeMsg = Extract<ClientMsg, { t: `trade.${string}` }>

interface Side { id: string; offer: Creature | null; confirmed: boolean }
interface Trade { id: string; sides: [Side, Side]; startedAt: number; done: boolean }
interface Pending { tradeId: string; from: string; to: string; expiresAt: number }

export interface TradeService {
  handle(c: Player, msg: TradeMsg, now?: number): void
  onDisconnect(c: Player): void
  /** Expire timed-out trades and stale requests. */
  sweep(now?: number): void
  /** Cancel everything (server shutdown). */
  close(): void
  activeCount(): number
}

export interface TradeDeps {
  core: HubCore
  /** Resolved lazily: null while src/shared/creature.ts is unavailable. */
  sanitizer: () => SanitizeCreature | null
  recordTrade(id: string): void
  /** Proximity rule (same map, within range); omitted = no range limit. */
  inRange?(a: Player, b: Player): boolean
}

export function createTrades(deps: TradeDeps): TradeService {
  const { core } = deps
  const trades = new Map<string, Trade>()
  const pendingByFrom = new Map<string, Pending>()
  const pendingByTo = new Map<string, Pending>()

  const nameOf = (id: string) => core.byId(id)?.name ?? ''

  const cancelled = (id: string, tradeId: string, reason: string) => {
    const p = core.byId(id)
    if (p) core.send(p, { t: 'trade.cancelled', tradeId, reason })
  }

  const dropPending = (p: Pending) => {
    if (pendingByFrom.get(p.from) === p) pendingByFrom.delete(p.from)
    if (pendingByTo.get(p.to) === p) pendingByTo.delete(p.to)
  }

  const release = (tr: Trade) => {
    tr.done = true
    trades.delete(tr.id)
    for (const s of tr.sides) {
      const p = core.byId(s.id)
      if (p && p.tradeId === tr.id) { p.tradeId = null; core.touch(p) }
    }
  }

  const endTrade = (tr: Trade, reason: string, notify: readonly string[]) => {
    if (tr.done) return
    release(tr)
    for (const id of notify) cancelled(id, tr.id, reason)
  }

  const tradeOf = (c: Player, tradeId: unknown): { tr: Trade; me: Side; other: Side } | null => {
    if (typeof tradeId !== 'string' || c.tradeId !== tradeId) return null
    const tr = trades.get(tradeId)
    if (!tr || tr.done) return null
    const [a, b] = tr.sides
    if (a.id === c.id) return { tr, me: a, other: b }
    if (b.id === c.id) return { tr, me: b, other: a }
    return null
  }

  function request(c: Player, to: unknown, now: number) {
    if (!c.limits.tradeRequest.take(now)) { core.error(c, 'rate_limited'); return }
    const target = typeof to === 'string' ? core.find(to) : undefined
    if (!target) { core.error(c, 'not_found'); return }
    if (target === c) { core.error(c, 'self_target'); return }
    if (core.isBusy(c)) { core.error(c, 'self_busy'); return }
    if (pendingByFrom.has(c.id) || pendingByTo.has(c.id)) { core.error(c, 'trade_pending'); return }
    if (core.isBusy(target) || pendingByTo.has(target.id) || pendingByFrom.has(target.id)) { core.error(c, 'busy'); return }
    if (deps.inRange && !deps.inRange(c, target)) { core.error(c, 'too_far'); return }
    const p: Pending = { tradeId: newSessionId(), from: c.id, to: target.id, expiresAt: now + NET.server.tradeRequestSeconds * 1000 }
    pendingByFrom.set(p.from, p)
    pendingByTo.set(p.to, p)
    core.send(target, { t: 'trade.requested', from: c.id, name: c.name })
  }

  function respond(c: Player, from: unknown, accept: unknown, now: number) {
    const p = pendingByTo.get(c.id)
    if (!p || p.from !== from) { core.error(c, 'trade_not_found'); return }
    dropPending(p)
    const requester = core.byId(p.from)
    if (!requester) { core.error(c, 'not_found'); return }
    if (accept !== true) { cancelled(requester.id, p.tradeId, t('net.trade.declined', { name: c.name })); return }
    if (core.isBusy(c)) {
      core.error(c, 'self_busy')
      cancelled(requester.id, p.tradeId, t('net.trade.busy'))
      return
    }
    if (core.isBusy(requester)) {
      core.error(c, 'busy')
      cancelled(requester.id, p.tradeId, t('net.trade.busy'))
      return
    }
    if (deps.inRange && !deps.inRange(requester, c)) {
      core.error(c, 'too_far')
      core.send(c, { t: 'system', text: t('net.trade.tooFar', { name: requester.name }), level: 'warn' })
      cancelled(requester.id, p.tradeId, t('net.trade.tooFar', { name: c.name }))
      return
    }
    const tr: Trade = {
      id: p.tradeId,
      sides: [{ id: requester.id, offer: null, confirmed: false }, { id: c.id, offer: null, confirmed: false }],
      startedAt: now,
      done: false,
    }
    trades.set(tr.id, tr)
    requester.tradeId = tr.id
    c.tradeId = tr.id
    core.touch(requester)
    core.touch(c)
    core.send(requester, { t: 'trade.start', tradeId: tr.id, with: c.id, name: c.name })
    core.send(c, { t: 'trade.start', tradeId: tr.id, with: requester.id, name: requester.name })
  }

  function offer(c: Player, tradeId: unknown, raw: unknown) {
    const found = tradeOf(c, tradeId)
    if (!found) { core.error(c, 'trade_not_found'); return }
    const { tr, me, other } = found
    let creature: Creature | null = null
    if (raw !== null) {
      const sanitize = deps.sanitizer()
      if (!sanitize) { core.error(c, 'trade_unavailable'); return }
      creature = sanitize(raw)
      if (!creature || !CONTENT.species[creature.speciesId]) { core.error(c, 'trade_invalid_creature'); return }
      // Free text travels to another player: apply the same word filter as chat.
      if (creature.nickname) creature.nickname = maskBanned(creature.nickname)
      creature.otName = maskBanned(creature.otName)
      if (other.offer && other.offer.uid === creature.uid) { core.error(c, 'trade_invalid_creature'); return }
    }
    me.offer = creature
    me.confirmed = false
    other.confirmed = false
    core.send(c, { t: 'trade.offer', tradeId: tr.id, side: 'self', creature })
    const o = core.byId(other.id)
    if (o) core.send(o, { t: 'trade.offer', tradeId: tr.id, side: 'other', creature })
  }

  function confirm(c: Player, tradeId: unknown) {
    const found = tradeOf(c, tradeId)
    if (!found) { core.error(c, 'trade_not_found'); return }
    const { tr, me, other } = found
    if (!me.offer || !other.offer) { core.error(c, 'trade_incomplete'); return }
    if (me.confirmed) return
    me.confirmed = true
    core.send(c, { t: 'trade.confirmed', tradeId: tr.id, side: 'self' })
    const o = core.byId(other.id)
    if (o) core.send(o, { t: 'trade.confirmed', tradeId: tr.id, side: 'other' })
    if (other.confirmed) complete(tr)
  }

  function complete(tr: Trade) {
    const [a, b] = tr.sides
    if (tr.done || !a.offer || !b.offer) return
    const pa = core.byId(a.id), pb = core.byId(b.id)
    if (!pa || !pb) { endTrade(tr, t('net.trade.disconnected', { name: pa ? nameOf(b.id) : nameOf(a.id) }), [a.id, b.id]); return }
    const giveA = a.offer, giveB = b.offer
    release(tr)
    core.send(pa, { t: 'trade.complete', tradeId: tr.id, received: giveB, given: giveA.uid })
    core.send(pb, { t: 'trade.complete', tradeId: tr.id, received: giveA, given: giveB.uid })
    deps.recordTrade(a.id)
    deps.recordTrade(b.id)
  }

  function cancel(c: Player, tradeId: unknown) {
    const found = tradeOf(c, tradeId)
    if (found) {
      endTrade(found.tr, t('net.trade.cancelled', { name: c.name }), found.tr.sides.map((s) => s.id))
      return
    }
    const out = pendingByFrom.get(c.id)
    if (out) {
      dropPending(out)
      const reason = t('net.trade.cancelled', { name: c.name })
      cancelled(out.to, out.tradeId, reason)
      cancelled(out.from, out.tradeId, reason)
      return
    }
    const inc = pendingByTo.get(c.id)
    if (inc) {
      dropPending(inc)
      cancelled(inc.from, inc.tradeId, t('net.trade.declined', { name: c.name }))
      cancelled(inc.to, inc.tradeId, t('net.trade.declined', { name: c.name }))
      return
    }
    core.error(c, 'trade_not_found')
  }

  return {
    handle(c, msg, now = Date.now()) {
      if (msg.t !== 'trade.request' && !c.limits.tradeAction.take(now)) { core.error(c, 'rate_limited'); return }
      switch (msg.t) {
        case 'trade.request': request(c, msg.to, now); break
        case 'trade.respond': respond(c, msg.from, msg.accept, now); break
        case 'trade.offer': offer(c, msg.tradeId, msg.creature); break
        case 'trade.confirm': confirm(c, msg.tradeId); break
        case 'trade.cancel': cancel(c, msg.tradeId); break
        default: core.error(c, 'bad_message')
      }
    },

    onDisconnect(c) {
      const reason = t('net.trade.disconnected', { name: c.name })
      if (c.tradeId) {
        const tr = trades.get(c.tradeId)
        if (tr) endTrade(tr, reason, tr.sides.map((s) => s.id).filter((id) => id !== c.id))
        c.tradeId = null
      }
      const out = pendingByFrom.get(c.id)
      if (out) { dropPending(out); cancelled(out.to, out.tradeId, reason) }
      const inc = pendingByTo.get(c.id)
      if (inc) { dropPending(inc); cancelled(inc.from, inc.tradeId, reason) }
    },

    sweep(now = Date.now()) {
      const limit = CONTENT.config.net.tradeTimeoutSeconds * 1000
      for (const tr of [...trades.values()]) {
        if (now - tr.startedAt >= limit) endTrade(tr, t('net.trade.timeout'), tr.sides.map((s) => s.id))
      }
      for (const p of [...pendingByFrom.values()]) {
        if (now >= p.expiresAt) {
          dropPending(p)
          cancelled(p.from, p.tradeId, t('net.trade.requestExpired'))
          cancelled(p.to, p.tradeId, t('net.trade.requestExpired'))
        }
      }
    },

    close() {
      const reason = t('net.trade.shutdown')
      for (const tr of [...trades.values()]) endTrade(tr, reason, tr.sides.map((s) => s.id))
      for (const p of [...pendingByFrom.values()]) { dropPending(p); cancelled(p.from, p.tradeId, reason); cancelled(p.to, p.tradeId, reason) }
    },

    activeCount: () => trades.size,
  }
}
