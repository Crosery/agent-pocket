// Behavioral tests for Issue #49 (ADR 0003):
// SQLite persistence (node:sqlite), scrypt auth, session cookies, CSRF origin policy, bounded rate limiting,
// 1:1 account/character/save binding, untrusted import isolation, two-account isolation, restart persistence,
// and transactional JSON -> SQLite migration idempotency + rollback restoration.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { WebSocket as NodeWebSocket } from 'ws'
import type { ClientMsg, PublicProfile, ServerMsg } from '../src/shared/protocol.ts'
import type { SaveData } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import gameJson from '../content/game.json' with { type: 'json' }
import { buildWorld, worldAnchors } from '../src/shared/world/index.ts'
import { createCreature } from '../src/shared/creature.ts'
import { Rng } from '../src/shared/rng.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { NET } from '../src/server/config.ts'
import { signEnvelopeNode } from '../src/server/net-envelope.ts'
import { startServer } from '../src/server/index.ts'
import {
  createProfileStore,
  migrateJsonToSqlite,
  parseSessionCookie,
  rollbackSqliteToJson,
  validatePassword,
  validateUsername,
} from '../src/server/store.ts'
import { isRecord } from '../src/server/util.ts'
import { runMigrateCli } from '../scripts/migrate-sqlite.ts'

interface HttpResp {
  status: number
  headers: Record<string, string | undefined>
  body: Buffer
  json: Record<string, unknown>
  cookie: string | null
}

async function httpCall(
  port: number,
  method: 'GET' | 'POST' | 'OPTIONS' | 'DELETE',
  path: string,
  opts: { body?: unknown; cookie?: string | null; headers?: Record<string, string> } = {},
): Promise<HttpResp> {
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  const headers: Record<string, string> = {
    ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...opts.headers,
  }
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
  })
  const ab = await res.arrayBuffer()
  const body = Buffer.from(ab)
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    if (isRecord(parsed)) json = parsed
  } catch { /* non-json response */ }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const firstCookie = setCookies[0] ?? res.headers.get('set-cookie') ?? undefined
  const cookiePair = typeof firstCookie === 'string' ? firstCookie.split(';')[0]?.trim() ?? null : null
  const headerMap: Record<string, string | undefined> = {
    'access-control-allow-origin': res.headers.get('access-control-allow-origin') ?? undefined,
    'set-cookie': firstCookie,
  }
  return {
    status: res.status,
    headers: headerMap,
    body,
    json,
    cookie: cookiePair,
  }
}

async function openWsWithCookie(
  port: number,
  cookie?: string | null,
  extraHeaders?: Record<string, string>,
): Promise<{
  ws: NodeWebSocket
  msgs: ServerMsg[]
  closed: Promise<number>
  send(m: ClientMsg): void
  waitFor(type: ServerMsg['t']): Promise<ServerMsg>
}> {
  const ws = new NodeWebSocket(
    `ws://localhost:${port}${NET.protocol.wsPath}`,
    {
      headers: {
        ...(cookie ? { cookie } : {}),
        ...extraHeaders,
      },
    },
  )
  const msgs: ServerMsg[] = []
  let sessionKey = ''
  let authSeq = 0
  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString('utf8')) as ServerMsg
    if (msg.t === 'welcome') sessionKey = msg.sessionKey ?? ''
    msgs.push(msg)
  })
  const closed = once(ws, 'close').then(([code]) => (typeof code === 'number' ? code : 0))
  await once(ws, 'open')
  return {
    ws,
    msgs,
    closed,
    send(m: ClientMsg) {
      ws.send(JSON.stringify(m.t === 'hello' || m.t === 'ping' ? m : signEnvelopeNode(sessionKey, m, ++authSeq)))
    },
    async waitFor(type: ServerMsg['t']): Promise<ServerMsg> {
      for (;;) {
        const found = msgs.find((m) => m.t === type)
        if (found) return found
        await once(ws, 'message')
      }
    },
  }
}

function makeSampleSave(name: string, overrides: Partial<SaveData> = {}): SaveData {
  const mgr = createSaveManager({ world: null, storage: null })
  const base = mgr.newGame({ name, avatar: CONTENT.characters[0]?.id ?? 'red' })
  return {
    ...base,
    position: { map: 'test-map', x: 5, y: 6, facing: 'down' },
    respawn: { map: 'test-map', x: 5, y: 6, facing: 'down' },
    ...overrides,
  }
}

