// Macro layout of the overworld (all coordinates already scaled from layout space, see data.ts scaleLayout):
//  zones   warped Voronoi over the authored region control points (+ town claims); `zoneRaw` ignores the sea
//          so border bands continue through the shallows
//  core    distance to the authored points: story areas keep their authored biome, the rest is wilderness
//  climate temperature / moisture / weirdness noise fields biased per zone (climate.json)
//  height  blurred zone levels + relief, wild landforms (hills, ridged mountain ranges, plateaus, canyons),
//          ridges along zone borders, authored peaks
//  sea     authored sea + noisy ocean ring, one continent, authored + procedural surf-only islands,
//          beaches on low coasts, cliffs on 'cliff' zones
//  pads    flattened lakes, towns and POI sites; hydrology (basin lakes, rivers) carves the field
//  levels  slope-limited lower envelope -> integer levels (neighbouring tiles never differ by > 1)
//  biomes  Whittaker-style table over the climate fields in the wilds, authored biome in the core
import { CONTENT } from '../content/index.ts'
import {
  createNoise, fbm, fbm01, latticeSize, ridged, sampleField, smoothstep, upsample, type FbmOpts, type Noise2,
} from '../noise.ts'
import type { BiomeRule, ClimateFile, NoiseSpec, OverworldSpec, RegionSpec, TownSpec } from './schema.ts'
import { noiseField, rngFor, seedFor } from './random.ts'
import { lockBounds, runHydrology, type Hydrology } from './hydro.ts'
import { chooseSites, type Site, type SiteInput } from './sites.ts'
import type { WorldContent } from './data.ts'

export interface Rect { x: number; y: number; w: number; h: number }

export interface TownPad { town: TownSpec; rect: Rect; level: number; region: number }

export interface IslandInfo { id: string; x: number; y: number; radius: number; authored: boolean }

export interface Macro {
  w: number
  h: number
  /** Zone (authored region index) per tile; ocean and island tiles belong to the water zone. */
  wild: Uint8Array
  /** Land zone per tile ignoring the sea (border bands continue through shallows). */
  zoneRaw: Uint8Array
  /** 0 = authored core .. 1 = deep wilderness. */
  wildness: Float32Array
  /** Distance (tiles) to the nearest authored control point or town. */
  coreDist: Float32Array
  /** 1 where the authored zone biome / region applies. */
  core: Uint8Array
  /** Index into CONTENT.biomes per tile. */
  biome: Uint8Array
  temp: Float32Array
  moist: Float32Array
  weird: Float32Array
  level: Uint8Array
  sea: Uint8Array
  /** Distance to the sea (tiles, capped). */
  seaDist: Uint16Array
  /** island index + 1 (into `islands`). */
  island: Uint8Array
  islands: IslandInfo[]
  /** lake index + 1 for water tiles / rim tiles (into `lakeTerrains`). */
  lake: Uint8Array
  lakeRim: Uint8Array
  lakeTerrains: [string, string][]
  /** terrain key index + 1 into craterTerrains */
  crater: Uint8Array
  craterTerrains: string[]
  beach: Uint8Array
  /** 1 for flattened (locked) tiles */
  locked: Uint8Array
  /** 1 = river channel, 2 = river bank (procedural hydrology). */
  river: Uint8Array
  pads: TownPad[]
  sites: Site[]
  hydro: Hydrology
}

export interface MacroInput {
  seed: number
  wc: WorldContent
  towns: { town: TownSpec; w: number; h: number }[]
}

export function townRect(t: TownSpec, w: number, h: number): Rect {
  return { x: t.x - Math.floor(w / 2), y: t.y - Math.floor(h / 2), w, h }
}

export function fbmOpts(spec: NoiseSpec): FbmOpts {
  return { frequency: 1 / spec.scale, octaves: spec.octaves, gain: spec.gain, lacunarity: spec.lacunarity }
}

export function noiseFor(seed: number, spec: NoiseSpec, salt = ''): Noise2 {
  return createNoise(seedFor(seed, spec.salt + salt))
}

/** Separable box blur (clamped edges), `passes` times. */
export function boxBlur(src: Float32Array, w: number, h: number, r: number, passes: number): Float32Array {
  const a = Float32Array.from(src)
  if (r <= 0) return a
  const b = new Float32Array(w * h)
  const win = 2 * r + 1
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const o = y * w
      let sum = 0
      for (let k = -r; k <= r; k++) sum += a[o + Math.min(w - 1, Math.max(0, k))]
      for (let x = 0; x < w; x++) {
        b[o + x] = sum / win
        sum += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let k = -r; k <= r; k++) sum += b[Math.min(h - 1, Math.max(0, k)) * w + x]
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / win
        sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x]
      }
    }
  }
  return a
}

const smooth = (t: number) => t * t * (3 - 2 * t)

interface Pt { x: number; y: number; r: number }

