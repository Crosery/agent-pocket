// Pure core of the world editor (ADR 0002 §3.3): RFC 6902 patches (add / remove / replace) with inverses for undo,
// and the edit operations expressed as patches against the template JSON, in template coordinates.
import { toTemplate, type ProvEntry, type ProvRegion, type ProvTransform } from '../world/provenance.ts'

export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }

export class PatchError extends Error {
  constructor(message: string) { super(message); this.name = 'PatchError' }
}

const unescape = (seg: string): string => seg.replace(/~1/g, '/').replace(/~0/g, '~')
export const escapePointer = (seg: string): string => seg.replace(/~/g, '~0').replace(/\//g, '~1')
const split = (path: string): string[] => {
  if (path === '') return []
  if (!path.startsWith('/')) throw new PatchError(`bad pointer ${path}`)
  return path.slice(1).split('/').map(unescape)
}

type Container = Record<string, unknown> | unknown[]

function walk(doc: unknown, segs: string[], path: string): Container {
  let cur: unknown = doc
  for (const s of segs) {
    if (Array.isArray(cur)) cur = cur[Number(s)]
    else if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[s]
    else throw new PatchError(`no such path ${path}`)
    if (cur === undefined) throw new PatchError(`no such path ${path}`)
  }
  if (!cur || typeof cur !== 'object') throw new PatchError(`no such path ${path}`)
  return cur as Container
}

const index = (arr: unknown[], key: string, path: string, allowEnd: boolean): number => {
  if (key === '-' && allowEnd) return arr.length
  const i = Number(key)
  if (!Number.isInteger(i) || i < 0 || i > arr.length || (!allowEnd && i === arr.length)) throw new PatchError(`bad index in ${path}`)
  return i
}

export function getAt(doc: unknown, path: string): unknown {
  const segs = split(path)
  if (!segs.length) return doc
  const parent = walk(doc, segs.slice(0, -1), path)
  const key = segs[segs.length - 1]
  const v = Array.isArray(parent) ? parent[Number(key)] : (parent as Record<string, unknown>)[key]
  if (v === undefined) throw new PatchError(`no such path ${path}`)
  return v
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Applies `ops` to `doc` in place and returns the inverse patch (apply it to undo). Throws PatchError, leaving `doc` as it was. */
export function applyPatch(doc: unknown, ops: readonly PatchOp[]): PatchOp[] {
  const inverse: PatchOp[] = []
  try {
    for (const op of ops) {
      const segs = split(op.path)
      if (!segs.length) throw new PatchError('the document root cannot be patched')
      const parent = walk(doc, segs.slice(0, -1), op.path)
      const key = segs[segs.length - 1]
      if (Array.isArray(parent)) {
        if (op.op === 'add') {
          const i = index(parent, key, op.path, true)
          parent.splice(i, 0, clone(op.value))
          inverse.unshift({ op: 'remove', path: `${segs.slice(0, -1).map((s) => `/${escapePointer(s)}`).join('')}/${i}` })
        } else {
          const i = index(parent, key, op.path, false)
          const old = parent[i]
          if (op.op === 'remove') { parent.splice(i, 1); inverse.unshift({ op: 'add', path: op.path, value: old }) } else { parent[i] = clone(op.value); inverse.unshift({ op: 'replace', path: op.path, value: old }) }
        }
      } else {
        const obj = parent as Record<string, unknown>
        const has = key in obj
        if (op.op === 'add') {
          const old = obj[key]
          obj[key] = clone(op.value)
          inverse.unshift(has ? { op: 'replace', path: op.path, value: old } : { op: 'remove', path: op.path })
        } else {
          if (!has) throw new PatchError(`no such path ${op.path}`)
          const old = obj[key]
          if (op.op === 'remove') { delete obj[key]; inverse.unshift({ op: 'add', path: op.path, value: old }) } else { obj[key] = clone(op.value); inverse.unshift({ op: 'replace', path: op.path, value: old }) }
        }
      }
    }
  } catch (err) {
    if (inverse.length) applyPatch(doc, inverse)
    throw err
  }
  return inverse
}

// ----------------------------------------------------------------------------- edit operations

export type EditableKind = ProvEntry['kind']

/** Buildings always face south; signs and anchors have no rotation. */
export const canRotate = (e: ProvEntry): boolean => e.kind === 'prop'

const rotMirror = (r: number): number => (r === 1 ? 3 : r === 3 ? 1 : r)
export type FootprintFn = (prop: string, rot: number) => [number, number]

/** Moves the object so that its footprint's top-left lands on map tile (x, y). */
export function moveOps(e: ProvEntry, x: number, y: number): PatchOp[] {
  const to = toTemplate(e.transform, x, y)
  if (e.kind === 'anchor') return [{ op: 'replace', path: e.pointer, value: [to.x, to.y] }]
  return [{ op: 'replace', path: `${e.pointer}/x`, value: to.x }, { op: 'replace', path: `${e.pointer}/y`, value: to.y }]
}

/** Turns a prop one quarter (counter-clockwise) keeping its footprint's top-left tile where it is. */
export function rotateOps(e: ProvEntry, size: FootprintFn): PatchOp[] {
  if (e.kind !== 'prop') throw new PatchError('only props rotate')
  const rot = (e.rot + 1) % 4
  const fw = size(e.label, rot)[0]
  const to = toTemplate({ ...e.transform, fw }, e.x, e.y)
  const baseRot = e.transform.mirror ? rotMirror(rot) : rot
  return [
    { op: 'add', path: `${e.pointer}/rot`, value: baseRot },
    { op: 'replace', path: `${e.pointer}/x`, value: to.x },
    { op: 'replace', path: `${e.pointer}/y`, value: to.y },
  ]
}

export function deleteOps(e: ProvEntry): PatchOp[] {
  return [{ op: 'remove', path: e.pointer }]
}

/** Adds a prop whose footprint's top-left lands on map tile (x, y) inside `region`. */
export function placeOps(region: ProvRegion, prop: string, x: number, y: number, rot: number, size: FootprintFn): PatchOp[] {
  const fw = size(prop, rot)[0]
  const t: ProvTransform = { ox: region.x, oy: region.y, mirror: region.mirror, tw: region.w, fw }
  const to = toTemplate(t, x, y)
  const baseRot = region.mirror ? rotMirror(rot) : rot
  return [{ op: 'add', path: `/templates/${escapePointer(region.template)}/props/-`, value: { prop, x: to.x, y: to.y, ...(baseRot ? { rot: baseRot } : {}) } }]
}

/** The region a map tile lies in, if any (smallest rectangle wins). */
export function regionAt(regions: readonly ProvRegion[], map: string, x: number, y: number): ProvRegion | null {
  let best: ProvRegion | null = null
  for (const r of regions) {
    if (r.map !== map || x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) continue
    if (!best || r.w * r.h < best.w * best.h) best = r
  }
  return best
}

/** The recorded object whose footprint covers a map tile (topmost: smallest footprint, props over buildings). */
export function entryAt(entries: readonly ProvEntry[], map: string, x: number, y: number): ProvEntry | null {
  let best: ProvEntry | null = null
  for (const e of entries) {
    if (e.map !== map || x < e.x || y < e.y || x >= e.x + e.w || y >= e.y + e.h) continue
    if (!best || e.w * e.h < best.w * best.h) best = e
  }
  return best
}

/** Problems that exist after an edit and did not exist before it (multiset difference), plus the count rule of the ADR. */
export function newProblems(before: readonly string[], after: readonly string[]): string[] {
  const left = new Map<string, number>()
  for (const p of before) left.set(p, (left.get(p) ?? 0) + 1)
  const fresh: string[] = []
  for (const p of after) {
    const n = left.get(p) ?? 0
    if (n > 0) left.set(p, n - 1)
    else fresh.push(p)
  }
  return fresh
}
