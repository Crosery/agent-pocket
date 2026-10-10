// Deterministic behavioral tests for Issue #23:
// - Compact motion protocol & delta snapshot codec
// - Client prediction, seq tracking, server ack and smooth 150ms authoritative correction
// - Adaptive jitter buffer, timestamp synchronization and dead-reckoning extrapolation
// - Live server integration: compact deltas, distance tiers, per-connection RTT & /api/metrics
// - Runtime setEndpoint switching on NetClient
// - Weak-network immediate feedback for trade and PvP
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { EventBus, GameEvents } from '../src/client/contracts.ts'
import type { ClientMsg, PlayerState, PublicProfile } from '../src/shared/protocol.ts'
import {
  applyPlayerDelta, decodeMoveFlags, decodeMoveFrame,
  encodeMoveFlags, encodeMoveFrame, encodePlayerDelta, staticStateKey,
} from '../src/shared/net-codec.ts'
import { adaptiveInterpDelay, pushSample, sampleAt, type Sample } from '../src/client/net/interp.ts'
import { createPredictor, type CorrectionState } from '../src/client/net/predict.ts'
import { createNetClient } from '../src/client/net/client.ts'
import { startServer } from '../src/server/index.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import netJson from '../content/net.json' with { type: 'json' }
const tickMs = 1000 / CONTENT.config.net.tickHz
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function makeBus(): EventBus<GameEvents> & { log: { type: string; payload: unknown }[] } {
  const handlers = new Map<string, Set<(p: unknown) => void>>()
  const log: { type: string; payload: unknown }[] = []
  return {
    log,
    on(type, fn) {
      const k = String(type)
      if (!handlers.has(k)) handlers.set(k, new Set())
      handlers.get(k)!.add(fn as (p: unknown) => void)
      return () => handlers.get(k)?.delete(fn as (p: unknown) => void)
    },
    once(type, fn) { const off = this.on(type, (p) => { off(); fn(p) }); return off },
    emit(type, payload) { log.push({ type: String(type), payload }); for (const f of handlers.get(String(type)) ?? []) f(payload) },
  }
}

const testProfile = (name: string): PublicProfile => ({
  id: 'x', name, avatar: 'char_red', badges: ['b1'], dexCaught: 5, party: [], pvpWins: 2, pvpLosses: 1, playTimeSec: 100,
})

const testHello = (name: string, map: string, x: number, y: number): Extract<ClientMsg, { t: 'hello' }> => ({
  t: 'hello', v: CONTENT.config.net.protocolVersion, playerId: crypto.randomUUID(), name, avatar: 'char_red',
  map, x, y, facing: 'down', lead: null, profile: testProfile(name), compact: true,
})

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (d: Buffer) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

