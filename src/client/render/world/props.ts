// Prop placement, streamed per terrain chunk: one InstancedMesh per (template part) per chunk so frustum culling and
// LRU disposal work on a 1024² overworld. Nature props (render.json "nature.props") pick one of K procedural
// variants (world/nature.ts) or the GLB by a tile hash and get per-instance free yaw, xyz scale jitter, lean and a
// climate-driven tint (autumn / blossom / dry / lush patches). Other props keep GLB-or-procedural-style templates
// with palette variants. Light sources are precomputed per chunk (stable objects for the light pool).
// Infinite maps (prepare with a TerrainSampler): nothing is indexed up front — each chunk reads the props / lights
// anchored around it from the sampler's world chunks (which the streamer ensured first).
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import type { GameMap, PropDef, PropPlacement } from '../../../shared/types.ts'
import type { AssetStore } from '../../contracts.ts'
import { RENDER, hexToRgb, propStyle, styleVariantCount, type NatureProp, type TintDef } from '../config.ts'
import { range, smoothstep } from '../noise.ts'
import { fieldValue, type ClimateGrid, type ClimateSample } from './climate.ts'
import { footprintCenter, footprintRect, hash2, rotYaw, walkHeight } from './coords.ts'
import type { LightSource } from './lights.ts'
import { generateNature, linearRgb } from './nature.ts'
import { buildProceduralTemplate, createMaterialLibrary, templateFromModel, templateFromNature, type PropTemplate } from './prop-builders.ts'
import { sampleWalkHeight, type TerrainSampler, type TileRect } from './terrain.ts'

/** A swaying canopy of a chunk (leaves fall from it): world position of its base, radius and height in tiles. */
export interface Canopy { x: number; y: number; z: number; r: number; h: number; key: string }

/** A tree gap where a light shaft can fall: ground point, canopy height above it, stable seed. */
export interface ShaftAnchor { x: number; y: number; z: number; h: number; seed: number }

export interface PropChunk { meshes: THREE.InstancedMesh[]; count: number; canopies: Canopy[]; anchors: ShaftAnchor[] }

export interface PropLayer {
  /** Whole-map mode (battle dioramas): every chunk built by load() lives here. */
  readonly group: THREE.Group
  /** Whole-map mode: light sources of the loaded map. */
  readonly lights: LightSource[]
  /** Whole-map mode: prepare + build every chunk at once (small maps only). */
  load(map: GameMap, onProgress?: (p: number) => void): Promise<void>
  /** Whole-map mode: hide chunks farther than radius from (x, z). */
  cull(x: number, z: number, radius: number): void
  /** Footprint-centre keys (see lightKey) of props that emit light, to drop map.lights derived from them. */
  readonly lightCenters: Set<string>
  /** Indexes the map's placements and light sources by chunk and preloads the GLB models it uses. Infinite maps
   * (map.infinite + sampler) index nothing: chunks read their objects from the sampler on demand. */
  prepare(map: GameMap, climate: ClimateGrid | null, chunkSize: number, sampler?: TerrainSampler | null): Promise<void>
  /** Light sources (props + map.lights) of a chunk; stable objects (infinite maps: fresh objects per call — keep them). */
  lightsOf(cx: number, cy: number): LightSource[]
  /** Tiles of a chunk covered by colliding prop footprints (props anchored up to the largest footprint away). */
  blockedIn(cx: number, cy: number): (tx: number, ty: number) => boolean
  /** Instances of a chunk; null when `deadline` (performance.now ms) passed before a needed template was built. */
  buildChunk(cx: number, cy: number, deadline: number): PropChunk | null
  disposeChunk(c: PropChunk): void
  /** Procedural variants per nature prop (quality). Returns true when it changed (chunks must rebuild). */
  setNatureVariants(n: number): boolean
  setLamps(f: number): void
  setShadows(on: boolean): void
  applyShadows(c: PropChunk): void
  /** Templates built so far (diagnostics). */
  readonly templateCount: number
  clear(): void
  dispose(): void
}

/** The light a prop emits: its props.json light, else the lit-window light render.json lights.windowLights gives it. */
const lightOf = (def: PropDef): PropDef['light'] => def.light ?? RENDER.lights.windowLights[def.key]

/** Half-tile grid key used to match map.lights against prop light positions. */
export const lightKey = (x: number, z: number) => `${Math.round(x * 2)},${Math.round(z * 2)}`

