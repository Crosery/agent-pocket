// Terrain chunk geometry: atlas-mapped top faces with AO + tint vertex colors, textured cliff faces split at
// texture repeats, stepped stairs, cut-away walls, liquid beds, ledge lips, plus separate water / waterfall / lava
// surface meshes. Tiles are read through a TerrainSampler: finite maps are precomputed once, the infinite overworld
// (GameMap.infinite) is cached per world chunk (64² blocks cut from ChunkProvider chunks) and only generated inside
// ensure(), which the streamer runs as a budgeted stage — so chunk borders read the same neighbours on both sides.
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import type { BiomeDef, ChunkProvider, GameMap, LightDef, MapChunk, PropPlacement, TerrainDef } from '../../../shared/types.ts'
import { FIELD_NAMES, RENDER, hexToRgb, uvModeOf, type SurfaceDef } from '../config.ts'
import type { UvRect } from './atlas.ts'
import type { ClimateGrid, ClimateSample } from './climate.ts'
import { hash2, rampOf, rampParam, stairsRamp, valueNoise, type LevelGrid, type StairsRamp } from './coords.ts'

const KIND_NORMAL = 0, KIND_NONE = 1, KIND_WATER = 2, KIND_LAVA = 3, KIND_GLOSSY = 4, KIND_WALL = 5
/** Values of TerrainSampler.kindAt(). */
export const TERRAIN_KIND = { normal: KIND_NORMAL, none: KIND_NONE, water: KIND_WATER, lava: KIND_LAVA, glossy: KIND_GLOSSY, wall: KIND_WALL } as const

/** Tile rect [x0, x1) x [y0, y1). */
export interface TileRect { x0: number; y0: number; x1: number; y1: number }

/** Objects anchored in a tile rect (what the streamed prop / light layers need). */
export interface RectObjects { props: PropPlacement[]; lights: LightDef[] }

/** Per-map tile access shared by chunk building, grass, decor, fringes, climate and heights. */
export interface TerrainSampler {
  readonly map: GameMap
  readonly skirt: number
  /** Tiles with data; null = unbounded (infinite overworld). */
  readonly bounds: TileRect | null
  /** Highest rendered tile top seen so far (world units). */
  readonly maxTop: number
  inside(tx: number, ty: number): boolean
  /** Terrain id (CONTENT.terrain index) or -1 outside the map. */
  terrainId(tx: number, ty: number): number
  terrain(tx: number, ty: number): TerrainDef | null
  /** Elevation level (0 outside). */
  level(tx: number, ty: number): number
  biome(tx: number, ty: number): BiomeDef | null
  kindAt(tx: number, ty: number): number
  /** Nothing rendered here (out of bounds or a 'none' surface such as the void). */
  isVoid(tx: number, ty: number): boolean
  /** Rendered top height (world units) at a local point (lx, lz in 0..1) of a tile. */
  topAt(tx: number, ty: number, lx: number, lz: number): number
  ramp(tx: number, ty: number): StairsRamp | null
  surface(tx: number, ty: number): SurfaceDef | null
  isLiquid(tx: number, ty: number): boolean
  /** Water/lava surface height of a liquid tile. */
  liquidY(tx: number, ty: number): number
  /** Makes the tiles of `rect` readable without generating on access. Infinite maps generate missing world chunks
   * here (at least one per call, then until `deadline`, performance.now ms). True when everything is ready. */
  ensure(rect: TileRect, deadline: number): boolean
  /** True when ensure(rect) would not generate anything. */
  ready(rect: TileRect): boolean
  /** Props / lights anchored in the rect (infinite maps: the rect must be ensured). */
  objects(rect: TileRect): RectObjects
  /** Generates up to `max` missing world chunks around (x, z) within `radius` tiles, nearest / ahead first, until
   * `deadline`. Returns how many were generated (infinite maps; 0 otherwise). */
  prefetch(x: number, z: number, radius: number, velX: number, velZ: number, max: number, deadline: number): number
  /** Drops cached blocks (and asks the provider to drop chunks) farther than `radius` tiles from (x, z). */
  retain(x: number, z: number, radius: number, providerRadius: number): void
  /** Forget cached tiles (core map edited at runtime). */
  invalidate(): void
}

interface SurfaceTables { surf: (SurfaceDef | null)[]; kind: number[]; drop: number[]; stairs: boolean[] }

function surfaceTables(mapKind: GameMap['kind']): SurfaceTables {
  const cfg = RENDER.terrain
  const out: SurfaceTables = { surf: [], kind: [], drop: [], stairs: [] }
  CONTENT.terrain.forEach((t) => {
    const sf = cfg.mapKindSurfaces[mapKind]?.[t.key] ?? cfg.surfaces[t.key] ?? (t.liquid ? cfg.defaultLiquid : null)
    out.surf[t.id] = sf
    out.kind[t.id] = sf?.kind === 'none' ? KIND_NONE : sf?.kind === 'water' ? KIND_WATER : sf?.kind === 'lava' ? KIND_LAVA
      : sf?.kind === 'glossy' ? KIND_GLOSSY : sf?.kind === 'wall' ? KIND_WALL : KIND_NORMAL
    out.drop[t.id] = sf?.kind === 'water' || sf?.kind === 'lava' ? (sf.depth ?? cfg.defaultLiquid.depth ?? 0) : 0
    out.stairs[t.id] = !!t.stairs
  })
  return out
}

/** Stepped top of a stairs tile at local (lx, lz). */
function stairTop(r: StairsRamp, lx: number, lz: number, steps: number, lh: number): number {
  const s = rampParam(r, lx, lz)
  const step = Math.min(steps - 1, Math.max(0, Math.floor(s * steps)))
  return (r.lowLevel + (r.highLevel - r.lowLevel) * (step + 0.5) / steps) * lh
}

