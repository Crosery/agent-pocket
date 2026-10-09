// Connection hub: hello/presence, per-map interest management (distance + hysteresis), movement validation
// (bounds, speed, and on the generated world tile steps incl. the infinite overworld, frontier interiors and
// one-way ledges), proximity for trade / pvp, server-observed distance records, chunk-cache trimming around
// online players, inspect, leaderboard, heartbeat, and routing to chat / trade / pvp.
import { WebSocket, type RawData } from 'ws'
import type { ClientMsg, PlayerState, ServerMsg } from '../shared/protocol.ts'
import { CONTENT, t } from '../shared/content/index.ts'
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
  /** Accept clients built with developer tooling (AP_DEV); the official server leaves this off. */
  allowDev?: boolean
  log?: (msg: string) => void
}

export interface Hub {
  /** Take ownership of an upgraded socket. */
  attach(ws: WebSocket, ip: string): void
  onlineCount(): number
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
  let seq = 0

  // ------------------------------------------------------------------ sending

  function sendRaw(c: Conn, data: string): void {
    if (c.closed || c.ws.readyState !== WebSocket.OPEN) return
    if (c.ws.bufferedAmount > srv.maxBufferedBytes) { drop(c, codes.slowConsumer, 'slow_consumer'); return }
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

  const chat = createChat(core)
  const trades = createTrades({
    core, sanitizer: opts.sanitizer, recordTrade: (id) => opts.store.recordTrade(id),
    inRange: (a, b) => inRange(a, b, PRESENCE.tradeRangeTiles),
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
  }

  let pvp: PvpInstance | null = null
  if (opts.pvp) {
    try { pvp = opts.pvp.createPvp(host) } catch (err) { log(`createPvp() failed, PvP disabled: ${(err as Error).message}`) }
  }

  // ------------------------------------------------------------------ lifecycle

  function makeConn(ws: WebSocket, ip: string): Conn {
    const limits = {} as Record<LimiterKey, RateLimiter>
    for (const k of Object.keys(srv.rates) as RateKey[]) limits[k] = createRateLimiter(srv.rates[k])
    limits.chat = createRateLimiter(net.chatRate)
    return {
      ws, ip, connectedAt: Date.now(), key: '', id: null, name: '', avatar: '', state: null, profile: null, version: 0,
      clientBusy: false, pvpBusy: false, tradeId: null, emoteUntil: 0, lastMoveAt: 0, visible: new Map(), snapMap: null,
      mapRef: null, lastOverworld: null, maxDistance: 0, distanceSaved: 0,
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
    try { pvp?.onDisconnect(p.id) } catch (err) { log(`pvp.onDisconnect failed: ${(err as Error).message}`) }
    registry.delete(p.id)
    if (byName.get(p.name.toLowerCase()) === p) byName.delete(p.name.toLowerCase())
    grid.remove(p)
    if (Math.floor(p.maxDistance) > p.distanceSaved) opts.store.recordDistance(p.id, p.maxDistance)
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

  const mapIdOk = (id: unknown): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= srv.profileLimits.idMaxLen && ID_TOKEN_RE.test(id)

  /** Static map, frontier interior (generated on demand) or injected bounds; null = unknown map. */
  function resolveMap(id: string): MapRef | null {
    if (geo) {
      // Frontier interior ids encode their site: never generate one outside the coordinate range.
      const a = geo.anchorOf(id)
      if (a && (Math.abs(a.x) > wcfg.maxCoordTiles || Math.abs(a.y) > wcfg.maxCoordTiles)) return null
      const m = geo.map(id)
      return m ? { id, map: m, width: m.width, height: m.height, infinite: geo.isInfinite(m) } : null
    }
    const b = opts.world?.maps.get(id)
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

  function onlineSummary(): ServerMsg {
    const players: Extract<ServerMsg, { t: 'online' }>['players'] = []
    for (const p of registry.values()) {
      if (players.length >= srv.onlineListMax) break
      players.push({ id: p.id, name: p.name, map: p.state.map, avatar: p.avatar, busy: p.state.busy })
    }
    return { t: 'online', count: registry.size, players }
  }

  function hello(c: Conn, m: HelloMsg): void {
    if (m.v !== net.protocolVersion) { drop(c, codes.version, 'version_mismatch'); return }
    if (m.build?.devtools === true && !opts.allowDev) { drop(c, codes.devNotAllowed, 'dev_not_allowed'); return }
    const secret = isUuidLike(m.playerId) ? m.playerId : newSecretId()
    const id = publicIdFor(secret)
    const prev = registry.get(id)
    if (prev) drop(prev, codes.duplicate, 'kicked_duplicate', true)

    const tag = id.replace(/-/g, '').slice(0, MODERATION.name.tagLength).toUpperCase()
    const base = sanitizeName(m.name) ?? fallbackName(tag)
    const name = uniqueName(base, (n) => byName.has(n.toLowerCase()), (i) => (i === 0 ? tag : `${tag}${i}`))
    const avatar = sanitizeAvatar(m.avatar)
    const profile = sanitizeProfile(m.profile, { id, name, avatar }, opts.world?.badgeIds ?? null)
    const { pos, ref } = initialPosition(m)
    const now = Date.now()

    c.id = id
    c.key = id
    c.name = name
    c.avatar = avatar
    c.profile = profile
    c.state = {
      id, name, avatar, ...pos, moving: false, running: false, lead: sanitizeLead(m.lead),
      badges: profile.badges.length, dexCaught: profile.dexCaught, busy: false,
    }
    c.lastMoveAt = now
    c.mapRef = ref
    c.lastOverworld = geo && pos.map === geo.overworldId ? { x: pos.x, y: pos.y } : null
    const p = c as Player
    registry.set(id, p)
    byName.set(name.toLowerCase(), p)
    grid.upsert(p)
    touch(p)
    opts.store.put(profile, now)
    p.maxDistance = p.distanceSaved = opts.store.get(id)?.maxDistance ?? 0

    core.send(p, { t: 'welcome', selfId: id, serverTime: now, motd: t('net.motd'), online: registry.size })
    core.send(p, onlineSummary())
    if (!prev) chat.system('net.system.join', { name })
    syncInterest(p)
  }

  /**
   * Same-map moves are walks when within the speed budget and (with world rules) reachable by tile steps;
   * anything else — map changes (doors, warps), fly, respawn, desyncs, client-only world changes such as opened
   * gates — spends the jump budget. Map changes spend it before any map is resolved or generated.
   */
  function move(p: Player, m: MoveMsg): void {
    const now = Date.now()
    if (!p.limits.move.take(now)) return
    if (typeof m.map !== 'string' || !isFiniteNumber(m.x) || !isFiniteNumber(m.y) || !isDir(m.facing)) { core.error(p, 'bad_message'); return }
    const st = p.state
    let ref: MapRef | null | undefined
    let walked = false
    let dt = 0
    if (m.map !== st.map) {
      if (!mapIdOk(m.map) || !p.limits.jump.take(now)) return
      if (!interiorReachable(p, m.map)) return
      ref = locate(m.map, m.x, m.y, null)
      if (ref === null) return
    } else {
      ref = locate(m.map, m.x, m.y, p.mapRef)
      if (ref === null) return
      dt = Math.min(srv.moveMaxDtSeconds, Math.max(0, now - p.lastMoveAt) / 1000)
      const allowed = maxSpeed * srv.moveSpeedSlack * dt + srv.moveToleranceTiles
      walked = Math.hypot(m.x - st.x, m.y - st.y) <= allowed && walkable(ref ?? null, st.x, st.y, m.x, m.y, allowed, now)
      if (!walked && !p.limits.jump.take(now)) return
    }
    const fromX = st.x, fromY = st.y
    st.map = m.map
    st.x = m.x
    st.y = m.y
    st.facing = m.facing
    st.moving = m.moving === true
    st.running = m.running === true
    p.lastMoveAt = now
    p.mapRef = ref ?? null
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
    const d2 = (o: Player) => (o.state.x - st.x) ** 2 + (o.state.y - st.y) ** 2
    // Players enter at viewRadius and leave beyond viewRadius + leaveMargin (no flapping at the edge).
    let near = grid.query(st.map, st.x, st.y, r + PRESENCE.leaveMarginTiles)
      .filter((o) => o !== c && (c.visible.has(o.id) || d2(o) <= r * r))
    if (near.length > srv.snapshotMaxPlayers) {
      near = near.sort((a, b) => d2(a) - d2(b)).slice(0, srv.snapshotMaxPlayers)
    }
    let changed = c.snapMap !== st.map
    const next = new Set(near.map((o) => o.id))
    for (const id of [...c.visible.keys()]) {
      if (next.has(id)) continue
      c.visible.delete(id)
      core.send(c, { t: 'leave', id })
      changed = true
    }
    for (const o of near) {
      const v = c.visible.get(o.id)
      if (v === undefined) { core.send(c, { t: 'join', player: o.state }); changed = true }
      else if (v !== o.version) changed = true
      c.visible.set(o.id, o.version)
    }
    if (!changed) return
    if (c.ws.bufferedAmount > srv.skipSnapshotAboveBytes) { c.snapMap = null; return }
    core.send(c, { t: 'snapshot', map: st.map, players: near.map((o) => o.state) })
    c.snapMap = st.map
  }

  function tick(): void {
    const now = Date.now()
    for (const p of registry.values()) {
      if (p.state.emote !== undefined && now >= p.emoteUntil) { delete p.state.emote; touch(p) }
    }
    for (const p of registry.values()) syncInterest(p)
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
      try { c.ws.ping() } catch { /* socket closing */ }
    }
  }

  // ------------------------------------------------------------------ dispatch

  function dispatch(c: Conn, msg: ClientMsg): void {
    if (msg.t === 'ping') {
      if (isFiniteNumber(msg.at)) core.send(c, { t: 'pong', at: msg.at, serverTime: Date.now() })
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
        const profile = sanitizeProfile(msg.profile, p, opts.world?.badgeIds ?? null)
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
    core.error(p, 'bad_message')
  }

  function onRaw(c: Conn, data: RawData, isBinary: boolean): void {
    if (c.closed) return
    if (!c.limits.messageKick.take()) { drop(c, codes.flood, 'flood'); return }
    if (!c.limits.message.take()) return
    if (isBinary) { core.error(c, 'bad_message'); return }
    const msg = safeJsonParse(rawToString(data))
    if (!isRecord(msg) || typeof msg.t !== 'string') { core.error(c, 'bad_message'); return }
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
    setInterval(() => { if (registry.size > 0) core.broadcast(registry.values(), onlineSummary()) }, srv.onlineSummarySeconds * 1000),
    setInterval(heartbeat, srv.heartbeatSeconds * 1000),
    setInterval(() => trades.sweep(), srv.sweepSeconds * 1000),
    setInterval(retainChunks, wcfg.retainSeconds * 1000),
  ]

  return {
    attach(ws, ip) {
      if (sockets.size >= srv.maxClients || (ipCounts.get(ip) ?? 0) >= srv.maxClientsPerIp) {
        ws.send(JSON.stringify(errorMsg('server_full')))
        ws.close(codes.serverFull)
        return
      }
      const c = makeConn(ws, ip)
      sockets.add(c)
      ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1)
      const helloTimer = setTimeout(() => { if (!c.id) drop(c, codes.helloTimeout, 'hello_timeout') }, srv.helloTimeoutSeconds * 1000)
      ws.on('pong', () => { c.alive = true })
      ws.on('message', (data, isBinary) => { c.alive = true; onRaw(c, data, isBinary) })
      ws.on('close', () => { clearTimeout(helloTimer); cleanup(c, false) })
      ws.on('error', (err) => log(`socket error (${c.ip}): ${err.message}`))
    },
    onlineCount: () => registry.size,
    close() {
      for (const tm of timers) clearInterval(tm)
      trades.close()
      try { pvp?.dispose?.() } catch (err) { log(`pvp.dispose failed: ${(err as Error).message}`) }
      for (const c of [...sockets]) drop(c, codes.shutdown, undefined, true)
    },
  }
}