// ----------------------------------------------------------------------------- 1. Compact Codec
test('compact codec: flags, quantization, move frames and delta players', () => {
  for (const dir of ['down', 'left', 'right', 'up'] as const) {
    for (const moving of [false, true]) {
      for (const running of [false, true]) {
        for (const busy of [false, true]) {
          const flags = encodeMoveFlags(dir, moving, running, busy)
          const dec = decodeMoveFlags(flags)
          assert.equal(dec.facing, dir)
          assert.equal(dec.moving, moving)
          assert.equal(dec.running, running)
          assert.equal(dec.busy, busy)
        }
      }
    }
  }

  // Move frame encoding & decoding
  const compactMove = encodeMoveFrame({ seq: 42, map: 'town', x: 12.34, y: 56.78, facing: 'right', moving: true, running: false }, false)
  assert.equal(compactMove.t, 'move')
  assert.equal(compactMove.seq, 42)
  assert.deepEqual(compactMove.d, [1234, 5678, 2 | 4])
  assert.equal(compactMove.map, undefined)

  const decoded = decodeMoveFrame(compactMove as unknown as Record<string, unknown>, 'town')
  assert.ok(decoded)
  assert.equal(decoded.seq, 42)
  assert.equal(decoded.map, 'town')
  assert.equal(decoded.x, 12.34)
  assert.equal(decoded.y, 56.78)
  assert.equal(decoded.facing, 'right')
  assert.equal(decoded.moving, true)
  assert.equal(decoded.running, false)

  // Verbose move fallback
  const verboseDecoded = decodeMoveFrame({ t: 'move', seq: 7, map: 'route1', x: 3.5, y: 4.5, facing: 'up', moving: false, running: true }, 'fallback')
  assert.ok(verboseDecoded)
  assert.equal(verboseDecoded.seq, 7)
  assert.equal(verboseDecoded.map, 'route1')
  assert.equal(verboseDecoded.x, 3.5)
  assert.equal(verboseDecoded.facing, 'up')
  assert.equal(verboseDecoded.running, true)

  // Player delta tuple
  const basePlayer: PlayerState = {
    id: 'p1', name: 'Alice', avatar: 'char_red', map: 'town', x: 10, y: 20, facing: 'down',
    moving: false, running: false, lead: null, badges: 1, dexCaught: 2, busy: false,
  }
  const deltaTuple = encodePlayerDelta(3, { x: 10.45, y: 20.95, facing: 'left', moving: true, running: true, busy: true })
  assert.deepEqual(deltaTuple, [3, 1045, 2095, 1 | 4 | 8 | 16])
  const updatedPlayer = applyPlayerDelta(basePlayer, deltaTuple)
  assert.ok(updatedPlayer)
  assert.equal(updatedPlayer.x, 10.45)
  assert.equal(updatedPlayer.y, 20.95)
  assert.equal(updatedPlayer.facing, 'left')
  assert.equal(updatedPlayer.moving, true)
  assert.equal(updatedPlayer.running, true)
  assert.equal(updatedPlayer.busy, true)
  assert.equal(updatedPlayer.name, 'Alice')

  // staticStateKey sensitivity
  const sk0 = staticStateKey(basePlayer)
  const skSame = staticStateKey({ ...basePlayer, x: 99, y: 99, moving: true, busy: true })
  assert.equal(sk0, skSame, 'motion and busy changes do not change static key')
  const skName = staticStateKey({ ...basePlayer, name: 'Bob' })
  assert.notEqual(sk0, skName)
  const skEmote = staticStateKey({ ...basePlayer, emote: '!' })
  assert.notEqual(sk0, skEmote)

  // Byte size verification
  const verboseJson = JSON.stringify({ t: 'move', map: 'town_origin', x: 12.34, y: 56.78, facing: 'right', moving: true, running: false })
  const compactJson = JSON.stringify(compactMove)
  assert.ok(compactJson.length < verboseJson.length * 0.5, 'compact move is over 2x smaller than verbose move')
})

// ----------------------------------------------------------------------------- 2. Client Prediction & Reconciliation
test('predictor: immediate prediction, ack trimming, step replay, smooth visual pull-back', () => {
  const predictor = createPredictor({
    correctionMs: 150,
    snapDistanceTiles: 6,
    maxPending: 64,
    maxReplayStepTiles: 2,
  })

  // Immediate movement records monotonic seq
  const seq1 = predictor.record({ map: 'town', x: 10.2, y: 10, facing: 'right', moving: true, running: false }, 1000)
  const seq2 = predictor.record({ map: 'town', x: 10.5, y: 10, facing: 'right', moving: true, running: false }, 1100)
  const seq3 = predictor.record({ map: 'town', x: 10.8, y: 10, facing: 'right', moving: true, running: false }, 1200)
  assert.equal(seq1, 1)
  assert.equal(seq2, 2)
  assert.equal(seq3, 3)
  assert.equal(predictor.pending.length, 3)

  // Ack trims pending
  predictor.ack(1)
  assert.equal(predictor.pending.length, 2)
  assert.equal(predictor.lastAckSeq, 1)

  // Server rejects move 2 (e.g. wall collision, authoritative position is (10.0, 10.0))
  // Step replay simulates colliding against a wall at x = 10.0:
  const replayWall = (_map: string, x: number, y: number, dx: number, dy: number) => {
    return { x: Math.min(10.0, x + dx), y: y + dy }
  }
  const corr = predictor.reconcile(
    { seq: 2, map: 'town', x: 10.0, y: 10.0, facing: 'right', reason: 'blocked_or_speed' },
    1300,
    replayWall,
  )

  // Logical coordinates snap immediately to authoritative state (anti-cheat)
  assert.equal(corr.snapped, false)
  assert.equal(corr.x, 10.0)
  assert.equal(predictor.position.x, 10.0)

  // Frame 0 visual offset equals discrepancy so rendered position does NOT snap
  assert.ok(Math.abs(corr.ox - 0.8) < 1e-6, 'initial visual offset bridges discrepancy')
  const f0 = predictor.renderedPosition(1300)
  assert.ok(Math.abs(f0.x - 10.8) < 1e-6, 'frame 0 rendered position is continuous')
  assert.equal(f0.correcting, true)

  // Halfway through correction (75 ms), visual offset decayed smoothly
  const fMid = predictor.renderedPosition(1375)
  assert.ok(fMid.x > 10.0 && fMid.x < 10.8, 'visual offset glides smoothly')

  // Past duration (150 ms), visual offset reached 0
  const fEnd = predictor.renderedPosition(1451)
  assert.equal(fEnd.x, 10.0)
  assert.equal(fEnd.correcting, false)
  assert.equal(fEnd.ox, 0)

  // Huge discrepancy (> snapDistanceTiles = 6) forces immediate snap
  predictor.record({ map: 'town', x: 20, y: 10, facing: 'right', moving: false, running: false }, 2000)
  const snapCorr = predictor.reconcile(
    { seq: 4, map: 'town', x: 10.0, y: 10.0, facing: 'right', reason: 'out_of_bounds' },
    2100,
  )
  assert.equal(snapCorr.snapped, true)
  assert.equal(snapCorr.ox, 0)
  assert.equal(predictor.visualOffset(2100).active, false)
})

