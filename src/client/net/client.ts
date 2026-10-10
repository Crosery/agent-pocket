// WebSocket client: connection lifecycle with jittered exponential backoff, hello/welcome, runtime endpoint
// switching, typed message listeners, compact movement + delta snapshot decoding, adaptive jitter-buffered
// remote-player interpolation with bounded dead-reckoning, local movement prediction with smooth 150ms
// authoritative correction, debounced profile pushes, leaderboard requests and RTT / bandwidth statistics.
// Every method is safe to call while offline.
import type { EventBus, GameEvents, NetClient, NetClientStats, NetStatus } from '../contracts.ts'
import type { ClientMsg, LeaderboardEntry, PlayerState, PublicProfile, ServerMsg } from '../../shared/protocol.ts'
import { applyPlayerDelta, encodeMoveFrame } from '../../shared/net-codec.ts'
import type { Dir } from '../../shared/types.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { signEnvelope } from '../../shared/net-envelope.ts'
import { NET_CLIENT } from './config.ts'
import { adaptiveInterpDelay, pushSample, sampleAt, type Sample } from './interp.ts'
import { createPredictor, type CorrectionState, type Predictor, type StepReplayFn } from './predict.ts'
import { normalizeWsUrl } from './servers.ts'

export type RemotePlayer = PlayerState & { rx: number; ry: number }

export interface NetClientExt extends NetClient {
  /** Smoothed round-trip time in ms (-1 until the first pong). */
  readonly rtt: number
  /** serverTime - local Date.now() estimate in ms. */
  readonly serverTimeOffset: number
  /** Message of the day from the last welcome. */
  readonly motd: string
  /** Resolved WebSocket endpoint URL currently configured. */
  readonly endpoint: string | null
  /** Live RTT, jitter, stall and byte rate statistics. */
  readonly stats: NetClientStats
  /** Local movement predictor and reconciliation buffer. */
  readonly predictor: Predictor
  /** Switch target server endpoint (`ws(s)://`, `http(s)://`, bare host, or `null` for default origin). */
  setEndpoint(url: string | null): void
  /** Register collision-aware step replay callback used when reconciling after `move.correct`. */
  setStepReplay(fn: StepReplayFn | null): void
  /** Subscribe to authoritative local movement corrections (`move.correct`). */
  onCorrection(fn: (c: CorrectionState) => void): () => void
  /** Current smooth visual pull-back offset (decays to 0 over correctionMs). */
  visualOffset(at?: number): { ox: number; oy: number; active: boolean }
}

export interface NetClientOptions {
  /** Full ws(s):// URL; defaults to the page origin + content/net.json protocol.wsPath. */
  url?: string
  /** Set false to force legacy verbose move frames (for before/after byte benchmarks). */
  compact?: boolean
}

type HelloMsg = Extract<ClientMsg, { t: 'hello' }>
type PositionReport = { map: string; x: number; y: number; facing: Dir; moving: boolean; running: boolean }
type Listener = (msg: ServerMsg) => void