/** Smooth walking height (world units) at float tile coords through a sampler (same rule as coords.walkHeight). */
export function sampleWalkHeight(sampler: TerrainSampler, x: number, y: number): number {
  const tx = Math.floor(x), ty = Math.floor(y)
  if (!sampler.inside(tx, ty)) return 0
  const lh = CONTENT.config.world.levelHeight
  const ramp = sampler.ramp(tx, ty)
  if (ramp) {
    const k = Math.min(1, Math.max(0, rampParam(ramp, x - tx, y - ty)))
    return (ramp.lowLevel + (ramp.highLevel - ramp.lowLevel) * k) * lh
  }
  const base = sampler.level(tx, ty) * lh
  const k = sampler.kindAt(tx, ty)
  return k === KIND_WATER || k === KIND_LAVA ? base - RENDER.terrain.liquidDrop : base
}

export function createTerrainSampler(map: GameMap): TerrainSampler {
  return map.infinite ? createInfiniteSampler(map, map.infinite) : createFiniteSampler(map)
}

function createFiniteSampler(map: GameMap): TerrainSampler {
  const cfg = RENDER.terrain
  const lh = CONTENT.config.world.levelHeight
  const n = map.width * map.height
  const kind = new Uint8Array(n)
  const flat = new Float32Array(n)
  const ramps = new Map<number, StairsRamp>()
  // outdoor maps hang their edges deep (hills read as solid ground); rooms and caves are thin floating dioramas
  const skirt = -(map.kind === 'overworld' ? cfg.skirtDepth : cfg.presetSkirtDepth) * lh
  // per terrain id lookups (one pass over a 1024² map must stay cheap)
  const tb = surfaceTables(map.kind)
  const T = map.terrain, E = map.elevation
  const W = map.width, H = map.height
  const inside = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < W && ty < H
  let maxTop = 0
  for (let i = 0; i < n; i++) {
    const tid = T[i]
    const k = tb.kind[tid] ?? KIND_NORMAL
    kind[i] = k
    flat[i] = k === KIND_NONE ? skirt : E[i] * lh - (tb.drop[tid] ?? 0)
    if (tb.stairs[tid]) {
      const r = stairsRamp(map, i % W, Math.floor(i / W))
      if (r) ramps.set(i, r)
    }
  }
  // walls: full height, except walls directly south of open floor (they would hide the room) are cut away
  for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
    const i = ty * W + tx
    if (kind[i] !== KIND_WALL) continue
    const s = tb.surf[T[i]]!
    const north = ty > 0 ? (ty - 1) * W + tx : -1
    const open = north >= 0 && kind[north] !== KIND_WALL && kind[north] !== KIND_NONE && (CONTENT.terrain[T[north]]?.walkable ?? false)
    // a cut-away wall stops just above the floor it would hide (walls may stand on a higher level than that floor)
    flat[i] = open ? Math.min(flat[i], flat[north]) + (s.cutawayHeight ?? 0) : flat[i] + (s.height ?? lh * 3)
  }
  for (let i = 0; i < n; i++) if (kind[i] !== KIND_NONE && flat[i] > maxTop) maxTop = flat[i]
  for (const r of ramps.values()) maxTop = Math.max(maxTop, r.highLevel * lh)
  const steps = Math.max(1, cfg.stairSteps)
  const bounds: TileRect = { x0: 0, y0: 0, x1: W, y1: H }
  const regionBiome = map.regions.map((r) => CONTENT.biomeById[r.biome] ?? null)
  const inRect = (o: { x: number; y: number }, r: TileRect) => o.x >= r.x0 && o.y >= r.y0 && o.x < r.x1 && o.y < r.y1

  const sampler: TerrainSampler = {
    map,
    skirt,
    bounds,
    maxTop,
    inside,
    terrainId(tx, ty) { return inside(tx, ty) ? T[ty * W + tx] : -1 },
    terrain(tx, ty) { return inside(tx, ty) ? CONTENT.terrain[T[ty * W + tx]] ?? null : null },
    level(tx, ty) { return inside(tx, ty) ? E[ty * W + tx] : 0 },
    biome(tx, ty) { return inside(tx, ty) ? regionBiome[map.region[ty * W + tx]] ?? null : null },
    kindAt(tx, ty) { return inside(tx, ty) ? kind[ty * W + tx] : KIND_NONE },
    isVoid(tx, ty) { return sampler.kindAt(tx, ty) === KIND_NONE },
    topAt(tx, ty, lx, lz) {
      if (!inside(tx, ty)) return skirt
      const i = ty * W + tx
      const r = ramps.get(i)
      return r ? stairTop(r, lx, lz, steps, lh) : flat[i]
    },
    ramp(tx, ty) { return inside(tx, ty) ? ramps.get(ty * W + tx) ?? null : null },
    surface(tx, ty) { return inside(tx, ty) ? tb.surf[T[ty * W + tx]] ?? null : null },
    isLiquid(tx, ty) { const k = sampler.kindAt(tx, ty); return k === KIND_WATER || k === KIND_LAVA },
    liquidY(tx, ty) { return sampler.level(tx, ty) * lh - cfg.liquidDrop },
    ensure: () => true,
    ready: () => true,
    objects(r) { return { props: map.props.filter((o) => inRect(o, r)), lights: map.lights.filter((o) => inRect(o, r)) } },
    prefetch: () => 0,
    retain() {},
    invalidate() {},
  }
  return sampler
}

