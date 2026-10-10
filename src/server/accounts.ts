// Account authentication, password hashing (async scrypt), session cookies, per-origin CSRF checks,
// bounded rate limiting, and the AccountStore contract shared with HTTP, Hub, Authority (#22) and Dungeons (#28).
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { promisify } from 'node:util'
import type { Creature, SaveData, World } from '../shared/types.ts'
import { CONTENT, t } from '../shared/content/index.ts'
import { sanitizeCreature } from '../shared/creature.ts'
import { createSaveManager } from '../client/core/save.ts'
import { migrateSave } from '../client/core/save-migrate.ts'
import { sanitizeSaveData, sanitizeSettings, type SanitizeContext } from '../client/core/save-sanitize.ts'
import { MODERATION, NET, type Rate } from './config.ts'
import { containsBanned, sanitizeName as moderateName } from './moderation.ts'
import { sanitizeAvatar } from './sanitize.ts'
import { codePointLength, createRateLimiter, isRecord, newSecretId, type RateLimiter } from './util.ts'

export interface AccountInfo {
  id: string
  username: string
  status: 'active' | 'flagged' | 'banned'
  createdAt: number
  lastSeen: number
}

export interface SessionInfo {
  token: string
  accountId: string
  username: string
  /** Per-session 32-byte hex secret stored with the session row. */
  sessionSecret: string
  createdAt: number
  expiresAt: number
}

export interface StoredAccountSave {
  accountId: string
  save: SaveData
  imported: boolean
  trusted: boolean
  rev: number
  updatedAt: number
  sig: string
}

export interface AuditEntryInput {
  accountId?: string | null
  ip?: string | null
  kind: string
  severity?: number
  detail?: Record<string, unknown>
  at?: number
}

export interface AuditRecord {
  id: number
  at: number
  accountId: string | null
  ipHash: string | null
  kind: string
  severity: number
  detail: Record<string, unknown>
}

export interface LedgerEntryInput {
  accountId: string
  kind: 'money' | 'item' | 'exp' | 'creature'
  subject: string
  delta: number
  balance: number
  ref: string
  at?: number
}

export interface LedgerRecord {
  id: number
  accountId: string
  at: number
  kind: 'money' | 'item' | 'exp' | 'creature'
  subject: string
  delta: number
  balance: number
  ref: string
}
export type AuthResult =
  | { ok: true; account: { id: string; username: string }; session: SessionInfo; save: SaveData | null; imported?: boolean }
  | { ok: false; status: number; code: string; message: string }

export type BindSaveResult =
  | { ok: true; record: StoredAccountSave }
  | { ok: false; status: number; code: 'already_bound' | 'invalid_save' | 'account_not_found' | 'rate_limited' | 'account_banned'; message: string }
export interface AccountStore {
  registerAccount(username: unknown, password: unknown, opts?: { ip?: string; now?: number }): Promise<AuthResult>
  loginAccount(username: unknown, password: unknown, opts?: { ip?: string; now?: number }): Promise<AuthResult>
  logoutSession(cookieHeaderOrToken: string | undefined | null, opts?: { ip?: string; now?: number }): boolean
  getAccountBySession(cookieHeaderOrToken: string | undefined | null, now?: number): SessionInfo | null
  /** Alias for getAccountBySession (#22 Authority compatibility). */
  verifySession(cookieHeaderOrToken: string | undefined | null, now?: number): SessionInfo | null
  getAccount(accountId: string): AccountInfo | null
  getSave(accountId: string): SaveData | null
  /** Detailed save record including imported/trusted/rev metadata. */
  getAccountSave(accountId: string): { accountId: string; save: SaveData | null; imported: boolean; trusted: boolean; rev: number; updatedAt?: number; sig?: string } | null
  /** Internal server-only authoritative save update (never exposed as raw client overwrite). */
  putSave(accountId: string, save: SaveData, opts?: { imported?: boolean; trusted?: boolean; now?: number; sig?: string }): StoredAccountSave
  /** Alias for putSave (#22 Authority compatibility). */
  putAccountSave(accountId: string, save: SaveData, opts?: { imported?: boolean; trusted?: boolean; now?: number; sig?: string }): StoredAccountSave
  /** First-bind only: binds a character/save to an account once; marks imported saves untrusted. */
  bindSave(accountId: string, rawSave: unknown, opts?: { imported?: boolean; ip?: string; now?: number }): BindSaveResult
  recordLedger(entry: { accountId: string; kind: LedgerRecord['kind']; subject: string; delta: number; balance: number; ref: string; at?: number }): void
  listLedger(accountId?: string, limit?: number): LedgerRecord[]
  onSessionRevoked?(listener: (accountId: string) => void): void
  audit(entry: AuditEntryInput): void
  /** Alias for audit (#22 Authority compatibility). */
  recordAudit(entry: AuditEntryInput): void
  listAudit(accountId?: string, limit?: number): AuditRecord[]
  recordLedger(entry: LedgerEntryInput): void
  listLedger(accountId?: string, limit?: number): LedgerRecord[]
}

