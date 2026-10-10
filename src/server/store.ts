// Persistent server store backed by Node's built-in node:sqlite (ap.db):
// - Accounts (scrypt password hashes), sessions (SHA-256 token hashes + per-session HMAC secret),
// - 1:1 bound character & SaveData per account (with untrusted offline import isolation),
// - Public profiles & leaderboard stats, audit log, and one-time transactional migration from profiles.json.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { LeaderboardEntry, PublicProfile } from '../shared/protocol.ts'
import type { CreatureView, SaveData, World } from '../shared/types.ts'
import { CONTENT, t } from '../shared/content/index.ts'
import { toView } from '../shared/creature.ts'
import { NET, type LeaderboardSortKey } from './config.ts'
import {
  createKeyedRateLimiter,
  hashIp,
  hashPassword,
  hashToken,
  newSessionSecret,
  newSessionToken,
  parseSessionCookie,
  prepareAccountSave,
  validatePassword,
  validateUsername,
  verifyDummyPassword,
  verifyPassword,
  type AccountStore,
  type AuditEntryInput,
  type AuditRecord,
  type SessionInfo,
  type StoredAccountSave,
} from './accounts.ts'
import { codePointLength, isRecord, newSecretId, publicIdFor, safeJsonParse } from './util.ts'

export {
  clearSessionCookie,
  checkOriginCsrf,
  createKeyedRateLimiter,
  formatSessionCookie,
  hashIp,
  hashPassword,
  hashToken,
  isSecureRequest,
  newSessionSecret,
  newSessionToken,
  parseSessionCookie,
  prepareAccountSave,
  validatePassword,
  validateUsername,
  verifyDummyPassword,
  verifyPassword,
  type AccountInfo,
  type AccountStore,
  type AuditEntryInput,
  type AuditRecord,
  type AuthResult,
  type BindSaveResult,
  type KeyedRateLimiter,
  type SessionInfo,
  type StoredAccountSave,
} from './accounts.ts'

export interface StoredProfile {
  profile: PublicProfile
  pvpWins: number
  pvpLosses: number
  trades: number
  firstSeen: number
  lastSeen: number
  /** Server-observed farthest overworld distance from the origin (tiles); absent in older files. */
  maxDistance?: number
}

interface ProfilesFile {
  version: number
  profiles: Record<string, StoredProfile>
}

export interface MigrationReport {
  migrated: boolean
  importedCount: number
  sqlitePath: string
  jsonPath: string
  backupPath: string | null
}

export interface RollbackReport {
  ok: boolean
  restoredProfiles: number
  jsonPath: string
  restoredDbFrom: string | null
}

export interface ProfileStore extends AccountStore {
  load(): Promise<void>
  get(id: string): StoredProfile | undefined
  /** Public profile with server-authoritative pvp stats. */
  publicProfile(id: string): PublicProfile | undefined
  /** Upsert the client-reported part of a profile (pvp stats are never taken from the client). */
  put(profile: PublicProfile, now?: number): void
  touch(id: string, now?: number): void
  recordPvp(winnerId: string | null, loserId: string | null): void
  recordTrade(id: string): void
  /** Raise the distance record (never lowers it). */
  recordDistance(id: string, tiles: number): void
  leaderboard(limit?: number): LeaderboardEntry[]
  size(): number
  flush(): Promise<void>
  close(): Promise<void>
}

