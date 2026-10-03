// Climate / landform fields of the infinite frontier. Every value is a pure function of (seed, x, y): all noise
// channels are evaluated on a global tile lattice (gen.lattice) and bilinearly interpolated; only the height
// detail octaves are sampled per tile. Chunks, site windows and sample() all go through column(), so terrain is
// identical no matter which chunk (or which order) asks for it.
import { noiseField, seedFor, type NoiseField } from '../random.ts'
import type { NoiseSpec } from '../schema.ts'
import { compiledFrontier, type CompiledFrontier, type CompiledRule } from './config.ts'

export const CH_CONT = 0
export const CH_ARCH = 1
export const CH_TEMP = 2
export const CH_MOIST = 3
export const CH_WEIRD = 4
export const CH_VOLC = 5
export const CH_ERO = 6
export const CH_MMASK = 7
export const CH_RIDGE = 8
export const CH_PASS = 9
export const CH_PLAT = 10
export const CH_CANYON = 11
export const CH_RIVER = 12
export const CH_RSIZE = 13
export const CH_LAKE = 14
export const CH_PWX = 15
export const CH_PWY = 16
export const CH_CONTS = 17
export const CH_ISLE = 18
export const CH_HILL = 19
export const CH_JIT = 20
export const NCH = 21

/** Water kinds of a column. */
export const W_NONE = 0
export const W_SEA = 1
export const W_RIVER = 2
export const W_LAKE = 3

export interface Column {
  cont: number
  inland: number
  t: number; m: number; w: number; volc: number; rug: number; mount: number
  h: number
  level: number
  /** W_* kind and whether it is deep (surf) water. */
  water: number
  deep: boolean
  /** Index into CONTENT.biomes. */
  biome: number
  /** Base terrain id (sea / river / lake / beach / biome ground). */
  terrain: number
  /** Province warp offsets (regions). */
  pwx: number; pwy: number
}

export function newColumn(): Column {
  return { cont: 0, inland: 0, t: 0, m: 0, w: 0, volc: 0, rug: 0, mount: 0, h: 0, level: 0, water: 0, deep: false, biome: 0, terrain: 0, pwx: 0, pwy: 0 }
}

/** A rectangle of lattice points with all low-frequency channels. */
export interface Sheet {
  /** Lattice index of the first point. */
  lx: number
  ly: number
  nx: number
  ny: number
  data: Float64Array
}

export interface Gateway { x: number; y: number }

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
export function smooth(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

function matchRule(rules: CompiledRule[], vals: Float64Array, shallow: boolean): number {
  for (let k = 0; k < rules.length; k++) {
    const rule = rules[k]
    if (rule.shallow !== undefined && rule.shallow && !shallow) continue
    const r = rule.r
    let ok = true
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i]
      if (v < r[i * 2] || v > r[i * 2 + 1]) { ok = false; break }
    }
    if (ok) return rule.biome
  }
  return rules[rules.length - 1].biome
}

export class Fields {
  readonly seed: number
  readonly cf: CompiledFrontier
  readonly lat: number
  readonly core: { x: number; y: number; width: number; height: number }
  readonly origin: { x: number; y: number }
  readonly gateways: Gateway[]
  private readonly nf: NoiseField[]
  private readonly detail: NoiseField
  private readonly ruleVals = new Float64Array(8)
  /** Interpolated lattice channels of the current column. */
  private readonly iv = new Float64Array(NCH)

  constructor(seed: number, core: Fields['core'], origin: Fields['origin'], gateways: Gateway[]) {
    this.seed = seed
    this.cf = compiledFrontier()
    this.core = core
    this.origin = origin
    this.gateways = gateways
    const g = this.cf.fc.gen
    this.lat = Math.max(1, Math.floor(g.lattice))
    const f = (spec: NoiseSpec) => noiseField(spec, seedFor(seed, 'frontier'))
    const c = g.continent, h = g.height, cl = g.climate, rv = g.rivers, pv = g.provinces
    // Lattice channels in CH_* order (CH_CONT combines the large+mid bands; CH_RIVER is sampled at warped coords),
    // then the extra fields: [17] mid continent band, [18..19] river warp, [20..23] small continent band, islands,
    // hills, climate jitter.
    this.nf = [
      f(c.large), f(c.archipelago.mask), f(cl.temperature.noise), f(cl.moisture.noise), f(cl.weirdness.noise),
      f(cl.volcanic.noise), f(h.erosion), f(h.mountains.mask), f(h.mountains.ridge), f(h.mountains.pass),
      f(h.plateaus.noise), f(h.canyons.noise), f(rv.noise), f(rv.size), f(g.lakes.noise), f(pv.warp.x), f(pv.warp.y),
      f(c.mid), f(rv.warp.x), f(rv.warp.y),
      f(c.small), f(c.archipelago.islands), f(h.hills), f(cl.jitter.noise),
    ]
    this.detail = f(h.detail)
  }

