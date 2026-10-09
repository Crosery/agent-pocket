// WebSocket client: connection lifecycle with jittered exponential backoff, hello/welcome, typed
// message listeners, remote-player interpolation, throttled position reports, debounced profile
// pushes, leaderboard requests and ping/pong RTT. Every method is safe to call while offline.
import type { EventBus, GameEvents, NetClient, NetStatus } from '../contracts.ts'
import type { ClientMsg, LeaderboardEntry, PlayerState, PublicProfile, ServerMsg } from '../../shared/protocol.ts'
import type { Dir } from '../../shared/types.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { NET_CLIENT } from './config.ts'
import { pushSample, sampleAt, type Sample } from './interp.ts'

export type RemotePlayer = PlayerState & { rx: number; ry: number }

export interface NetClientExt extends NetClient {
  /** Smoothed round-trip time in ms (-1 until the first pong). */
  readonly rtt: number
  /** serverTime - local Date.now() estimate in ms. */
  readonly serverTimeOffset: number
  /** Message of the day from the last welcome. */
  readonly motd: string
}

export interface NetClientOptions {
  /** Full ws(s):// URL; defaults to the page origin + content/net.json protocol.wsPath. */
  url?: string
}

type HelloMsg = Extract<ClientMsg, { t: 'hello' }>
type PositionReport = { map: string; x: number; y: number; facing: Dir; moving: boolean; running: boolean }
type Listener = (msg: ServerMsg) => void

interface Remote { state: PlayerState; samples: Sample[]; out: RemotePlayer }

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function defaultUrl(): string | null {
  const loc = (globalThis as { location?: Location }).location
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

export function createNetClient(
  events: EventBus<GameEvents>,
  getHello: () => HelloMsg,
  opts: NetClientOptions = {},
): NetClientExt {
  const cfg = NET_CLIENT.client
  const codes = NET_CLIENT.protocol.closeCodes
  const tickMs = 1000 / CONTENT.config.net.tickHz
  const interp = { keepMs: cfg.sampleBufferMs, snapDistance: cfg.snapDistanceTiles, tickMs }
  const round = (v: number) => { const f = 10 ** cfg.positionDecimals; return Math.round(v * f) / f }

  let status: NetStatus = 'offline'
  let ws: WebSocket | null = null
  let selfId: string | null = null
  let online = 0
  let motd = ''
  let rtt = -1
  let serverTimeOffset = 0
  let wanted = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let lastPongAt = 0
  let profileTimer: ReturnType<typeof setTimeout> | null = null
  let pendingProfile: PublicProfile | null = null
  let localMap: string | null = null
  let lastSent: PositionReport | null = null
  let lastSentAt = -Infinity
  let windowHooked = false

  const listeners = new Map<string, Set<Listener>>()
  const remotes = new Map<string, Remote>()
  const view = new Map<string, RemotePlayer>()
  const lbWaiters = new Set<(entries: LeaderboardEntry[] | null) => void>()

  const url = (): string | null => opts.url ?? defaultUrl()

  function setStatus(s: NetStatus): void {
    if (status === s) return
    status = s
    events.emit('net:status', { status: s })
  }

  // ---------------------------------------------------------------- remote players

  function clearRemotes(): void {
    remotes.clear()
    view.clear()
  }

  function removeRemote(id: string): void {
    remotes.delete(id)
    view.delete(id)
  }

  function upsertRemote(p: PlayerState, t: number): void {
    if (p.id === selfId) return
    if (localMap !== null && p.map !== localMap) { removeRemote(p.id); return }
    const r = remotes.get(p.id)
    if (!r) {
      const out: RemotePlayer = { ...p, rx: p.x, ry: p.y }
      remotes.set(p.id, { state: p, samples: [{ t, x: p.x, y: p.y }], out })
      view.set(p.id, out)
      return
    }
    if (r.state.map !== p.map) r.samples.length = 0
    r.state = p
    pushSample(r.samples, { t, x: p.x, y: p.y }, interp)
    r.out = { ...p, rx: r.out.rx, ry: r.out.ry }
    view.set(p.id, r.out)
  }

  function applySnapshot(msg: Extract<ServerMsg, { t: 'snapshot' }>): void {
    if (localMap !== null && msg.map !== localMap) return
    const t = now()
    const seen = new Set<string>()
    for (const p of msg.players) { seen.add(p.id); upsertRemote(p, t) }
    for (const id of [...remotes.keys()]) if (!seen.has(id)) removeRemote(id)
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

  function startPing(): void {
    if (pingTimer) clearInterval(pingTimer)
    lastPongAt = now()
    const ping = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (now() - lastPongAt > cfg.pingTimeoutSeconds * 1000) { dropSocket(1006); return }
      ws.send(JSON.stringify({ t: 'ping', at: now() } satisfies ClientMsg))
    }
    pingTimer = setInterval(ping, cfg.pingSeconds * 1000)
    ping()
  }

  function hookWindow(): void {
    if (windowHooked) return
    const w = globalThis as { addEventListener?: (t: string, fn: () => void) => void }
    if (typeof w.addEventListener !== 'function' || typeof (globalThis as { document?: unknown }).document === 'undefined') return
    windowHooked = true
    w.addEventListener('online', () => {
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
        hello = getHello()
      } catch (err) {
        reportError(err)
        dropSocket(1011)
        return
      }
      localMap = hello.map
      sock.send(JSON.stringify(hello))
    }
    sock.onmessage = (e: MessageEvent) => {
      if (ws !== sock || typeof e.data !== 'string') return
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
      case 'join': upsertRemote(msg.player, now()); break
      case 'leave': removeRemote(msg.id); break
      case 'chat': events.emit('chat:message', { from: msg.from, name: msg.name, channel: msg.channel, text: msg.text, at: msg.at }); break
      case 'pong': {
        const t = now()
        lastPongAt = t
        const sample = Math.max(0, t - msg.at)
        rtt = rtt < 0 ? sample : rtt + (sample - rtt) * cfg.rttSmoothing
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
    ws.send(JSON.stringify(msg))
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
      const rt = now() - cfg.interpolationDelayMs
      for (const r of remotes.values()) {
        const p = sampleAt(r.samples, rt)
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
      const urgent = !prev || prev.moving !== q.moving || prev.map !== q.map
      const t = now()
      if (!urgent && t - lastSentAt < tickMs) return
      send({ t: 'move', ...q })
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