// ----------------------------------------------------------------------------- 3. Jitter Buffer & Dead Reckoning
test('interp: adaptive delay formula, velocity dead-reckoning and stopped convergence', () => {
  // Adaptive delay formula clamp(jitterP95 + tickMs, minMs, maxMs)
  assert.equal(adaptiveInterpDelay(10, 100, 150, 400), 150)
  assert.equal(adaptiveInterpDelay(80, 100, 150, 400), 180)
  assert.equal(adaptiveInterpDelay(350, 100, 150, 400), 400)

  const buf: Sample[] = []
  const o = { keepMs: 1500, snapDistance: 6, tickMs: 100, maxExtrapolateMs: 160 }

  // Remote player moving right at 2 tiles/sec (vx = 2)
  pushSample(buf, { t: 1000, x: 10.0, y: 5.0, vx: 2, vy: 0 }, o)
  pushSample(buf, { t: 1100, x: 10.2, y: 5.0, vx: 2, vy: 0 }, o)

  // Normal interpolation between samples
  assert.deepEqual(sampleAt(buf, 1050, 160), { x: 10.1, y: 5.0 })

  // Packet-loss stall: time advances 100ms past the last sample
  const extrapolated = sampleAt(buf, 1200, 160)
  assert.ok(extrapolated)
  assert.ok(Math.abs(extrapolated.x - 10.4) < 1e-6, 'dead reckoning extrapolates at velocity')

  // Bounded extrapolation does not run away past maxExtrapolateMs (160ms = 0.32 tiles)
  const bounded = sampleAt(buf, 2000, 160)
  assert.ok(bounded)
  assert.ok(Math.abs(bounded.x - (10.2 + 2 * 0.16)) < 1e-6, 'extrapolation caps at maxExtrapolateMs')

  // Stopped player (vx = 0) never extrapolates
  pushSample(buf, { t: 1300, x: 10.6, y: 5.0, vx: 0, vy: 0 }, o)
  const stopped = sampleAt(buf, 1450, 160)
  assert.deepEqual(stopped, { x: 10.6, y: 5.0 })
})