/** One world chunk of the infinite map, decoded for rendering. Walls and stairs ramps are resolved lazily (they read
 * neighbours that may live in another block). */
interface Block {
  readonly cx: number
  readonly cy: number
  readonly ch: MapChunk
  readonly biome: (BiomeDef | null)[]
  readonly kind: Uint8Array
  readonly flat: Float32Array
  /** 0 = not resolved, 1 = no ramp, 2 = ramp in `ramps`. */
  readonly rampState: Uint8Array
  readonly ramps: Map<number, StairsRamp>
}

const BLOCK_BIAS = 0x8000
const blockKey = (cx: number, cy: number) => (cx + BLOCK_BIAS) * 0x10000 + (cy + BLOCK_BIAS)

function createInfiniteSampler(map: GameMap, provider: ChunkProvider): TerrainSampler {
  const cfg = RENDER.terrain
  const lh = CONTENT.config.world.levelHeight
  const S = provider.size
  const skirt = -cfg.skirtDepth * lh
  const tb = surfaceTables(map.kind)
  const steps = Math.max(1, cfg.stairSteps)
  const blocks = new Map<number, Block>()
  let last: Block | null = null
  let maxTop = 0

  function decode(cx: number, cy: number, ch: MapChunk): Block {
    const n = S * S
    const kind = new Uint8Array(n), flat = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const tid = ch.terrain[i]
      const k = tb.kind[tid] ?? KIND_NORMAL
      kind[i] = k
      // walls: NaN = resolved on first read (needs the tile to the north)
      flat[i] = k === KIND_NONE ? skirt : k === KIND_WALL ? NaN : ch.elevation[i] * lh - (tb.drop[tid] ?? 0)
      if (k !== KIND_NONE && flat[i] > maxTop) maxTop = flat[i]
    }
    const biome = ch.regionIds.map((id) => { const r = provider.region(id); return (r && CONTENT.biomeById[r.biome]) ?? null })
    return { cx, cy, ch, biome, kind, flat, rampState: new Uint8Array(n), ramps: new Map() }
  }

  /** Block holding tile (tx, ty); generates its world chunk when missing (callers ensure() first to stay in budget). */
  function blockOf(tx: number, ty: number): Block {
    const cx = Math.floor(tx / S), cy = Math.floor(ty / S)
    if (last && last.cx === cx && last.cy === cy) return last
    const k = blockKey(cx, cy)
    let b = blocks.get(k)
    if (!b) { b = decode(cx, cy, provider.chunk(cx, cy)); blocks.set(k, b) }
    last = b
    return b
  }
  const idx = (b: Block, tx: number, ty: number) => (ty - b.cy * S) * S + (tx - b.cx * S)

  const grid: LevelGrid = {
    inside: () => true,
    level: (tx, ty) => { const b = blockOf(tx, ty); return b.ch.elevation[idx(b, tx, ty)] },
    stairs: (tx, ty) => { const b = blockOf(tx, ty); return tb.stairs[b.ch.terrain[idx(b, tx, ty)]] === true },
  }

  function rampAt(tx: number, ty: number): StairsRamp | null {
    const b = blockOf(tx, ty)
    const i = idx(b, tx, ty)
    const st = b.rampState[i]
    if (st === 1) return null
    if (st === 2) return b.ramps.get(i) ?? null
    if (!tb.stairs[b.ch.terrain[i]]) { b.rampState[i] = 1; return null }
    const r = rampOf(grid, tx, ty)
    // blockOf() above may have switched `last`; b is still the right block
    b.rampState[i] = r ? 2 : 1
    if (r) { b.ramps.set(i, r); maxTop = Math.max(maxTop, r.highLevel * lh) }
    return r
  }

  function flatAt(tx: number, ty: number): number {
    const b = blockOf(tx, ty)
    const i = idx(b, tx, ty)
    const v = b.flat[i]
    if (!Number.isNaN(v)) return v
    const tid = b.ch.terrain[i]
    const s = tb.surf[tid]!
    const base = b.ch.elevation[i] * lh
    const nk = sampler.kindAt(tx, ty - 1)
    const open = nk !== KIND_WALL && nk !== KIND_NONE && (sampler.terrain(tx, ty - 1)?.walkable ?? false)
    const out = open ? Math.min(base, flatAt(tx, ty - 1)) + (s.cutawayHeight ?? 0) : base + (s.height ?? lh * 3)
    b.flat[i] = out
    return out
  }

  /** World chunks overlapping a tile rect. */
  function chunksOf(r: TileRect, f: (cx: number, cy: number) => boolean | void): boolean {
    const c0 = Math.floor(r.x0 / S), c1 = Math.floor((r.x1 - 1) / S)
    const r0 = Math.floor(r.y0 / S), r1 = Math.floor((r.y1 - 1) / S)
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) if (f(cx, cy) === false) return false
    return true
  }
  const have = (cx: number, cy: number) => blocks.has(blockKey(cx, cy)) || provider.peek(cx, cy) !== null
  const take = (cx: number, cy: number) => { if (!blocks.has(blockKey(cx, cy))) blockOf(cx * S, cy * S) }
  const inRect = (o: { x: number; y: number }, r: TileRect) => o.x >= r.x0 && o.y >= r.y0 && o.x < r.x1 && o.y < r.y1

  const sampler: TerrainSampler = {
    map,
    skirt,
    bounds: null,
    get maxTop() { return maxTop },
    inside: () => true,
    terrainId(tx, ty) { const b = blockOf(tx, ty); return b.ch.terrain[idx(b, tx, ty)] },
    terrain(tx, ty) { const b = blockOf(tx, ty); return CONTENT.terrain[b.ch.terrain[idx(b, tx, ty)]] ?? null },
    level(tx, ty) { const b = blockOf(tx, ty); return b.ch.elevation[idx(b, tx, ty)] },
    biome(tx, ty) { const b = blockOf(tx, ty); return b.biome[b.ch.region[idx(b, tx, ty)]] ?? null },
    kindAt(tx, ty) { const b = blockOf(tx, ty); return b.kind[idx(b, tx, ty)] },
    isVoid(tx, ty) { return sampler.kindAt(tx, ty) === KIND_NONE },
    topAt(tx, ty, lx, lz) {
      const r = rampAt(tx, ty)
      return r ? stairTop(r, lx, lz, steps, lh) : flatAt(tx, ty)
    },
    ramp: rampAt,
    surface(tx, ty) { const b = blockOf(tx, ty); return tb.surf[b.ch.terrain[idx(b, tx, ty)]] ?? null },
    isLiquid(tx, ty) { const k = sampler.kindAt(tx, ty); return k === KIND_WATER || k === KIND_LAVA },
    liquidY(tx, ty) { return sampler.level(tx, ty) * lh - cfg.liquidDrop },
    ensure(r, deadline) {
      let made = 0
      return chunksOf(r, (cx, cy) => {
        if (blocks.has(blockKey(cx, cy))) return true
        if (made > 0 && performance.now() > deadline && provider.peek(cx, cy) === null) return false
        if (provider.peek(cx, cy) === null) made++
        take(cx, cy)
        return true
      })
    },
    ready(r) { return chunksOf(r, (cx, cy) => have(cx, cy)) },
    objects(r) {
      const out: RectObjects = { props: [], lights: [] }
      chunksOf(r, (cx, cy) => {
        const ch = blockOf(cx * S, cy * S).ch
        for (const o of ch.props) if (inRect(o, r)) out.props.push(o)
        for (const o of ch.lights) if (inRect(o, r)) out.lights.push(o)
      })
      return out
    },
    prefetch(x, z, radius, velX, velZ, max, deadline) {
      const c0 = Math.floor((x - radius) / S), c1 = Math.floor((x + radius) / S)
      const r0 = Math.floor((z - radius) / S), r1 = Math.floor((z + radius) / S)
      const sp = Math.hypot(velX, velZ)
      const todo: { cx: number; cy: number; p: number }[] = []
      for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
        if (have(cx, cy)) continue
        const mx = Math.max(cx * S, Math.min(x, (cx + 1) * S)), mz = Math.max(cy * S, Math.min(z, (cy + 1) * S))
        const d = Math.hypot(mx - x, mz - z)
        if (d > radius) continue
        const ahead = sp > 1e-3 && d > 1e-3 ? ((mx - x) * velX + (mz - z) * velZ) / (d * sp) : 0
        todo.push({ cx, cy, p: d * (1 - 0.5 * ahead) })
      }
      todo.sort((a, b) => a.p - b.p)
      let made = 0
      for (const t of todo) {
        if (made >= max || (made > 0 && performance.now() > deadline)) break
        provider.chunk(t.cx, t.cy)
        made++
      }
      return made
    },
    retain(x, z, radius, providerRadius) {
      const far = (cx: number, cy: number, rad: number) => Math.hypot((cx + 0.5) * S - x, (cy + 0.5) * S - z) > rad + S * 0.7072
      for (const [k, b] of blocks) if (far(b.cx, b.cy, radius)) { blocks.delete(k); if (last === b) last = null }
      provider.retain([{ x, y: z }], providerRadius)
    },
    invalidate() { blocks.clear(); last = null },
  }
  return sampler
}

