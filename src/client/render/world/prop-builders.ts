// Prop templates: procedural fallback meshes generated from content/render.json styles (generic "parts",
// parametric "house" and crossed-card "billboard" builders) or GLB models. A template is a list of
// merged geometries (one per material) in the prop's local frame (origin = footprint centre on ground,
// facade +Z), ready to be instanced.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { PropDef } from '../../../shared/types.ts'
import {
  RENDER, hexToRgb, propStyle, resolveColor, stylePalette,
  type BillboardStyle, type HouseStyle, type PartDef, type PropStyle, type Vec3,
} from '../config.ts'
import { configurePixelTexture } from '../sprite-utils.ts'
import { applySnowDust } from './climate.ts'
import { doorOffsetX, hashString } from './coords.ts'
import type { NatureModel } from './nature.ts'
import { applyOcclusion } from './occlusion.ts'
import { patternTexture } from './patterns.ts'
import { applyWind } from './wind.ts'

export type EmissiveMode = 'night' | 'always'

export interface MaterialSpec {
  pattern: string
  color: string
  color2?: string
  colors?: string[]
  cutout?: boolean
  emissive?: number
  emissiveColor?: string
  emissiveMap?: boolean
  foliage?: boolean
  sway?: boolean
  glossy?: boolean
  opacity?: number
  /** Multiply by the geometry's colour attribute (procedural nature cluster shades). */
  vertexColors?: boolean
  mode: EmissiveMode
}

type LitMaterial = THREE.MeshLambertMaterial | THREE.MeshPhongMaterial | THREE.MeshStandardMaterial

export interface MaterialLibrary {
  get(spec: MaterialSpec): THREE.Material
  /** Track an emissive material (procedural or GLB 'EMIT_*') so its glow follows the lamps factor. */
  track(material: LitMaterial, mode: EmissiveMode, weight: number): void
  /** 0 (day) .. 1 (night) */
  setLamps(f: number): void
  /** Depth material for swaying foliage shadows. */
  readonly swayDepth: THREE.MeshDepthMaterial
  /** Materials get the camera-occlusion cutaway (overworld only). */
  readonly occlusion: boolean
  dispose(): void
}

export function createMaterialLibrary(opts?: { occlusion?: boolean }): MaterialLibrary {
  const occlusion = !!opts?.occlusion
  const L = RENDER.lights
  const cache = new Map<string, THREE.Material>()
  const emissive: { material: LitMaterial; mode: EmissiveMode; weight: number }[] = []
  const swayDepth = applyWind(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), 'prop-depth')
  const srgb = (hex: string) => new THREE.Color().setRGB(...hexToRgb(hex), THREE.SRGBColorSpace)
  let lamps = 0

  const lib: MaterialLibrary = {
    swayDepth,
    occlusion,
    get(spec) {
      const key = JSON.stringify(spec)
      const hit = cache.get(key)
      if (hit) return hit
      const map = patternTexture({ id: spec.pattern, color: spec.color, color2: spec.color2, colors: spec.colors, cutout: spec.cutout })
      const common = {
        map,
        alphaTest: spec.cutout ? RENDER.props.foliageAlphaTest : 0,
        side: spec.cutout || spec.foliage ? THREE.DoubleSide : THREE.FrontSide,
        transparent: (spec.opacity ?? 1) < 1,
        opacity: spec.opacity ?? 1,
        depthWrite: (spec.opacity ?? 1) >= 1,
        vertexColors: !!spec.vertexColors,
      }
      const m: LitMaterial = spec.glossy
        ? new THREE.MeshPhongMaterial({ ...common, shininess: RENDER.terrain.glossy.shininess, specular: srgb(RENDER.terrain.glossy.specular) })
        : new THREE.MeshLambertMaterial(common)
      if (spec.emissive) {
        m.emissive = srgb(spec.emissiveColor ?? spec.color)
        if (spec.emissiveMap) m.emissiveMap = map
        m.name = `EMIT_${spec.pattern}`
        lib.track(m, spec.mode, spec.emissive)
      } else if (spec.foliage) m.name = 'FOLIAGE'
      if (spec.foliage && spec.sway) applyWind(m, 'prop')
      if (!m.transparent) applySnowDust(m, true)
      if (occlusion && !m.transparent) applyOcclusion(m)
      cache.set(key, m)
      return m
    },
    track(material, mode, weight) {
      if (emissive.some((e) => e.material === material)) return
      material.userData.apEmissive = true
      emissive.push({ material, mode, weight })
      apply(emissive[emissive.length - 1])
    },
    setLamps(f) {
      if (Math.abs(f - lamps) < 1e-3) return
      lamps = f
      for (const e of emissive) apply(e)
    },
    dispose() {
      for (const m of cache.values()) m.dispose()
      cache.clear()
      emissive.length = 0
      swayDepth.dispose()
    },
  }
  function apply(e: { material: LitMaterial; mode: EmissiveMode; weight: number }): void {
    e.material.emissiveIntensity = e.weight * (e.mode === 'always' ? L.emissiveAlways : L.emissiveDay + (L.emissiveNight - L.emissiveDay) * lamps)
  }
  return lib
}

