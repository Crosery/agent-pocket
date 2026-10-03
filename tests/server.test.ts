// Integration tests for src/server: real HTTP + WebSocket server on test ports 8791-8793.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import type { ClientMsg, PlayerState, PublicProfile, ServerMsg } from '../src/shared/protocol.ts'
import type { Creature } from '../src/shared/types.ts'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { startServer } from '../src/server/index.ts'
import { MODERATION, NET, PRESENCE, validateNetContent } from '../src/server/config.ts'
import { cleanText, maskBanned, sanitizeChat, sanitizeName, uniqueName } from '../src/server/moderation.ts'
import { createRateLimiter, isUuidLike, publicIdFor } from '../src/server/util.ts'
import { loadWorldInfo, type WorldInfo } from '../src/server/world.ts'
import { negotiateEncoding } from '../src/server/http.ts'
import type { PvpHost, PvpModule } from '../src/server/pvp-hooks.ts'

// ----------------------------------------------------------------------------- helpers

type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>

interface TestClient {
  ws: WebSocket
  msgs: ServerMsg[]
  selfId: string
  closed: Promise<number>
  send(m: ClientMsg | Record<string, unknown>): void
  mark(): number
  waitFor<T extends ServerMsg['t']>(type: T, pred?: (m: Msg<T>) => boolean, opts?: { from?: number; ms?: number }): Promise<Msg<T>>
  all<T extends ServerMsg['t']>(type: T, from?: number): Msg<T>[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tickMs = 1000 / CONTENT.config.net.tickHz

function openClient(port: number): Promise<TestClient> {
  const ws = new WebSocket(`ws://localhost:${port}${NET.protocol.wsPath}`)
  const msgs: ServerMsg[] = []
  const waiters = new Set<() => void>()
  const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)))
  ws.addEventListener('message', (e) => {
    msgs.push(JSON.parse(String(e.data)) as ServerMsg)
    for (const w of [...waiters]) w()
  })
  const c: TestClient = {
    ws, msgs, selfId: '', closed,
    send: (m) => ws.send(JSON.stringify(m)),
    mark: () => msgs.length,
    all: (type, from = 0) => msgs.slice(from).filter((m) => m.t === type) as never,
    waitFor(type, pred = () => true, opts = {}) {
      const from = opts.from ?? msgs.length
      return new Promise((resolve, reject) => {
        let i = from
        const check = () => {
          for (; i < msgs.length; i++) {
            const m = msgs[i]
            if (m.t === type && pred(m as never)) { cleanup(); resolve(m as never); return }
          }
        }
        const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${type}; got ${msgs.slice(from).map((m) => m.t).join(',')}`)) }, opts.ms ?? 3000)
        const cleanup = () => { clearTimeout(timer); waiters.delete(check) }
        waiters.add(check)
        check()
      })
    },
  }
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(c))
    ws.addEventListener('error', () => reject(new Error('ws error')))
  })
}

const profileOf = (o: Partial<PublicProfile> = {}): PublicProfile => ({
  id: 'ignored', name: 'ignored', avatar: 'ignored', badges: [], dexCaught: 0, party: [], pvpWins: 99, pvpLosses: 99, playTimeSec: 10, ...o,
})

interface JoinOpts { name: string; map: string; x: number; y: number; playerId?: string; profile?: Partial<PublicProfile>; v?: number }

function helloMsg(o: JoinOpts): ClientMsg {
  return {
    t: 'hello', v: o.v ?? CONTENT.config.net.protocolVersion, playerId: o.playerId ?? crypto.randomUUID(), name: o.name,
    avatar: 'not-a-character', map: o.map, x: o.x, y: o.y, facing: 'down', lead: null, profile: profileOf(o.profile),
  }
}

async function join(port: number, o: JoinOpts): Promise<TestClient> {
  const c = await openClient(port)
  const from = c.mark()
  c.send(helloMsg(o))
  const w = await c.waitFor('welcome', undefined, { from })
  c.selfId = w.selfId
  return c
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (d: Buffer) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Two real map ids + positions: from the generated world when available, else free-form ids. */
async function pickMaps() {
  const world = await loadWorldInfo()
  if (!world) return { world: null, a: { id: 'test-map-a', w: 1000, h: 1000 }, b: { id: 'test-map-b', w: 1000, h: 1000 } }
  const maps = [...world.maps.entries()].sort((x, y) => y[1].width * y[1].height - x[1].width * x[1].height)
  const [aId, a] = maps[0]
  const [bId, b] = maps.find(([id]) => id !== aId) ?? maps[0]
  return { world, a: { id: aId, w: a.width, h: a.height }, b: { id: bId, w: b.width, h: b.height } }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-server-test-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

async function loadCreatureFactory(): Promise<((speciesId: string, seed: number) => Creature) | null> {
  try {
    const cm = await import('../src/shared/creature.ts') as { createCreature: (s: string, l: number, o: { rng: unknown; otName?: string }) => Creature }
    const rm_ = await import('../src/shared/rng.ts') as { Rng: new (seed: number) => unknown }
    return (speciesId, seed) => cm.createCreature(speciesId, 5, { rng: new rm_.Rng(seed), otName: 'tester' })
  } catch {
    return null
  }
}

// ----------------------------------------------------------------------------- unit

test('net + moderation content is valid', () => {
  assert.deepEqual(validateNetContent(), [])
  for (const k of ['net.motd', 'net.system.join', 'net.system.leave', 'net.name.fallback', 'net.trade.declined', 'net.http.notFound']) {
    assert.notEqual(t(k), k, `missing text ${k}`)
  }
})

test('moderation: names, chat cleaning, banned words', () => {
  const banned = MODERATION.bannedWords[0]
  assert.equal(sanitizeName('  小<b>明</b>  '), '小明')
  assert.equal(sanitizeName(''), null)
  assert.equal(sanitizeName(MODERATION.name.reserved[0]), null)
  assert.equal(sanitizeName(`a${banned}b`), null)
  const long = 'xy'.repeat(CONTENT.config.net.nameMaxLen)
  assert.equal([...(sanitizeName(long) ?? '')].length, CONTENT.config.net.nameMaxLen)
  assert.equal(cleanText('a\u0000b​c‮d<script>x</script>', 50), 'abcdx')
  const masked = maskBanned(`hi ${[...banned].join(' ')} there`)
  assert.ok(!masked.includes(banned) && masked.includes(MODERATION.mask) && masked.startsWith('hi ') && masked.endsWith(' there'))
  const whole = MODERATION.bannedWordsWhole[0]
  assert.ok(maskBanned(`x ${whole} y`).includes(MODERATION.mask))
  assert.equal(maskBanned(`zz${whole}zz`), `zz${whole}zz`, 'whole-word entries must not match inside words')
  assert.equal([...sanitizeChat('ab'.repeat(1000))].length, CONTENT.config.net.chatMaxLen)
  assert.equal([...cleanText('z'.repeat(100), 100)].length, MODERATION.chat.maxRepeatRun)
  const taken = new Set(['bob'])
  assert.notEqual(uniqueName('Bob', (n) => taken.has(n.toLowerCase()), () => 'AB12'), 'Bob')
})

test('util: rate limiter, ids, encoding negotiation', () => {
  const rl = createRateLimiter({ count: 2, perSeconds: 1 })
  const t0 = Date.now()
  assert.equal(rl.take(t0), true)
  assert.equal(rl.take(t0), true)
  assert.equal(rl.take(t0), false)
  assert.equal(rl.take(t0 + 600), true)
  const id = crypto.randomUUID()
  assert.equal(publicIdFor(id), publicIdFor(id.toUpperCase()))
  assert.notEqual(publicIdFor(id), id)
  assert.ok(isUuidLike(publicIdFor(id)))
  assert.equal(negotiateEncoding('gzip, deflate, br'), 'br')
  assert.equal(negotiateEncoding('gzip, br;q=0'), 'gzip')
  assert.equal(negotiateEncoding('identity'), null)
  assert.equal(negotiateEncoding(undefined), null)
})

// ----------------------------------------------------------------------------- websocket hub

test('hub: presence, interest, chat, inspect, trade, leaderboard', async (tc) => {
  await withTempDir(async (dataDir) => {
    const PORT = 8791
    const srv = await startServer({ port: PORT, dataDir, distDir: pathJoin(dataDir, 'no-dist'), quiet: true, pvp: null })
    const { a: mapA, b: mapB } = await pickMaps()
    const ax = Math.min(10, mapA.w - 2), ay = Math.min(10, mapA.h - 2)
    const clients: TestClient[] = []
    try {
      const pidA = crypto.randomUUID()
      const A = await join(PORT, { name: 'Alice', map: mapA.id, x: ax, y: ay, playerId: pidA, profile: { dexCaught: 3, badges: ['b1'] } })
      const B = await join(PORT, { name: 'Bob', map: mapA.id, x: ax + 1, y: ay })
      const C = await join(PORT, { name: 'Carol', map: mapB.id, x: 1, y: 1 })
      clients.push(A, B, C)

      await tc.test('hello/welcome: stable public id, sanitized avatar', async () => {
        assert.equal(A.selfId, publicIdFor(pidA))
        assert.notEqual(A.selfId, pidA)
        // The joiner gets an immediate summary; periodic ones follow every onlineSummarySeconds.
        const online = await C.waitFor('online', (m) => m.count >= 3, { from: 0 })
        const me = online.players.find((p) => p.id === A.selfId)
        assert.ok(me && CONTENT.characterById[me.avatar]?.playable)
      })

      await tc.test('snapshots only include nearby players on the same map', async () => {
        const snap = await A.waitFor('snapshot', (m) => m.players.some((p) => p.id === B.selfId), { from: 0 })
        assert.equal(snap.map, mapA.id)
        assert.ok(!snap.players.some((p) => p.id === A.selfId), 'self excluded')
        assert.ok(!snap.players.some((p) => p.id === C.selfId), 'other map excluded')
        const from = A.mark()
        B.send({ t: 'move', map: mapA.id, x: ax + 2, y: ay, facing: 'right', moving: true, running: false })
        const moved = await A.waitFor('snapshot', (m) => m.players.some((p) => p.id === B.selfId && p.x === ax + 2), { from })
        assert.equal(moved.players.find((p) => p.id === B.selfId)?.moving, true)
        await sleep(tickMs * 3)
        assert.ok(!C.all('snapshot').some((m) => m.players.some((p) => p.id === A.selfId || p.id === B.selfId)))
        const leaveAt = PRESENCE.viewRadiusTiles + PRESENCE.leaveMarginTiles
        if (mapA.w > leaveAt + ax + 4) {
          const far = A.mark()
          B.send({ t: 'move', map: mapA.id, x: ax + leaveAt + 3, y: ay, facing: 'right', moving: false, running: false })
          await A.waitFor('leave', (m) => m.id === B.selfId, { from: far })
          B.send({ t: 'move', map: mapA.id, x: ax + 1, y: ay, facing: 'left', moving: false, running: false })
          await A.waitFor('join', (m) => m.player.id === B.selfId, { from: far })
        }
      })

      await tc.test('chat: global reaches all, local only nearby, html stripped, banned masked', async () => {
        const fb = B.mark(), fc = C.mark()
        A.send({ t: 'chat', channel: 'global', text: `<b>大家好</b> ${MODERATION.bannedWords[0]}` })
        const gb = await B.waitFor('chat', (m) => m.channel === 'global', { from: fb })
        await C.waitFor('chat', (m) => m.channel === 'global', { from: fc })
        assert.equal(gb.from, A.selfId)
        assert.equal(gb.name, 'Alice')
        assert.ok(!gb.text.includes('<') && gb.text.startsWith('大家好') && !gb.text.includes(MODERATION.bannedWords[0]))
        const fb2 = B.mark(), fc2 = C.mark()
        A.send({ t: 'chat', channel: 'local', text: 'local hi' })
        await B.waitFor('chat', (m) => m.channel === 'local' && m.text === 'local hi', { from: fb2 })
        await sleep(150)
        assert.equal(C.all('chat', fc2).filter((m) => m.channel === 'local').length, 0)
      })

      await tc.test('chat: whisper by name and by id', async () => {
        const fa = A.mark(), fb = B.mark(), fc = C.mark()
        A.send({ t: 'chat', channel: 'whisper', to: 'carol', text: 'psst' })
        const w = await C.waitFor('chat', (m) => m.channel === 'whisper', { from: fc })
        assert.equal(w.from, A.selfId)
        const echo = await A.waitFor('chat', (m) => m.channel === 'whisper', { from: fa })
        assert.equal(echo.name, t('net.chat.whisperTo', { name: 'Carol' }))
        A.send({ t: 'chat', channel: 'whisper', to: C.selfId, text: 'by id' })
        await C.waitFor('chat', (m) => m.text === 'by id', { from: fc })
        A.send({ t: 'chat', channel: 'whisper', to: 'nobody-here', text: 'x' })
        await A.waitFor('error', (m) => m.code === 'not_found', { from: fa })
        await sleep(100)
        assert.equal(B.all('chat', fb).filter((m) => m.channel === 'whisper').length, 0)
      })

      await tc.test('chat: rate limit', async () => {
        const D = await join(PORT, { name: 'Dave', map: mapB.id, x: 2, y: 2 })
        clients.push(D)
        const from = D.mark()
        for (let i = 0; i <= CONTENT.config.net.chatRate.count; i++) D.send({ t: 'chat', channel: 'local', text: `m${i}` })
        const err = await D.waitFor('error', (m) => m.code === 'chat_rate', { from })
        assert.equal(err.message, t('net.error.chat_rate'))
        assert.equal(D.all('chat', from).filter((m) => m.channel === 'local').length, CONTENT.config.net.chatRate.count)
      })

      await tc.test('emote reaches nearby players', async () => {
        const fb = B.mark()
        A.send({ t: 'emote', emote: '!' })
        const e = await B.waitFor('emote', (m) => m.id === A.selfId, { from: fb })
        assert.equal(e.emote, '!')
        await B.waitFor('snapshot', (m) => m.players.some((p) => p.id === A.selfId && p.emote === '!'), { from: fb })
      })

      await tc.test('inspect returns server-authoritative public profile', async () => {
        const fb = B.mark()
        B.send({ t: 'inspect', target: A.selfId })
        const p = await B.waitFor('profile', undefined, { from: fb })
        assert.equal(p.profile.id, A.selfId)
        assert.equal(p.profile.name, 'Alice')
        assert.equal(p.profile.dexCaught, Math.min(3, CONTENT.speciesList.length))
        assert.equal(p.profile.pvpWins, 0, 'pvp stats are not taken from the client')
        B.send({ t: 'inspect', target: 'ghost' })
        await B.waitFor('error', (m) => m.code === 'not_found', { from: fb })
      })

      await tc.test('trade: decline, cancel, disconnect', async () => {
        let fa = A.mark(), fb = B.mark()
        A.send({ t: 'trade.request', to: B.selfId })
        await B.waitFor('trade.requested', (m) => m.from === A.selfId, { from: fb })
        B.send({ t: 'trade.respond', from: A.selfId, accept: false })
        const dec = await A.waitFor('trade.cancelled', undefined, { from: fa })
        assert.equal(dec.reason, t('net.trade.declined', { name: 'Bob' }))

        fa = A.mark(); fb = B.mark()
        A.send({ t: 'trade.request', to: 'Bob' })
        await B.waitFor('trade.requested', undefined, { from: fb })
        B.send({ t: 'trade.respond', from: A.selfId, accept: true })
        const sa = await A.waitFor('trade.start', undefined, { from: fa })
        const sb = await B.waitFor('trade.start', undefined, { from: fb })
        assert.equal(sa.tradeId, sb.tradeId)
        assert.equal(sa.with, B.selfId)
        await A.waitFor('snapshot', (m) => m.players.some((p) => p.id === B.selfId && p.busy), { from: fa })
        const fc = C.mark()
        C.send({ t: 'trade.request', to: A.selfId })
        await C.waitFor('error', (m) => m.code === 'busy', { from: fc })
        B.send({ t: 'trade.cancel', tradeId: sb.tradeId })
        const ca = await A.waitFor('trade.cancelled', (m) => m.tradeId === sa.tradeId, { from: fa })
        assert.equal(ca.reason, t('net.trade.cancelled', { name: 'Bob' }))
        await B.waitFor('trade.cancelled', (m) => m.tradeId === sa.tradeId, { from: fb })
        await A.waitFor('snapshot', (m) => m.players.some((p) => p.id === B.selfId && !p.busy), { from: fa })

        const E = await join(PORT, { name: 'Eve', map: mapB.id, x: 3, y: 3 })
        const fc2 = C.mark()
        E.send({ t: 'trade.request', to: C.selfId })
        await C.waitFor('trade.requested', undefined, { from: fc2 })
        C.send({ t: 'trade.respond', from: E.selfId, accept: true })
        const st = await C.waitFor('trade.start', undefined, { from: fc2 })
        E.ws.close()
        const gone = await C.waitFor('trade.cancelled', (m) => m.tradeId === st.tradeId, { from: fc2 })
        assert.equal(gone.reason, t('net.trade.disconnected', { name: 'Eve' }))
        await C.waitFor('chat', (m) => m.channel === 'system' && m.text === t('net.system.leave', { name: 'Eve' }), { from: fc2 })
      })

      await tc.test('trade: happy path with offer reset and no double complete', async (st) => {
        const make = await loadCreatureFactory()
        if (!make || CONTENT.speciesList.length === 0) { st.skip('src/shared/creature.ts unavailable'); return }
        const sp = CONTENT.speciesList
        const ca = make(sp[0].id, 1), cb = make(sp[sp.length > 1 ? 1 : 0].id, 2), cb2 = make(sp[0].id, 3)
        const fa = A.mark(), fb = B.mark()
        A.send({ t: 'trade.request', to: B.selfId })
        await B.waitFor('trade.requested', undefined, { from: fb })
        B.send({ t: 'trade.respond', from: A.selfId, accept: true })
        const { tradeId } = await A.waitFor('trade.start', undefined, { from: fa })
        await B.waitFor('trade.start', undefined, { from: fb })

        A.send({ t: 'trade.confirm', tradeId })
        await A.waitFor('error', (m) => m.code === 'trade_incomplete', { from: fa })
        A.send({ t: 'trade.offer', tradeId, creature: { ...ca, level: 100000 } as Creature })
        const selfOffer = await A.waitFor('trade.offer', (m) => m.side === 'self', { from: fa })
        assert.equal(selfOffer.creature?.uid, ca.uid)
        assert.ok((selfOffer.creature?.level ?? 0) <= CONTENT.config.party.maxLevel, 'offer is sanitized')
        await B.waitFor('trade.offer', (m) => m.side === 'other' && m.creature?.uid === ca.uid, { from: fb })
        B.send({ t: 'trade.offer', tradeId, creature: { bogus: true } as unknown as Creature })
        await B.waitFor('error', (m) => m.code === 'trade_invalid_creature', { from: fb })
        B.send({ t: 'trade.offer', tradeId, creature: cb })
        await A.waitFor('trade.offer', (m) => m.side === 'other' && m.creature?.uid === cb.uid, { from: fa })

        A.send({ t: 'trade.confirm', tradeId })
        await B.waitFor('trade.confirmed', (m) => m.side === 'other', { from: fb })
        const fb2 = B.mark()
        B.send({ t: 'trade.offer', tradeId, creature: cb2 })
        await A.waitFor('trade.offer', (m) => m.side === 'other' && m.creature?.uid === cb2.uid, { from: fa })
        B.send({ t: 'trade.confirm', tradeId })
        await A.waitFor('trade.confirmed', (m) => m.side === 'other', { from: fa })
        await sleep(100)
        assert.equal(B.all('trade.complete', fb2).length, 0, 'offer change reset A confirmation')

        const fa3 = A.mark()
        A.send({ t: 'trade.confirm', tradeId })
        const doneA = await A.waitFor('trade.complete', undefined, { from: fa3 })
        const doneB = await B.waitFor('trade.complete', undefined, { from: fb2 })
        assert.equal(doneA.received.uid, cb2.uid)
        assert.equal(doneA.given, ca.uid)
        assert.equal(doneB.received.uid, ca.uid)
        assert.equal(doneB.given, cb2.uid)
        A.send({ t: 'trade.confirm', tradeId })
        await A.waitFor('error', (m) => m.code === 'trade_not_found', { from: fa3 })
        await sleep(100)
        assert.equal(A.all('trade.complete', fa3).length, 1)
      })

      await tc.test('pvp messages without a pvp module', async () => {
        const fa = A.mark()
        A.send({ t: 'pvp.challenge', to: B.selfId })
        const e = await A.waitFor('error', (m) => m.code === 'pvp_unavailable', { from: fa })
        assert.equal(e.message, t('net.error.pvp_unavailable'))
      })

      await tc.test('leaderboard over ws and http', async () => {
        const fa = A.mark()
        A.send({ t: 'leaderboard' })
        const lb = await A.waitFor('leaderboard', undefined, { from: fa })
        assert.ok(lb.entries.some((e) => e.id === A.selfId && e.name === 'Alice'))
        assert.ok(lb.entries.length <= NET.leaderboard.size)
        const res = await httpGet(PORT, NET.http.leaderboardPath)
        assert.equal(res.status, 200)
        const body = JSON.parse(res.body.toString()) as { entries: { id: string }[] }
        assert.deepEqual(body.entries.map((e) => e.id), lb.entries.map((e) => e.id))
      })

      await tc.test('protocol errors: not ready, bad json, version mismatch, duplicate login', async () => {
        const raw = await openClient(PORT)
        clients.push(raw)
        raw.send({ t: 'chat', channel: 'global', text: 'too early' })
        await raw.waitFor('error', (m) => m.code === 'not_ready', { from: 0 })
        raw.ws.send('{nope')
        await raw.waitFor('error', (m) => m.code === 'bad_message', { from: 0 })

        const old = await openClient(PORT)
        old.send(helloMsg({ name: 'Old', map: mapA.id, x: 1, y: 1, v: CONTENT.config.net.protocolVersion + 1 }))
        await old.waitFor('error', (m) => m.code === 'version_mismatch', { from: 0 })
        assert.equal(await old.closed, NET.protocol.closeCodes.version)

        const fb = B.mark()
        const A2 = await join(PORT, { name: 'Alice', map: mapA.id, x: ax, y: ay, playerId: pidA })
        clients.push(A2)
        assert.equal(A2.selfId, A.selfId)
        await A.waitFor('error', (m) => m.code === 'kicked_duplicate', { from: 0 })
        assert.equal(await A.closed, NET.protocol.closeCodes.duplicate)
        await sleep(tickMs * 3)
        assert.equal(B.all('chat', fb).filter((m) => m.channel === 'system').length, 0, 'takeover is silent')
      })

      await tc.test('movement: teleports beyond the jump budget are rejected', async () => {
        const p1 = { x: 1, y: 1 }
        const p2 = { x: Math.min(mapA.w - 2, 300), y: Math.min(mapA.h - 2, 300) }
        const budget = NET.server.rates.jump.count
        const expected = budget % 2 === 1 ? p2 : p1
        const W = await join(PORT, { name: 'Watcher', map: mapA.id, x: expected.x, y: expected.y })
        const J = await join(PORT, { name: 'Jumper', map: mapA.id, x: p1.x, y: p1.y })
        clients.push(W, J)
        for (let i = 1; i <= budget + 1; i++) {
          const p = i % 2 === 1 ? p2 : p1
          J.send({ t: 'move', map: mapA.id, x: p.x, y: p.y, facing: 'down', moving: false, running: false })
        }
        await sleep(tickMs * 4)
        const last = W.all('snapshot').reverse().find((m) => m.players.some((p) => p.id === J.selfId))
        const seen = last?.players.find((p) => p.id === J.selfId) as PlayerState
        assert.deepEqual({ x: seen.x, y: seen.y }, expected)
        J.send({ t: 'move', map: mapA.id, x: -1000, y: -1000, facing: 'down', moving: false, running: false })
        await sleep(tickMs * 3)
        const after = W.all('snapshot').reverse().find((m) => m.players.some((p) => p.id === J.selfId))
        // Rejected either by world bounds or by the exhausted jump budget.
        assert.equal(after?.players.find((p) => p.id === J.selfId)?.x, expected.x)
      })
    } finally {
      for (const c of clients) c.ws.close()
      await srv.close()
    }
  })
})

// ----------------------------------------------------------------------------- http

test('http: health, 404 without dist, api 404, method guard', async () => {
  await withTempDir(async (dir) => {
    const PORT = 8792
    const srv = await startServer({ port: PORT, dataDir: dir, distDir: pathJoin(dir, 'missing-dist'), quiet: true, pvp: null })
    try {
      const h = await httpGet(PORT, NET.http.healthPath)
      assert.equal(h.status, 200)
      const health = JSON.parse(h.body.toString()) as { ok: boolean; online: number; uptime: number; version: string }
      assert.equal(health.ok, true)
      assert.equal(health.online, 0)
      assert.equal(typeof health.uptime, 'number')
      assert.equal(typeof health.version, 'string')
      const root = await httpGet(PORT, '/')
      assert.equal(root.status, 404)
      assert.equal(root.body.toString(), t('net.http.notFound'))
      assert.equal((await httpGet(PORT, `${NET.http.apiPrefix}nope`)).status, 404)
      assert.equal((await httpGet(PORT, NET.http.healthPath, {}, 'POST')).status, 405)
      const lb = await httpGet(PORT, NET.http.leaderboardPath)
      assert.deepEqual(JSON.parse(lb.body.toString()), { entries: [] })
    } finally {
      await srv.close()
    }
  })
})

test('http: static dist serving, caching, compression, ranges, traversal, SPA fallback', async () => {
  await withTempDir(async (dir) => {
    const PORT = 8792
    const dist = pathJoin(dir, 'dist')
    await mkdir(pathJoin(dist, 'assets'), { recursive: true })
    const js = `console.log(${JSON.stringify('agent pocket '.repeat(400))})\n`
    await writeFile(pathJoin(dist, 'index.html'), '<!doctype html><title>t</title>')
    await writeFile(pathJoin(dist, 'assets', 'index-AbCd12_9.js'), js)
    await writeFile(pathJoin(dist, 'assets', 'plain.js'), js)
    const bin = Buffer.alloc(4096, 7)
    await writeFile(pathJoin(dist, 'assets', 'song.mp3'), bin)
    await writeFile(pathJoin(dist, 'assets', 'model.glb'), bin)
    await writeFile(pathJoin(dist, 'assets', 'font.woff2'), bin)
    await writeFile(pathJoin(dir, 'secret.txt'), 'top secret')
    await symlink(pathJoin(dir, 'secret.txt'), pathJoin(dist, 'leak.txt'))
    const srv = await startServer({ port: PORT, dataDir: pathJoin(dir, 'data'), distDir: dist, quiet: true, pvp: null })
    try {
      const index = await httpGet(PORT, '/')
      assert.equal(index.status, 200)
      assert.equal(index.headers['cache-control'], 'no-cache')
      assert.match(String(index.headers['content-type']), /text\/html/)
      const spa = await httpGet(PORT, '/some/client/route')
      assert.equal(spa.status, 200)
      assert.equal(spa.body.toString(), index.body.toString())
      assert.equal((await httpGet(PORT, '/assets/missing.js')).status, 404)

      const br = await httpGet(PORT, '/assets/index-AbCd12_9.js', { 'accept-encoding': 'gzip, br' })
      assert.equal(br.status, 200)
      assert.equal(br.headers['content-encoding'], 'br')
      assert.match(String(br.headers['cache-control']), /immutable/)
      assert.equal(brotliDecompressSync(br.body).toString(), js)
      const gz = await httpGet(PORT, '/assets/plain.js', { 'accept-encoding': 'gzip' })
      assert.equal(gz.headers['content-encoding'], 'gzip')
      assert.doesNotMatch(String(gz.headers['cache-control']), /immutable/)
      assert.equal(gunzipSync(gz.body).toString(), js)
      const etag = String(br.headers.etag)
      assert.equal((await httpGet(PORT, '/assets/index-AbCd12_9.js', { 'if-none-match': etag })).status, 304)

      const mp3 = await httpGet(PORT, '/assets/song.mp3', { range: 'bytes=100-199' })
      assert.equal(mp3.status, 206)
      assert.equal(mp3.body.length, 100)
      assert.equal(mp3.headers['content-range'], `bytes 100-199/${bin.length}`)
      assert.equal(mp3.headers['content-type'], NET.http.mime['.mp3'])
      assert.equal((await httpGet(PORT, '/assets/model.glb')).headers['content-type'], NET.http.mime['.glb'])
      assert.equal((await httpGet(PORT, '/assets/font.woff2')).headers['content-type'], NET.http.mime['.woff2'])
      assert.equal((await httpGet(PORT, '/assets/song.mp3', { range: 'bytes=99999-' })).status, 416)

      for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/leak.txt', '/.hidden', '/a%00b']) {
        const r = await httpGet(PORT, p)
        assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`)
        assert.ok(!r.body.toString().includes('top secret'), `${p} leaked`)
      }
      assert.equal((await httpGet(PORT, '/', {}, 'DELETE')).status, 405)
      const head = await httpGet(PORT, '/assets/plain.js', {}, 'HEAD')
      assert.equal(head.status, 200)
      assert.equal(head.body.length, 0)
    } finally {
      await srv.close()
    }
  })
})

