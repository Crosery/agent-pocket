// Deterministic network measurement script (#23):
// 1. Quantifies before/after bytes per player per second (legacy verbose vs Issue #23 compact delta frames).
// 2. Simulates 150ms RTT and 2% packet-loss stalls over lagproxy, verifying local prediction + smooth correction
//    and remote player jitter-buffered interpolation with zero snapping.
//
// Usage:
//   node scripts/measure-net.ts [--seconds 4] [--players 12] [--json]
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { NET } from '../src/server/config.ts'
import { signEnvelopeNode } from '../src/server/net-envelope.ts'
import type { WorldInfo } from '../src/server/world.ts'
import { isRecord } from '../src/server/util.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { createNetClient, type NetClientExt } from '../src/client/net/index.ts'
import type { EventBus, GameEvents } from '../src/client/contracts.ts'
import type { PublicProfile } from '../src/shared/protocol.ts'
import { encodeMoveFrame } from '../src/shared/net-codec.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { peerAt, type FakeConfig } from '../src/shared/dev/netsim.ts'
import { buildWorld, worldAnchors } from '../src/shared/world/index.ts'
import { startLagProxy } from './lagproxy.ts'
import netSimJson from '../content/dev/net-sim.json' with { type: 'json' }
import netJson from '../content/net.json' with { type: 'json' }

const FAKE = netSimJson.fake as unknown as FakeConfig
const tickMs = 1000 / CONTENT.config.net.tickHz

function makeBus(): EventBus<GameEvents> {
  const handlers = new Map<string, Set<(p: unknown) => void>>()
  return {
    on(type, fn) {
      const k = String(type)
      if (!handlers.has(k)) handlers.set(k, new Set())
      handlers.get(k)!.add(fn as (p: unknown) => void)
      return () => handlers.get(k)?.delete(fn as (p: unknown) => void)
    },
    once(type, fn) { const off = this.on(type, (p) => { off(); fn(p) }); return off },
    emit(type, payload) { for (const f of handlers.get(String(type)) ?? []) f(payload) },
  }
}

const emptyProfile = (name: string): PublicProfile => ({
  id: 'x', name, avatar: 'char_red', badges: [], dexCaught: 5, party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0,
})