export interface StoreOptions {
  dir: string
  world?: World | null
  log?: (msg: string) => void
}

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'flagged', 'banned')),
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS characters (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  avatar TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('new', 'legacy-profile', 'legacy-import')),
  imported INTEGER NOT NULL DEFAULT 0,
  trusted INTEGER NOT NULL DEFAULT 1,
  rev INTEGER NOT NULL DEFAULT 1,
  save_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL,
  pvp_wins INTEGER NOT NULL DEFAULT 0,
  pvp_losses INTEGER NOT NULL DEFAULT 0,
  trades INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  max_distance INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS legacy_profiles (
  id TEXT PRIMARY KEY,
  raw_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  account_id TEXT,
  ip_hash TEXT,
  kind TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 1,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_account ON audit(account_id, at);
`

export function compareEntries(sortBy: readonly LeaderboardSortKey[]) {
  return (a: LeaderboardEntry, b: LeaderboardEntry): number => {
    for (const k of sortBy) {
      const av = a[k] ?? 0
      const bv = b[k] ?? 0
      const d = k === 'pvpLosses' ? av - bv : bv - av
      if (d !== 0) return d
    }
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  }
}

function parsePublicProfile(raw: unknown): PublicProfile | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.avatar !== 'string') {
    return null
  }
  const badges = Array.isArray(raw.badges) ? raw.badges.filter((b): b is string => typeof b === 'string') : []
  const party = Array.isArray(raw.party) ? (raw.party as CreatureView[]) : []
  return {
    id: raw.id,
    name: raw.name,
    avatar: raw.avatar,
    badges,
    dexCaught: typeof raw.dexCaught === 'number' ? raw.dexCaught : 0,
    party,
    pvpWins: typeof raw.pvpWins === 'number' ? raw.pvpWins : 0,
    pvpLosses: typeof raw.pvpLosses === 'number' ? raw.pvpLosses : 0,
    playTimeSec: typeof raw.playTimeSec === 'number' ? raw.playTimeSec : 0,
    ...(typeof raw.maxDistance === 'number' ? { maxDistance: raw.maxDistance } : {}),
  }
}

function parseStoredProfileRecord(raw: unknown): StoredProfile | null {
  if (!isRecord(raw)) return null
  const profile = parsePublicProfile(raw.profile)
  if (!profile) return null
  const pvpWins = typeof raw.pvpWins === 'number' ? raw.pvpWins : 0
  const pvpLosses = typeof raw.pvpLosses === 'number' ? raw.pvpLosses : 0
  const maxDistance = typeof raw.maxDistance === 'number' ? raw.maxDistance : undefined
  return {
    profile: { ...profile, pvpWins, pvpLosses },
    pvpWins,
    pvpLosses,
    trades: typeof raw.trades === 'number' ? raw.trades : 0,
    firstSeen: typeof raw.firstSeen === 'number' ? raw.firstSeen : 0,
    lastSeen: typeof raw.lastSeen === 'number' ? raw.lastSeen : 0,
    ...(maxDistance !== undefined ? { maxDistance } : {}),
  }
}

function profileFromSave(accountId: string, save: SaveData, trusted: boolean, prev?: StoredProfile): PublicProfile {
  return {
    id: accountId,
    name: save.name,
    avatar: save.avatar,
    badges: trusted ? [...save.badges] : (prev?.profile.badges ?? []),
    dexCaught: trusted ? save.dexCaught.length : (prev?.profile.dexCaught ?? 0),
    party: save.party.slice(0, CONTENT.config.party.maxParty).map((c) => toView(c, CONTENT)),
    pvpWins: prev?.pvpWins ?? 0,
    pvpLosses: prev?.pvpLosses ?? 0,
    playTimeSec: save.playTimeSec,
    ...(prev?.maxDistance !== undefined ? { maxDistance: prev.maxDistance } : {}),
  }
}

export function createProfileStore(opts: StoreOptions): ProfileStore {
  const cfg = NET.store
  const jsonFile = join(opts.dir, cfg.file)
  const sqliteFile = join(opts.dir, cfg.sqliteFile)
  const backupDir = join(opts.dir, cfg.backupDir)
  const log = opts.log ?? (() => {})
  const profiles = new Map<string, StoredProfile>()
  const registerIpLimiter = createKeyedRateLimiter(NET.auth.rates.registerIp, NET.auth.maxRateBuckets)
  const loginIpLimiter = createKeyedRateLimiter(NET.auth.rates.loginIp, NET.auth.maxRateBuckets)
  const loginAccountLimiter = createKeyedRateLimiter(NET.auth.rates.loginAccount, NET.auth.maxRateBuckets)
  const bindAccountLimiter = createKeyedRateLimiter(NET.auth.rates.bindAccount, NET.auth.maxRateBuckets)

  let db: DatabaseSync | null = null
  let board: LeaderboardEntry[] | null = null
  let dirtyJson = false
  let timer: NodeJS.Timeout | null = null
  let writing: Promise<void> | null = null
  let closed = false

  function openDb(): DatabaseSync {
    if (db && db.isOpen) return db
    mkdirSync(opts.dir, { recursive: true })
    db = new DatabaseSync(sqliteFile, { timeout: 5000 })
    db.exec(SCHEMA_SQL)
    const rows = db.prepare('SELECT id, profile_json, pvp_wins, pvp_losses, trades, first_seen, last_seen, max_distance FROM profiles').all()
    for (const r of rows) {
      if (typeof r.id !== 'string' || typeof r.profile_json !== 'string') continue
      const parsed = parsePublicProfile(safeJsonParse(r.profile_json))
      if (!parsed) continue
      const pvpWins = typeof r.pvp_wins === 'number' ? r.pvp_wins : 0
      const pvpLosses = typeof r.pvp_losses === 'number' ? r.pvp_losses : 0
      const maxDistance = typeof r.max_distance === 'number' ? r.max_distance : 0
      profiles.set(r.id, {
        profile: { ...parsed, id: r.id, pvpWins, pvpLosses },
        pvpWins,
        pvpLosses,
        trades: typeof r.trades === 'number' ? r.trades : 0,
        firstSeen: typeof r.first_seen === 'number' ? r.first_seen : 0,
        lastSeen: typeof r.last_seen === 'number' ? r.last_seen : 0,
        ...(maxDistance > 0 ? { maxDistance } : {}),
      })
    }
    board = null
    return db
  }

  function upsertProfileRow(s: StoredProfile): void {
    if (closed) return
    const conn = openDb()
    conn.prepare(`
      INSERT INTO profiles (id, profile_json, pvp_wins, pvp_losses, trades, first_seen, last_seen, max_distance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        profile_json = excluded.profile_json,
        pvp_wins = excluded.pvp_wins,
        pvp_losses = excluded.pvp_losses,
        trades = excluded.trades,
        first_seen = excluded.first_seen,
        last_seen = excluded.last_seen,
        max_distance = MAX(profiles.max_distance, excluded.max_distance)
    `).run(
      s.profile.id,
      JSON.stringify(s.profile),
      s.pvpWins,
      s.pvpLosses,
      s.trades,
      s.firstSeen,
      s.lastSeen,
      s.maxDistance ?? 0,
    )
  }

  function isLegacyJsonProtected(): boolean {
    const conn = openDb()
    const row = conn.prepare("SELECT value FROM meta WHERE key = 'legacy_source'").get()
    return row?.value === cfg.file
  }

  function scheduleJsonMirror(): void {
    board = null
    dirtyJson = true
    if (closed || timer) return
    timer = setTimeout(() => { timer = null; void persistJsonMirror() }, cfg.debounceMs)
    timer.unref?.()
  }

  async function writeJsonMirrorOnce(): Promise<boolean> {
    dirtyJson = false
    if (isLegacyJsonProtected()) return true
    const data: ProfilesFile = { version: cfg.version, profiles: Object.fromEntries(profiles) }
    const tmp = `${jsonFile}.${process.pid}.${Date.now()}.tmp`
    try {
      await mkdir(opts.dir, { recursive: true })
      await writeFile(tmp, JSON.stringify(data))
      await rename(tmp, jsonFile)
      return true
    } catch (err) {
      dirtyJson = true
      await unlink(tmp).catch(() => {})
      log(`profile store mirror write failed: ${(err as Error).message}`)
      return false
    }
  }

  async function persistJsonMirror(): Promise<void> {
    for (;;) {
      if (writing) { await writing; continue }
      if (!dirtyJson) return
      let ok = true
      writing = writeJsonMirrorOnce().then((r) => { ok = r }).finally(() => { writing = null })
      await writing
      if (!ok) { if (!closed) scheduleJsonMirror(); return }
    }
  }

  function evictIfNeeded(): void {
    if (profiles.size <= cfg.maxProfiles) return
    const conn = openDb()
    const oldest = [...profiles.values()].sort((a, b) => a.lastSeen - b.lastSeen)
    const toRemove = oldest.slice(0, profiles.size - cfg.maxProfiles)
    const delStmt = conn.prepare('DELETE FROM profiles WHERE id = ?')
    for (const p of toRemove) {
      profiles.delete(p.profile.id)
      delStmt.run(p.profile.id)
    }
  }

  function writeAudit(entry: AuditEntryInput): void {
    if (closed && (!db || !db.isOpen)) return
    const conn = openDb()
    const at = entry.at ?? Date.now()
    const severity = entry.severity ?? 1
    const ipHash = hashIp(entry.ip)
    const detailJson = JSON.stringify(entry.detail ?? {})
    conn.prepare(`
      INSERT INTO audit (at, account_id, ip_hash, kind, severity, detail_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(at, entry.accountId ?? null, ipHash, entry.kind, severity, detailJson)
  }

  function createSessionRow(accountId: string, username: string, now: number): SessionInfo {
    const conn = openDb()
    const token = newSessionToken()
    const tokenHash = hashToken(token)
    const sessionSecret = newSessionSecret()
    const expiresAt = now + NET.auth.sessionTtlSeconds * 1000

    conn.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
    const existing = conn.prepare('SELECT token_hash FROM sessions WHERE account_id = ? ORDER BY created_at DESC').all(accountId)
    const maxKeep = Math.max(0, NET.auth.maxSessionsPerAccount - 1)
    if (existing.length > maxKeep) {
      const del = conn.prepare('DELETE FROM sessions WHERE token_hash = ?')
      for (const old of existing.slice(maxKeep)) {
        if (typeof old.token_hash === 'string') del.run(old.token_hash)
      }
    }

    conn.prepare(`
      INSERT INTO sessions (token_hash, account_id, session_secret, created_at, expires_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tokenHash, accountId, sessionSecret, now, expiresAt, now)

    return { token, accountId, username, sessionSecret, createdAt: now, expiresAt }
  }

  function readCharacterRow(accountId: string): StoredAccountSave | null {
    const conn = openDb()
    const row = conn.prepare(`
      SELECT save_json, imported, trusted, rev, updated_at
      FROM characters
      WHERE account_id = ?
    `).get(accountId)
    if (!row || typeof row.save_json !== 'string') return null
    const parsed = safeJsonParse(row.save_json)
    if (!isRecord(parsed)) return null
    const prepared = prepareAccountSave(parsed, {
      accountId,
      fallbackName: typeof parsed.name === 'string' ? parsed.name : t('audio.save.defaultName'),
      world: opts.world ?? null,
      imported: row.imported === 1,
      trusted: row.trusted === 1,
      forBind: false,
    })
    if (!prepared) return null
    return {
      accountId,
      save: prepared.save,
      imported: row.imported === 1,
      trusted: row.trusted === 1,
      rev: typeof row.rev === 'number' ? row.rev : 1,
      updatedAt: typeof row.updated_at === 'number' ? row.updated_at : 0,
    }
  }

  function syncProfileFromSave(accountId: string, save: SaveData, trusted: boolean, now: number): void {
    const prev = profiles.get(accountId)
    const pub = profileFromSave(accountId, save, trusted, prev)
    const stored: StoredProfile = {
      profile: pub,
      pvpWins: prev?.pvpWins ?? 0,
      pvpLosses: prev?.pvpLosses ?? 0,
      trades: prev?.trades ?? 0,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      ...(prev?.maxDistance !== undefined ? { maxDistance: prev.maxDistance } : {}),
    }
    profiles.set(accountId, stored)
    upsertProfileRow(stored)
    board = null
  }

  function getAccountBySessionImpl(cookieHeaderOrToken: string | undefined | null, now = Date.now()): SessionInfo | null {
    const token = parseSessionCookie(cookieHeaderOrToken)
    if (!token) return null
    const conn = openDb()
    const tokenHash = hashToken(token)
    const row = conn.prepare(`
      SELECT s.account_id, s.session_secret, s.created_at, s.expires_at, a.username, a.status
      FROM sessions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ?
    `).get(tokenHash)
    if (!row || typeof row.account_id !== 'string' || typeof row.username !== 'string' || typeof row.session_secret !== 'string') {
      return null
    }
    const expiresAt = typeof row.expires_at === 'number' ? row.expires_at : 0
    const createdAt = typeof row.created_at === 'number' ? row.created_at : 0
    if (expiresAt <= now || row.status === 'banned') {
      conn.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
      return null
    }
    conn.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, tokenHash)
    conn.prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').run(now, row.account_id)
    return {
      token,
      accountId: row.account_id,
      username: row.username,
      sessionSecret: row.session_secret,
      createdAt,
      expiresAt,
    }
  }

  function putSaveImpl(
    accountId: string,
    save: SaveData,
    putOpts?: { imported?: boolean; trusted?: boolean; now?: number },
  ): StoredAccountSave {
    const conn = openDb()
    const now = putOpts?.now ?? Date.now()
    const acc = conn.prepare('SELECT username FROM accounts WHERE id = ?').get(accountId)
    const fallbackName = typeof acc?.username === 'string' ? acc.username : t('audio.save.defaultName')
    const existing = conn.prepare('SELECT imported, trusted, rev, created_at FROM characters WHERE account_id = ?').get(accountId)
    const imported = putOpts?.imported ?? (existing ? existing.imported === 1 : false)
    const trusted = putOpts?.trusted ?? (existing ? existing.trusted === 1 : !imported)
    const prepared = prepareAccountSave(save, {
      accountId,
      fallbackName,
      world: opts.world ?? null,
      imported,
      trusted,
      forBind: false,
      now,
    })
    const cleanSave: SaveData = prepared ? prepared.save : { ...save, playerId: accountId }
    const nextRev = existing && typeof existing.rev === 'number' ? existing.rev + 1 : 1
    const createdAt = existing && typeof existing.created_at === 'number' ? existing.created_at : now
    const origin = imported ? 'legacy-import' : 'new'

    conn.prepare(`
      INSERT INTO characters (account_id, name, name_key, avatar, origin, imported, trusted, rev, save_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        name = excluded.name,
        name_key = excluded.name_key,
        avatar = excluded.avatar,
        imported = excluded.imported,
        trusted = excluded.trusted,
        rev = excluded.rev,
        save_json = excluded.save_json,
        updated_at = excluded.updated_at
    `).run(
      accountId,
      cleanSave.name,
      cleanSave.name.toLowerCase(),
      cleanSave.avatar,
      origin,
      imported ? 1 : 0,
      trusted ? 1 : 0,
      nextRev,
      JSON.stringify(cleanSave),
      createdAt,
      now,
    )

    syncProfileFromSave(accountId, cleanSave, trusted, now)
    scheduleJsonMirror()
    return { accountId, save: cleanSave, imported, trusted, rev: nextRev, updatedAt: now }
  }

  return {
    async load() {
      const conn = openDb()
      const legacyRow = conn.prepare("SELECT value FROM meta WHERE key = 'legacy_imported'").get()
      if (legacyRow) return
      if (!existsSync(jsonFile)) return

      let raw: string
      try {
        raw = readFileSync(jsonFile, 'utf8')
      } catch {
        return
      }
      const parsed = safeJsonParse(raw)
      if (!isRecord(parsed) || (parsed.profiles !== undefined && !isRecord(parsed.profiles))) {
        const aside = `${jsonFile}.corrupt-${Date.now()}`
        await rename(jsonFile, aside).catch(() => {})
        log(`profile store unreadable; moved to ${aside}`)
        return
      }

      const now = Date.now()
      try {
        await mkdir(backupDir, { recursive: true })
        const backupFile = join(backupDir, `pre-legacy-import-${now}.db`)
        await backup(conn, backupFile)
      } catch (err) {
        log(`pre-import sqlite backup skipped: ${(err as Error).message}`)
      }

      const rawProfiles = isRecord(parsed.profiles) ? parsed.profiles : {}
      conn.exec('BEGIN IMMEDIATE')
      try {
        const insertLegacy = conn.prepare(`
          INSERT INTO legacy_profiles (id, raw_json, imported_at)
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `)
        const upsertProf = conn.prepare(`
          INSERT INTO profiles (id, profile_json, pvp_wins, pvp_losses, trades, first_seen, last_seen, max_distance)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            profile_json = excluded.profile_json,
            pvp_wins = MAX(profiles.pvp_wins, excluded.pvp_wins),
            pvp_losses = MAX(profiles.pvp_losses, excluded.pvp_losses),
            trades = MAX(profiles.trades, excluded.trades),
            first_seen = MIN(profiles.first_seen, excluded.first_seen),
            last_seen = MAX(profiles.last_seen, excluded.last_seen),
            max_distance = MAX(profiles.max_distance, excluded.max_distance)
        `)
        for (const [id, entry] of Object.entries(rawProfiles)) {
          const sp = parseStoredProfileRecord(entry)
          if (!sp || sp.profile.id !== id) continue
          insertLegacy.run(id, JSON.stringify(entry), now)
          upsertProf.run(
            id,
            JSON.stringify(sp.profile),
            sp.pvpWins,
            sp.pvpLosses,
            sp.trades,
            sp.firstSeen,
            sp.lastSeen,
            sp.maxDistance ?? 0,
          )
          profiles.set(id, sp)
        }
        conn.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_imported', ?)").run(String(now))
        conn.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_source', ?)").run(cfg.file)
        conn.exec('COMMIT')
      } catch (err) {
        conn.exec('ROLLBACK')
        throw err
      }
      board = null
    },

    get(id) {
      openDb()
      return profiles.get(id)
    },

    publicProfile(id) {
      openDb()
      const s = profiles.get(id)
      return s ? { ...s.profile, pvpWins: s.pvpWins, pvpLosses: s.pvpLosses, maxDistance: s.maxDistance ?? 0 } : undefined
    },

    put(profile, now = Date.now()) {
      openDb()
      const prev = profiles.get(profile.id)
      const charRow = db?.prepare('SELECT trusted FROM characters WHERE account_id = ?').get(profile.id)
      const untrustedAccount = charRow !== undefined && charRow.trusted === 0
      const effectiveProfile: PublicProfile = untrustedAccount
        ? {
          ...profile,
          badges: prev?.profile.badges ?? [],
          dexCaught: prev?.profile.dexCaught ?? 0,
          pvpWins: prev?.pvpWins ?? 0,
          pvpLosses: prev?.pvpLosses ?? 0,
        }
        : { ...profile, pvpWins: prev?.pvpWins ?? 0, pvpLosses: prev?.pvpLosses ?? 0 }
      const next: StoredProfile = {
        profile: effectiveProfile,
        pvpWins: prev?.pvpWins ?? 0,
        pvpLosses: prev?.pvpLosses ?? 0,
        trades: prev?.trades ?? 0,
        firstSeen: prev?.firstSeen ?? now,
        lastSeen: now,
        ...(prev?.maxDistance !== undefined ? { maxDistance: prev.maxDistance } : {}),
      }
      profiles.set(profile.id, next)
      upsertProfileRow(next)
      evictIfNeeded()
      scheduleJsonMirror()
    },

    touch(id, now = Date.now()) {
      openDb()
      const s = profiles.get(id)
      if (s) {
        s.lastSeen = now
        upsertProfileRow(s)
        scheduleJsonMirror()
      }
    },

    recordPvp(winnerId, loserId) {
      openDb()
      const w = winnerId ? profiles.get(winnerId) : undefined
      const l = loserId ? profiles.get(loserId) : undefined
      if (w) {
        w.pvpWins++
        w.profile.pvpWins = w.pvpWins
        upsertProfileRow(w)
      }
      if (l) {
        l.pvpLosses++
        l.profile.pvpLosses = l.pvpLosses
        upsertProfileRow(l)
      }
      if (w || l) scheduleJsonMirror()
    },

    recordTrade(id) {
      openDb()
      const s = profiles.get(id)
      if (s) {
        s.trades++
        upsertProfileRow(s)
        scheduleJsonMirror()
      }
    },

    recordDistance(id, tiles) {
      openDb()
      const s = profiles.get(id)
      if (!s || !Number.isFinite(tiles) || tiles <= (s.maxDistance ?? 0)) return
      s.maxDistance = Math.floor(tiles)
      upsertProfileRow(s)
      scheduleJsonMirror()
    },

    leaderboard(limit = NET.leaderboard.size) {
      openDb()
      if (!board) {
        board = [...profiles.values()]
          .map((s): LeaderboardEntry => ({
            id: s.profile.id,
            name: s.profile.name,
            avatar: s.profile.avatar,
            dexCaught: s.profile.dexCaught,
            badges: s.profile.badges.length,
            pvpWins: s.pvpWins,
            pvpLosses: s.pvpLosses,
            maxDistance: s.maxDistance ?? 0,
          }))
          .sort(compareEntries(NET.leaderboard.sortBy))
      }
      return board.slice(0, limit)
    },

    size() {
      openDb()
      return profiles.size
    },

    async registerAccount(rawUsername, rawPassword, regOpts) {
      const conn = openDb()
      const now = regOpts?.now ?? Date.now()
      const ip = regOpts?.ip ?? 'local'
      if (!registerIpLimiter.take(ip, now)) {
        writeAudit({ ip, kind: 'auth.register_rate_limited', severity: 2, detail: {}, at: now })
        return { ok: false, status: 429, code: 'rate_limited', message: t('net.error.rate_limited') }
      }
      const u = validateUsername(rawUsername)
      if (!u.ok) return { ok: false, status: 400, code: u.code, message: u.message }
      const p = validatePassword(rawPassword, u.username)
      if (!p.ok) return { ok: false, status: 400, code: p.code, message: p.message }

      const existing = conn.prepare('SELECT id FROM accounts WHERE username_key = ?').get(u.key)
      if (existing) {
        writeAudit({ ip, kind: 'auth.register_conflict', severity: 1, detail: { usernameKey: u.key }, at: now })
        return { ok: false, status: 409, code: 'username_taken', message: t('net.auth.usernameTaken') }
      }

      const passwordHash = await hashPassword(p.password)
      const accountId = publicIdFor(newSecretId())

      conn.exec('BEGIN IMMEDIATE')
      let session: SessionInfo
      try {
        const checkAgain = conn.prepare('SELECT id FROM accounts WHERE username_key = ?').get(u.key)
        if (checkAgain) {
          conn.exec('ROLLBACK')
          writeAudit({ ip, kind: 'auth.register_conflict', severity: 1, detail: { usernameKey: u.key }, at: now })
          return { ok: false, status: 409, code: 'username_taken', message: t('net.auth.usernameTaken') }
        }
        conn.prepare(`
          INSERT INTO accounts (id, username, username_key, password_hash, status, created_at, last_seen)
          VALUES (?, ?, ?, ?, 'active', ?, ?)
        `).run(accountId, u.username, u.key, passwordHash, now, now)
        session = createSessionRow(accountId, u.username, now)
        conn.exec('COMMIT')
      } catch (err) {
        if (conn.isTransaction) conn.exec('ROLLBACK')
        throw err
      }

      writeAudit({ accountId, ip, kind: 'auth.register', severity: 1, detail: { username: u.username }, at: now })
      return { ok: true, account: { id: accountId, username: u.username }, session, save: null }
    },

    async loginAccount(rawUsername, rawPassword, loginOpts) {
      const conn = openDb()
      const now = loginOpts?.now ?? Date.now()
      const ip = loginOpts?.ip ?? 'local'
      if (!loginIpLimiter.take(ip, now)) {
        writeAudit({ ip, kind: 'auth.login_rate_limited', severity: 2, detail: { scope: 'ip' }, at: now })
        return { ok: false, status: 429, code: 'rate_limited', message: t('net.error.rate_limited') }
      }
      const usernameKey = typeof rawUsername === 'string' ? rawUsername.normalize('NFKC').trim().toLowerCase() : ''
      if (usernameKey && !loginAccountLimiter.take(usernameKey, now)) {
        writeAudit({ ip, kind: 'auth.login_rate_limited', severity: 2, detail: { scope: 'account', usernameKey }, at: now })
        return { ok: false, status: 429, code: 'rate_limited', message: t('net.error.rate_limited') }
      }
      if (!usernameKey || typeof rawPassword !== 'string' || rawPassword.length === 0 || codePointLength(rawPassword) > NET.auth.password.maxLen) {
        await verifyDummyPassword(typeof rawPassword === 'string' ? rawPassword.slice(0, NET.auth.password.maxLen) : 'invalid')
        writeAudit({ ip, kind: 'auth.login_failed', severity: 1, detail: {}, at: now })
        return { ok: false, status: 401, code: 'invalid_credentials', message: t('net.auth.invalidCredentials') }
      }

      const row = conn.prepare('SELECT id, username, password_hash, status FROM accounts WHERE username_key = ?').get(usernameKey)
      if (!row || typeof row.id !== 'string' || typeof row.username !== 'string' || typeof row.password_hash !== 'string') {
        await verifyDummyPassword(rawPassword)
        writeAudit({ ip, kind: 'auth.login_failed', severity: 1, detail: {}, at: now })
        return { ok: false, status: 401, code: 'invalid_credentials', message: t('net.auth.invalidCredentials') }
      }

      const valid = await verifyPassword(rawPassword, row.password_hash)
      if (!valid) {
        writeAudit({ accountId: row.id, ip, kind: 'auth.login_failed', severity: 1, detail: {}, at: now })
        return { ok: false, status: 401, code: 'invalid_credentials', message: t('net.auth.invalidCredentials') }
      }
      if (row.status === 'banned') {
        writeAudit({ accountId: row.id, ip, kind: 'auth.login_banned', severity: 2, detail: {}, at: now })
        return { ok: false, status: 403, code: 'account_banned', message: t('net.auth.accountBanned') }
      }

      conn.prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').run(now, row.id)
      const session = createSessionRow(row.id, row.username, now)
      const charRec = readCharacterRow(row.id)
      writeAudit({ accountId: row.id, ip, kind: 'auth.login', severity: 1, detail: {}, at: now })
      return {
        ok: true,
        account: { id: row.id, username: row.username },
        session,
        save: charRec?.save ?? null,
        ...(charRec ? { imported: charRec.imported } : {}),
      }
    },

    logoutSession(cookieHeaderOrToken, logoutOpts) {
      const token = parseSessionCookie(cookieHeaderOrToken)
      if (!token) return false
      const conn = openDb()
      const now = logoutOpts?.now ?? Date.now()
      const tokenHash = hashToken(token)
      const row = conn.prepare('SELECT account_id FROM sessions WHERE token_hash = ?').get(tokenHash)
      const res = conn.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
      if (row && typeof row.account_id === 'string') {
        writeAudit({ accountId: row.account_id, ip: logoutOpts?.ip, kind: 'auth.logout', severity: 1, detail: {}, at: now })
      }
      return Number(res.changes) > 0
    },

    getAccountBySession: getAccountBySessionImpl,
    verifySession: getAccountBySessionImpl,

    getAccount(accountId) {
      const conn = openDb()
      const row = conn.prepare('SELECT id, username, status, created_at, last_seen FROM accounts WHERE id = ?').get(accountId)
      if (!row || typeof row.id !== 'string' || typeof row.username !== 'string') return null
      const status = row.status === 'flagged' || row.status === 'banned' ? row.status : 'active'
      return {
        id: row.id,
        username: row.username,
        status,
        createdAt: typeof row.created_at === 'number' ? row.created_at : 0,
        lastSeen: typeof row.last_seen === 'number' ? row.last_seen : 0,
      }
    },

    getSave(accountId) {
      return readCharacterRow(accountId)?.save ?? null
    },

    getAccountSave(accountId) {
      const conn = openDb()
      const rec = readCharacterRow(accountId)
      if (rec) return { save: rec.save, imported: rec.imported, trusted: rec.trusted, rev: rec.rev }
      const acc = conn.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId)
      if (!acc) return null
      return { save: null, imported: false, trusted: true, rev: 0 }
    },

    putSave: putSaveImpl,
    putAccountSave: putSaveImpl,

    bindSave(accountId, rawSave, bindOpts) {
      const conn = openDb()
      const now = bindOpts?.now ?? Date.now()
      if (!bindAccountLimiter.take(accountId, now)) {
        writeAudit({ accountId, ip: bindOpts?.ip, kind: 'account.bind_rate_limited', severity: 2, detail: {}, at: now })
        return { ok: false, status: 429, code: 'rate_limited', message: t('net.error.rate_limited') }
      }
      const acc = conn.prepare('SELECT id, username, status FROM accounts WHERE id = ?').get(accountId)
      if (!acc || typeof acc.username !== 'string') {
        return { ok: false, status: 404, code: 'account_not_found', message: t('net.auth.unauthorized') }
      }
      const existing = conn.prepare('SELECT account_id FROM characters WHERE account_id = ?').get(accountId)
      if (existing) {
        writeAudit({ accountId, ip: bindOpts?.ip, kind: 'account.bind_rejected_duplicate', severity: 1, detail: {}, at: now })
        return { ok: false, status: 409, code: 'already_bound', message: t('net.auth.alreadyBound') }
      }

      const prepared = prepareAccountSave(rawSave, {
        accountId,
        fallbackName: acc.username,
        world: opts.world ?? null,
        imported: bindOpts?.imported === true,
        forBind: true,
        now,
      })
      if (!prepared) {
        writeAudit({ accountId, ip: bindOpts?.ip, kind: 'account.bind_invalid_save', severity: 1, detail: {}, at: now })
        return { ok: false, status: 400, code: 'invalid_save', message: t('net.auth.invalidSave') }
      }

      const { save, imported, trusted } = prepared
      const origin = imported ? 'legacy-import' : 'new'
      const insertRes = conn.prepare(`
        INSERT INTO characters (account_id, name, name_key, avatar, origin, imported, trusted, rev, save_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(account_id) DO NOTHING
      `).run(
        accountId,
        save.name,
        save.name.toLowerCase(),
        save.avatar,
        origin,
        imported ? 1 : 0,
        trusted ? 1 : 0,
        JSON.stringify(save),
        now,
        now,
      )
      if (Number(insertRes.changes) === 0) {
        writeAudit({ accountId, ip: bindOpts?.ip, kind: 'account.bind_rejected_duplicate', severity: 1, detail: {}, at: now })
        return { ok: false, status: 409, code: 'already_bound', message: t('net.auth.alreadyBound') }
      }

      syncProfileFromSave(accountId, save, trusted, now)
      scheduleJsonMirror()
      writeAudit({
        accountId,
        ip: bindOpts?.ip,
        kind: imported ? 'account.bind_import' : 'account.bind_new',
        severity: 1,
        detail: {
          imported,
          trusted,
          partySize: save.party.length,
          badges: save.badges.length,
          dexCaught: save.dexCaught.length,
        },
        at: now,
      })
      return {
        ok: true,
        record: { accountId, save, imported, trusted, rev: 1, updatedAt: now },
      }
    },

    audit: writeAudit,
    recordAudit: writeAudit,

    listAudit(accountId, limit = 100) {
      const conn = openDb()
      const rows = accountId
        ? conn.prepare('SELECT id, at, account_id, ip_hash, kind, severity, detail_json FROM audit WHERE account_id = ? ORDER BY id DESC LIMIT ?').all(accountId, limit)
        : conn.prepare('SELECT id, at, account_id, ip_hash, kind, severity, detail_json FROM audit ORDER BY id DESC LIMIT ?').all(limit)
      return rows.map((r): AuditRecord => {
        const parsed = typeof r.detail_json === 'string' ? safeJsonParse(r.detail_json) : null
        return {
          id: typeof r.id === 'number' ? r.id : 0,
          at: typeof r.at === 'number' ? r.at : 0,
          accountId: typeof r.account_id === 'string' ? r.account_id : null,
          ipHash: typeof r.ip_hash === 'string' ? r.ip_hash : null,
          kind: typeof r.kind === 'string' ? r.kind : '',
          severity: typeof r.severity === 'number' ? r.severity : 1,
          detail: isRecord(parsed) ? parsed : {},
        }
      })
    },

    async flush() {
      if (timer) { clearTimeout(timer); timer = null }
      await persistJsonMirror()
      if (db && db.isOpen) {
        try { db.exec('PRAGMA wal_checkpoint(PASSIVE)') } catch { /* ignore */ }
      }
    },

    async close() {
      closed = true
      if (timer) { clearTimeout(timer); timer = null }
      await persistJsonMirror()
      if (db && db.isOpen) {
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* ignore */ }
        db.close()
      }
    },
  }
}

export const createAccountStore = createProfileStore

/**
 * Run the one-time transactional JSON (`profiles.json`) -> SQLite (`ap.db`) migration on `dir`.
 * Idempotent: if already migrated, returns `migrated: false` and the existing count without re-importing.
 * Retains the original `profiles.json` untouched on disk.
 */
export async function migrateJsonToSqlite(dir: string, log: (msg: string) => void = () => {}): Promise<MigrationReport> {
  const cfg = NET.store
  const sqlitePath = join(dir, cfg.sqliteFile)
  const jsonPath = join(dir, cfg.file)
  const backupDir = join(dir, cfg.backupDir)

  mkdirSync(dir, { recursive: true })
  const checkConn = new DatabaseSync(sqlitePath, { timeout: 5000 })
  checkConn.exec(SCHEMA_SQL)
  const already = checkConn.prepare("SELECT value FROM meta WHERE key = 'legacy_imported'").get()
  checkConn.close()

  const store = createProfileStore({ dir, log })
  await store.load()
  await store.close()

  const verifyConn = new DatabaseSync(sqlitePath, { timeout: 5000 })
  const countRow = verifyConn.prepare('SELECT COUNT(*) AS cnt FROM legacy_profiles').get()
  const importedAfter = verifyConn.prepare("SELECT value FROM meta WHERE key = 'legacy_imported'").get()
  verifyConn.close()

  let latestBackup: string | null = null
  if (existsSync(backupDir)) {
    const files = readdirSync(backupDir).filter((f) => f.startsWith('pre-legacy-import-') && f.endsWith('.db')).sort()
    if (files.length > 0) latestBackup = join(backupDir, files[files.length - 1])
  }

  return {
    migrated: !already && !!importedAfter,
    importedCount: typeof countRow?.cnt === 'number' ? countRow.cnt : 0,
    sqlitePath,
    jsonPath,
    backupPath: latestBackup,
  }
}

/**
 * Roll back / restore `profiles.json` from SQLite (`legacy_profiles` + current `profiles`), and optionally
 * restore `ap.db` from a pre-migration backup snapshot.
 */
export async function rollbackSqliteToJson(
  dir: string,
  opts: { backupFile?: string; restoreDbBackup?: boolean; log?: (msg: string) => void } = {},
): Promise<RollbackReport> {
  const cfg = NET.store
  const sqlitePath = join(dir, cfg.sqliteFile)
  const jsonPath = join(dir, cfg.file)
  const backupDir = join(dir, cfg.backupDir)

  if (!existsSync(sqlitePath)) {
    return { ok: false, restoredProfiles: 0, jsonPath, restoredDbFrom: null }
  }

  const conn = new DatabaseSync(sqlitePath, { timeout: 5000 })
  conn.exec(SCHEMA_SQL)
  const restored: Record<string, StoredProfile> = {}

  const legacyRows = conn.prepare('SELECT id, raw_json FROM legacy_profiles').all()
  for (const r of legacyRows) {
    if (typeof r.id !== 'string' || typeof r.raw_json !== 'string') continue
    const sp = parseStoredProfileRecord(safeJsonParse(r.raw_json))
    if (sp) restored[r.id] = sp
  }

  const currentRows = conn.prepare('SELECT id, profile_json, pvp_wins, pvp_losses, trades, first_seen, last_seen, max_distance FROM profiles').all()
  for (const r of currentRows) {
    if (typeof r.id !== 'string' || typeof r.profile_json !== 'string') continue
    if (restored[r.id]) continue
    const pub = parsePublicProfile(safeJsonParse(r.profile_json))
    if (!pub) continue
    const pvpWins = typeof r.pvp_wins === 'number' ? r.pvp_wins : 0
    const pvpLosses = typeof r.pvp_losses === 'number' ? r.pvp_losses : 0
    const maxDistance = typeof r.max_distance === 'number' ? r.max_distance : 0
    restored[r.id] = {
      profile: { ...pub, id: r.id, pvpWins, pvpLosses },
      pvpWins,
      pvpLosses,
      trades: typeof r.trades === 'number' ? r.trades : 0,
      firstSeen: typeof r.first_seen === 'number' ? r.first_seen : 0,
      lastSeen: typeof r.last_seen === 'number' ? r.last_seen : 0,
      ...(maxDistance > 0 ? { maxDistance } : {}),
    }
  }
  conn.close()

  const payload: ProfilesFile = { version: cfg.version, profiles: restored }
  const tmp = `${jsonPath}.${process.pid}.${Date.now()}.rollback.tmp`
  await mkdir(dir, { recursive: true })
  await writeFile(tmp, JSON.stringify(payload))
  await rename(tmp, jsonPath)

  let restoredDbFrom: string | null = null
  let candidateBackup = opts.backupFile ?? null
  if (!candidateBackup && opts.restoreDbBackup && existsSync(backupDir)) {
    const files = readdirSync(backupDir).filter((f) => f.startsWith('pre-legacy-import-') && f.endsWith('.db')).sort()
    if (files.length > 0) candidateBackup = join(backupDir, files[files.length - 1])
  }
  if (candidateBackup && existsSync(candidateBackup)) {
    copyFileSync(candidateBackup, sqlitePath)
    restoredDbFrom = candidateBackup
  }

  return {
    ok: true,
    restoredProfiles: Object.keys(restored).length,
    jsonPath,
    restoredDbFrom,
  }
}