interface Remote {
  state: PlayerState
  samples: Sample[]
  out: RemotePlayer
  lastSampleAt: number
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function pageLocation(): Location | null {
  if ('location' in globalThis && typeof globalThis.location === 'object' && globalThis.location) {
    return globalThis.location
  }
  return null
}

function defaultUrl(): string | null {
  const loc = pageLocation()
  if (!loc?.host) return null
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${NET_CLIENT.protocol.wsPath}`
}


function leaderboardUrl(wsUrl: string | null): string | null {
  if (!wsUrl) return null
  try {
    const u = new URL(wsUrl)
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.pathname = NET_CLIENT.http.leaderboardPath
    u.search = ''
    return u.href
  } catch {
    return null
  }
}

function reportError(err: unknown): void {
  const g = globalThis as { reportError?: (e: unknown) => void }
  if (typeof g.reportError === 'function') g.reportError(err)
  else console.error(err)
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return -1
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[idx]
}

export function createNetClient(
  events: EventBus<GameEvents>,
  getHello: () => HelloMsg,
  opts: NetClientOptions = {},
): NetClientExt {
  const cfg = NET_CLIENT.client
  const codes = NET_CLIENT.protocol.closeCodes
  const tickMs = 1000 / CONTENT.config.net.tickHz
  const useCompact = opts.compact !== false
  const interp = {
    keepMs: cfg.sampleBufferMs,
    snapDistance: cfg.snapDistanceTiles,
    tickMs,
    maxExtrapolateMs: cfg.maxExtrapolateMs,
  }
  const round = (v: number) => { const f = 10 ** cfg.positionDecimals; return Math.round(v * f) / f }
  const predictor = createPredictor({
    correctionMs: cfg.correctionMs,
    snapDistanceTiles: cfg.snapDistanceTiles,
    maxPending: cfg.predictionMaxPending,
    maxReplayStepTiles: cfg.predictionReplayStepMaxTiles,
  })

  let customUrl: string | null = opts.url ?? null
  let status: NetStatus = 'offline'
  let ws: WebSocket | null = null
  let selfId: string | null = null
  let online = 0
  let motd = ''
  let rtt = -1
  let serverTimeOffset = 0
  let serverPerfOffset = 0
  let hasServerPerfOffset = false
  let lastServerSnapAt = 0
  let activeInterpDelayMs = cfg.interpolationDelayMs
  let wanted = false
  let attempt = 0
  let retryTimer: NodeJS.Timeout | number | null = null
  let pingTimer: NodeJS.Timeout | number | null = null
  let lastPongAt = 0
  let profileTimer: NodeJS.Timeout | number | null = null
  let pendingProfile: PublicProfile | null = null
  let localMap: string | null = null
  let lastSent: PositionReport | null = null
  let lastSentAt = -Infinity
  let sessionKey: string | null = null
  let outSeq = 0
  let windowHooked = false
  let stepReplayFn: StepReplayFn | null = null

  // Metrics state
  const rttSamples: number[] = []
  const rttDiffSamples: number[] = []
  const snapJitterSamples: number[] = []
  const snapshotHistogram: [number, number, number, number] = [0, 0, 0, 0]
  let stalls = 0
  let totalSnapshots = 0
  let lastSnapArrivalAt = 0
  let rxBytes = 0
  let txBytes = 0
  const rxWindow: { at: number; bytes: number }[] = []
  const txWindow: { at: number; bytes: number }[] = []

  const listeners = new Map<string, Set<Listener>>()
  const correctionListeners = new Set<(c: CorrectionState) => void>()
  const remotes = new Map<string, Remote>()
  const slotToId = new Map<number, string>()
  const idToSlot = new Map<string, number>()
  const view = new Map<string, RemotePlayer>()
  const lbWaiters = new Set<(entries: LeaderboardEntry[] | null) => void>()

  const url = (): string | null => (customUrl !== null ? normalizeWsUrl(customUrl) : defaultUrl())

  function recordRx(bytes: number, t: number): void {
    rxBytes += bytes
    rxWindow.push({ at: t, bytes })
    const cutoff = t - 2000
    while (rxWindow.length > 0 && rxWindow[0].at < cutoff) rxWindow.shift()
  }

  function recordTx(bytes: number, t: number): void {
    txBytes += bytes
    txWindow.push({ at: t, bytes })
    const cutoff = t - 2000
    while (txWindow.length > 0 && txWindow[0].at < cutoff) txWindow.shift()
  }

  function rateBps(win: { at: number; bytes: number }[], t: number): number {
    const cutoff = t - 1000
    let sum = 0
    for (let i = win.length - 1; i >= 0; i--) {
      if (win[i].at < cutoff) break
      sum += win[i].bytes
    }
    return sum
  }

  function currentJitterP95(): number {
    const rttJ = percentile(rttDiffSamples, 0.95)
    const snapJ = percentile(snapJitterSamples, 0.95)
    return Math.max(rttJ >= 0 ? rttJ : 0, snapJ >= 0 ? snapJ : 0)
  }

  function setStatus(s: NetStatus): void {
    if (status === s) return
    status = s
    events.emit('net:status', { status: s })
  }

  // ---------------------------------------------------------------- remote players

  function clearRemotes(): void {
    remotes.clear()
    slotToId.clear()
    idToSlot.clear()
    view.clear()
  }

  function removeRemote(id: string): void {
    const slot = idToSlot.get(id)
    if (slot !== undefined) {
      slotToId.delete(slot)
      idToSlot.delete(id)
    }
    remotes.delete(id)
    view.delete(id)
  }

  function bindSlot(slot: number | undefined, id: string): void {
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot <= 0) return
    const prevId = slotToId.get(slot)
    if (prevId && prevId !== id) idToSlot.delete(prevId)
    const prevSlot = idToSlot.get(id)
    if (prevSlot !== undefined && prevSlot !== slot) slotToId.delete(prevSlot)
    slotToId.set(slot, id)
    idToSlot.set(id, slot)
  }

  function velocityFor(p: PlayerState): { vx: number; vy: number } {
    if (!p.moving) return { vx: 0, vy: 0 }
    const M = CONTENT.config.movement
    const speed = p.running ? M.runSpeed : M.walkSpeed
    const dx = p.facing === 'left' ? -1 : p.facing === 'right' ? 1 : 0
    const dy = p.facing === 'up' ? -1 : p.facing === 'down' ? 1 : 0
    return { vx: dx * speed, vy: dy * speed }
  }

  function upsertRemote(p: PlayerState, t: number): void {
    if (p.id === selfId) return
    if (localMap !== null && p.map !== localMap) { removeRemote(p.id); return }
    const vel = velocityFor(p)
    const r = remotes.get(p.id)
    if (!r) {
      const out: RemotePlayer = { ...p, rx: p.x, ry: p.y }
      remotes.set(p.id, { state: p, samples: [{ t, x: p.x, y: p.y, vx: vel.vx, vy: vel.vy }], out, lastSampleAt: t })
      view.set(p.id, out)
      return
    }
    if (r.state.map !== p.map) r.samples.length = 0
    r.state = p
    r.lastSampleAt = t
    pushSample(r.samples, { t, x: p.x, y: p.y, vx: vel.vx, vy: vel.vy }, interp)
    r.out = { ...p, rx: r.out.rx, ry: r.out.ry }
    view.set(p.id, r.out)
  }

  function snapshotSampleTime(msgAt: number | undefined, arrT: number): number {
    if (typeof msgAt !== 'number' || !Number.isFinite(msgAt)) return arrT
    const obsOffset = arrT - msgAt
    if (!hasServerPerfOffset) {
      serverPerfOffset = obsOffset
      hasServerPerfOffset = true
    } else {
      // Follow baseline offset slowly; burst arrivals after a stall keep their server-stamped spacing.
      const alpha = obsOffset < serverPerfOffset ? 0.35 : 0.08
      serverPerfOffset += (obsOffset - serverPerfOffset) * alpha
    }
    const est = msgAt + serverPerfOffset
    const clamped = Math.max(arrT - cfg.sampleBufferMs, Math.min(arrT + tickMs * 0.5, est))
    if (lastServerSnapAt > 0 && msgAt > lastServerSnapAt) {
      lastServerSnapAt = msgAt
      return clamped
    }
    lastServerSnapAt = msgAt
    return clamped
  }

  function applySnapshot(msg: Extract<ServerMsg, { t: 'snapshot' }>): void {
    if (typeof msg.ack === 'number') predictor.ack(msg.ack)
    if (localMap !== null && msg.map !== localMap) return
    const arrT = now()
    totalSnapshots++
    if (lastSnapArrivalAt > 0) {
      const dt = Math.max(0, arrT - lastSnapArrivalAt)
      if (dt <= 120) snapshotHistogram[0]++
      else if (dt <= 180) snapshotHistogram[1]++
      else if (dt <= 250) snapshotHistogram[2]++
      else {
        snapshotHistogram[3]++
        if (dt > cfg.stallThresholdMs) stalls++
      }
      snapJitterSamples.push(Math.abs(dt - tickMs))
      if (snapJitterSamples.length > cfg.metricsWindowSize) snapJitterSamples.shift()
    }
    lastSnapArrivalAt = arrT

    const sampleT = snapshotSampleTime(msg.at, arrT)
    const isDelta = msg.d !== undefined || slotToId.size > 0
    const seen = isDelta ? null : new Set<string>()
    for (const p of msg.players) {
      seen?.add(p.id)
      upsertRemote(p, sampleT)
    }
    if (Array.isArray(msg.d)) {
      for (const tuple of msg.d) {
        if (!Array.isArray(tuple) || tuple.length < 4) continue
        const id = slotToId.get(tuple[0])
        if (!id) continue
        const r = remotes.get(id)
        if (!r) continue
        const updated = applyPlayerDelta(r.state, tuple)
        if (updated) upsertRemote(updated, sampleT)
      }
    }
    if (seen) {
      for (const id of [...remotes.keys()]) if (!seen.has(id)) removeRemote(id)
    }
  }

  // ---------------------------------------------------------------- socket lifecycle

  function stopTimers(): void {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  }

  function flushLeaderboardWaiters(entries: LeaderboardEntry[] | null): void {
    for (const w of [...lbWaiters]) w(entries)
  }

  function onClosed(code: number): void {
    stopTimers()
    selfId = null
    lastSent = null
    hasServerPerfOffset = false
    lastServerSnapAt = 0
    lastSnapArrivalAt = 0
    predictor.reset()
    sessionKey = null
    outSeq = 0
    clearRemotes()
    flushLeaderboardWaiters(null)
    if (!wanted) { setStatus('offline'); return }
    if (code === codes.duplicate || code === codes.version || code === codes.devNotAllowed) {
      // Another tab took over this player, the client is outdated, or this devtools build is refused: retrying would only fight it.
      wanted = false
      setStatus('error')
      if (code === codes.devNotAllowed) events.emit('toast', { text: t('net.error.dev_not_allowed'), kind: 'warn' })
      return
    }
    scheduleReconnect()
  }

  function dropSocket(code: number): void {
    const s = ws
    if (!s) return
    ws = null
    s.onopen = s.onmessage = s.onclose = s.onerror = null
    try { s.close() } catch { /* already closed */ }
    onClosed(code)
  }

  function scheduleReconnect(): void {
    if (retryTimer || !wanted) return
    const r = cfg.reconnect
    const base = Math.min(r.maxMs, r.baseMs * r.factor ** attempt)
    const delay = Math.max(0, base * (1 + (Math.random() * 2 - 1) * r.jitter))
    attempt++
    setStatus('connecting')
    retryTimer = setTimeout(() => { retryTimer = null; open() }, delay)
  }

  function sendJson(sock: WebSocket, msg: ClientMsg): void {
    const raw = JSON.stringify(msg)
    recordTx(raw.length, now())
    sock.send(raw)
  }

  function startPing(): void {
    clearInterval(pingTimer ?? undefined)
    lastPongAt = now()
    const ping = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (now() - lastPongAt > cfg.pingTimeoutSeconds * 1000) { dropSocket(1006); return }
      sendJson(ws, { t: 'ping', at: now(), ...(rtt >= 0 ? { rtt: Math.round(rtt) } : {}) })
    }
    pingTimer = setInterval(ping, cfg.pingSeconds * 1000)
    ping()
  }

  function hookWindow(): void {
    if (windowHooked) return
    if (!('addEventListener' in globalThis) || typeof globalThis.addEventListener !== 'function' || !('document' in globalThis) || typeof globalThis.document === 'undefined') return
    windowHooked = true
    globalThis.addEventListener('online', () => {
      if (!wanted || ws) return
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      attempt = 0
      open()
    })
  }

  function open(): void {
    if (ws || !wanted) return
    const target = url()
    if (!target || typeof WebSocket === 'undefined') { setStatus('offline'); return }
    setStatus('connecting')
    let sock: WebSocket
    try {
      sock = new WebSocket(target)
    } catch {
      scheduleReconnect()
      return
    }
    ws = sock
    sock.onopen = () => {
      if (ws !== sock) return
      let hello: HelloMsg
      try {
        const raw = getHello()
        hello = { ...raw, signed: true }
      } catch (err) {
        reportError(err)
        dropSocket(1011)
        return
      }
      localMap = hello.map
      predictor.reset({ map: hello.map, x: round(hello.x), y: round(hello.y), facing: hello.facing })
      sendJson(sock, useCompact && hello.compact === undefined ? { ...hello, compact: true } : hello)
    }
    sock.onmessage = (e: MessageEvent) => {
      if (ws !== sock || typeof e.data !== 'string') return
      recordRx(e.data.length, now())
      let msg: ServerMsg
      try { msg = JSON.parse(e.data) as ServerMsg } catch { return }
      if (msg && typeof msg.t === 'string') handle(msg)
    }
    sock.onclose = (e: CloseEvent) => {
      if (ws !== sock) return
      ws = null
      onClosed(e.code)
    }
    sock.onerror = () => { /* a close event always follows */ }
  }

  // ---------------------------------------------------------------- inbound

  function handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        selfId = msg.selfId
        online = msg.online
        motd = msg.motd
        serverTimeOffset = msg.serverTime - Date.now()
        sessionKey = typeof msg.sessionKey === 'string' && msg.sessionKey ? msg.sessionKey : null
        outSeq = 0
        attempt = 0
        lastSent = null
        // The hello already carried the freshest profile.
        pendingProfile = null
        if (profileTimer) { clearTimeout(profileTimer); profileTimer = null }
        startPing()
        setStatus('online')
        break
      case 'online': online = msg.count; break
      case 'snapshot': applySnapshot(msg); break
      case 'join':
        bindSlot(msg.s, msg.player.id)
        upsertRemote(msg.player, now())
        break
      case 'leave': removeRemote(msg.id); break
      case 'move.correct': {
        const corr = predictor.reconcile(msg, now(), stepReplayFn)
        localMap = corr.map
        lastSent = { map: corr.map, x: round(corr.x), y: round(corr.y), facing: corr.facing, moving: false, running: false }
        for (const fn of [...correctionListeners]) {
          try { fn(corr) } catch (err) { reportError(err) }
        }
        break
      }
      case 'chat': events.emit('chat:message', { from: msg.from, name: msg.name, channel: msg.channel, text: msg.text, at: msg.at }); break
      case 'pong': {
        const t = now()
        lastPongAt = t
        if (typeof msg.ack === 'number') predictor.ack(msg.ack)
        const sample = Math.max(0, t - msg.at)
        const prevRtt = rtt
        rtt = rtt < 0 ? sample : rtt + (sample - rtt) * cfg.rttSmoothing
        rttSamples.push(sample)
        if (rttSamples.length > cfg.metricsWindowSize) rttSamples.shift()
        if (prevRtt >= 0) {
          rttDiffSamples.push(Math.abs(sample - prevRtt))
          if (rttDiffSamples.length > cfg.metricsWindowSize) rttDiffSamples.shift()
        }
        serverTimeOffset = msg.serverTime + sample / 2 - Date.now()
        break
      }
      case 'leaderboard': flushLeaderboardWaiters(msg.entries); break
    }
    const set = listeners.get(msg.t)
    if (!set) return
    for (const fn of [...set]) {
      try { fn(msg) } catch (err) { reportError(err) }
    }
  }

  // ---------------------------------------------------------------- outbound

  function send(msg: ClientMsg): void {
    if (!ws || status !== 'online' || ws.readyState !== WebSocket.OPEN) return
    if (sessionKey && msg.t !== 'ping') {
      const targetSeq = typeof msg.seq === 'number' && Number.isSafeInteger(msg.seq) && msg.seq > 0 ? msg.seq : ++outSeq
      if (targetSeq > outSeq) outSeq = targetSeq
      sendJson(ws, signEnvelope(sessionKey, msg, targetSeq))
      return
    }
    sendJson(ws, msg)
  }

  function sendProfileNow(): void {
    profileTimer = null
    if (!pendingProfile || status !== 'online') return
    const profile = pendingProfile
    pendingProfile = null
    send({ t: 'profile', profile })
  }

  async function httpLeaderboard(): Promise<LeaderboardEntry[]> {
    const href = leaderboardUrl(url())
    if (!href || typeof fetch !== 'function') return []
    try {
      const res = await fetch(href, { cache: 'no-store' })
      if (!res.ok) return []
      const body = (await res.json()) as { entries?: LeaderboardEntry[] }
      return Array.isArray(body.entries) ? body.entries : []
    } catch {
      return []
    }
  }

  return {
    get status() { return status },
    get selfId() { return selfId },
    get online() { return online },
    get rtt() { return rtt },
    get serverTimeOffset() { return serverTimeOffset },
    get motd() { return motd },
    get endpoint() { return url() },
    get predictor() { return predictor },
    get stats(): NetClientStats {
      const t = now()
      const p50 = percentile(rttSamples, 0.5)
      const p95 = percentile(rttSamples, 0.95)
      const jitter = currentJitterP95()
      return {
        rtt,
        p50,
        p95,
        jitter,
        interpDelayMs: Math.round(activeInterpDelayMs),
        stalls,
        snapshotHistogram: [...snapshotHistogram] as [number, number, number, number],
        rxBps: rateBps(rxWindow, t),
        txBps: rateBps(txWindow, t),
        rxBytes,
        txBytes,
        lossRate: totalSnapshots > 0 ? Math.min(1, stalls / totalSnapshots) : 0,
      }
    },

    setEndpoint(nextUrl) {
      const prev = url()
      customUrl = nextUrl && nextUrl.trim() ? nextUrl.trim() : null
      const next = url()
      if (prev === next) return
      if (ws || retryTimer) {
        const keepWanted = wanted
        wanted = false
        if (ws) dropSocket(1000)
        else { stopTimers(); setStatus('offline') }
        if (keepWanted) {
          wanted = true
          attempt = 0
          open()
        }
      }
    },

    setStepReplay(fn) {
      stepReplayFn = fn
    },

    onCorrection(fn) {
      correctionListeners.add(fn)
      return () => { correctionListeners.delete(fn) }
    },

    visualOffset(at = now()) {
      return predictor.visualOffset(at)
    },

    connect() {
      wanted = true
      hookWindow()
      if (ws || retryTimer) return
      attempt = 0
      open()
    },

    disconnect() {
      wanted = false
      if (profileTimer) { clearTimeout(profileTimer); profileTimer = null }
      if (ws) dropSocket(1000)
      else { stopTimers(); setStatus('offline') }
    },

    send,

    on(t, fn) {
      let set = listeners.get(t)
      if (!set) { set = new Set(); listeners.set(t, set) }
      const l = fn as unknown as Listener
      set.add(l)
      return () => { listeners.get(t)?.delete(l) }
    },

    remotePlayers() {
      if (rttDiffSamples.length >= 2 || snapJitterSamples.length >= 2) {
        const targetDelay = adaptiveInterpDelay(currentJitterP95(), tickMs, cfg.interpolationMinMs, cfg.interpolationMaxMs)
        activeInterpDelayMs += (targetDelay - activeInterpDelayMs) * 0.2
      } else {
        activeInterpDelayMs = cfg.interpolationDelayMs
      }
      const rt = now() - activeInterpDelayMs
      for (const r of remotes.values()) {
        const p = sampleAt(r.samples, rt, cfg.maxExtrapolateMs)
        r.out.rx = p ? p.x : r.state.x
        r.out.ry = p ? p.y : r.state.y
      }
      return view
    },

    reportPosition(p) {
      if (localMap !== p.map) { localMap = p.map; clearRemotes() }
      if (status !== 'online') return
      const q: PositionReport = { map: p.map, x: round(p.x), y: round(p.y), facing: p.facing, moving: p.moving, running: p.running }
      const prev = lastSent
      if (prev && prev.map === q.map && prev.x === q.x && prev.y === q.y && prev.facing === q.facing && prev.moving === q.moving && prev.running === q.running) return
      const urgent = !prev || prev.moving !== q.moving || prev.map !== q.map || prev.running !== q.running
      const t = now()
      if (!urgent && t - lastSentAt < tickMs) return
      const seq = predictor.record(q, t)
      const includeMap = !prev || prev.map !== q.map
      if (useCompact) send(encodeMoveFrame({ seq, ...q }, includeMap))
      else send({ t: 'move', seq, ...q })
      lastSent = q
      lastSentAt = t
    },

    updateProfile(profile) {
      pendingProfile = profile
      if (profileTimer) return
      profileTimer = setTimeout(sendProfileNow, cfg.profileDebounceMs)
    },

    leaderboard() {
      if (status !== 'online') return httpLeaderboard()
      return new Promise<LeaderboardEntry[]>((resolve) => {
        const waiter = (entries: LeaderboardEntry[] | null) => {
          clearTimeout(timer)
          lbWaiters.delete(waiter)
          if (entries) resolve(entries)
          else void httpLeaderboard().then(resolve)
        }
        const timer = setTimeout(() => waiter(null), cfg.leaderboardTimeoutMs)
        lbWaiters.add(waiter)
        send({ t: 'leaderboard' })
      })
    },
  }
}
