// Behavioral tests for Issue #22:
// - RFC 2104 HMAC-SHA256 & monotonic sliding-window replay protection (src/shared/net-envelope.ts)
// - Server save HMAC signing, tamper detection on load, portable save verification & untrusted import isolation (src/server/save-sign.ts)
// - Authoritative PvE battles (wild, trainer, boss + contract), shop, item use, ledger & audit log (src/server/authority.ts)
// - Cross-account trade ownership & PvP party fabrication prevention
// - End-to-end client PveChannel & NetClient signed session envelopes
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BattleAction, Creature, Dir, SaveData, World } from '../src/shared/types.ts'
import type { ClientMsg, PublicProfile, ServerMsg } from '../src/shared/protocol.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import { createCreature } from '../src/shared/creature.ts'
import { hashString, Rng } from '../src/shared/rng.ts'
import { loadWorldInfo, type WorldInfo } from '../src/server/world.ts'
import { starterSpecies } from '../src/shared/world/story.ts'
import { contractOdds, instanceOfBoss } from '../src/shared/gameplay/instances.ts'
import { collisionField, elevationAt, regionAt } from '../src/shared/world/worldapi.ts'
import {
  canonicalJson, createReplayWindow, hmacSha256WebCrypto, signEnvelope,
} from '../src/shared/net-envelope.ts'
import {
  hmacSha256HexNode, signEnvelopeNode, verifyEnvelope,
} from '../src/server/net-envelope.ts'
import { portableChecksum, signPortableSave, verifyPortableSave } from '../src/shared/save-provenance.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { decodeSaveCode, encodeSaveCode, encodeSignedSaveCode } from '../src/client/core/save-codec.ts'
import { createEventBus } from '../src/client/core/events.ts'
import { createNetClient } from '../src/client/net/index.ts'
import { createPveChannel, requestOnlineBattleStart } from '../src/client/net/pve-channel.ts'
import type { GameEvents } from '../src/client/contracts.ts'
import { startServer } from '../src/server/index.ts'
import { NET } from '../src/server/config.ts'
import { createPvp } from '../src/server/pvp.ts'
import { signServerSave, verifyServerSave } from '../src/server/save-sign.ts'
import type { AuthorityService } from '../src/server/authority.ts'
import type { ProfileStore } from '../src/server/store.ts'