// ---------------------------------------------------------------------------
// Unit shapes: non-indexed, normalised to x,z in [-0.5,0.5], y in [0,1].
// ---------------------------------------------------------------------------

/** Patterns that are drawn once across a face (signs, screens, rugs) instead of tiling in world units. */
const DECAL_PATTERNS = new Set(['rug', 'arena', 'stairsdown', 'books', 'screen', 'cross', 'badge', 'leds', 'glass', 'flowers', 'reeds', 'water', 'rings'])

function normalizeUnit(geo: THREE.BufferGeometry, keepY = false): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo
  if (g !== geo) geo.dispose()
  g.computeBoundingBox()
  const b = g.boundingBox!
  const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z
  g.translate(-(b.min.x + b.max.x) / 2, keepY ? 0 : -b.min.y, -(b.min.z + b.max.z) / 2)
  g.scale(sx > 1e-6 ? 1 / sx : 1, !keepY && sy > 1e-6 ? 1 / sy : 1, sz > 1e-6 ? 1 / sz : 1)
  return g
}

function prismGeometry(ridge: 'x' | 'y' | 'z'): THREE.BufferGeometry {
  // triangle profile extruded along one axis; built as a non-indexed triangle soup
  const tri: [number, number][] = ridge === 'y' ? [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]] : [[-0.5, 0], [0.5, 0], [0, 1]]
  const p: number[] = []
  const put = (a: number, b: number, e: number) => {
    if (ridge === 'x') p.push(e, b, a)        // profile in (z, y), extrude x
    else if (ridge === 'z') p.push(a, b, e)   // profile in (x, y), extrude z
    else p.push(a, e, b)                      // profile in (x, z), extrude y
  }
  const e0 = ridge === 'y' ? 0 : -0.5, e1 = ridge === 'y' ? 1 : 0.5
  const [A, B, C] = tri
  // caps
  put(A[0], A[1], e0); put(C[0], C[1], e0); put(B[0], B[1], e0)
  put(A[0], A[1], e1); put(B[0], B[1], e1); put(C[0], C[1], e1)
  // sides
  for (const [P, Q] of [[A, B], [B, C], [C, A]]) {
    put(P[0], P[1], e0); put(Q[0], Q[1], e0); put(Q[0], Q[1], e1)
    put(P[0], P[1], e0); put(Q[0], Q[1], e1); put(P[0], P[1], e1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
  // fix winding so every face points outward from the centroid
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const c = new THREE.Vector3(0, ridge === 'y' ? 0.5 : 1 / 3, ridge === 'y' ? -1 / 6 : 0)
  if (ridge === 'z') c.set(0, 1 / 3, 0)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3()
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); d.fromBufferAttribute(pos, i + 2)
    n.subVectors(b, a).cross(m.subVectors(d, a))
    m.copy(a).add(b).add(d).multiplyScalar(1 / 3).sub(c)
    if (n.dot(m) < 0) { pos.setXYZ(i + 1, d.x, d.y, d.z); pos.setXYZ(i + 2, b.x, b.y, b.z) }
  }
  const uv = new Float32Array(pos.count * 2)
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.computeVertexNormals()
  return g
}

