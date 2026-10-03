// PvP module (src/server/pvp.ts) through the real hub on test ports 8797-8799, plus content checks for
// content/multiplayer.json and the multiplayer text namespace.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { BattleAction, BattleEvent, Creature, SideIndex } from '../src/shared/types.ts'
import type { ClientMsg, PublicProfile, ServerMsg } from '../src/shared/protocol.ts'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { createCreature } from '../src/shared/creature.ts'
import { Rng } from '../src/shared/rng.ts'
import { startServer } from '../src/server/index.ts'
import { NET } from '../src/server/config.ts'
import { PVP_RULES, arenaFor, createPvp, sanitizePvpParty, type PvpOverrides } from '../src/server/pvp.ts'
import type { PvpModule } from '../src/server/pvp-hooks.ts'
import type { GameEvents, NetStatus } from '../src/client/contracts.ts'
import { createEventBus } from '../src/client/core/events.ts'
import { createNetClient } from '../src/client/net/index.ts'
import {
  arenaFor as clientArenaFor, buildPvpInit, createPvpChannel, creatureFromView, outcomeOf, pvpParty, resultFromEnd,
} from '../src/client/net/pvp-channel.ts'
import { applyTradeResult, canOffer, ivStars, offerableIndices, trackOnlineRoster, TRADE_RULES } from '../src/client/net/trade-flow.ts'
import type { SaveData } from '../src/shared/types.ts'
import { maxHp } from '../src/shared/creature.ts'
import multiplayerJson from '../content/multiplayer.json' with { type: 'json' }

// ----------------------------------------------------------------------------- helpers

type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>

interface TestClient {
  ws: WebSocket
  msgs: ServerMsg[]
  selfId: string
  name: string
  send(m: ClientMsg | Record<string, unknown>): void
  mark(): number
  waitFor<T extends ServerMsg['t']>(type: T, pred?: (m: Msg<T>) => boolean, opts?: { from?: number; ms?: number }): Promise<Msg<T>>
  all<T extends ServerMsg['t']>(type: T, from?: number): Msg<T>[]
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Spacing between pvp messages that stays under the hub's pvp rate limit. */
const PVP_GAP_MS = Math.ceil((NET.server.rates.pvp.perSeconds * 1000) / NET.server.rates.pvp.count) + 5

function openClient(port: number): Promise<TestClient> {
  const ws = new WebSocket(`ws://localhost:${port}${NET.protocol.wsPath}`)
  const msgs: ServerMsg[] = []
  const waiters = new Set<() => void>()
  const closed = new Promise<void>((r) => ws.addEventListener('close', () => r()))
  ws.addEventListener('message', (e) => {
    msgs.push(JSON.parse(String(e.data)) as ServerMsg)
    for (const w of [...waiters]) w()
  })
  const c: TestClient = {
    ws, msgs, selfId: '', name: '',
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
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`timeout waiting for ${type}; got ${msgs.slice(from).map((m) => (m.t === 'error' ? `error:${m.code}` : m.t)).join(',')}`))
        }, opts.ms ?? 4000)
        const cleanup = () => { clearTimeout(timer); waiters.delete(check) }
        waiters.add(check)
        check()
      })
    },
    close() { ws.close(); return closed },
  }
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(c))
    ws.addEventListener('error', () => reject(new Error('ws error')))
  })
}

const MAP = 'pvp-test-map'

async function join(port: number, name: string, x: number): Promise<TestClient> {
  const c = await openClient(port)
  const from = c.mark()
  const profile: PublicProfile = { id: '', name, avatar: '', badges: [], dexCaught: 0, party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0 }
  c.send({
    t: 'hello', v: CONTENT.config.net.protocolVersion, playerId: crypto.randomUUID(), name, avatar: '', map: MAP, x, y: 5, facing: 'down', lead: null, profile,
  } satisfies ClientMsg)
  const w = await c.waitFor('welcome', undefined, { from })
  c.selfId = w.selfId
  c.name = name
  return c
}

let seedCounter = 1
/** A party built generically from whatever species exist (first `n` species in dex order). */
function party(n: number, level: number, otName = 'tester'): Creature[] {
  const list = CONTENT.speciesList
  assert.ok(list.length > 0, 'content needs at least one species')
  return Array.from({ length: n }, (_, i) =>
    createCreature(list[i % list.length].id, level, { rng: new Rng(seedCounter++ * 7919), otName, shiny: false }))
}

function pvpModule(overrides: PvpOverrides): PvpModule {
  return { createPvp: (host) => createPvp(host, overrides) }
}