const INVISIBLE_OR_CONTROL_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u

/** Validate and normalize a username against content/net.json auth.username and content/moderation.json. */
export function validateUsername(
  raw: unknown,
): { ok: true; username: string; key: string } | { ok: false; code: 'invalid_username'; message: string } {
  const cfg = NET.auth.username
  const errMsg = t('net.auth.invalidUsername', { min: cfg.minLen, max: cfg.maxLen })
  if (typeof raw !== 'string') return { ok: false, code: 'invalid_username', message: errMsg }
  const username = raw.normalize('NFKC').trim()
  const len = codePointLength(username)
  if (len < cfg.minLen || len > cfg.maxLen) return { ok: false, code: 'invalid_username', message: errMsg }
  if (INVISIBLE_OR_CONTROL_RE.test(username)) return { ok: false, code: 'invalid_username', message: errMsg }
  const pattern = new RegExp(cfg.pattern, 'u')
  if (!pattern.test(username)) return { ok: false, code: 'invalid_username', message: errMsg }
  for (const ch of MODERATION.name.forbiddenChars) {
    if (username.includes(ch)) return { ok: false, code: 'invalid_username', message: errMsg }
  }
  const moderateCheck = moderateName(username)
  if (!moderateCheck || moderateCheck !== username) return { ok: false, code: 'invalid_username', message: errMsg }
  const key = username.toLowerCase()
  if (MODERATION.name.reserved.some((r) => r.toLowerCase() === key)) return { ok: false, code: 'invalid_username', message: errMsg }
  if (containsBanned(username)) return { ok: false, code: 'invalid_username', message: errMsg }
  return { ok: true, username, key }
}

/** Validate a password against content/net.json auth.password rules. */
export function validatePassword(
  raw: unknown,
  username?: string,
): { ok: true; password: string } | { ok: false; code: 'invalid_password'; message: string } {
  const cfg = NET.auth.password
  const errMsg = t('net.auth.invalidPassword', { min: cfg.minLen, max: cfg.maxLen })
  if (typeof raw !== 'string') return { ok: false, code: 'invalid_password', message: errMsg }
  if (INVISIBLE_OR_CONTROL_RE.test(raw)) return { ok: false, code: 'invalid_password', message: errMsg }
  const len = codePointLength(raw)
  if (len < cfg.minLen || len > cfg.maxLen || raw.trim().length === 0) return { ok: false, code: 'invalid_password', message: errMsg }
  if (username && raw.normalize('NFKC').trim().toLowerCase() === username.normalize('NFKC').trim().toLowerCase()) {
    return { ok: false, code: 'invalid_password', message: errMsg }
  }
  return { ok: true, password: raw }
}

const scryptAsync = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keyLen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/** Salted async scrypt password hash: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`. */
export async function hashPassword(password: string, cfg = NET.auth.scrypt): Promise<string> {
  const salt = randomBytes(cfg.saltBytes)
  const derived = await scryptAsync(password.normalize('NFKC'), salt, cfg.keyLen, {
    N: cfg.cost,
    r: cfg.blockSize,
    p: cfg.parallelization,
    maxmem: cfg.maxmem,
  })
  return `scrypt$${cfg.cost}$${cfg.blockSize}$${cfg.parallelization}$${salt.toString('hex')}$${derived.toString('hex')}`
}

/** Timing-safe verification of a password against a stored `scrypt$...` hash. */
export async function verifyPassword(password: string, storedHash: string, cfg = NET.auth.scrypt): Promise<boolean> {
  const parts = storedHash.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 1 || r <= 0 || p <= 0) return false
  const salt = Buffer.from(parts[4], 'hex')
  const expected = Buffer.from(parts[5], 'hex')
  if (salt.length === 0 || expected.length === 0) return false
  try {
    const derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: cfg.maxmem,
    })
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