// ----------------------------------------------------------------------------- pvp hooks + persistence

test('pvp hooks are wired to the hub and stats persist across restarts', async () => {
  await withTempDir(async (dataDir) => {
    const PORT = 8793
    const { a: mapA } = await pickMaps()
    let host: PvpHost | null = null
    const handled: { from: string; t: string }[] = []
    const disconnected: string[] = []
    let disposed = false
    const fake: PvpModule = {
      createPvp(h) {
        host = h
        return {
          handle(from, msg) { handled.push({ from, t: msg.t }) },
          onDisconnect(id) { disconnected.push(id) },
          dispose() { disposed = true },
        }
      },
    }
    let srv = await startServer({ port: PORT, dataDir, quiet: true, pvp: fake, distDir: pathJoin(dataDir, 'nd') })
    let A: TestClient | null = null, B: TestClient | null = null
    let aId = '', bId = ''
    try {
      A = await join(PORT, { name: 'Ann', map: mapA.id, x: 5, y: 5 })
      B = await join(PORT, { name: 'Ben', map: mapA.id, x: 6, y: 5 })
      aId = A.selfId; bId = B.selfId
      A.send({ t: 'pvp.challenge', to: bId })
      await sleep(100)
      assert.deepEqual(handled, [{ from: aId, t: 'pvp.challenge' }])
      assert.ok(host)
      const h = host as PvpHost
      assert.deepEqual(h.getPlayer(aId), { id: aId, name: 'Ann', avatar: h.getPlayer(aId)!.avatar, busy: false })
      assert.equal(h.getPlayer('nobody'), null)
      const fb = B.mark()
      h.setBusy(aId, true)
      await B.waitFor('snapshot', (m) => m.players.some((p) => p.id === aId && p.busy), { from: fb })
      assert.equal(h.getPlayer(aId)!.busy, true)
      h.send(bId, { t: 'pvp.challenged', from: aId, name: 'Ann' })
      await B.waitFor('pvp.challenged', (m) => m.from === aId, { from: fb })
      const fa = A.mark()
      A.send({ t: 'trade.request', to: bId })
      await A.waitFor('error', (m) => m.code === 'self_busy', { from: fa })
      h.recordPvp(aId, bId)
      h.setBusy(aId, false)
      B.ws.close()
      await sleep(150)
      assert.deepEqual(disconnected, [bId])
    } finally {
      A?.ws.close()
      B?.ws.close()
      await srv.close()
    }
    assert.equal(disposed, true)
    const file = pathJoin(dataDir, NET.store.file)
    assert.ok(existsSync(file), 'profiles persisted on close')
    const saved = JSON.parse(await readFile(file, 'utf8')) as { profiles: Record<string, { pvpWins: number; pvpLosses: number }> }
    assert.equal(saved.profiles[aId].pvpWins, 1)
    assert.equal(saved.profiles[bId].pvpLosses, 1)

    srv = await startServer({ port: PORT, dataDir, quiet: true, pvp: null, distDir: pathJoin(dataDir, 'nd') })
    try {
      const res = await httpGet(PORT, NET.http.leaderboardPath)
      const { entries } = JSON.parse(res.body.toString()) as { entries: { id: string; pvpWins: number; pvpLosses: number }[] }
      assert.equal(entries.find((e) => e.id === aId)?.pvpWins, 1)
      assert.equal(entries.find((e) => e.id === bId)?.pvpLosses, 1)
    } finally {
      await srv.close()
    }
  })
})

