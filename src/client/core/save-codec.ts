// Portable save codes: "<version>.<base64url(utf8 JSON)>.<checksum>". Pure, works in browsers and Node.
import { hmacSha256Hex, timingSafeEqualStr } from '../../shared/net-envelope.ts'
import { hashString } from './hash.ts'

const SAVE_CODE_HMAC_KEY = 'agent-pocket/save-code-v1'
export function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(code: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(code)) return null
  try {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (code.length % 4)) % 4)
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function checksum(payload: string): string {
  return hashString(payload).toString(16).padStart(8, '0')
}

export function encodeSaveCode(data: unknown, version: number): string {
  const payload = toBase64Url(JSON.stringify(data))
  return `${version}.${payload}.${checksum(payload)}`
}

/** Returns the parsed JSON value, or null when the code is malformed or its checksum does not match. */
/** Returns the parsed JSON value, or null when the code is malformed or its checksum/signature does not match. */
export function decodeSaveCode(code: string, secret = SAVE_CODE_HMAC_KEY): { version: number; data: unknown; signed?: boolean } | null {
  const parts = code.replace(/\s+/g, '').split('.')
  if (parts.length !== 3 && parts.length !== 4) return null
  const [ver, payload, sum, sig] = parts
  if (!/^\d+$/.test(ver) || !payload || checksum(payload) !== sum.toLowerCase()) return null
  if (sig !== undefined) {
    const expected = hmacSha256Hex(secret, `${ver}.${payload}.${sum.toLowerCase()}`)
    if (!timingSafeEqualStr(sig.toLowerCase(), expected)) return null
  }
  const json = fromBase64Url(payload)
  if (json === null) return null
  try {
    return { version: Number(ver), data: JSON.parse(json) as unknown, ...(sig !== undefined ? { signed: true } : {}) }
  } catch {
    return null
  }
}

export function encodeSignedSaveCode(data: unknown, version: number, secret = SAVE_CODE_HMAC_KEY): string {
  const base = encodeSaveCode(data, version)
  const sig = hmacSha256Hex(secret, base)
  return `${base}.${sig}`
}