// ---------------------------------------------------------------------------
// Geometry builder
// ---------------------------------------------------------------------------

class Buf {
  pos: number[] = []
  nrm: number[] = []
  uv: number[] = []
  col: number[] = []
  idx: number[] = []
  get count() { return this.pos.length / 3 }
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: number, cr = c, cg = c, cb = c): void {
    this.pos.push(x, y, z)
    this.nrm.push(nx, ny, nz)
    this.uv.push(u, v)
    this.col.push(cr, cg, cb)
  }
  quad(): void {
    const b = this.count - 4
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
}

export interface ChunkGeometry {
  /** Groups: 0 = matte (Lambert), 1 = glossy (Phong). */
  solid: THREE.BufferGeometry | null
  water: THREE.BufferGeometry | null
  /** Vertical water sheets where water drops to lower water (attributes: position, aFall = [along, depth from top, height]). */
  falls: THREE.BufferGeometry | null
  lava: THREE.BufferGeometry | null
}

export interface ChunkContext {
  sampler: TerrainSampler
  rect(key: string): UvRect
  /** Climate fields for terrain tints (render.json terrain.fieldTint); omitted = brightness noise only. */
  climate?: ClimateGrid | null
}

/**
 * Vertex colour of terrain `key` at world (x, z): brightness noise (terrain.tintVariation) times the per-key climate
 * multipliers of terrain.fieldTint (dry grass turns straw-yellow, lush grass deepens, leaf litter in autumn patches...).
 */
export function terrainTint(key: string, x: number, z: number, climate: ClimateGrid | null, out: number[] = [1, 1, 1], cs?: ClimateSample): number[] {
  const cfg = RENDER.terrain
  const k = 1 + cfg.tintVariation * (valueNoise(x * cfg.tintScale, z * cfg.tintScale, 7) * 2 - 1)
    + cfg.tintVariation * 0.35 * (hash2(Math.floor(x * 2), Math.floor(z * 2), 3) - 0.5)
  out[0] = k; out[1] = k; out[2] = k
  const ft = cfg.fieldTint[key]
  if (ft?.base) { out[0] *= ft.base[0]; out[1] *= ft.base[1]; out[2] *= ft.base[2] }
  if (!ft || !climate) return out
  const c = climate.sampleAll(x, z, cs)
  for (const f of FIELD_NAMES) {
    const m = ft[f]
    if (!m) continue
    const w = f === 'lush' ? 1 - c.dry : c[f]
    out[0] *= 1 + (m[0] - 1) * w; out[1] *= 1 + (m[1] - 1) * w; out[2] *= 1 + (m[2] - 1) * w
  }
  return out
}