interface VariantRef { id: string; weight: number }

const tintCache = new Map<TintDef, { base: number[]; rules: { colors: number[][] }[] }>()
function tintData(def: TintDef) {
  let d = tintCache.get(def)
  if (!d) {
    d = { base: linearRgb(def.base), rules: (def.fields ?? []).map((r) => ({ colors: r.colors.map(linearRgb) })) }
    tintCache.set(def, d)
  }
  return d
}

/**
 * Per-instance colour multiplier for a part role: ratio of the climate-shifted target colour to the role's base colour,
 * times brightness / hue jitter. `h(salt)` is the instance's deterministic hash.
 */
export function instanceTint(def: TintDef | undefined, c: ClimateSample, h: (salt: number) => number, jitter: number, out: THREE.Color): THREE.Color {
  if (!def) {
    const k = 1 + (h(1) - 0.5) * 2 * jitter
    return out.setRGB(k, k, k)
  }
  const d = tintData(def)
  let r = d.base[0], g = d.base[1], b = d.base[2]
  def.fields?.forEach((rule, i) => {
    const v = fieldValue(c, rule.field) + (h(10 + i) - 0.5) * (rule.spread ?? 0)
    const w = smoothstep(rule.lo ?? 0, rule.hi ?? 1, v) * (rule.amount ?? 1)
    if (w <= 0) return
    const col = d.rules[i].colors[Math.floor(h(20 + i) * d.rules[i].colors.length) % d.rules[i].colors.length]
    r += (col[0] - r) * w; g += (col[1] - g) * w; b += (col[2] - b) * w
  })
  const k = 1 + (h(1) - 0.5) * 2 * (def.jitter ?? jitter)
  const hj = def.hueJitter ?? 0
  return out.setRGB(
    (r / Math.max(d.base[0], 0.004)) * k * (1 + (h(2) - 0.5) * 2 * hj),
    (g / Math.max(d.base[1], 0.004)) * k * (1 + (h(3) - 0.5) * 2 * hj),
    (b / Math.max(d.base[2], 0.004)) * k * (1 + (h(4) - 0.5) * 2 * hj),
  )
}

const ratioCache = new Map<string, readonly number[]>()
/** Linear-space ratio target / base (biome recolours of nature parts). */
function targetRatio(target: string, base: string): readonly number[] {
  const k = `${target}|${base}`
  let r = ratioCache.get(k)
  if (!r) {
    const t = linearRgb(target), b = linearRgb(base)
    r = [t[0] / Math.max(b[0], 0.004), t[1] / Math.max(b[1], 0.004), t[2] / Math.max(b[2], 0.004)]
    ratioCache.set(k, r)
  }
  return r
}

/** Weighted variant pool of a nature prop: K procedural variants + the GLB (when loaded and weighted). */
export function naturePool(cfg: NatureProp, k: number, hasModel: boolean): VariantRef[] {
  const out: VariantRef[] = []
  for (let i = 0; i < Math.max(1, k); i++) out.push({ id: `p${i}`, weight: 1 })
  if (hasModel && (cfg.glbWeight ?? 1) > 0) out.push({ id: 'glb', weight: cfg.glbWeight ?? 1 })
  return out
}

export function pickVariant(pool: VariantRef[], u: number): string {
  const total = pool.reduce((s, v) => s + v.weight, 0)
  let r = u * total
  for (const v of pool) { r -= v.weight; if (r < 0) return v.id }
  return pool[pool.length - 1].id
}

