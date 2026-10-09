// Network simulation (ADR 0002 §3.4): replaces window.WebSocket with DevSocket before net.connect(), so src/client/net
// stays untouched. Two modes: `real` wraps the genuine socket and bends the link (latency, jitter, TCP-style stalls,
// drops); `fake` talks to an in-page FakeServer with a crowd of walking fake players and needs no server at all.
import { FakeServer, type FakeConfig, type FakeText } from '../../shared/dev/netsim.ts'
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts'

export interface LinkConfig {
  latencyMs: number
  jitterMs: number
  /** Chance per message that the stream stalls (TCP retransmission); everything behind it waits, nothing is reordered. */
  stallChance: number
  stallMs: [number, number]
}

export interface NetSimConfig {
  link: LinkConfig
  limits: { latencyMs: number; jitterMs: number; stallMs: number; peers: number }
  presets: Record<string, Partial<LinkConfig>>
  fake: FakeConfig
}

/** The slice of the WebSocket API the game client uses (client.ts: new, on*, send, close, readyState). */
export interface SocketLike {
  readyState: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}
export type SocketCtor = new (url: string) => SocketLike

export interface NetSimOptions {
  /** The genuine WebSocket constructor, or null where there is none (the fake mode still works). */
  Real: SocketCtor | null
  config: NetSimConfig
  text: FakeText
  /** Avatar ids the fake players are dressed in, round robin. */
  avatars: string[]
  now?: () => number
  rand?: () => number
}

export interface NetSimState {
  mode: 'real' | 'fake'
  link: LinkConfig
  peers: number
  /** Open DevSockets right now. */
  sockets: number
}

export interface NetSim {
  /** Constructor to put on window.WebSocket. */
  readonly Socket: SocketCtor & { readonly OPEN: number; readonly CONNECTING: number; readonly CLOSING: number; readonly CLOSED: number }
  state(): NetSimState
  /** Merges the given link settings (missing fields keep their value). */
  setLink(patch: Partial<LinkConfig>): LinkConfig
  /** Applies a named preset from the config, starting from the all-off link. */
  preset(name: string): LinkConfig
  /** Abnormal close of every open socket (the client sees code `code` and reconnects by itself). */
  drop(code?: number): number
  /** Sockets opened from now on talk to the fake server (or to the real one again). */
  setFake(on: boolean, peers?: number): void
  /** Resizes the fake crowd, live. */
  setPeers(n: number): number
  /** Puts DevSocket on `target.WebSocket` and returns what to call to put the original back. */
  install(target: { WebSocket?: unknown }): () => void
}

const READY = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const
const ABNORMAL = 1006