let cachedWorldInfoPromise: Promise<WorldInfo> | null = null
function getSharedWorldInfo(): Promise<WorldInfo> {
  cachedWorldInfoPromise ??= loadWorldInfo().then((info) => {
    assert.ok(info?.world, 'worldInfo must load generated world')
    return info
  })
  return cachedWorldInfoPromise
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-auth22-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function makeCreature(seed: number, level = 12, speciesIdx = 0): Creature {
  const sp = CONTENT.speciesList[speciesIdx % CONTENT.speciesList.length]
  const cr = createCreature(sp.id, level, { rng: new Rng(seed), otName: 'Tester', shiny: false }, CONTENT)
  const dmgIdx = cr.moves.findIndex((m) => (CONTENT.moves[m.id]?.power ?? 0) > 0)
  if (dmgIdx > 0) {
    ;[cr.moves[0], cr.moves[dmgIdx]] = [cr.moves[dmgIdx], cr.moves[0]]
  }
  return cr
}

function makeTestSave(playerId: string, name = 'Alice', world: World): SaveData {
  const mgr = createSaveManager({ world, now: () => 1_700_000_000_000, newId: () => playerId })
  const save = mgr.newGame({ name, avatar: CONTENT.characters[0]?.id ?? '' })
  const baseSeed = (Math.abs(hashString(playerId)) % 100000) + 1
  save.party = [makeCreature(baseSeed * 10 + 1, 15, 0), makeCreature(baseSeed * 10 + 2, 15, 1)]
  return save
}

interface WildEncounterSpot {
  map: string
  x: number
  y: number
  speciesId: string
  level: number
}

function findWildEncounterSpot(world: World): WildEncounterSpot {
  const ow = world.maps[world.startMap]
  assert.ok(ow, 'world startMap must exist')
  const col = collisionField(ow)
  let best: (WildEncounterSpot & { minLv: number; dist: number }) | null = null
  for (let y = 1; y < ow.height - 1; y++) {
    for (let x = 1; x < ow.width - 2; x++) {
      if (col.at(x, y) !== 0 || col.at(x + 1, y) !== 0) continue
      if (elevationAt(ow, x, y) !== elevationAt(ow, x + 1, y)) continue
      const r0 = regionAt(ow, x, y)
      const r1 = regionAt(ow, x + 1, y)
      if (!r0 || !r1 || r0.id !== r1.id || r0.encounters.length === 0) continue
      const slot = r0.encounters[0]
      const minLv = Math.min(slot.minLevel, slot.maxLevel)
      const dist = Math.hypot(x - ow.spawn.x, y - ow.spawn.y)
      if (!best || minLv < best.minLv || (minLv === best.minLv && dist < best.dist)) {
        best = {
          map: world.startMap,
          x,
          y,
          speciesId: slot.species,
          level: minLv,
          minLv,
          dist,
        }
      }
    }
  }
  assert.ok(best, 'generated world must contain a walkable wild encounter region')
  return best
}
interface RawWsClient {
  ws: WebSocket
  msgs: ServerMsg[]
  selfId: string
  sessionKey: string
  seq: number
  sendRaw(obj: Record<string, unknown>): void
  sendSigned(msg: ClientMsg | Record<string, unknown>, customSeq?: number): number
  waitFor<T extends ServerMsg['t']>(type: T, pred?: (m: Extract<ServerMsg, { t: T }>) => boolean, from?: number): Promise<Extract<ServerMsg, { t: T }>>
  close(): Promise<void>
}
function promiseResolvers<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (err: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function connectRawClient(port: number, token?: string): Promise<RawWsClient> {
  const ws = new WebSocket(
    `ws://localhost:${port}${NET.protocol.wsPath}`,
    token ? ({ headers: { Cookie: `ap_session=${token}` } } as unknown as string[]) : undefined,
  )
  const msgs: ServerMsg[] = []
  const waiters = new Set<() => void>()
  const { promise: closedPromise, resolve: resolveClosed } = promiseResolvers<void>()
  let closedResolved = false
  ws.addEventListener('close', () => {
    if (!closedResolved) {
      closedResolved = true
      resolveClosed()
    }
  })
  ws.addEventListener('message', (e) => {
    msgs.push(JSON.parse(String(e.data)) as ServerMsg)
    for (const w of [...waiters]) w()
  })

  const client: RawWsClient = {
    ws,
    msgs,
    selfId: '',
    sessionKey: '',
    seq: 0,
    sendRaw(obj) {
      ws.send(JSON.stringify(obj))
    },
    sendSigned(msg, customSeq) {
      const s = customSeq ?? ++client.seq
      if (s > client.seq) client.seq = s
      const signed = signEnvelopeNode(client.sessionKey, msg as Record<string, unknown>, s)
      ws.send(JSON.stringify(signed))
      return s
    },
    waitFor(type, pred = () => true, from = msgs.length) {
      const callSiteErr = new Error(`timeout waiting for ${type}`)
      const { promise, resolve, reject } = promiseResolvers<Extract<ServerMsg, { t: typeof type }>>()
      let i = from
      const check = () => {
        for (; i < msgs.length; i++) {
          const m = msgs[i]
          if (m.t === type && pred(m as Extract<ServerMsg, { t: typeof type }>)) {
            cleanup()
            resolve(m as Extract<ServerMsg, { t: typeof type }>)
            return
          }
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        callSiteErr.message = `timeout waiting for ${type}; got ${msgs.slice(from).map((x) => (x.t === 'error' ? `error:${x.code}` : x.t)).join(',')}`
        reject(callSiteErr)
      }, 4000)
      const cleanup = () => {
        clearTimeout(timer)
        waiters.delete(check)
      }
      waiters.add(check)
      check()
      return promise
    },
    close() {
      ws.close()
      return closedPromise
    },
  }
  const { promise: openPromise, resolve: resolveOpen, reject: rejectOpen } = promiseResolvers<RawWsClient>()
  ws.addEventListener('open', () => resolveOpen(client))
  ws.addEventListener('error', () => rejectOpen(new Error('ws open failed')))
  return openPromise
}

let registerSeq = 0

interface LoginSeedOptions {
  map?: string
  x?: number
  y?: number
  facing?: Dir
  save?: SaveData
  party?: Creature[]
  bag?: Record<string, number>
  money?: number
  badges?: string[]
  flags?: Record<string, boolean | number | string>
  imported?: boolean
  trusted?: boolean
}

async function loginSignedClient(
  srv: { port: number; store: ProfileStore; authority: AuthorityService },
  world: World,
  name: string,
  opts: LoginSeedOptions = {},
): Promise<RawWsClient> {
  const seq = ++registerSeq
  const syntheticIp = `10.220.${(seq >> 8) & 255}.${seq & 255}`
  const reg = await srv.store.registerAccount(name, 'StrongPass#123', { ip: syntheticIp })
  assert.ok(reg.ok)
  const accountId = reg.account.id

  // Seed player save and position BEFORE WS hello; online setSave/commitSave syncs position from live player state.
  const baseSave = opts.save ? structuredClone(opts.save) : makeTestSave(accountId, name, world)
  baseSave.playerId = accountId
  baseSave.name = name
  const map = opts.map ?? baseSave.position.map
  const x = opts.x ?? baseSave.position.x
  const y = opts.y ?? baseSave.position.y
  const facing = opts.facing ?? baseSave.position.facing ?? 'down'
  baseSave.position = { map, x, y, facing }
  baseSave.respawn = { map, x, y, facing }
  if (opts.party !== undefined) baseSave.party = structuredClone(opts.party)
  if (opts.bag !== undefined) baseSave.bag = { ...opts.bag }
  if (opts.money !== undefined) baseSave.money = opts.money
  if (opts.badges !== undefined) baseSave.badges = [...opts.badges]
  if (opts.flags !== undefined) Object.assign(baseSave.flags, opts.flags)
  const imported = opts.imported === true
  const trusted = opts.trusted ?? !imported
  srv.authority.setSave(accountId, baseSave, { imported, trusted })

  const token = reg.session.token
  const c = await connectRawClient(srv.port, token)
  const from = c.msgs.length
  const profile: PublicProfile = { id: accountId, name, avatar: '', badges: [], dexCaught: 0, party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0 }
  c.sendRaw({
    t: 'hello',
    v: CONTENT.config.net.protocolVersion,
    playerId: accountId,
    name,
    avatar: '',
    map,
    x,
    y,
    facing,
    lead: null,
    profile,
    signed: true,
  })
  const w = await c.waitFor('welcome', undefined, from)
  c.selfId = w.selfId
  c.sessionKey = w.sessionKey ?? ''
  assert.ok(c.sessionKey.length >= 32, 'welcome must issue a sessionKey')
  return c
}

// ---------------------------------------------------------------------------
// 1. Standard HMAC-SHA256 & Monotonic Replay Window
// ---------------------------------------------------------------------------

test('net-envelope: pure WebCrypto matches node:crypto and replay window blocks duplicates/old seqs', async () => {
  const keys = ['short-key', 'a'.repeat(100), '密钥-🌟-secret-key-0123456789abcdef']
  const payloads = ['', 'hello world', canonicalJson({ t: 'shop.buy', itemId: 'ball', qty: 3, nested: { b: 2, a: 1 } })]
  for (const k of keys) {
    for (const p of payloads) {
      const expected = createHmac('sha256', k).update(p).digest('hex')
      assert.equal(hmacSha256HexNode(k, p), expected)
      const webSig = await hmacSha256WebCrypto(k, p)
      assert.equal(webSig, expected, 'WebCrypto HMAC must match node:crypto exactly')
    }
  }
  assert.equal(portableChecksum('domain', 'abc').length, 32)

  const win = createReplayWindow(64, 1000)
  const sessionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const m1 = signEnvelopeNode(sessionKey, { t: 'shop.buy', itemId: 'x', qty: 1 }, 1)
  assert.deepEqual(verifyEnvelope(sessionKey, m1, win, { requireSig: true }), { ok: true, authSeq: 1 })

  // Replaying seq 1 is rejected.
  const replay = verifyEnvelope(sessionKey, m1, win, { requireSig: true })
  assert.equal(replay.ok, false)
  if (!replay.ok) assert.equal(replay.code, 'replay_detected')

  // Out-of-order within window (authSeq 5 then authSeq 3) succeeds once each, while move.seq stays independent.
  const m5 = signEnvelopeNode(sessionKey, { t: 'move', seq: 1, x: 5 }, 5)
  const m3 = signEnvelopeNode(sessionKey, { t: 'move', seq: 1, x: 3 }, 3)
  assert.equal(verifyEnvelope(sessionKey, m5, win, { requireSig: true }).ok, true)
  assert.equal(verifyEnvelope(sessionKey, m3, win, { requireSig: true }).ok, true)
  assert.equal(verifyEnvelope(sessionKey, m3, win, { requireSig: true }).ok, false)
  // Advancing beyond window invalidates old seq 2.
  const m80 = signEnvelopeNode(sessionKey, { t: 'move', x: 80 }, 80)
  const m2 = signEnvelopeNode(sessionKey, { t: 'move', x: 2 }, 2)
  assert.equal(verifyEnvelope(sessionKey, m80, win, { requireSig: true }).ok, true)
  const old = verifyEnvelope(sessionKey, m2, win, { requireSig: true })
  assert.equal(old.ok, false)
  if (!old.ok) assert.equal(old.code, 'replay_detected')

  // Tampering with payload invalidates signature.
  const m81 = signEnvelopeNode(sessionKey, { t: 'shop.buy', itemId: 'x', qty: 1 }, 81)
  const tampered = { ...m81, qty: 99 }
  const badSig = verifyEnvelope(sessionKey, tampered, win, { requireSig: true })
  assert.equal(badSig.ok, false)
  if (!badSig.ok) assert.equal(badSig.code, 'bad_signature')
})

// ---------------------------------------------------------------------------
// 2. Signed Server Saves, Local Slot Verification & Untrusted Offline Imports
// ---------------------------------------------------------------------------

test('save-sign: server save HMAC detects disk tampering; untrusted offline imports are isolated', async () => {
  await withTempDir(async (dir) => {
    const worldInfo = await getSharedWorldInfo()
    const world = worldInfo.world!
    const secret = 'server-only-hmac-secret-0123456789abcdef0123456789abcdef'
    const save = makeTestSave('acc-1', 'Alice', world)
    const signed = signServerSave({
      version: save.version,
      accountId: 'acc-1',
      rev: 1,
      trusted: true,
      imported: false,
      updatedAt: Date.now(),
      save,
    }, secret)

    assert.equal(verifyServerSave(signed, secret).ok, true)
    assert.equal(verifyServerSave({ ...signed, save: { ...save, money: 999999 } }, secret).ok, false)
    assert.equal(verifyServerSave({ ...signed, trusted: true, imported: true }, secret).ok, false)

    // Local slot tamper detection via SaveManager.verifySlot
    const slotStore: Record<string, string> = {}
    const storage = {
      getItem: (k: string) => slotStore[k] ?? null,
      setItem: (k: string, v: string) => { slotStore[k] = v },
      removeItem: (k: string) => { delete slotStore[k] },
    }
    const mgr = createSaveManager({ world, storage })
    mgr.write(save, 0)
    assert.deepEqual(mgr.verifySlot?.(0), { valid: true, tampered: false })
    const rawSlot = JSON.parse(slotStore[`${CONTENT.config.save.storagePrefix}0`]!) as SaveData
    rawSlot.money = 888888
    slotStore[`${CONTENT.config.save.storagePrefix}0`] = JSON.stringify(rawSlot)
    const checkTampered = mgr.verifySlot?.(0)
    assert.equal(checkTampered?.tampered, true)
    assert.equal(checkTampered?.valid, false)

    // Signed save code & portable envelope verification
    const signedCode = encodeSignedSaveCode(save, save.version)
    assert.ok(decodeSaveCode(signedCode)?.signed)
    assert.equal(decodeSaveCode(`${signedCode.slice(0, -4)}ffff`), null)
    const portable = signPortableSave(save)
    assert.equal(verifyPortableSave(portable).ok, true)
    assert.equal(verifyPortableSave({ ...portable, save: { ...save, money: 777777 } }).ok, false)

    // Server refuses to load a tampered SQLite characters row on read, records an audit entry,
    // and isolates untrusted offline imports while preserving offline gameplay progress
    const srv1 = await startServer({ port: 0, dataDir: dir, distDir: pathJoin(dir, 'no-dist'), quiet: true, world: worldInfo, pvp: null })
    const buyableItem = CONTENT.itemList.find((it) => it.buyable && it.price > 0)!
    const masterBall = CONTENT.itemList.find((it) => it.effect.kind === 'ball' && it.effect.bonus === 'master')
    const offlineSave = makeTestSave('old-local-id', 'OfflineHero', world)
    offlineSave.maxDistance = 9000
    offlineSave.bag[buyableItem.id] = 250
    if (masterBall) offlineSave.bag[masterBall.id] = 99
    offlineSave.party[0].level = 80
    offlineSave.party[0].origin = { kind: 'boss', at: 1_700_000_000_000, boss: 'deepseek' }

    const regImport = await srv1.store.registerAccount('OfflineImporter', 'StrongPass#123', { ip: '127.0.0.1' })
    assert.ok(regImport.ok)
    const importAccId = regImport.account.id
    const imported = srv1.authority.importOfflineSave(importAccId, encodeSaveCode(offlineSave, offlineSave.version), { ip: '127.0.0.1' })
    assert.equal(imported.ok, true)
    if (imported.ok) {
      const impSave = imported.record.save
      assert.equal(imported.record.imported, true)
      assert.equal(imported.record.trusted, false)
      assert.equal(impSave.playerId, importAccId)
      assert.equal(impSave.flags['auth:untrustedImport'], true, 'imported save must carry auth:untrustedImport flag')
      assert.equal(impSave.stats.pvpWins, 0, 'offline pvpWins stripped')
      assert.equal(impSave.stats.pvpLosses, 0, 'offline pvpLosses stripped')
      assert.equal(impSave.stats.trades, 0, 'offline trades stripped')
      assert.ok(!impSave.maxDistance, 'offline maxDistance stripped')
      assert.ok(impSave.party.every((c) => c.origin?.kind === 'legacy'), 'imported creatures marked legacy')
      assert.equal(srv1.authority.isUntrustedImport(importAccId), true, 'isUntrustedImport reports true for imported save')
      const tradeCheck = srv1.authority.validateTradeOffer(importAccId, impSave.party[0], '127.0.0.1')
      assert.deepEqual(tradeCheck, { ok: false, code: 'trade_untrusted_creature' }, 'untrusted imported save blocked from trade')
      const pvpCheck = srv1.authority.validatePvpParty(importAccId, impSave.party, true, '127.0.0.1')
      assert.equal(pvpCheck, null, 'untrusted imported save blocked from PvP')
    }

    // Tampered save code or out-of-bounds raw save is rejected on import
    const regBad = await srv1.store.registerAccount('BadImporter', 'StrongPass#123', { ip: '127.0.0.1' })
    assert.ok(regBad.ok)
    const badCode = srv1.authority.importOfflineSave(regBad.account.id, '3.corruptedpayload.00000000', { ip: '127.0.0.1' })
    assert.equal(badCode.ok, false)
    if (!badCode.ok) assert.equal(badCode.code, 'save_tampered')

    const outOfBounds = srv1.authority.importOfflineSave(regBad.account.id, { ...offlineSave, money: -999 }, { ip: '127.0.0.1' })
    assert.equal(outOfBounds.ok, false)
    if (!outOfBounds.ok) assert.equal(outOfBounds.code, 'save_tampered')

    const regTamper = await srv1.store.registerAccount('TamperTarget', 'StrongPass#123', { ip: '127.0.0.1' })
    assert.ok(regTamper.ok)
    const tamperId = regTamper.account.id
    srv1.authority.setSave(tamperId, makeTestSave(tamperId, 'TamperTarget', world))
    await srv1.close()

    const sqlitePath = pathJoin(dir, NET.store.sqliteFile)
    const rawDb = new DatabaseSync(sqlitePath)
    const charRow = rawDb.prepare('SELECT save_json FROM characters WHERE account_id = ?').get(tamperId)
    assert.ok(charRow && typeof charRow.save_json === 'string')
    const tamperedSave = JSON.parse(charRow.save_json) as SaveData
    tamperedSave.money = 9_999_999
    rawDb.prepare('UPDATE characters SET save_json = ? WHERE account_id = ?').run(JSON.stringify(tamperedSave), tamperId)
    rawDb.close()
    const srv2 = await startServer({ port: 0, dataDir: dir, distDir: pathJoin(dir, 'no-dist'), quiet: true, world: worldInfo, pvp: null })
    try {
      assert.equal(srv2.authority.getSave(tamperId), null, 'tampered server save in SQLite must be refused on load')
      assert.equal(srv2.store.getSave(tamperId), null, 'store.getSave must also refuse tampered save_sig')
      const audits = srv2.authority.listAudit(tamperId)
      assert.ok(audits.some((a) => a.kind === 'save.tamper_detected'), 'tampered server save must write an audit entry')
    } finally {
      await srv2.close()
    }
  })
})
// ---------------------------------------------------------------------------
// 3. Authoritative Battles, Tamper/Replay Rejection, Ownership & Economy
// ---------------------------------------------------------------------------

test('server authority: valid battles update save once; tampered results/exp/items/signatures/replay and cross-account theft are rejected and audited', async () => {
  await withTempDir(async (dir) => {
    const worldInfo = await getSharedWorldInfo()
    const world = worldInfo.world!
    const wildSpot = findWildEncounterSpot(world)
    const deepseekInst = instanceOfBoss('deepseek')!
    const cursorInst = instanceOfBoss('cursor')!
    assert.ok(deepseekInst?.def.entry && cursorInst?.def.entry)
    const deepseekEntry = deepseekInst.def.entry
    const cursorEntry = cursorInst.def.entry

    const srv = await startServer({
      port: 0,
      dataDir: dir,
      distDir: pathJoin(dir, 'no-dist'),
      quiet: true,
      world: worldInfo,
      pvp: { createPvp: (host) => createPvp(host, { partySeconds: 5, turnSeconds: 5 }) },
    })
    const clients: RawWsClient[] = []
    try {
      const ballItem = CONTENT.items['prompt-ball']
      const healItem = CONTENT.items['cache-potion']
      assert.ok(ballItem?.buyable && healItem?.buyable)

      // Seed authoritative saves and positions on origin-lab-b1 BEFORE WS hello
      const aliceInitialParty = [makeCreature(777, 50, 0), makeCreature(202, 15, 1)]
      const bobInitialParty = [makeCreature(101, 15, 0), makeCreature(303, 15, 1)]
      const alice = await loginSignedClient(srv, world, 'Alice', {
        map: deepseekEntry.map,
        x: deepseekEntry.x,
        y: deepseekEntry.y,
        party: aliceInitialParty,
        bag: { [ballItem.id]: 5, [healItem.id]: 2 },
        money: 3000,
      })
      const bob = await loginSignedClient(srv, world, 'Bob', {
        map: deepseekEntry.map,
        x: deepseekEntry.x,
        y: deepseekEntry.y,
        party: bobInitialParty,
      })
      clients.push(alice, bob)

      // 3a. Wire-level HMAC tamper and sequence replay rejection + audit (ds-supply on origin-lab-b1 offers prompt-ball)
      const mFrom = alice.msgs.length
      const usedSeq = alice.sendSigned({ t: 'shop.buy', itemId: ballItem.id, qty: 1 })
      const sync1 = await alice.waitFor('state.sync', undefined, mFrom)
      assert.equal(sync1.save.bag[ballItem.id], 6)
      assert.equal(sync1.save.money, 3000 - ballItem.price)

      // Buying a badge-gated / non-offered shop item on origin-lab-b1 is rejected and audited
      const lockedShopFrom = bob.msgs.length
      bob.sendSigned({ t: 'shop.buy', itemId: 'full-restore', qty: 1 })
      await bob.waitFor('error', (e) => e.code === 'shop_invalid', lockedShopFrom)
      assert.ok(srv.authority.listAudit(bob.selfId).some((a) => a.kind === 'shop.locked_tier_item'))
      // Replay the exact same signed message with the same seq -> rejected + audited
      const rFrom = alice.msgs.length
      alice.sendSigned({ t: 'shop.buy', itemId: ballItem.id, qty: 1 }, usedSeq)
      const replayErr = await alice.waitFor('error', (e) => e.code === 'replay_detected', rFrom)
      assert.equal(replayErr.code, 'replay_detected')
      assert.equal(srv.authority.getSave(alice.selfId)!.bag[ballItem.id], 6, 'replay must not execute twice')
      assert.ok(srv.authority.listAudit(alice.selfId).some((a) => a.kind === 'protocol.replay_detected'))

      // Tamper with payload after signing -> rejected + audited
      const tFrom = alice.msgs.length
      const nextSeq = ++alice.seq
      const validSigned = await signEnvelope(alice.sessionKey, { t: 'shop.buy', itemId: ballItem.id, qty: 1 }, nextSeq)
      alice.sendRaw({ ...validSigned, qty: 50 })
      const sigErr = await alice.waitFor('error', (e) => e.code === 'bad_signature', tFrom)
      assert.equal(sigErr.code, 'bad_signature')
      assert.equal(srv.authority.getSave(alice.selfId)!.bag[ballItem.id], 6, 'tampered frame must not execute')
      assert.ok(srv.authority.listAudit(alice.selfId).some((a) => a.kind === 'protocol.bad_signature'))

      // 3b. Forged battle results, forged exp, and unowned item mutations rejected + audited
      const fFrom = bob.msgs.length
      bob.sendSigned({ t: 'battle.result', result: 'win', exp: 999999, money: 500000 })
      await bob.waitFor('error', (e) => e.code === 'authority_violation', fFrom)
      assert.ok(srv.authority.listAudit(bob.selfId).some((a) => a.kind === 'authority.forged_message'))

      const sellFrom = bob.msgs.length
      bob.sendSigned({ t: 'shop.sell', itemId: ballItem.id, qty: 999 })
      await bob.waitFor('error', (e) => e.code === 'item_not_owned', sellFrom)
      assert.ok(srv.authority.listAudit(bob.selfId).some((a) => a.kind === 'shop.sell_not_owned'))

      const useFrom = bob.msgs.length
      bob.sendSigned({ t: 'item.use', itemId: 'non-existent-or-unowned-item', partyIndex: 0 })
      await bob.waitFor('error', (e) => e.code === 'item_not_owned', useFrom)
      assert.ok(srv.authority.listAudit(bob.selfId).some((a) => a.kind === 'item.not_owned'))

      // 3c. Valid authoritative battle in a real wild-encounter region executes on server and updates persisted save once
      alice.sendSigned({ t: 'move', map: wildSpot.map, x: wildSpot.x, y: wildSpot.y, facing: 'down' })
      const revBeforeBattle = srv.authority.getRecord(alice.selfId)!.rev
      const expBeforeBattle = srv.authority.getSave(alice.selfId)!.party[0].exp
      const bStartFrom = alice.msgs.length
      alice.sendSigned({
        t: 'battle.start',
        kind: 'wild',
        speciesId: wildSpot.speciesId,
        level: wildSpot.level,
      })
      const started = await alice.waitFor('battle.started', undefined, bStartFrom)
      assert.ok(started.battleId)

      // Tampering with battle.action by injecting forged result/exp/items is rejected + audited
      const bTamperFrom = alice.msgs.length
      alice.sendSigned({
        t: 'battle.action',
        battleId: started.battleId,
        action: { kind: 'move', moveIndex: 0 },
        result: 'win',
        exp: 50000,
        items: { [ballItem.id]: 99 },
      })
      await alice.waitFor('error', (e) => e.code === 'authority_violation', bTamperFrom)
      assert.ok(srv.authority.listAudit(alice.selfId).some((a) => a.kind === 'battle.tampered_action'))

      // Using an unowned item in battle is rejected + audited
      const masterBall = CONTENT.itemList.find((it) => it.effect.kind === 'ball' && it.effect.bonus === 'master')
      if (masterBall) {
        const bItemFrom = alice.msgs.length
        alice.sendSigned({
          t: 'battle.action',
          battleId: started.battleId,
          action: { kind: 'item', itemId: masterBall.id },
        })
        await alice.waitFor('error', (e) => e.code === 'item_not_owned', bItemFrom)
        assert.ok(srv.authority.listAudit(alice.selfId).some((a) => a.kind === 'battle.item_not_owned'))
      }

      // Play the battle to completion with valid move actions
      let finished = false
      for (let turn = 0; turn < 20 && !finished; turn++) {
        const stepFrom = alice.msgs.length
        alice.sendSigned({
          t: 'battle.action',
          battleId: started.battleId,
          action: { kind: 'move', moveIndex: 0 } satisfies BattleAction,
        })
        const batch = await alice.waitFor('battle.events', (m) => m.battleId === started.battleId, stepFrom)
        if (batch.events.some((e) => e.t === 'end')) {
          finished = true
        }
      }
      assert.equal(finished, true, 'authoritative wild battle should conclude')
      const endMsg = await alice.waitFor('battle.end', (m) => m.battleId === started.battleId, bStartFrom)
      assert.equal(endMsg.result, 'win')
      const recAfterBattle = srv.authority.getRecord(alice.selfId)!
      assert.equal(recAfterBattle.rev, revBeforeBattle + 1, 'persisted save rev must increment exactly once for the completed battle')
      assert.ok(recAfterBattle.save.party[0].exp > expBeforeBattle, 'server save party earned authoritative exp')
      assert.equal(recAfterBattle.save.stats.battlesWon, 1)

      // Return Alice to origin-lab-b1 where Bob is stationed for Trade, PvP, and DeepSeek boss entry
      alice.sendSigned({ t: 'move', map: deepseekEntry.map, x: deepseekEntry.x, y: deepseekEntry.y, facing: 'down' })

      // 3d. Cross-account Trade theft / tampering prevention & atomic swap
      const tReqFrom = bob.msgs.length
      const aTradeFrom = alice.msgs.length
      alice.sendSigned({ t: 'trade.request', to: bob.selfId })
      await bob.waitFor('trade.requested', (m) => m.from === alice.selfId, tReqFrom)
      bob.sendSigned({ t: 'trade.respond', from: alice.selfId, accept: true })
      const tradeStart = await alice.waitFor('trade.start', undefined, aTradeFrom)
      await bob.waitFor('trade.start', undefined, tReqFrom)

      // Alice tries to offer Bob's creature uid -> rejected (trade_not_owned) + audited
      const stealFrom = alice.msgs.length
      const bobTarget0 = srv.authority.getSave(bob.selfId)!.party[0]
      alice.sendSigned({ t: 'trade.offer', tradeId: tradeStart.tradeId, creature: bobTarget0 })
      await alice.waitFor('error', (e) => e.code === 'trade_not_owned', stealFrom)
      assert.ok(srv.authority.listAudit(alice.selfId).some((a) => a.kind === 'trade.ownership_violation'))

      // Alice tries to offer her own creature uid but with tampered level 99 -> rejected + audited
      const tamperOfferFrom = alice.msgs.length
      const aliceOwned0 = srv.authority.getSave(alice.selfId)!.party[0]
      alice.sendSigned({ t: 'trade.offer', tradeId: tradeStart.tradeId, creature: { ...aliceOwned0, level: 99 } })
      await alice.waitFor('error', (e) => e.code === 'trade_invalid_creature', tamperOfferFrom)
      assert.ok(srv.authority.listAudit(alice.selfId).some((a) => a.kind === 'trade.offer_tamper'))

      // Valid trade between Alice's slot 1 and Bob's slot 0 swaps ownership atomically without duplication
      const aliceOfferCr = srv.authority.getSave(alice.selfId)!.party[1]
      const bobOfferCr = srv.authority.getSave(bob.selfId)!.party[0]
      const validOfferFromA = alice.msgs.length
      const validOfferFromB = bob.msgs.length
      alice.sendSigned({ t: 'trade.offer', tradeId: tradeStart.tradeId, creature: aliceOfferCr })
      await alice.waitFor('trade.offer', (m) => m.side === 'self', validOfferFromA)
      bob.sendSigned({ t: 'trade.offer', tradeId: tradeStart.tradeId, creature: bobOfferCr })
      await bob.waitFor('trade.offer', (m) => m.side === 'self', validOfferFromB)

      const doneFromA = alice.msgs.length
      const doneFromB = bob.msgs.length
      alice.sendSigned({ t: 'trade.confirm', tradeId: tradeStart.tradeId })
      bob.sendSigned({ t: 'trade.confirm', tradeId: tradeStart.tradeId })
      await alice.waitFor('trade.complete', undefined, doneFromA)
      await bob.waitFor('trade.complete', undefined, doneFromB)

      const alicePartyUids = srv.authority.getSave(alice.selfId)!.party.map((c) => c.uid)
      const bobPartyUids = srv.authority.getSave(bob.selfId)!.party.map((c) => c.uid)
      assert.ok(alicePartyUids.includes(bobOfferCr.uid) && !alicePartyUids.includes(aliceOfferCr.uid))
      assert.ok(bobPartyUids.includes(aliceOfferCr.uid) && !bobPartyUids.includes(bobOfferCr.uid))

      // 3e. PvP party fabrication prevention
      const pvpFromB = bob.msgs.length
      const pvpFromA = alice.msgs.length
      alice.sendSigned({ t: 'pvp.challenge', to: bob.selfId })
      await bob.waitFor('pvp.challenged', undefined, pvpFromB)
      bob.sendSigned({ t: 'pvp.respond', from: alice.selfId, accept: true })
      const pvpStart = await alice.waitFor('pvp.start', undefined, pvpFromA)
      await bob.waitFor('pvp.start', undefined, pvpFromB)

      // Bob tries to submit a fabricated creature not in his server save -> PvP session aborted + audited
      const fabricated = makeCreature(9999, 100, 2)
      const fabFrom = bob.msgs.length
      bob.sendSigned({ t: 'pvp.party', battleId: pvpStart.battleId, party: [fabricated] })
      const pvpErr = await bob.waitFor('error', (e) => e.code === 'pvp_party_invalid', fabFrom)
      assert.equal(pvpErr.code, 'pvp_party_invalid')
      assert.ok(srv.authority.listAudit(bob.selfId).some((a) => a.kind === 'pvp.party_tamper'))

      // Untrusted imported account or legacy creature rejected from PvP
      const untrustedClient = await loginSignedClient(srv, world, 'UntrustedPvP', {
        map: deepseekEntry.map,
        x: deepseekEntry.x,
        y: deepseekEntry.y,
        imported: true,
        trusted: false,
      })
      clients.push(untrustedClient)
      const untrustedSave = srv.authority.getSave(untrustedClient.selfId)!
      const untrustedRes = srv.authority.validatePvpParty(untrustedClient.selfId, untrustedSave.party, true)
      assert.equal(untrustedRes, null, 'untrusted account party must be rejected from PvP')
      assert.ok(srv.authority.listAudit(untrustedClient.selfId).some((a) => a.kind === 'pvp.untrusted_party'))

      // 3f. Uncontextualized script.op mutations are rejected; world-verified town/respawn ops succeed
      // Use a fresh client on origin-lab-b1 so per-connection error rate limit (10/5s) is never saturated
      const scriptTester = await loginSignedClient(srv, world, 'ScriptTester', {
        map: deepseekEntry.map,
        x: deepseekEntry.x,
        y: deepseekEntry.y,
      })
      clients.push(scriptTester)

      const arbMoneyFrom = scriptTester.msgs.length
      scriptTester.sendSigned({ t: 'script.op', op: 'giveMoney', amount: 500 })
      await scriptTester.waitFor('error', (e) => e.code === 'authority_violation', arbMoneyFrom)
      assert.ok(srv.authority.listAudit(scriptTester.selfId).some((a) => a.kind === 'script.invalid_give_money'))

      const arbItemFrom = scriptTester.msgs.length
      scriptTester.sendSigned({ t: 'script.op', op: 'giveItem', itemId: ballItem.id, qty: 2 })
      await scriptTester.waitFor('error', (e) => e.code === 'authority_violation', arbItemFrom)
      assert.ok(srv.authority.listAudit(scriptTester.selfId).some((a) => a.kind === 'script.invalid_give_item'))

      const arbFlagFrom = scriptTester.msgs.length
      scriptTester.sendSigned({ t: 'script.op', op: 'setFlag', flag: 'champion', value: true })
      await scriptTester.waitFor('error', (e) => e.code === 'authority_violation', arbFlagFrom)
      assert.ok(srv.authority.listAudit(scriptTester.selfId).some((a) => a.kind === 'script.forged_flag'))

      const realTown = world.towns.find((tw) => tw.kind === 'town' && tw.id !== 'origin') ?? world.towns[0]
      assert.ok(realTown)
      const townSyncFrom = alice.msgs.length
      alice.sendSigned({ t: 'script.op', op: 'unlockTown', townId: realTown.id })
      await alice.waitFor('state.sync', undefined, townSyncFrom)
      assert.ok(srv.authority.getSave(alice.selfId)!.visitedTowns.includes(realTown.id))

      // Mismatched map in setRespawn is rejected; current player map succeeds
      const badRespFrom = scriptTester.msgs.length
      scriptTester.sendSigned({ t: 'script.op', op: 'setRespawn', map: 'origin-home', x: 3, y: 3, facing: 'down' })
      await scriptTester.waitFor('error', (e) => e.code === 'authority_violation', badRespFrom)
      assert.ok(srv.authority.listAudit(scriptTester.selfId).some((a) => a.kind === 'script.invalid_respawn'))

      const respSyncFrom = alice.msgs.length
      alice.sendSigned({
        t: 'script.op',
        op: 'setRespawn',
        map: deepseekEntry.map,
        x: deepseekEntry.x,
        y: deepseekEntry.y,
        facing: 'down',
      })
      await alice.waitFor('state.sync', undefined, respSyncFrom)
      assert.deepEqual(srv.authority.getSave(alice.selfId)!.respawn, {
        map: deepseekEntry.map,
        x: deepseekEntry.x,
        y: deepseekEntry.y,
        facing: 'down',
      })

      // Unverified scriptedOnly boss start rejected
      const scriptedBoss = Object.values(CONTENT.bossBySpecies).find((b) => b.scriptedOnly)
      if (scriptedBoss) {
        const bFailFrom = scriptTester.msgs.length
        scriptTester.sendSigned({ t: 'battle.start', kind: 'wild', speciesId: scriptedBoss.species, scripted: false })
        await scriptTester.waitFor('error', (e) => e.code === 'invalid_encounter', bFailFrom)
        assert.ok(srv.authority.listAudit(scriptTester.selfId).some((a) => a.kind === 'battle.invalid_encounter'))
      }

      // Locked boss tier (badgesAtLeast not met on real tier 'hard') is rejected with invalid_encounter
      const lockedBossFrom = scriptTester.msgs.length
      scriptTester.sendSigned({ t: 'battle.start', kind: 'boss', bossId: 'deepseek', tierId: 'hard' })
      await scriptTester.waitFor('error', (e) => e.code === 'invalid_encounter', lockedBossFrom)
      assert.ok(srv.authority.listAudit(scriptTester.selfId).some((a) => a.kind === 'battle.boss_tier_locked'))
      // 3g. Solo Boss Battle (story & repeat contract odds, pity, shard rewards & failure shard compensation)
      const bossLead = makeCreature(888, 100, 0)
      const prepSave = srv.authority.getSave(alice.selfId)!
      prepSave.party[0] = bossLead
      prepSave.bag[ballItem.id] = 10
      srv.authority.setSave(alice.selfId, prepSave, { imported: false, trusted: true })

      const shardItem = GAMEPLAY.instanceDefaults.shardItem ?? 'data-shard'
      const deepseekStoryRules = deepseekInst.def.tiers.story
      assert.ok(deepseekStoryRules)
      const bagBeforeBossWin = { ...srv.authority.getSave(alice.selfId)!.bag }
      const shardsBefore = bagBeforeBossWin[shardItem] ?? 0
      const bossStartFrom = alice.msgs.length
      alice.sendSigned({
        t: 'battle.start',
        kind: 'boss',
        bossId: 'deepseek',
        tierId: 'story',
        captureAfterWin: true,
      })
      const bossStarted = await alice.waitFor('battle.started', undefined, bossStartFrom)
      let bossEnded = false
      for (let turn = 0; turn < 30 && !bossEnded; turn++) {
        const stepFrom = alice.msgs.length
        alice.sendSigned({
          t: 'battle.action',
          battleId: bossStarted.battleId,
          action: { kind: 'move', moveIndex: 0 } satisfies BattleAction,
        })
        const batch = await alice.waitFor('battle.events', (m) => m.battleId === bossStarted.battleId, stepFrom)
        if (batch.events.some((e) => e.t === 'end')) bossEnded = true
      }
      assert.equal(bossEnded, true, 'deepseek story boss battle should finish')
      const bossEndMsg = await alice.waitFor('battle.end', (m) => m.battleId === bossStarted.battleId, bossStartFrom)
      assert.equal(bossEndMsg.result, 'win')

      const saveAfterBossWin = srv.authority.getSave(alice.selfId)!
      assert.equal(saveAfterBossWin.flags['bossWon:deepseek'], true)
      assert.ok((saveAfterBossWin.bag[shardItem] ?? 0) > shardsBefore, 'boss win must award data shards')
      for (const [rewardItemId, rewardQty] of Object.entries(deepseekStoryRules.firstReward.items ?? {})) {
        assert.equal(
          (saveAfterBossWin.bag[rewardItemId] ?? 0) - (bagBeforeBossWin[rewardItemId] ?? 0),
          rewardQty,
          `first boss win must award ${rewardQty}x ${rewardItemId} from firstReward.items`,
        )
      }

      // Unowned master ball in battle.contract is rejected with item_not_owned
      if (masterBall) {
        const badContractFrom = alice.msgs.length
        alice.sendSigned({
          t: 'battle.contract',
          battleId: bossStarted.battleId,
          bossId: 'deepseek',
          tierId: 'story',
          ballId: masterBall.id,
        })
        await alice.waitFor('error', (e) => e.code === 'item_not_owned', badContractFrom)
      }

      // Valid first-clear contract on deepseek story (capture.first = 1) signs Lv1 boss card via battle.contracted
      const contractFrom = alice.msgs.length
      alice.sendSigned({
        t: 'battle.contract',
        battleId: bossStarted.battleId,
        bossId: 'deepseek',
        tierId: 'story',
        ballId: ballItem.id,
      })
      const contracted = await alice.waitFor('battle.contracted', (m) => m.battleId === bossStarted.battleId, contractFrom)
      assert.ok(contracted.signed, 'first-clear story contract with capture.first=1 must sign boss card')
      assert.equal(contracted.signed.card.origin?.kind, 'boss')
      assert.equal(contracted.signed.card.origin?.boss, 'deepseek')
      assert.equal(contracted.signed.card.level, 1, 'signed boss card starts at Lv1 until badge settlement')
      const deepseekProg = contracted.save.instances?.[deepseekInst.id]
      assert.ok(deepseekProg, 'deepseek instance progress recorded under instances[deepseekInst.id]')
      assert.equal(deepseekProg.captures.story, 1)
      assert.equal(deepseekProg.lastRollRun?.story, deepseekProg.runSeq)

      // Replaying battle.contract for the same battleId is rejected with invalid_contract
      const dupContractFrom = alice.msgs.length
      alice.sendSigned({
        t: 'battle.contract',
        battleId: bossStarted.battleId,
        bossId: 'deepseek',
        tierId: 'story',
        ballId: ballItem.id,
      })
      await alice.waitFor('error', (e) => e.code === 'invalid_contract', dupContractFrom)

      // Cursor boss at gym-code: first clear has capture.first = 1, repeat clear has capture.repeat = 0.35
      const cursorStoryRules = cursorInst.def.tiers.story
      assert.ok(cursorStoryRules)
      assert.equal(contractOdds(cursorStoryRules, 0, false, 0).chance, cursorStoryRules.capture.first)
      assert.equal(contractOdds(cursorStoryRules, 0, true, 0).chance, cursorStoryRules.capture.repeat)

      alice.sendSigned({ t: 'move', map: cursorEntry.map, x: cursorEntry.x, y: cursorEntry.y, facing: 'up' })

      // First clear of cursor story (guaranteed first capture)
      const cursorFirstFrom = alice.msgs.length
      alice.sendSigned({
        t: 'battle.start',
        kind: 'boss',
        bossId: 'cursor',
        tierId: 'story',
        captureAfterWin: true,
      })
      const cursorFirstStarted = await alice.waitFor('battle.started', undefined, cursorFirstFrom)
      for (let turn = 0; turn < 30; turn++) {
        const stepFrom = alice.msgs.length
        alice.sendSigned({
          t: 'battle.action',
          battleId: cursorFirstStarted.battleId,
          action: { kind: 'move', moveIndex: 0 } satisfies BattleAction,
        })
        const batch = await alice.waitFor('battle.events', (m) => m.battleId === cursorFirstStarted.battleId, stepFrom)
        if (batch.events.some((e) => e.t === 'end')) break
      }
      await alice.waitFor('battle.end', (m) => m.battleId === cursorFirstStarted.battleId, cursorFirstFrom)
      const cursorFirstContractFrom = alice.msgs.length
      alice.sendSigned({
        t: 'battle.contract',
        battleId: cursorFirstStarted.battleId,
        bossId: 'cursor',
        tierId: 'story',
        ballId: ballItem.id,
      })
      const cursorFirstContracted = await alice.waitFor(
        'battle.contracted',
        (m) => m.battleId === cursorFirstStarted.battleId,
        cursorFirstContractFrom,
      )
      assert.ok(cursorFirstContracted.signed, 'cursor first clear contract (capture.first=1) must sign boss card')
      assert.equal(cursorFirstContracted.save.instances?.[cursorInst.id]?.captures.story, 1)

      // Repeat clear of cursor story (rolls capture.repeat odds, updates lastRollRun & pity or awards fail shards)
      const cursorRepeatFrom = alice.msgs.length
      alice.sendSigned({
        t: 'battle.start',
        kind: 'boss',
        bossId: 'cursor',
        tierId: 'story',
        captureAfterWin: true,
      })
      const cursorRepeatStarted = await alice.waitFor('battle.started', undefined, cursorRepeatFrom)
      let cursorEnded = false
      for (let turn = 0; turn < 30 && !cursorEnded; turn++) {
        const stepFrom = alice.msgs.length
        alice.sendSigned({
          t: 'battle.action',
          battleId: cursorRepeatStarted.battleId,
          action: { kind: 'move', moveIndex: 0 } satisfies BattleAction,
        })
        const batch = await alice.waitFor('battle.events', (m) => m.battleId === cursorRepeatStarted.battleId, stepFrom)
        if (batch.events.some((e) => e.t === 'end')) cursorEnded = true
      }
      assert.equal(cursorEnded, true, 'cursor repeat story battle should finish')
      await alice.waitFor('battle.end', (m) => m.battleId === cursorRepeatStarted.battleId, cursorRepeatFrom)
      const shardsBeforeCursorContract = srv.authority.getSave(alice.selfId)!.bag[shardItem] ?? 0
      const cursorContractFrom = alice.msgs.length
      alice.sendSigned({
        t: 'battle.contract',
        battleId: cursorRepeatStarted.battleId,
        bossId: 'cursor',
        tierId: 'story',
        ballId: ballItem.id,
      })
      const cursorContracted = await alice.waitFor(
        'battle.contracted',
        (m) => m.battleId === cursorRepeatStarted.battleId,
        cursorContractFrom,
      )
      const cursorProg = cursorContracted.save.instances?.[cursorInst.id]
      assert.ok(cursorProg, 'cursor instance progress recorded under instances[cursorInst.id]')
      assert.equal(cursorProg.lastRollRun?.story, cursorProg.runSeq, 'contract roll records lastRollRun')
      if (cursorContracted.signed) {
        assert.equal(cursorProg.pity?.story, 0)
        assert.equal(cursorProg.captures.story, 2)
      } else {
        assert.equal(cursorProg.pity?.story, 1, 'failed repeat contract roll increments pity')
        const expectedFailShards = cursorStoryRules.repeat.shards ?? GAMEPLAY.instanceDefaults.failShardQty ?? 1
        assert.equal(
          cursorContracted.save.bag[shardItem],
          shardsBeforeCursorContract + expectedFailShards,
          'failed contract roll awards failure shard compensation',
        )
      }
    } finally {
      await Promise.all(clients.map((c) => c.close()))
      await srv.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Client NetClient + PveChannel End-to-End Integration
// ---------------------------------------------------------------------------

test('client PveChannel + NetClient: signs session envelopes and drives authoritative battle end-to-end', async () => {
  await withTempDir(async (dir) => {
    const worldInfo = await getSharedWorldInfo()
    const world = worldInfo.world!
    const wildSpot = findWildEncounterSpot(world)
    const srv = await startServer({ port: 0, dataDir: dir, distDir: pathJoin(dir, 'no-dist'), quiet: true, world: worldInfo, pvp: null })
    const reg = await srv.store.registerAccount('ClientHero', 'StrongPass#123', { ip: '127.0.0.1' })
    assert.ok(reg.ok)
    const pid = reg.account.id

    // Seed authoritative save at wildSpot BEFORE WS hello
    const save = makeTestSave(pid, 'ClientHero', world)
    save.position = { map: wildSpot.map, x: wildSpot.x, y: wildSpot.y, facing: 'down' }
    save.respawn = { map: wildSpot.map, x: wildSpot.x, y: wildSpot.y, facing: 'down' }
    save.party[0] = makeCreature(555, 50, 0)
    srv.authority.setSave(pid, save, { imported: false, trusted: true })

    const events = createEventBus<GameEvents>()
    const profile: PublicProfile = { id: pid, name: 'ClientHero', avatar: '', badges: [], dexCaught: 0, party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0 }
    const net = createNetClient(events, () => ({
      t: 'hello',
      v: CONTENT.config.net.protocolVersion,
      playerId: pid,
      name: 'ClientHero',
      avatar: '',
      map: wildSpot.map,
      x: wildSpot.x,
      y: wildSpot.y,
      facing: 'down',
      lead: null,
      profile,
    }), {
      url: `ws://localhost:${srv.port}${NET.protocol.wsPath}`,
      headers: { Cookie: `ap_session=${reg.session.token}` },
    })

    try {
      const { promise: onlineReady, resolve: resolveOnline } = promiseResolvers<void>()
      const off = events.on('net:status', ({ status }) => {
        if (status === 'online') {
          off()
          resolveOnline()
        }
      })
      net.connect()
      await onlineReady
      assert.equal(net.status, 'online')
      assert.ok(net.selfId)

      // Interleave chat (advances authSeq) with walkable movement — no replay collisions!
      net.send({ t: 'chat', channel: 'global', text: 'hello before move' })
      net.reportPosition({ map: wildSpot.map, x: wildSpot.x + 1, y: wildSpot.y, facing: 'right', moving: true, running: false })
      net.send({ t: 'chat', channel: 'global', text: 'hello between moves' })
      net.reportPosition({ map: wildSpot.map, x: wildSpot.x + 1, y: wildSpot.y, facing: 'right', moving: false, running: false })

      const started = await requestOnlineBattleStart(net, {
        kind: 'wild',
        speciesId: wildSpot.speciesId,
        level: wildSpot.level,
      })
      assert.ok(started, 'requestOnlineBattleStart must receive battle.started')

      const ended: Extract<ServerMsg, { t: 'battle.end' }>[] = []
      const channel = createPveChannel(net, started, (e) => { ended.push(e) })
      const opening = await channel.start()
      assert.ok(opening.events.length > 0)

      for (let i = 0; i < 15 && !channel.ended; i++) {
        await channel.submit({ kind: 'move', moveIndex: 0 })
      }
      channel.dispose()
      assert.equal(ended.length, 1)
      assert.equal(ended[0].result, 'win')
    } finally {
      net.disconnect()
      await srv.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. World-Backed New-Account Prologue Progression & Anti-Cheat Authorization
// ---------------------------------------------------------------------------

test('world-backed prologue progression: starter selection, one-shot gifts, aide phi-3 & anti-cheat rejections', async () => {
  await withTempDir(async (dir) => {
    const worldInfo = await getSharedWorldInfo()
    const world = worldInfo.world!
    const srv = await startServer({
      port: 0,
      dataDir: dir,
      distDir: pathJoin(dir, 'no-dist'),
      quiet: true,
      world: worldInfo,
      pvp: null,
    })
    const clients: RawWsClient[] = []
    try {
      const mgr = createSaveManager({ world, now: () => 1_700_000_000_000 })
      const freshSave = mgr.newGame({ name: 'Rookie', avatar: CONTENT.characters[0]?.id ?? '' })
      const rookie = await loginSignedClient(srv, world, 'Rookie', {
        save: freshSave,
        map: 'origin-lab',
        x: 6,
        y: 6,
        facing: 'up',
      })
      clients.push(rookie)

      const [starter, alternateStarter] = starterSpecies().map((s) => s.id)
      // Forged creature payload in chooseStarter is ignored; server creates authoritative Lv5 starter
      const forgedStarter = makeCreature(123, 100, 0)
      forgedStarter.shiny = true
      forgedStarter.ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }
      const starterSyncFrom = rookie.msgs.length
      rookie.sendSigned({
        t: 'script.op',
        op: 'chooseStarter',
        speciesId: starter,
        creature: forgedStarter,
      })
      const afterStarter = await rookie.waitFor('state.sync', undefined, starterSyncFrom)
      assert.equal(afterStarter.save.party.length, 1)
      assert.equal(afterStarter.save.party[0].speciesId, starter)
      assert.equal(afterStarter.save.party[0].level, 5, 'server enforces Lv5 starter regardless of forged client creature')
      assert.notEqual(afterStarter.save.party[0].uid, forgedStarter.uid, 'server generates authoritative starter uid')
      assert.equal(afterStarter.save.flags.starter, starter)

      // Duplicate chooseStarter is rejected
      const dupStarterFrom = rookie.msgs.length
      rookie.sendSigned({ t: 'script.op', op: 'chooseStarter', speciesId: alternateStarter })
      await rookie.waitFor('error', (e) => e.code === 'authority_violation', dupStarterFrom)

      // Professor's prologue gifts (npc:professor, steps 0.else.7..9) succeed once and reject replay
      const professorGifts = [
        ['dex-device', 1, '0.else.7'],
        ['town-map', 1, '0.else.8'],
        ['prompt-ball', 5, '0.else.9'],
      ] as const
      for (const [itemId, qty, stepPath] of professorGifts) {
        const gFrom = rookie.msgs.length
        rookie.sendSigned({
          t: 'script.op',
          op: 'giveItem',
          itemId,
          qty,
          sourceId: 'npc:professor',
          npcId: 'professor',
          stepPath,
        })
        const gSync = await rookie.waitFor('state.sync', undefined, gFrom)
        assert.equal(gSync.save.bag[itemId], qty)

        const replayFrom = rookie.msgs.length
        rookie.sendSigned({
          t: 'script.op',
          op: 'giveItem',
          itemId,
          qty,
          sourceId: 'npc:professor',
          npcId: 'professor',
          stepPath,
        })
        await rookie.waitFor('error', (e) => e.code === 'authority_violation', replayFrom)
      }

      // Aide's phi-3 gift (npc:aide-types, step 0.else.4) and research tasks (0.else.5 see, 0.else.6 catch) succeed once and reject replay
      const phiSyncFrom = rookie.msgs.length
      rookie.sendSigned({
        t: 'script.op',
        op: 'giveCreature',
        speciesId: 'phi-3',
        level: 6,
        creature: forgedStarter,
        sourceId: 'npc:aide-types',
        npcId: 'aide-types',
        stepPath: '0.else.4',
      })
      const afterPhi = await rookie.waitFor('state.sync', undefined, phiSyncFrom)
      assert.equal(afterPhi.save.party.length, 2)
      assert.equal(afterPhi.save.party[1].speciesId, 'phi-3')
      assert.equal(afterPhi.save.party[1].level, 6)
      assert.notEqual(afterPhi.save.party[1].uid, forgedStarter.uid)

      const dupPhiFrom = rookie.msgs.length
      rookie.sendSigned({
        t: 'script.op',
        op: 'giveCreature',
        speciesId: 'phi-3',
        level: 6,
        sourceId: 'npc:aide-types',
        npcId: 'aide-types',
        stepPath: '0.else.4',
      })
      await rookie.waitFor('error', (e) => e.code === 'authority_violation', dupPhiFrom)

      const resSeeFrom = rookie.msgs.length
      rookie.sendSigned({
        t: 'script.op',
        op: 'research',
        speciesId: 'phi-3',
        task: 'see',
        amount: 1,
        sourceId: 'npc:aide-types',
        npcId: 'aide-types',
        stepPath: '0.else.5',
      })
      const afterSee = await rookie.waitFor('state.sync', undefined, resSeeFrom)
      assert.equal(afterSee.save.research?.['phi-3']?.see, 1)

      const dupSeeFrom = rookie.msgs.length
      rookie.sendSigned({
        t: 'script.op',
        op: 'research',
        speciesId: 'phi-3',
        task: 'see',
        amount: 1,
        sourceId: 'npc:aide-types',
        npcId: 'aide-types',
        stepPath: '0.else.5',
      })
      await rookie.waitFor('error', (e) => e.code === 'authority_violation', dupSeeFrom)

      const resCatchFrom = rookie.msgs.length
      rookie.sendSigned({
        t: 'script.op',
        op: 'research',
        speciesId: 'phi-3',
        task: 'catch',
        amount: 1,
        sourceId: 'npc:aide-types',
        npcId: 'aide-types',
        stepPath: '0.else.6',
      })
      const afterCatch = await rookie.waitFor('state.sync', undefined, resCatchFrom)
      assert.equal(afterCatch.save.research?.['phi-3']?.catch, 1)

      const dupCatchFrom = rookie.msgs.length
      rookie.sendSigned({
        t: 'script.op',
        op: 'research',
        speciesId: 'phi-3',
        task: 'catch',
        amount: 1,
        sourceId: 'npc:aide-types',
        npcId: 'aide-types',
        stepPath: '0.else.6',
      })
      await rookie.waitFor('error', (e) => e.code === 'authority_violation', dupCatchFrom)

      // Premature progression flags (ds:done without deepseek defeat) and source-free grants are rejected
      const badDoneFrom = rookie.msgs.length
      rookie.sendSigned({ t: 'script.op', op: 'setFlag', flag: 'ds:done', value: true })
      await rookie.waitFor('error', (e) => e.code === 'authority_violation', badDoneFrom)

      const forger = await loginSignedClient(srv, world, 'PrologueForger', {
        save: mgr.newGame({ name: 'PrologueForger', avatar: CONTENT.characters[0]?.id ?? '' }),
        map: 'origin-lab',
        x: 6,
        y: 6,
        facing: 'up',
        flags: { starter },
      })
      clients.push(forger)

      const noSourceGiftFrom = forger.msgs.length
      forger.sendSigned({ t: 'script.op', op: 'giveItem', itemId: 'dex-device', qty: 1 })
      await forger.waitFor('error', (e) => e.code === 'authority_violation', noSourceGiftFrom)

      const noSourcePhiFrom = forger.msgs.length
      forger.sendSigned({ t: 'script.op', op: 'giveCreature', speciesId: 'phi-3', level: 6 })
      await forger.waitFor('error', (e) => e.code === 'authority_violation', noSourcePhiFrom)

      const noSourceResFrom = forger.msgs.length
      forger.sendSigned({ t: 'script.op', op: 'research', speciesId: 'phi-3', task: 'see', amount: 1 })
      await forger.waitFor('error', (e) => e.code === 'authority_violation', noSourceResFrom)
    } finally {
      await Promise.all(clients.map((c) => c.close()))
      await srv.close()
    }
  })
})