test('world bounds: spawn fallback, out-of-bounds moves, badge filtering', async () => {
  await withTempDir(async (dataDir) => {
    const PORT = 8793
    const world: WorldInfo = {
      maps: new Map([['town', { width: 20, height: 12, spawn: { x: 5, y: 6, facing: 'up' } }], ['house', { width: 8, height: 8, spawn: { x: 2, y: 2, facing: 'down' } }]]),
      startMap: 'town',
      badgeIds: new Set(['badge-a']),
    }
    const srv = await startServer({ port: PORT, dataDir, distDir: pathJoin(dataDir, 'nd'), quiet: true, pvp: null, world })
    const clients: TestClient[] = []
    try {
      const W = await join(PORT, { name: 'Wally', map: 'town', x: 6, y: 6, profile: { badges: ['badge-a', 'forged', 'badge-a'] } })
      const L = await join(PORT, { name: 'Lost', map: 'nowhere', x: 3, y: 3 })
      clients.push(W, L)
      const snap = await W.waitFor('snapshot', (m) => m.players.some((p) => p.id === L.selfId), { from: 0 })
      const lost = snap.players.find((p) => p.id === L.selfId)!
      assert.deepEqual({ map: snap.map, x: lost.x, y: lost.y, facing: lost.facing }, { map: 'town', x: 5, y: 6, facing: 'up' })
      assert.equal(snap.players.find((p) => p.id === L.selfId)?.badges, 0)

      const from = W.mark()
      L.send({ t: 'move', map: 'town', x: 6, y: 25, facing: 'down', moving: true, running: false })
      L.send({ t: 'move', map: 'house', x: 30, y: 2, facing: 'down', moving: false, running: false })
      L.send({ t: 'move', map: 'town', x: 6, y: 7, facing: 'down', moving: false, running: false })
      const ok = await W.waitFor('snapshot', (m) => m.players.some((p) => p.id === L.selfId && p.y === 7), { from })
      assert.equal(ok.players.find((p) => p.id === L.selfId)?.x, 6)
      assert.ok(!W.all('snapshot', from).some((m) => m.players.some((p) => p.id === L.selfId && (p.y === 25 || p.map === 'house'))))

      const fl = L.mark()
      L.send({ t: 'inspect', target: 'Wally' })
      const prof = await L.waitFor('profile', undefined, { from: fl })
      assert.deepEqual(prof.profile.badges, ['badge-a'])
    } finally {
      for (const c of clients) c.ws.close()
      await srv.close()
    }
  })
})