/** Nearest control point per tile after domain warping; block-wise candidate pruning keeps it ~O(N). */
function voronoi(W: number, H: number, pts: Pt[], land: boolean[], warpX: Float32Array, warpY: Float32Array): { all: Uint8Array; landZ: Uint8Array } {
  const all = new Uint8Array(W * H), landZ = new Uint8Array(W * H)
  let maxWarp = 0
  for (let i = 0; i < W * H; i++) {
    const m = Math.max(Math.abs(warpX[i]), Math.abs(warpY[i]))
    if (m > maxWarp) maxWarp = m
  }
  const B = 16
  const margin = 2 * (B * 0.7072 + maxWarp * 1.4143) + 1
  const dist = new Float64Array(pts.length)
  const candA: number[] = [], candL: number[] = []
  for (let by = 0; by < H; by += B) for (let bx = 0; bx < W; bx += B) {
    const cx = bx + B / 2, cy = by + B / 2
    let dA = Infinity, dL = Infinity
    for (let k = 0; k < pts.length; k++) {
      const dx = pts[k].x - cx, dy = pts[k].y - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      dist[k] = d
      if (d < dA) dA = d
      if (land[pts[k].r] && d < dL) dL = d
    }
    candA.length = 0; candL.length = 0
    for (let k = 0; k < pts.length; k++) {
      if (dist[k] <= dA + margin) candA.push(k)
      if (land[pts[k].r] && dist[k] <= dL + margin) candL.push(k)
    }
    for (let y = by; y < Math.min(H, by + B); y++) for (let x = bx; x < Math.min(W, bx + B); x++) {
      const i = y * W + x
      const px = x + warpX[i], py = y + warpY[i]
      let best = 0, bd = Infinity
      for (const k of candA) {
        const dx = px - pts[k].x, dy = py - pts[k].y
        const d = dx * dx + dy * dy
        if (d < bd) { bd = d; best = pts[k].r }
      }
      all[i] = best
      best = 0; bd = Infinity
      for (const k of candL) {
        const dx = px - pts[k].x, dy = py - pts[k].y
        const d = dx * dx + dy * dy
        if (d < bd) { bd = d; best = pts[k].r }
      }
      landZ[i] = best
    }
  }
  return { all, landZ }
}

/** Multi-source BFS distance (4-neighbour) on a w x h grid from `src` tiles, capped at `cap`. */
export function bfsDistance(w: number, h: number, isSource: (i: number) => boolean, cap: number, passable?: (i: number) => boolean, chebyshev = false): Uint16Array {
  const N = w * h
  const dist = new Uint16Array(N).fill(cap)
  const q = new Int32Array(N)
  let head = 0, tail = 0
  for (let i = 0; i < N; i++) if (isSource(i)) { dist[i] = 0; q[tail++] = i }
  const visit = (j: number, nd: number) => { if (dist[j] > nd && (!passable || passable(j))) { dist[j] = nd; q[tail++] = j } }
  while (head < tail) {
    const i = q[head++]
    const nd = dist[i] + 1
    if (nd >= cap) continue
    const x = i % w
    const up = i >= w, down = i < N - w, left = x > 0, right = x < w - 1
    if (left) visit(i - 1, nd)
    if (right) visit(i + 1, nd)
    if (up) visit(i - w, nd)
    if (down) visit(i + w, nd)
    if (chebyshev) {
      if (up && left) visit(i - w - 1, nd)
      if (up && right) visit(i - w + 1, nd)
      if (down && left) visit(i + w - 1, nd)
      if (down && right) visit(i + w + 1, nd)
    }
  }
  return dist
}

/** Connected components (4-neighbour) of tiles where mask[i] = 1; returns labels (0 = none) and sizes. */
export function components(w: number, h: number, mask: Uint8Array): { label: Int32Array; sizes: number[] } {
  const N = w * h
  const label = new Int32Array(N)
  const sizes: number[] = [0]
  const q = new Int32Array(N)
  for (let s = 0; s < N; s++) {
    if (!mask[s] || label[s]) continue
    const id = sizes.length
    let head = 0, tail = 0
    q[tail++] = s
    label[s] = id
    while (head < tail) {
      const i = q[head++]
      const x = i % w
      if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = id; q[tail++] = i - 1 }
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = id; q[tail++] = i + 1 }
      if (i >= w && mask[i - w] && !label[i - w]) { label[i - w] = id; q[tail++] = i - w }
      if (i < N - w && mask[i + w] && !label[i + w]) { label[i + w] = id; q[tail++] = i + w }
    }
    sizes.push(tail)
  }
  return { label, sizes }
}

const inRange = (r: [number, number] | undefined, v: number) => r === undefined || (v >= r[0] && v <= r[1])

/** First matching rule of the Whittaker-style table (index into CONTENT.biomes), or `fallback`. */
export function classifyBiome(rules: { rule: BiomeRule; biome: number }[], t: number, m: number, weird: number, elev: number, seaDist: number, fallback: number): number {
  for (const { rule, biome } of rules) {
    if (inRange(rule.t, t) && inRange(rule.m, m) && inRange(rule.weird, weird) && inRange(rule.elev, elev) && inRange(rule.sea, seaDist)) return biome
  }
  return fallback
}

export function compileBiomeRules(climate: ClimateFile): { rule: BiomeRule; biome: number }[] {
  return climate.rules.map((rule) => {
    const biome = CONTENT.biomes.findIndex((b) => b.id === rule.biome)
    if (biome < 0) throw new Error(`climate.json: unknown biome "${rule.biome}"`)
    return { rule, biome }
  })
}

interface LockGroup {
  cells: number[]
  T: number
  /** Told the final level when `startFlat` lowers the group (towns and POI pads keep it in `level`). */
  retarget?: (T: number) => void
}

/** Flattens every lock group to T + 0.5 and raises the surroundings so pads never sit in a pit. */
function applyLocks(spec: OverworldSpec, W: number, H: number, hf: Float32Array, sea: Uint8Array, locked: Uint8Array, groups: LockGroup[]): void {
  const reach = Math.ceil((spec.maxLevel + 2) / spec.slope)
  const N = W * H
  const stamp = new Int32Array(N).fill(-1)
  let frontier: number[] = [], next: number[] = []
  groups.forEach((lk, gi) => {
    const target = lk.T + 0.5
    frontier.length = 0
    for (const i of lk.cells) { hf[i] = target; locked[i] = 1; sea[i] = 0; stamp[i] = gi; frontier.push(i) }
    for (let step = 1; step <= reach && frontier.length; step++) {
      next.length = 0
      const floor = target - spec.slope * step
      for (const i of frontier) {
        const x = i % W, y = (i - x) / W
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy
          if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const j = ny * W + nx
          if (stamp[j] === gi) continue
          stamp[j] = gi
          next.push(j)
          if (!locked[j] && !sea[j] && hf[j] < floor) hf[j] = floor
        }
      }
      const t = frontier; frontier = next; next = t
    }
  })
}

