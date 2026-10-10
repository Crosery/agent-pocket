// Deterministic WebSocket weak-network proxy (#23, ADR 0001 §4.1):
// Injects one-way latency (rttMs / 2), bounded jitter (±jitterMs), and TCP-over-WebSocket packet loss
// stalls (lossRate: a lost TCP segment stalls the direction stream by 1..1.5 RTTs while preserving frame order),
// and records exact uplink/downlink frame and byte counts.
//
// CLI usage:
//   node scripts/lagproxy.ts --listen 8789 --target ws://127.0.0.1:8787/ws [--rtt 150] [--jitter 10] [--loss 0.02] [--seed 20261011]
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { Rng } from '../src/shared/rng.ts'
import netJson from '../content/net.json' with { type: 'json' }

export interface LagProxyOptions {
  /** Local port to listen on (0 = ephemeral port). */
  listenPort: number
  /** Upstream WebSocket URL, e.g. ws://127.0.0.1:8787/ws. */
  targetUrl: string
  /** Round-trip time in ms (split evenly between uplink and downlink). Default: 150. */
  rttMs?: number
  /** Symmetric jitter in ms per direction. Default: 10. */
  jitterMs?: number
  /** Per-frame packet loss probability (0..1) causing a TCP retransmission head-of-line stall. Default: 0.02. */
  lossRate?: number
  /** Deterministic PRNG seed. Default: 20261011. */
  seed?: number
}

export interface LagProxyStats {
  connections: number
  txFrames: number
  rxFrames: number
  txBytes: number
  rxBytes: number
  txStalls: number
  rxStalls: number
}

export interface RunningLagProxy {
  readonly port: number
  readonly url: string
  stats(): LagProxyStats
  setConditions(patch: { rttMs?: number; jitterMs?: number; lossRate?: number }): void
  close(): Promise<void>
}

interface PipeState {
  tail: number
  timers: Set<NodeJS.Timeout>
}

export async function startLagProxy(opts: LagProxyOptions): Promise<RunningLagProxy> {
  let rttMs = Math.max(0, opts.rttMs ?? 150)
  let jitterMs = Math.max(0, opts.jitterMs ?? 10)
  let lossRate = Math.max(0, Math.min(1, opts.lossRate ?? 0.02))
  const rng = new Rng(opts.seed ?? 20261011)
  const wsPath = netJson.protocol.wsPath

  const counters: LagProxyStats = {
    connections: 0,
    txFrames: 0,
    rxFrames: 0,
    txBytes: 0,
    rxBytes: 0,
    txStalls: 0,
    rxStalls: 0,
  }

  const activePipes = new Set<PipeState>()
  const activeSockets = new Set<WebSocket>()

  function schedule(pipe: PipeState, dir: 'tx' | 'rx', fn: () => void): void {
    const t = performance.now()
    const baseDelay = rttMs / 2
    const jitter = jitterMs > 0 ? (rng.next() * 2 - 1) * jitterMs : 0
    let stall = 0
    if (lossRate > 0 && rng.next() < lossRate) {
      stall = Math.max(60, rttMs * (1 + rng.next() * 0.5))
      if (dir === 'tx') counters.txStalls++
      else counters.rxStalls++
    }
    const due = Math.max(t, pipe.tail, t + Math.max(0, baseDelay + jitter + stall))
    pipe.tail = due
    const waitMs = Math.max(0, Math.round(due - t))
    const timer = setTimeout(() => {
      pipe.timers.delete(timer)
      fn()
    }, waitMs)
    pipe.timers.add(timer)
  }

  function clearPipe(pipe: PipeState): void {
    for (const tm of pipe.timers) clearTimeout(tm)
    pipe.timers.clear()
    activePipes.delete(pipe)
  }

  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, rttMs, jitterMs, lossRate, ...counters }))
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: netJson.server.maxPayloadBytes })

  httpServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      counters.connections++
      const upPipe: PipeState = { tail: 0, timers: new Set() }
      const downPipe: PipeState = { tail: 0, timers: new Set() }
      activePipes.add(upPipe)
      activePipes.add(downPipe)
      activeSockets.add(clientWs)

      const upstreamWs = new WebSocket(opts.targetUrl)
      activeSockets.add(upstreamWs)
      const pendingUp: string[] = []

      upstreamWs.on('open', () => {
        for (const frame of pendingUp.splice(0)) {
          if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.send(frame)
        }
      })

      clientWs.on('message', (data, isBinary) => {
        if (isBinary) return
        const str = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')
        counters.txFrames++
        counters.txBytes += Buffer.byteLength(str, 'utf8')
        schedule(upPipe, 'tx', () => {
          if (upstreamWs.readyState === WebSocket.CONNECTING) pendingUp.push(str)
          else if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.send(str)
        })
      })

      upstreamWs.on('message', (data, isBinary) => {
        if (isBinary) return
        const str = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')
        counters.rxFrames++
        counters.rxBytes += Buffer.byteLength(str, 'utf8')
        schedule(downPipe, 'rx', () => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.send(str)
        })
      })

      const cleanup = (code = 1000) => {
        clearPipe(upPipe)
        clearPipe(downPipe)
        activeSockets.delete(clientWs)
        activeSockets.delete(upstreamWs)
        try { if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code) } catch { /* closing */ }
        try { if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) upstreamWs.close(code) } catch { /* closing */ }
      }

      clientWs.on('close', (code) => cleanup(code))
      upstreamWs.on('close', (code) => cleanup(code))
      clientWs.on('error', () => cleanup(1006))
      upstreamWs.on('error', () => cleanup(1006))
    })
  })

  await new Promise<void>((ok, fail) => {
    httpServer.once('error', fail)
    httpServer.listen(opts.listenPort, '127.0.0.1', () => {
      httpServer.off('error', fail)
      ok()
    })
  })
  const addr = httpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : opts.listenPort
  const url = `ws://127.0.0.1:${port}${wsPath}`

  return {
    port,
    url,
    stats: () => ({ ...counters }),
    setConditions(patch) {
      if (patch.rttMs !== undefined) rttMs = Math.max(0, patch.rttMs)
      if (patch.jitterMs !== undefined) jitterMs = Math.max(0, patch.jitterMs)
      if (patch.lossRate !== undefined) lossRate = Math.max(0, Math.min(1, patch.lossRate))
    },
    async close() {
      for (const p of [...activePipes]) clearPipe(p)
      for (const s of [...activeSockets]) {
        try { s.terminate() } catch { /* gone */ }
      }
      activeSockets.clear()
      wss.close()
      await new Promise<void>((ok) => {
        httpServer.close(() => ok())
        httpServer.closeAllConnections()
      })
    },
  }
}

const isMain = !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  const arg = (name: string, fallback: string): string => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
  }
  const listenPort = Number(arg('listen', '8789'))
  const targetUrl = arg('target', `ws://127.0.0.1:${netJson.server.defaultPort}${netJson.protocol.wsPath}`)
  const rttMs = Number(arg('rtt', '150'))
  const jitterMs = Number(arg('jitter', '10'))
  const lossRate = Number(arg('loss', '0.02'))
  const seed = Number(arg('seed', '20261011'))
  startLagProxy({ listenPort, targetUrl, rttMs, jitterMs, lossRate, seed }).then(
    (proxy) => {
      console.log(JSON.stringify({ url: proxy.url, targetUrl, rttMs, jitterMs, lossRate, seed }))
      const stop = () => { proxy.close().then(() => process.exit(0), () => process.exit(1)) }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    },
    (err: Error) => {
      console.error(`lagproxy failed: ${err.message}`)
      process.exit(1)
    },
  )
}