function toGeometry(groups: Buf[]): THREE.BufferGeometry | null {
  const total = groups.reduce((s, b) => s + b.count, 0)
  if (!total) return null
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), uv = new Float32Array(total * 2), col = new Float32Array(total * 3)
  const idxCount = groups.reduce((s, b) => s + b.idx.length, 0)
  const idx = total > 65535 ? new Uint32Array(idxCount) : new Uint16Array(idxCount)
  const geo = new THREE.BufferGeometry()
  let v = 0, ii = 0
  groups.forEach((b, gi) => {
    pos.set(b.pos, v * 3); nrm.set(b.nrm, v * 3); uv.set(b.uv, v * 2); col.set(b.col, v * 3)
    for (let k = 0; k < b.idx.length; k++) idx[ii + k] = b.idx[k] + v
    if (b.idx.length) geo.addGroup(ii, b.idx.length, gi)
    v += b.count
    ii += b.idx.length
  })
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  geo.computeBoundingSphere()
  geo.computeBoundingBox()
  return geo
}

const DIRS = [
  { dx: 0, dy: 1, nx: 0, nz: 1 },   // south
  { dx: 0, dy: -1, nx: 0, nz: -1 }, // north
  { dx: 1, dy: 0, nx: 1, nz: 0 },   // east
  { dx: -1, dy: 0, nx: -1, nz: 0 }, // west
] as const

