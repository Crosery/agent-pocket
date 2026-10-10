// Connection hub: hello/presence, per-map interest management (distance + hysteresis), movement validation
// (bounds, speed, and on the generated world tile steps incl. the infinite overworld, frontier interiors and
// one-way ledges), proximity for trade / pvp, server-observed distance records, chunk-cache trimming around
// online players, inspect, leaderboard, heartbeat, and routing to chat / trade / pvp.
import type { IncomingMessage } from 'node:http'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import { createReplayWindow, verifyEnvelope } from '../shared/net-envelope.ts'
import type { ClientMsg, PlayerState, ServerMsg } from '../shared/protocol.ts'
import { decodeMoveFrame, encodePlayerDelta, staticStateKey, type CompactPlayerTuple } from '../shared/net-codec.ts'
import type { CoopClientMsg } from '../shared/coop/protocol.ts'
import { createDungeonServer } from './dungeon.ts'
import { CONTENT, t } from '../shared/content/index.ts'
import { toView } from '../shared/creature.ts'
import { checkOriginCsrf, parseSessionCookie, type SessionInfo } from './accounts.ts'
import { createAuthority, type AuthorityService } from './authority.ts'
import { MODERATION, NET, PRESENCE, type RateKey } from './config.ts'
import type { Conn, HubCore, LimiterKey, Player } from './core.ts'
import { createChat } from './chat.ts'
import { createTrades, type SanitizeCreature } from './trade.ts'
import type { ProfileStore } from './store.ts'
import type { WorldInfo } from './world.ts'
import type { PvpHost, PvpInstance, PvpModule } from './pvp-hooks.ts'
import { createSpatialIndex } from './spatial.ts'
import { fallbackName, sanitizeName, uniqueName } from './moderation.ts'
import { sanitizeAvatar, sanitizeLead, sanitizeProfile } from './sanitize.ts'
import {
  createRateLimiter, ID_TOKEN_RE, isDir, isFiniteNumber, isRecord, isUuidLike, newSecretId, publicIdFor, safeJsonParse,
  type RateLimiter,
} from './util.ts'

export interface HubOptions {
  store: ProfileStore
  world: WorldInfo | null
  pvp: PvpModule | null
  /** Resolves sanitizeCreature from src/shared/creature.ts (null while unavailable). */
  sanitizer: () => SanitizeCreature | null
  /** Directory for authoritative saves, ledger, and audit persistence. */
  dataDir?: string
  /** Optional pre-built authority service. */
  authority?: AuthorityService
  /** Enforce HMAC envelope signing from the first post-hello message. */
  requireSigned?: boolean
  /** Accept clients built with developer tooling (AP_DEV); the official server leaves this off. */
  allowDev?: boolean
  log?: (msg: string) => void
}

export interface ClientRttSummary {
  id: string | null
  ip: string
  rtt: number
  p50: number
  p95: number
  min: number
  max: number
  jitter: number
  samples: number
  rxBytes: number
  txBytes: number
  rxBps: number
  txBps: number
  movesAccepted: number
  movesRejected: number
}

export interface HubMetrics {
  online: number
  connections: number
  rxBytes: number
  txBytes: number
  rxBps: number
  txBps: number
  rxMsgs: number
  txMsgs: number
  movesAccepted: number
  movesRejected: number
  tickMs: { last: number; p50: number; p95: number; max: number }
  eventLoopLagMs: { p50: number; p95: number; max: number }
  rtt: {
    count: number
    min: number
    p50: number
    p95: number
    max: number
    mean: number
    histogram: { le50: number; le100: number; le150: number; le250: number; gt250: number }
  }
  clients: ClientRttSummary[]
}

export interface Hub {
  readonly authority: AuthorityService
  /** Take ownership of an upgraded socket. */
  attach(ws: WebSocket, ip: string, req?: IncomingMessage): void
  onlineCount(): number
  metrics(): HubMetrics
  /** Stop timers, cancel sessions and close every socket. */
  close(): void
}

type HelloMsg = Extract<ClientMsg, { t: 'hello' }>
type MoveMsg = Extract<ClientMsg, { t: 'move' }>
type TradeMsg = Extract<ClientMsg, { t: `trade.${string}` }>

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return +sorted[idx].toFixed(2)
}

function rateBps(win: { at: number; bytes: number }[], nowMs: number): number {
  const cutoff = nowMs - 1000
  let sum = 0
  for (let i = win.length - 1; i >= 0; i--) {
    if (win[i].at < cutoff) break
    sum += win[i].bytes
  }
  return sum
}

