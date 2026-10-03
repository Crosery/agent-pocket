// Procedural nature models: seeded generators (trees, bushes, rocks, crystals, cacti, mushrooms, stumps, logs, card
// clumps) that turn content/render.json "nature.props.<key>.params" into noise-displaced meshes. Every call with a
// different variant index yields a different model, so the overworld never shows one fixed asset per prop. Output
// geometry is in world units (1 = one tile), origin at the footprint centre on the ground, vertex colours carry
// per-cluster shade ratios against the part material's base colour.
import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import type { PropDef } from '../../../shared/types.ts'
import { RENDER, hexToRgb, isHexColor, type NatureMaterial, type NatureProp, type Vec2, type Vec3 } from '../config.ts'
import { createNoise, fbm3, mulberry32, range, seedOf, type Noise } from '../noise.ts'

type V3 = Vec3
type RGB = Vec3

// ---------------------------------------------------------------------------
// Colour helpers (vertex colours are linear-space ratios against the material base colour)
// ---------------------------------------------------------------------------

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
export function linearRgb(hex: string): RGB { const [r, g, b] = hexToRgb(hex); return [lin(r), lin(g), lin(b)] }
/** Linear-space ratio target / base, clamped so near-black base channels cannot explode. */
export function colorRatio(target: string, base: string, max = 12): RGB {
  const t = linearRgb(target), b = linearRgb(base)
  return [Math.min(max, t[0] / Math.max(b[0], 0.004)), Math.min(max, t[1] / Math.max(b[1], 0.004)), Math.min(max, t[2] / Math.max(b[2], 0.004))]
}
const ONE: RGB = [1, 1, 1]
const shadeRgb = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k]

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
/** Direction from yaw (around +Y, 0 = +X) and elevation (deg above horizontal). */
const dirOf = (yaw: number, elevDeg: number): V3 => {
  const e = elevDeg * Math.PI / 180
  return [Math.cos(yaw) * Math.cos(e), Math.sin(e), Math.sin(yaw) * Math.cos(e)]
}
/** Rodrigues rotation of v around unit axis k. */
function rotate(v: V3, k: V3, ang: number): V3 {
  const c = Math.cos(ang), s = Math.sin(ang)
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)))
}
function perp(t: V3): V3 { return norm(Math.abs(t[1]) < 0.9 ? cross(t, [0, 1, 0]) : cross(t, [1, 0, 0])) }

// ---------------------------------------------------------------------------
// Geometry buffer: indexed while building, de-indexed with per-face planar UVs at the end
// ---------------------------------------------------------------------------

