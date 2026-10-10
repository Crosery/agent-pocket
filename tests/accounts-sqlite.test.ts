// Behavioral tests for Issue #49 (ADR 0003):
// SQLite persistence (node:sqlite), scrypt auth, session cookies, CSRF origin policy, bounded rate limiting,
// 1:1 account/character/save binding, untrusted import isolation, two-account isolation, restart persistence,
// and transactional JSON -> SQLite migration idempotency + rollback restoration.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { WebSocket as NodeWebSocket } from 'ws'
import type { ClientMsg, PublicProfile, ServerMsg } from '../src/shared/protocol.ts'
import type { SaveData } from '../src/shared/types.ts'
import { CONTENT, t } from '../src/shared/content/index.ts'
import { createCreature } from '../src/shared/creature.ts'
import { Rng } from '../src/shared/rng.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { NET } from '../src/server/config.ts'
import { startServer } from '../src/server/index.ts'
import {
  createProfileStore,
  migrateJsonToSqlite,
  parseSessionCookie,
  rollbackSqliteToJson,
  validatePassword,
  validateUsername,
  type StoredProfile,
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
): Promise<{
  ws: NodeWebSocket
  msgs: ServerMsg[]
  closed: Promise<number>
  send(m: ClientMsg): void
  waitFor(type: ServerMsg['t']): Promise<ServerMsg>
}> {
  const ws = new NodeWebSocket(
    `ws://localhost:${port}${NET.protocol.wsPath}`,
    cookie ? { headers: { cookie } } : undefined,
  )
  const msgs: ServerMsg[] = []
  ws.on('message', (data: Buffer) => {
    msgs.push(JSON.parse(data.toString('utf8')) as ServerMsg)
  })
  const closed = once(ws, 'close').then(([code]) => (typeof code === 'number' ? code : 0))
  await once(ws, 'open')
  return {
    ws,
    msgs,
    closed,
    send(m: ClientMsg) {
      ws.send(JSON.stringify(m))
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
  const mgr = createSaveManager({ world: null })
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
  assert.equal(validateUsername( 'admin').ok, false, 'reserved name rejected')
  assert.equal(validateUsername('训练家_01').ok, true, 'Chinese + underscore + digits accepted')

  assert.equal(validatePassword('short').ok, false, 'password under minLen rejected')
  assert.equal(validatePassword('x'.repeat(NET.auth.password.maxLen + 1)).ok, false, 'password above maxLen rejected')
  assert.equal(validatePassword('validPass\u0000123').ok, false, 'control character rejected')
  assert.equal(validatePassword('Trainer_01', 'trainer_01').ok, false, 'password equal to username rejected')
  assert.equal(validatePassword('CorrectHorseBattery1', 'trainer_01').ok, true)
})

test('store: account uniqueness, wrong auth, rate limits, session expiry/logout, bind once & untrusted import isolation', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-acc-store-'))
  try {
    const store = createProfileStore({ dir })
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

    // After window refills, login succeeds
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

    // First bind with untrusted offline save: strips pvpWins/pvpLosses/trades/maxDistance, marks creatures legacy, overwrites playerId
    const spId = CONTENT.speciesList[0]!.id
    const mon = createCreature(spId, 20, { rng: new Rng(42), otName: 'Spoof' })
    const forgedOfflineSave = makeSampleSave('Alice_01', {
      playerId: '00000000-0000-0000-0000-000000000000',
      party: [mon],
      badges: ['badge-1', 'badge-2'],
      dexCaught: [spId],
      maxDistance: 88888,
      stats: { battlesWon: 50, caught: 10, steps: 900, pvpWins: 777, pvpLosses: 1, trades: 99, shiniesFound: 5 },
    })

    // Even if client claims imported: false, pre-existing party/badges/stats force imported=true & trusted=false
    const bind1 = store.bindSave(reg1.account.id, forgedOfflineSave, { imported: false, ip: '10.0.0.1', now: 3000 })
    assert.equal(bind1.ok, true)
    if (!bind1.ok) return
    assert.equal(bind1.record.imported, true)
    assert.equal(bind1.record.trusted, false)
    assert.equal(bind1.record.save.playerId, reg1.account.id, 'server overwrites client-supplied playerId')
    assert.equal(bind1.record.save.stats.pvpWins, 0, 'untrusted import pvpWins stripped')
    assert.equal(bind1.record.save.stats.pvpLosses, 0, 'untrusted import pvpLosses stripped')
    assert.equal(bind1.record.save.stats.trades, 0, 'untrusted import trades stripped')
    assert.equal(bind1.record.save.maxDistance, undefined, 'untrusted import maxDistance stripped')
    assert.equal(bind1.record.save.party[0]?.origin?.kind, 'legacy', 'imported creatures marked legacy')

    // Untrusted import does not grant badges/dexCaught on the authoritative leaderboard
    const lbEntry = store.leaderboard().find((e) => e.id === reg1.account.id)
    assert.ok(lbEntry)
    assert.equal(lbEntry.pvpWins, 0)
    assert.equal(lbEntry.badges, 0)
    assert.equal(lbEntry.dexCaught, 0)

    // Second bind attempt rejected (first-bind only)
    const bind2 = store.bindSave(reg1.account.id, makeSampleSave('Alice_01'), { imported: false, ip: '10.0.0.1', now: 3001 })
    assert.equal(bind2.ok, false)
    if (!bind2.ok) {
      assert.equal(bind2.status, 409)
      assert.equal(bind2.code, 'already_bound')
    }

    // Audit records captured
    const audits = store.listAudit(reg1.account.id)
    assert.ok(audits.some((a) => a.kind === 'account.bind_import'))
    assert.ok(audits.some((a) => a.kind === 'account.bind_rejected_duplicate'))

    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('http + ws + sqlite restart: status, register/login/logout, CSRF, unauthorized save access, two-account isolation, persistence', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-acc-http-'))
  const PORT = 8794
  try {
    let srv = await startServer({ port: PORT, dataDir: dir, distDir: pathJoin(dir, 'no-dist'), quiet: true, pvp: null, world: null })
    let aliceCookie = ''
    let bobCookie = ''
    let aliceId = ''
    let bobId = ''
    try {
      // 1. GET /api/status
      const st = await httpCall(PORT, 'GET', NET.http.statusPath)
      assert.equal(st.status, 200)
      assert.equal(st.headers['access-control-allow-origin'], '*')
      assert.equal(st.json.protocolVersion, CONTENT.config.net.protocolVersion)
      assert.equal(typeof st.json.version, 'string')
      assert.equal(st.json.online, 0)
      assert.equal(st.json.name, t('net.serverName'))

      // 2. Unauthorized GET /api/account and POST /api/account/bind rejected with 401
      const unauthGet = await httpCall(PORT, 'GET', NET.http.accountPath)
      assert.equal(unauthGet.status, 401)
      assert.equal(unauthGet.json.error, 'unauthorized')

      const unauthBind = await httpCall(PORT, 'POST', NET.http.bindPath, {
        body: { save: makeSampleSave('Hacker'), imported: false },
      })
      assert.equal(unauthBind.status, 401)
      assert.equal(unauthBind.json.error, 'unauthorized')

      // 3. Cross-origin CSRF rejected with 403
      const csrfAttempt = await httpCall(PORT, 'POST', NET.http.registerPath, {
        body: { username: 'CsrfUser', password: 'Password1234' },
        headers: { origin: 'https://evil.example.com' },
      })
      assert.equal(csrfAttempt.status, 403)
      assert.equal(csrfAttempt.json.error, 'forbidden_origin')

      // 4. Register Alice & Bob (directly logs in and sets HttpOnly cookie)
      const regAlice = await httpCall(PORT, 'POST', NET.http.registerPath, {
        body: { username: 'AliceTrainer', password: 'AlicePassword123' },
        headers: { origin: `http://localhost:${PORT}` },
      })
      assert.equal(regAlice.status, 200)
      assert.ok(regAlice.cookie)
      aliceCookie = regAlice.cookie
      const rawSetCookie = String(regAlice.headers['set-cookie'])
      assert.match(rawSetCookie, /HttpOnly/)
      assert.match(rawSetCookie, /SameSite=Lax/)
      assert.ok(isRecord(regAlice.json.account))
      aliceId = String(regAlice.json.account.id)
      assert.equal(regAlice.json.save, null)

      const regBob = await httpCall(PORT, 'POST', NET.http.registerPath, {
        body: { username: 'BobTrainer', password: 'BobPassword123' },
      })
      assert.equal(regBob.status, 200)
      assert.ok(regBob.cookie)
      bobCookie = regBob.cookie
      assert.ok(isRecord(regBob.json.account))
      bobId = String(regBob.json.account.id)
      assert.notEqual(aliceId, bobId)

      // 5. Bind Alice's fresh save and Bob's distinct save
      const aliceInitialSave = makeSampleSave('AliceTrainer', {
        playerId: 'spoofed-client-id-1',
        position: { map: 'map-alice', x: 11, y: 22, facing: 'right' },
      })
      const bindAlice = await httpCall(PORT, 'POST', NET.http.bindPath, {
        cookie: aliceCookie,
        body: { save: aliceInitialSave, imported: false },
      })
      assert.equal(bindAlice.status, 200)
      assert.equal(bindAlice.json.imported, false)
      assert.ok(isRecord(bindAlice.json.save))
      assert.equal(bindAlice.json.save.playerId, aliceId, 'bound save uses Alice server accountId')

      const bobInitialSave = makeSampleSave('BobTrainer', {
        playerId: aliceId, // Bob attempts to claim Alice's ID in his save payload
        position: { map: 'map-bob', x: 33, y: 44, facing: 'up' },
      })
      const bindBob = await httpCall(PORT, 'POST', NET.http.bindPath, {
        cookie: bobCookie,
        body: { save: bobInitialSave, imported: false },
      })
      assert.equal(bindBob.status, 200)
      assert.ok(isRecord(bindBob.json.save))
      assert.equal(bindBob.json.save.playerId, bobId, 'Bob cannot claim Alice ID')

      // 6. Two-account isolation: Alice's cookie reads only Alice's save; Bob's cookie reads only Bob's save
      const accAlice = await httpCall(PORT, 'GET', NET.http.accountPath, { cookie: aliceCookie })
      const accBob = await httpCall(PORT, 'GET', NET.http.accountPath, { cookie: bobCookie })
      assert.equal(accAlice.status, 200)
      assert.equal(accBob.status, 200)
      assert.ok(isRecord(accAlice.json.save) && isRecord(accBob.json.save))
      assert.equal(accAlice.json.save.name, 'AliceTrainer')
      assert.equal(accBob.json.save.name, 'BobTrainer')
      assert.equal(accAlice.json.save.playerId, aliceId)
      assert.equal(accBob.json.save.playerId, bobId)

      // 7. WebSocket with Alice's session cookie binds connection to aliceId (ignoring spoofed hello.playerId)
      const wsAlice = await openWsWithCookie(PORT, aliceCookie)
      wsAlice.send({
        t: 'hello',
        v: CONTENT.config.net.protocolVersion,
        playerId: crypto.randomUUID(),
        name: 'SpoofedName',
        avatar: 'invalid',
        map: 'wrong-map',
        x: 0,
        y: 0,
        facing: 'down',
        lead: null,
        profile: { id: 'x', name: 'x', avatar: 'x', badges: [], dexCaught: 0, party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0 },
      })
      const welcomeAlice = await wsAlice.waitFor('welcome')
      assert.equal(welcomeAlice.t, 'welcome')
      if (welcomeAlice.t === 'welcome') {
        assert.equal(welcomeAlice.selfId, aliceId)
      }
      wsAlice.ws.close()
      await wsAlice.closed

      // 8. WebSocket with forged/invalid session cookie is rejected with unauthorized
      const wsForged = await openWsWithCookie(PORT, `${NET.auth.cookieName}=forged_token_value_1234567890`)
      const errForged = await wsForged.waitFor('error')
      assert.equal(errForged.t, 'error')
      if (errForged.t === 'error') assert.equal(errForged.code, 'unauthorized')
      await wsForged.closed
    } finally {
      await srv.close()
    }

    // 9. Restart server on the same dataDir: SQLite ap.db persists accounts, sessions, and saves
    assert.ok(existsSync(pathJoin(dir, NET.store.sqliteFile)), 'ap.db created on disk')
    srv = await startServer({ port: PORT, dataDir: dir, distDir: pathJoin(dir, 'no-dist'), quiet: true, pvp: null, world: null })
    try {
      // Existing session cookie still works across restart
      const accAfterRestart = await httpCall(PORT, 'GET', NET.http.accountPath, { cookie: aliceCookie })
      assert.equal(accAfterRestart.status, 200)
      assert.ok(isRecord(accAfterRestart.json.account) && isRecord(accAfterRestart.json.save))
      assert.equal(accAfterRestart.json.account.id, aliceId)
      assert.equal(accAfterRestart.json.save.name, 'AliceTrainer')

      // Logout invalidates session; re-login issues a fresh working cookie and returns persisted save
      const logoutRes = await httpCall(PORT, 'POST', NET.http.logoutPath, { cookie: aliceCookie })
      assert.equal(logoutRes.status, 200)
      assert.equal((await httpCall(PORT, 'GET', NET.http.accountPath, { cookie: aliceCookie })).status, 401)

      const relogin = await httpCall(PORT, 'POST', NET.http.loginPath, {
        body: { username: 'AliceTrainer', password: 'AlicePassword123' },
      })
      assert.equal(relogin.status, 200)
      assert.ok(relogin.cookie && parseSessionCookie(relogin.cookie))
      assert.ok(isRecord(relogin.json.save))
      assert.equal(relogin.json.save.playerId, aliceId)
    } finally {
      await srv.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration CLI: profiles.json -> SQLite transactional import, original JSON retained, idempotency, and rollback restoration', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-migrate-test-'))
  try {
    const jsonPath = pathJoin(dir, NET.store.file)
    const p1: PublicProfile = {
      id: '11111111-2222-3333-4444-555555555555',
      name: 'LegacyAlpha',
      avatar: CONTENT.characters[0]?.id ?? 'red',
      badges: ['badge-code', 'badge-vision'],
      dexCaught: 18,
      party: [],
      pvpWins: 12,
      pvpLosses: 3,
      playTimeSec: 7200,
    }
    const p2: PublicProfile = {
      id: '66666666-7777-8888-9999-aaaaaaaaaaaa',
      name: 'LegacyBeta',
      avatar: CONTENT.characters[0]?.id ?? 'red',
      badges: ['badge-code'],
      dexCaught: 7,
      party: [],
      pvpWins: 4,
      pvpLosses: 5,
      playTimeSec: 1800,
    }
    const legacyPayload: { version: number; profiles: Record<string, StoredProfile> } = {
      version: NET.store.version,
      profiles: {
        [p1.id]: { profile: p1, pvpWins: 12, pvpLosses: 3, trades: 5, firstSeen: 1000, lastSeen: 5000, maxDistance: 420 },
        [p2.id]: { profile: p2, pvpWins: 4, pvpLosses: 5, trades: 1, firstSeen: 2000, lastSeen: 6000, maxDistance: 128 },
      },
    }
    const originalJsonBytes = JSON.stringify(legacyPayload, null, 2)
    await writeFile(jsonPath, originalJsonBytes, 'utf8')

    // 1. Run migration once
    const r1 = await migrateJsonToSqlite(dir)
    assert.equal(r1.migrated, true)
    assert.equal(r1.importedCount, 2)
    assert.ok(existsSync(r1.sqlitePath))
    assert.ok(r1.backupPath && existsSync(r1.backupPath), 'pre-migration SQLite backup created')

    // Original profiles.json is retained byte-for-byte untouched
    assert.equal(await readFile(jsonPath, 'utf8'), originalJsonBytes)

    // 2. Run migration a second time via CLI: idempotent (migrated: false, count stays 2)
    const r2 = await runMigrateCli(['--data-dir', dir])
    assert.ok('migrated' in r2)
    if ('migrated' in r2) {
      assert.equal(r2.migrated, false)
      assert.equal(r2.importedCount, 2)
    }

    // 3. Verify store reads the migrated data from SQLite even if profiles.json is removed temporarily
    await unlink(jsonPath)
    const store = createProfileStore({ dir })
    await store.load()
    assert.equal(store.size(), 2)
    assert.equal(store.get(p1.id)?.pvpWins, 12)
    assert.equal(store.get(p1.id)?.maxDistance, 420)
    assert.equal(store.get(p2.id)?.trades, 1)
    await store.close()

    // 4. Rollback restores profiles.json with exact deepEqual contents
    const rb = await rollbackSqliteToJson(dir)
    assert.equal(rb.ok, true)
    assert.equal(rb.restoredProfiles, 2)
    assert.ok(existsSync(jsonPath))
    const restoredData = JSON.parse(await readFile(jsonPath, 'utf8')) as typeof legacyPayload
    assert.deepEqual(restoredData, legacyPayload)
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