  /** All lattice channels at lattice point (lx, ly) into out[off..off+NCH). */
  latticePoint(lx: number, ly: number, out: Float64Array, off: number): void {
    const g = this.cf.fc.gen
    const x = lx * this.lat, y = ly * this.lat
    const n = this.nf
    const w = g.continent.weights
    out[off + CH_CONT] = w[0] * n[0].sample(x, y) + w[1] * n[17].sample(x, y)
    out[off + CH_ARCH] = n[1].sample(x, y)
    out[off + CH_TEMP] = n[2].sample(x, y)
    out[off + CH_MOIST] = n[3].sample(x, y)
    out[off + CH_WEIRD] = n[4].sample(x, y)
    out[off + CH_VOLC] = n[5].sample(x, y)
    out[off + CH_ERO] = n[6].sample(x, y)
    out[off + CH_MMASK] = n[7].sample(x, y)
    out[off + CH_RIDGE] = 1 - Math.abs(2 * n[8].sample(x, y) - 1)
    out[off + CH_PASS] = n[9].sample(x, y)
    out[off + CH_PLAT] = n[10].sample(x, y)
    out[off + CH_CANYON] = 1 - Math.abs(2 * n[11].sample(x, y) - 1)
    const A = g.rivers.warp.amplitude
    const wx = x + (n[18].sample(x, y) - 0.5) * 2 * A
    const wy = y + (n[19].sample(x, y) - 0.5) * 2 * A
    out[off + CH_RIVER] = n[12].sample(wx, wy) - 0.5
    out[off + CH_RSIZE] = n[13].sample(x, y)
    out[off + CH_LAKE] = n[14].sample(x, y)
    const P = g.provinces.warp.amplitude
    out[off + CH_PWX] = (n[15].sample(x, y) - 0.5) * 2 * P
    out[off + CH_PWY] = (n[16].sample(x, y) - 0.5) * 2 * P
    out[off + CH_CONTS] = n[20].sample(x, y)
    out[off + CH_ISLE] = n[21].sample(x, y)
    out[off + CH_HILL] = n[22].sample(x, y)
    out[off + CH_JIT] = n[23].sample(x, y)
  }