export class GeoBuf {
  p: number[] = []
  n: number[] = []
  c: number[] = []
  uv: number[] = []
  i: number[] = []
  get vc() { return this.p.length / 3 }
  get tc() { return this.i.length / 3 }
  vert(p: V3, c: RGB, uv: Vec2 = [0, 0], n: V3 = [0, 0, 0]): number {
    this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.c.push(c[0], c[1], c[2]); this.uv.push(uv[0], uv[1])
    return this.vc - 1
  }
  pos(k: number): V3 { return [this.p[k * 3], this.p[k * 3 + 1], this.p[k * 3 + 2]] }
  /** Triangle; flipped when its normal points away from `expect`. */
  tri(a: number, b: number, c: number, expect?: V3): void {
    if (expect) {
      const pa = this.pos(a), nrm = cross(sub(this.pos(b), pa), sub(this.pos(c), pa))
      if (dot(nrm, expect) < 0) { this.i.push(a, c, b); return }
    }
    this.i.push(a, b, c)
  }
  /** Area-weighted smooth normals for vertices >= fromV using triangles >= fromT. */
  smooth(fromV: number, fromT: number): void {
    for (let k = fromV * 3; k < this.n.length; k++) this.n[k] = 0
    for (let t = fromT * 3; t < this.i.length; t += 3) {
      const a = this.i[t], b = this.i[t + 1], c = this.i[t + 2]
      const pa = this.pos(a), f = cross(sub(this.pos(b), pa), sub(this.pos(c), pa))
      for (const v of [a, b, c]) if (v >= fromV) { this.n[v * 3] += f[0]; this.n[v * 3 + 1] += f[1]; this.n[v * 3 + 2] += f[2] }
    }
    for (let v = fromV; v < this.vc; v++) {
      const k = v * 3, l = Math.hypot(this.n[k], this.n[k + 1], this.n[k + 2]) || 1
      this.n[k] /= l; this.n[k + 1] /= l; this.n[k + 2] /= l
    }
  }
  /** Bends normals of vertices >= fromV toward "away from centre" (soft rounded foliage light). */
  bend(fromV: number, center: V3, k: number): void {
    if (k <= 0) return
    for (let v = fromV; v < this.vc; v++) {
      const d = norm(sub(this.pos(v), center))
      const q = v * 3
      const m = norm(lerp3([this.n[q], this.n[q + 1], this.n[q + 2]], d, k))
      this.n[q] = m[0]; this.n[q + 1] = m[1]; this.n[q + 2] = m[2]
    }
  }
  /** Scales vertex colours of vertices >= fromV. */
  tint(fromV: number, f: (p: V3, n: V3) => RGB): void {
    for (let v = fromV; v < this.vc; v++) {
      const q = v * 3
      const k = f(this.pos(v), [this.n[q], this.n[q + 1], this.n[q + 2]])
      this.c[q] *= k[0]; this.c[q + 1] *= k[1]; this.c[q + 2] *= k[2]
    }
  }
  /** Non-indexed geometry. flat = face normals; planarUv = world-scaled UVs by each face's dominant axis. */
  toGeometry(flat: boolean, planarUv: boolean, uvScale: number): THREE.BufferGeometry {
    const n = this.i.length
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), C = new Float32Array(n * 3), U = new Float32Array(n * 2)
    for (let t = 0; t < n; t += 3) {
      const ids = [this.i[t], this.i[t + 1], this.i[t + 2]]
      const pa = this.pos(ids[0]), f = norm(cross(sub(this.pos(ids[1]), pa), sub(this.pos(ids[2]), pa)))
      const ax = Math.abs(f[0]), ay = Math.abs(f[1]), az = Math.abs(f[2])
      for (let k = 0; k < 3; k++) {
        const v = ids[k], o = (t + k) * 3
        P[o] = this.p[v * 3]; P[o + 1] = this.p[v * 3 + 1]; P[o + 2] = this.p[v * 3 + 2]
        if (flat) { N[o] = f[0]; N[o + 1] = f[1]; N[o + 2] = f[2] } else { N[o] = this.n[v * 3]; N[o + 1] = this.n[v * 3 + 1]; N[o + 2] = this.n[v * 3 + 2] }
        C[o] = this.c[v * 3]; C[o + 1] = this.c[v * 3 + 1]; C[o + 2] = this.c[v * 3 + 2]
        const u = (t + k) * 2
        if (!planarUv) { U[u] = this.uv[v * 2]; U[u + 1] = this.uv[v * 2 + 1] }
        else if (ay >= ax && ay >= az) { U[u] = P[o] * uvScale; U[u + 1] = -P[o + 2] * uvScale }
        else if (ax >= az) { U[u] = P[o + 2] * uvScale; U[u + 1] = P[o + 1] * uvScale }
        else { U[u] = P[o] * uvScale; U[u + 1] = P[o + 1] * uvScale }
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(P, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(U, 2))
    g.setAttribute('color', new THREE.BufferAttribute(C, 3))
    g.computeBoundingBox()
    g.computeBoundingSphere()
    return g
  }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const icoCache = new Map<number, { pos: Float32Array; idx: ArrayLike<number> }>()
function unitIco(detail: number): { pos: Float32Array; idx: ArrayLike<number> } {
  let hit = icoCache.get(detail)
  if (!hit) {
    const g = new THREE.IcosahedronGeometry(1, detail)
    g.deleteAttribute('normal'); g.deleteAttribute('uv')
    const m = mergeVertices(g, 1e-4)
    g.dispose()
    hit = { pos: m.getAttribute('position').array as Float32Array, idx: m.getIndex()!.array }
    icoCache.set(detail, hit)
  }
  return hit
}

export interface BlobOpts {
  detail: number
  noise: Noise
  amp: number
  freq: number
  /** Noise domain offset (different lumps per blob). */
  offset: number
  color: RGB
  /** Normal bend toward radial (0 = true smooth normals). */
  bend?: number
  /** Clamp vertices below this world y (flat bottoms). */
  floor?: number
  /** Keep only the upper half (dome); the cut is closed by a flat disc. */
  dome?: boolean
}

/** Noise-displaced ellipsoid (icosphere). */
export function addBlob(b: GeoBuf, c: V3, r: V3, o: BlobOpts): void {
  const { pos, idx } = unitIco(o.detail)
  const v0 = b.vc, t0 = b.tc
  const count = pos.length / 3
  for (let k = 0; k < count; k++) {
    let d: V3 = [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]]
    if (o.dome && d[1] < 0) d = norm([d[0], 0, d[2]])
    const s = 1 + o.amp * fbm3(o.noise, d[0] * o.freq + o.offset, d[1] * o.freq + o.offset * 0.7, d[2] * o.freq - o.offset * 1.3, 2)
    let p: V3 = [c[0] + d[0] * r[0] * s, c[1] + d[1] * r[1] * (o.dome && d[1] <= 0 ? 0 : s), c[2] + d[2] * r[2] * s]
    if (o.floor !== undefined && p[1] < o.floor) p = [p[0], o.floor, p[2]]
    b.vert(p, o.color)
  }
  for (let t = 0; t < idx.length; t += 3) b.tri(v0 + idx[t], v0 + idx[t + 1], v0 + idx[t + 2])
  b.smooth(v0, t0)
  if (o.bend) b.bend(v0, c, o.bend)
}

export interface TubeOpts {
  sides: number
  color: RGB
  /** Per-ring colour multiplier (0..1 along the path). */
  shade?: (t: number) => number
  /** Star cross-section: odd vertices pushed in by this fraction (cactus ribs). */
  ribs?: number
  capEnd?: boolean
  capStart?: boolean
  twist?: number
}

/** Generalised cylinder along a polyline with parallel-transport frames. */
export function addTube(b: GeoBuf, path: V3[], radii: number[], o: TubeOpts): void {
  const n = path.length
  if (n < 2) return
  const v0 = b.vc, t0 = b.tc
  const T: V3[] = path.map((_, i) => norm(sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)])))
  let N = perp(T[0])
  const rings: number[][] = []
  for (let i = 0; i < n; i++) {
    if (i > 0) { const proj = sub(N, mul(T[i], dot(N, T[i]))); N = len(proj) > 1e-5 ? norm(proj) : perp(T[i]) }
    const B = cross(T[i], N)
    const ring: number[] = []
    const k = o.shade ? o.shade(i / (n - 1)) : 1
    for (let j = 0; j < o.sides; j++) {
      const a = (j / o.sides) * Math.PI * 2 + (o.twist ?? 0)
      const d = add(mul(N, Math.cos(a)), mul(B, Math.sin(a)))
      const r = radii[i] * (o.ribs && j % 2 === 1 ? 1 - o.ribs : 1)
      ring.push(b.vert(add(path[i], mul(d, r)), shadeRgb(o.color, k)))
    }
    rings.push(ring)
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < o.sides; j++) {
    const a = rings[i][j], c = rings[i][(j + 1) % o.sides], d = rings[i + 1][j], e = rings[i + 1][(j + 1) % o.sides]
    const out = norm(sub(lerp3(b.pos(a), b.pos(e), 0.5), lerp3(path[i], path[i + 1], 0.5)))
    b.tri(a, c, d, out)
    b.tri(c, e, d, out)
  }
  const cap = (i: number, dir: V3) => {
    const k = o.shade ? o.shade(i / (n - 1)) : 1
    const ctr = b.vert(add(path[i], mul(dir, radii[i] * 0.15)), shadeRgb(o.color, k))
    for (let j = 0; j < o.sides; j++) b.tri(rings[i][j], rings[i][(j + 1) % o.sides], ctr, dir)
  }
  if (o.capEnd) cap(n - 1, T[n - 1])
  if (o.capStart) cap(0, mul(T[0], -1))
  b.smooth(v0, t0)
}

/** Cone tier (conifer layer / roof-like cap) with a jagged, drooping rim and a shallow underside. `puff` (0..0.6)
 * rounds the profile into a plump, dome-like skirt (cute silhouettes) using `rings` intermediate rings. */
export function addTier(b: GeoBuf, base: V3, radius: number, height: number, o: {
  sides: number; droop: number; jag: number; under: number; twist: number; color: RGB; noise: Noise; offset: number; bend?: number
  puff?: number; rings?: number
}): void {
  const v0 = b.vc, t0 = b.tc
  const puff = Math.max(0, Math.min(0.8, o.puff ?? 0))
  const nr = puff > 0 ? Math.max(1, o.rings ?? 2) : 0
  const apexY = base[1] + height
  const apex = b.vert([base[0], apexY, base[2]], o.color)
  const under = b.vert([base[0], base[1] + height * o.under, base[2]], shadeRgb(o.color, 0.7))
  const rimPts: V3[] = []
  for (let j = 0; j < o.sides; j++) {
    const a = (j / o.sides) * Math.PI * 2 + o.twist
    const jag = 1 + o.jag * o.noise.noise2(Math.cos(a) * 1.7 + o.offset, Math.sin(a) * 1.7 - o.offset)
    const r = radius * (j % 2 === 0 ? 1 : 1 - o.jag * 0.6) * jag
    rimPts.push([base[0] + Math.cos(a) * r, base[1] - o.droop * radius * (0.7 + 0.3 * jag), base[2] + Math.sin(a) * r])
  }
  // rings from the apex outwards: radial reach s^(1 - puff) (bulges out), drop s^(1 + puff) (domed crown)
  const rings: number[][] = []
  for (let k = 1; k <= nr + 1; k++) {
    const s = k / (nr + 1)
    const f = Math.pow(s, 1 - puff), g = Math.pow(s, 1 + puff)
    const shade = 1 - 0.18 * s
    rings.push(rimPts.map((q) => b.vert([base[0] + (q[0] - base[0]) * f, apexY + (q[1] - apexY) * g, base[2] + (q[2] - base[2]) * f], shadeRgb(o.color, shade))))
  }
  const outward = (p: V3): V3 => norm([p[0] - base[0], 0.6, p[2] - base[2]])
  for (let j = 0; j < o.sides; j++) {
    const j2 = (j + 1) % o.sides
    const a = rings[0][j], c = rings[0][j2]
    b.tri(a, c, apex, outward(lerp3(b.pos(a), b.pos(c), 0.5)))
    for (let k = 0; k < rings.length - 1; k++) {
      const p0 = rings[k][j], p1 = rings[k][j2], q0 = rings[k + 1][j], q1 = rings[k + 1][j2]
      const out = outward(lerp3(b.pos(p0), b.pos(q1), 0.5))
      b.tri(q0, q1, p1, out)
      b.tri(q0, p1, p0, out)
    }
    const rim = rings[rings.length - 1]
    b.tri(rim[j2], rim[j], under, [0, -1, 0])
  }
  b.smooth(v0, t0)
  if (o.bend) b.bend(v0, [base[0], base[1] + height * 0.3, base[2]], o.bend)
}