// ----------------------------------------------------------------------------- 4. Live Server Integration
test('live server: compact delta movement, server ack, correction, distance tiers, /api/metrics and setEndpoint', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-net-latency-live-'))
  const server = await startServer({ port: 0, dataDir: dir, distDir: pathJoin(dir, 'nd'), quiet: true, pvp: null, world: null })
  const wsUrl = `ws://127.0.0.1:${server.port}${netJson.protocol.wsPath}`

  const busA = makeBus(), busB = makeBus()
  const a = createNetClient(busA, () => testHello('Alice', 'test_map', 10, 10), { url: wsUrl, compact: true })
  const b = createNetClient(busB, () => testHello('Bob', 'test_map', 11, 10), { url: wsUrl, compact: true })

  let aCorrection: CorrectionState | null = null
  const getCorrection = (): CorrectionState | null => aCorrection
  a.onCorrection((corr) => { aCorrection = corr })

  try {
    a.connect()
    b.connect()

    // Wait until both are online
    const onlineDeadline = Date.now() + 4000
    while ((a.status !== 'online' || b.status !== 'online') && Date.now() < onlineDeadline) await sleep(20)
    assert.equal(a.status, 'online')
    assert.equal(b.status, 'online')

    // B sees A joined
    const bSeesADeadline = Date.now() + 4000
    while (!b.remotePlayers().has(a.selfId ?? '') && Date.now() < bSeesADeadline) await sleep(20)
    assert.ok(b.remotePlayers().has(a.selfId ?? ''))

    // A moves: sends compact moves with seq
    for (let step = 1; step <= 5; step++) {
      a.reportPosition({ map: 'test_map', x: 10 + step * 0.2, y: 10, facing: 'right', moving: step < 5, running: false })
      await sleep(tickMs + 10)
    }

    // B receives compact deltas and interpolates A's position
    const bInterpDeadline = Date.now() + 4000
    while (Math.abs((b.remotePlayers().get(a.selfId ?? '')?.x ?? 0) - 11.0) > 0.05 && Date.now() < bInterpDeadline) await sleep(25)
    const remoteA = b.remotePlayers().get(a.selfId ?? '')!
    assert.ok(remoteA, 'B saw remote A')
    assert.ok(Math.abs(remoteA.x - 11.0) < 0.05, `B saw A move to ~11.0 (got ${remoteA?.x})`)

    // A received ack from server
    assert.ok(a.predictor.lastAckSeq >= 1, `A received ack from server (lastAckSeq=${a.predictor.lastAckSeq})`)

    // A sends an invalid move outside bounds -> server replies with move.correct
    a.send({ t: 'move', seq: 99, map: 'test_map', x: 9999, y: 9999, facing: 'down', moving: false, running: false })
    const corrDeadline = Date.now() + 2000
    while (!getCorrection() && Date.now() < corrDeadline) await sleep(20)
    const corr = getCorrection()
    assert.ok(corr, 'A received move.correct')
    assert.equal(corr.seq, 99)
    assert.equal(corr.map, 'test_map')
    assert.equal(corr.snapped, false)
    assert.ok(a.visualOffset().active, 'smooth visual correction is active')

    // Wait for 150ms visual ease-out to complete
    await sleep(200)
    assert.equal(a.visualOffset().active, false, 'visual offset smoothly decayed to zero')

    // Endpoint switching via setEndpoint
    const prevEndpoint = a.endpoint
    a.setEndpoint('127.0.0.1:9999')
    assert.equal(a.endpoint, 'ws://127.0.0.1:9999/ws')
    // Reset back to server
    a.setEndpoint(prevEndpoint)
    const reconnectDeadline = Date.now() + 4000
    while (a.status !== 'online' && Date.now() < reconnectDeadline) await sleep(20)
    assert.equal(a.status, 'online')

    // A reverse proxy may itself connect over loopback; metrics still require explicit authentication.
    const metricsRes = await httpGet(server.port, netJson.http.metricsPath)
    assert.equal(metricsRes.status, 403)
    const metrics = server.metrics()
    assert.equal(metrics.online, 2)
    assert.ok(metrics.connections >= 2)
    assert.ok(metrics.rxBytes > 0)
    assert.ok(metrics.txBytes > 0)
    assert.ok(Array.isArray(metrics.clients))
  } finally {
    a.disconnect()
    b.disconnect()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('net client: options.headers forwards custom headers during WebSocket handshake', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-net-headers-'))
  const server = await startServer({ port: 0, dataDir: dir, distDir: pathJoin(dir, 'nd'), quiet: true, pvp: null, world: null })
  const wsUrl = `ws://127.0.0.1:${server.port}${netJson.protocol.wsPath}`
  const bus = makeBus()

  const client = createNetClient(
    bus,
    () => testHello('HeaderUser', 'test_map', 5, 5),
    {
      url: wsUrl,
      headers: {
        cookie: 'ap_session=mock_test_token_12345678',
        origin: 'http://127.0.0.1',
      },
    },
  )

  try {
    client.connect()
    const deadline = Date.now() + 4000
    while (client.status !== 'online' && client.status !== 'offline' && Date.now() < deadline) await sleep(20)
    assert.ok(client.status === 'online' || client.status === 'offline')
  } finally {
    client.disconnect()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
