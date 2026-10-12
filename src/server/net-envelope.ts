// Server-only wire envelope verification using node:crypto for high performance.
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  canonicalJson,
  createReplayWindow,
  payloadWithoutEnvelopeSig,
  type ReplayWindow,
} from '../shared/net-envelope.ts'

export { canonicalJson, createReplayWindow, payloadWithoutEnvelopeSig, type ReplayWindow }

export function hmacSha256HexNode(key: string, message: string): string {
  return createHmac('sha256', key).update(message).digest('hex')
}

export function computeEnvelopeSigNode(sessionKey: string, msg: Record<string, unknown>, authSeq: number): string {
  const clean = payloadWithoutEnvelopeSig({ ...msg, authSeq })
  return hmacSha256HexNode(sessionKey, `${authSeq}:${canonicalJson(clean)}`)
}

export function signEnvelopeNode<T extends object>(
  sessionKey: string,
  msg: T,
  authSeq: number,
): T & { authSeq: number; sig: string } {
  const raw = msg as unknown as Record<string, unknown>
  const sig = computeEnvelopeSigNode(sessionKey, raw, authSeq)
  return { ...msg, authSeq, sig }
}

export function timingSafeEqualNode(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export type EnvelopeVerifyResult =
  | { ok: true; authSeq?: number }
  | { ok: false; code: 'bad_signature' | 'replay_detected' | 'bad_sequence'; reason: string }

/**
 * Verifies an inbound client message envelope on the server.
 * - hello and ping are handshake/keepalive frames and bypass session signature checks.
 * - authSeq is the distinct monotonic envelope sequence for signed frames (never colliding with move.seq).
 * - When requireSig is true or raw.sig is present, verifies raw.sig against sessionKey and raw.authSeq.
 * - When raw.authSeq is present (or requireSig is true), checks and records raw.authSeq in window.
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
    const expected = computeEnvelopeSigNode(sessionKey, raw, raw.authSeq)
    if (!timingSafeEqualNode(raw.sig.toLowerCase(), expected.toLowerCase())) {
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
