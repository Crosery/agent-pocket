// Shared test fixtures for authenticated HTTP account registration/login/bind,
// session cookie forwarding in WebSocket handshakes, and HMAC-SHA256 signed ordered frames.
import assert from 'node:assert/strict'
import { request } from 'node:http'
import type { ClientMsg, PublicProfile, ServerMsg } from '../src/shared/protocol.ts'
import type { Creature, Dir, SaveData } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { NET } from '../src/server/config.ts'
import type { RunningServer } from '../src/server/index.ts'
import { signEnvelopeNode } from '../src/server/net-envelope.ts'
import { isRecord } from '../src/server/util.ts'

export type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>

export interface HttpResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
  json: Record<string, unknown>
  cookie: string | null
  setCookieRaw: string | null
}

export function httpRequest(
  port: number,
  path: string,
  opts: {
    method?: string
    headers?: Record<string, string>
    cookie?: string | null
    body?: unknown
    host?: string
  } = {},
): Promise<HttpResponse> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')
  const host = opts.host ?? 'localhost'
  const payload = opts.body !== undefined
    ? (typeof opts.body === 'string' || Buffer.isBuffer(opts.body) ? opts.body : JSON.stringify(opts.body))
    : undefined
  const headers: Record<string, string> = {
    ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...(method === 'POST' ? { origin: `http://${host}:${port}`, 'sec-fetch-site': 'same-origin' } : {}),
    ...opts.headers,
  }
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (d: Buffer) => chunks.push(d))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        let json: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(body.toString('utf8'))
          if (isRecord(parsed)) json = parsed
        } catch {
          // non-JSON response
        }
        const rawSetCookie = res.headers['set-cookie']
        const firstSetCookie = Array.isArray(rawSetCookie) ? rawSetCookie[0] ?? null : (rawSetCookie ?? null)
        const cookie = firstSetCookie ? firstSetCookie.split(';')[0]?.trim() ?? null : null
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          json,
          cookie,
          setCookieRaw: firstSetCookie,
        })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

export interface AccountSeedOptions {
  username?: string
  password?: string
  name?: string
  avatar?: string
  map?: string
  x?: number
  y?: number
  facing?: Dir
  badges?: string[]
  dexCaught?: string[] | number
  party?: Creature[]
  boxes?: Creature[][]
  bag?: Record<string, number>
  money?: number
  playTimeSec?: number
  imported?: boolean
  trusted?: boolean
  /** Set false to skip /api/account/bind (for testing unbound-account rejection). */
  bind?: boolean
}

export interface RegisteredTestAccount {
  accountId: string
  username: string
  password: string
  name: string
  cookie: string
  save: SaveData | null
}

let accountCounter = 0

function makeValidUsername(preferred?: string): string {
  const seq = ++accountCounter
  const cleaned = (preferred ?? 'Trainer').normalize('NFKC').replace(/[^\p{L}\p{N}_-]/gu, '')
  const stem = [...(cleaned || 'Trainer')].slice(0, 9).join('')
  const candidate = `${stem}_${seq}`
  return candidate.length >= NET.auth.username.minLen ? candidate : `User_${seq}`
}

export function createBaseSave(name: string, avatar?: string): SaveData {
  const mgr = createSaveManager({ world: null, storage: null })
  const playable = CONTENT.characters.find((c) => c.playable)?.id ?? CONTENT.characters[0]?.id ?? ''
  return mgr.newGame({
    name,
    avatar: avatar && CONTENT.characterById[avatar]?.playable ? avatar : playable,
  })
}

/**
 * Registers an account via HTTP `/api/auth/register` (falling back to store registration with a distinct test IP
 * only when a multi-account suite exceeds the 5/60s per-IP register rate limit on one server), binds a canonical
 * character save via HTTP `/api/account/bind`, and seeds any requested gameplay state via `srv.authority.setSave`.
 */