/** Listens on an ephemeral port (the label only documents the test) so a dev server on a fixed port can't collide. */
async function withServer(_label: number, overrides: PvpOverrides, fn: (port: number, dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), 'ap-pvp-test-'))
  const srv = await startServer({ port: 0, dataDir, distDir: pathJoin(dataDir, 'no-dist'), quiet: true, world: null, pvp: pvpModule(overrides) })
  try { await fn(srv.port, dataDir) } finally {
    await srv.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

/** A challenges B, B accepts; both get pvp.start. */
async function startBattle(A: TestClient, B: TestClient) {
  const fb = B.mark()
  const fa = A.mark()
  A.send({ t: 'pvp.challenge', to: B.selfId })
  const ch = await B.waitFor('pvp.challenged', undefined, { from: fb })
  assert.equal(ch.from, A.selfId)
  assert.equal(ch.name, A.name)
  B.send({ t: 'pvp.respond', from: A.selfId, accept: true })
  const sa = await A.waitFor('pvp.start', undefined, { from: fa })
  const sb = await B.waitFor('pvp.start', undefined, { from: fb })
  assert.equal(sa.battleId, sb.battleId)
  assert.equal(sa.side, 0, 'challenger is side 0')
  assert.equal(sb.side, 1)
  assert.equal(sa.opponent.id, B.selfId)
  assert.equal(sb.opponent.id, A.selfId)
  assert.equal(sa.levelCap, CONTENT.config.net.pvpLevelCap)
  return sa.battleId
}

/** Sends parties and waits for pvp.begin on both sides. */
async function sendParties(A: TestClient, B: TestClient, battleId: string, pa: Creature[], pb: Creature[]) {
  const fa = A.mark(), fb = B.mark()
  A.send({ t: 'pvp.party', battleId, party: pa })
  await sleep(PVP_GAP_MS)
  B.send({ t: 'pvp.party', battleId, party: pb })
  const ba = await A.waitFor('pvp.begin', undefined, { from: fa })
  const bb = await B.waitFor('pvp.begin', undefined, { from: fb })
  return { ba, bb, fa, fb }
}

/**
 * Plays until pvp.end: answers every action/switch request; an answer rejected by the engine (reply carries the
 * same kind of request again) moves on to the next index.
 */
function autoPlayer(c: TestClient, battleId: string, from: number): Promise<Msg<'pvp.end'>> {
  return new Promise((resolve, reject) => {
    let i = from
    let attempt = 0
    let lastKind = ''
    let busy = false
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`${c.name}: battle did not end`)) }, 60_000)
    const poll = setInterval(async () => {
      if (busy) return
      busy = true
      try {
        for (; i < c.msgs.length; i++) {
          const m = c.msgs[i]
          if (m.t === 'pvp.end' && m.battleId === battleId) { clearInterval(poll); clearTimeout(timer); resolve(m); return }
          if (m.t === 'error' && m.code === 'rate_limited') { await sleep(PVP_GAP_MS * 4); attempt = Math.max(0, attempt - 1); lastKind = '' }
          if (m.t !== 'pvp.events' || m.battleId !== battleId) continue
          const req = m.request
          if (req.kind === 'wait') continue
          const rejected = m.events.length === 1 && m.events[0].t === 'msg' && lastKind === req.kind
          attempt = rejected ? attempt + 1 : 0
          lastKind = req.kind
          const action: BattleAction = req.kind === 'switch'
            ? { kind: 'switch', partyIndex: attempt % CONTENT.config.party.maxParty }
            : { kind: 'move', moveIndex: attempt % CONTENT.config.party.maxMoves }
          await sleep(PVP_GAP_MS)
          c.send({ t: 'pvp.action', battleId, action })
        }
      } finally { busy = false }
    }, 5)
  })
}

const flipSide = (s: SideIndex): SideIndex => (s === 0 ? 1 : 0)
function flip(e: BattleEvent): BattleEvent {
  if (e.t === 'end') return { t: 'end', result: e.result === 'win' ? 'lose' : e.result === 'lose' ? 'win' : e.result, winner: e.winner === -1 ? -1 : flipSide(e.winner) }
  if ('side' in e) return { ...e, side: flipSide(e.side) } as BattleEvent
  return e
}
const structural = (events: BattleEvent[]) => events.filter((e) => e.t !== 'msg')

/** Every batch both players received must describe the same battle, mirrored. */
function assertMirrored(A: TestClient, B: TestClient, battleId: string, fa: number, fb: number) {
  const batches = (c: TestClient, from: number) => c.all('pvp.events', from).filter((m) => m.battleId === battleId).map((m) => structural(m.events)).filter((ev) => ev.length > 0)
  const ea = batches(A, fa)
  const eb = batches(B, fb)
  assert.equal(ea.length, eb.length, 'same number of resolved batches')
  assert.ok(ea.length > 0)
  ea.forEach((batch, i) => assert.deepEqual(batch.map(flip), eb[i], `batch ${i} mirrored`))
}

async function inspectProfile(c: TestClient, target: string): Promise<PublicProfile> {
  const from = c.mark()
  c.send({ t: 'inspect', target })
  return (await c.waitFor('profile', (m) => m.profile.id === target, { from })).profile
}

// ----------------------------------------------------------------------------- content

interface MultiplayerFileShape {
  pvp: typeof PVP_RULES & {
    clientSlackSeconds: number
    challengeAbortErrors: string[]
    resultOutcome: Record<string, string>
    outcomeToast: Record<string, string>
    sfx: Record<string, string>
  }
  trade: { ivStars: number; cardIconSize: number; completeAnimMs: number; completeHoldMs: number; buttons: string[]; sfx: Record<string, string>; requestAbortErrors: string[]; sessionErrors: string[] }
  online: { tabs: string[]; playerActions: string[]; inspectAbortErrors: string[]; visibleRows: number; listWidth: number; avatarIconSize: number; partyIconSize: number; profileAvatarSize: number; inspectTimeoutMs: number; leaderboardMaxAgeSeconds: number; statusRefreshMs: number }
  emotes: string[]
}
const MP = multiplayerJson as unknown as MultiplayerFileShape