test('username and password validation follows content rules and moderation', () => {
  assert.equal(validateUsername('a').ok, false, 'too short')
  assert.equal(validateUsername('a'.repeat(NET.auth.username.maxLen + 1)).ok, false, 'too long')
  assert.equal(validateUsername('bad<script>').ok, false, 'html characters rejected')
  assert.equal(validateUsername('has space').ok, false, 'spaces rejected')
  assert.equal(validateUsername('admin').ok, false, 'reserved name rejected')
  assert.equal(validateUsername('_admin_').ok, false, 'separator-wrapped reserved name rejected')
  assert.equal(validateUsername('a_d_m_i_n').ok, false, 'ignored-separator reserved name rejected')
  assert.equal(validateUsername('训练家_01').ok, true, 'Chinese + underscore + digits accepted')

  assert.equal(validatePassword('short').ok, false, 'password under minLen rejected')
  assert.equal(validatePassword('x'.repeat(NET.auth.password.maxLen + 1)).ok, false, 'password above maxLen rejected')
  assert.equal(validatePassword('validPass\u0000123').ok, false, 'control character rejected')
  assert.equal(validatePassword('Trainer_01', 'trainer_01').ok, false, 'password equal to username rejected')
  assert.equal(validatePassword('CorrectHorseBattery1', 'trainer_01').ok, true)

  // parseSessionCookie duplicate handling
  assert.equal(parseSessionCookie('ap_session=; ap_session=valid_token_1234567890123456'), 'valid_token_1234567890123456')
})

