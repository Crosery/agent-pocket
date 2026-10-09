// Pure helpers over JSON-like state: canonical form, digest, JSON-pointer lookup, leaf diff and matchers.
// No DOM and no game imports, so Node tests can use them directly.

export interface DiffOp { op: 'add' | 'remove' | 'replace'; path: string; before?: unknown; after?: unknown }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Same value with object keys sorted, undefined dropped and non-finite numbers as null (JSON-safe, order-independent). */
export function canonical(v: unknown): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canonical(x)))
  if (isObj(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined && typeof v[k] !== 'function') out[k] = canonical(v[k])
    return out
  }
  return v === undefined || typeof v === 'function' ? null : v
}

export const canonicalJson = (v: unknown): string => JSON.stringify(canonical(v))

/** 53-bit string hash (cyrb53) as 14 hex digits. */
export function digest(v: unknown): string {
  const s = canonicalJson(v)
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1')
const unesc = (k: string) => k.replace(/~1/g, '/').replace(/~0/g, '~')

export const pointer = (...keys: (string | number)[]): string => keys.map((k) => `/${esc(String(k))}`).join('')

/** Value at an RFC 6901 pointer ('' = the document itself). */
export function getPointer(doc: unknown, ptr: string): { found: boolean; value?: unknown } {
  if (ptr === '') return { found: true, value: doc }
  if (!ptr.startsWith('/')) return { found: false }
  let cur: unknown = doc
  for (const raw of ptr.slice(1).split('/')) {
    const k = unesc(raw)
    if (Array.isArray(cur)) {
      const i = /^\d+$/.test(k) ? Number(k) : -1
      if (i < 0 || i >= cur.length) return { found: false }
      cur = cur[i]
    } else if (isObj(cur) && Object.hasOwn(cur, k)) cur = cur[k]
    else return { found: false }
  }
  return { found: true, value: cur }
}

/** Leaf-level differences between two states. Arrays of equal length compare per index, others as a whole. */
export function diff(a: unknown, b: unknown, at = ''): DiffOp[] {
  const A = canonical(a), B = canonical(b)
  const out: DiffOp[] = []
  walk(A, B, at, out)
  return out
}

function walk(a: unknown, b: unknown, path: string, out: DiffOp[]): void {
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) {
      if (!Object.hasOwn(b, k)) out.push({ op: 'remove', path: `${path}/${esc(k)}`, before: a[k] })
      else walk(a[k], b[k], `${path}/${esc(k)}`, out)
    }
    for (const k of Object.keys(b)) if (!Object.hasOwn(a, k)) out.push({ op: 'add', path: `${path}/${esc(k)}`, after: b[k] })
    return
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${path}/${i}`, out)
    return
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ op: 'replace', path, before: a, after: b })
}

/** One operator per matcher; a bare value means eq. */
export type Matcher =
  | { eq: unknown } | { ne: unknown }
  | { gt: number } | { gte: number } | { lt: number } | { lte: number }
  | { in: unknown[] } | { includes: unknown } | { length: number }
  | { match: string } | { exists: boolean }

const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'includes', 'length', 'match', 'exists'] as const

export function describeMatcher(m: unknown): string {
  return isObj(m) && OPS.some((k) => k in m) ? JSON.stringify(m) : JSON.stringify({ eq: m })
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)

/** Does `value` (found = it exists) satisfy the matcher? */
export function matches(found: boolean, value: unknown, matcher: unknown): boolean {
  const m = isObj(matcher) && OPS.some((k) => k in matcher) ? matcher : { eq: matcher }
  if ('exists' in m) return found === (m.exists === true)
  if (!found) return false
  if ('eq' in m) return same(value, m.eq)
  if ('ne' in m) return !same(value, m.ne)
  const num = typeof value === 'number' ? value : NaN
  if ('gt' in m) return num > Number(m.gt)
  if ('gte' in m) return num >= Number(m.gte)
  if ('lt' in m) return num < Number(m.lt)
  if ('lte' in m) return num <= Number(m.lte)
  if ('in' in m) return Array.isArray(m.in) && m.in.some((x) => same(x, value))
  if ('includes' in m) return Array.isArray(value) ? value.some((x) => same(x, m.includes)) : typeof value === 'string' && value.includes(String(m.includes))
  if ('length' in m) return (Array.isArray(value) || typeof value === 'string') && value.length === m.length
  if ('match' in m) return typeof value === 'string' && new RegExp(String(m.match)).test(value)
  return false
}

/** True when every key of `partial` appears in `payload` with an equal value (recursively for objects). */
export function partialMatch(payload: unknown, partial: unknown): boolean {
  if (isObj(partial)) return isObj(payload) && Object.keys(partial).every((k) => partialMatch(payload[k], partial[k]))
  return same(payload, partial)
}