/**
 * Lowers tiny isolated terraces inside `box` to the level around them: a plateau of fewer than `minPatch` tiles whose
 * neighbours are all lower reads as a stray bump, not a highland. Locked pads and the sea are never touched.
 */
function despeckle(level: Uint8Array, locked: Uint8Array, W: number, H: number, box: { x0: number; y0: number; x1: number; y1: number }, minPatch: number): void {
  const x0 = Math.max(0, box.x0), y0 = Math.max(0, box.y0), x1 = Math.min(W - 1, box.x1), y1 = Math.min(H - 1, box.y1)
  const seen = new Uint8Array(W * H)
  const comp: number[] = []
  let top = 0
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) top = Math.max(top, level[y * W + x])
  for (let h = top; h >= 1; h--) {
    seen.fill(0)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const start = y * W + x
      if (seen[start] || level[start] !== h) continue
      comp.length = 0
      comp.push(start)
      seen[start] = 1
      let pinned = false, lower = false, higher = false
      for (let k = 0; k < comp.length; k++) {
        const i = comp[k], cx = i % W, cy = (i - cx) / W
        if (locked[i]) pinned = true
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) { pinned = true; continue }
          const j = ny * W + nx
          if (level[j] === h) { if (!seen[j]) { seen[j] = 1; comp.push(j) } }
          else if (level[j] > h) higher = true
          else lower = true
        }
      }
      if (comp.length < minPatch && !pinned && lower && !higher) for (const i of comp) level[i] = h - 1
    }
  }
}

/**
 * A zone cut apart by the coast or by a neighbouring zone keeps only its largest land piece; every other piece
 * joins the zone it shares the longest border with (a stranded piece would sit behind border walls with no gate).
 * Pieces holding a town pad are never moved.
 */
function mergeZoneFragments(W: number, H: number, sea: Uint8Array, zoneRaw: Uint8Array, zoneAll: Uint8Array, pads: TownPad[]): void {
  const N = W * H
  const label = new Int32Array(N).fill(-1)
  const q = new Int32Array(N)
  const compZone: number[] = [], compSize: number[] = []
  for (let s0 = 0; s0 < N; s0++) {
    if (sea[s0] || label[s0] >= 0) continue
    const id = compZone.length, z = zoneRaw[s0]
    let head = 0, tail = 0
    q[tail++] = s0; label[s0] = id
    while (head < tail) {
      const i = q[head++]
      const x = i % W
      if (x > 0 && !sea[i - 1] && label[i - 1] < 0 && zoneRaw[i - 1] === z) { label[i - 1] = id; q[tail++] = i - 1 }
      if (x < W - 1 && !sea[i + 1] && label[i + 1] < 0 && zoneRaw[i + 1] === z) { label[i + 1] = id; q[tail++] = i + 1 }
      if (i >= W && !sea[i - W] && label[i - W] < 0 && zoneRaw[i - W] === z) { label[i - W] = id; q[tail++] = i - W }
      if (i < N - W && !sea[i + W] && label[i + W] < 0 && zoneRaw[i + W] === z) { label[i + W] = id; q[tail++] = i + W }
    }
    compZone.push(z); compSize.push(tail)
  }
  const best = new Map<number, number>()
  compZone.forEach((z, c) => { const b = best.get(z); if (b === undefined || compSize[c] > compSize[b]) best.set(z, c) })
  const pinned = new Set<number>()
  for (const p of pads) {
    const i = (p.rect.y + (p.rect.h >> 1)) * W + p.rect.x + (p.rect.w >> 1)
    if (label[i] >= 0) pinned.add(label[i])
  }
  const moves = new Map<number, Map<number, number>>()
  for (let i = 0; i < N; i++) {
    const c = label[i]
    if (c < 0 || best.get(compZone[c]) === c || pinned.has(c)) continue
    const x = i % W
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
      if (j < 0 || j >= N || sea[j] || label[j] === c) continue
      let m = moves.get(c)
      if (!m) { m = new Map(); moves.set(c, m) }
      m.set(zoneRaw[j], (m.get(zoneRaw[j]) ?? 0) + 1)
    }
  }
  const target = new Map<number, number>()
  for (const [c, m] of moves) {
    let bz = -1, bn = -1
    for (const [z, n] of m) if (n > bn || (n === bn && z < bz)) { bz = z; bn = n }
    target.set(c, bz)
  }
  if (!target.size) return
  for (let i = 0; i < N; i++) {
    const c = label[i]
    if (c < 0) continue
    const z = target.get(c)
    if (z === undefined) continue
    if (zoneAll[i] === zoneRaw[i]) zoneAll[i] = z
    zoneRaw[i] = z
  }
}