export function buildChunk(ctx: ChunkContext, cx: number, cy: number, size: number): ChunkGeometry {
  const { sampler } = ctx
  const cfg = RENDER.terrain
  const ledgeCfg = cfg.ledge
  const steps = Math.max(1, cfg.stairSteps)
  const matte = new Buf(), glossy = new Buf()
  const water = { pos: [] as number[], shore: [] as number[], deep: [] as number[], idx: [] as number[] }
  const lava = { pos: [] as number[], idx: [] as number[] }
  const falls = { pos: [] as number[], fall: [] as number[], idx: [] as number[] }
  const wallTopDefault = hexToRgb(cfg.wallTopColor)
  const wallTops = new Map<string, readonly number[]>()
  const wallTopOf = (s: SurfaceDef | null) => {
    if (!s?.topColor) return wallTopDefault
    let c = wallTops.get(s.topColor)
    if (!c) { c = hexToRgb(s.topColor); wallTops.set(s.topColor, c) }
    return c
  }
  /** Whether tile-space cell (a, b) samples texture `key` flipped along its first axis (see terrain.uvVariation). */
  const flipped = (key: string, a: number, b: number, salt: number) => {
    const mode = uvModeOf(key)
    return mode === 'mirror' ? (a & 1) === 1 : mode === 'flip' ? hash2(a, b, salt) < 0.5 : false
  }
  const EPS = 1e-3

  const climate = ctx.climate ?? null
  const _rgb = [1, 1, 1]
  const _cs: ClimateSample = { dry: 0, autumn: 0, blossom: 0, snow: 0 }
  const WHITE = [1, 1, 1] as const

  const cliffKey = (tx: number, ty: number) => sampler.biome(tx, ty)?.cliff ?? cfg.defaultCliff

  /** Vertical face along a horizontal segment p->q (world xz) between heights yb..yt, facing (nx,nz). */
  function vface(b: Buf, px: number, pz: number, qx: number, qz: number, yt: number, yb: number, nx: number, nz: number,
    key: string, u0f: number, u1f: number, flipU: boolean): void {
    if (yt - yb < EPS) return
    // order endpoints so the quad winds toward the normal
    if ((qx - px) * nz + (qz - pz) * -nx < 0) { [px, pz, qx, qz] = [qx, qz, px, pz]; [u0f, u1f] = [1 - u1f, 1 - u0f] }
    const r = ctx.rect(key)
    const uA = flipU ? r.u1 - (r.u1 - r.u0) * u0f : r.u0 + (r.u1 - r.u0) * u0f
    const uB = flipU ? r.u1 - (r.u1 - r.u0) * u1f : r.u0 + (r.u1 - r.u0) * u1f
    const shadeAt = (y: number) => cfg.cliffBottomShade + (cfg.cliffTopLight - cfg.cliffBottomShade) * ((y - yb) / (yt - yb))
    // split at texture repeats measured from the top so lips/edges of cliff textures line up with the brink
    let d0 = 0
    const total = yt - yb
    while (d0 < total - EPS) {
      const k = Math.floor(d0 + EPS)
      const d1 = Math.min(total, k + 1)
      const f0 = d0 - k, f1 = d1 - k
      const mirror = uvModeOf(key) === 'mirror' && (k & 1) === 1
      const vTop = mirror ? r.v0 + (r.v1 - r.v0) * f0 : r.v1 - (r.v1 - r.v0) * f0
      const vBot = mirror ? r.v0 + (r.v1 - r.v0) * f1 : r.v1 - (r.v1 - r.v0) * f1
      const ya = yt - d0, yb2 = yt - d1
      const ca = shadeAt(ya), cb = shadeAt(yb2)
      b.vert(px, ya, pz, nx, 0, nz, uA, vTop, ca)
      b.vert(px, yb2, pz, nx, 0, nz, uA, vBot, cb)
      b.vert(qx, yb2, qz, nx, 0, nz, uB, vBot, cb)
      b.vert(qx, ya, qz, nx, 0, nz, uB, vTop, ca)
      b.quad()
      d0 = d1
    }
  }

  /** Horizontal face over local rect [lx0,lx1]x[lz0,lz1] of tile (tx,ty) at height y; colour = ao x climate tint of tintKey x rgb. */
  function hface(b: Buf, tx: number, ty: number, lx0: number, lz0: number, lx1: number, lz1: number, y: number, key: string, tintKey: string,
    ao: ((x: number, z: number) => number) | null, rgb: readonly number[] = WHITE): void {
    const r = ctx.rect(key)
    const fu = flipped(key, tx, ty, 41), fv = flipped(key, ty, tx, 43)
    const U = (lx: number) => (fu ? r.u1 - (r.u1 - r.u0) * lx : r.u0 + (r.u1 - r.u0) * lx)
    const V = (lz: number) => (fv ? r.v0 + (r.v1 - r.v0) * lz : r.v1 - (r.v1 - r.v0) * lz)
    const x0 = tx + lx0, x1 = tx + lx1, z0 = ty + lz0, z1 = ty + lz1
    const push = (x: number, z: number, lx: number, lz: number) => {
      const k = ao ? ao(x, z) : 1
      const t = terrainTint(tintKey, x, z, climate, _rgb, _cs)
      b.vert(x, y, z, 0, 1, 0, U(lx), V(lz), k, k * t[0] * rgb[0], k * t[1] * rgb[1], k * t[2] * rgb[2])
    }
    push(x0, z0, lx0, lz0)
    push(x0, z1, lx0, lz1)
    push(x1, z1, lx1, lz1)
    push(x1, z0, lx1, lz0)
    b.quad()
  }

  /** Top texture of a ledge tile: the ground it belongs to (most common flat, non-ledge neighbour at its level), so
   * only the lip marks the hop-down; render.json terrain.ledge.tops / the ledge's own key as fallbacks. */
  function ledgeTop(tx: number, ty: number, own: string): string {
    const e = sampler.level(tx, ty)
    let best: string | null = null, bestN = 0
    const seen = new Map<string, number>()
    for (const d of DIRS) {
      const nx = tx + d.dx, ny = ty + d.dy
      const k = sampler.kindAt(nx, ny)
      if ((k !== KIND_NORMAL && k !== KIND_GLOSSY) || sampler.level(nx, ny) !== e || sampler.ramp(nx, ny)) continue
      const nt = sampler.terrain(nx, ny)
      if (!nt || nt.ledge || nt.tallGrass) continue
      const n = (seen.get(nt.key) ?? 0) + 1
      seen.set(nt.key, n)
      if (n > bestN) { best = nt.key; bestN = n }
    }
    return best ?? ledgeCfg.tops[own] ?? own
  }

  /** Overhanging lip along the drop edge of a ledge tile (reads as a one-way hop-down, not a cliff). */
  function lip(tx: number, ty: number, d: (typeof DIRS)[number], top: number, key: string): void {
    const L = ledgeCfg
    const o = L.lipOut, y = top + L.lipRaise, yb = y - L.lipHeight
    const shade = [L.lipShade, L.lipShade, L.lipShade]
    // edge segment on the drop side, pushed out by the overhang
    let ax: number, az: number, bx: number, bz: number
    if (d.dx !== 0) { ax = bx = tx + (d.dx > 0 ? 1 + o : -o); az = ty; bz = ty + 1 }
    else { az = bz = ty + (d.dy > 0 ? 1 + o : -o); ax = tx; bx = tx + 1 }
    // top strip from the tile edge outwards (lx/lz in tile space so the texture continues from the tile top)
    const ex = d.dx > 0 ? 1 : 0, ez = d.dy > 0 ? 1 : 0
    if (d.dx !== 0) hface(matte, tx, ty, Math.min(ex, ex + d.dx * o), 0, Math.max(ex, ex + d.dx * o), 1, y, key, key, null, shade)
    else hface(matte, tx, ty, 0, Math.min(ez, ez + d.dy * o), 1, Math.max(ez, ez + d.dy * o), y, key, key, null, shade)
    vface(matte, ax, az, bx, bz, y, yb, d.nx, d.nz, key, 0, 1, false)
  }

  /** Waterfall sheet on the edge between water tile (tx, ty) and the lower water tile in direction d. */
  function fall(tx: number, ty: number, d: (typeof DIRS)[number], yTop: number, yBot: number): void {
    const F = RENDER.water.falls
    const o = F.offset
    let ax: number, az: number, bx: number, bz: number
    if (d.dx !== 0) { ax = bx = tx + (d.dx > 0 ? 1 + o : -o); az = ty; bz = ty + 1 }
    else { az = bz = ty + (d.dy > 0 ? 1 + o : -o); ax = tx; bx = tx + 1 }
    if ((bx - ax) * d.nz + (bz - az) * -d.nx < 0) { [ax, az, bx, bz] = [bx, bz, ax, az] }
    const h = yTop - yBot + F.overlap
    const base = falls.pos.length / 3
    const alongA = d.dx !== 0 ? az : ax, alongB = d.dx !== 0 ? bz : bx
    falls.pos.push(ax, yTop + F.crest, az, ax, yBot - F.overlap, az, bx, yBot - F.overlap, bz, bx, yTop + F.crest, bz)
    falls.fall.push(alongA, 0, h, alongA, h, h, alongB, h, h, alongB, 0, h)
    falls.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  const x0 = cx * size, y0 = cy * size
  const B = sampler.bounds
  const x1 = B ? Math.min(B.x1, x0 + size) : x0 + size, y1 = B ? Math.min(B.y1, y0 + size) : y0 + size

  for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) {
    const kind = sampler.kindAt(tx, ty)
    if (kind === KIND_NONE) continue
    const t = sampler.terrain(tx, ty)!
    const surf = sampler.surface(tx, ty)
    const ramp = sampler.ramp(tx, ty)
    const topKey = (kind === KIND_WATER || kind === KIND_LAVA) ? (surf?.bed ?? t.key) : t.ledge && !ramp ? ledgeTop(tx, ty, t.key) : t.key
    const top = sampler.topAt(tx, ty, 0.5, 0.5)
    const b = kind === KIND_GLOSSY ? glossy : matte

    // corner AO: occluders are neighbours whose top is above ours
    const occ = (dx: number, dy: number) => (sampler.topAt(tx + dx, ty + dy, 0.5, 0.5) > top + 0.05 ? 1 : 0)
    const ao = (sx: number, sy: number) => {
      const a = occ(sx, 0), c = occ(0, sy), d = occ(sx, sy)
      const level = a && c ? 0 : 3 - (a + c + d)
      return 1 - cfg.aoStrength * (3 - level) / 3
    }
    const cornerAo = (x: number, z: number) => ao(x < tx + 0.5 ? -1 : 1, z < ty + 0.5 ? -1 : 1)

    if (ramp) {
      // stepped treads + internal risers
      for (let i = 0; i < steps; i++) {
        const sA = i / steps, sB = (i + 1) / steps
        const lo = ramp.dir > 0 ? sA : 1 - sB, hi = ramp.dir > 0 ? sB : 1 - sA
        const [lx0, lz0, lx1, lz1] = ramp.axis === 'x' ? [lo, 0, hi, 1] : [0, lo, 1, hi]
        const h = sampler.topAt(tx, ty, (lx0 + lx1) / 2, (lz0 + lz1) / 2)
        hface(matte, tx, ty, lx0, lz0, lx1, lz1, h, t.key, t.key, null)
        if (i > 0) {
          const prev = sampler.topAt(tx, ty, ramp.axis === 'x' ? (ramp.dir > 0 ? lx0 - 0.01 : lx1 + 0.01) : 0.5, ramp.axis === 'y' ? (ramp.dir > 0 ? lz0 - 0.01 : lz1 + 0.01) : 0.5)
          const bnd = ramp.dir > 0 ? sA : 1 - sA
          if (ramp.axis === 'x') {
            const wx = tx + bnd
            vface(matte, wx, ty, wx, ty + 1, h, prev, -ramp.dir, 0, t.key, 0, 1, false)
          } else {
            const wz = ty + bnd
            vface(matte, tx, wz, tx + 1, wz, h, prev, 0, -ramp.dir, t.key, 0, 1, false)
          }
        }
      }
    } else if (kind === KIND_WALL) {
      hface(matte, tx, ty, 0, 0, 1, 1, top, surf?.top ?? t.key, t.key, null, wallTopOf(surf))
    } else {
      hface(b, tx, ty, 0, 0, 1, 1, top, topKey, topKey, cornerAo)
    }

    // side faces toward lower neighbours (segmented when stairs are involved)
    for (const d of DIRS) {
      const nx = tx + d.dx, ny = ty + d.dy
      const segs = ramp || sampler.ramp(nx, ny) ? steps : 1
      const sideKey = kind === KIND_WALL ? (surf?.face === '$cliff' ? cliffKey(tx, ty) : surf?.face ?? t.key)
        : (kind === KIND_WATER || kind === KIND_LAVA) ? topKey : cliffKey(tx, ty)
      for (let j = 0; j < segs; j++) {
        const a = j / segs, c = (j + 1) / segs, m = (a + c) / 2
        // local sample points: just inside our edge, and just inside the neighbour's facing edge
        const selfL = d.dx !== 0 ? [d.dx > 0 ? 0.999 : 0.001, m] : [m, d.dy > 0 ? 0.999 : 0.001]
        const nbL = d.dx !== 0 ? [d.dx > 0 ? 0.001 : 0.999, m] : [m, d.dy > 0 ? 0.001 : 0.999]
        const hs = sampler.topAt(tx, ty, selfL[0], selfL[1])
        const hn = sampler.topAt(nx, ny, nbL[0], nbL[1])
        if (hs <= hn + EPS) continue
        let px: number, pz: number, qx: number, qz: number
        if (d.dx !== 0) { px = qx = tx + (d.dx > 0 ? 1 : 0); pz = ty + a; qz = ty + c }
        else { pz = qz = ty + (d.dy > 0 ? 1 : 0); px = tx + a; qx = tx + c }
        const along = d.dx !== 0 ? ty : tx
        const face = t.ledge && segs === 1 ? ledgeCfg.faces[t.key] ?? sideKey : sideKey
        vface(matte, px, pz, qx, qz, hs, hn, d.nx, d.nz, face, a, c, flipped(face, along, d.dx !== 0 ? tx : ty, 47))
      }
      // one-way ledge: a lip over a drop of exactly one level toward a walkable tile
      if (t.ledge && !ramp && sampler.level(nx, ny) === sampler.level(tx, ty) - 1 && !sampler.isLiquid(nx, ny) && !sampler.ramp(nx, ny)) lip(tx, ty, d, top, topKey)
      // water dropping to lower water: animated sheet over the bed's cliff face
      if (kind === KIND_WATER && sampler.kindAt(nx, ny) === KIND_WATER) {
        const yN = sampler.liquidY(nx, ny), yS = sampler.liquidY(tx, ty)
        if (yS - yN > EPS) fall(tx, ty, d, yS, yN)
      }
    }

    if (kind === KIND_WATER || kind === KIND_LAVA) {
      const y = sampler.liquidY(tx, ty)
      const corners: [number, number][] = [[tx, ty], [tx, ty + 1], [tx + 1, ty + 1], [tx + 1, ty]]
      if (kind === KIND_WATER) {
        const base = water.pos.length / 3
        for (const [ci, cj] of corners) {
          let land = 0, deepSum = 0, liquid = 0
          for (const [ox, oy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
            const qx = ci + ox, qy = cj + oy
            if (!sampler.inside(qx, qy)) { liquid++; deepSum += surf?.deep ?? cfg.defaultLiquid.deep ?? 0; continue }
            // the pool under a waterfall foams like a shore
            if (sampler.isLiquid(qx, qy) && sampler.level(qx, qy) <= sampler.level(tx, ty)) { liquid++; deepSum += sampler.surface(qx, qy)?.deep ?? cfg.defaultLiquid.deep ?? 0 }
            else land++
          }
          water.pos.push(ci, y, cj)
          water.shore.push(Math.min(1, land / 2))
          water.deep.push(liquid ? deepSum / liquid : 0)
        }
        water.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      } else {
        const base = lava.pos.length / 3
        for (const [ci, cj] of corners) lava.pos.push(ci, y, cj)
        lava.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      }
    }
  }

  let waterGeo: THREE.BufferGeometry | null = null
  if (water.idx.length) {
    waterGeo = new THREE.BufferGeometry()
    waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(water.pos, 3))
    waterGeo.setAttribute('aShore', new THREE.Float32BufferAttribute(water.shore, 1))
    waterGeo.setAttribute('aDeep', new THREE.Float32BufferAttribute(water.deep, 1))
    waterGeo.setIndex(water.idx)
    waterGeo.computeBoundingSphere()
  }
  let fallsGeo: THREE.BufferGeometry | null = null
  if (falls.idx.length) {
    fallsGeo = new THREE.BufferGeometry()
    fallsGeo.setAttribute('position', new THREE.Float32BufferAttribute(falls.pos, 3))
    fallsGeo.setAttribute('aFall', new THREE.Float32BufferAttribute(falls.fall, 3))
    fallsGeo.setIndex(falls.idx)
    fallsGeo.computeBoundingSphere()
  }
  let lavaGeo: THREE.BufferGeometry | null = null
  if (lava.idx.length) {
    lavaGeo = new THREE.BufferGeometry()
    lavaGeo.setAttribute('position', new THREE.Float32BufferAttribute(lava.pos, 3))
    lavaGeo.setIndex(lava.idx)
    lavaGeo.computeBoundingSphere()
  }
  return { solid: toGeometry([matte, glossy]), water: waterGeo, falls: fallsGeo, lava: lavaGeo }
}