export function createHub(opts: HubOptions): Hub {
  const net = CONTENT.config.net
  const srv = NET.server
  const codes = NET.protocol.closeCodes
  const log = opts.log ?? (() => {})
  const sockets = new Set<Conn>()
  const registry = new Map<string, Player>()
  const byName = new Map<string, Player>()
  const ipCounts = new Map<string, number>()
  const grid = createSpatialIndex<Player>(Math.max(1, PRESENCE.viewRadiusTiles))
  const maxSpeed = Math.max(...Object.values(CONTENT.config.movement).filter(isFiniteNumber))
  const geo = opts.world?.geo ?? null
  const wcfg = srv.world
  /** Global CPU budget for frontier chunks generated only to validate moves. */
  const chunkBudget = createRateLimiter(wcfg.chunkGen)
  const loopDelay = monitorEventLoopDelay({ resolution: 10 })
  loopDelay.enable()
  let seq = 0
  let tickCount = 0
  let totalRxBytes = 0
  let totalTxBytes = 0
  let totalRxMsgs = 0
  let totalTxMsgs = 0
  let totalMovesAccepted = 0
  let totalMovesRejected = 0
  const tickSamples: number[] = []

  function recordConnRtt(c: Conn, sampleMs: number): void {
    if (!Number.isFinite(sampleMs) || sampleMs < 0) return
    const clamped = Math.min(60000, sampleMs)
    const prev = c.rtt
    c.rtt = prev < 0 ? clamped : prev + (clamped - prev) * 0.2
    c.rttSamples.push(clamped)
    if (c.rttSamples.length > srv.rttWindowSize) c.rttSamples.shift()
    if (prev >= 0) {
      c.rttDiffSamples.push(Math.abs(clamped - prev))
      if (c.rttDiffSamples.length > srv.rttWindowSize) c.rttDiffSamples.shift()
    }
  }

  function pingSocket(c: Conn): void {
    if (c.closed || c.ws.readyState !== WebSocket.OPEN) return
    c.pingSentAt = performance.now()
    try { c.ws.ping() } catch { /* socket closing */ }
  }

  // ------------------------------------------------------------------ sending

  function sendRaw(c: Conn, data: string): void {
    if (c.closed || c.ws.readyState !== WebSocket.OPEN) return
    if (c.ws.bufferedAmount > srv.maxBufferedBytes) { drop(c, codes.slowConsumer, 'slow_consumer'); return }
    const bytes = Buffer.byteLength(data, 'utf8')
    const t = Date.now()
    c.txBytes += bytes
    c.txMsgs++
    totalTxBytes += bytes
    totalTxMsgs++
    c.txWindow.push({ at: t, bytes })
    while (c.txWindow.length > 0 && c.txWindow[0].at < t - 2000) c.txWindow.shift()
    c.ws.send(data)
  }

  const errorMsg = (code: string): ServerMsg => ({ t: 'error', code, message: t(`net.error.${code}`) })

  const isBusy = (c: Conn) => c.clientBusy || c.pvpBusy || c.tradeId !== null

  const inRange = (a: Player, b: Player, range: number | null): boolean =>
    range === null || (a.state.map === b.state.map && Math.hypot(a.state.x - b.state.x, a.state.y - b.state.y) <= range)

  const touch = (p: Player) => {
    p.state.busy = isBusy(p)
    p.version = ++seq
  }

  const core: HubCore = {
    send: (c, msg) => sendRaw(c, JSON.stringify(msg)),
    broadcast(to, msg) {
      const data = JSON.stringify(msg)
      for (const c of to) sendRaw(c, data)
    },
    error(c, code) {
      if (c.limits.errors.take()) sendRaw(c, JSON.stringify(errorMsg(code)))
    },
    byId: (id) => registry.get(id),
    find(target) {
      const s = target.trim()
      return registry.get(s) ?? byName.get(s.toLowerCase())
    },
    players: () => registry.values(),
    nearby(c, radius, includeSelf) {
      const near = grid.query(c.state.map, c.state.x, c.state.y, radius)
      return includeSelf ? near : near.filter((o) => o !== c)
    },
    inRange,
    isBusy,
    touch,
  }

  const authority = opts.authority ?? createAuthority({
    dataDir: opts.dataDir ?? NET.store.defaultDir,
    core,
    store: opts.store,
    world: opts.world?.world ?? null,
    log,
  })

  const chat = createChat(core)
  const trades = createTrades({
    core,
    sanitizer: opts.sanitizer,
    recordTrade: (id) => opts.store.recordTrade(id),
    inRange: (a, b) => inRange(a, b, PRESENCE.tradeRangeTiles),
    validateOffer: (player, raw) => authority.validateTradeOffer(player.id, raw, player.ip),
    completeTrade: (aId, aUid, bId, bUid, tradeId) => authority.completeTrade(aId, aUid, bId, bUid, tradeId),
  })
  const dungeons = createDungeonServer({
    core,
    store: opts.store,
    lookupPlayer: (id) => registry.get(id) ?? null,
    log,
  })

  // ------------------------------------------------------------------ pvp

  const host: PvpHost = {
    send(id, msg) { const p = registry.get(id); if (p) core.send(p, msg) },
    getPlayer(id) {
      const p = registry.get(id)
      return p ? { id: p.id, name: p.name, avatar: p.avatar, busy: isBusy(p) } : null
    },
    setBusy(id, busy) {
      const p = registry.get(id)
      if (p && p.pvpBusy !== busy) { p.pvpBusy = busy; touch(p) }
    },
    recordPvp: (w, l) => opts.store.recordPvp(w, l),
    inRange(a, b) {
      const pa = registry.get(a), pb = registry.get(b)
      return !!pa && !!pb && inRange(pa, pb, PRESENCE.pvpRangeTiles)
    },
    resolveParty: (playerId, raw, healParty) => authority.validatePvpParty(playerId, raw, healParty, registry.get(playerId)?.ip),
  }

  let pvp: PvpInstance | null = null
  if (opts.pvp) {
    try { pvp = opts.pvp.createPvp(host) } catch (err) { log(`createPvp() failed, PvP disabled: ${(err as Error).message}`) }
  }

  // ------------------------------------------------------------------ lifecycle

  function makeConn(ws: WebSocket, ip: string, session: SessionInfo | null = null): Conn {
    const limits = {} as Record<LimiterKey, RateLimiter>
    for (const k of Object.keys(srv.rates) as RateKey[]) limits[k] = createRateLimiter(srv.rates[k])
    limits.chat = createRateLimiter(net.chatRate)
    return {
      ws, ip, connectedAt: Date.now(), accountId: session?.accountId ?? null, session,
      key: '', id: null, name: '', avatar: '', state: null, profile: null, version: 0,
      compact: false, nextSlot: 0, lastMoveSeq: 0, ackDirty: false,
      sessionKey: randomBytes(32).toString('hex'),
      signed: true,
      replayWindow: createReplayWindow(),
      clientBusy: false, pvpBusy: false, tradeId: null, emoteUntil: 0, lastMoveAt: 0,
      visible: new Map(), rosterSent: new Map(), lastOnlineCount: 0, snapMap: null,
      mapRef: null, lastOverworld: null, maxDistance: 0, distanceSaved: 0,
      pingSentAt: 0, rtt: -1, rttSamples: [], rttDiffSamples: [],
      rxBytes: 0, txBytes: 0, rxMsgs: 0, txMsgs: 0, rxWindow: [], txWindow: [],
      movesAccepted: 0, movesRejected: 0,
      alive: true, closed: false, limits,
      get map() { return this.state?.map ?? '' },
      get x() { return this.state?.x ?? 0 },
      get y() { return this.state?.y ?? 0 },
    }
  }

  function cleanup(c: Conn, silent: boolean): void {
    if (c.closed) return
    c.closed = true
    sockets.delete(c)
    const n = (ipCounts.get(c.ip) ?? 1) - 1
    if (n <= 0) ipCounts.delete(c.ip)
    else ipCounts.set(c.ip, n)
    if (!c.id || registry.get(c.id) !== c) return
    const p = c as Player
    trades.onDisconnect(p)
    authority.onDisconnect(p.id)
    dungeons.onPlayerLeave(p)
    try { pvp?.onDisconnect(p.id) } catch (err) { log(`pvp.onDisconnect failed: ${(err as Error).message}`) }
    registry.delete(p.id)
    if (byName.get(p.name.toLowerCase()) === p) byName.delete(p.name.toLowerCase())
    grid.remove(p)
    if (Math.floor(p.maxDistance) > p.distanceSaved) opts.store.recordDistance(p.id, p.maxDistance)
    if (p.accountId) {
      const account = opts.store.getAccount(p.accountId)
      if (account && account.status !== 'banned') {
        const sessionStillValid = p.session ? opts.store.getAccountBySession(p.session.token) : null
        if (sessionStillValid) {
          const existingSave = opts.store.getSave(p.accountId)
          if (existingSave) {
            opts.store.putSave(p.accountId, {
              ...existingSave,
              position: { map: p.state.map, x: Math.floor(p.state.x), y: Math.floor(p.state.y), facing: p.state.facing },
            })
          }
        }
      }
    }
    opts.store.touch(p.id)
    if (!silent) chat.system('net.system.leave', { name: p.name })
  }

  /** Close with an optional final error message; state is cleaned up immediately. */
  function drop(c: Conn, code: number, errCode?: string, silent = false): void {
    if (c.closed) return
    if (errCode && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(errorMsg(errCode)))
    cleanup(c, silent)
    try { c.ws.close(code) } catch { /* already closing */ }
    const kill = setTimeout(() => c.ws.terminate(), srv.closeGraceMs)
    kill.unref?.()
  }

  // ------------------------------------------------------------------ presence

  type MapRef = NonNullable<Conn['mapRef']>

  const mapIdOk = (id: unknown): id is string => {
    if (typeof id !== 'string' || id.length === 0 || id.length > srv.profileLimits.idMaxLen) return false
    const base = id.includes('#') ? id.split('#')[0] : id
    return ID_TOKEN_RE.test(base)
  }

  /** Static map, frontier interior (generated on demand) or injected bounds; null = unknown map. */
  function resolveMap(id: string): MapRef | null {
    const baseId = id.includes('#') ? id.split('#')[0] : id
    if (geo) {
      // Frontier interior ids encode their site: never generate one outside the coordinate range.
      const a = geo.anchorOf(baseId)
      if (a && (Math.abs(a.x) > wcfg.maxCoordTiles || Math.abs(a.y) > wcfg.maxCoordTiles)) return null
      const m = geo.map(baseId)
      return m ? { id, map: m, width: m.width, height: m.height, infinite: geo.isInfinite(m) } : null
    }
    const b = opts.world?.maps.get(baseId)
    return b ? { id, map: null, width: b.width, height: b.height, infinite: false } : null
  }

  function inBounds(r: MapRef, x: number, y: number): boolean {
    if (r.infinite) return Math.abs(x) <= wcfg.maxCoordTiles && Math.abs(y) <= wcfg.maxCoordTiles
    const s = srv.boundsSlackTiles
    return x >= -s && y >= -s && x <= r.width - 1 + s && y <= r.height - 1 + s
  }

  /** The resolved map when (map, x, y) is a valid position; `undefined` = valid but no world (free-form ids). */
  function locate(map: unknown, x: unknown, y: unknown, cached: MapRef | null): MapRef | null | undefined {
    if (!mapIdOk(map) || !isFiniteNumber(x) || !isFiniteNumber(y)) return null
    if (!opts.world) return undefined
    const r = cached && cached.id === map ? cached : resolveMap(map)
    return r && inBounds(r, x, y) ? r : null
  }

  /** Frontier interiors are entered from their site: reject ids whose site is far from the last overworld spot. */
  function interiorReachable(p: Player, mapId: string): boolean {
    const a = geo?.anchorOf(mapId)
    if (!a) return true
    return !p.lastOverworld || Math.hypot(a.x - p.lastOverworld.x, a.y - p.lastOverworld.y) <= wcfg.interiorReachTiles
  }

  /** Can the player walk from (x0,y0) to (x1,y1) within `allowed` tiles on its current map (tile step rules)? */
  function walkable(r: MapRef | null, x0: number, y0: number, x1: number, y1: number, allowed: number, now: number): boolean {
    if (!geo || !r?.map) return true
    const fx = Math.floor(x0), fy = Math.floor(y0), tx = Math.floor(x1), ty = Math.floor(y1)
    if (fx === tx && fy === ty) return true
    const lim = { maxSteps: Math.ceil(allowed) + 1, margin: wcfg.pathMarginTiles, maxNodes: wcfg.pathMaxNodes }
    if (r.infinite) {
      const m = lim.margin + 1
      const need = geo.missingChunks(r.map, Math.min(fx, tx) - m, Math.min(fy, ty) - m, Math.max(fx, tx) + m, Math.max(fy, ty) + m)
      // Out of generation budget (many players spread over the frontier): fall back to the speed check alone.
      if (need > 0 && !chunkBudget.take(now, need)) return true
    }
    return geo.reachable(r.map, fx, fy, tx, ty, lim)
  }

  /**
   * Only walks extend the distance record, only when they start within the known range (record + slack), and
   * never faster than the top movement speed over the elapsed time (message spam / per-move tolerance and
   * teleports earn nothing).
   */
  function creditDistance(p: Player, fromX: number, fromY: number, dt: number): void {
    if (!geo) return
    if (geo.distance(fromX, fromY) > p.maxDistance + wcfg.distanceSlackTiles) return
    const next = Math.min(geo.distance(p.state.x, p.state.y), p.maxDistance + maxSpeed * srv.moveSpeedSlack * dt)
    if (next <= p.maxDistance) return
    p.maxDistance = next
    if (next - p.distanceSaved >= wcfg.distanceStepTiles) {
      p.distanceSaved = Math.floor(next)
      opts.store.recordDistance(p.id, p.distanceSaved)
    }
  }

  function initialPosition(m: HelloMsg): { pos: Pick<PlayerState, 'map' | 'x' | 'y' | 'facing'>; ref: MapRef | null } {
    const facing = isDir(m.facing) ? m.facing : srv.defaultFacing
    const r = locate(m.map, m.x, m.y, null)
    if (r !== null) return { pos: { map: m.map, x: m.x, y: m.y, facing }, ref: r ?? null }
    if (opts.world) {
      const start = opts.world.maps.get(opts.world.startMap)!
      return {
        pos: { map: opts.world.startMap, x: start.spawn.x, y: start.spawn.y, facing: start.spawn.facing },
        ref: resolveMap(opts.world.startMap),
      }
    }
    return { pos: { map: mapIdOk(m.map) ? m.map : '', x: 0, y: 0, facing }, ref: null }
  }

  function rosterEntries(): Extract<ServerMsg, { t: 'online' }>['players'] {
    const players: Extract<ServerMsg, { t: 'online' }>['players'] = []
    for (const p of registry.values()) {
      if (players.length >= srv.onlineListMax) break
      players.push({ id: p.id, name: p.name, map: p.state.map, avatar: p.avatar, busy: p.state.busy })
    }
    return players
  }

  const rosterFp = (e: { name: string; map: string; avatar: string; busy: boolean }): string =>
    `${e.name}\0${e.map}\0${e.avatar}\0${e.busy ? 1 : 0}`

  function sendOnlineSummary(c: Conn, entries = rosterEntries(), allowDelta = false): void {
    const count = registry.size
    if (!allowDelta || !c.compact || c.rosterSent.size === 0) {
      c.rosterSent.clear()
      for (const e of entries) c.rosterSent.set(e.id, rosterFp(e))
      c.lastOnlineCount = count
      core.send(c, { t: 'online', count, players: entries })
      return
    }
    const changed: Extract<ServerMsg, { t: 'online' }>['players'] = []
    const present = new Set<string>()
    for (const e of entries) {
      present.add(e.id)
      const fp = rosterFp(e)
      if (c.rosterSent.get(e.id) !== fp) {
        c.rosterSent.set(e.id, fp)
        changed.push(e)
      }
    }
    const left: string[] = []
    for (const id of [...c.rosterSent.keys()]) {
      if (!present.has(id)) {
        c.rosterSent.delete(id)
        left.push(id)
      }
    }
    if (changed.length === 0 && left.length === 0 && c.lastOnlineCount === count) return
    c.lastOnlineCount = count
    core.send(c, { t: 'online', count, players: changed, delta: true, ...(left.length > 0 ? { left } : {}) })
  }

  function broadcastOnlineSummaries(): void {
    if (registry.size === 0) return
    const entries = rosterEntries()
    for (const p of registry.values()) sendOnlineSummary(p, entries, true)
  }
  function hello(c: Conn, m: HelloMsg): void {
    if (m.v !== net.protocolVersion) { drop(c, codes.version, 'version_mismatch'); return }
    if (m.build?.devtools === true && !opts.allowDev) { drop(c, codes.devNotAllowed, 'dev_not_allowed'); return }
    if (m.signed === true) c.signed = true

    let id: string
    let boundSave: ReturnType<ProfileStore['getAccountSave']> = null
    if (c.session) {
      const liveSession = opts.store.getAccountBySession(c.session.token)
      if (!liveSession) {
        drop(c, codes.shutdown, 'unauthorized')
        return
      }
      c.session = liveSession
      c.accountId = liveSession.accountId
      id = liveSession.accountId
      boundSave = opts.store.getAccountSave(id)
    } else {
      const rawSecret = isUuidLike(m.playerId) ? m.playerId : newSecretId()
      const candidateId = publicIdFor(rawSecret)
      // Never allow an unauthenticated connection to claim a registered account id.
      id = opts.store.getAccount(candidateId) ? publicIdFor(newSecretId()) : candidateId
    }
    const prev = registry.get(id)
    if (prev) drop(prev, codes.duplicate, 'kicked_duplicate', true)

    const tag = id.replace(/-/g, '').slice(0, MODERATION.name.tagLength).toUpperCase()
    const rawName = boundSave?.save ? boundSave.save.name : (c.session?.username ?? m.name)
    const base = sanitizeName(rawName) ?? fallbackName(tag)
    const name = uniqueName(base, (n) => byName.has(n.toLowerCase()), (i) => (i === 0 ? tag : `${tag}${i}`))
    const avatar = sanitizeAvatar(boundSave?.save ? boundSave.save.avatar : m.avatar)
    const profileInput = boundSave?.save
      ? {
        ...m.profile,
        badges: boundSave.trusted ? boundSave.save.badges : [],
        dexCaught: boundSave.trusted ? boundSave.save.dexCaught.length : 0,
        party: boundSave.save.party.slice(0, CONTENT.config.party.maxParty).map((c) => toView(c, CONTENT)),
        playTimeSec: boundSave.save.playTimeSec,
      }
      : m.profile
    const profile = sanitizeProfile(profileInput, { id, name, avatar }, opts.world?.badgeIds ?? null)
    const helloPosMsg: HelloMsg = boundSave?.save
      ? { ...m, map: boundSave.save.position.map, x: boundSave.save.position.x, y: boundSave.save.position.y, facing: boundSave.save.position.facing }
      : m
    const { pos, ref } = initialPosition(helloPosMsg)
    const now = Date.now()

    c.id = id
    c.key = id
    c.name = name
    c.avatar = avatar
    c.profile = profile
    c.compact = m.compact === true
    c.state = {
      id, name, avatar, ...pos, moving: false, running: false, lead: sanitizeLead(m.lead),
      badges: rawProfile.badges.length, dexCaught: rawProfile.dexCaught, busy: false,
    }
    c.lastMoveAt = now
    c.mapRef = ref
    c.lastOverworld = geo && pos.map === geo.overworldId ? { x: pos.x, y: pos.y } : null
    const p = c as Player
    registry.set(id, p)
    byName.set(name.toLowerCase(), p)
    grid.upsert(p)
    touch(p)
    const validatedProfile = authority.validateProfileReport(p, profile)
    p.profile = validatedProfile
    p.state.badges = validatedProfile.badges.length
    p.state.dexCaught = validatedProfile.dexCaught
    opts.store.put(validatedProfile, now)
    p.maxDistance = p.distanceSaved = opts.store.get(id)?.maxDistance ?? 0
    const saveRec = authority.getRecord(id)
    core.send(p, {
      t: 'welcome',
      selfId: id,
      serverTime: now,
      motd: t('net.motd'),
      online: registry.size,
      sessionKey: c.sessionKey,
      authority: true,
      ...(saveRec ? { save: saveRec.save, saveRev: saveRec.rev, untrustedImport: saveRec.imported } : {}),
    })
    sendOnlineSummary(p)
    pingSocket(p)
    if (!prev) chat.system('net.system.join', { name })
    syncInterest(p)
  }

  /**
   * Same-map moves are walks when within the speed budget and (with world rules) reachable by tile steps;
   * anything else — map changes (doors, warps), fly, respawn, desyncs, client-only world changes such as opened
   * gates — spends the jump budget. Map changes spend it before any map is resolved or generated.
   */
  function move(p: Player, rawMsg: MoveMsg): void {
    const now = Date.now()
    if (!p.limits.move.take(now)) return
    const st = p.state
    const m = decodeMoveFrame(rawMsg as unknown as Record<string, unknown>, st.map)
    if (!m || typeof m.map !== 'string' || !isFiniteNumber(m.x) || !isFiniteNumber(m.y) || !isDir(m.facing)) {
      core.error(p, 'bad_message')
      return
    }
    if (m.seq !== undefined) {
      p.lastMoveSeq = Math.max(p.lastMoveSeq, m.seq)
      p.ackDirty = true
    }
    const reject = (reason: string): void => {
      p.movesRejected++
      totalMovesRejected++
      if (m.seq !== undefined && p.limits.errors.take(now)) {
        p.ackDirty = false
        core.send(p, { t: 'move.correct', seq: m.seq, map: st.map, x: st.x, y: st.y, facing: st.facing, reason })
      }
    }
    let ref: MapRef | null | undefined
    let walked = false
    let dt = 0
    if (m.map !== st.map) {
      if (!mapIdOk(m.map) || !p.limits.jump.take(now)) { reject('jump_budget'); return }
      if (!interiorReachable(p, m.map)) { reject('interior_unreachable'); return }
      ref = locate(m.map, m.x, m.y, null)
      if (ref === null) { reject('out_of_bounds'); return }
    } else {
      ref = locate(m.map, m.x, m.y, p.mapRef)
      if (ref === null) { reject('out_of_bounds'); return }
      dt = Math.min(srv.moveMaxDtSeconds, Math.max(0, now - p.lastMoveAt) / 1000)
      const allowed = maxSpeed * srv.moveSpeedSlack * dt + srv.moveToleranceTiles
      walked = Math.hypot(m.x - st.x, m.y - st.y) <= allowed && walkable(ref ?? null, st.x, st.y, m.x, m.y, allowed, now)
      if (!walked && !p.limits.jump.take(now)) {
        authority.audit(p.id, 'movement.jump_budget_exhausted', { map: m.map, x: m.x, y: m.y, fromX: st.x, fromY: st.y }, 2, p.ip)
        reject('blocked_or_speed')
        return
      }
    }
    p.movesAccepted++
    totalMovesAccepted++
    const fromX = st.x, fromY = st.y
    st.map = m.map
    st.x = m.x
    st.y = m.y
    st.facing = m.facing
    st.moving = m.moving === true
    st.running = m.running === true
    p.lastMoveAt = now
    p.mapRef = ref ?? null
    if (walked && Math.hypot(m.x - fromX, m.y - fromY) >= 0.25) authority.noteStep(p.id, p.ip)
    if (geo && st.map === geo.overworldId) {
      p.lastOverworld = { x: st.x, y: st.y }
      if (walked) creditDistance(p, fromX, fromY, dt)
    }
    grid.upsert(p)
    touch(p)
  }

  function inspect(p: Player, target: unknown): void {
    if (!p.limits.inspect.take()) { core.error(p, 'rate_limited'); return }
    if (typeof target !== 'string' || !target) { core.error(p, 'bad_message'); return }
    const online = core.find(target)
    const profile = online
      ? opts.store.publicProfile(online.id) ?? online.profile
      : opts.store.publicProfile(target.trim())
    if (!profile) { core.error(p, 'not_found'); return }
    core.send(p, { t: 'profile', profile })
  }

  // ------------------------------------------------------------------ interest management

  function syncInterest(c: Player): void {
    const st = c.state
    const r = PRESENCE.viewRadiusTiles
    const nearR2 = srv.nearRadiusTiles * srv.nearRadiusTiles
    const d2 = (o: Player) => (o.state.x - st.x) ** 2 + (o.state.y - st.y) ** 2
    // Players enter at viewRadius and leave beyond viewRadius + leaveMargin (no flapping at the edge).
    let near = grid.query(st.map, st.x, st.y, r + PRESENCE.leaveMarginTiles)
      .filter((o) => o !== c && (c.visible.has(o.id) || d2(o) <= r * r))
    if (near.length > srv.snapshotMaxPlayers) {
      near = near.sort((a, b) => d2(a) - d2(b)).slice(0, srv.snapshotMaxPlayers)
    }
    const mapChanged = c.snapMap !== st.map
    if (mapChanged) c.visible.clear()
    const next = new Set(near.map((o) => o.id))
    for (const id of [...c.visible.keys()]) {
      if (next.has(id)) continue
      c.visible.delete(id)
      core.send(c, { t: 'leave', id })
    }

    const fullPlayers: PlayerState[] = []
    const deltas: CompactPlayerTuple[] = []

    for (const o of near) {
      const vis = c.visible.get(o.id)
      const sk = staticStateKey(o.state)
      if (!vis) {
        const slot = ++c.nextSlot
        c.visible.set(o.id, { version: o.version, slot, staticKey: sk, lastSentTick: tickCount })
        if (c.compact) {
          core.send(c, { t: 'join', player: o.state, s: slot })
        } else {
          core.send(c, { t: 'join', player: o.state })
          fullPlayers.push(o.state)
        }
        continue
      }
      if (vis.version === o.version) continue
      if (
        c.compact &&
        sk === vis.staticKey &&
        o.state.moving &&
        d2(o) > nearR2 &&
        tickCount - vis.lastSentTick < srv.farStrideTicks
      ) {
        continue
      }
      vis.version = o.version
      vis.lastSentTick = tickCount
      if (c.compact && sk === vis.staticKey) {
        deltas.push(encodePlayerDelta(vis.slot, o.state))
      } else {
        vis.staticKey = sk
        fullPlayers.push(o.state)
      }
    }

    if (!mapChanged && fullPlayers.length === 0 && deltas.length === 0) return
    if (c.ws.bufferedAmount > srv.skipSnapshotAboveBytes) { c.snapMap = null; return }
    const ack = c.ackDirty && c.lastMoveSeq > 0 ? c.lastMoveSeq : undefined
    c.ackDirty = false
    core.send(c, {
      t: 'snapshot',
      map: st.map,
      players: fullPlayers,
      ...(deltas.length > 0 ? { d: deltas } : {}),
      at: Date.now(),
      ...(ack !== undefined ? { ack } : {}),
    })
    c.snapMap = st.map
  }

  function tick(): void {
    const t0 = performance.now()
    tickCount++
    const now = Date.now()
    for (const p of registry.values()) {
      if (p.state.emote !== undefined && now >= p.emoteUntil) { delete p.state.emote; touch(p) }
    }
    for (const p of registry.values()) syncInterest(p)
    const elapsed = +(performance.now() - t0).toFixed(3)
    tickSamples.push(elapsed)
    if (tickSamples.length > srv.rttWindowSize) tickSamples.shift()
  }

  /** Keep only overworld chunks near online players (and the doors of players inside interiors). */
  function retainChunks(): void {
    if (!geo) return
    const points: { x: number; y: number }[] = []
    for (const p of registry.values()) {
      if (p.state.map === geo.overworldId) points.push({ x: p.state.x, y: p.state.y })
      else if (p.lastOverworld) points.push(p.lastOverworld)
    }
    try { geo.retain(points, wcfg.retainRadiusTiles) } catch (err) { log(`chunk retain failed: ${(err as Error).message}`) }
  }

  function heartbeat(): void {
    for (const c of [...sockets]) {
      if (!c.alive) { cleanup(c, false); c.ws.terminate(); continue }
      c.alive = false
      pingSocket(c)
    }
  }

  // ------------------------------------------------------------------ dispatch

  function dispatch(c: Conn, msg: ClientMsg): void {
    if (msg.t === 'ping') {
      if (isFiniteNumber(msg.rtt) && msg.rtt >= 0) recordConnRtt(c, msg.rtt)
      if (c.pingSentAt === 0) pingSocket(c)
      if (isFiniteNumber(msg.at)) {
        const ack = c.lastMoveSeq > 0 ? c.lastMoveSeq : undefined
        c.ackDirty = false
        core.send(c, { t: 'pong', at: msg.at, serverTime: Date.now(), ...(ack !== undefined ? { ack } : {}) })
      }
      return
    }
    if (msg.t === 'hello') {
      if (c.id) core.error(c, 'bad_message')
      else hello(c, msg)
      return
    }
    if (!c.id || !c.state) { core.error(c, 'not_ready'); return }
    const p = c as Player
    switch (msg.t) {
      case 'move': move(p, msg); return
      case 'lead':
        if (!p.limits.profile.take()) { core.error(p, 'rate_limited'); return }
        p.state.lead = sanitizeLead(msg.lead)
        touch(p)
        return
      case 'profile': {
        if (!p.limits.profile.take()) { core.error(p, 'rate_limited'); return }
        const sanitized = sanitizeProfile(msg.profile, p, opts.world?.badgeIds ?? null)
        const profile = authority.validateProfileReport(p, sanitized)
        p.profile = profile
        p.state.badges = profile.badges.length
        p.state.dexCaught = profile.dexCaught
        opts.store.put(profile)
        touch(p)
        return
      }
      case 'busy':
        if (typeof msg.busy !== 'boolean') { core.error(p, 'bad_message'); return }
        if (p.clientBusy !== msg.busy) { p.clientBusy = msg.busy; touch(p) }
        return
      case 'chat': chat.handleChat(p, msg); return
      case 'emote': chat.handleEmote(p, msg); return
      case 'inspect': inspect(p, msg.target); return
      case 'leaderboard':
        if (!p.limits.leaderboard.take()) { core.error(p, 'rate_limited'); return }
        core.send(p, { t: 'leaderboard', entries: opts.store.leaderboard() })
        return
    }
    const kind: string = msg.t
    if (kind.startsWith('trade.')) { trades.handle(p, msg as TradeMsg); return }
    if (kind.startsWith('pvp.')) {
      if (!pvp) { core.error(p, 'pvp_unavailable'); return }
      if (!p.limits.pvp.take()) { core.error(p, 'rate_limited'); return }
      try { pvp.handle(p.id, msg) } catch (err) { log(`pvp.handle failed: ${(err as Error).message}`); core.error(p, 'bad_message') }
      return
    }
    if (authority.handle(p, msg)) return
    if (kind.startsWith('party.') || kind.startsWith('dungeon.') || kind.startsWith('raid.')) {
      dungeons.handle(p, msg as CoopClientMsg)
      return
    }
    core.error(p, 'bad_message')
  }

  function onRaw(c: Conn, data: RawData, isBinary: boolean): void {
    if (c.closed) return
    if (!c.limits.messageKick.take()) { drop(c, codes.flood, 'flood'); return }
    if (!c.limits.message.take()) return
    if (isBinary) { core.error(c, 'bad_message'); return }
    const rawStr = rawToString(data)
    const bytes = Buffer.byteLength(rawStr, 'utf8')
    const nowMs = Date.now()
    c.rxBytes += bytes
    c.rxMsgs++
    totalRxBytes += bytes
    totalRxMsgs++
    c.rxWindow.push({ at: nowMs, bytes })
    while (c.rxWindow.length > 0 && c.rxWindow[0].at < nowMs - 2000) c.rxWindow.shift()
    const msg = safeJsonParse(rawStr)
    if (!isRecord(msg) || typeof msg.t !== 'string') { core.error(c, 'bad_message'); return }
    if (msg.sig !== undefined) c.signed = true
    const envCheck = verifyEnvelope(c.sessionKey, msg, c.replayWindow, { requireSig: c.signed })
    if (!envCheck.ok) {
      authority.audit(c.id, `protocol.${envCheck.code}`, { reason: envCheck.reason, t: msg.t, authSeq: msg.authSeq, seq: msg.seq }, 3, c.ip)
      core.error(c, envCheck.code)
      return
    }
    try {
      dispatch(c, msg as unknown as ClientMsg)
    } catch (err) {
      log(`handler for "${msg.t}" failed: ${(err as Error).stack ?? err}`)
      core.error(c, 'bad_message')
    }
  }

  // ------------------------------------------------------------------ timers

  const timers = [
    setInterval(tick, 1000 / net.tickHz),
    setInterval(broadcastOnlineSummaries, srv.onlineSummarySeconds * 1000),
    setInterval(heartbeat, srv.heartbeatSeconds * 1000),
    setInterval(() => trades.sweep(), srv.sweepSeconds * 1000),
    setInterval(retainChunks, wcfg.retainSeconds * 1000),
  ]

  opts.store.onSessionRevoked?.((revokedAccountId) => {
    for (const c of [...sockets]) {
      if (c.accountId === revokedAccountId) {
        drop(c, codes.shutdown, 'unauthorized', false)
      }
    }
  })

  return {
    authority,
    attach(ws, ip, req) {
      if (sockets.size >= srv.maxClients || (ipCounts.get(ip) ?? 0) >= srv.maxClientsPerIp) {
        ws.send(JSON.stringify(errorMsg('server_full')))
        ws.close(codes.serverFull)
        return
      }
      if (req && !checkOriginCsrf(req)) {
        opts.store.audit({ ip, kind: 'ws.csrf_blocked', severity: 2, detail: {} })
        ws.send(JSON.stringify(errorMsg('unauthorized')))
        ws.close(codes.shutdown)
        return
      }
      const cookieHeader = req?.headers.cookie
      const token = parseSessionCookie(cookieHeader)
      let session: SessionInfo | null = null
      if (token) {
        session = opts.store.getAccountBySession(token)
        if (!session) {
          opts.store.audit({ ip, kind: 'ws.unauthorized_session', severity: 1, detail: {} })
          ws.send(JSON.stringify(errorMsg('unauthorized')))
          ws.close(codes.shutdown)
          return
        }
      }
      const c = makeConn(ws, ip, session)
      sockets.add(c)
      ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1)
      const helloTimer = setTimeout(() => { if (!c.id) drop(c, codes.helloTimeout, 'hello_timeout') }, srv.helloTimeoutSeconds * 1000)
      ws.on('pong', () => {
        c.alive = true
        if (c.pingSentAt > 0) {
          const sample = Math.max(0, performance.now() - c.pingSentAt)
          c.pingSentAt = 0
          recordConnRtt(c, sample)
        }
      })
      ws.on('message', (data, isBinary) => { c.alive = true; onRaw(c, data, isBinary) })
      ws.on('close', () => { clearTimeout(helloTimer); cleanup(c, false) })
      ws.on('error', (err) => log(`socket error (${c.ip}): ${err.message}`))
    },
    onlineCount: () => registry.size,
    metrics(): HubMetrics {
      const nowMs = Date.now()
      const clients: ClientRttSummary[] = []
      const allRtts: number[] = []
      const hist = { le50: 0, le100: 0, le150: 0, le250: 0, gt250: 0 }
      let rxBps = 0
      let txBps = 0
      for (const c of sockets) {
        const cRxBps = rateBps(c.rxWindow, nowMs)
        const cTxBps = rateBps(c.txWindow, nowMs)
        rxBps += cRxBps
        txBps += cTxBps
        const samples = c.rttSamples
        const p50 = samples.length ? percentile(samples, 0.5) : -1
        const p95 = samples.length ? percentile(samples, 0.95) : -1
        const min = samples.length ? +Math.min(...samples).toFixed(2) : -1
        const max = samples.length ? +Math.max(...samples).toFixed(2) : -1
        const jitter = c.rttDiffSamples.length ? percentile(c.rttDiffSamples, 0.95) : 0
        if (c.rtt >= 0) {
          allRtts.push(c.rtt)
          if (c.rtt <= 50) hist.le50++
          else if (c.rtt <= 100) hist.le100++
          else if (c.rtt <= 150) hist.le150++
          else if (c.rtt <= 250) hist.le250++
          else hist.gt250++
        }
        clients.push({
          id: c.id,
          ip: c.ip,
          rtt: c.rtt >= 0 ? +c.rtt.toFixed(2) : -1,
          p50,
          p95,
          min,
          max,
          jitter,
          samples: samples.length,
          rxBytes: c.rxBytes,
          txBytes: c.txBytes,
          rxBps: cRxBps,
          txBps: cTxBps,
          movesAccepted: c.movesAccepted,
          movesRejected: c.movesRejected,
        })
      }
      const rttMean = allRtts.length > 0 ? +(allRtts.reduce((a, b) => a + b, 0) / allRtts.length).toFixed(2) : -1
      return {
        online: registry.size,
        connections: sockets.size,
        rxBytes: totalRxBytes,
        txBytes: totalTxBytes,
        rxBps,
        txBps,
        rxMsgs: totalRxMsgs,
        txMsgs: totalTxMsgs,
        movesAccepted: totalMovesAccepted,
        movesRejected: totalMovesRejected,
        tickMs: {
          last: tickSamples[tickSamples.length - 1] ?? 0,
          p50: percentile(tickSamples, 0.5),
          p95: percentile(tickSamples, 0.95),
          max: tickSamples.length ? +Math.max(...tickSamples).toFixed(2) : 0,
        },
        eventLoopLagMs: {
          p50: +(loopDelay.percentile(50) / 1e6).toFixed(2),
          p95: +(loopDelay.percentile(95) / 1e6).toFixed(2),
          max: +(loopDelay.max / 1e6).toFixed(2),
        },
        rtt: {
          count: allRtts.length,
          min: allRtts.length ? +Math.min(...allRtts).toFixed(2) : -1,
          p50: allRtts.length ? percentile(allRtts, 0.5) : -1,
          p95: allRtts.length ? percentile(allRtts, 0.95) : -1,
          max: allRtts.length ? +Math.max(...allRtts).toFixed(2) : -1,
          mean: rttMean,
          histogram: hist,
        },
        clients,
      }
    },
    close() {
      loopDelay.disable()
      for (const tm of timers) clearInterval(tm)
      trades.close()
      dungeons.close()
      try { pvp?.dispose?.() } catch (err) { log(`pvp.dispose failed: ${(err as Error).message}`) }
      for (const c of [...sockets]) drop(c, codes.shutdown, undefined, true)
    },
  }
}