test('store: canonical newGame for imported:false vs untrusted quarantine for imported:true, rate refill with synthetic time', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-acc-store-'))
  try {
    const world = buildWorld()
    const store = createProfileStore({ dir, world })
    await store.load()

    const reg1 = await store.registerAccount('Alice_01', 'StrongPass#123', { ip: '10.0.0.1', now: 1000 })
    assert.equal(reg1.ok, true)
    if (!reg1.ok) return
    assert.equal(reg1.account.username, 'Alice_01')
    assert.equal(reg1.save, null)
    assert.ok(reg1.session.token.length >= 32)
    assert.ok(reg1.session.sessionSecret.length === 64)

    // Case-insensitive duplicate username rejected
    const dup = await store.registerAccount('alice_01', 'AnotherPass#123', { ip: '10.0.0.2', now: 1001 })
    assert.equal(dup.ok, false)
    if (!dup.ok) {
      assert.equal(dup.status, 409)
      assert.equal(dup.code, 'username_taken')
    }

    // Wrong password vs unknown username return identical non-revealing error
    const wrongPass = await store.loginAccount('Alice_01', 'WrongPassword99', { ip: '10.0.0.3', now: 1002 })
    const unknownUser = await store.loginAccount('NoSuchUser_99', 'WrongPassword99', { ip: '10.0.0.3', now: 1003 })
    assert.equal(wrongPass.ok, false)
    assert.equal(unknownUser.ok, false)
    if (!wrongPass.ok && !unknownUser.ok) {
      assert.equal(wrongPass.status, 401)
      assert.equal(unknownUser.status, 401)
      assert.equal(wrongPass.code, 'invalid_credentials')
      assert.equal(unknownUser.code, 'invalid_credentials')
      assert.equal(wrongPass.message, unknownUser.message)
    }

    // Account login rate limit triggers after configured attempts within window
    for (let i = 0; i < NET.auth.rates.loginAccount.count; i++) {
      await store.loginAccount('Alice_01', 'BadPass1234', { ip: `10.0.1.${i}`, now: 2000 })
    }
    const rateLimited = await store.loginAccount('Alice_01', 'StrongPass#123', { ip: '10.0.1.99', now: 2000 })
    assert.equal(rateLimited.ok, false)
    if (!rateLimited.ok) {
      assert.equal(rateLimited.status, 429)
      assert.equal(rateLimited.code, 'rate_limited')
    }

    // After window refills using synthetic time, login succeeds (Review 3 test)
    const afterRefill = 2000 + (NET.auth.rates.loginAccount.perSeconds + 1) * 1000
    const loginOk = await store.loginAccount('Alice_01', 'StrongPass#123', { ip: '10.0.1.99', now: afterRefill })
    assert.equal(loginOk.ok, true)
    if (!loginOk.ok) return

    // Session lookup works before expiry, fails after expiry
    const cookieHeader = `${NET.auth.cookieName}=${loginOk.session.token}`
    const activeSess = store.getAccountBySession(cookieHeader, afterRefill + 1000)
    assert.equal(activeSess?.accountId, reg1.account.id)
    const expiredSess = store.getAccountBySession(cookieHeader, loginOk.session.expiresAt + 1)
    assert.equal(expiredSess, null)

    // Logout revokes active session immediately
    assert.equal(store.getAccountBySession(reg1.session.token, 1500)?.accountId, reg1.account.id)
    assert.equal(store.logoutSession(reg1.session.token, { ip: '10.0.0.1', now: 1600 }), true)
    assert.equal(store.getAccountBySession(reg1.session.token, 1601), null)

    // First bind with imported: false and forged client items/money/quests (Review 1):
    // Server ignores client gameplay fields and constructs canonical fresh save!
    const clientForgedNewSave = makeSampleSave('Alice_01', {
      money: 999999,
      bag: { 'master-ball': 99, 'potion': 50 },
      badges: ['badge-code', 'badge-vision'],
      party: [createCreature(CONTENT.speciesList[0]!.id, 50, { rng: new Rng(1) })],
      flags: { 'cheated': true },
      quests: { 'main': { stage: 9, done: true } },
    })
    const bindNew = store.bindSave(reg1.account.id, clientForgedNewSave, { imported: false, ip: '10.0.0.1', now: 3000 })
    assert.equal(bindNew.ok, true)
    if (!bindNew.ok) return
    assert.equal(bindNew.record.imported, false)
    assert.equal(bindNew.record.trusted, true)
    assert.equal(bindNew.record.save.money, CONTENT.config.economy.startMoney, 'money is canonical startMoney')
    assert.deepEqual(bindNew.record.save.bag, CONTENT.config.economy.startItems, 'bag is canonical startItems')
    assert.equal(bindNew.record.save.party.length, 0, 'party is empty for fresh character')
    assert.equal(bindNew.record.save.badges.length, 0, 'badges is empty for fresh character')
    assert.deepEqual(bindNew.record.save.position, { ...worldAnchors(world)[gameJson.newGame.startAnchor], facing: gameJson.newGame.facing })
    assert.deepEqual(bindNew.record.save.respawn, bindNew.record.save.position)

    // Second bind rejected
    const bindDup = store.bindSave(reg1.account.id, makeSampleSave('Alice_01'), { imported: false, ip: '10.0.0.1', now: 3001 })
    assert.equal(bindDup.ok, false)
    if (!bindDup.ok) assert.equal(bindDup.code, 'already_bound')

    // Register second account to test imported: true quarantine
    const reg2 = await store.registerAccount('Bob_02', 'StrongPass#123', { ip: '10.0.0.2', now: 4000 })
    assert.equal(reg2.ok, true)
    if (!reg2.ok) return

    const spId = CONTENT.speciesList[0]!.id
    const bossDef = CONTENT.bossList[0]
    const normalMon = createCreature(spId, 80, { rng: new Rng(42), otName: 'Spoof' })
    const bossMon = createCreature(bossDef.species, 50, { rng: new Rng(43) })
    bossMon.origin = { kind: 'boss', boss: bossDef.id }

    const offlineImportSave = makeSampleSave('Bob_02', {
      money: 9999999,
      bag: { 'cache-potion': 50, 'hover-board': 1, 'master-ball': 10 },
      party: [normalMon, bossMon],
      badges: ['badge-code'],
      stats: { battlesWon: 10, caught: 5, steps: 100, pvpWins: 50, pvpLosses: 2, trades: 10, shiniesFound: 1 },
      maxDistance: 9999,
    })
    const originalImport = structuredClone(offlineImportSave)
    const bindImport = store.bindSave(reg2.account.id, offlineImportSave, { imported: true, ip: '10.0.0.2', now: 4001 })
    assert.equal(bindImport.ok, true)
    if (!bindImport.ok) return
    assert.equal(bindImport.record.imported, true)
    assert.equal(bindImport.record.trusted, false)
    assert.equal(bindImport.record.save.money, offlineImportSave.money, 'validated offline money retained')
    assert.equal(bindImport.record.save.flags['auth:untrustedImport'], true, 'untrusted quarantine flag set')
    assert.equal(bindImport.record.save.bag['hover-board'], 1, 'owned key item retained')
    assert.equal(bindImport.record.save.bag['cache-potion'], 50, 'validated inventory retained')
    assert.equal(bindImport.record.save.party[0]?.level, normalMon.level)
    assert.equal(bindImport.record.save.party[1]?.level, bossMon.level)
    assert.equal(bindImport.record.save.stats.battlesWon, offlineImportSave.stats.battlesWon)
    assert.equal(bindImport.record.save.stats.pvpLosses, 0)
    assert.equal(bindImport.record.save.stats.trades, 0)
    assert.deepEqual(offlineImportSave, originalImport, 'binding never mutates the local source slot')
    assert.equal(bindImport.record.save.stats.pvpWins, 0, 'pvpWins stripped')
    assert.equal(bindImport.record.save.maxDistance, undefined, 'maxDistance stripped')
    assert.equal(bindImport.record.save.party[0]?.origin?.kind, 'legacy')
    assert.equal(bindImport.record.save.party[1]?.origin?.kind, 'legacy')
    assert.equal(bindImport.record.save.party[1]?.origin?.boss, bossDef.id, 'boss card retains origin.boss')

    assert.equal(store.leaderboard().some((e) => e.id === reg2.account.id), false, 'imported accounts are excluded entirely, not ranked with zero stats')
    store.putSave(reg2.account.id, bindImport.record.save)
    const persistedImport = store.getAccountSave(reg2.account.id)!
    assert.equal(persistedImport.imported, true)
    assert.equal(persistedImport.trusted, false)
    assert.equal(store.leaderboard().some((e) => e.id === reg2.account.id), false, 'ordinary save writes cannot remove isolation')

    // Ledger methods work
    store.recordLedger({ accountId: reg1.account.id, kind: 'money', subject: 'starter', delta: 3000, balance: 3000, ref: 'init' })
    const ledger = store.listLedger(reg1.account.id)
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0]?.delta, 3000)

    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('http + ws + CSRF + profile spoof protection + guest eviction isolation', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-acc-http-'))
  const PORT = 8794
  try {
    let srv = await startServer({ port: PORT, dataDir: dir, distDir: pathJoin(dir, 'no-dist'), quiet: true, pvp: null, world: null })
    let aliceCookie = ''
    let aliceId = ''
    try {
      // 1. Status endpoint
      const st = await httpCall(PORT, 'GET', NET.http.statusPath)
      assert.equal(st.status, 200)
      assert.equal(st.headers['access-control-allow-origin'], '*')

      // 2. CSRF checks: cross-site and same-site without same origin rejected
      const csrfCross = await httpCall(PORT, 'POST', NET.http.registerPath, {
        body: { username: 'CsrfCross', password: 'Password1234' },
        headers: { 'sec-fetch-site': 'cross-site' },
      })
      assert.equal(csrfCross.status, 403)
      assert.equal(csrfCross.json.error, 'forbidden_origin')

      const csrfSameSite = await httpCall(PORT, 'POST', NET.http.registerPath, {
        body: { username: 'CsrfSameSite', password: 'Password1234' },
        headers: { 'sec-fetch-site': 'same-site' },
      })
      assert.equal(csrfSameSite.status, 403)

      // 3. Register Alice
      const reg = await httpCall(PORT, 'POST', NET.http.registerPath, {
        body: { username: 'AliceOnline', password: 'AlicePassword123' },
        headers: { 'sec-fetch-site': 'same-origin', origin: `http://localhost:${PORT}` },
      })
      assert.equal(reg.status, 200)
      assert.ok(reg.cookie)
      aliceCookie = reg.cookie
      assert.ok(isRecord(reg.json.account))
      aliceId = String(reg.json.account.id)

      // 4. Bind Alice with canonical fresh save
      const bind = await httpCall(PORT, 'POST', NET.http.bindPath, {
        cookie: aliceCookie,
        body: { save: makeSampleSave('AliceOnline'), imported: false },
        headers: { origin: `http://localhost:${PORT}` },
      })
      assert.equal(bind.status, 200)
      assert.equal(bind.json.imported, false)

      // 5. Connect WebSocket with Alice cookie
      const wsAlice = await openWsWithCookie(PORT, aliceCookie, { origin: `http://localhost:${PORT}` })
      wsAlice.send({
        t: 'hello',
        v: CONTENT.config.net.protocolVersion,
        playerId: crypto.randomUUID(),
        name: 'SpoofedAlice',
        avatar: 'invalid',
        map: 'test-map',
        x: 5,
        y: 6,
        facing: 'down',
        lead: null,
        profile: { id: 'spoof', name: 'spoof', avatar: 'x', badges: ['badge-code', 'badge-vision'], dexCaught: 50, party: [], pvpWins: 100, pvpLosses: 0, playTimeSec: 0 },
      })
      const welcome = await wsAlice.waitFor('welcome')
      assert.equal(welcome.t, 'welcome')
      if (welcome.t === 'welcome') assert.equal(welcome.selfId, aliceId)
      const anonymous = await openWsWithCookie(PORT)
      const denial = await anonymous.waitFor('error')
      assert.equal(denial.t === 'error' && denial.code, 'unauthorized')
      assert.equal(await anonymous.closed, NET.protocol.closeCodes.shutdown)
      assert.equal(srv.hub.onlineCount(), 1, 'unauthenticated sockets cannot replace the active account')

      // 6. Client attempts to send WebSocket profile message with forged badges/dexCaught/party:
      // Server must NOT accept forged stats on leaderboard!
      wsAlice.send({
        t: 'profile',
        profile: {
          id: aliceId,
          name: 'AliceOnline',
          avatar: CONTENT.characters[0]!.id,
          badges: ['badge-1', 'badge-2', 'badge-3'],
          dexCaught: 99,
          party: [],
          pvpWins: 500,
          pvpLosses: 0,
          playTimeSec: 1000,
        },
      })
      wsAlice.send({ t: 'ping', at: Date.now() })
      await wsAlice.waitFor('pong')
      assert.equal(wsAlice.msgs.some((m) => m.t === 'error' && m.code === 'bad_signature'), false, 'profile reached the authoritative consumer with a valid signature')

      // Check leaderboard: Alice's badges and dexCaught remain authoritative (0 for fresh save)
      const lbRes = await httpCall(PORT, 'GET', NET.http.leaderboardPath)
      const entries = Array.isArray(lbRes.json.entries) ? (lbRes.json.entries as Array<{ id: string; badges: number; dexCaught: number; pvpWins: number }>) : []
      const aliceEntry = entries.find((e) => e.id === aliceId)
      assert.ok(aliceEntry)
      assert.equal(aliceEntry.badges, 0, 'badges cannot be spoofed via WS profile')
      assert.equal(aliceEntry.dexCaught, 0, 'dexCaught cannot be spoofed via WS profile')
      assert.equal(aliceEntry.pvpWins, 0, 'pvpWins cannot be spoofed via WS profile')

      // 7. Active WebSocket dropped on logout (Review 6)
      const logout = await httpCall(PORT, 'POST', NET.http.logoutPath, {
        cookie: aliceCookie,
        headers: { origin: `http://localhost:${PORT}` },
      })
      assert.equal(logout.status, 200)
      const wsCloseCode = await wsAlice.closed
      assert.ok(wsCloseCode > 0, 'WebSocket closed on logout')
    } finally {
      await srv.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration CLI: rollback stat merge and explicit missing backup error', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-migrate-merge-'))
  try {
    const jsonPath = pathJoin(dir, NET.store.file)
    const p1: PublicProfile = {
      id: '11111111-2222-3333-4444-555555555555',
      name: 'Alpha',
      avatar: CONTENT.characters[0]?.id ?? 'red',
      badges: ['badge-code'],
      dexCaught: 5,
      party: [],
      pvpWins: 2,
      pvpLosses: 1,
      playTimeSec: 1000,
    }
    const legacyPayload = {
      version: NET.store.version,
      profiles: {
        [p1.id]: { profile: p1, pvpWins: 2, pvpLosses: 1, trades: 1, firstSeen: 1000, lastSeen: 2000, maxDistance: 100 },
      },
    }
    await writeFile(jsonPath, JSON.stringify(legacyPayload), 'utf8')

    // Migrate once
    const m = await migrateJsonToSqlite(dir)
    assert.equal(m.migrated, true)

    // Simulate online gameplay updating PvP wins in SQLite
    const store = createProfileStore({ dir })
    await store.load()
    store.recordPvp(p1.id, null) // pvpWins now 3
    store.recordDistance(p1.id, 500)
    await store.close()

    // Rollback merges post-migration stats back into JSON
    const rb = await rollbackSqliteToJson(dir)
    assert.equal(rb.ok, true)
    const rolledBack = JSON.parse(await readFile(jsonPath, 'utf8')) as typeof legacyPayload
    assert.equal(rolledBack.profiles[p1.id]?.pvpWins, 3, 'post-migration PvP wins merged in rollback')
    assert.equal(rolledBack.profiles[p1.id]?.maxDistance, 500, 'post-migration distance merged in rollback')

    // Explicit non-existent backup returns error
    const badRb = await rollbackSqliteToJson(dir, { backupFile: pathJoin(dir, 'non-existent-backup.db') })
    assert.equal(badRb.ok, false)
    assert.equal(badRb.error, 'backup_not_found')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration CLI rejects missing paths and unknown options before touching a data directory', async () => {
  for (const args of [
    ['--data-dir'], ['--data-dir', '--rollback'], ['--backup'],
    ['--date-dir', 'missing'], ['--restore-db'], ['--backup', 'backup.db'],
  ]) {
    await assert.rejects(runMigrateCli(args), /requires|require|unknown migration option/)
  }
})