let dummyHashPromise: Promise<string> | null = null

/** Constant-work dummy verify when an account does not exist, preventing username timing enumeration. */
export async function verifyDummyPassword(password: string): Promise<void> {
  dummyHashPromise ??= hashPassword('dummy-nonexistent-account-password')
  const dummy = await dummyHashPromise
  await verifyPassword(password, dummy)
}

export function hashToken(token: string): string {
  return createHash('sha256').update(`agent-pocket/session/${token}`).digest('hex')
}

export function hashIp(ip: string | undefined | null): string | null {
  if (!ip) return null
  return createHash('sha256').update(`agent-pocket/ip/${ip}`).digest('hex').slice(0, 24)
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function newSessionSecret(): string {
  return randomBytes(32).toString('hex')
}

const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/

/** Extract the session token from either a `Cookie` header or a direct token string. */
export function parseSessionCookie(
  cookieHeaderOrToken: string | undefined | null,
  cookieName: string = NET.auth.cookieName,
): string | null {
  if (!cookieHeaderOrToken || typeof cookieHeaderOrToken !== 'string') return null
  const trimmed = cookieHeaderOrToken.trim()
  if (!trimmed) return null
  if (!trimmed.includes('=') && !trimmed.includes(';')) {
    return RAW_TOKEN_RE.test(trimmed) ? trimmed : null
  }
  for (const part of trimmed.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const k = part.slice(0, eq).trim()
    if (k !== cookieName) continue
    const v = part.slice(eq + 1).trim()
    if (RAW_TOKEN_RE.test(v)) return v
  }
  return null
}

export function isSecureRequest(req: IncomingMessage): boolean {
  if ('encrypted' in req.socket && req.socket.encrypted === true) return true
  if (NET.server.trustProxy) {
    const proto = req.headers['x-forwarded-proto']
    const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim().toLowerCase()
    if (first === 'https') return true
  }
  return false
}

export function formatSessionCookie(
  token: string,
  opts: { maxAgeSeconds?: number; secure?: boolean; cookieName?: string } = {},
): string {
  const name = opts.cookieName ?? NET.auth.cookieName
  const maxAge = Math.max(0, Math.floor(opts.maxAgeSeconds ?? NET.auth.sessionTtlSeconds))
  const parts = [`${name}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookie(opts: { secure?: boolean; cookieName?: string } = {}): string {
  return formatSessionCookie('', { ...opts, maxAgeSeconds: 0 })
}

/**
 * Per-origin CSRF policy for state-changing POST endpoints:
 * - Rejects `Sec-Fetch-Site: cross-site`.
 * - When `Origin` is present, its host must match the request `Host` (or `X-Forwarded-Host` when `trustProxy` is on).
 * - When `Origin` is absent and `Referer` is present, its URL host must match `Host`.
 */
export function checkOriginCsrf(req: IncomingMessage): boolean {
  const secSite = req.headers['sec-fetch-site']
  const site = (Array.isArray(secSite) ? secSite[0] : secSite)?.trim().toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return false
  const rawHost = NET.server.trustProxy
    ? ((Array.isArray(req.headers['x-forwarded-host']) ? req.headers['x-forwarded-host'][0] : req.headers['x-forwarded-host']) ?? req.headers.host)
    : req.headers.host
  const expectedHost = rawHost?.split(',')[0]?.trim().toLowerCase()

  const originHeader = req.headers.origin
  const origin = (Array.isArray(originHeader) ? originHeader[0] : originHeader)?.trim()
  if (origin) {
    if (origin === 'null' || !expectedHost) return false
    try {
      return new URL(origin).host.toLowerCase() === expectedHost
    } catch {
      return false
    }
  }

  const refererHeader = req.headers.referer
  const referer = (Array.isArray(refererHeader) ? refererHeader[0] : refererHeader)?.trim()
  if (referer) {
    if (!expectedHost) return false
    try {
      return new URL(referer).host.toLowerCase() === expectedHost
    } catch {
      return false
    }
  }

  return true
}

export interface KeyedRateLimiter {
  take(key: string, now?: number, n?: number): boolean
  size(): number
}

/** Bounded LRU map of token-bucket rate limiters (prevents unbounded memory growth from random IPs/usernames). */
export function createKeyedRateLimiter(rate: Rate, maxBuckets: number = NET.auth.maxRateBuckets): KeyedRateLimiter {
  const buckets = new Map<string, RateLimiter>()
  return {
    take(key: string, now = Date.now(), n = 1) {
      let limiter = buckets.get(key)
      if (limiter) {
        buckets.delete(key)
        buckets.set(key, limiter)
      } else {
        limiter = createRateLimiter(rate, now)
        buckets.set(key, limiter)
        if (buckets.size > maxBuckets) {
          const oldest = buckets.keys().next().value
          if (oldest !== undefined) buckets.delete(oldest)
        }
      }
      return limiter.take(now, n)
    },
    size: () => buckets.size,
  }
}


function markCreatureLegacy(cr: Creature, now: number): void {
  const originBoss = isRecord(cr.origin) && typeof cr.origin.boss === 'string' ? cr.origin.boss : undefined
  const boss = originBoss ?? CONTENT.bossBySpecies[cr.speciesId]?.id
  cr.origin = { kind: 'legacy', at: now, ...(boss ? { boss } : {}) }
}

/**
 * Sanitize and prepare a SaveData for server storage.
 * - Forces `save.playerId = accountId` (never trusts client-supplied id).
 * - Fresh binding accepts only identity/settings; imported binding preserves validated offline progression
 *   in an untrusted account excluded from ranking, trading and shared-reward co-op.
 */
export function prepareAccountSave(
  rawSave: unknown,
  opts: {
    accountId: string
    fallbackName: string
    world?: World | null
    imported?: boolean
    trusted?: boolean
    forBind?: boolean
    now?: number
  },
): { save: SaveData; imported: boolean; trusted: boolean } | null {
  const now = opts.now ?? Date.now()

  if (opts.forBind && opts.imported !== true) {
    // Canonical fresh SaveData creation on server: only name, avatar and settings accepted
    const saveMgr = createSaveManager({ world: opts.world ?? null })
    const reqName = isRecord(rawSave) && typeof rawSave.name === 'string' ? rawSave.name : opts.fallbackName
    const safeName = moderateName(reqName) ?? moderateName(opts.fallbackName) ?? t('audio.save.defaultName')
    const reqAvatar = isRecord(rawSave) && typeof rawSave.avatar === 'string' ? rawSave.avatar : undefined
    const safeAvatar = sanitizeAvatar(reqAvatar)
    const save = saveMgr.newGame({
      name: safeName,
      avatar: safeAvatar,
    })
    if (isRecord(rawSave) && isRecord(rawSave.settings)) {
      save.settings = sanitizeSettings(rawSave.settings, CONTENT)
    }
    save.playerId = opts.accountId
    return { save, imported: false, trusted: true }
  }

  const ctx: SanitizeContext = {
    content: CONTENT,
    world: opts.world ?? null,
    sanitizeCreature: (raw) => sanitizeCreature(raw, CONTENT),
    defaultName: opts.fallbackName,
    now: () => now,
    newId: () => newSecretId(),
  }
  const migrated = migrateSave(rawSave, CONTENT)
  const save = sanitizeSaveData(migrated, ctx)
  if (!save) return null

  save.playerId = opts.accountId
  save.name = moderateName(save.name) ?? moderateName(opts.fallbackName) ?? t('audio.save.defaultName')
  save.avatar = sanitizeAvatar(save.avatar)

  let imported = opts.imported === true
  let trusted = opts.trusted ?? !imported

  if (opts.forBind) {
    imported = true
    trusted = false
    save.flags['auth:untrustedImport'] = true
    for (const cr of save.party) markCreatureLegacy(cr, now)
    for (const box of save.boxes) for (const cr of box) markCreatureLegacy(cr, now)
    save.stats.pvpWins = 0
    save.stats.pvpLosses = 0
    save.stats.trades = 0
    delete save.maxDistance
  }

  return { save, imported, trusted }
}

export {
  createAccountStore,
  createProfileStore,
  migrateJsonToSqlite,
  rollbackSqliteToJson,
  type MigrationReport,
  type ProfileStore,
  type RollbackReport,
  type StoredProfile,
  type StoreOptions,
} from './store.ts'