/** Pointed prism (crystal / ice shard). Flat-shaded by its group. */
export function addShard(b: GeoBuf, base: V3, dir: V3, length: number, radius: number, sides: number, tip: number, color: RGB, twist: number): void {
  const d = norm(dir), N = perp(d), B = cross(d, N)
  const ring = (at: number, r: number, k: number) => {
    const out: number[] = []
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2 + twist
      out.push(b.vert(add(add(base, mul(d, at)), add(mul(N, Math.cos(a) * r), mul(B, Math.sin(a) * r))), shadeRgb(color, k)))
    }
    return out
  }
  const r0 = ring(-0.05, radius * 0.92, 0.75), r1 = ring(length * (1 - tip), radius, 1)
  const apex = b.vert(add(base, mul(d, length)), shadeRgb(color, 1.25))
  const ctr = add(base, mul(d, length * 0.5))
  for (let j = 0; j < sides; j++) {
    const j2 = (j + 1) % sides
    const out = norm(sub(lerp3(b.pos(r0[j]), b.pos(r1[j2]), 0.5), ctr))
    b.tri(r0[j], r0[j2], r1[j], out)
    b.tri(r0[j2], r1[j2], r1[j], out)
    b.tri(r1[j], r1[j2], apex, norm(add(out, d)))
  }
}

/** Flat ribbon along a path (palm fronds, hanging moss). `side` = width direction per point; `fold` lifts the midrib. */
export function addStrip(b: GeoBuf, path: V3[], widths: number[], side: V3[], fold: number, color: RGB, up: V3 = [0, 1, 0]): void {
  const v0 = b.vc, t0 = b.tc
  const rows: [number, number, number][] = []
  path.forEach((p, i) => {
    const s = mul(side[i], widths[i] / 2)
    const k = 0.85 + 0.25 * (i / Math.max(1, path.length - 1))
    rows.push([
      b.vert(sub(p, add(s, mul(up, fold * widths[i]))), shadeRgb(color, k * 0.9)),
      b.vert(p, shadeRgb(color, k)),
      b.vert(add(p, sub(s, mul(up, fold * widths[i]))), shadeRgb(color, k * 0.9)),
    ])
  })
  for (let i = 0; i < rows.length - 1; i++) for (let s = 0; s < 2; s++) {
    const a = rows[i][s], c = rows[i][s + 1], d = rows[i + 1][s], e = rows[i + 1][s + 1]
    b.tri(a, c, d, up)
    b.tri(c, e, d, up)
  }
  b.smooth(v0, t0)
}

/** Disc with explicit 0..1 UVs (decals: tree rings). `n` = facing. */
export function addDisc(b: GeoBuf, c: V3, r: number, sides: number, n: V3, color: RGB): void {
  const N = norm(n), A = perp(N), B = cross(N, A)
  const ctr = b.vert(c, color, [0.5, 0.5], N)
  const rim: number[] = []
  for (let j = 0; j < sides; j++) {
    const a = (j / sides) * Math.PI * 2
    rim.push(b.vert(add(c, add(mul(A, Math.cos(a) * r), mul(B, Math.sin(a) * r))), color, [0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5], N))
  }
  for (let j = 0; j < sides; j++) b.tri(rim[j], rim[(j + 1) % sides], ctr, N)
}