export async function registerTestAccount(
  srv: Pick<RunningServer, 'port' | 'store' | 'authority'>,
  opts: AccountSeedOptions = {},
): Promise<RegisteredTestAccount> {
  const seq = accountCounter + 1
  const username = opts.username ?? makeValidUsername(opts.name)
  const password = opts.password ?? 'StrongPass#123'
  const displayName = opts.name ?? username

  let accountId = ''
  let cookie = ''

  const regRes = await httpRequest(srv.port, NET.http.registerPath, {
    method: 'POST',
    body: { username, password },
  })

  if (regRes.status === 200 && regRes.cookie && isRecord(regRes.json.account) && typeof regRes.json.account.id === 'string') {
    assert.ok(regRes.setCookieRaw?.includes('HttpOnly'), 'session Set-Cookie must be HttpOnly')
    accountId = regRes.json.account.id
    cookie = regRes.cookie
  } else if (regRes.status === 429) {
    const syntheticIp = `10.240.${(seq >> 8) & 255}.${seq & 255}`
    const direct = await srv.store.registerAccount(username, password, { ip: syntheticIp })
    if (!direct.ok) throw new Error(`registerAccount failed for ${username}: ${direct.message}`)
    accountId = direct.account.id
    cookie = `${NET.auth.cookieName}=${direct.session.token}`
  } else {
    throw new Error(`unexpected register status ${regRes.status}: ${JSON.stringify(regRes.json)}`)
  }

  if (opts.bind === false) {
    return { accountId, username, password, name: displayName, cookie, save: null }
  }

  const baseSave = createBaseSave(displayName, opts.avatar)
  const bindRes = await httpRequest(srv.port, NET.http.bindPath, {
    method: 'POST',
    cookie,
    body: {
      save: {
        ...baseSave,
        ...(opts.avatar !== undefined ? { avatar: opts.avatar } : {}),
      },
      imported: opts.imported === true,
    },
  })
  assert.equal(bindRes.status, 200, `HTTP /api/account/bind failed (${bindRes.status}): ${JSON.stringify(bindRes.json)}`)

  let finalSave = srv.store.getSave(accountId) ?? baseSave
  const needsSeed =
    opts.map !== undefined ||
    opts.x !== undefined ||
    opts.y !== undefined ||
    opts.facing !== undefined ||
    opts.badges !== undefined ||
    opts.dexCaught !== undefined ||
    opts.party !== undefined ||
    opts.boxes !== undefined ||
    opts.bag !== undefined ||
    opts.money !== undefined ||
    opts.playTimeSec !== undefined ||
    opts.imported !== undefined ||
    opts.trusted !== undefined

  if (needsSeed) {
    const seeded = structuredClone(finalSave)
    seeded.playerId = accountId
    seeded.name = displayName
    if (opts.avatar && CONTENT.characterById[opts.avatar]?.playable) {
      seeded.avatar = opts.avatar
    }
    if (opts.map !== undefined || opts.x !== undefined || opts.y !== undefined || opts.facing !== undefined) {
      const map = opts.map ?? seeded.position.map
      const x = opts.x !== undefined ? Math.floor(opts.x) : seeded.position.x
      const y = opts.y !== undefined ? Math.floor(opts.y) : seeded.position.y
      const facing = opts.facing ?? seeded.position.facing
      seeded.position = { map, x, y, facing }
      seeded.respawn = { map, x, y, facing }
    }
    if (opts.badges !== undefined) {
      seeded.badges = [...opts.badges]
    }
    if (opts.dexCaught !== undefined) {
      const caughtIds = typeof opts.dexCaught === 'number'
        ? CONTENT.speciesList.slice(0, Math.max(0, opts.dexCaught)).map((s) => s.id)
        : [...opts.dexCaught]
      seeded.dexCaught = caughtIds
      seeded.dexSeen = [...new Set([...seeded.dexSeen, ...caughtIds])]
    }
    if (opts.party !== undefined) {
      seeded.party = structuredClone(opts.party)
      for (const cr of seeded.party) {
        if (CONTENT.species[cr.speciesId] && !seeded.dexSeen.includes(cr.speciesId)) seeded.dexSeen.push(cr.speciesId)
      }
    }
    if (opts.boxes !== undefined) {
      seeded.boxes = structuredClone(opts.boxes)
    }
    if (opts.bag !== undefined) {
      seeded.bag = { ...opts.bag }
    }
    if (opts.money !== undefined) {
      seeded.money = opts.money
    }
    if (opts.playTimeSec !== undefined) {
      seeded.playTimeSec = opts.playTimeSec
    }
    const isImported = opts.imported === true
    const isTrusted = opts.trusted ?? !isImported
    const rec = srv.authority.setSave(accountId, seeded, {
      imported: isImported,
      trusted: isTrusted,
      ref: 'test:seed',
    })
    finalSave = rec.save
  }

  return {
    accountId,
    username,
    password,
    name: finalSave.name,
    cookie,
    save: finalSave,
  }
}

