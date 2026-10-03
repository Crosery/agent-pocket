// Small generic helpers shared by the server modules (no game data here).
import { createHash, randomUUID } from 'node:crypto'
import type { Dir } from '../shared/types.ts'
import type { Rate } from './config.ts'

const DIRS: readonly Dir[] = ['down', 'left', 'right', 'up']

export const isDir = (v: unknown): v is Dir => typeof v === 'string' && (DIRS as readonly string[]).includes(v)

/** Token bucket: `count` burst, refilled at count/perSeconds tokens per second. */
export interface RateLimiter {
  /** Takes `n` tokens (default 1) or none at all. */
  take(now?: number, n?: number): boolean
  /** Tokens currently available (for diagnostics/tests). */
  available(now?: number): number
}

export function createRateLimiter(rate: Rate): RateLimiter {
  const capacity = rate.count
  const perMs = rate.count / (rate.perSeconds * 1000)
  let tokens = capacity
  let last = Date.now()
  const refill = (now: number) => {
    if (now > last) { tokens = Math.min(capacity, tokens + (now - last) * perMs); last = now }
  }
  return {
    take(now = Date.now(), n = 1) {
      refill(now)
      if (tokens < n) return false
      tokens -= n
      return true
    },
    available(now = Date.now()) { refill(now); return tokens },
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v)

/** Integer clamp for untrusted numbers; non-numbers become `fallback`. */
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (!isFiniteNumber(v)) return fallback
  return clamp(Math.trunc(v), min, max)
}

/** Truncate by code points (never splits a surrogate pair). */
export function truncateCodePoints(s: string, max: number): string {
  const cps = [...s]
  return cps.length <= max ? s : cps.slice(0, max).join('')
}

export const codePointLength = (s: string): number => [...s].length

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

export const isUuidLike = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

export const newSecretId = (): string => randomUUID()

/**
 * Public player id derived from the client's private playerId. The private id is what the client
 * persists; every other client only ever sees this hash, so a broadcast id cannot be replayed in a
 * hello to impersonate (and kick) its owner.
 */
export function publicIdFor(secret: string): string {
  const h = createHash('sha256').update(`agent-pocket/player/${secret.toLowerCase().replace(/-/g, '')}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** Short opaque id for trades and similar sessions. */
export const newSessionId = (): string => randomUUID()

export function safeJsonParse(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return undefined }
}

export function stableStringArray(v: unknown, maxItems: number, maxLen: number, pattern: RegExp): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of v) {
    if (out.length >= maxItems) break
    if (typeof x !== 'string' || x.length === 0 || x.length > maxLen || !pattern.test(x) || seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

export const ID_TOKEN_RE = /^[A-Za-z0-9_.:-]+$/
