// Wire envelope signing (RFC 2104 HMAC-SHA256) and monotonic sliding-window replay protection.
// Uses platform node:crypto when in Node/server environment and WebCrypto (globalThis.crypto.subtle)
// when in browser / Web environment with zero external npm dependencies.
import * as nodeCrypto from 'node:crypto'

const encoder = new TextEncoder()

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const len = hex.length
  const out = new Uint8Array(len / 2)
  for (let i = 0; i < len; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return out
}

/** Computes SHA256 hex digest synchronously via node:crypto or cached crypto. */
export function sha256Hex(text: string): string {
  if (typeof nodeCrypto.createHash === 'function') {
    return nodeCrypto.createHash('sha256').update(text).digest('hex')
  }
  // Fallback WebCrypto sync digest is not available natively in browser, but nodeCrypto is available in Node/Bun/Vite SSR
  throw new Error('sha256Hex requires node:crypto or async digest')
}

/** Synchronous HMAC-SHA256 hex using node:crypto (server / tests). */
export function hmacSha256Hex(key: string | Uint8Array, message: string): string {
  if (typeof nodeCrypto.createHmac === 'function') {
    const k = typeof key === 'string' ? key : Buffer.from(key)
    return nodeCrypto.createHmac('sha256', k).update(message).digest('hex')
  }
  throw new Error('hmacSha256Hex requires node:crypto')
}

const subtleCryptoKeyCache = new Map<string, Promise<CryptoKey>>()

function getWebCryptoHmacKey(key: string): Promise<CryptoKey> {
  let p = subtleCryptoKeyCache.get(key)
  if (!p) {
    const rawKey = encoder.encode(key)
    p = globalThis.crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )
    subtleCryptoKeyCache.set(key, p)
  }
  return p
}

/** Asynchronous HMAC-SHA256 hex using WebCrypto subtle (browser client). */
export async function hmacSha256HexAsync(key: string, message: string): Promise<string> {
  if (typeof nodeCrypto.createHmac === 'function') {
    return nodeCrypto.createHmac('sha256', key).update(message).digest('hex')
  }
  const cryptoKey = await getWebCryptoHmacKey(key)
  const sigBuf = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message))
  return bytesToHex(new Uint8Array(sigBuf))
}

/** Constant-time string comparison so signature checks never leak prefix length via timing. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  if (typeof nodeCrypto.timingSafeEqual === 'function') {
    const bufA = Buffer.from(a)
    const bufB = Buffer.from(b)
    if (bufA.length !== bufB.length) return false
    return nodeCrypto.timingSafeEqual(bufA, bufB)
  }
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

export function computeEnvelopeSig(sessionKey: string, msg: Record<string, unknown>, authSeq: number): string {
  const clean = payloadWithoutEnvelopeSig({ ...msg, authSeq })
  return hmacSha256Hex(sessionKey, `${authSeq}:${canonicalJson(clean)}`)
}

export async function computeEnvelopeSigAsync(sessionKey: string, msg: Record<string, unknown>, authSeq: number): Promise<string> {
  const clean = payloadWithoutEnvelopeSig({ ...msg, authSeq })
  return hmacSha256HexAsync(sessionKey, `${authSeq}:${canonicalJson(clean)}`)
}

export function signEnvelope<T extends object>(
  sessionKey: string,
  msg: T,
  authSeq: number,
): T & { authSeq: number; sig: string } {
  const raw = msg as unknown as Record<string, unknown>
  const sig = computeEnvelopeSig(sessionKey, raw, authSeq)
  return { ...msg, authSeq, sig }
}

export async function signEnvelopeAsync<T extends object>(
  sessionKey: string,
  msg: T,
  authSeq: number,
): Promise<T & { authSeq: number; sig: string }> {
  const raw = msg as unknown as Record<string, unknown>
  const sig = await computeEnvelopeSigAsync(sessionKey, raw, authSeq)
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

export type EnvelopeVerifyResult =
  | { ok: true; authSeq?: number }
  | { ok: false; code: 'bad_signature' | 'replay_detected' | 'bad_sequence'; reason: string }

/**
 * Verifies an inbound client message envelope.
 * - `hello` and `ping` are handshake/keepalive frames and bypass session signature checks.
 * - `authSeq` is the distinct monotonic envelope sequence for signed frames (never colliding with `move.seq`).
 * - When `requireSig` is true or `raw.sig` is present, verifies `raw.sig` against `sessionKey` and `raw.authSeq`.
 * - When `raw.authSeq` is present (or `requireSig` is true), checks and records `raw.authSeq` in `window`.
 */
export function verifyEnvelope(
  sessionKey: string,
  raw: Record<string, unknown>,
  window: ReplayWindow,
  opts: { requireSig?: boolean } = {},
): EnvelopeVerifyResult {
  if (raw.t === 'hello' || raw.t === 'ping') return { ok: true }
  const hasSig = raw.sig !== undefined
  const hasAuthSeq = raw.authSeq !== undefined
  const mustSign = opts.requireSig === true || hasSig

  if (mustSign) {
    if (typeof raw.sig !== 'string' || !raw.sig) {
      return { ok: false, code: 'bad_signature', reason: 'missing_signature' }
    }
    if (typeof raw.authSeq !== 'number' || !Number.isSafeInteger(raw.authSeq) || raw.authSeq < 1) {
      return { ok: false, code: 'bad_signature', reason: 'missing_auth_seq_for_signature' }
    }
    if (!sessionKey) {
      return { ok: false, code: 'bad_signature', reason: 'session_key_unavailable' }
    }
    const expected = computeEnvelopeSig(sessionKey, raw, raw.authSeq)
    if (!timingSafeEqualStr(raw.sig.toLowerCase(), expected)) {
      return { ok: false, code: 'bad_signature', reason: 'hmac_mismatch' }
    }
  }

  if (mustSign || hasAuthSeq) {
    const seqRes = window.checkAndRecord(raw.authSeq)
    if (!seqRes.ok) return seqRes
    return { ok: true, authSeq: seqRes.seq }
  }

  return { ok: true }
}