export interface TestWsClient {
  ws: WebSocket
  msgs: ServerMsg[]
  selfId: string
  accountId: string
  username: string
  name: string
  cookie: string
  sessionKey: string
  authSeq: number
  closed: Promise<number>
  /** Sends a signed frame once welcomed (or raw hello/ping). */
  send(m: ClientMsg | Record<string, unknown>, customAuthSeq?: number): number
  /** Sends an unsigned/raw frame or raw string (for protocol/signature error tests). */
  sendRaw(m: ClientMsg | Record<string, unknown> | string): void
  mark(): number
  waitFor<T extends ServerMsg['t']>(
    type: T,
    pred?: (m: Msg<T>) => boolean,
    opts?: { from?: number; ms?: number },
  ): Promise<Msg<T>>
  all<T extends ServerMsg['t']>(type: T, from?: number): Msg<T>[]
  close(): Promise<number>
}

export function openRawWsClient(
  port: number,
  opts: {
    cookie?: string | null
    origin?: string | null
    headers?: Record<string, string>
    accountId?: string
    username?: string
    name?: string
    allowHandshakeError?: boolean
  } = {},
): Promise<TestWsClient> {
  const headers: Record<string, string> = {
    ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    ...(opts.origin !== null ? { Origin: opts.origin ?? `http://localhost:${port}` } : {}),
    ...opts.headers,
  }
  const hasHeaders = Object.keys(headers).length > 0
  const ws = new WebSocket(
    `ws://localhost:${port}${NET.protocol.wsPath}`,
    hasHeaders ? ({ headers } as unknown as string[]) : undefined,
  )
  const msgs: ServerMsg[] = []
  const waiters = new Set<() => void>()
  const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)))
  ws.addEventListener('message', (e) => {
    msgs.push(JSON.parse(String(e.data)) as ServerMsg)
    for (const w of [...waiters]) w()
  })
  const c: TestWsClient = {
    ws,
    msgs,
    selfId: '',
    accountId: opts.accountId ?? '',
    username: opts.username ?? '',
    name: opts.name ?? '',
    cookie: opts.cookie ?? '',
    sessionKey: '',
    authSeq: 0,
    closed,
    send(m, customAuthSeq) {
      const rec = m as Record<string, unknown>
      if (!c.sessionKey || rec.t === 'hello' || rec.t === 'ping') {
        ws.send(JSON.stringify(m))
        return 0
      }
      const seq = customAuthSeq ?? ++c.authSeq
      if (seq > c.authSeq) c.authSeq = seq
      const signed = signEnvelopeNode(c.sessionKey, rec, seq)
      ws.send(JSON.stringify(signed))
      return seq
    },
    sendRaw(m) {
      ws.send(typeof m === 'string' ? m : JSON.stringify(m))
    },
    mark: () => msgs.length,
    all: (type, from = 0) => msgs.slice(from).filter((m) => m.t === type) as never,
    waitFor(type, pred = () => true, waitOpts = {}) {
      const from = waitOpts.from ?? msgs.length
      return new Promise((resolve, reject) => {
        let i = from
        const timer = setTimeout(() => {
          cleanup()
          const seen = msgs.slice(from).map((m) => (m.t === 'error' ? `error:${m.code}` : m.t)).join(',')
          reject(new Error(`timeout waiting for ${type}; got ${seen}`))
        }, waitOpts.ms ?? 4000)
        const check = () => {
          for (; i < msgs.length; i++) {
            const m = msgs[i]
            if (m.t === type && pred(m as never)) {
              cleanup()
              resolve(m as never)
              return
            }
          }
        }
        const cleanup = () => {
          clearTimeout(timer)
          waiters.delete(check)
        }
        waiters.add(check)
        check()
      })
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
      return closed
    },
  }

  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(c))
    ws.addEventListener('close', () => {
      if (opts.allowHandshakeError) resolve(c)
    })
    ws.addEventListener('error', () => {
      if (opts.allowHandshakeError) resolve(c)
      else reject(new Error('ws error'))
    })
  })
}