export function createNetSim(opts: NetSimOptions): NetSim {
  const now = opts.now ?? Date.now
  const rand = opts.rand ?? Math.random
  const cfg = opts.config
  const link: LinkConfig = { ...cfg.link, stallMs: [...cfg.link.stallMs] }
  let fake = false
  let peers = cfg.fake.peers
  const open = new Set<Socket>()

  /** One direction of one connection: due times never decrease, so stalls delay what follows instead of reordering it. */
  class Pipe {
    private tail = 0
    private timers = new Set<ReturnType<typeof setTimeout>>()
    /** Fake connections must never deliver inside the call that caused it (a real socket opens and answers later); real ones already arrive asynchronously. */
    private readonly deferred: boolean
    constructor(deferred: boolean) { this.deferred = deferred }
    push(fn: () => void): void {
      const t = now()
      let due = t + link.latencyMs + (link.jitterMs > 0 ? (rand() * 2 - 1) * link.jitterMs : 0)
      if (link.stallChance > 0 && rand() < link.stallChance) due += link.stallMs[0] + rand() * (link.stallMs[1] - link.stallMs[0])
      due = Math.max(due, this.tail, t)
      this.tail = due
      if (!this.deferred && due <= t && this.timers.size === 0) { fn(); return }
      const id = setTimeout(() => { this.timers.delete(id); fn() }, due - t)
      this.timers.add(id)
    }
    clear(): void { for (const id of this.timers) clearTimeout(id); this.timers.clear() }
  }

  class Socket implements SocketLike {
    static readonly CONNECTING = READY.CONNECTING
    static readonly OPEN = READY.OPEN
    static readonly CLOSING = READY.CLOSING
    static readonly CLOSED = READY.CLOSED
    readonly CONNECTING = READY.CONNECTING
    readonly OPEN = READY.OPEN
    readonly CLOSING = READY.CLOSING
    readonly CLOSED = READY.CLOSED
    readyState: number = READY.CONNECTING
    binaryType = 'blob'
    bufferedAmount = 0
    extensions = ''
    protocol = ''
    onopen: SocketLike['onopen'] = null
    onmessage: SocketLike['onmessage'] = null
    onclose: SocketLike['onclose'] = null
    onerror: SocketLike['onerror'] = null
    readonly url: string
    private real: SocketLike | null = null
    server: FakeServer | null = null
    private ticker: ReturnType<typeof setInterval> | null = null
    private readonly inbound: Pipe
    private readonly outbound: Pipe

    constructor(url: string) {
      this.url = String(url)
      open.add(this)
      const Real = fake ? null : opts.Real
      this.inbound = new Pipe(!Real)
      this.outbound = new Pipe(!Real)
      if (!Real) {
        this.server = new FakeServer(cfg.fake, opts.text, opts.avatars, peers, now())
        this.inbound.push(() => this.opened())
      } else {
        const real = new Real(this.url)
        this.real = real
        real.onopen = () => this.inbound.push(() => this.opened())
        real.onmessage = (e) => this.inbound.push(() => { if (this.readyState === READY.OPEN) this.onmessage?.(e) })
        real.onclose = (e) => this.inbound.push(() => this.finish(e.code, e.reason, e.wasClean))
        real.onerror = (e) => this.inbound.push(() => this.onerror?.(e))
      }
    }

    private opened(): void {
      if (this.readyState !== READY.CONNECTING) return
      this.readyState = READY.OPEN
      if (this.server) this.ticker = setInterval(() => this.emit(this.server?.tick(now()) ?? []), 1000 / cfg.fake.snapshotHz)
      this.onopen?.({ type: 'open' })
    }

    /** Server -> client messages of the fake server, through the same delayed pipe as real traffic. */
    emit(msgs: ServerMsg[]): void {
      for (const m of msgs) this.inbound.push(() => { if (this.readyState === READY.OPEN) this.onmessage?.({ data: JSON.stringify(m) }) })
    }

    send(data: string): void {
      if (this.readyState !== READY.OPEN) throw new Error('InvalidStateError: socket is not open')
      this.outbound.push(() => {
        if (this.readyState !== READY.OPEN) return
        if (this.real) { if (this.real.readyState === READY.OPEN) this.real.send(data) } else if (this.server) {
          let msg: ClientMsg
          try { msg = JSON.parse(data) as ClientMsg } catch { return }
          this.emit(this.server.handle(msg, now()))
        }
      })
    }

    close(code = 1000, reason = ''): void {
      if (this.readyState === READY.CLOSING || this.readyState === READY.CLOSED) return
      this.readyState = READY.CLOSING
      if (this.ticker) { clearInterval(this.ticker); this.ticker = null }
      if (this.real) this.real.close(code, reason)
      else this.inbound.push(() => this.finish(code, reason, true))
    }

    /** Ends the connection right now as if the network cut it (no close handshake, no delay). */
    abort(code: number): void {
      if (this.readyState === READY.CLOSED) return
      if (this.real) { this.real.onopen = this.real.onmessage = this.real.onclose = this.real.onerror = null; try { this.real.close() } catch { /* already gone */ } }
      this.finish(code, '', false)
    }

    private finish(code: number, reason: string, wasClean: boolean): void {
      if (this.readyState === READY.CLOSED) return
      this.readyState = READY.CLOSED
      if (this.ticker) { clearInterval(this.ticker); this.ticker = null }
      this.inbound.clear()
      this.outbound.clear()
      open.delete(this)
      this.onclose?.({ code, reason, wasClean })
    }
  }

  const clampLink = (l: LinkConfig): LinkConfig => {
    const lim = cfg.limits
    l.latencyMs = Math.min(lim.latencyMs, Math.max(0, l.latencyMs))
    l.jitterMs = Math.min(lim.jitterMs, Math.max(0, l.jitterMs))
    l.stallChance = Math.min(1, Math.max(0, l.stallChance))
    const lo = Math.min(lim.stallMs, Math.max(0, l.stallMs[0]))
    l.stallMs = [lo, Math.min(lim.stallMs, Math.max(lo, l.stallMs[1]))]
    return l
  }

  return {
    Socket: Socket as unknown as NetSim['Socket'],
    state: () => ({ mode: fake || !opts.Real ? 'fake' : 'real', link: { ...link, stallMs: [...link.stallMs] }, peers, sockets: open.size }),
    setLink(patch) {
      Object.assign(link, { ...patch, stallMs: patch.stallMs ? [...patch.stallMs] : link.stallMs })
      clampLink(link)
      return { ...link, stallMs: [...link.stallMs] }
    },
    preset(name) {
      const p = cfg.presets[name]
      if (!p) throw new Error(`unknown preset ${name}`)
      Object.assign(link, { ...cfg.link, stallMs: [...cfg.link.stallMs] }, { ...p, stallMs: p.stallMs ? [...p.stallMs] : [...cfg.link.stallMs] })
      clampLink(link)
      return { ...link, stallMs: [...link.stallMs] }
    },
    drop(code = ABNORMAL) {
      const all = [...open]
      for (const s of all) s.abort(code)
      return all.length
    },
    setFake(on, n) {
      fake = on
      if (n !== undefined) peers = Math.min(cfg.limits.peers, Math.max(0, Math.floor(n)))
    },
    setPeers(n) {
      peers = Math.min(cfg.limits.peers, Math.max(0, Math.floor(n)))
      for (const s of open) if (s.server) s.emit(s.server.setPeers(peers, now()))
      return peers
    },
    install(target) {
      const before = target.WebSocket
      target.WebSocket = Socket
      return () => { target.WebSocket = before }
    },
  }
}