test('content/multiplayer.json is consistent with the content tables', () => {
  const pos = (v: unknown, where: string) => assert.ok(typeof v === 'number' && Number.isFinite(v) && v > 0, `${where} must be > 0`)
  for (const k of ['challengeSeconds', 'partySeconds', 'afkForfeitAfter', 'maxResolveSteps', 'clientSlackSeconds'] as const) pos(MP.pvp[k], `pvp.${k}`)
  assert.equal(typeof MP.pvp.healParty, 'boolean')
  assert.ok(MP.pvp.arena.biomes.length > 0 && MP.pvp.arena.biomes.every((b) => CONTENT.biomeById[b]), 'arena biomes exist')
  const phases = new Set(CONTENT.config.time.phases.map((p) => p.id))
  assert.ok(MP.pvp.arena.timeOfDay.length > 0 && MP.pvp.arena.timeOfDay.every((x) => phases.has(x)), 'arena times exist')
  if (MP.pvp.arena.weather) assert.ok(MP.pvp.arena.weather === 'none' || CONTENT.weatherById[MP.pvp.arena.weather], 'arena weather exists')
  const results = ['win', 'lose', 'draw', 'forfeit', 'disconnect']
  for (const r of results) assert.ok(['win', 'loss', 'draw'].includes(MP.pvp.resultOutcome[r]), `resultOutcome.${r}`)
  for (const o of ['win', 'loss', 'draw']) assert.ok(['info', 'success', 'warn', 'error'].includes(MP.pvp.outcomeToast[o]), `outcomeToast.${o}`)
  for (const r of results) assert.notEqual(t(`multiplayer.pvp.result.${r}`), `multiplayer.pvp.result.${r}`)
  const sfx = new Set(CONTENT.audio.sfx)
  for (const [k, id] of [...Object.entries(MP.pvp.sfx), ...Object.entries(MP.trade.sfx)]) assert.ok(sfx.has(id), `sfx ${k} -> "${id}" exists in content/audio.json`)
  for (const k of ['ivStars', 'cardIconSize', 'completeAnimMs', 'completeHoldMs'] as const) pos(MP.trade[k], `trade.${k}`)
  for (const k of ['visibleRows', 'listWidth', 'avatarIconSize', 'partyIconSize', 'profileAvatarSize', 'inspectTimeoutMs', 'leaderboardMaxAgeSeconds', 'statusRefreshMs'] as const) pos(MP.online[k], `online.${k}`)
  assert.deepEqual([...MP.online.tabs].sort(), ['leaderboard', 'players', 'profile'], 'online tabs are the implemented views')
  for (const tab of MP.online.tabs) assert.notEqual(t(`multiplayer.online.tab.${tab}`), `multiplayer.online.tab.${tab}`)
  assert.deepEqual([...MP.online.playerActions].sort(), ['battle', 'inspect', 'trade', 'whisper'], 'player actions are the implemented ones')
  for (const a of MP.online.playerActions) assert.notEqual(t(`multiplayer.online.actions.${a}`), `multiplayer.online.actions.${a}`)
  assert.deepEqual([...MP.trade.buttons].sort(), ['cancel', 'confirm', 'pick', 'withdraw'], 'trade buttons are the implemented ones')
  const statuses: NetStatus[] = ['online', 'connecting', 'offline', 'error']
  for (const s of statuses) assert.notEqual(t(`multiplayer.status.${s}`), `multiplayer.status.${s}`)
  for (const code of MP.online.inspectAbortErrors) assert.notEqual(t(`net.error.${code}`), `net.error.${code}`, `error text for ${code}`)
  assert.ok(MP.emotes.length > 0 && new Set(MP.emotes).size === MP.emotes.length, 'emotes are unique')
  for (const e of MP.emotes) {
    const symbol = t(`multiplayer.emote.${e}.symbol`)
    assert.notEqual(symbol, `multiplayer.emote.${e}.symbol`)
    assert.notEqual(t(`multiplayer.emote.${e}.label`), `multiplayer.emote.${e}.label`)
    assert.ok([...symbol].length <= NET.server.emoteMaxLen, `emote ${e} fits the server limit`)
  }
  for (const code of [...MP.pvp.challengeAbortErrors, ...MP.trade.requestAbortErrors, ...MP.trade.sessionErrors]) {
    const key = code.startsWith('pvp_') && code !== 'pvp_unavailable' ? `multiplayer.serverError.${code}` : `net.error.${code}`
    assert.notEqual(t(key), key, `error text for ${code}`)
  }
})