/** Height particles settle on at a tile: liquid surface, void level or the tile top (world units). */
function groundHeight(sampler: TerrainSampler, tx: number, ty: number): number {
  const k = sampler.kindAt(tx, ty)
  return sampler.isLiquid(tx, ty) ? sampler.liquidY(tx, ty)
    : k === KIND_NONE ? sampler.level(tx, ty) * CONTENT.config.world.levelHeight
    : sampler.topAt(tx, ty, 0.5, 0.5)
}

/** Float heightmap (tile-top world heights) for GPU particles that settle on the ground. */
export interface HeightField {
  readonly texture: THREE.DataTexture
  /** Texels per side (texture spans size x size tiles). */
  readonly size: THREE.Vector2
  /** Toroidal window (infinite maps): tile (x, z) lives at texel (x mod N, z mod N); the texture repeats. */
  readonly wrap: boolean
  /** Writes the tiles of a built chunk (rolling window only; finite maps are complete from the start). */
  writeChunk(cx: number, cy: number, chunk: number): void
  /** Uploads pending writes (once per frame). */
  flush(): void
  dispose(): void
}

/**
 * Finite maps: the whole map. Infinite maps: an N x N toroidal window (N = streaming.infinite.heightWindow, a
 * multiple of the render chunk) refreshed per built chunk; N must exceed the streamed diameter so live chunks never alias.
 */
