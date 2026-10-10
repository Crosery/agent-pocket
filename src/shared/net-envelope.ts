// Isomorphic wire envelope signing and monotonic sliding-window replay protection.
// Pure TypeScript and standard WebCrypto (globalThis.crypto.subtle); zero external or Node dependencies.
import type { ClientMsg } from './protocol.ts'

const encoder = new TextEncoder()

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

/** Constant-time string comparison so signature checks never leak prefix length via timing. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Deterministic JSON serialization with lexicographically sorted keys and omitted undefined properties. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`
}

export function payloadWithoutEnvelopeSig(msg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(msg)) {
    if (k === 'sig' || v === undefined) continue
    out[k] = v
  }
  return out
}

const subtleKeyCache = new Map<string, Promise<CryptoKey>>()

function getWebCryptoHmacKey(key: string): Promise<CryptoKey> {
  let p = subtleKeyCache.get(key)
  if (!p) {
    p = globalThis.crypto.subtle.importKey(
      'raw',
      encoder.encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )
    subtleKeyCache.set(key, p)
  }
  return p
}

export async function hmacSha256WebCrypto(key: string, data: string): Promise<string> {
  const cryptoKey = await getWebCryptoHmacKey(key)
  const sigBuf = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
  return bytesToHex(new Uint8Array(sigBuf))
}

export async function computeEnvelopeSig(sessionKey: string, msg: Record<string, unknown>, authSeq: number): Promise<string> {
  const clean = payloadWithoutEnvelopeSig({ ...msg, authSeq })
  return hmacSha256WebCrypto(sessionKey, `${authSeq}:${canonicalJson(clean)}`)
}

export async function signEnvelope<T extends ClientMsg>(
  sessionKey: string,
  msg: T,
  authSeq: number,
): Promise<T & { authSeq: number; sig: string }>
export async function signEnvelope<T extends Record<string, unknown>>(
  sessionKey: string,
  msg: T,
  authSeq: number,
): Promise<T & { authSeq: number; sig: string }>
export async function signEnvelope<T extends object>(
  sessionKey: string,
  msg: T,
  authSeq: number,
): Promise<T & { authSeq: number; sig: string }> {
  const raw = msg as unknown as Record<string, unknown>
  const sig = await computeEnvelopeSig(sessionKey, raw, authSeq)
  return { ...msg, authSeq, sig }
}

export interface ReplayWindow {
  readonly maxSeq: number
  checkAndRecord(seq: unknown):
    | { ok: true; seq: number }
    | { ok: false; code: 'bad_sequence' | 'replay_detected'; reason: string }
  reset(): void
}

/**
 * Monotonic sliding-window replay detector.
 * Accepts integer `seq >= 1` within `(maxSeq - windowSize, maxSeq + maxJump]` that has not been seen before.
 */
export function createReplayWindow(windowSize = 64, maxJump = 10000): ReplayWindow {
  const size = Math.max(1, Math.min(64, Math.floor(windowSize)))
  const maskAll = (1n << BigInt(size)) - 1n
  let maxSeq = 0
  let bitmap = 0n

  return {
    get maxSeq() { return maxSeq },
    checkAndRecord(seq: unknown) {
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
        return { ok: false, code: 'bad_sequence', reason: 'non_positive_or_non_integer_seq' }
      }
      if (seq > maxSeq + maxJump) {
        return { ok: false, code: 'bad_sequence', reason: 'seq_jump_exceeded' }
      }
      if (seq > maxSeq) {
        const shift = seq - maxSeq
        bitmap = shift >= size ? 1n : ((bitmap << BigInt(shift)) | 1n) & maskAll
        maxSeq = seq
        return { ok: true, seq }
      }
      const offset = maxSeq - seq
      if (offset >= size) {
        return { ok: false, code: 'replay_detected', reason: 'seq_outside_window' }
      }
      const bit = 1n << BigInt(offset)
      if ((bitmap & bit) !== 0n) {
        return { ok: false, code: 'replay_detected', reason: 'duplicate_seq' }
      }
      bitmap |= bit
      return { ok: true, seq }
    },
    reset() {
      maxSeq = 0
      bitmap = 0n
    },
  }
}