/** Vertical card (cutout billboard plane) with explicit UVs; normals point up like the billboard builder. */
export function addCard(b: GeoBuf, c: V3, w: number, h: number, yaw: number, flipU: boolean, color: RGB): void {
  const dx = Math.cos(yaw) * w / 2, dz = Math.sin(yaw) * w / 2
  const u0 = flipU ? 1 : 0, u1 = flipU ? 0 : 1
  const up: V3 = [0, 1, 0]
  const a = b.vert([c[0] - dx, c[1], c[2] - dz], color, [u0, 0], up)
  const d = b.vert([c[0] + dx, c[1], c[2] + dz], color, [u1, 0], up)
  const e = b.vert([c[0] + dx, c[1] + h, c[2] + dz], color, [u1, 1], up)
  const f = b.vert([c[0] - dx, c[1] + h, c[2] - dz], color, [u0, 1], up)
  b.i.push(a, d, e, a, e, f)
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** One material group of a generated model. */
export interface NatureGroup {
  material: NatureMaterial
  role: string
  buf: GeoBuf
  flat: boolean
  planarUv: boolean
  foliage: boolean
  castShadow: boolean
}

export interface NatureModel { groups: NatureGroup[]; height: number }

interface GenCtx {
  rnd: () => number
  noise: Noise
  def: PropDef
  group(role: string, material: NatureMaterial, opts?: { flat?: boolean; planarUv?: boolean; foliage?: boolean; castShadow?: boolean }): NatureGroup
}

type R2 = Vec2
interface TrunkP { height: R2; radius: R2; taper: number; bend: number; sides: number; rings: number; flare: number; roots?: R2; rootLength?: R2; material: NatureMaterial }
interface CanopyP { clusters: R2; radius: R2; spread: number; lift: R2; squash: number; detail: number; noise: number; noiseFreq: number; top: R2; colors: string[]; material: NatureMaterial; bend?: number }
interface BroadleafP {
  trunk: TrunkP
  branches: { count: R2; from: R2; length: R2; radius: number; rise: R2 }
  canopy: CanopyP
  fruit?: { chance: number; count: R2; radius: number; colors: string[]; material: NatureMaterial }
  /** Hanging strands; `rim` = start radius as a fraction of the cluster radius, `drop` = start height below the cluster
   * centre (fraction of its vertical radius). */
  moss?: { count: R2; length: R2; width: number; rim?: number; drop?: number; material: NatureMaterial }
}
interface ConiferP {
  trunk: TrunkP
  tiers: {
    count: R2; bottom: R2; radius: R2; shrink: R2; height: R2; overlap: number; sides: number; droop: R2; jag: number; under: number; top: R2
    colors: string[]; material: NatureMaterial; bend?: number
    /** Rounded, plump tiers (0 = straight cones) and the intermediate rings used to shape them. */
    puff?: R2; rings?: number
  }
  snow?: { cover: number; outset: number; material: NatureMaterial }
}
interface PalmP {
  trunk: TrunkP & { lean: R2; bulge: number }
  fronds: { count: R2; length: R2; width: R2; rise: R2; droop: R2; segments: number; fold: number; colors: string[]; material: NatureMaterial }
  nuts?: { count: R2; radius: number; material: NatureMaterial }
}
interface DeadP { trunk: TrunkP; branches: { levels: number; count: R2; from: R2; length: R2; shrink: number; rise: R2; radius: number } }
interface BushP {
  blobs: R2; radius: R2; spread: number; top: R2; squash: number; detail: number; noise: number; noiseFreq: number; colors: string[]; material: NatureMaterial; bend?: number
  berries?: { chance: number; count: R2; radius: number; colors: string[]; material: NatureMaterial }
}
interface RockP {
  boulders: R2; radius: R2; spread: number; squash: R2; detail: number; noise: number; noiseFreq: number; sink: number; flat: boolean
  colors: string[]; material: NatureMaterial; moss?: { chance: number; color: string; threshold: number }
}
interface CrystalP {
  base?: { radius: R2; squash: number; noise: number; material: NatureMaterial; colors?: string[] }
  shards: { count: R2; length: R2; radius: R2; tilt: R2; sides: number; tip: number; spread: number; lead?: number }
  palettes: NatureMaterial[]
}
interface CactusP {
  forms: [string, number][]
  column: { height: R2; radius: R2; sides: number; ribs: number; rings: number }
  arms: { count: R2; at: R2; out: R2; up: R2; scale: number }
  barrel: { radius: R2; height: R2 }
  flower?: { chance: number; radius: number; colors: string[]; material: NatureMaterial }
  material: NatureMaterial
}
interface MushroomP {
  count: R2; spread: number
  stem: { height: R2; radius: R2; bend: number; material: NatureMaterial }
  cap: { radius: R2; height: R2; noise: number; materials: NatureMaterial[] }
}
interface StumpP { height: R2; radius: R2; sides: number; flare: number; roots: R2; rootLength: R2; tilt: number; bark: NatureMaterial; top: NatureMaterial }
interface LogP { length: R2; radius: R2; bend: number; sides: number; bark: NatureMaterial; ends: NatureMaterial; moss?: { chance: number; color: string } }
interface CardsP { planes: R2; width: R2; height: R2; subset: R2; material: NatureMaterial }

const pick = <T>(rnd: () => number, list: readonly T[]): T => list[Math.floor(rnd() * list.length) % list.length]
const rr = (rnd: () => number, r: R2) => range(r, rnd())
const ri = (rnd: () => number, r: R2) => Math.round(range(r, rnd()))

/** Cluster colour (vertex ratio) for colour list entry k against the material colour. */
const clusterColor = (colors: string[], base: string, k: number): RGB => (colors.length ? colorRatio(colors[k % colors.length], base) : ONE)

function trunkPath(rnd: () => number, t: TrunkP, height: number): { path: V3[]; radii: number[]; r0: number } {
  const rings = Math.max(2, t.rings)
  const yaw = rnd() * Math.PI * 2
  const bend = t.bend * height
  const r0 = rr(rnd, t.radius)
  const path: V3[] = [], radii: number[] = []
  for (let i = 0; i <= rings; i++) {
    const s = i / rings
    path.push([Math.cos(yaw) * bend * s * s, height * s, Math.sin(yaw) * bend * s * s])
    radii.push(r0 * (1 - (1 - t.taper) * s) * (1 + t.flare * Math.pow(1 - s, 4)))
  }
  return { path, radii, r0 }
}

function addRoots(ctx: GenCtx, g: NatureGroup, t: TrunkP, r0: number): void {
  if (!t.roots) return
  const n = ri(ctx.rnd, t.roots)
  const off = ctx.rnd() * Math.PI * 2
  for (let k = 0; k < n; k++) {
    const a = off + (k / n) * Math.PI * 2 + (ctx.rnd() - 0.5) * 0.6
    const L = rr(ctx.rnd, t.rootLength ?? [0.15, 0.25])
    const d: V3 = [Math.cos(a), 0, Math.sin(a)]
    const path: V3[] = [add(mul(d, r0 * 0.3), [0, r0 * 1.6, 0]), add(mul(d, r0 * 0.9 + L * 0.45), [0, r0 * 0.45, 0]), add(mul(d, r0 + L), [0, -0.04, 0])]
    addTube(g.buf, path, [r0 * 0.55, r0 * 0.32, 0.012], { sides: 4, color: ONE, shade: (s) => 0.85 + 0.1 * s })
  }
}

function genBroadleaf(ctx: GenCtx, p: BroadleafP): void {
  const { rnd, noise } = ctx
  const H = ctx.def.height
  const bark = ctx.group('bark', p.trunk.material)
  const leaves = ctx.group('foliage', p.canopy.material, { foliage: true })
  const C = p.canopy
  // layout first (heights scaled afterwards so the crown top lands on the target height)
  const trunkH = rr(rnd, p.trunk.height)
  const tr = trunkPath(rnd, p.trunk, trunkH)
  const top = tr.path[tr.path.length - 1]
  const clusters: { c: V3; r: number; k: number }[] = []
  const mainR = rr(rnd, C.radius) * 1.15
  clusters.push({ c: add(top, [0, mainR * C.squash * 0.55, 0]), r: mainR, k: 0 })
  const branches: { path: V3[]; radii: number[] }[] = []
  const nb = ri(rnd, p.branches.count)
  const boff = rnd() * Math.PI * 2
  for (let i = 0; i < nb; i++) {
    const s = rr(rnd, p.branches.from)
    const idx = Math.min(tr.path.length - 2, Math.floor(s * (tr.path.length - 1)))
    const at = lerp3(tr.path[idx], tr.path[idx + 1], s * (tr.path.length - 1) - idx)
    const ra = tr.radii[idx] * p.branches.radius
    const yaw = boff + (i / nb) * Math.PI * 2 + (rnd() - 0.5) * 0.9
    const L = rr(rnd, p.branches.length)
    const d = dirOf(yaw, rr(rnd, p.branches.rise))
    const tip = add(at, mul(d, L))
    branches.push({ path: [at, add(at, add(mul(d, L * 0.5), [0, L * 0.06, 0])), tip], radii: [ra, ra * 0.7, ra * 0.4] })
    clusters.push({ c: add(tip, [0, C.squash * 0.2, 0]), r: rr(rnd, C.radius), k: 1 + i })
  }
  const nc = Math.max(clusters.length, ri(rnd, C.clusters))
  for (let i = clusters.length; i < nc; i++) {
    const a = rnd() * Math.PI * 2, d = C.spread * Math.sqrt(rnd())
    clusters.push({ c: add(top, [Math.cos(a) * d, rr(rnd, C.lift), Math.sin(a) * d]), r: rr(rnd, C.radius) * 0.9, k: i })
  }
  const crown = Math.max(...clusters.map((c) => c.c[1] + c.r * C.squash * (1 + C.noise * 0.5)))
  const want = H * rr(rnd, C.top)
  const sy = Math.min(1.35, Math.max(0.7, want / crown))
  const Y = (v: V3): V3 => [v[0], v[1] * sy, v[2]]
  addTube(bark.buf, tr.path.map(Y), tr.radii, { sides: p.trunk.sides, color: ONE, shade: (s) => 0.82 + 0.25 * s, capEnd: true })
  addRoots(ctx, bark, p.trunk, tr.r0)
  for (const b of branches) addTube(bark.buf, b.path.map(Y), b.radii, { sides: 4, color: ONE, shade: () => 0.95, capEnd: true })
  const center: V3 = [top[0], top[1] * sy, top[2]]
  for (const cl of clusters) {
    const c = Y(cl.c)
    const v0 = leaves.buf.vc
    addBlob(leaves.buf, c, [cl.r, cl.r * C.squash, cl.r], {
      detail: C.detail, noise, amp: C.noise, freq: C.noiseFreq, offset: cl.k * 3.17 + rnd() * 9, color: clusterColor(C.colors, C.material.color, cl.k), bend: 0,
    })
    leaves.buf.bend(v0, center, C.bend ?? RENDER.nature.foliageNormalBlend)
    // darker undersides, sunlit crowns
    leaves.buf.tint(v0, (q) => { const k = 0.78 + 0.32 * Math.min(1, Math.max(0, (q[1] - (c[1] - cl.r)) / (2 * cl.r * C.squash))); return [k, k, k] })
  }
  if (p.fruit && rnd() < p.fruit.chance) {
    const g = ctx.group('fruit', p.fruit.material)
    const n = ri(rnd, p.fruit.count)
    for (let i = 0; i < n; i++) {
      const cl = pick(rnd, clusters)
      const d = norm([rnd() - 0.5, rnd() * 0.8 - 0.2, rnd() - 0.5])
      const at = Y(add(cl.c, [d[0] * cl.r * 0.95, d[1] * cl.r * C.squash * 0.95, d[2] * cl.r * 0.95]))
      addBlob(g.buf, at, [p.fruit.radius, p.fruit.radius, p.fruit.radius], { detail: 0, noise, amp: 0, freq: 1, offset: 0, color: clusterColor(p.fruit.colors, p.fruit.material.color, i) })
    }
  }
  if (p.moss) {
    const g = ctx.group('moss', p.moss.material, { castShadow: false }) // single-sided: outward normals stay lit
    const n = ri(rnd, p.moss.count)
    for (let i = 0; i < n; i++) {
      const cl = pick(rnd, clusters)
      const a = rnd() * Math.PI * 2
      const rim = p.moss.rim ?? 0.8, drop = p.moss.drop ?? 0.35
      const start = Y(add(cl.c, [Math.cos(a) * cl.r * rim, -cl.r * C.squash * drop, Math.sin(a) * cl.r * rim]))
      const L = rr(rnd, p.moss.length)
      const path: V3[] = [start, add(start, [0, -L * 0.5, 0]), add(start, [0.02, -L, 0.02])]
      const side: V3 = [Math.cos(a + Math.PI / 2), 0, Math.sin(a + Math.PI / 2)]
      addStrip(g.buf, path, [p.moss.width, p.moss.width * 0.8, p.moss.width * 0.3], [side, side, side], 0, ONE, [Math.cos(a), 0, Math.sin(a)])
    }
  }
}

function genConifer(ctx: GenCtx, p: ConiferP): void {
  const { rnd, noise } = ctx
  const H = ctx.def.height
  const T = p.tiers
  const bark = ctx.group('bark', p.trunk.material)
  const leaves = ctx.group('foliage', T.material, { foliage: true })
  const snow = p.snow ? ctx.group('snow', p.snow.material, { foliage: true }) : null
  const n = ri(rnd, T.count)
  const tiers: { y: number; r: number; h: number }[] = []
  let y = rr(rnd, T.bottom), r = rr(rnd, T.radius)
  for (let i = 0; i < n; i++) {
    const h = rr(rnd, T.height) * (1 - i * 0.08)
    tiers.push({ y, r, h })
    y += h * (1 - T.overlap)
    r *= rr(rnd, T.shrink)
  }
  const last = tiers[tiers.length - 1]
  const apex = last.y + last.h
  const sy = Math.min(1.3, Math.max(0.75, (H * rr(rnd, T.top)) / apex))
  const trunkH = rr(rnd, p.trunk.height)
  const tr = trunkPath(rnd, { ...p.trunk, bend: 0 }, Math.min(trunkH, apex * 0.7) * sy)
  addTube(bark.buf, tr.path, tr.radii, { sides: p.trunk.sides, color: ONE, shade: (s) => 0.8 + 0.2 * s })
  addRoots(ctx, bark, p.trunk, tr.r0)
  const lean: V3 = [(rnd() - 0.5) * 0.06, 0, (rnd() - 0.5) * 0.06]
  tiers.forEach((t, i) => {
    const base: V3 = add([0, t.y * sy, 0], mul(lean, t.y))
    const twist = rnd() * Math.PI
    const droop = rr(rnd, T.droop)
    const color = clusterColor(T.colors, T.material.color, i)
    const puff = T.puff ? rr(rnd, T.puff) : 0
    addTier(leaves.buf, base, t.r, t.h * sy, { sides: T.sides, droop, jag: T.jag, under: T.under, twist, color, noise, offset: i * 5.3 + rnd() * 7, bend: T.bend, puff, rings: T.rings })
    if (snow && p.snow) {
      const c = p.snow.cover
      const h = t.h * sy
      const sb: V3 = add(base, [0, h * (1 - c) + p.snow.outset, 0])
      // the cap follows the tier profile: radius of the (puffed) tier at the cap's base height
      const q = Math.min(1, (h * c) / (h + droop * t.r * 0.85))
      const reach = Math.pow(Math.pow(q, 1 / (1 + puff)), 1 - puff)
      addTier(snow.buf, sb, t.r * reach * (1 + p.snow.outset * 4), h * c + p.snow.outset, {
        sides: T.sides, droop: droop * 0.6, jag: T.jag * 1.4, under: 0.5, twist, color: ONE, noise, offset: i * 2.1 + 11, bend: T.bend, puff, rings: T.rings,
      })
    }
  })
}

function genPalm(ctx: GenCtx, p: PalmP): void {
  const { rnd } = ctx
  const bark = ctx.group('bark', p.trunk.material)
  const leaves = ctx.group('foliage', p.fronds.material, { foliage: true })
  const h = rr(rnd, p.trunk.height)
  const leanD = rr(rnd, p.trunk.lean)
  const yaw = rnd() * Math.PI * 2
  const rings = Math.max(3, p.trunk.rings)
  const r0 = rr(rnd, p.trunk.radius)
  const path: V3[] = [], radii: number[] = []
  for (let i = 0; i <= rings * 2; i++) {
    const s = i / (rings * 2)
    const bow = Math.sin(s * Math.PI * 0.5)
    path.push([Math.cos(yaw) * leanD * bow * s, h * s, Math.sin(yaw) * leanD * bow * s])
    radii.push(r0 * (1 - (1 - p.trunk.taper) * s) * (1 + p.trunk.flare * Math.pow(1 - s, 6)) * (1 + (i % 2 === 0 ? p.trunk.bulge : 0)))
  }
  addTube(bark.buf, path, radii, { sides: p.trunk.sides, color: ONE, shade: (s) => 0.85 + 0.2 * s, capEnd: true })
  const crown = path[path.length - 1]
  const F = p.fronds
  const nf = ri(rnd, F.count)
  const off = rnd() * Math.PI * 2
  for (let i = 0; i < nf; i++) {
    const a = off + (i / nf) * Math.PI * 2 + (rnd() - 0.5) * 0.5
    const L = rr(rnd, F.length), W = rr(rnd, F.width), rise = rr(rnd, F.rise), droop = rr(rnd, F.droop)
    const dh: V3 = [Math.cos(a), 0, Math.sin(a)], side: V3 = [-Math.sin(a), 0, Math.cos(a)]
    const fp: V3[] = [], fw: number[] = [], fs: V3[] = []
    for (let k = 0; k <= F.segments; k++) {
      const d = k / F.segments
      fp.push(add(crown, add(mul(dh, L * d), [0, L * (rise * d - droop * d * d), 0])))
      fw.push(W * Math.sin(Math.PI * Math.pow(Math.max(0.02, d), 0.75)) + 0.02)
      fs.push(side)
    }
    addStrip(leaves.buf, fp, fw, fs, F.fold, clusterColor(F.colors, F.material.color, i))
  }
  if (p.nuts) {
    const g = ctx.group('fruit', p.nuts.material)
    const nn = ri(rnd, p.nuts.count)
    for (let i = 0; i < nn; i++) {
      const a = rnd() * Math.PI * 2
      addBlob(g.buf, add(crown, [Math.cos(a) * r0 * 0.9, -p.nuts.radius * 1.2, Math.sin(a) * r0 * 0.9]), [p.nuts.radius, p.nuts.radius, p.nuts.radius], { detail: 0, noise: ctx.noise, amp: 0, freq: 1, offset: 0, color: ONE })
    }
  }
}

function genDead(ctx: GenCtx, p: DeadP): void {
  const { rnd } = ctx
  const bark = ctx.group('bark', p.trunk.material)
  const tr = trunkPath(rnd, p.trunk, rr(rnd, p.trunk.height))
  addTube(bark.buf, tr.path, tr.radii, { sides: p.trunk.sides, color: ONE, shade: (s) => 0.8 + 0.25 * s, capEnd: true })
  addRoots(ctx, bark, p.trunk, tr.r0)
  const B = p.branches
  const grow = (path: V3[], radii: number[], level: number) => {
    if (level >= B.levels) return
    const n = ri(rnd, B.count)
    for (let i = 0; i < n; i++) {
      const s = rr(rnd, B.from)
      const idx = Math.min(path.length - 2, Math.floor(s * (path.length - 1)))
      const at = lerp3(path[idx], path[idx + 1], s * (path.length - 1) - idx)
      const L = rr(rnd, B.length) * Math.pow(B.shrink, level)
      const d = dirOf(rnd() * Math.PI * 2, rr(rnd, B.rise))
      const mid = add(at, add(mul(d, L * 0.55), [(rnd() - 0.5) * L * 0.2, L * 0.08, (rnd() - 0.5) * L * 0.2]))
      const tip = add(mid, add(mul(d, L * 0.45), [0, L * 0.12, 0]))
      const ra = Math.max(0.015, radii[idx] * B.radius)
      const bp = [at, mid, tip], br = [ra, ra * 0.6, 0.01]
      addTube(bark.buf, bp, br, { sides: 4, color: ONE, shade: () => 0.95 })
      grow(bp, br, level + 1)
    }
  }
  grow(tr.path, tr.radii, 0)
}

function genBush(ctx: GenCtx, p: BushP): void {
  const { rnd, noise } = ctx
  const leaves = ctx.group('foliage', p.material, { foliage: true })
  const n = ri(rnd, p.blobs)
  const blobs: { c: V3; r: number }[] = []
  const off = rnd() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    const r = rr(rnd, p.radius) * (i === 0 ? 1.15 : 1)
    const a = off + (i / n) * Math.PI * 2, d = i === 0 ? 0 : p.spread * (0.6 + rnd() * 0.5)
    blobs.push({ c: [Math.cos(a) * d, r * p.squash * 0.8, Math.sin(a) * d], r })
  }
  const top = Math.max(...blobs.map((b) => b.c[1] + b.r * p.squash))
  const sy = Math.min(1.4, Math.max(0.7, (ctx.def.height * rr(rnd, p.top)) / top))
  blobs.forEach((b, i) => {
    const c: V3 = [b.c[0], b.c[1] * sy, b.c[2]]
    const v0 = leaves.buf.vc
    addBlob(leaves.buf, c, [b.r, b.r * p.squash * sy, b.r], { detail: p.detail, noise, amp: p.noise, freq: p.noiseFreq, offset: i * 4.1 + rnd() * 9, color: clusterColor(p.colors, p.material.color, i), floor: 0 })
    leaves.buf.bend(v0, [0, 0, 0], p.bend ?? RENDER.nature.foliageNormalBlend)
    leaves.buf.tint(v0, (q) => { const k = 0.72 + 0.4 * Math.min(1, q[1] / Math.max(0.1, top * sy)); return [k, k, k] })
  })
  if (p.berries && rnd() < p.berries.chance) {
    const g = ctx.group('fruit', p.berries.material)
    const nb = ri(rnd, p.berries.count)
    const col = Math.floor(rnd() * p.berries.colors.length)
    for (let i = 0; i < nb; i++) {
      const b = pick(rnd, blobs)
      const d = norm([rnd() - 0.5, rnd() * 0.9, rnd() - 0.5])
      const at: V3 = [b.c[0] + d[0] * b.r * 0.95, (b.c[1] + d[1] * b.r * p.squash * 0.95) * sy, b.c[2] + d[2] * b.r * 0.95]
      addBlob(g.buf, at, [p.berries.radius, p.berries.radius, p.berries.radius], { detail: 0, noise, amp: 0, freq: 1, offset: 0, color: clusterColor(p.berries.colors, p.berries.material.color, col) })
    }
  }
}

