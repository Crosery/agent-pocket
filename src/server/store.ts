// Persistent player profiles + stats (data/server/profiles.json). Writes are debounced and atomic
// (temp file + rename) so a crash never leaves a truncated file behind.
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { LeaderboardEntry, PublicProfile } from '../shared/protocol.ts'
import { NET, type LeaderboardSortKey } from './config.ts'

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

interface ProfilesFile { version: number; profiles: Record<string, StoredProfile> }

export interface ProfileStore {
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

export interface StoreOptions { dir: string; log?: (msg: string) => void }

const entryOf = (s: StoredProfile): LeaderboardEntry => ({
  id: s.profile.id,
  name: s.profile.name,
  avatar: s.profile.avatar,
  dexCaught: s.profile.dexCaught,
  badges: s.profile.badges.length,
  pvpWins: s.pvpWins,
  pvpLosses: s.pvpLosses,
  maxDistance: s.maxDistance ?? 0,
})

export function compareEntries(sortBy: readonly LeaderboardSortKey[]) {
  return (a: LeaderboardEntry, b: LeaderboardEntry): number => {
    for (const k of sortBy) {
      // Losses rank ascending (fewer is better); every other key ranks descending.
      const av = a[k] ?? 0, bv = b[k] ?? 0
      const d = k === 'pvpLosses' ? av - bv : bv - av
      if (d !== 0) return d
    }
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  }
}

export function createProfileStore(opts: StoreOptions): ProfileStore {
  const cfg = NET.store
  const file = join(opts.dir, cfg.file)
  const log = opts.log ?? (() => {})
  const profiles = new Map<string, StoredProfile>()
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> | null = null
  let board: LeaderboardEntry[] | null = null
  let closed = false

  const invalidate = () => { board = null }

  const schedule = () => {
    dirty = true
    invalidate()
    if (closed || timer) return
    timer = setTimeout(() => { timer = null; void persist() }, cfg.debounceMs)
    timer.unref?.()
  }

  const evictIfNeeded = () => {
    if (profiles.size <= cfg.maxProfiles) return
    const oldest = [...profiles.values()].sort((a, b) => a.lastSeen - b.lastSeen)
    for (const p of oldest.slice(0, profiles.size - cfg.maxProfiles)) profiles.delete(p.profile.id)
  }

  async function writeOnce(): Promise<boolean> {
    dirty = false
    const data: ProfilesFile = { version: cfg.version, profiles: Object.fromEntries(profiles) }
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await mkdir(opts.dir, { recursive: true })
      await writeFile(tmp, JSON.stringify(data))
      await rename(tmp, file)
      return true
    } catch (err) {
      dirty = true
      await unlink(tmp).catch(() => {})
      log(`profile store write failed: ${(err as Error).message}`)
      return false
    }
  }

  /** Writes until clean; a failed write is retried by the debounce timer instead of spinning. */
  async function persist(): Promise<void> {
    for (;;) {
      if (writing) { await writing; continue }
      if (!dirty) return
      let ok = true
      writing = writeOnce().then((r) => { ok = r }).finally(() => { writing = null })
      await writing
      if (!ok) { if (!closed) schedule(); return }
    }
  }

  return {
    async load() {
      let raw: string
      try { raw = await readFile(file, 'utf8') } catch { return }
      try {
        const data = JSON.parse(raw) as ProfilesFile
        for (const [id, p] of Object.entries(data.profiles ?? {})) {
          if (p && p.profile && typeof p.profile.id === 'string') profiles.set(id, p)
        }
      } catch (err) {
        const aside = `${file}.corrupt-${Date.now()}`
        await rename(file, aside).catch(() => {})
        log(`profile store unreadable (${(err as Error).message}); moved to ${aside}`)
      }
      invalidate()
    },
    get: (id) => profiles.get(id),
    publicProfile(id) {
      const s = profiles.get(id)
      return s ? { ...s.profile, pvpWins: s.pvpWins, pvpLosses: s.pvpLosses, maxDistance: s.maxDistance ?? 0 } : undefined
    },
    put(profile, now = Date.now()) {
      const prev = profiles.get(profile.id)
      profiles.set(profile.id, {
        profile: { ...profile, pvpWins: prev?.pvpWins ?? 0, pvpLosses: prev?.pvpLosses ?? 0 },
        pvpWins: prev?.pvpWins ?? 0,
        pvpLosses: prev?.pvpLosses ?? 0,
        trades: prev?.trades ?? 0,
        firstSeen: prev?.firstSeen ?? now,
        lastSeen: now,
        ...(prev?.maxDistance !== undefined ? { maxDistance: prev.maxDistance } : {}),
      })
      evictIfNeeded()
      schedule()
    },
    touch(id, now = Date.now()) {
      const s = profiles.get(id)
      if (s) { s.lastSeen = now; schedule() }
    },
    recordPvp(winnerId, loserId) {
      const w = winnerId ? profiles.get(winnerId) : undefined
      const l = loserId ? profiles.get(loserId) : undefined
      if (w) { w.pvpWins++; w.profile.pvpWins = w.pvpWins }
      if (l) { l.pvpLosses++; l.profile.pvpLosses = l.pvpLosses }
      if (w || l) schedule()
    },
    recordTrade(id) {
      const s = profiles.get(id)
      if (s) { s.trades++; schedule() }
    },
    recordDistance(id, tiles) {
      const s = profiles.get(id)
      if (!s || !Number.isFinite(tiles) || tiles <= (s.maxDistance ?? 0)) return
      s.maxDistance = Math.floor(tiles)
      schedule()
    },
    leaderboard(limit = NET.leaderboard.size) {
      if (!board) board = [...profiles.values()].map(entryOf).sort(compareEntries(NET.leaderboard.sortBy))
      return board.slice(0, limit)
    },
    size: () => profiles.size,
    async flush() {
      if (timer) { clearTimeout(timer); timer = null }
      await persist()
    },
    async close() {
      closed = true
      if (timer) { clearTimeout(timer); timer = null }
      await persist()
    },
  }
}