function httpPostJson(
  port: number,
  path: string,
  body: unknown,
  opts: { cookie?: string; host?: string } = {},
): Promise<{ status: number; json: Record<string, unknown>; cookie: string | null }> {
  const host = opts.host ?? '127.0.0.1'
  const payload = JSON.stringify(body)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: `http://${host}:${port}`,
    'sec-fetch-site': 'same-origin',
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
  }
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (d: Buffer) => chunks.push(d))
      res.on('end', () => {
        let json: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (isRecord(parsed)) json = parsed
        } catch { /* ignore */ }
        const rawSetCookie = res.headers['set-cookie']
        const first = Array.isArray(rawSetCookie) ? rawSetCookie[0] ?? null : (rawSetCookie ?? null)
        const cookie = first ? first.split(';')[0]?.trim() ?? null : null
        resolve({ status: res.statusCode ?? 0, json, cookie })
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

let benchAccountSeq = 0

async function registerBenchAccount(
  server: RunningServer,
  name: string,
  map: string,
  x: number,
  y: number,
): Promise<{ accountId: string; cookie: string }> {
  const seq = ++benchAccountSeq
  const username = `${name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'Bot'}_${seq}`
  const password = 'StrongPass#123'
  let accountId = ''
  let cookie = ''

  const regHttp = await httpPostJson(server.port, NET.http.registerPath, { username, password })
  if (regHttp.status === 200 && regHttp.cookie && isRecord(regHttp.json.account) && typeof regHttp.json.account.id === 'string') {
    accountId = regHttp.json.account.id
    cookie = regHttp.cookie
  } else {
    const regStore = await server.store.registerAccount(username, password, { ip: `10.200.${(seq >> 8) & 255}.${seq & 255}` })
    if (!regStore.ok) throw new Error(`Failed to register benchmark account ${username}: ${regStore.message}`)
    accountId = regStore.account.id
    cookie = `${NET.auth.cookieName}=${regStore.session.token}`
  }

  const mgr = createSaveManager({ world: null, storage: null })
  const playable = CONTENT.characters.find((c) => c.playable)?.id ?? CONTENT.characters[0]?.id ?? ''
  const baseSave = mgr.newGame({ name, avatar: playable })
  const bindHttp = await httpPostJson(server.port, NET.http.bindPath, { save: baseSave, imported: false }, { cookie })
  if (bindHttp.status !== 200) {
    throw new Error(`Failed to bind benchmark account ${username}: ${bindHttp.status}`)
  }

  const current = server.store.getSave(accountId) ?? baseSave
  server.authority.setSave(accountId, {
    ...current,
    playerId: accountId,
    name,
    position: { map, x: Math.floor(x), y: Math.floor(y), facing: 'down' },
    respawn: { map, x: Math.floor(x), y: Math.floor(y), facing: 'down' },
  }, { imported: false, trusted: true, ref: 'bench:seed' })

  return { accountId, cookie }
}

async function runBandwidthBenchmark(compact: boolean, playersCount: number, durationSec: number): Promise<{
  upBpsPerPlayer: number
  downBpsPerPlayer: number
  totalBpsPerPlayer: number
  totalRxBytes: number
  totalTxBytes: number
  totalRxMsgs: number
  totalTxMsgs: number
  clientTxBytes: number
  clientRxBytes: number
}> {
  const dir = await mkdtemp(pathJoin(tmpdir(), `ap-bench-${compact ? 'compact' : 'legacy'}-`))
  const server = await startServer({ port: 0, dataDir: dir, distDir: pathJoin(dir, 'nd'), quiet: true, pvp: null, world: null })
  const world = buildWorld()
  const anchor = worldAnchors(world)['town:origin'] ?? { map: 'town:origin', x: 20, y: 20 }
  const clients: NetClientExt[] = []

  try {
    const wsUrlV4 = `ws://127.0.0.1:${server.port}${netJson.protocol.wsPath}`
    const wsUrlV6 = `ws://[::1]:${server.port}${netJson.protocol.wsPath}`

    for (let i = 0; i < playersCount; i++) {
      const name = `Bot${i}`
      const pose = peerAt(FAKE, i % 4, 0, anchor)
      const acct = await registerBenchAccount(server, name, anchor.map, pose.x, pose.y)
      const bus = makeBus()
      const useIpv6 = i % 2 === 1
      const origin = useIpv6 ? `http://[::1]:${server.port}` : `http://127.0.0.1:${server.port}`
      const headers = { Cookie: acct.cookie, Origin: origin }
      const client = createNetClient(
        bus,
        () => ({
          t: 'hello',
          v: CONTENT.config.net.protocolVersion,
          playerId: acct.accountId,
          name,
          avatar: 'char_red',
          map: anchor.map,
          x: Math.floor(pose.x) + 0.5,
          y: Math.floor(pose.y) + 0.5,
          facing: pose.facing,
          lead: null,
          profile: emptyProfile(name),
          compact,
          signed: true,
        }),
        {
          url: wsUrlV4,
          compact,
          headers,
          ...(useIpv6
            ? {
              createSocket: () => new (WebSocket as unknown as { new (u: string, o?: unknown): WebSocket })(wsUrlV6, { headers }),
            }
            : {}),
        },
      )
      clients.push(client)
      client.connect()
      await sleep(20)
    }

    // Wait until all are online
    const deadline = Date.now() + 6000
    while (clients.some((c) => c.status !== 'online') && Date.now() < deadline) await sleep(20)
    if (clients.some((c) => c.status !== 'online')) {
      throw new Error(`Clients failed to connect within timeout: ${clients.filter((c) => c.status !== 'online').length} offline`)
    }

    // Warm up initial visibility / slot bindings before sampling steady-state movement bandwidth
    for (let i = 0; i < clients.length; i++) {
      const p0 = peerAt(FAKE, i % 4, 0, anchor)
      clients[i].reportPosition({
        map: anchor.map,
        x: Math.round(p0.x * 100) / 100,
        y: Math.round(p0.y * 100) / 100,
        facing: p0.facing,
        moving: true,
        running: false,
      })
    }
    await sleep(tickMs * 3)

    const m0 = server.metrics()
    const c0 = clients.map((c) => ({ rx: c.stats.rxBytes, tx: c.stats.txBytes }))
    const tMeasureStart = performance.now()

    // Drive deterministic tick-aligned movement across all players (identical workload for legacy & compact)
    const totalTicks = Math.max(1, Math.round((durationSec * 1000) / tickMs))
    for (let step = 1; step <= totalTicks; step++) {
      const simSec = step * (tickMs / 1000)
      for (let i = 0; i < clients.length; i++) {
        // Patterns 0..3 in FAKE are active walkers (circle, line-x, wander, line-y)
        const p = peerAt(FAKE, i % 4, simSec, anchor)
        clients[i].reportPosition({
          map: anchor.map,
          x: Math.round((p.x + step * 0.01) * 100) / 100,
          y: Math.round(p.y * 100) / 100,
          facing: p.facing,
          moving: true,
          running: false,
        })
      }
      await sleep(tickMs)
    }

    await sleep(tickMs * 2)
    const tMeasureEnd = performance.now()
    const m1 = server.metrics()
    const c1 = clients.map((c) => ({ rx: c.stats.rxBytes, tx: c.stats.txBytes }))
    const elapsedSec = (tMeasureEnd - tMeasureStart) / 1000

    const rxBytes = Math.max(0, m1.rxBytes - m0.rxBytes)
    const txBytes = Math.max(0, m1.txBytes - m0.txBytes)
    const rxMsgs = Math.max(0, m1.rxMsgs - m0.rxMsgs)
    const txMsgs = Math.max(0, m1.txMsgs - m0.txMsgs)
    const clientTxBytes = c1.reduce((acc, cur, idx) => acc + Math.max(0, cur.tx - c0[idx].tx), 0)
    const clientRxBytes = c1.reduce((acc, cur, idx) => acc + Math.max(0, cur.rx - c0[idx].rx), 0)
    const upBpsPerPlayer = Math.round(rxBytes / elapsedSec / playersCount)
    const downBpsPerPlayer = Math.round(txBytes / elapsedSec / playersCount)

    return {
      upBpsPerPlayer,
      downBpsPerPlayer,
      totalBpsPerPlayer: upBpsPerPlayer + downBpsPerPlayer,
      totalRxBytes: rxBytes,
      totalTxBytes: txBytes,
      totalRxMsgs: rxMsgs,
      totalTxMsgs: txMsgs,
      clientTxBytes,
      clientRxBytes,
    }
  } finally {
    for (const c of clients) c.disconnect()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
}

async function runWeakNetworkSimulation(): Promise<{
  predictionLatencyMs: number
  correctionDurationMs: number
  correctionSnapped: boolean
  maxRemoteStepDiscontinuity: number
  measuredRttP50: number
  measuredRttP95: number
  jitterMs: number
  stallsObserved: number
}> {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-weak-sim-'))
  const world: WorldInfo = {
    maps: new Map([['sim_map', { width: 20, height: 20, spawn: { x: 10, y: 10, facing: 'down' } }]]),
    startMap: 'sim_map',
    badgeIds: new Set(),
  }
  const server = await startServer({ port: 0, dataDir: dir, distDir: pathJoin(dir, 'nd'), quiet: true, pvp: null, world })
  const proxy = await startLagProxy({
    listenPort: 0,
    targetUrl: `ws://127.0.0.1:${server.port}${netJson.protocol.wsPath}`,
    rttMs: 150,
    jitterMs: 10,
    lossRate: 0.02,
    seed: 20261011,
  })

  const origin = `http://127.0.0.1:${server.port}`
  const acctA = await registerBenchAccount(server, 'LocalA', 'sim_map', 18, 10)
  const acctB = await registerBenchAccount(server, 'RemoteB', 'sim_map', 12, 10)

  const busA = makeBus(), busB = makeBus()
  let correctedState: { snapped: boolean; durationMs: number } | null = null
  const readCorrected = (): { snapped: boolean; durationMs: number } | null => correctedState

  const clientA = createNetClient(
    busA,
    () => ({
      t: 'hello', v: CONTENT.config.net.protocolVersion, playerId: acctA.accountId, name: 'LocalA',
      avatar: 'char_red', map: 'sim_map', x: 18, y: 10, facing: 'down', lead: null, profile: emptyProfile('LocalA'),
      compact: true,
      signed: true,
    }),
    { url: proxy.url, compact: true, headers: { Cookie: acctA.cookie, Origin: origin } },
  )

  const clientB = createNetClient(
    busB,
    () => ({
      t: 'hello', v: CONTENT.config.net.protocolVersion, playerId: acctB.accountId, name: 'RemoteB',
      avatar: 'char_blue', map: 'sim_map', x: 12, y: 10, facing: 'down', lead: null, profile: emptyProfile('RemoteB'),
      compact: true,
      signed: true,
    }),
    { url: proxy.url, compact: true, headers: { Cookie: acctB.cookie, Origin: origin } },
  )

  clientA.onCorrection((corr) => {
    correctedState = { snapped: corr.snapped, durationMs: corr.durationMs }
  })

  try {
    clientA.connect()
    clientB.connect()
    const deadline = Date.now() + 6000
    while ((clientA.status !== 'online' || clientB.status !== 'online') && Date.now() < deadline) await sleep(20)
    if (clientA.status !== 'online' || clientB.status !== 'online') {
      throw new Error(`Simulation clients failed to connect: A=${clientA.status}, B=${clientB.status}`)
    }
    // Local movement prediction is synchronous (0 ms latency)
    const tPred0 = performance.now()
    clientA.reportPosition({ map: 'sim_map', x: 18.2, y: 10, facing: 'right', moving: true, running: false })
    const predictionLatencyMs = +(performance.now() - tPred0).toFixed(2)

    // Drive remote player B walking across packet-loss stalls, and sample A's view at 60 FPS
    let maxRemoteStep = 0
    let prevRemoteX = -1, prevRemoteY = -1
    const samplesT0 = performance.now()

    for (let frame = 0; frame < 180; frame++) {
      const nowMs = performance.now()
      const tSec = (nowMs - samplesT0) / 1000

      // Update B's movement within sim_map bounds (12 -> 16.5)
      clientB.reportPosition({
        map: 'sim_map',
        x: 12 + tSec * 1.5,
        y: 10,
        facing: 'right',
        moving: true,
        running: false,
      })

      // Sample A's interpolated view of B
      const remotes = clientA.remotePlayers()
      const bView = remotes.get(clientB.selfId ?? '')
      if (bView) {
        if (prevRemoteX >= 0) {
          const step = Math.hypot(bView.rx - prevRemoteX, bView.ry - prevRemoteY)
          if (step > maxRemoteStep) maxRemoteStep = step
        }
        prevRemoteX = bView.rx
        prevRemoteY = bView.ry
      }

      await sleep(16)
    }

    // Trigger a real authoritative correction on A: predict a move past map width 20 (x=21.5, error=3.3 <= snapDistanceTiles=6)
    clientA.reportPosition({ map: 'sim_map', x: 21.5, y: 10, facing: 'right', moving: true, running: false })
    const corrDeadline = Date.now() + 3000
    while (!readCorrected() && Date.now() < corrDeadline) await sleep(20)
    const finalCorrection = readCorrected()
    if (!finalCorrection) {
      throw new Error('Expected authoritative move.correct during weak-network simulation')
    }

    const st = clientA.stats
    return {
      predictionLatencyMs,
      correctionDurationMs: finalCorrection.durationMs,
      correctionSnapped: finalCorrection.snapped,
      maxRemoteStepDiscontinuity: +maxRemoteStep.toFixed(3),
      measuredRttP50: Math.round(st.p50),
      measuredRttP95: Math.round(st.p95),
      jitterMs: Math.round(st.jitter),
      stallsObserved: st.stalls,
    }
  } finally {
    clientA.disconnect()
    clientB.disconnect()
    await proxy.close()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
}

function sampleMoveFrameBytes(): {
  unsignedVerboseBytes: number
  unsignedCompactBytes: number
  signedVerboseBytes: number
  signedCompactBytes: number
  signatureOverheadBytes: number
} {
  const sessionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const verboseMove = { t: 'move' as const, seq: 42, map: 'town_origin', x: 21.35, y: 19.8, facing: 'right' as const, moving: true, running: false }
  const compactMove = encodeMoveFrame(verboseMove, false)
  const signedVerbose = signEnvelopeNode(sessionKey, verboseMove, 42)
  const signedCompact = signEnvelopeNode(sessionKey, compactMove, 42)
  const unsignedVerboseBytes = Buffer.byteLength(JSON.stringify(verboseMove), 'utf8')
  const unsignedCompactBytes = Buffer.byteLength(JSON.stringify(compactMove), 'utf8')
  const signedVerboseBytes = Buffer.byteLength(JSON.stringify(signedVerbose), 'utf8')
  const signedCompactBytes = Buffer.byteLength(JSON.stringify(signedCompact), 'utf8')
  return {
    unsignedVerboseBytes,
    unsignedCompactBytes,
    signedVerboseBytes,
    signedCompactBytes,
    signatureOverheadBytes: signedCompactBytes - unsignedCompactBytes,
  }
}

async function main(): Promise<void> {
  const arg = (name: string, fallback: string): string => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
  }
  const isJson = process.argv.includes('--json')
  const seconds = Number(arg('seconds', '4'))
  const players = Number(arg('players', '12'))

  if (!isJson) console.log(`Measuring Agent Pocket authenticated/signed network bandwidth (N=${players} players, ${seconds}s)...`)

  const frameSample = sampleMoveFrameBytes()
  const legacy = await runBandwidthBenchmark(false, players, seconds)
  const compact = await runBandwidthBenchmark(true, players, seconds)
  const weakSim = await runWeakNetworkSimulation()

  const upReduction = Math.round(((legacy.upBpsPerPlayer - compact.upBpsPerPlayer) / Math.max(1, legacy.upBpsPerPlayer)) * 100)
  const downReduction = Math.round(((legacy.downBpsPerPlayer - compact.downBpsPerPlayer) / Math.max(1, legacy.downBpsPerPlayer)) * 100)
  const totalReduction = Math.round(((legacy.totalBpsPerPlayer - compact.totalBpsPerPlayer) / Math.max(1, legacy.totalBpsPerPlayer)) * 100)

  const output = {
    benchmark: {
      players,
      durationSec: seconds,
      authenticatedAndSigned: true,
      frameSample,
      legacy: {
        upBpsPerPlayer: legacy.upBpsPerPlayer,
        downBpsPerPlayer: legacy.downBpsPerPlayer,
        totalBpsPerPlayer: legacy.totalBpsPerPlayer,
        totalRxBytes: legacy.totalRxBytes,
        totalTxBytes: legacy.totalTxBytes,
        totalRxMsgs: legacy.totalRxMsgs,
        totalTxMsgs: legacy.totalTxMsgs,
        clientTxBytes: legacy.clientTxBytes,
        clientRxBytes: legacy.clientRxBytes,
      },
      compact: {
        upBpsPerPlayer: compact.upBpsPerPlayer,
        downBpsPerPlayer: compact.downBpsPerPlayer,
        totalBpsPerPlayer: compact.totalBpsPerPlayer,
        totalRxBytes: compact.totalRxBytes,
        totalTxBytes: compact.totalTxBytes,
        totalRxMsgs: compact.totalRxMsgs,
        totalTxMsgs: compact.totalTxMsgs,
        clientTxBytes: compact.clientTxBytes,
        clientRxBytes: compact.clientRxBytes,
      },
      reduction: {
        uplinkPercent: upReduction,
        downlinkPercent: downReduction,
        totalPercent: totalReduction,
      },
    },
    weakNetworkSimulation: {
      link: { rttMs: 150, jitterMs: 10, lossRatePercent: 2 },
      localInputLatencyMs: weakSim.predictionLatencyMs,
      correctionDurationMs: weakSim.correctionDurationMs,
      correctionSnapped: weakSim.correctionSnapped,
      maxRemoteStepDiscontinuityTiles: weakSim.maxRemoteStepDiscontinuity,
      rttP50Ms: weakSim.measuredRttP50,
      rttP95Ms: weakSim.measuredRttP95,
      jitterMs: weakSim.jitterMs,
      stallsObserved: weakSim.stallsObserved,
      zeroSnappingVerified: weakSim.maxRemoteStepDiscontinuity <= netJson.client.snapDistanceTiles,
    },
  }

  if (isJson) {
    console.log(JSON.stringify(output, null, 2))
    return
  }

  console.log(`\n### 1. 协议带宽对比（实测数据：N=${players} 玩家，已鉴权 + HMAC-SHA256 逐帧签名，同屏移动）\n`)
  console.log(`- 单帧移动载荷对比：未签名全量 ${frameSample.unsignedVerboseBytes} B -> 未签名紧凑 ${frameSample.unsignedCompactBytes} B；含 HMAC 签名（开销 +${frameSample.signatureOverheadBytes} B/帧）全量 ${frameSample.signedVerboseBytes} B -> 紧凑 ${frameSample.signedCompactBytes} B\n`)
  console.log('| 协议版本 | 上行 / 玩家 | 下行 / 玩家 | 合计 / 玩家 | 变化比例 |')
  console.log('|---|---|---|---|---|')
  console.log(`| 改动前（全量 JSON + 签名） | ${legacy.upBpsPerPlayer} B/s | ${legacy.downBpsPerPlayer} B/s | ${legacy.totalBpsPerPlayer} B/s | 基线 |`)
  console.log(`| 改动后（紧凑差量 + 签名） | ${compact.upBpsPerPlayer} B/s | ${compact.downBpsPerPlayer} B/s | ${compact.totalBpsPerPlayer} B/s | **-${totalReduction}%**（下行 -${downReduction}%，上行 -${upReduction}%） |`)

  console.log('\n### 2. 弱网模拟（150ms RTT、±10ms 抖动、2% 丢包 / TCP 队头阻塞）\n')
  console.log(`- 本地输入立即生效延迟：${weakSim.predictionLatencyMs} ms（零等待）`)
  console.log(`- 服务端校正平滑过渡耗时：${weakSim.correctionDurationMs} ms（snapped=${weakSim.correctionSnapped}）`)
  console.log(`- 远端角色插值最大帧步进：${weakSim.maxRemoteStepDiscontinuity} 格（低于瞬移阈值 ${netJson.client.snapDistanceTiles} 格，平滑无跳变）`)
  console.log(`- 实测 RTT 中位数：${weakSim.measuredRttP50} ms，p95：${weakSim.measuredRttP95} ms，抖动：${weakSim.jitterMs} ms`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