/** `occlusion`: materials get the camera-occlusion cutaway (the overworld view; battle dioramas leave it off). */
export function createPropLayer(assets: AssetStore, opts?: { occlusion?: boolean }): PropLayer {
  const lib = createMaterialLibrary({ occlusion: opts?.occlusion })
  const templates = new Map<string, PropTemplate>()
  const models = new Map<string, THREE.Object3D | null>()
  const lightCenters = new Set<string>()
  let byChunk = new Map<number, PropPlacement[]>()
  let lightsByChunk = new Map<number, LightSource[]>()
  let map: GameMap | null = null
  /** Set for infinite maps: objects come from its world chunks. */
  let source: TerrainSampler | null = null
  /** Tile reads (biome recolours); any map. */
  let tiles: TerrainSampler | null = null
  let climate: ClimateGrid | null = null
  let chunk = 16
  let cols = 1
  let natureK = 1
  let shadows = true

  const group = new THREE.Group()
  group.name = 'props'
  const legacyLights: LightSource[] = []
  const legacyChunks: { c: PropChunk; x: number; z: number }[] = []

  const N = RENDER.nature
  const SH = RENDER.lighting.shafts
  const shaftProps = new Set(SH.props)
  const natureOf = (key: string): NatureProp | undefined => N.props[key]
  /** Biome of a placement's anchor tile when the biome re-models that prop (render.json nature.biomeVariants). */
  const variantBiome = (def: PropDef, p: PropPlacement): string | null => {
    if (!tiles || !N.biomeVariants) return null
    const b = tiles.biome(p.x, p.y)?.id
    return b && N.biomeVariants[b]?.[def.key] ? b : null
  }
  /** Nature recipe of a template key ("<prop>@<biome>#..." = the biome variant). */
  const natureOfKey = (def: PropDef, key: string): NatureProp | undefined => {
    const at = key.indexOf('@')
    return at < 0 ? natureOf(def.key) : N.biomeVariants?.[key.slice(at + 1, key.indexOf('#'))]?.[def.key] ?? natureOf(def.key)
  }
  /** Largest footprint side: how far from its anchor a prop (or its light) can reach. */
  const reach = Object.values(CONTENT.props).reduce((m, d) => Math.max(m, d.footprint[0], d.footprint[1]), 1)
  const groundY = (m: GameMap, x: number, y: number) => (source ? sampleWalkHeight(source, x, y) : walkHeight(m, x, y))

  /** Light source of a light-emitting prop: building lights hang in front of the facade (by the door), others at the
   * footprint centre. */
  function propLight(m: GameMap, p: PropPlacement, def: PropDef): LightSource {
    const c = footprintCenter(p, def)
    const yaw = rotYaw(p.rot)
    const fwd = def.door ? def.footprint[1] / 2 + RENDER.lights.frontOffset : 0
    const lx = c.x + Math.sin(yaw) * fwd, lz = c.z + Math.cos(yaw) * fwd
    const L = lightOf(def)!
    return {
      x: lx, y: groundY(m, p.x, p.y) + L.h, z: lz,
      color: new THREE.Color().setRGB(...hexToRgb(L.color), THREE.SRGBColorSpace),
      intensity: L.intensity, radius: L.radius, nightOnly: L.nightOnly, phase: hash2(p.x, p.y, 5) * 6.283, kind: def.key,
    }
  }
  const mapLight = (m: GameMap, l: GameMap['lights'][number], phase: number): LightSource => ({
    x: l.x, y: groundY(m, l.x, l.y) + l.h, z: l.y,
    color: new THREE.Color().setRGB(...hexToRgb(l.color), THREE.SRGBColorSpace),
    intensity: l.intensity, radius: l.radius, nightOnly: l.nightOnly, phase, kind: 'map',
  })
  const chunkRect = (cx: number, cy: number): TileRect => ({ x0: cx * chunk, y0: cy * chunk, x1: (cx + 1) * chunk, y1: (cy + 1) * chunk })
  const grow = (r: TileRect, w: number, n: number, e: number, s: number): TileRect => ({ x0: r.x0 - w, y0: r.y0 - n, x1: r.x1 + e, y1: r.y1 + s })

  function templateKey(def: PropDef, p: PropPlacement): string {
    const vb = variantBiome(def, p)
    const nat = vb ? N.biomeVariants![vb][def.key] : natureOf(def.key)
    const head = vb ? `${def.key}@${vb}` : def.key
    if (nat) return `${head}#${pickVariant(naturePool(nat, natureK, !!models.get(def.model)), hash2(p.x, p.y, 23))}`
    const nv = styleVariantCount(propStyle(def.key))
    const v = nv > 1 ? (p.variant ?? Math.floor(hash2(p.x, p.y, 17) * nv)) % nv : 0
    return `${def.key}#s${v}`
  }

  function buildTemplate(def: PropDef, key: string): PropTemplate {
    const id = key.slice(key.indexOf('#') + 1)
    const model = models.get(def.model) ?? null
    const nat = natureOfKey(def, key)
    if (nat && id.startsWith('p')) return templateFromNature(def, generateNature(def, nat, Number(id.slice(1))), lib)
    if (model) return templateFromModel(model.clone(true), def, lib)
    return buildProceduralTemplate(def, Number(id.slice(1)) || 0, lib)
  }

  const _q = new THREE.Quaternion()
  const _ql = new THREE.Quaternion()
  const _s = new THREE.Vector3()
  const _p = new THREE.Vector3()
  const _ax = new THREE.Vector3()
  const _m = new THREE.Matrix4()
  const _c = new THREE.Color()
  const _up = new THREE.Vector3(0, 1, 0)
  const _cs: ClimateSample = { dry: 0, autumn: 0, blossom: 0, snow: 0 }

  function clear(): void {
    for (const l of legacyChunks) layer.disposeChunk(l.c)
    legacyChunks.length = 0
    legacyLights.length = 0
    byChunk = new Map()
    lightsByChunk = new Map()
    lightCenters.clear()
    map = null
    source = null
    tiles = null
  }

  const layer: PropLayer = {
    group,
    lights: legacyLights,
    async load(m, onProgress) {
      await layer.prepare(m, null, CONTENT.config.world.chunk)
      const cw = Math.ceil(m.width / chunk), ch = Math.ceil(m.height / chunk)
      for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
        legacyLights.push(...layer.lightsOf(cx, cy))
        const c = layer.buildChunk(cx, cy, Infinity)!
        for (const mesh of c.meshes) group.add(mesh)
        legacyChunks.push({ c, x: (cx + 0.5) * chunk, z: (cy + 0.5) * chunk })
        onProgress?.((cy * cw + cx + 1) / (cw * ch))
      }
    },
    cull(x, z, radius) {
      for (const l of legacyChunks) {
        const vis = Math.hypot(l.x - x, l.z - z) < radius + chunk * 0.75
        for (const m of l.c.meshes) m.visible = vis
      }
    },
    lightCenters,
    get templateCount() { return templates.size },

    async prepare(m, cl, size, sampler) {
      clear()
      map = m
      climate = cl
      chunk = size
      cols = Math.ceil(m.width / size)
      tiles = sampler ?? null
      const used = new Set<string>()
      if (m.infinite && sampler) {
        source = sampler
        // frontier chunks are not known yet: their props reuse the content's models
        for (const p of m.props) { const def = CONTENT.props[p.prop]; if (def) used.add(def.model) }
        if (RENDER.streaming.infinite.preloadAllModels) for (const def of Object.values(CONTENT.props)) used.add(def.model)
        await Promise.all([...used].filter((id) => !models.has(id) && assets.has('models', id)).map(async (id) => {
          models.set(id, await assets.loadModel(id).catch(() => null))
        }))
        return
      }
      const addLight = (x: number, z: number, src: LightSource) => {
        const k = Math.floor(z / size) * cols + Math.floor(x / size)
        let list = lightsByChunk.get(k)
        if (!list) { list = []; lightsByChunk.set(k, list) }
        list.push(src)
      }
      for (const p of m.props) {
        const def = CONTENT.props[p.prop]
        if (!def) continue
        used.add(def.model)
        const k = Math.floor(p.y / size) * cols + Math.floor(p.x / size)
        let list = byChunk.get(k)
        if (!list) { list = []; byChunk.set(k, list) }
        list.push(p)
        if (lightOf(def)) {
          const c = footprintCenter(p, def)
          lightCenters.add(lightKey(c.x, c.z))
          const src = propLight(m, p, def)
          addLight(src.x, src.z, src)
        }
      }
      // the world generator also emits LightDefs for prop lights: keep only the ones props don't already provide
      m.lights.forEach((l, i) => {
        if (lightCenters.has(lightKey(l.x, l.y))) return
        addLight(l.x, l.y, mapLight(m, l, i * 1.37))
      })
      // GLB models load in parallel once (cached across maps)
      await Promise.all([...used].filter((id) => !models.has(id) && assets.has('models', id)).map(async (id) => {
        models.set(id, await assets.loadModel(id).catch(() => null))
      }))
    },

    lightsOf(cx, cy) {
      if (!source || !map) return lightsByChunk.get(cy * cols + cx) ?? []
      // props anchored up to `reach` tiles away can light this chunk; map lights duplicating a prop light are dropped
      const r = chunkRect(cx, cy)
      const near = source.objects(grow(r, reach + 2, reach + 2, reach + 2, reach + 2))
      const inR = (x: number, z: number) => x >= r.x0 && z >= r.y0 && x < r.x1 && z < r.y1
      const out: LightSource[] = []
      const centers = new Set<string>()
      for (const p of near.props) {
        const def = CONTENT.props[p.prop]
        if (!def || !lightOf(def)) continue
        const c = footprintCenter(p, def)
        centers.add(lightKey(c.x, c.z))
        const src = propLight(map, p, def)
        if (inR(src.x, src.z)) out.push(src)
      }
      for (const l of near.lights) if (inR(l.x, l.y) && !centers.has(lightKey(l.x, l.y))) out.push(mapLight(map, l, hash2(l.x, l.y, 7) * 6.283))
      return out
    },

    blockedIn(cx, cy) {
      const r = chunkRect(cx, cy)
      const W = r.x1 - r.x0
      const cells = new Uint8Array(W * (r.y1 - r.y0))
      let list: PropPlacement[]
      if (source) list = source.objects(grow(r, reach, reach, 0, 0)).props
      else {
        list = []
        const k = Math.ceil(reach / chunk)
        for (let y = cy - k; y <= cy; y++) for (let x = cx - k; x <= cx; x++) if (x >= 0 && y >= 0 && x < cols) list.push(...(byChunk.get(y * cols + x) ?? []))
      }
      for (const p of list) {
        const def = CONTENT.props[p.prop]
        if (!def?.collide) continue
        const f = footprintRect(p, def)
        for (let y = Math.max(r.y0, f.y0); y < Math.min(r.y1, f.y0 + f.d); y++) for (let x = Math.max(r.x0, f.x0); x < Math.min(r.x1, f.x0 + f.w); x++) cells[(y - r.y0) * W + (x - r.x0)] = 1
      }
      return (tx, ty) => tx >= r.x0 && ty >= r.y0 && tx < r.x1 && ty < r.y1 && cells[(ty - r.y0) * W + (tx - r.x0)] === 1
    },

    buildChunk(cx, cy, deadline) {
      const out: PropChunk = { meshes: [], count: 0, canopies: [], anchors: [] }
      const list = source ? source.objects(chunkRect(cx, cy)).props : byChunk.get(cy * cols + cx)
      if (!list || !map) return out
      const m = map
      const buckets = new Map<string, { def: PropDef; items: PropPlacement[] }>()
      for (const p of list) {
        const def = CONTENT.props[p.prop]
        if (!def) continue
        const key = templateKey(def, p)
        let b = buckets.get(key)
        if (!b) { b = { def, items: [] }; buckets.set(key, b) }
        b.items.push(p)
      }
      // templates first: bail out (to resume next frame) instead of blowing the frame budget
      for (const [key, b] of buckets) {
        if (templates.has(key)) continue
        if (performance.now() > deadline) return null
        templates.set(key, buildTemplate(b.def, key))
      }
      const candidates: { hv: number; a: ShaftAnchor }[] = []
      for (const [key, b] of buckets) {
        const t = templates.get(key)!
        const nat = natureOfKey(b.def, key)
        const n = b.items.length
        const sheds = !!b.def.sway && t.parts.some((part) => part.sway)
        const matrices = new Float32Array(n * 16)
        const tints = t.parts.map(() => new Float32Array(n * 3))
        b.items.forEach((p, i) => {
          const c = footprintCenter(p, b.def)
          const h = (salt: number) => hash2(p.x, p.y, 101 + salt)
          let y = groundY(m, p.x, p.y)
          if (nat) {
            const I = nat.instance
            const s = (p.scale ?? 1) * range(I.scale, h(0))
            _s.set(s * (1 + (h(1) - 0.5) * 2 * I.scaleXZ), s * (1 + (h(2) - 0.5) * 2 * I.scaleY), s * (1 + (h(3) - 0.5) * 2 * I.scaleXZ))
            _q.setFromAxisAngle(_up, h(4) * Math.PI * 2)
            const a = h(5) * Math.PI * 2
            _ax.set(Math.cos(a), 0, Math.sin(a))
            _ql.setFromAxisAngle(_ax, THREE.MathUtils.degToRad(I.lean * h(6)))
            _q.premultiply(_ql)
            y -= I.sink ?? 0
          } else {
            const yaw = rotYaw(p.rot) + (t.randomYaw ? hash2(p.x, p.y, 3) * Math.PI * 2 : 0)
            const sc = (p.scale ?? 1) * (1 + (hash2(p.x, p.y, 9) - 0.5) * 2 * t.scaleJitter)
            _q.setFromAxisAngle(_up, yaw)
            _s.set(sc, sc, sc)
          }
          _p.set(c.x, y, c.z)
          _m.compose(_p, _q, _s).toArray(matrices, i * 16)
          if (sheds) out.canopies.push({ x: c.x, y, z: c.z, r: Math.max(0.5, Math.min(2.2, b.def.height * 0.38 * _s.x)), h: b.def.height * _s.y, key: b.def.key })
          if (nat) climate?.sampleAll(c.x, c.z, _cs)
          const bt = nat && tiles && N.biomeTints ? N.biomeTints[tiles.biome(Math.floor(c.x), Math.floor(c.z))?.id ?? ''] : undefined
          t.parts.forEach((part, k) => {
            if (nat) instanceTint(part.role ? nat.tints?.[part.role] : undefined, _cs, h, N.jitter, _c)
            else { const v = 1 + (hash2(p.x, p.y, 11) - 0.5) * 2 * t.tintJitter; _c.setRGB(v, v, v) }
            const rt = bt && part.role ? bt[part.role] : undefined
            if (rt) {
              const base = nat?.tints?.[part.role!]?.base
              const mul = rt.colors?.length && base ? targetRatio(rt.colors[Math.floor(h(40) * rt.colors.length) % rt.colors.length], base)
                : rt.mul?.length ? rt.mul[Math.floor(h(40) * rt.mul.length) % rt.mul.length] : null
              const a = rt.amount ?? 1
              if (mul) _c.setRGB(_c.r * (1 + (mul[0] - 1) * a), _c.g * (1 + (mul[1] - 1) * a), _c.b * (1 + (mul[2] - 1) * a))
            }
            tints[k][i * 3] = _c.r; tints[k][i * 3 + 1] = _c.g; tints[k][i * 3 + 2] = _c.b
          })
        })
        t.parts.forEach((part, k) => {
          const mesh = new THREE.InstancedMesh(part.geometry, part.material, n)
          mesh.instanceMatrix.array.set(matrices)
          mesh.instanceMatrix.needsUpdate = true
          mesh.instanceColor = new THREE.InstancedBufferAttribute(tints[k], 3)
          mesh.computeBoundingSphere()
          mesh.castShadow = shadows && part.castShadow
          mesh.receiveShadow = true
          mesh.userData.apCast = part.castShadow
          if (part.sway) mesh.customDepthMaterial = lib.swayDepth
          mesh.name = `prop:${b.def.key}`
          out.meshes.push(mesh)
        })
        out.count += n
        if (shaftProps.has(b.def.key)) for (const p of b.items) {
          const hv = hash2(p.x, p.y, 77)
          if (hv >= SH.density) continue
          const c = footprintCenter(p, b.def)
          const a = hash2(p.x, p.y, 78) * Math.PI * 2, r = SH.jitter * (0.5 + 0.5 * hash2(p.x, p.y, 79))
          candidates.push({ hv, a: { x: c.x + Math.cos(a) * r, y: groundY(m, p.x, p.y), z: c.z + Math.sin(a) * r, h: b.def.height * 0.85 * (p.scale ?? 1), seed: hash2(p.x, p.y, 80) } })
        }
      }
      candidates.sort((u, v) => u.hv - v.hv)
      for (const c of candidates.slice(0, SH.perChunk)) out.anchors.push(c.a)
      return out
    },

    disposeChunk(c) { for (const m of c.meshes) { m.removeFromParent(); m.dispose() } c.meshes.length = 0 },

    setNatureVariants(n) {
      const k = Math.max(1, Math.round(n))
      if (k === natureK) return false
      natureK = k
      return true
    },
    setLamps(f) { lib.setLamps(f) },
    setShadows(on) {
      if (on === shadows) return
      shadows = on
      for (const l of legacyChunks) layer.applyShadows(l.c)
    },
    applyShadows(c) { for (const m of c.meshes) m.castShadow = shadows && !!m.userData.apCast },
    clear,
    dispose() {
      clear()
      for (const t of templates.values()) t.dispose()
      templates.clear()
      lib.dispose()
    },
  }
  return layer
}