  /** Lattice sheet covering tiles [x0, x1] x [y0, y1] (inclusive). */
  sheet(x0: number, y0: number, x1: number, y1: number): Sheet {
    const L = this.lat
    const lx = Math.floor(x0 / L), ly = Math.floor(y0 / L)
    const nx = Math.floor(x1 / L) - lx + 2, ny = Math.floor(y1 / L) - ly + 2
    const data = new Float64Array(nx * ny * NCH)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) this.latticePoint(lx + i, ly + j, data, (j * nx + i) * NCH)
    return { lx, ly, nx, ny, data }
  }

  /** Distance (tiles) from the core continent rectangle (0 inside). */
  coreDist(x: number, y: number): number {
    const c = this.core
    const dx = x < c.x ? c.x - x : x >= c.x + c.width ? x - (c.x + c.width - 1) : 0
    const dy = y < c.y ? c.y - y : y >= c.y + c.height ? y - (c.y + c.height - 1) : 0
    return dx === 0 ? dy : dy === 0 ? dx : Math.sqrt(dx * dx + dy * dy)
  }

  originDist(x: number, y: number): number {
    const dx = x - this.origin.x, dy = y - this.origin.y
    return Math.sqrt(dx * dx + dy * dy)
  }

  /** Fills `o` for tile (x, y); `s` must cover the tile's lattice cell. */
  column(x: number, y: number, s: Sheet, o: Column): void {
    const g = this.cf.fc.gen
    const L = this.lat
    const cx = Math.floor(x / L), cy = Math.floor(y / L)
    const fx = (x - cx * L) / L, fy = (y - cy * L) / L
    const i00 = ((cy - s.ly) * s.nx + (cx - s.lx)) * NCH
    const i10 = i00 + NCH, i01 = i00 + s.nx * NCH, i11 = i01 + NCH
    const d = s.data
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
    const iv = this.iv
    for (let ch = 0; ch < NCH; ch++) iv[ch] = d[i00 + ch] * w00 + d[i10 + ch] * w10 + d[i01 + ch] * w01 + d[i11 + ch] * w11

    // Continent: large + mid bands from the lattice, coastline detail per tile, archipelagos, the moat around the
    // core, and guaranteed landfall at the causeway gateways.
    const C = g.continent
    let c = iv[CH_CONT] + C.weights[2] * iv[CH_CONTS]
    c = 0.5 + (c - 0.5) * C.contrast
    const am = smooth(C.archipelago.maskRange[0], C.archipelago.maskRange[1], iv[CH_ARCH])
    if (am > 0) c += C.archipelago.amplitude * am * (iv[CH_ISLE] - 0.5)
    const dc = this.coreDist(x, y)
    if (dc < C.moat.far) c -= C.moat.depth * (1 - smooth(C.moat.near, C.moat.far, dc))
    // Gateways: a noise-wobbled landfall bump (organic coast) with a guaranteed dry core for the hamlet pad.
    const gw = g.causeways.gateway
    let gateFade = 1
    for (const p of this.gateways) {
      const ddx = x - p.x, ddy = y - p.y
      const dd = Math.sqrt(ddx * ddx + ddy * ddy)
      if (dd >= gw.radius + 2 * gw.wobble) continue
      gateFade = Math.min(gateFade, smooth(gw.radius, gw.radius + 2 * gw.wobble, dd))
      const dw = dd + (iv[CH_ISLE] - 0.5) * 2 * gw.wobble
      c += gw.bump * (1 - smooth(gw.land, gw.radius, dw))
      if (dd < gw.core) c = Math.max(c, C.seaLevel + C.inlandRange * gw.coreInland)
    }
    o.cont = c
    const inland = (c - C.seaLevel) / C.inlandRange
    o.inland = inland

    // Climate (temperature lapse applied after the height is known).
    const cl = g.climate
    const jit = (iv[CH_JIT] - 0.5) * 2 * cl.jitter.amplitude
    const lat = cl.temperature.latitude
    let t = 0.5 + (iv[CH_TEMP] - 0.5) * cl.temperature.contrast
    const ly = (y - this.origin.y) / lat.scale
    t += lat.gain * (ly < -1 ? -1 : ly > 1 ? 1 : ly) + jit * cl.jitter.weights.t
    const jw = cl.jitter.weights
    let m = 0.5 + (iv[CH_MOIST] - 0.5) * cl.moisture.contrast + jit * jw.m
    if (inland >= 0) m += cl.moisture.coast.boost * (1 - smooth(0, cl.moisture.coast.range, inland))
    const r0 = this.originDist(x, y)
    o.w = clamp01(0.5 + (iv[CH_WEIRD] - 0.5) * cl.weirdness.contrast + Math.min(cl.weirdness.max, (r0 / 1000) * cl.weirdness.perThousand) + jit * jw.w)
    o.volc = clamp01(0.5 + (iv[CH_VOLC] - 0.5) * cl.volcanic.contrast + jit * jw.volc)
    m = clamp01(m)
    o.m = m
    o.pwx = iv[CH_PWX]
    o.pwy = iv[CH_PWY]

    const cf = this.cf
    if (inland < 0) {
      // Sea: shallow shoals near coasts (walkable), deep water further out.
      const shallow = c >= C.seaLevel - C.shallowBand
      o.t = clamp01(t)
      o.rug = 0; o.mount = 0; o.h = 0; o.level = 0
      o.water = W_SEA
      o.deep = !shallow
      const rv = this.ruleVals
      rv[0] = o.t; rv[1] = m; rv[2] = o.w; rv[3] = 0; rv[4] = inland; rv[5] = 0; rv[6] = o.volc; rv[7] = 0
      o.biome = matchRule(cf.seaRules, rv, shallow)
      o.terrain = shallow ? cf.shallow : cf.water
      return
    }

    // Land height.
    const H = g.height
    const ramp = smooth(0, H.coastRamp, inland)
    const rug = 1 - smooth(H.erosionRange[0], H.erosionRange[1], iv[CH_ERO])
    let h = H.inlandLevels * (inland > 1 ? 1 : inland)
    h += (iv[CH_HILL] - 0.5) * 2 * H.hillAmp * (H.hillFlat + (1 - H.hillFlat) * rug) * ramp
    const M = H.mountains
    let mount = 0
    const mm = smooth(M.maskRange[0], M.maskRange[1], iv[CH_MMASK])
    if (mm > 0) {
      const r = iv[CH_RIDGE]
      const ps = smooth(M.passRange[0], M.passRange[1], iv[CH_PASS])
      mount = M.amplitude * mm * r * r * (1 - M.passDepth * ps) * ramp
      h += mount
    }
    const P = H.plateaus
    if (m < P.moistureMax) h += P.amplitude * smooth(P.threshold, P.threshold + P.edge, iv[CH_PLAT]) * ramp
    const K = H.canyons
    if (m < K.moistureMax) {
      const cv = iv[CH_CANYON]
      if (cv > K.threshold) h -= K.depth * smooth(K.threshold, 1, cv) * ramp
    }
    const smoothH = h
    h += (this.detail.sample(x, y) - 0.5) * 2 * H.detailAmp

    // Rivers: zero contour of warped noise; distance in tiles = |v| / |grad v| from the bilinear lattice cell.
    // Rivers taper out and lakes shrink around the gateways (their hamlets and lanes stay dry).
    let water = W_NONE, deep = false, waterLevel = 0
    const R = g.rivers
    if (m >= R.moistureMin && gateFade > 0) {
      const sz = iv[CH_RSIZE]
      if (sz > R.sizeCutoff) {
        const a = d[i00 + CH_RIVER], b = d[i10 + CH_RIVER], cc = d[i01 + CH_RIVER], dd = d[i11 + CH_RIVER]
        const rvv = a * w00 + b * w10 + cc * w01 + dd * w11
        if (Math.abs(rvv) < R.rejectAbove) {
          const gx = ((1 - fy) * (b - a) + fy * (dd - cc)) / L
          const gy = ((1 - fx) * (cc - a) + fx * (dd - b)) / L
          const dist = Math.abs(rvv) / (Math.sqrt(gx * gx + gy * gy) + 1e-9)
          const strength = smooth(R.sizeCutoff, R.sizeCutoff + R.strengthRamp, sz)
          const width = (R.width[0] + (R.width[1] - R.width[0]) * strength) * gateFade
          const valley = R.valley * gateFade
          if (dist < width + valley) {
            const k = 1 - Math.max(0, dist - width) / valley
            const carve = R.valleyDepth * k * k * (R.carveMin + (1 - R.carveMin) * strength)
            h -= carve
            if (dist < width) {
              water = W_RIVER
              deep = width >= R.deepMin && dist < width - R.bank
              const wl = smoothH - carve
              waterLevel = wl < 0 ? 0 : Math.floor(wl)
            }
          }
        }
      }
    }

    // Lakes: basins pulled toward a flat level, water above the threshold.
    const LK = g.lakes
    if (water === W_NONE && m >= LK.moistureMin && mount < LK.mountainMax) {
      const lk = iv[CH_LAKE] - LK.coastFade * (2 - smooth(LK.inlandMin, 2 * LK.inlandMin, inland) - gateFade)
      if (lk > LK.threshold - LK.blend) {
        const base = H.inlandLevels * (inland > 1 ? 1 : inland)
        const ll = Math.floor(base)
        const k = smooth(LK.threshold - LK.blend, LK.threshold, lk)
        h = h + (ll + LK.levelOffset - h) * k
        if (lk > LK.threshold) { water = W_LAKE; deep = lk > LK.threshold + LK.deep; waterLevel = ll }
      }
    }

    if (h < 0) h = 0
    let level = Math.floor(h)
    if (level > H.maxLevel) level = H.maxLevel
    if (water !== W_NONE) level = Math.min(level, waterLevel)
    o.h = h
    o.level = level
    o.rug = rug
    o.mount = mount
    o.t = clamp01(t - cl.temperature.lapse * h)
    o.water = water
    o.deep = deep
    const rv = this.ruleVals
    rv[0] = o.t; rv[1] = m; rv[2] = o.w; rv[3] = level; rv[4] = inland; rv[5] = rug; rv[6] = o.volc; rv[7] = mount
    const bi = matchRule(cf.rules, rv, false)
    o.biome = bi
    const tables = cf.biome[bi]
    if (water !== W_NONE) o.terrain = deep ? cf.water : cf.shallow
    else if (level === 0 && inland < C.beachInland) o.terrain = tables ? tables.beach : cf.shallow
    else o.terrain = tables ? tables.ground : cf.roadDefault
  }

  /** Column at an arbitrary tile without a prepared sheet (4 lattice points; ~2 µs). */
  columnAt(x: number, y: number, o: Column): void {
    const L = this.lat
    const s = this.sheet(Math.floor(x / L) * L, Math.floor(y / L) * L, Math.floor(x / L) * L, Math.floor(y / L) * L)
    this.column(x, y, s, o)
  }
}
