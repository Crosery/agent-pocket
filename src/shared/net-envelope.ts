// Isomorphic wire envelope signing (RFC 2104 HMAC-SHA256) and monotonic sliding-window replay protection.
// Pure TypeScript with zero DOM or Node dependencies so both src/client/net and src/server share the exact math.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const encoder = new TextEncoder()

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

export function sha256Bytes(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8
  const padLen = ((data.length + 9 + 63) & ~63)
  const buf = new Uint8Array(padLen)
  buf.set(data)
  buf[data.length] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(padLen - 4, bitLen >>> 0, false)

  let h0 = H0[0], h1 = H0[1], h2 = H0[2], h3 = H0[3]
  let h4 = H0[4], h5 = H0[5], h6 = H0[6], h7 = H0[7]
  const w = new Uint32Array(64)

  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, h0, false); outView.setUint32(4, h1, false)
  outView.setUint32(8, h2, false); outView.setUint32(12, h3, false)
  outView.setUint32(16, h4, false); outView.setUint32(20, h5, false)
  outView.setUint32(24, h6, false); outView.setUint32(28, h7, false)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256Bytes(encoder.encode(text)))
}

export function hmacSha256Hex(key: string | Uint8Array, message: string): string {
  let k = typeof key === 'string' ? encoder.encode(key) : key
  if (k.length > 64) k = sha256Bytes(k)
  const ipad = new Uint8Array(64)
  const opad = new Uint8Array(64)
  for (let i = 0; i < 64; i++) {
    const b = i < k.length ? k[i] : 0
    ipad[i] = b ^ 0x36
    opad[i] = b ^ 0x5c
  }
  const msgBytes = encoder.encode(message)
  const innerInput = new Uint8Array(64 + msgBytes.length)
  innerInput.set(ipad, 0)
  innerInput.set(msgBytes, 64)
  const innerHash = sha256Bytes(innerInput)

  const outerInput = new Uint8Array(64 + 32)
  outerInput.set(opad, 0)
  outerInput.set(innerHash, 64)
  return bytesToHex(sha256Bytes(outerInput))
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

export function computeEnvelopeSig(sessionKey: string, msg: Record<string, unknown>, seq: number): string {
  const clean = payloadWithoutEnvelopeSig({ ...msg, seq })
  return hmacSha256Hex(sessionKey, `${seq}:${canonicalJson(clean)}`)
}

export function signEnvelope<T extends Record<string, unknown>>(
  sessionKey: string,
  msg: T,
  seq: number,
): T & { seq: number; sig: string } {
  const sig = computeEnvelopeSig(sessionKey, msg, seq)
  return { ...msg, seq, sig }
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
  | { ok: true; seq?: number }
  | { ok: false; code: 'bad_signature' | 'replay_detected' | 'bad_sequence'; reason: string }

/**
 * Verifies an inbound client message envelope.
 * - `hello` and `ping` are handshake/keepalive frames and bypass session signature checks.
 * - When `requireSig` is true or `raw.sig` is present, verifies `raw.sig` against `sessionKey` and `raw.seq`.
 * - When `raw.seq` is present (or `requireSig` is true), checks and records `raw.seq` in `window`.
 */
export function verifyEnvelope(
  sessionKey: string,
  raw: Record<string, unknown>,
  window: ReplayWindow,
  opts: { requireSig?: boolean } = {},
): EnvelopeVerifyResult {
  if (raw.t === 'hello' || raw.t === 'ping') return { ok: true }
  const hasSig = raw.sig !== undefined
  const hasSeq = raw.seq !== undefined
  const mustSign = opts.requireSig === true || hasSig

  if (mustSign) {
    if (typeof raw.sig !== 'string' || !raw.sig) {
      return { ok: false, code: 'bad_signature', reason: 'missing_signature' }
    }
    if (typeof raw.seq !== 'number' || !Number.isSafeInteger(raw.seq) || raw.seq < 1) {
      return { ok: false, code: 'bad_signature', reason: 'missing_seq_for_signature' }
    }
    if (!sessionKey) {
      return { ok: false, code: 'bad_signature', reason: 'session_key_unavailable' }
    }
    const expected = computeEnvelopeSig(sessionKey, raw, raw.seq)
    if (!timingSafeEqualStr(raw.sig.toLowerCase(), expected)) {
      return { ok: false, code: 'bad_signature', reason: 'hmac_mismatch' }
    }
  }

  if (mustSign || hasSeq) {
    const seqRes = window.checkAndRecord(raw.seq)
    if (!seqRes.ok) return seqRes
    return { ok: true, seq: seqRes.seq }
  }

  return { ok: true }
}