function genRock(ctx: GenCtx, p: RockP): void {
  const { rnd, noise } = ctx
  const g = ctx.group('rock', p.material, { flat: p.flat })
  const n = ri(rnd, p.boulders)
  const off = rnd() * Math.PI * 2
  const scaleH = ctx.def.height
  const moss = p.moss && rnd() < p.moss.chance ? colorRatio(p.moss.color, p.material.color) : null
  for (let i = 0; i < n; i++) {
    const r = rr(rnd, p.radius) * (i === 0 ? 1 : 0.45 + rnd() * 0.3)
    const a = off + i * 2.4, d = i === 0 ? 0 : p.spread * (0.7 + rnd() * 0.5)
    const sq = rr(rnd, p.squash)
    const h = i === 0 ? Math.min(scaleH, r * sq * 2) : r * sq * 2
    const c: V3 = [Math.cos(a) * d, h * 0.5 - p.sink, Math.sin(a) * d]
    const v0 = g.buf.vc
    addBlob(g.buf, c, [r * (0.9 + rnd() * 0.25), h * 0.5, r * (0.8 + rnd() * 0.25)], {
      detail: p.detail, noise, amp: p.noise, freq: p.noiseFreq, offset: i * 7.7 + rnd() * 13, color: clusterColor(p.colors, p.material.color, i), floor: -p.sink * 0.5,
    })
    if (moss) g.buf.tint(v0, (_q, nn) => (nn[1] > p.moss!.threshold ? moss : ONE))
  }
}