function rockGeometry(seed: number): THREE.BufferGeometry {
  const R = RENDER.props.rock
  const ico = new THREE.IcosahedronGeometry(0.5, 1)
  const g = ico.toNonIndexed()
  ico.dispose()
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  // jitter shared vertices identically (key by rounded position) so faces stay closed
  const jitter = new Map<string, number>()
  let s = seed >>> 0
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return s / 4294967296 }
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`
    let j = jitter.get(k)
    if (j === undefined) { j = 1 - R.jitter / 2 + rnd() * R.jitter; jitter.set(k, j) }
    pos.setXYZ(i, pos.getX(i) * j, Math.max(pos.getY(i) * j, R.floor), pos.getZ(i) * j)
  }
  g.computeVertexNormals()
  return g
}

const unitCache = new Map<string, THREE.BufferGeometry>()

function unitShape(p: PartDef, seed: number): THREE.BufferGeometry {
  const seg = p.segments ?? 0
  const taper = p.taper ?? 1
  const key = `${p.shape}|${seg}|${taper}|${p.ridge ?? 'x'}|${p.shape === 'rock' ? seed : 0}`
  const hit = unitCache.get(key)
  if (hit) return hit
  let g: THREE.BufferGeometry
  switch (p.shape) {
    case 'box': {
      const b = new THREE.BoxGeometry(1, 1, 1)
      if (taper !== 1) {
        const pos = b.getAttribute('position') as THREE.BufferAttribute
        for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0) pos.setXYZ(i, pos.getX(i) * taper, pos.getY(i), pos.getZ(i) * taper)
        b.computeVertexNormals()
      }
      g = normalizeUnit(b)
      break
    }
    case 'cylinder': g = normalizeUnit(new THREE.CylinderGeometry(0.5 * taper, 0.5, 1, seg || 8)); break
    case 'cone': g = normalizeUnit(new THREE.ConeGeometry(0.5, 1, seg || 8)); break
    case 'pyramid': { const c = new THREE.ConeGeometry(0.5, 1, 4); c.rotateY(Math.PI / 4); g = normalizeUnit(c); break }
    case 'sphere': g = normalizeUnit(new THREE.SphereGeometry(0.5, seg || 10, Math.max(4, Math.round((seg || 10) * 0.7)))); break
    case 'dome': g = normalizeUnit(new THREE.SphereGeometry(0.5, seg || 12, Math.max(3, Math.round((seg || 12) / 2)), 0, Math.PI * 2, 0, Math.PI / 2)); break
    case 'prism': g = normalizeUnit(prismGeometry(p.ridge ?? 'x')); break
    case 'plane': { const pl = new THREE.PlaneGeometry(1, 1); pl.rotateX(-Math.PI / 2); g = normalizeUnit(pl, true); break }
    case 'torus': { const t = new THREE.TorusGeometry(0.4, 0.1, 6, seg || 12); t.rotateX(Math.PI / 2); g = normalizeUnit(t); break }
    case 'rock': g = normalizeUnit(rockGeometry(seed)); break
    default: g = normalizeUnit(new THREE.BoxGeometry(1, 1, 1))
  }
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name)
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
  unitCache.set(key, g)
  return g
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface TemplatePart {
  geometry: THREE.BufferGeometry
  material: THREE.Material
  sway: boolean
  castShadow: boolean
  /** Tint role (render.json nature tints: foliage, bark, rock ...); undefined = generic. */
  role?: string
}

export interface PropTemplate {
  parts: TemplatePart[]
  height: number
  randomYaw: boolean
  scaleJitter: number
  tintJitter: number
  dispose(): void
}

interface Ctx { W: number; D: number; H: number; palette: Record<string, string>; def: PropDef; lib: MaterialLibrary; seed: number }

const _m = new THREE.Matrix4()
const _r = new THREE.Matrix4()
const _t = new THREE.Matrix4()
const _n = new THREE.Vector3()
const _p = new THREE.Vector3()

function partGeometries(p: PartDef, ctx: Ctx, index: number): THREE.BufferGeometry[] {
  const unit = unitShape(p, ctx.seed + index * 977)
  let sx = p.size[0] * ctx.W, sy = p.size[1] * ctx.H, sz = p.size[2] * ctx.D
  if (p.lengthAxis === 'x') [sx, sy] = [sy, sx]
  else if (p.lengthAxis === 'z') [sz, sy] = [sy, sz]
  const rot = p.rot ?? [0, 0, 0]
  _r.makeRotationFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(rot[0]), THREE.MathUtils.degToRad(rot[1]), THREE.MathUtils.degToRad(rot[2]), 'XYZ'))
  const out: THREE.BufferGeometry[] = []
  const count = Math.max(1, p.repeat?.count ?? 1)
  for (let k = 0; k < count; k++) {
    const step = p.repeat?.step ?? [0, 0, 0]
    const px = (p.pos[0] + step[0] * k) * ctx.W, py = (p.pos[1] + step[1] * k) * ctx.H, pz = (p.pos[2] + step[2] * k) * ctx.D
    const g = unit.clone()
    g.scale(Math.max(sx, 1e-4), p.shape === 'plane' ? 1 : Math.max(sy, 1e-4), Math.max(sz, 1e-4))
    if (p.pivot === 'center') {
      _m.makeTranslation(0, -sy / 2, 0)
      g.applyMatrix4(_m)
      g.applyMatrix4(_r)
      _t.makeTranslation(px, py + sy / 2, pz)
      g.applyMatrix4(_t)
    } else {
      g.applyMatrix4(_r)
      _t.makeTranslation(px, py, pz)
      g.applyMatrix4(_t)
    }
    if (!DECAL_PATTERNS.has(p.pattern ?? 'plain')) projectUv(g)
    out.push(g)
  }
  return out
}

/** World-scaled planar UVs chosen by the dominant normal axis: constant texel density on every shape. */
function projectUv(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute
  const uv = g.getAttribute('uv') as THREE.BufferAttribute
  const k = 1 / RENDER.props.patternUnits
  for (let i = 0; i < pos.count; i++) {
    _n.fromBufferAttribute(nrm, i)
    _p.fromBufferAttribute(pos, i)
    const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z)
    if (ay >= ax && ay >= az) uv.setXY(i, _p.x * k, -_p.z * k)
    else if (ax >= az) uv.setXY(i, _p.z * k, _p.y * k)
    else uv.setXY(i, _p.x * k, _p.y * k)
  }
  uv.needsUpdate = true
}

function specOf(p: PartDef, ctx: Ctx): MaterialSpec {
  const light = ctx.def.light
  return {
    pattern: p.pattern ?? 'plain',
    color: resolveColor(p.color, ctx.palette),
    color2: p.color2 ? resolveColor(p.color2, ctx.palette) : undefined,
    colors: p.colors?.map((c) => resolveColor(c, ctx.palette)),
    cutout: p.cutout || undefined,
    emissive: p.emissive || undefined,
    emissiveColor: p.emissiveColor ? resolveColor(p.emissiveColor, ctx.palette) : undefined,
    emissiveMap: p.emissiveMap || undefined,
    foliage: p.foliage || undefined,
    sway: (p.foliage && ctx.def.sway) || undefined,
    glossy: p.glossy || undefined,
    opacity: p.opacity,
    mode: p.alwaysOn || (light && !light.nightOnly) ? 'always' : 'night',
  }
}

function buildFromParts(parts: PartDef[], ctx: Ctx, style: PropStyle): PropTemplate {
  const upNormals = style.builder === 'billboard'
  const groups = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; foliage: boolean; sway: boolean }>()
  const foliageGeos: THREE.BufferGeometry[] = []
  parts.forEach((p, i) => {
    const spec = specOf(p, ctx)
    const material = ctx.lib.get(spec)
    let g = groups.get(material)
    if (!g) { g = { geos: [], foliage: !!spec.foliage, sway: !!spec.sway }; groups.set(material, g) }
    const geos = partGeometries(p, ctx, i)
    g.geos.push(...geos)
    if (spec.foliage) foliageGeos.push(...geos)
  })
  // foliage normals bend outward from the canopy centre: soft, rounded lighting instead of facets
  if (upNormals) {
    for (const g of foliageGeos) { const nrm = g.getAttribute('normal') as THREE.BufferAttribute; for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0) }
  } else if (foliageGeos.length) {
    const c = new THREE.Vector3()
    let n = 0
    for (const g of foliageGeos) { const pos = g.getAttribute('position'); for (let i = 0; i < pos.count; i++) { c.x += pos.getX(i); c.y += pos.getY(i); c.z += pos.getZ(i); n++ } }
    c.multiplyScalar(1 / Math.max(1, n))
    const d = new THREE.Vector3()
    for (const g of foliageGeos) {
      const pos = g.getAttribute('position') as THREE.BufferAttribute, nrm = g.getAttribute('normal') as THREE.BufferAttribute
      for (let i = 0; i < pos.count; i++) {
        d.fromBufferAttribute(pos, i).sub(c).normalize()
        _n.fromBufferAttribute(nrm, i).lerp(d, RENDER.props.foliageNormalBlend).normalize()
        nrm.setXYZ(i, _n.x, _n.y, _n.z)
      }
    }
  }
  const out: TemplatePart[] = []
  let height = 0
  for (const [material, g] of groups) {
    const merged = g.geos.length === 1 ? g.geos[0] : mergeGeometries(g.geos, false)
    if (g.geos.length > 1) for (const x of g.geos) x.dispose()
    if (!merged) continue
    merged.computeBoundingBox()
    merged.computeBoundingSphere()
    height = Math.max(height, merged.boundingBox!.max.y)
    out.push({ geometry: merged, material, sway: g.sway, castShadow: (material as THREE.MeshLambertMaterial).opacity >= 1 })
  }
  return {
    parts: out,
    height,
    randomYaw: !!style.randomYaw,
    scaleJitter: style.scaleJitter ?? 0,
    tintJitter: style.tintJitter ?? RENDER.props.defaultTintJitter,
    dispose() { for (const p of out) p.geometry.dispose() },
  }
}

/** Parametric building: plinth, walls, corner trims, roof, door, windows (EMIT glass), chimney, sign, awning. */
function houseParts(s: HouseStyle, ctx: Ctx): PartDef[] {
  const { W, D, H, def } = ctx
  const B = RENDER.props.house
  const nx = (t: number) => t / W, nz = (t: number) => t / D, ny = (t: number) => t / H
  const wallW = W * (1 - 2 * s.inset), wallD = D * (1 - 2 * s.inset)
  const top = s.wallHeight
  const roofH = 1 - top
  const oW = s.overhang * W, oD = s.overhang * D
  const front = wallD / 2
  const parts: PartDef[] = []
  const P = (x: PartDef) => parts.push(x)
  const has = (k: string) => k in ctx.palette
  const wall2 = has('wall2') ? '$wall2' : undefined

  P({ shape: 'box', pos: [0, 0, 0], size: [nx(wallW + B.plinth), ny(B.plinth), nz(wallD + B.plinth)], color: '$base', pattern: s.basePattern })
  P({ shape: 'box', pos: [0, 0, 0], size: [nx(wallW), top, nz(wallD)], color: '$wall', color2: wall2, pattern: s.wallPattern })
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    P({ shape: 'box', pos: [nx(sx * wallW / 2), 0, nz(sz * wallD / 2)], size: [nx(B.cornerTrim), top, nz(B.cornerTrim)], color: '$trim', pattern: 'plain' })
  }
  P({ shape: 'box', pos: [0, top - ny(B.band), 0], size: [nx(wallW + B.bandOut), ny(B.band), nz(wallD + B.bandOut)], color: '$trim', pattern: 'plain' })

  if (s.roof === 'gable') {
    P({ shape: 'prism', pos: [0, top, 0], size: [nx(wallW + 2 * oW), roofH, nz(wallD + 2 * oD)], color: '$roof', pattern: s.roofPattern, ridge: 'x' })
    P({ shape: 'prism', pos: [0, top, 0], size: [nx(wallW) * B.gableFill, roofH * B.gableFill, nz(wallD) * B.gableFill], color: '$wall', color2: wall2, pattern: s.wallPattern, ridge: 'x' })
    P({ shape: 'box', pos: [0, 1 - ny(B.ridgeCap[0] / 2), 0], size: [nx(wallW + 2 * oW + B.bandOut), ny(B.ridgeCap[0]), nz(B.ridgeCap[1])], color: '$trim', pattern: 'plain' })
  } else if (s.roof === 'hip') {
    P({ shape: 'box', pos: [0, top, 0], size: [nx(wallW + 2 * oW), ny(B.eave), nz(wallD + 2 * oD)], color: '$trim', pattern: 'plain' })
    P({ shape: 'pyramid', pos: [0, top + ny(B.eave), 0], size: [nx(wallW + 2 * oW), roofH - ny(B.eave), nz(wallD + 2 * oD)], color: '$roof', pattern: s.roofPattern })
  } else {
    P({ shape: 'box', pos: [0, top, 0], size: [nx(wallW + 2 * oW), ny(B.flatSlab), nz(wallD + 2 * oD)], color: '$roof', pattern: s.roofPattern })
    P({ shape: 'box', pos: [0, top + ny(B.flatSlab), 0], size: [nx(wallW - B.parapet[1]), ny(B.parapet[0]), nz(wallD - B.parapet[1])], color: '$trim', pattern: 'plain' })
  }

  // door: PropDef.door is the tile in front of the facade relative to the anchor tile
  const doorX = doorOffsetX(def)
  const [doorLo, doorHi] = def.doorSpan ?? [0, 0]
  const doorW = Math.max((s.doorWidth ?? B.doorWidth / W) * W, B.doorWidth + doorHi - doorLo)
  const doorH = (s.doorHeight ?? B.doorHeight) * top
  if (doorX !== null) {
    const [fw, fh, fd] = B.doorFrame
    P({ shape: 'box', pos: [nx(doorX), 0, nz(front)], size: [nx(doorW + fw), doorH + ny(fh), nz(fd)], color: '$trim', pattern: 'plain' })
    P({
      shape: 'box', pos: [nx(doorX), 0, nz(front + fd / 2)], size: [nx(doorW), doorH, nz(B.doorDepth)], color: '$door', pattern: s.doorEmissive ? 'glass' : 'vplanks',
      emissive: s.doorEmissive, emissiveColor: s.doorEmissive ? '$glow' : undefined,
    })
    const [sw, sh, sd] = B.doorStep
    P({ shape: 'box', pos: [nx(doorX), 0, nz(front + sd / 2)], size: [nx(doorW + sw), ny(sh), nz(sd)], color: '$base', pattern: 'stone' })
  }

  // windows on the three visible sides
  const win = s.windows
  const winW = win.w * W
  const winH = win.h * top
  const rowGap = win.rows > 1 ? (1 - win.y) / win.rows : 0
  const F = B.windowFrame, WD = B.windowDepth
  const addWindow = (x: number, z: number, y: number, along: boolean) => {
    P({ shape: 'box', pos: [nx(x), y - ny(F / 2), nz(z)], size: [along ? nx(winW + F) : nx(WD * 0.75), winH + ny(F), along ? nz(WD * 0.75) : nz(winW + F)], color: '$frame', pattern: 'plain' })
    P({ shape: 'box', pos: [nx(x), y, nz(z)], size: [along ? nx(winW) : nx(WD), winH, along ? nz(WD) : nz(winW)], color: '$window', pattern: 'glass', emissive: 1, emissiveColor: '$glow', alwaysOn: win.alwaysOn })
    if (along) P({ shape: 'box', pos: [nx(x), y - ny(F / 2 + B.sill[1] / 2), nz(z + B.sill[2] / 2)], size: [nx(winW + B.sill[0]), ny(B.sill[1]), nz(B.sill[2])], color: '$trim', pattern: 'plain' })
  }
  for (let row = 0; row < win.rows; row++) {
    const y = (win.y + row * rowGap) * top
    for (let k = 0; k < win.perSide; k++) {
      const x = -wallW / 2 + (k + 0.5) * wallW / win.perSide
      if (row === 0 && doorX !== null && Math.abs(x - doorX) < doorW / 2 + winW / 2 + F) continue
      addWindow(x, front, y, true)
    }
    const nSide = Math.max(1, Math.round(win.perSide * wallD / wallW))
    for (let k = 0; k < nSide; k++) {
      const z = -wallD / 2 + (k + 0.5) * wallD / nSide
      addWindow(-wallW / 2, z, y, false)
      addWindow(wallW / 2, z, y, false)
    }
  }

  if (s.chimney) {
    const c = s.chimney
    P({ shape: 'box', pos: [c.x, top, c.z], size: [c.w, roofH * B.chimneyRoofShare + c.h, c.w * W / D], color: has('chimney') ? '$chimney' : '$trim', pattern: 'bricks' })
  }
  if (s.sign) {
    const sy = Math.min(top - s.sign.h - ny(B.signGap / 2), doorH + ny(B.signGap))
    P({
      shape: 'box', pos: [doorX !== null ? nx(doorX) : 0, sy, nz(front + B.signDepth / 2)], size: [s.sign.w, s.sign.h, nz(B.signDepth)], color: '$sign', pattern: s.sign.pattern,
      emissive: s.sign.emissive, emissiveColor: '$sign',
    })
  }
  if (s.awning) {
    const a = s.awning
    P({ shape: 'box', pos: [0, a.y * top, nz(front + a.depth * D / 2)], size: [nx(wallW + B.bandOut), ny(B.awningThickness), a.depth], color: a.color, color2: a.color2, pattern: 'stripes', rot: [B.awningTilt, 0, 0], pivot: 'center' })
  }
  if (s.extraParts) parts.push(...s.extraParts)
  return parts
}

function billboardParts(s: BillboardStyle, ctx: Ctx): PartDef[] {
  const parts: PartDef[] = []
  for (let i = 0; i < Math.max(1, s.planes); i++) {
    parts.push({
      shape: 'box', pos: [0, 0, 0], size: [s.width, 1, 0.001 / ctx.D], rot: [0, (i / s.planes) * 180, 0],
      color: s.color, colors: s.colors, pattern: s.pattern, cutout: true, foliage: true,
    })
  }
  return parts
}

/** Procedural template for a prop def + palette variant (variant 0 = base palette). */
export function buildProceduralTemplate(def: PropDef, variant: number, lib: MaterialLibrary): PropTemplate {
  const style = propStyle(def.key)
  const ctx: Ctx = {
    W: def.footprint[0], D: def.footprint[1], H: def.height,
    palette: stylePalette(style, variant), def, lib, seed: hashString(def.key),
  }
  const parts = style.builder === 'house' ? houseParts(style, ctx) : style.builder === 'billboard' ? billboardParts(style, ctx) : style.parts
  return buildFromParts(parts, ctx, style)
}

/** Template from a loaded GLB scene: meshes baked into the prop frame; EMIT_* glow, FOLIAGE sways. */
export function templateFromModel(root: THREE.Object3D, def: PropDef, lib: MaterialLibrary): PropTemplate {
  root.updateMatrixWorld(true)
  const parts: TemplatePart[] = []
  let height = 0
  const light = def.light
  const style = propStyle(def.key)
  const emissiveWeight = style.modelEmissive ?? RENDER.props.modelEmissive
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    height = Math.max(height, geometry.boundingBox!.max.y)
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const material = mats[0]
    const tex = (material as THREE.MeshStandardMaterial).map
    if (tex) configurePixelTexture(tex)
    let sway = false
    if (material.name.startsWith('EMIT_') && 'emissive' in material) {
      const m = material as THREE.MeshStandardMaterial
      if (m.emissive.getHex() === 0) m.emissive.copy(m.color)
      lib.track(m, light && !light.nightOnly ? 'always' : 'night', emissiveWeight)
    } else {
      if (material.name.startsWith('FOLIAGE') && def.sway) {
        if (!material.userData.apWind) { material.userData.apWind = true; applyWind(material, 'glb') }
        sway = true
      }
      if (!material.transparent) applySnowDust(material, true)
    }
    if (lib.occlusion && !material.transparent) applyOcclusion(material)
    const role = Object.entries(RENDER.nature.roles).find(([prefix]) => material.name.startsWith(prefix))?.[1]
    parts.push({ geometry, material, sway, castShadow: true, role })
  })
  return {
    parts,
    height,
    randomYaw: !!style.randomYaw,
    scaleJitter: style.scaleJitter ?? 0,
    tintJitter: style.tintJitter ?? RENDER.props.defaultTintJitter,
    dispose() { for (const p of parts) p.geometry.dispose() },
  }
}

/** Template from a procedural nature model (world/nature.ts): one part per material group, vertex-coloured. */
export function templateFromNature(def: PropDef, model: NatureModel, lib: MaterialLibrary): PropTemplate {
  const parts: TemplatePart[] = []
  const light = def.light
  for (const g of model.groups) {
    const m = g.material
    const spec: MaterialSpec = {
      pattern: m.pattern, color: m.color, color2: m.color2, colors: m.colors, cutout: m.cutout || undefined,
      emissive: m.emissive || undefined, emissiveColor: m.emissiveColor, emissiveMap: m.emissiveMap || undefined,
      foliage: g.foliage || undefined, sway: (g.foliage && def.sway) || undefined, glossy: m.glossy || undefined,
      vertexColors: true, mode: light && !light.nightOnly ? 'always' : 'night',
    }
    const geometry = g.buf.toGeometry(g.flat, g.planarUv, 1 / RENDER.props.patternUnits)
    parts.push({ geometry, material: lib.get(spec), sway: !!spec.sway, castShadow: g.castShadow, role: g.role })
  }
  return {
    parts,
    height: model.height,
    randomYaw: true,
    scaleJitter: 0,
    tintJitter: 0,
    dispose() { for (const p of parts) p.geometry.dispose() },
  }
}