export function defaultPublicProfile(overrides: Partial<PublicProfile> = {}): PublicProfile {
  return {
    id: 'ignored',
    name: 'ignored',
    avatar: 'ignored',
    badges: [],
    dexCaught: 0,
    party: [],
    pvpWins: 99,
    pvpLosses: 99,
    playTimeSec: 10,
    ...overrides,
  }
}

export interface JoinAuthenticatedOptions extends AccountSeedOptions {
  account?: RegisteredTestAccount
  playerId?: string
  profile?: Partial<PublicProfile>
  v?: number
  compact?: boolean
  build?: { devtools: boolean }
}

export function buildHelloMsg(o: {
  name: string
  map: string
  x: number
  y: number
  facing?: Dir
  avatar?: string
  playerId?: string
  profile?: Partial<PublicProfile>
  v?: number
  compact?: boolean
  build?: { devtools: boolean }
}): ClientMsg {
  return {
    t: 'hello',
    v: o.v ?? CONTENT.config.net.protocolVersion,
    playerId: o.playerId ?? crypto.randomUUID(),
    name: o.name,
    avatar: o.avatar ?? 'not-a-character',
    map: o.map,
    x: o.x,
    y: o.y,
    facing: o.facing ?? 'down',
    lead: null,
    profile: defaultPublicProfile(o.profile),
    signed: true,
    ...(o.compact !== undefined ? { compact: o.compact } : {}),
    ...(o.build !== undefined ? { build: o.build } : {}),
  }
}

export async function joinAuthenticatedClient(
  srv: Pick<RunningServer, 'port' | 'store' | 'authority'>,
  opts: JoinAuthenticatedOptions & { name: string; map: string; x: number; y: number },
): Promise<TestWsClient> {
  const acct = opts.account ?? await registerTestAccount(srv, {
    ...opts,
    badges: opts.badges ?? opts.profile?.badges,
    dexCaught: opts.dexCaught ?? opts.profile?.dexCaught,
    playTimeSec: opts.playTimeSec ?? opts.profile?.playTimeSec,
  })
  const c = await openRawWsClient(srv.port, {
    cookie: acct.cookie,
    accountId: acct.accountId,
    username: acct.username,
    name: acct.name,
  })
  const from = c.mark()
  c.sendRaw(buildHelloMsg({
    name: opts.name,
    map: opts.map,
    x: opts.x,
    y: opts.y,
    facing: opts.facing,
    avatar: opts.avatar,
    playerId: opts.playerId ?? acct.accountId,
    profile: opts.profile,
    v: opts.v,
    compact: opts.compact,
    build: opts.build,
  }))
  const w = await c.waitFor('welcome', undefined, { from })
  c.selfId = w.selfId
  c.sessionKey = w.sessionKey ?? ''
  assert.ok(c.sessionKey.length >= 32, 'welcome must issue a sessionKey')
  return c
}