function genCrystal(ctx: GenCtx, p: CrystalP): void {
  const { rnd, noise } = ctx
  if (p.base) {
    const b = ctx.group('rock', p.base.material, { flat: true })
    const r = rr(rnd, p.base.radius)
    addBlob(b.buf, [0, 0, 0], [r, r * p.base.squash, r * 0.9], { detail: 1, noise, amp: p.base.noise, freq: 1.6, offset: rnd() * 9, color: clusterColor(p.base.colors ?? [], p.base.material.color, 0), floor: -0.02 })
  }
  const mat = pick(rnd, p.palettes)
  const g = ctx.group('crystal', mat, { flat: true })
  const S = p.shards
  const n = ri(rnd, S.count)
  const off = rnd() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    const lead = i === 0
    const a = off + (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.7
    const tilt = lead ? rr(rnd, S.tilt) * 0.3 : rr(rnd, S.tilt)
    const dir = dirOf(a, 90 - tilt)
    const L = rr(rnd, S.length) * (lead ? (S.lead ?? 1.25) : 0.55 + rnd() * 0.4)
    const R = rr(rnd, S.radius) * (lead ? 1.2 : 0.8)
    const base: V3 = lead ? [0, 0, 0] : [Math.cos(a) * S.spread, 0, Math.sin(a) * S.spread]
    addShard(g.buf, base, dir, L * ctx.def.height, R, S.sides, S.tip, clusterColor(mat.colors ?? [], mat.color, i), rnd() * Math.PI)
  }
}