test('every multiplayer text key referenced by the multiplayer modules exists', async () => {
  const files = ['src/server/pvp.ts', 'src/client/net/pvp-channel.ts', 'src/client/net/trade-flow.ts', 'src/client/ui/screens/online.ts']
  const keys = new Set<string>()
  for (const f of files) {
    let src = ''
    try { src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8') } catch { continue }
    for (const m of src.matchAll(/['`](multiplayer\.[A-Za-z0-9_.]+)['`]/g)) keys.add(m[1])
    for (const m of src.matchAll(/fail\([^,]+,\s*'([a-z_]+)'/g)) keys.add(`multiplayer.serverError.${m[1]}`)
    for (const m of src.matchAll(/'(pvp_[a-z_]+)'/g)) if (m[1] !== 'pvp_unavailable') keys.add(`multiplayer.serverError.${m[1]}`)
    // Player-facing Chinese text must come from content, never from code.
    assert.ok(!/[一-鿿]/.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')), `${f} contains CJK text outside comments`)
  }
  assert.ok(keys.size > 0)
  for (const k of keys) assert.notEqual(t(k), k, `missing text ${k}`)
})

test('arena selection is deterministic and uses existing content', () => {
  for (const seed of [0, 1, 7, 12345, 2 ** 31 - 2]) {
    const a = arenaFor(seed)
    assert.deepEqual(a, arenaFor(seed))
    assert.ok(CONTENT.biomeById[a.biome])
    assert.ok(PVP_RULES.arena.timeOfDay.includes(a.timeOfDay))
  }
})

test('sanitizePvpParty: limits, duplicates, unknown species, healing, independence', () => {
  assert.equal(sanitizePvpParty([]), null)
  assert.equal(sanitizePvpParty('x'), null)
  assert.equal(sanitizePvpParty(party(CONTENT.config.party.maxParty + 1, 5)), null)
  const p = party(2, 5)
  assert.equal(sanitizePvpParty([p[0], p[0]]), null, 'duplicate uids rejected')
  assert.equal(sanitizePvpParty([{ ...p[0], speciesId: '__nope__' }]), null)
  const hurt = structuredClone(p)
  hurt[0].hp = 1
  hurt[1].hp = 0
  for (const m of hurt[0].moves) m.pp = 0
  const out = sanitizePvpParty(hurt, { ...PVP_RULES, healParty: true })!
  assert.ok(out && out.length === 2)
  assert.notEqual(out[0], hurt[0], 'returns clones')
  assert.ok(out.every((c) => c.hp > 1 && c.moves.every((m) => m.pp === m.ppMax)), 'healed when healParty')
  const fainted = structuredClone(p).map((c) => ({ ...c, hp: 0 }))
  assert.equal(sanitizePvpParty(fainted, { ...PVP_RULES, healParty: false }), null, 'needs one healthy creature without healing')
  assert.equal(hurt[0].hp, 1, 'input untouched')
})

// ----------------------------------------------------------------------------- integration

test('pvp: full battle to the end, mirrored perspectives, level cap, records', async () => {
  await withServer(8797, {}, async (port) => {
    const A = await join(port, 'Ann', 5)
    const B = await join(port, 'Ben', 6)
    try {
      const battleId = await startBattle(A, B)
      const cap = CONTENT.config.net.pvpLevelCap
      const high = Math.min(CONTENT.config.party.maxLevel, cap + 10)
      const pa = party(2, high)
      const pb = party(2, Math.max(1, cap - 10))
      const { ba, bb, fa, fb } = await sendParties(A, B, battleId, pa, pb)
      assert.equal(ba.seed, bb.seed)
      assert.deepEqual(ba.yourParty.map((v) => v.uid), pa.map((c) => c.uid))
      assert.ok(ba.yourParty.every((v) => v.level === Math.min(high, cap)), 'party views are level-capped')
      assert.ok(ba.yourParty.every((v) => v.hp === v.maxHp), 'party healed for pvp')
      assert.equal(ba.theirPartySize, pb.length)
      assert.equal(bb.theirPartySize, pa.length)
      assert.equal(ba.theirLead.uid, pb[0].uid)
      assert.equal(bb.theirLead.uid, pa[0].uid)
      assert.equal(ba.theirLead.level, Math.min(pb[0].level, cap))

      const first = await A.waitFor('pvp.events', (m) => m.battleId === battleId, { from: fa })
      const firstB = await B.waitFor('pvp.events', (m) => m.battleId === battleId, { from: fb })
      const msgA = first.events.find((e) => e.t === 'msg')
      const msgB = firstB.events.find((e) => e.t === 'msg')
      assert.equal(msgA?.t === 'msg' && msgA.text, t('battle.pvpStart', { trainer: B.name }), 'side 0 sees the opponent named')
      assert.equal(msgB?.t === 'msg' && msgB.text, t('battle.pvpStart', { trainer: A.name }), 'side 1 sees its own perspective')
      assert.equal(first.request.kind, 'action')
      assert.equal(firstB.request.kind, 'action')
      assert.ok(first.events.some((e) => e.t === 'switch' && e.side === 0 && e.creature.uid === pa[0].uid), 'own lead is side 0')
      assert.ok(firstB.events.some((e) => e.t === 'switch' && e.side === 0 && e.creature.uid === pb[0].uid), 'own lead is side 0 for side 1 too')

      const [endA, endB] = await Promise.all([autoPlayer(A, battleId, fa), autoPlayer(B, battleId, fb)])
      assertMirrored(A, B, battleId, fa, fb)
      const seenA = A.all('pvp.events', fa).flatMap((m) => m.events)
      assert.ok(seenA.some((e) => e.t === 'turn') && seenA.some((e) => e.t === 'damage'), 'turns were actually fought')
      assert.ok(!seenA.some((e) => e.t === 'exp' || e.t === 'money' || e.t === 'catch'), 'no exp/money/catch in pvp')
      const outcome = new Set([endA.result, endB.result])
      assert.ok((outcome.has('win') && outcome.has('lose')) || (endA.result === 'draw' && endB.result === 'draw'), `results ${endA.result}/${endB.result}`)
      const lastA = A.all('pvp.events', fa).filter((m) => m.battleId === battleId).at(-1)!
      assert.equal(lastA.request.kind, 'wait')
      assert.ok(lastA.events.some((e) => e.t === 'end'))

      const pa2 = await inspectProfile(A, A.selfId)
      const pb2 = await inspectProfile(A, B.selfId)
      if (endA.result === 'win') { assert.equal(pa2.pvpWins, 1); assert.equal(pb2.pvpLosses, 1) }
      if (endB.result === 'win') { assert.equal(pb2.pvpWins, 1); assert.equal(pa2.pvpLosses, 1) }

      // Session released: actions now fail and both can battle again.
      const f2 = A.mark()
      A.send({ t: 'pvp.action', battleId, action: { kind: 'move', moveIndex: 0 } })
      await A.waitFor('error', (m) => m.code === 'pvp_battle_not_found', { from: f2 })
      await sleep(PVP_GAP_MS)
      const again = await startBattle(B, A)
      assert.notEqual(again, battleId)
    } finally {
      await A.close()
      await B.close()
    }
  })
})

test('pvp: decline, expiry, withdraw, busy and self checks', async () => {
  await withServer(8798, { challengeSeconds: 0.3 }, async (port) => {
    const A = await join(port, 'Amy', 5)
    const B = await join(port, 'Bea', 6)
    const C = await join(port, 'Cid', 7)
    try {
      let fa = A.mark()
      A.send({ t: 'pvp.challenge', to: A.selfId })
      await A.waitFor('error', (m) => m.code === 'pvp_self', { from: fa })
      A.send({ t: 'pvp.challenge', to: 'nobody' })
      await A.waitFor('error', (m) => m.code === 'pvp_not_found', { from: fa })

      // decline
      fa = A.mark()
      let fb = B.mark()
      A.send({ t: 'pvp.challenge', to: B.selfId })
      await B.waitFor('pvp.challenged', undefined, { from: fb })
      const fc = C.mark()
      C.send({ t: 'pvp.challenge', to: B.selfId })
      await C.waitFor('error', (m) => m.code === 'pvp_busy', { from: fc })
      await sleep(PVP_GAP_MS)
      A.send({ t: 'pvp.challenge', to: C.selfId })
      await A.waitFor('error', (m) => m.code === 'pvp_pending', { from: fa })
      B.send({ t: 'pvp.respond', from: A.selfId, accept: false })
      const declined = await A.waitFor('error', (m) => m.code === 'pvp_declined', { from: fa })
      assert.equal(declined.message, t('multiplayer.serverError.pvp_declined', { name: B.name }))
      B.send({ t: 'pvp.respond', from: A.selfId, accept: true })
      await B.waitFor('error', (m) => m.code === 'pvp_challenge_not_found', { from: fb })

      // expiry
      await sleep(PVP_GAP_MS)
      fa = A.mark()
      fb = B.mark()
      A.send({ t: 'pvp.challenge', to: B.selfId })
      await B.waitFor('pvp.challenged', undefined, { from: fb })
      await A.waitFor('error', (m) => m.code === 'pvp_expired', { from: fa, ms: 2000 })
      await B.waitFor('error', (m) => m.code === 'pvp_expired', { from: fb, ms: 2000 })

      // withdraw (pvp.forfeit without a battle id)
      await sleep(PVP_GAP_MS)
      fb = B.mark()
      A.send({ t: 'pvp.challenge', to: B.selfId })
      await B.waitFor('pvp.challenged', undefined, { from: fb })
      await sleep(PVP_GAP_MS)
      A.send({ t: 'pvp.forfeit', battleId: '' })
      const withdrawn = await B.waitFor('error', (m) => m.code === 'pvp_cancelled', { from: fb })
      assert.equal(withdrawn.message, t('multiplayer.serverError.pvp_cancelled', { name: A.name }))

      // busy while in a battle session
      await sleep(PVP_GAP_MS)
      const battleId = await startBattle(A, B)
      const fc2 = C.mark()
      C.send({ t: 'pvp.challenge', to: A.selfId })
      await C.waitFor('error', (m) => m.code === 'pvp_busy', { from: fc2 })
      fa = A.mark()
      A.send({ t: 'pvp.challenge', to: C.selfId })
      await A.waitFor('error', (m) => m.code === 'pvp_self_busy', { from: fa })
      // trades are refused while in pvp (hub busy flag)
      A.send({ t: 'trade.request', to: C.selfId })
      await A.waitFor('error', (m) => m.code === 'self_busy', { from: fa })

      // cancelling before the battle began: no record, both released
      await sleep(PVP_GAP_MS)
      fb = B.mark()
      A.send({ t: 'pvp.forfeit', battleId })
      const endB = await B.waitFor('pvp.end', (m) => m.battleId === battleId, { from: fb })
      assert.equal(endB.result, 'draw')
      await B.waitFor('error', (m) => m.code === 'pvp_cancelled', { from: fb })
      const prof = await inspectProfile(C, A.selfId)
      assert.equal(prof.pvpWins + prof.pvpLosses, 0)
      await sleep(PVP_GAP_MS)
      fb = B.mark()
      C.send({ t: 'pvp.challenge', to: B.selfId })
      await B.waitFor('pvp.challenged', (m) => m.from === C.selfId, { from: fb })
    } finally {
      await Promise.all([A.close(), B.close(), C.close()])
    }
  })
})

test('pvp: forfeit, disconnect, invalid party, party timeout, turn timeout and AFK forfeit', async (tc) => {
  await withServer(8799, { partySeconds: 0.4, turnSeconds: 0.25, afkForfeitAfter: 2 }, async (port) => {
    await tc.test('forfeit mid-battle', async () => {
      const A = await join(port, 'Fay', 5)
      const B = await join(port, 'Gus', 6)
      try {
        const battleId = await startBattle(A, B)
        const { fa, fb } = await sendParties(A, B, battleId, party(1, 20), party(1, 20))
        await A.waitFor('pvp.events', (m) => m.battleId === battleId, { from: fa })
        A.send({ t: 'pvp.forfeit', battleId })
        const ea = await A.waitFor('pvp.end', undefined, { from: fa })
        const eb = await B.waitFor('pvp.end', undefined, { from: fb })
        assert.equal(ea.result, 'forfeit')
        assert.equal(eb.result, 'win')
        const lastB = B.all('pvp.events', fb).at(-1)!
        const end = lastB.events.find((e) => e.t === 'end')
        assert.deepEqual(end, { t: 'end', result: 'forfeit', winner: 0 }, 'winner is side 0 in the winner\'s perspective')
        assert.ok(lastB.events.some((e) => e.t === 'msg' && e.text === t('battle.foeForfeit', { trainer: A.name })))
        assert.equal((await inspectProfile(B, B.selfId)).pvpWins, 1)
        assert.equal((await inspectProfile(B, A.selfId)).pvpLosses, 1)
      } finally { await Promise.all([A.close(), B.close()]) }
    })

    await tc.test('disconnect mid-battle counts as a loss', async () => {
      const A = await join(port, 'Hal', 5)
      const B = await join(port, 'Ivy', 6)
      try {
        const battleId = await startBattle(A, B)
        const { fa } = await sendParties(A, B, battleId, party(1, 20), party(1, 20))
        await A.waitFor('pvp.events', (m) => m.battleId === battleId, { from: fa })
        const bId = B.selfId
        await B.close()
        const end = await A.waitFor('pvp.end', undefined, { from: fa })
        assert.equal(end.result, 'disconnect')
        const last = A.all('pvp.events', fa).at(-1)!
        assert.ok(last.events.some((e) => e.t === 'msg' && e.text === t('multiplayer.pvp.opponentLeft', { name: B.name })))
        assert.deepEqual(last.events.at(-1), { t: 'end', result: 'win', winner: 0 })
        assert.equal((await inspectProfile(A, A.selfId)).pvpWins, 1)
        assert.equal((await inspectProfile(A, bId)).pvpLosses, 1)
      } finally { await A.close() }
    })

    await tc.test('invalid party aborts without records', async () => {
      const A = await join(port, 'Jo', 5)
      const B = await join(port, 'Kai', 6)
      try {
        const battleId = await startBattle(A, B)
        const fa = A.mark(), fb = B.mark()
        A.send({ t: 'pvp.party', battleId, party: [{ uid: 'x', speciesId: '__missing__' }] })
        await A.waitFor('error', (m) => m.code === 'pvp_party_invalid', { from: fa })
        await B.waitFor('error', (m) => m.code === 'pvp_cancelled', { from: fb })
        await A.waitFor('pvp.end', (m) => m.battleId === battleId, { from: fa })
        await B.waitFor('pvp.end', (m) => m.battleId === battleId, { from: fb })
        assert.equal((await inspectProfile(A, A.selfId)).pvpLosses, 0)
      } finally { await Promise.all([A.close(), B.close()]) }
    })

    await tc.test('party timeout aborts', async () => {
      const A = await join(port, 'Lu', 5)
      const B = await join(port, 'Mo', 6)
      try {
        const battleId = await startBattle(A, B)
        const fa = A.mark(), fb = B.mark()
        A.send({ t: 'pvp.party', battleId, party: party(1, 10) })
        await B.waitFor('error', (m) => m.code === 'pvp_party_timeout', { from: fb, ms: 2000 })
        await A.waitFor('error', (m) => m.code === 'pvp_opponent_timeout', { from: fa, ms: 2000 })
        await A.waitFor('pvp.end', (m) => m.battleId === battleId, { from: fa })
      } finally { await Promise.all([A.close(), B.close()]) }
    })

    await tc.test('turn timer auto-picks, then repeated timeouts forfeit', async () => {
      const A = await join(port, 'Ned', 5)
      const B = await join(port, 'Oz', 6)
      try {
        const battleId = await startBattle(A, B)
        // High enough hp that two auto-picked turns cannot end the battle.
        const lvl = CONTENT.config.net.pvpLevelCap
        const { fa, fb } = await sendParties(A, B, battleId, party(CONTENT.config.party.maxParty, lvl), party(CONTENT.config.party.maxParty, lvl))
        const ea = await A.waitFor('pvp.end', (m) => m.battleId === battleId, { from: fa, ms: 5000 })
        const eb = await B.waitFor('pvp.end', (m) => m.battleId === battleId, { from: fb, ms: 5000 })
        const timeoutText = t('multiplayer.pvp.timeout')
        const sawTimeout = A.all('pvp.events', fa).some((m) => m.events.some((e) => e.t === 'msg' && e.text === timeoutText))
        assert.ok(sawTimeout, 'timeout note delivered')
        const afk = A.all('pvp.events', fa).some((m) => m.events.some((e) => e.t === 'msg' && e.text === t('multiplayer.pvp.afkForfeit')))
        if (afk) {
          assert.equal(ea.result, 'forfeit')
          assert.equal(eb.result, 'win')
        } else {
          assert.ok(['win', 'lose', 'draw'].includes(ea.result), 'battle ended on its own before the AFK limit')
        }
        assertMirrored(A, B, battleId, fa, fb)
      } finally { await Promise.all([A.close(), B.close()]) }
    })
  })
})

// ----------------------------------------------------------------------------- client modules (pure parts)

test('client arena matches the server for every seed', () => {
  for (let seed = 0; seed < 500; seed += 7) assert.deepEqual(clientArenaFor(seed), arenaFor(seed))
})

test('pvp outcome mapping and end-event fallback', () => {
  assert.equal(outcomeOf('win'), 'win')
  assert.equal(outcomeOf('disconnect'), 'win')
  assert.equal(outcomeOf('lose'), 'loss')
  assert.equal(outcomeOf('forfeit'), 'loss')
  assert.equal(outcomeOf('draw'), 'draw')
  assert.equal(resultFromEnd({ t: 'end', result: 'win', winner: 0 }), 'win')
  assert.equal(resultFromEnd({ t: 'end', result: 'forfeit', winner: 1 }), 'forfeit')
  assert.equal(resultFromEnd({ t: 'end', result: 'lose', winner: 1 }), 'lose')
  assert.equal(resultFromEnd({ t: 'end', result: 'draw', winner: -1 }), 'draw')
})

test('pvpParty clones, caps the size and honours healParty', () => {
  const p = party(CONTENT.config.party.maxParty, 10)
  const save = { party: p }
  const out = pvpParty(save)!
  assert.equal(out.length, CONTENT.config.party.maxParty)
  assert.notEqual(out[0], p[0])
  assert.equal(pvpParty({ party: [] }), null)
  const fainted = { party: party(1, 5).map((c) => ({ ...c, hp: 0 })) }
  assert.equal(pvpParty(fainted, { healParty: false }), null)
  assert.ok(pvpParty(fainted, { healParty: true }))
})

test('buildPvpInit: level-capped own party, opponent lead with matching max hp, bench placeholders', () => {
  const cap = CONTENT.config.net.pvpLevelCap
  const high = Math.min(CONTENT.config.party.maxLevel, cap + 5)
  const sent = party(2, high)
  const theirs = party(1, Math.max(1, cap - 3))[0]
  const view = { uid: theirs.uid, speciesId: theirs.speciesId, level: theirs.level, hp: maxHp(theirs), maxHp: maxHp(theirs), status: null, shiny: false }
  const start = { t: 'pvp.start' as const, battleId: 'b', side: 0 as const, opponent: { id: 'o', name: 'Opp', avatar: 'hero_boy' }, levelCap: cap }
  const yourParty = sent.map((c) => ({ uid: c.uid, speciesId: c.speciesId, level: Math.min(c.level, cap), hp: 7, maxHp: 99, status: null, shiny: false }))
  const init = buildPvpInit({ name: 'Me' }, start, { t: 'pvp.begin', battleId: 'b', seed: 42, yourParty, theirLead: view, theirPartySize: 3 }, sent)
  assert.equal(init.sides[0].party.length, 2)
  assert.ok(init.sides[0].party.every((c) => c.level === Math.min(high, cap) && c.hp === 7))
  assert.notEqual(init.sides[0].party[0], sent[0], 'display party is a clone')
  assert.equal(sent[0].level, high, 'sent creatures untouched')
  assert.equal(init.sides[1].party.length, 3)
  assert.equal(init.sides[1].kind, 'remote')
  assert.equal(maxHp(init.sides[1].party[0]), view.maxHp, 'opponent stub reproduces the server max hp')
  assert.deepEqual({ biome: init.biome, timeOfDay: init.timeOfDay }, arenaFor(42))
  assert.equal(init.levelCap, cap)
  assert.ok(!init.isWild && !init.canRun && !init.canCatch && !init.expGain)
  const stub = creatureFromView({ ...view, nickname: 'Nick' }, { id: 'o', name: 'Opp' })
  assert.equal(stub.nickname, 'Nick')
  assert.equal(stub.otName, 'Opp')
})

/** Fake NetClient with scripted inbound messages. */
function fakeNet() {
  const listeners = new Map<string, Set<(m: ServerMsg) => void>>()
  const sent: ClientMsg[] = []
  const net = {
    status: 'online' as NetStatus,
    sent,
    on(type: string, fn: (m: never) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn as (m: ServerMsg) => void)
      return () => { listeners.get(type)?.delete(fn as (m: ServerMsg) => void) }
    },
    send(m: ClientMsg) { sent.push(m) },
    emit(m: ServerMsg) { for (const fn of [...(listeners.get(m.t) ?? [])]) fn(m) },
  }
  return net
}

test('pvp channel: merges wait batches, skips stale submits, ends on end events, pvp.end and lost connections', async () => {
  const net = fakeNet()
  const events = createEventBus<GameEvents>()
  const ch = createPvpChannel(net as never, 'B1', events)
  const msg = (text: string): BattleEvent => ({ t: 'msg', text })
  const act = { kind: 'action', canSwitch: true, canRun: false, canItem: false } as const

  const p0 = ch.start()
  net.emit({ t: 'pvp.events', battleId: 'other', events: [msg('x')], request: act })
  net.emit({ t: 'pvp.events', battleId: 'B1', events: [msg('a')], request: { kind: 'wait' } })
  await sleep(5)
  net.emit({ t: 'pvp.events', battleId: 'B1', events: [msg('b')], request: act })
  const r0 = await p0
  assert.deepEqual(r0.events, [msg('a'), msg('b')], 'wait batch merged into the next decision')
  assert.equal(r0.request.kind, 'action')

  const p1 = ch.submit({ kind: 'move', moveIndex: 1 })
  assert.deepEqual(net.sent.at(-1), { t: 'pvp.action', battleId: 'B1', action: { kind: 'move', moveIndex: 1 } })
  net.emit({ t: 'pvp.events', battleId: 'B1', events: [msg('turn')], request: act })
  assert.equal((await p1).events.length, 1)

  // The server auto-picked (timer) before we answered: the stale action is not sent.
  net.emit({ t: 'pvp.events', battleId: 'B1', events: [msg('auto')], request: act })
  const before = net.sent.length
  const p2 = await ch.submit({ kind: 'move', moveIndex: 0 })
  assert.equal(net.sent.length, before)
  assert.deepEqual(p2.events, [msg('auto')])

  const p3 = ch.submit({ kind: 'move', moveIndex: 0 })
  net.emit({ t: 'pvp.events', battleId: 'B1', events: [msg('ko'), { t: 'end', result: 'win', winner: 0 }], request: { kind: 'wait' } })
  const r3 = await p3
  assert.equal(r3.request.kind, 'wait')
  assert.ok(ch.ended)
  assert.equal(ch.result, 'win')
  const waiting = ch.waitResult(1000)
  net.emit({ t: 'pvp.end', battleId: 'B1', result: 'win' })
  assert.equal(await waiting, 'win')
  const n = net.sent.length
  ch.dispose()
  assert.equal(net.sent.length, n, 'no forfeit after the end')

  // Lost connection mid-battle → synthetic end, counted as a loss, no forfeit message.
  const ch2 = createPvpChannel(net as never, 'B2', events)
  const q = ch2.start()
  events.emit('net:status', { status: 'connecting' })
  const r = await q
  assert.equal(r.events.at(-1)?.t, 'end')
  assert.ok(ch2.connectionLost && ch2.ended)
  assert.equal(outcomeOf(ch2.result!), 'loss')
  ch2.dispose()

  // Disposing a running battle forfeits it.
  const ch3 = createPvpChannel(net as never, 'B3', events)
  ch3.dispose()
  assert.deepEqual(net.sent.at(-1), { t: 'pvp.forfeit', battleId: 'B3' })
  const ch4 = createPvpChannel(net as never, 'B4', events)
  ch4.dispose(false)
  assert.notDeepEqual(net.sent.at(-1), { t: 'pvp.forfeit', battleId: 'B4' })
})

function saveWith(partyList: Creature[]): SaveData {
  return {
    version: 1, playerId: 'p', name: 'Me', avatar: '', createdAt: 0, playTimeSec: 0, money: 0, badges: [], party: partyList,
    boxes: Array.from({ length: CONTENT.config.party.boxCount }, () => []), bag: {}, dexSeen: [], dexCaught: [],
    position: { map: 'm', x: 0, y: 0, facing: 'down' }, respawn: { map: 'm', x: 0, y: 0, facing: 'down' }, flags: {}, quests: {},
    visitedTowns: [], exploredChunks: {}, repelSteps: 0, clockMinutes: 0,
    stats: { battlesWon: 0, caught: 0, steps: 0, pvpWins: 0, pvpLosses: 0, trades: 0, shiniesFound: 0 },
    settings: CONTENT.config.defaultSettings,
  }
}

test('trade rules: offerability, IV stars, applying a completed trade', () => {
  const [a, b] = party(2, 10)
  assert.equal(canOffer([a], a), false, 'never the last creature')
  assert.equal(canOffer([a, { ...b, hp: 0 }], a), false, 'never the last healthy creature')
  assert.deepEqual(offerableIndices([a, b]), [0, 1])
  const ivMax = CONTENT.config.creature.ivMax
  assert.equal(ivStars({ ivs: { hp: ivMax, atk: ivMax, def: ivMax, spa: ivMax, spd: ivMax, spe: ivMax } }), TRADE_RULES.ivStars)
  assert.equal(ivStars({ ivs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } }), 0)

  const save = saveWith([a, b])
  const incoming = party(1, 12, 'Other')[0]
  const res = applyTradeResult(save, a.uid, incoming)
  assert.equal(res.where, 'party')
  assert.equal(res.index, 0)
  assert.equal(res.given, a)
  assert.equal(save.party[0].uid, incoming.uid, 'received takes the given creature\'s slot')
  assert.notEqual(save.party[0], incoming, 'stored as a copy')
  assert.equal(save.party.length, 2)
  assert.ok(res.newSeen && res.newCaught && save.dexCaught.includes(incoming.speciesId))
  assert.equal(save.stats.trades, 1)
  const again = applyTradeResult(save, b.uid, { ...incoming })
  assert.notEqual(save.party[1].uid, incoming.uid, 'uid collision gets a fresh uid')
  assert.equal(again.newCaught, false)

  // Given creature not in the party (boxed) and a full party → received goes to the first box with room.
  const full = party(CONTENT.config.party.maxParty, 5)
  const s2 = saveWith(full)
  const boxed = party(1, 5)[0]
  s2.boxes[0].push(boxed)
  const r2 = applyTradeResult(s2, boxed.uid, party(1, 5)[0])
  assert.equal(r2.where, 'box')
  assert.equal(s2.boxes[0].length, 1)
  assert.equal(s2.party.length, CONTENT.config.party.maxParty)
})

// ----------------------------------------------------------------------------- client channel against the real server

test('pvp channel drives a real battle through two NetClients', async () => {
  await withServer(8797, {}, async (port) => {
    const url = `ws://localhost:${port}${NET.protocol.wsPath}`
    const mk = (name: string) => {
      const events = createEventBus<GameEvents>()
      const profile: PublicProfile = { id: '', name, avatar: '', badges: [], dexCaught: 0, party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0 }
      const net = createNetClient(events, () => ({
        t: 'hello', v: CONTENT.config.net.protocolVersion, playerId: crypto.randomUUID(), name, avatar: '', map: MAP, x: 3, y: 3, facing: 'down', lead: null, profile,
      }), { url })
      return { net, events }
    }
    const A = mk('Pia')
    const B = mk('Quin')
    const rosterA = trackOnlineRoster(A.net)
    A.net.connect()
    B.net.connect()
    try {
      for (let i = 0; i < 200 && (A.net.status !== 'online' || B.net.status !== 'online'); i++) await sleep(10)
      assert.equal(A.net.status, 'online')
      const nextOf = <T extends ServerMsg['t']>(net: typeof A.net, type: T) => new Promise<Extract<ServerMsg, { t: T }>>((resolve) => {
        const off = net.on(type, (m) => { off(); resolve(m) })
      })
      const challenged = nextOf(B.net, 'pvp.challenged')
      A.net.send({ t: 'pvp.challenge', to: B.net.selfId! })
      await challenged
      const sa = nextOf(A.net, 'pvp.start')
      const sb = nextOf(B.net, 'pvp.start')
      B.net.send({ t: 'pvp.respond', from: A.net.selfId!, accept: true })
      const [startA, startB] = await Promise.all([sa, sb])
      const chA = createPvpChannel(A.net, startA.battleId, A.events)
      const chB = createPvpChannel(B.net, startB.battleId, B.events)
      A.net.send({ t: 'pvp.party', battleId: startA.battleId, party: party(1, 30) })
      await sleep(PVP_GAP_MS)
      B.net.send({ t: 'pvp.party', battleId: startB.battleId, party: party(1, 30) })

      const drive = async (ch: typeof chA) => {
        let r = await ch.start()
        let attempt = 0
        let turns = 0
        while (!ch.ended && turns++ < 200) {
          if (r.request.kind === 'wait') break
          const rejected = r.events.length === 1 && r.events[0].t === 'msg'
          attempt = rejected ? attempt + 1 : 0
          await sleep(PVP_GAP_MS)
          r = await ch.submit(r.request.kind === 'switch'
            ? { kind: 'switch', partyIndex: attempt }
            : { kind: 'move', moveIndex: attempt % CONTENT.config.party.maxMoves })
        }
        return ch.waitResult(3000)
      }
      const [ra, rb] = await Promise.all([drive(chA), drive(chB)])
      assert.ok(ra && rb, 'both channels saw the end')
      if (ra === 'draw') assert.equal(rb, 'draw')
      else assert.deepEqual(new Set([outcomeOf(ra!), outcomeOf(rb!)]), new Set(['win', 'loss']))
      chA.dispose()
      chB.dispose()
      const deadline = Date.now() + (NET.server.onlineSummarySeconds + 1) * 1000
      while (Date.now() < deadline && !rosterA.players.some((p) => p.id === B.net.selfId)) await sleep(50)
      assert.ok(rosterA.players.some((p) => p.id === B.net.selfId), 'roster tracks online summaries')
    } finally {
      A.net.disconnect()
      B.net.disconnect()
    }
  })
})
