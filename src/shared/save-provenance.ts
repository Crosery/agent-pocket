// Save integrity & provenance helpers shared by client (localStorage / save codes) and server (import audit).
// Offline/portable signatures detect accidental corruption, version mismatch, and casual hand-edits;
// they never grant online authority (see ADR 0001 §3.5: offline imports are isolated as untrusted).
import type { SaveData } from './types.ts'
import { canonicalJson, timingSafeEqualStr } from './net-envelope.ts'
import { hashString } from './rng.ts'

export type SaveOriginKind = 'offline' | 'imported' | 'online-authoritative'

export interface PortableSignedSave {
  version: number
  origin: SaveOriginKind
  save: SaveData
  sig: string
}

const PORTABLE_DOMAIN_KEY = 'agent-pocket/portable-save-v1'
const LOCAL_SLOT_DOMAIN_KEY = 'agent-pocket/local-slot-v1'

/** Pure synchronous corruption-detection checksum (128-bit hex) with zero platform or crypto dependencies. */
export function portableChecksum(domain: string, payload: string): string {
  const h1 = hashString(`${domain}:p1:${payload}`)
  const h2 = hashString(`${domain}:p2:${payload}`)
  const h3 = hashString(`${domain}:p3:${payload}`)
  const h4 = hashString(`${domain}:p4:${payload}`)
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}${h3.toString(16).padStart(8, '0')}${h4.toString(16).padStart(8, '0')}`
}

export function computeSaveDigest(save: unknown, version: number, domainKey = PORTABLE_DOMAIN_KEY): string {
  return portableChecksum(domainKey, `${version}:${canonicalJson(save)}`)
}

export function signPortableSave(save: SaveData, version = save.version, origin: SaveOriginKind = 'offline'): PortableSignedSave {
  const sig = portableChecksum(PORTABLE_DOMAIN_KEY, `${version}:${origin}:${canonicalJson(save)}`)
  return { version, origin, save, sig }
}

export function verifyPortableSave(
  raw: unknown,
): { ok: true; version: number; origin: SaveOriginKind; save: unknown } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not_an_object' }
  }
  const r = raw as Record<string, unknown>
  if ('sig' in r && 'save' in r) {
    const version = typeof r.version === 'number' && Number.isInteger(r.version) ? r.version : 0
    const origin: SaveOriginKind = r.origin === 'imported' || r.origin === 'online-authoritative' ? r.origin : 'offline'
    if (typeof r.sig !== 'string' || !r.sig) return { ok: false, reason: 'missing_portable_signature' }
    const expected = portableChecksum(PORTABLE_DOMAIN_KEY, `${version}:${origin}:${canonicalJson(r.save)}`)
    if (!timingSafeEqualStr(r.sig.toLowerCase(), expected.toLowerCase())) {
      return { ok: false, reason: 'portable_signature_mismatch' }
    }
    return { ok: true, version, origin, save: r.save }
  }
  if (typeof r.version === 'number' && 'party' in r && 'position' in r) {
    return { ok: true, version: r.version, origin: 'offline', save: r }
  }
  return { ok: false, reason: 'unrecognized_save_shape' }
}

export function signLocalSlotText(rawJsonText: string, slot: number): string {
  try {
    const parsed: unknown = JSON.parse(rawJsonText)
    const ver = typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'number'
      ? parsed.version
      : 0
    return `${ver}.${portableChecksum(LOCAL_SLOT_DOMAIN_KEY, `${slot}:${ver}:${canonicalJson(parsed)}`)}`
  } catch {
    return `0.${portableChecksum(LOCAL_SLOT_DOMAIN_KEY, `${slot}:0:${rawJsonText}`)}`
  }
}

export function verifyLocalSlotText(
  rawJsonText: string | null,
  storedSig: string | null,
  slot: number,
): { valid: boolean; tampered: boolean; reason?: string } {
  if (rawJsonText === null) return { valid: false, tampered: false, reason: 'empty_slot' }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJsonText)
  } catch {
    return { valid: false, tampered: true, reason: 'invalid_json' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, tampered: true, reason: 'not_an_object' }
  }
  if (storedSig === null) {
    return { valid: true, tampered: false, reason: 'unsigned_legacy_slot' }
  }
  const expected = signLocalSlotText(rawJsonText, slot)
  if (!timingSafeEqualStr(storedSig.toLowerCase(), expected.toLowerCase())) {
    return { valid: false, tampered: true, reason: 'slot_signature_mismatch' }
  }
  return { valid: true, tampered: false }
}