function genCactus(ctx: GenCtx, p: CactusP): void {
  const { rnd, noise } = ctx
  const g = ctx.group('cactus', p.material)
  const total = p.forms.reduce((s, f) => s + f[1], 0)
  let r = rnd() * total, form = p.forms[0][0]
  for (const [f, w] of p.forms) { r -= w; if (r < 0) { form = f; break } }
  const C = p.column
  const ribbed = (path: V3[], radii: number[]) => addTube(g.buf, path, radii, { sides: C.sides, ribs: C.ribs, color: ONE, shade: (s) => 0.85 + 0.2 * s, twist: rnd() })
  const roundTop = (base: V3, up: V3, h: number, rad: number): { path: V3[]; radii: number[] } => {
    const path: V3[] = [], radii: number[] = []
    const body = Math.max(0.01, h - rad)
    for (let i = 0; i <= C.rings; i++) { path.push(add(base, mul(up, body * i / C.rings))); radii.push(rad) }
    for (let k = 1; k <= 3; k++) { const a = (k / 3) * Math.PI / 2; path.push(add(base, mul(up, body + Math.sin(a) * rad * 0.9))); radii.push(Math.max(0.005, Math.cos(a) * rad)) }
    return { path, radii }
  }
  let topY = 0
  if (form === 'barrel') {
    const rad = rr(rnd, p.barrel.radius), h = rr(rnd, p.barrel.height)
    const body = roundTop([0, 0, 0], [0, 1, 0], h, rad)
    ribbed(body.path, body.radii.map((x, i) => x * (0.86 + 0.14 * Math.sin(Math.PI * Math.min(1, i / C.rings)))))
    topY = h
  } else {
    const h = rr(rnd, C.height), rad = rr(rnd, C.radius)
    const col = roundTop([0, 0, 0], [0, 1, 0], h, rad)
    ribbed(col.path, col.radii)
    topY = h
    const na = ri(rnd, p.arms.count)
    const off = rnd() * Math.PI * 2
    for (let i = 0; i < na; i++) {
      const a = off + (i / Math.max(1, na)) * Math.PI * 2 + (rnd() - 0.5) * 0.8
      const d: V3 = [Math.cos(a), 0, Math.sin(a)]
      const ar = rad * p.arms.scale
      const y0 = h * rr(rnd, p.arms.at)
      const out = rr(rnd, p.arms.out), up = rr(rnd, p.arms.up) * h
      const elbow = add(mul(d, rad + out), [0, y0 + ar * 0.5, 0])
      const horiz: V3[] = [add(mul(d, rad * 0.4), [0, y0, 0]), add(mul(d, rad + out * 0.5), [0, y0 + ar * 0.1, 0]), elbow]
      addTube(g.buf, horiz, [ar, ar, ar], { sides: C.sides, ribs: C.ribs, color: ONE, shade: () => 0.95 })
      const vert = roundTop(elbow, [0, 1, 0], up, ar)
      ribbed(vert.path, vert.radii)
    }
  }
  if (p.flower && rnd() < p.flower.chance) {
    const f = ctx.group('flower', p.flower.material, { castShadow: false })
    const col = clusterColor(p.flower.colors, p.flower.material.color, Math.floor(rnd() * p.flower.colors.length))
    addBlob(f.buf, [0, topY, 0], [p.flower.radius, p.flower.radius * 0.6, p.flower.radius], { detail: 1, noise, amp: 0.25, freq: 3, offset: rnd() * 5, color: col })
  }
}

function genMushroom(ctx: GenCtx, p: MushroomP): void {
  const { rnd, noise } = ctx
  const stem = ctx.group('stem', p.stem.material)
  const capMat = pick(rnd, p.cap.materials)
  const cap = ctx.group('cap', capMat)
  const n = ri(rnd, p.count)
  const H = ctx.def.height
  for (let i = 0; i < n; i++) {
    const lead = i === 0
    const a = rnd() * Math.PI * 2, d = lead ? 0 : p.spread * (0.6 + rnd() * 0.6)
    const k = lead ? 1 : 0.45 + rnd() * 0.35
    const h = rr(rnd, p.stem.height) * H * k, sr = rr(rnd, p.stem.radius) * (0.7 + 0.3 * k)
    const base: V3 = [Math.cos(a) * d, 0, Math.sin(a) * d]
    const lean: V3 = [(rnd() - 0.5) * p.stem.bend * 2 + Math.cos(a) * p.stem.bend * (lead ? 0 : 1), 0, (rnd() - 0.5) * p.stem.bend * 2 + Math.sin(a) * p.stem.bend * (lead ? 0 : 1)]
    const top = add(base, add([0, h, 0], lean))
    addTube(stem.buf, [base, add(lerp3(base, top, 0.5), mul(lean, -0.3)), top], [sr * 1.25, sr, sr * 0.9], { sides: 6, color: ONE, shade: (s) => 0.85 + 0.15 * s })
    const cr = rr(rnd, p.cap.radius) * (0.6 + 0.4 * k), ch = cr * rr(rnd, p.cap.height)
    addBlob(cap.buf, add(top, [0, -ch * 0.15, 0]), [cr, ch, cr], { detail: 1, noise, amp: p.cap.noise, freq: 2.2, offset: i * 3.3 + rnd() * 5, color: clusterColor(capMat.colors ?? [], capMat.color, i), dome: true })
  }
}