export function buildMacro(inp: MacroInput): Macro {
  const { seed, wc } = inp
  const spec = wc.world.overworld
  const regions: RegionSpec[] = wc.regions
  const climate = wc.climate
  const W = spec.width, H = spec.height, N = W * H
  const C = Math.max(1, Math.floor(spec.coarse))
  const regionIdx = new Map(regions.map((r, i) => [r.id, i]))
  const water = regions.map((r) => r.water === true)
  const landZone = regions.map((r) => !r.water)
  const walled = regions.map((r) => r.border !== false && !r.water)
  const seaZone = regions.findIndex((r) => r.water)
  const biomeIdx = (id: string) => Math.max(0, CONTENT.biomes.findIndex((b) => b.id === id))

  // --- zones ---------------------------------------------------------------------------------------
  const wn = spec.warp.noise
  const wxN = noiseFor(seed, wn, '-x'), wyN = noiseFor(seed, wn, '-y')
  const wo = fbmOpts(wn)
  const warpX = sampleField(W, H, C, (x, y) => fbm(wxN, x, y, wo) * 1.4 * spec.warp.amplitude)
  const warpY = sampleField(W, H, C, (x, y) => fbm(wyN, x, y, wo) * 1.4 * spec.warp.amplitude)
  const pts: Pt[] = []
  regions.forEach((r, ri) => r.points.forEach(([x, y]) => pts.push({ x, y, r: ri })))
  const { all: zoneAll, landZ: zoneRaw } = voronoi(W, H, pts, landZone, warpX, warpY)
  // Towns claim their surroundings so region border walls never cut through a town.
  const claim = spec.townMargin + spec.borderRadius + 2
  const pads: TownPad[] = []
  for (const { town, w, h } of inp.towns) {
    const rect = townRect(town, w, h)
    const ri = regionIdx.get(town.region)
    if (ri === undefined) throw new Error(`town ${town.id}: unknown region "${town.region}"`)
    for (let y = rect.y - claim; y < rect.y + rect.h + claim; y++) {
      for (let x = rect.x - claim; x < rect.x + rect.w + claim; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const i = y * W + x
        if (walled[zoneRaw[i]]) zoneRaw[i] = ri
        zoneAll[i] = ri
      }
    }
    pads.push({ town, rect, level: 0, region: ri })
  }

  // --- core / wilderness ---------------------------------------------------------------------------
  // Core = around the towns and each zone's anchor point; the rest of every zone is wilderness.
  const corePts: { x: number; y: number }[] = []
  regions.forEach((r) => { if (!r.water && r.points.length) corePts.push({ x: r.points[0][0], y: r.points[0][1] }) })
  for (const p of pads) corePts.push({ x: p.town.x, y: p.town.y })
  const cc = climate.core
  const coreN = noiseFor(seed, cc.noise)
  const coreO = fbmOpts(cc.noise)
  const coreDist = sampleField(W, H, C, (x, y) => {
    let best = Infinity
    for (const p of corePts) {
      const dx = p.x - x, dy = p.y - y
      const d = dx * dx + dy * dy
      if (d < best) best = d
    }
    return Math.sqrt(best)
  })
  const wildness = sampleField(W, H, C, (x, y) => {
    const xi = Math.min(W - 1, x), yi = Math.min(H - 1, y)
    const d = coreDist[yi * W + xi] + cc.jitter * (fbm01(coreN, x, y, coreO) - 0.5) * 2
    return smoothstep(cc.radius[0], cc.radius[1], d)
  })

  // --- climate fields (lattice) --------------------------------------------------------------------
  const { gw, gh } = latticeSize(W, H, C)
  const lat = (fill: (x: number, y: number, gi: number) => number): Float32Array => {
    const g = new Float32Array(gw * gh)
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) g[gy * gw + gx] = fill(Math.min(W - 1, gx * C), Math.min(H - 1, gy * C), gy * gw + gx)
    return g
  }
  const zoneAt = (x: number, y: number) => zoneAll[y * W + x]
  const blurR = Math.max(1, Math.round(climate.bias.blur / C))
  const biasT = boxBlur(lat((x, y) => regions[zoneAt(x, y)].climate?.t ?? 0.5), gw, gh, blurR, 2)
  const biasM = boxBlur(lat((x, y) => regions[zoneAt(x, y)].climate?.m ?? 0.5), gw, gh, blurR, 2)
  const biasW = boxBlur(lat((x, y) => regions[zoneAt(x, y)].climate?.w ?? 0.3), gw, gh, blurR, 2)
  const tN = noiseFor(seed, climate.temperature.noise), mN = noiseFor(seed, climate.moisture.noise), xN = noiseFor(seed, climate.weirdness.noise)
  const tO = fbmOpts(climate.temperature.noise), mO = fbmOpts(climate.moisture.noise), xO = fbmOpts(climate.weirdness.noise)
  const tempL = lat((x, y, gi) => {
    const wb = climate.bias.core + (climate.bias.wild - climate.bias.core) * wildness[y * W + x]
    const nt = 0.5 + (fbm01(tN, x, y, tO) - 0.5) * climate.temperature.contrast + climate.temperature.latitude * (y / H - 0.5)
    return nt + (biasT[gi] - nt) * wb
  })
  const moistL = lat((x, y, gi) => {
    const wb = climate.bias.core + (climate.bias.wild - climate.bias.core) * wildness[y * W + x]
    const nm = 0.5 + (fbm01(mN, x, y, mO) - 0.5) * climate.moisture.contrast
    return nm + (biasM[gi] - nm) * wb
  })
  const weirdL = lat((x, y, gi) => {
    const nw = 0.5 + (fbm01(xN, x, y, xO) - 0.5) * climate.weirdness.contrast
    return nw + (biasW[gi] - nw) * climate.bias.weird
  })
  const temp = upsample(tempL, gw, C, W, H)
  const moist = upsample(moistL, gw, C, W, H)
  const weird = upsample(weirdL, gw, C, W, H)

  // --- height --------------------------------------------------------------------------------------
  const baseL = boxBlur(lat((x, y) => regions[zoneAt(x, y)].level), gw, gh, Math.max(1, Math.round(spec.blur.radius / C)), spec.blur.passes)
  const reliefL = boxBlur(lat((x, y) => regions[zoneAt(x, y)].relief), gw, gh, Math.max(1, Math.round(spec.blur.radius / C)), spec.blur.passes)
  const base = upsample(baseL, gw, C, W, H)
  const reliefAmp = upsample(reliefL, gw, C, W, H)
  const rn = noiseField(spec.relief, seed)
  const S2 = Math.max(1, Math.floor(C / 2))
  const relief = sampleField(W, H, S2, (x, y) => (rn.sample(x, y) - 0.5) * 2)
  const lf = spec.landforms
  const lwxN = noiseFor(seed, lf.warp.noise, '-x'), lwyN = noiseFor(seed, lf.warp.noise, '-y'), lwO = fbmOpts(lf.warp.noise)
  const hillN = noiseFor(seed, lf.hills.noise), hillO = fbmOpts(lf.hills.noise)
  const maskN = noiseFor(seed, lf.mountains.mask), maskO = fbmOpts(lf.mountains.mask)
  const ridgeN = noiseFor(seed, lf.mountains.ridge), ridgeO = fbmOpts(lf.mountains.ridge)
  const platN = noiseFor(seed, lf.plateaus.noise), platO = fbmOpts(lf.plateaus.noise)
  const canN = noiseFor(seed, lf.canyons.noise), canO = fbmOpts(lf.canyons.noise)
  const landform = sampleField(W, H, S2, (x, y) => {
    const px = x + fbm(lwxN, x, y, lwO) * 1.4 * lf.warp.amplitude
    const py = y + fbm(lwyN, x, y, lwO) * 1.4 * lf.warp.amplitude
    const xi = Math.min(W - 1, x), yi = Math.min(H - 1, y)
    let v = fbm(hillN, px, py, hillO) * 1.4 * lf.hills.amplitude
    const mask = smoothstep(lf.mountains.maskRange[0], lf.mountains.maskRange[1], fbm01(maskN, px, py, maskO))
    if (mask > 0) { const r = ridged(ridgeN, px, py, ridgeO); v += mask * r * r * lf.mountains.amplitude }
    v += smoothstep(lf.plateaus.threshold, lf.plateaus.threshold + lf.plateaus.edge, fbm01(platN, px, py, platO)) * lf.plateaus.amplitude
    const dry = moist[yi * W + xi] <= lf.canyons.moistureMax ? 1 : 0
    if (dry) v -= lf.canyons.depth * smoothstep(lf.canyons.threshold[0], lf.canyons.threshold[1], ridged(canN, px, py, canO))
    return v
  })
  // Ridges along walled zone borders (mountain chains between regions).
  const br = lf.borderRidge
  const borderDist = bfsDistance(W, H, (i) => {
    const z = zoneRaw[i]
    if (!walled[z]) return false
    const x = i % W
    return (x + 1 < W && zoneRaw[i + 1] !== z && walled[zoneRaw[i + 1]]) || (i + W < N && zoneRaw[i + W] !== z && walled[zoneRaw[i + W]])
  }, Math.max(1, br.width) + 1)
  const ridgeNoise = noiseField(br.noise, seed)
  const hf = new Float32Array(N)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    let v = base[i] + relief[i] * reliefAmp[i] + wildness[i] * landform[i]
    if (borderDist[i] < br.width) {
      const t = 1 - borderDist[i] / br.width
      v += br.amplitude * t * t * ridgeNoise.sample(x, y)
    }
    hf[i] = v
  }
  const crater = new Uint8Array(N)
  const craterTerrains: string[] = []
  for (const r of regions) for (const pk of r.peaks ?? []) {
    let craterId = 0
    if (pk.crater) { craterTerrains.push(pk.crater.terrain); craterId = craterTerrains.length }
    const r0 = Math.ceil(pk.radius)
    for (let y = Math.max(0, pk.y - r0); y <= Math.min(H - 1, pk.y + r0); y++) {
      for (let x = Math.max(0, pk.x - r0); x <= Math.min(W - 1, pk.x + r0); x++) {
        const d = Math.sqrt((x - pk.x) * (x - pk.x) + (y - pk.y) * (y - pk.y))
        if (d >= pk.radius) continue
        const t = 1 - d / pk.radius
        const v = pk.shape === 'cone' ? t : pk.shape === 'dome' ? smooth(t) : smooth(Math.min(1, t / Math.max(0.05, 1 - (pk.flat ?? 0.5))))
        hf[y * W + x] += pk.height * v
        if (pk.crater && d < pk.crater.radius) crater[y * W + x] = craterId
      }
    }
  }
  // --- sea: authored water zone + ocean ring, one continent ------------------------------------------
  const seaH = spec.seaLevel + 0.5
  const oc = spec.ocean
  const ocN = noiseFor(seed, oc.noise), ocO = fbmOpts(oc.noise)
  const oceanVal = sampleField(W, H, C, (x, y) => {
    let e = Math.min(x, y, W - 1 - x, H - 1 - y)
    if (oc.round > 0) {
      const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2)
      e = Math.min(e, (oc.round - Math.sqrt(dx * dx + dy * dy)) * Math.min(W, H) / 2)
    }
    return smoothstep(0, oc.width, e) + oc.amplitude * (fbm01(ocN, x, y, ocO) - 0.5) * 2
  })
  const keep = new Uint8Array(N)
  for (const p of pads) {
    const m = oc.keepClear
    for (let y = p.rect.y - m; y < p.rect.y + p.rect.h + m; y++) for (let x = p.rect.x - m; x < p.rect.x + p.rect.w + m; x++) {
      if (x >= 0 && y >= 0 && x < W && y < H) keep[y * W + x] = 1
    }
  }
  const sea = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const x = i % W, y = (i - x) / W
    const edge = Math.min(x, y, W - 1 - x, H - 1 - y) < oc.margin
    if (!keep[i] && (edge || water[zoneAll[i]] || oceanVal[i] < oc.threshold)) sea[i] = 1
  }
  {
    // Inland "ocean" pockets become land; land not connected to the main continent sinks.
    const reachSea = bfsDistance(W, H, (i) => {
      if (!sea[i]) return false
      const x = i % W, y = (i - x) / W
      return x === 0 || y === 0 || x === W - 1 || y === H - 1
    }, 0xffff, (i) => sea[i] === 1)
    for (let i = 0; i < N; i++) if (sea[i] && reachSea[i] === 0xffff && !water[zoneAll[i]]) sea[i] = 0
    const landMask = new Uint8Array(N)
    for (let i = 0; i < N; i++) landMask[i] = sea[i] ? 0 : 1
    const { label, sizes } = components(W, H, landMask)
    let main = 1
    for (let k = 2; k < sizes.length; k++) if (sizes[k] > sizes[main]) main = k
    for (let i = 0; i < N; i++) if (landMask[i] && label[i] !== main) sea[i] = 1
  }
  for (let i = 0; i < N; i++) if (sea[i]) hf[i] = seaH
  mergeZoneFragments(W, H, sea, zoneRaw, zoneAll, pads)

  // --- islands (authored + procedural archipelago, surf only) -----------------------------------------
  const island = new Uint8Array(N)
  const islands: IslandInfo[] = []
  const isl = noiseField(spec.islandNoise, seed)
  const paintIsland = (cx: number, cy: number, radius: number, noise: number, level: number, k: number, onlyZone: number) => {
    const r0 = Math.ceil(radius * (1 + noise)) + 1
    for (let y = Math.max(0, cy - r0); y <= Math.min(H - 1, cy + r0); y++) {
      for (let x = Math.max(0, cx - r0); x <= Math.min(W - 1, cx + r0); x++) {
        const i = y * W + x
        if (!sea[i] || (onlyZone >= 0 && zoneAll[i] !== onlyZone)) continue
        const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy))
        const rr = radius * (1 + (isl.sample(x, y) - 0.5) * 2 * noise)
        if (d < rr) { sea[i] = 0; island[i] = k; hf[i] = level + 0.5 }
      }
    }
  }
  spec.islands.forEach((s) => {
    islands.push({ id: s.id, x: s.x, y: s.y, radius: s.radius, authored: true })
    paintIsland(s.x, s.y, s.radius, s.noise, s.level, islands.length, regionIdx.get(s.region) ?? -1)
  })
  {
    const ap = spec.archipelago
    const landDist = bfsDistance(W, H, (i) => !sea[i], 0xfff0)
    const rng = rngFor(seed, 'archipelago')
    for (let t = 0; t < ap.tries && islands.length - spec.islands.length < ap.count; t++) {
      const x = rng.int(0, W - 1), y = rng.int(0, H - 1)
      const radius = ap.radius[0] + rng.next() * (ap.radius[1] - ap.radius[0])
      const reach = Math.ceil(radius * (1 + ap.noise))
      if (x < reach + ap.minGap || y < reach + ap.minGap || x >= W - reach - ap.minGap || y >= H - reach - ap.minGap) continue
      if (landDist[y * W + x] < reach + ap.minGap) continue
      if (islands.some((o) => (o.x - x) * (o.x - x) + (o.y - y) * (o.y - y) < ap.spacing * ap.spacing)) continue
      const id = `${ap.idPrefix}${islands.length - spec.islands.length + 1}`
      islands.push({ id, x, y, radius, authored: false })
      paintIsland(x, y, radius, ap.noise, ap.level, islands.length, -1)
    }
  }

  // --- beaches and cliff coasts ----------------------------------------------------------------------
  const seaCap = 64
  let seaDist = bfsDistance(W, H, (i) => sea[i] === 1, seaCap)
  const beach = new Uint8Array(N)
  const beachZones = new Set(spec.beach.regions.map((id) => regionIdx.get(id)))
  const cliffZone = regions.map((r) => r.shore === 'cliff')
  for (let i = 0; i < N; i++) {
    if (sea[i]) continue
    const d = seaDist[i]
    const z = island[i] ? seaZone : zoneAll[i]
    if (cliffZone[zoneRaw[i]] && !island[i]) {
      if (d <= spec.cliffWidth) hf[i] = Math.max(hf[i], seaH + 1.5)
      continue
    }
    if (d <= spec.beach.width && (beachZones.has(z) || island[i] || hf[i] < seaH + spec.beach.maxRise)) {
      beach[i] = 1
      hf[i] = Math.min(hf[i], seaH + (d - 1) * spec.beach.rise)
    }
  }

  // --- zones per tile (sea and islands belong to the water zone) ------------------------------------
  const wild = new Uint8Array(N)
  for (let i = 0; i < N; i++) wild[i] = sea[i] || island[i] ? (seaZone >= 0 ? seaZone : zoneAll[i]) : (water[zoneAll[i]] ? zoneRaw[i] : zoneAll[i])

  // --- provisional biomes for site selection --------------------------------------------------------
  const rules = compileBiomeRules(climate)
  const zoneBiome = regions.map((r) => biomeIdx(r.biome))
  const core = new Uint8Array(N)
  for (let i = 0; i < N; i++) core[i] = !island[i] && !sea[i] && wildness[i] < cc.threshold ? 1 : 0
  const biomeAt = (i: number, level: number, extraM = 0): number => {
    if (sea[i]) return zoneBiome[wild[i]]
    if (core[i]) return zoneBiome[wild[i]]
    return classifyBiome(rules, temp[i] - climate.temperature.lapse * level, moist[i] + extraM, weird[i], level, seaDist[i], zoneBiome[wild[i]])
  }

  // --- flattened pads: authored lakes, towns, POI sites --------------------------------------------
  const locked = new Uint8Array(N)
  const locks: LockGroup[] = []
  const lake = new Uint8Array(N), lakeRim = new Uint8Array(N)
  const lakeTerrains: [string, string][] = []
  const ln = noiseField(spec.lakeNoise, seed)
  // The sea is never raised, so a flattened group may stand at most slope * (Chebyshev distance) above it.
  const seaCheb = bfsDistance(W, H, (i) => sea[i] === 1, 0xfff0, undefined, true)
  const capBySea = (cells: number[], T: number): number => {
    let minSea = 0xfff0
    for (const i of cells) if (seaCheb[i] < minSea) minSea = seaCheb[i]
    return Math.max(0, Math.min(T, Math.floor(seaH + spec.slope * minSea - 0.5)))
  }
  spec.lakes.forEach((lk) => {
    lakeTerrains.push([lk.terrain, lk.rimTerrain])
    const k = lakeTerrains.length
    let T = Math.max(0, Math.floor(hf[lk.y * W + lk.x]) + (lk.levelOffset ?? 0))
    const cells: number[] = []
    const r0 = Math.ceil(lk.radius * (1 + lk.noise)) + lk.rim + 1
    for (let y = Math.max(0, lk.y - r0); y <= Math.min(H - 1, lk.y + r0); y++) {
      for (let x = Math.max(0, lk.x - r0); x <= Math.min(W - 1, lk.x + r0); x++) {
        const i = y * W + x
        if (sea[i]) continue
        const d = Math.sqrt((x - lk.x) * (x - lk.x) + (y - lk.y) * (y - lk.y))
        const rr = lk.radius * (1 + (ln.sample(x, y) - 0.5) * 2 * lk.noise)
        if (d < rr) { lake[i] = k; cells.push(i) }
        else if (d < rr + lk.rim) { lakeRim[i] = k; cells.push(i) }
      }
    }
    T = capBySea(cells, T)
    locks.push({ cells, T })
  })
  for (const pad of pads) {
    const T = pad.town.level ?? Math.max(0, Math.floor(hf[pad.town.y * W + pad.town.x]))
    pad.level = T
    const cells: number[] = []
    const m = spec.townMargin
    for (let y = pad.rect.y - m; y < pad.rect.y + pad.rect.h + m; y++) {
      for (let x = pad.rect.x - m; x < pad.rect.x + pad.rect.w + m; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const i = y * W + x
        if (sea[i] && (x < pad.rect.x || y < pad.rect.y || x >= pad.rect.x + pad.rect.w || y >= pad.rect.y + pad.rect.h)) continue
        cells.push(i)
      }
    }
    locks.push({ cells, T, retarget: (t) => { pad.level = t } })
  }
  const lakeDist = bfsDistance(W, H, (i) => lake[i] !== 0 || lakeRim[i] !== 0, 0xff, undefined, true)
  const siteIn: SiteInput = {
    seed, wc, W, H, hf, sea, island, islands, wild, zoneRaw, wildness, seaDist, borderDist, lake, lakeDist, pads, walled, cliffZone,
    biomeAt: (i) => biomeAt(i, Math.max(0, Math.floor(hf[i]))),
  }
  const sites = chooseSites(siteIn)
  // Site pads must fit the slope envelope of what is already fixed (sea, authored lakes, town pads) and of each
  // other: two flattened groups at levels a and b need a Chebyshev gap D with |a - b| <= slope * (D - 1) + 1.
  const fixed = (() => {
    const v = new Float32Array(N), on = new Uint8Array(N)
    for (const g of locks) for (const i of g.cells) { v[i] = g.T + 0.5; on[i] = 1 }
    return lockBounds(W, H, v, on, sea, seaH, spec.slope)
  })()
  const placed: { x: number; y: number; r: number; T: number }[] = []
  for (const s of sites) {
    if (!s.pad) continue
    const ci = s.y * W + s.x
    let T = Math.max(0, Math.floor(hf[ci]))
    if (s.island) T = Math.max(T, spec.archipelago.level)
    if (cliffZone[zoneRaw[ci]] && !s.island && seaDist[ci] <= spec.cliffWidth + s.radius) T = Math.max(T, spec.seaLevel + 1)
    const cells: number[] = []
    const r = s.radius
    for (let y = Math.max(0, s.y - r); y <= Math.min(H - 1, s.y + r); y++) for (let x = Math.max(0, s.x - r); x <= Math.min(W - 1, s.x + r); x++) {
      const i = y * W + x
      if (sea[i] || lake[i] || lakeRim[i]) continue
      if ((x - s.x) * (x - s.x) + (y - s.y) * (y - s.y) <= r * r) cells.push(i)
    }
    if (!s.island) {
      let lo = 0, hi = spec.maxLevel
      for (const i of cells) { lo = Math.max(lo, Math.ceil(fixed.lo[i] - 1)); hi = Math.min(hi, Math.floor(fixed.hi[i])) }
      for (const o of placed) {
        const dist = Math.sqrt((o.x - s.x) * (o.x - s.x) + (o.y - s.y) * (o.y - s.y))
        const gap = Math.max(1, Math.floor((dist - o.r - r) / 1.415))
        const k = Math.floor(spec.slope * (gap - 1) + 1)
        lo = Math.max(lo, o.T - k); hi = Math.min(hi, o.T + k)
      }
      T = Math.max(lo, Math.min(hi, T))
    }
    s.level = T
    placed.push({ x: s.x, y: s.y, r, T })
    locks.push({ cells, T, retarget: (t) => { s.level = t } })
  }
  applyLocks(spec, W, H, hf, sea, locked, locks)

  // --- hydrology: basin lakes and rivers carve the continuous field --------------------------------
  const hydro = runHydrology({
    seed, spec, W, H, C, hf, sea, locked, lake, lakeRim, island, moist, zoneRaw, cliffZone,
    lakeKey: () => { lakeTerrains.push([spec.hydrology.lakeTerrain, spec.hydrology.lakeRimTerrain]); return lakeTerrains.length },
  })
  for (const g of hydro.lockGroups) g.T = capBySea(g.cells, g.T)
  if (hydro.lockGroups.length) applyLocks(spec, W, H, hf, sea, locked, hydro.lockGroups)

  // --- start basin: nothing above `startFlat.level` around the start town -------------------------------
  // Applied after hydrology on purpose: rivers, lakes, sites and biomes are decided from the uncapped field, so the
  // world keeps its layout and only the terraces near the start are levelled. The cap rises smoothly (Perlin-wobbled
  // radius, no circular cliff) and the envelope below turns it into walkable slopes.
  const startTown = inp.towns.find(({ town }) => town.start)?.town
  const flat = spec.startFlat
  if (startTown && flat) {
    const wobble = noiseField(flat.noise, seed)
    const inner = Math.max(0, Math.min(spec.maxLevel, flat.level)) + 0.99
    const outer = spec.maxLevel + 0.5
    const capAt = (x: number, y: number): number => {
      const dx = x - startTown.x, dy = y - startTown.y
      const d = Math.sqrt(dx * dx + dy * dy) + flat.jitter * (wobble.sample(x, y) - 0.5) * 2
      return inner + (outer - inner) * smoothstep(0, 1, (d - flat.radius) / flat.transition)
    }
    // A flattened pad stays flat: it drops to the lowest cap it touches.
    const groups: LockGroup[] = [...locks, ...hydro.lockGroups]
    for (const g of groups) {
      let low = Infinity
      for (const i of g.cells) low = Math.min(low, capAt(i % W, (i - (i % W)) / W))
      const T = Math.min(g.T, Math.max(0, Math.floor(low - 0.5)))
      if (T === g.T) continue
      g.T = T
      g.retarget?.(T)
      for (const i of g.cells) hf[i] = T + 0.5
    }
    const reach = Math.ceil(flat.radius + flat.jitter + flat.transition)
    for (let y = Math.max(0, startTown.y - reach); y <= Math.min(H - 1, startTown.y + reach); y++) {
      for (let x = Math.max(0, startTown.x - reach); x <= Math.min(W - 1, startTown.x + reach); x++) {
        const i = y * W + x
        if (locked[i] || sea[i]) continue
        hf[i] = Math.min(hf[i], capAt(x, y))
      }
    }
  }

  // --- slope-limited lower envelope (two-pass chamfer) -------------------------------------------
  const s = spec.slope
  const e = hf
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (locked[i]) continue
    let v = e[i]
    if (x > 0) v = Math.min(v, e[i - 1] + s)
    if (y > 0) {
      v = Math.min(v, e[i - W] + s)
      if (x > 0) v = Math.min(v, e[i - W - 1] + s)
      if (x < W - 1) v = Math.min(v, e[i - W + 1] + s)
    }
    e[i] = v
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x
    if (locked[i]) continue
    let v = e[i]
    if (x < W - 1) v = Math.min(v, e[i + 1] + s)
    if (y < H - 1) {
      v = Math.min(v, e[i + W] + s)
      if (x < W - 1) v = Math.min(v, e[i + W + 1] + s)
      if (x > 0) v = Math.min(v, e[i + W - 1] + s)
    }
    e[i] = v
  }
  {
    // Rivers carved after the locks may have pulled a pad's ramp down: ramp back up from the pads (never the sea).
    const q: number[] = []
    const relax = (i: number) => {
      const x = i % W, y = (i - x) / W
      const floorV = e[i] - s
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const j = ny * W + nx
        if (locked[j] || sea[j] || e[j] >= floorV - 1e-6) continue
        e[j] = floorV
        q.push(j)
      }
    }
    for (let i = 0; i < N; i++) if (locked[i] && !sea[i]) relax(i)
    for (let k = 0; k < q.length; k++) relax(q[k])
  }
  const level = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const l = sea[i] ? spec.seaLevel : Math.floor(e[i])
    level[i] = Math.max(0, Math.min(spec.maxLevel, l))
  }
  if (startTown && flat && flat.minPatch > 0) {
    const reach = Math.ceil(flat.radius + flat.jitter + flat.transition)
    despeckle(level, locked, W, H, { x0: startTown.x - reach, y0: startTown.y - reach, x1: startTown.x + reach, y1: startTown.y + reach }, flat.minPatch)
  }
  seaDist = bfsDistance(W, H, (i) => sea[i] === 1, seaCap)

  // --- final biomes (moisture rises near rivers and lakes) -------------------------------------------
  const mw = climate.moisture.water
  const waterDist = bfsDistance(W, H, (i) => hydro.river[i] === 1 || lake[i] !== 0, Math.max(1, mw.distance) + 1)
  const biome = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const wb = waterDist[i] < mw.distance ? mw.boost * (1 - waterDist[i] / mw.distance) : 0
    biome[i] = biomeAt(i, level[i], wb)
  }

  return {
    w: W, h: H, wild, zoneRaw, wildness, coreDist, core, biome, temp, moist, weird, level, sea, seaDist, island, islands,
    lake, lakeRim, lakeTerrains, crater, craterTerrains, beach, locked, river: hydro.river, pads, sites, hydro,
  }
}