export function createHeightField(sampler: TerrainSampler, window: number): HeightField {
  const B = sampler.bounds
  const W = B ? B.x1 - B.x0 : window, H = B ? B.y1 - B.y0 : window
  const data = new Float32Array(W * H)
  if (B) for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) data[ty * W + tx] = groundHeight(sampler, tx, ty)
  const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.FloatType)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  if (!B) tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.needsUpdate = true
  let dirty = false
  const mod = (v: number, n: number) => ((v % n) + n) % n
  return {
    texture: tex,
    size: new THREE.Vector2(W, H),
    wrap: !B,
    writeChunk(cx, cy, chunk) {
      if (B) return
      for (let ty = cy * chunk; ty < (cy + 1) * chunk; ty++) {
        const row = mod(ty, H) * W
        for (let tx = cx * chunk; tx < (cx + 1) * chunk; tx++) data[row + mod(tx, W)] = groundHeight(sampler, tx, ty)
      }
      dirty = true
    },
    flush() { if (dirty) { dirty = false; tex.needsUpdate = true } },
    dispose() { tex.dispose() },
  }
}

/** Whole-map heightmap of a finite map (kept for callers of the old API). */
export function createHeightTexture(sampler: TerrainSampler): THREE.DataTexture {
  return createHeightField(sampler, 0).texture
}