function genStump(ctx: GenCtx, p: StumpP): void {
  const { rnd } = ctx
  const bark = ctx.group('bark', p.bark)
  const top = ctx.group('wood', p.top, { planarUv: false })
  const h = rr(rnd, p.height), r0 = rr(rnd, p.radius)
  const path: V3[] = [], radii: number[] = []
  for (let i = 0; i <= 3; i++) { const s = i / 3; path.push([0, h * s, 0]); radii.push(r0 * (1 + p.flare * Math.pow(1 - s, 3))) }
  addTube(bark.buf, path, radii, { sides: p.sides, color: ONE, shade: (s) => 0.82 + 0.2 * s })
  addRoots(ctx, bark, { height: [0, 0], radius: [r0, r0], taper: 1, bend: 0, sides: 4, rings: 2, flare: 0, roots: p.roots, rootLength: p.rootLength, material: p.bark }, r0 * 1.1)
  const tilt = (rnd() - 0.5) * p.tilt
  addDisc(top.buf, [0, h + 0.004, 0], r0 * 0.96, p.sides, [Math.sin(tilt), 1, Math.cos(tilt) * 0.2], ONE)
}

function genLog(ctx: GenCtx, p: LogP): void {
  const { rnd } = ctx
  const bark = ctx.group('bark', p.bark)
  const ends = ctx.group('wood', p.ends, { planarUv: false })
  const L = rr(rnd, p.length) * Math.max(1, ctx.def.footprint[0]) / 2, r = rr(rnd, p.radius)
  const bend = (rnd() - 0.5) * p.bend
  const path: V3[] = []
  for (let i = 0; i <= 4; i++) { const s = i / 4; path.push([-L / 2 + L * s, r * 0.92, Math.sin(s * Math.PI) * bend]) }
  addTube(bark.buf, path, path.map((_, i) => r * (1 - 0.08 * Math.abs(i - 2) / 2)), { sides: p.sides, color: ONE, shade: () => 1 })
  addDisc(ends.buf, add(path[4], [0.002, 0, 0]), r * 0.95, p.sides, [1, 0, 0], ONE)
  addDisc(ends.buf, add(path[0], [-0.002, 0, 0]), r * 0.95, p.sides, [-1, 0, 0], ONE)
  if (p.moss && rnd() < p.moss.chance) {
    const m = colorRatio(p.moss.color, p.bark.color)
    bark.buf.tint(0, (_q, n) => (n[1] > 0.55 ? m : ONE))
  }
}

function genCards(ctx: GenCtx, p: CardsP): void {
  const { rnd } = ctx
  const pool = p.material.colors ?? []
  const k = Math.min(pool.length, Math.max(1, ri(rnd, p.subset)))
  const start = Math.floor(rnd() * Math.max(1, pool.length))
  const colors = pool.length ? Array.from({ length: k }, (_, i) => pool[(start + i) % pool.length]) : undefined
  const g = ctx.group('flower', { ...p.material, colors, cutout: true }, { foliage: true, planarUv: false, castShadow: false })
  const n = ri(rnd, p.planes)
  const off = rnd() * Math.PI
  const H = ctx.def.height
  for (let i = 0; i < n; i++) addCard(g.buf, [(rnd() - 0.5) * 0.12, 0, (rnd() - 0.5) * 0.12], rr(rnd, p.width), rr(rnd, p.height) * H, off + (i / n) * Math.PI, rnd() < 0.5, ONE)
}

const GENERATORS: Record<string, (ctx: GenCtx, p: never) => void> = {
  broadleaf: genBroadleaf, conifer: genConifer, palm: genPalm, deadtree: genDead, bush: genBush, rock: genRock,
  crystal: genCrystal, cactus: genCactus, mushroom: genMushroom, stump: genStump, log: genLog, cards: genCards,
}

/** Generates procedural variant `variant` of a nature prop (deterministic per prop key + variant). */
export function generateNature(def: PropDef, cfg: NatureProp, variant: number): NatureModel {
  const seed = seedOf(`${def.key}#${variant}`)
  const rnd = mulberry32(seed)
  const noise = createNoise(seed ^ 0x2c1b3c6d)
  const groups = new Map<string, NatureGroup>()
  const ctx: GenCtx = {
    rnd, noise, def,
    group(role, material, opts) {
      const key = `${role}|${JSON.stringify(material)}|${opts?.flat ? 1 : 0}`
      let g = groups.get(key)
      if (!g) {
        g = { material, role, buf: new GeoBuf(), flat: !!opts?.flat, planarUv: opts?.planarUv ?? true, foliage: !!opts?.foliage, castShadow: opts?.castShadow ?? true }
        groups.set(key, g)
      }
      return g
    },
  }
  const gen = GENERATORS[cfg.gen]
  if (!gen) throw new Error(`nature: unknown generator "${cfg.gen}" for ${def.key}`)
  gen(ctx, cfg.params as never)
  const list = [...groups.values()].filter((g) => g.buf.i.length > 0)
  let height = 0
  for (const g of list) for (let k = 1; k < g.buf.p.length; k += 3) height = Math.max(height, g.buf.p[k])
  return { groups: list, height }
}

/** Shape / reference problems of the nature config (validated by tests/render.test.ts). */
export function validateNatureParams(key: string, cfg: NatureProp): string[] {
  const errs: string[] = []
  const w = `nature.props.${key}`
  const mats: NatureMaterial[] = []
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) { v.forEach(walk); return }
    const o = v as Record<string, unknown>
    if (typeof o.pattern === 'string' && typeof o.color === 'string') mats.push(o as unknown as NatureMaterial)
    for (const x of Object.values(o)) walk(x)
  }
  walk(cfg.params)
  for (const m of mats) {
    if (!isHexColor(m.color)) errs.push(`${w}: bad material color ${m.color}`)
    if (m.color2 && !isHexColor(m.color2)) errs.push(`${w}: bad color2 ${m.color2}`)
    if (m.emissiveColor && !isHexColor(m.emissiveColor)) errs.push(`${w}: bad emissiveColor ${m.emissiveColor}`)
    m.colors?.forEach((c) => { if (!isHexColor(c)) errs.push(`${w}: bad colour ${c}`) })
  }
  const colorsOf = (v: unknown): void => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) { v.forEach(colorsOf); return }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'colors' && Array.isArray(x)) x.forEach((c) => { if (!isHexColor(c)) errs.push(`${w}.${k}: bad colour ${String(c)}`) })
      else colorsOf(x)
    }
  }
  colorsOf(cfg.params)
  return errs
}
