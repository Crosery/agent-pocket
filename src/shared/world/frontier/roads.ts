// Road network of the frontier: every road-bearing site links to the next road-bearing site east and south
// (skipping up to roads.maxGap empty cells) by a Z-shaped, axis-aligned road; causeway lanes link the core coast
// to the gateway hamlets. Each edge is a pure function of its two sites, so chunks rasterise the same tiles no
// matter which one asks first. Each gateway hamlet also gets an "onward" edge to the nearest road-bearing site in
// its causeway direction that may bridge any amount of sea, so the core always connects to the frontier road
// network on foot. Edge heights are graded: a 1-Lipschitz level profile (level changes only on
// straight land stretches, never on bridges, near corners or inside pads) with stairs on the lower tile.
import { WORLD_CONTENT } from '../data.ts'
import { hash3, hashString } from '../random.ts'
import { Fields, newColumn, W_NONE, W_SEA, type Sheet } from './fields.ts'
import { Lru } from './lru.ts'
import type { FrontierSite, Gate, SiteGrid } from './sites.ts'

export interface RoadEdge {
  id: string
  a: FrontierSite | null
  b: FrontierSite
  gate: Gate | null
  /** Path tiles in order (4-connected). */
  xs: Int32Array
  ys: Int32Array
  /** Graded level per path tile. */
  levels: Uint8Array
  /** Terrain id per path tile (road / bridge / causeway / stairs). */
  terrain: Uint8Array
  /** 1 = drawn (inside the pads' plaza stop radius the road is not drawn). */
  drawn: Uint8Array
  x0: number; y0: number; x1: number; y1: number
  /** Endpoint levels could not be reconciled (a cliff remains somewhere). */
  broken: boolean
}

function pushSeg(xs: number[], ys: number[], x0: number, y0: number, x1: number, y1: number): void {
  const dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0)
  let x = x0, y = y0
  if (!xs.length || xs[xs.length - 1] !== x || ys[ys.length - 1] !== y) { xs.push(x); ys.push(y) }
  while (x !== x1 || y !== y1) {
    x += dx; y += dy
    xs.push(x); ys.push(y)
  }
}

export class RoadNet {
  readonly fields: Fields
  readonly grid: SiteGrid
  private readonly cache: Lru<string, RoadEdge | null>
  private readonly col = newColumn()

  constructor(fields: Fields, grid: SiteGrid) {
    this.fields = fields
    this.grid = grid
    this.cache = new Lru(fields.cf.fc.gen.cache.edges)
  }

  /** Stop radius: roads end at the plaza (hamlets) or just outside the centre prop. */
  private stopRadius(s: FrontierSite): number {
    const st = this.fields.cf.fc.gen.roads.stop
    return s.type === 'hamlet' ? (this.fields.cf.fc.sites.hamlet.plaza?.radius ?? WORLD_CONTENT.pois.hamlets.plaza.radius) + st.plazaPad : st.poi
  }

  /** Every edge whose bounding box (grown by `pad`) touches [x0, x1) x [y0, y1). */
  edgesNear(x0: number, y0: number, x1: number, y1: number, pad: number): RoadEdge[] {
    const g = this.fields.cf.fc.gen.roads
    const C = this.grid.cell
    const reach = (g.maxGap + 2) * C
    const out: RoadEdge[] = []
    const seen = new Set<string>()
    const take = (e: RoadEdge | null) => {
      if (!e || seen.has(e.id)) return
      if (e.x1 < x0 - pad || e.x0 >= x1 + pad || e.y1 < y0 - pad || e.y0 >= y1 + pad) return
      seen.add(e.id)
      out.push(e)
    }
    for (let sy = Math.floor((y0 - reach) / C); sy <= Math.floor((y1 + C) / C); sy++) {
      for (let sx = Math.floor((x0 - reach) / C); sx <= Math.floor((x1 + C) / C); sx++) {
        const a = this.grid.siteAt(sx, sy)
        if (!a || !a.roads) continue
        take(this.edge(a, 'h'))
        take(this.edge(a, 'v'))
      }
    }
    for (const gate of this.grid.gates) {
      const [gx, gy] = this.grid.cellOf(gate.x, gate.y)
      const g = this.grid.siteAt(gx, gy)
      if (!g?.gate) continue
      take(this.gateEdge(g))
      take(this.onwardEdge(g))
    }
    out.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))
    return out
  }

  private edge(a: FrontierSite, dir: 'h' | 'v'): RoadEdge | null {
    const key = `${a.id}|${dir}`
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const e = this.buildSiteEdge(a, dir)
    this.cache.set(key, e)
    return e
  }

  private gateEdge(g: FrontierSite): RoadEdge | null {
    const key = `${g.id}|gate`
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const gate = g.gate!
    const xs: number[] = [], ys: number[] = []
    pushSeg(xs, ys, gate.out.x, gate.out.y, g.x, g.y)
    const e = this.finish(`road:${gate.id}`, null, g, gate, xs, ys, true)
    this.cache.set(key, e)
    return e
  }

  /** Gateway hamlet -> nearest road-bearing site ahead (causeway.onward cells, lateral offsets 0, -1, +1). */
  private onwardEdge(g: FrontierSite): RoadEdge | null {
    const key = `${g.id}|onward`
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const gate = g.gate!
    const cw = this.fields.cf.fc.gen.causeways
    let b: FrontierSite | null = null
    for (let k = 1; k <= cw.onwardCells && !b; k++) {
      for (const lat of [0, -1, 1]) {
        const sx = g.sx + gate.dir.x * k + (gate.dir.x === 0 ? lat : 0)
        const sy = g.sy + gate.dir.y * k + (gate.dir.y === 0 ? lat : 0)
        const s = this.grid.siteAt(sx, sy)
        if (s && s.roads && !s.gate) { b = s; break }
      }
    }
    let e: RoadEdge | null = null
    if (b) {
      const xs: number[] = [], ys: number[] = []
      if (gate.dir.x !== 0) {
        const mx = Math.round((g.x + b.x) / 2)
        pushSeg(xs, ys, g.x, g.y, mx, g.y); pushSeg(xs, ys, mx, g.y, mx, b.y); pushSeg(xs, ys, mx, b.y, b.x, b.y)
      } else {
        const my = Math.round((g.y + b.y) / 2)
        pushSeg(xs, ys, g.x, g.y, g.x, my); pushSeg(xs, ys, g.x, my, b.x, my); pushSeg(xs, ys, b.x, my, b.x, b.y)
      }
      e = this.finish(`road:${gate.id}:onward`, g, b, null, xs, ys, true)
    }
    this.cache.set(key, e)
    return e
  }

  private buildSiteEdge(a: FrontierSite, dir: 'h' | 'v'): RoadEdge | null {
    const F = this.fields
    const g = F.cf.fc.gen.roads
    let b: FrontierSite | null = null
    for (let k = 1; k <= g.maxGap + 1 && !b; k++) {
      const s = dir === 'h' ? this.grid.siteAt(a.sx + k, a.sy) : this.grid.siteAt(a.sx, a.sy + k)
      if (s && s.roads) b = s
    }
    if (!b) return null
    const h = hash3(F.seed, hashString(a.id), dir === 'h' ? 0x68 : 0x76)
    if (!a.gate && !b.gate && h / 4294967296 < g.skip) return null
    const f = g.bend[0] + ((h >>> 8) / 16777216) * (g.bend[1] - g.bend[0])
    const xs: number[] = [], ys: number[] = []
    if (dir === 'h') {
      const mx = a.x + Math.round((b.x - a.x) * f)
      pushSeg(xs, ys, a.x, a.y, mx, a.y)
      pushSeg(xs, ys, mx, a.y, mx, b.y)
      pushSeg(xs, ys, mx, b.y, b.x, b.y)
    } else {
      const my = a.y + Math.round((b.y - a.y) * f)
      pushSeg(xs, ys, a.x, a.y, a.x, my)
      pushSeg(xs, ys, a.x, my, b.x, my)
      pushSeg(xs, ys, b.x, my, b.x, b.y)
    }
    return this.finish(`road:${a.id}>${b.id}`, a, b, null, xs, ys)
  }

  /** Columns along the path (one thin sheet per straight segment), sea-run check, graded profile. */
  /** `causeway`: any sea crossing allowed, water tiles become causeway instead of bridge. */
  private finish(id: string, a: FrontierSite | null, b: FrontierSite, gate: Gate | null, xs: number[], ys: number[], causeway = false): RoadEdge | null {
    const F = this.fields
    const cf = F.cf
    const g = cf.fc.gen.roads
    const n = xs.length
    const target = new Float64Array(n)
    const water = new Uint8Array(n)
    const sea = new Uint8Array(n)
    const ground = new Uint8Array(n)
    const col = this.col
    let sheet: Sheet | null = null
    let segStart = 0
    for (let i = 0; i < n; i++) {
      // New sheet at every corner (straight segments are thin rectangles). segStart is the index where the current
      // sheet's straight run ends (its closing corner), so the next sheet starts exactly there.
      if (!sheet || i === segStart) {
        let j = i + 1
        while (j < n - 1 && xs[j + 1] - xs[j] === xs[j] - xs[j - 1] && ys[j + 1] - ys[j] === ys[j] - ys[j - 1]) j++
        const xa = Math.min(xs[i], xs[Math.min(j, n - 1)]), xb = Math.max(xs[i], xs[Math.min(j, n - 1)])
        const ya = Math.min(ys[i], ys[Math.min(j, n - 1)]), yb = Math.max(ys[i], ys[Math.min(j, n - 1)])
        sheet = F.sheet(xa, ya, xb, yb)
        segStart = Math.min(j, n - 1)
      }
      F.column(xs[i], ys[i], sheet, col)
      target[i] = col.h
      water[i] = col.water !== W_NONE ? 1 : 0
      sea[i] = col.water === W_SEA ? 1 : 0
      const bt = cf.biome[col.biome]
      ground[i] = bt ? bt.road : cf.roadDefault
    }
    // Long open-sea crossings: no road (causeway lanes are exempt).
    if (!causeway) {
      let run = 0
      for (let i = 0; i < n; i++) {
        run = sea[i] ? run + 1 : 0
        if (run > g.maxSeaRun) return null
      }
    }
    // Fixed levels inside the pads; free steps (c = 1) only between two land tiles away from corners.
    const fixed = new Int16Array(n).fill(-1)
    const inPad = (s: FrontierSite, i: number) => {
      const dx = xs[i] - s.x, dy = ys[i] - s.y
      return dx * dx + dy * dy <= s.radius * s.radius
    }
    for (let i = 0; i < n; i++) {
      if (a && inPad(a, i)) fixed[i] = a.level
      else if (inPad(b, i)) fixed[i] = b.level
    }
    if (gate) fixed[0] = 0
    const c = new Uint8Array(n)
    for (let i = 1; i < n; i++) c[i] = water[i] || water[i - 1] || fixed[i] >= 0 || fixed[i - 1] >= 0 ? 0 : 1
    for (let i = 1; i < n - 1; i++) {
      const turn = xs[i + 1] - xs[i] !== xs[i] - xs[i - 1] || ys[i + 1] - ys[i] !== ys[i] - ys[i - 1]
      if (!turn) continue
      for (let k = Math.max(1, i - g.cornerFree); k <= Math.min(n - 1, i + g.cornerFree + 1); k++) c[k] = 0
    }
    // Smoothed target (moving average), rounded to levels.
    const half = Math.max(0, Math.floor(g.smooth / 2))
    const pre = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + target[i]
    const maxLevel = cf.fc.gen.height.maxLevel
    const lv = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1)
      const v = Math.floor((pre[hi] - pre[lo]) / (hi - lo))
      lv[i] = fixed[i] >= 0 ? fixed[i] : v < 0 ? 0 : v > maxLevel ? maxLevel : v
    }
    // Weighted distance D(i, j) = |C[j] - C[i]|; clamp to the fixed points' reach, then the lower 1-Lipschitz envelope.
    const Cs = new Float64Array(n)
    for (let i = 1; i < n; i++) Cs[i] = Cs[i - 1] + c[i]
    const lower = new Float64Array(n).fill(-Infinity)
    let best = -Infinity
    for (let i = 0; i < n; i++) { if (fixed[i] >= 0) best = Math.max(best, fixed[i] + Cs[i]); lower[i] = best - Cs[i] }
    best = -Infinity
    for (let i = n - 1; i >= 0; i--) { if (fixed[i] >= 0) best = Math.max(best, fixed[i] - Cs[i]); lower[i] = Math.max(lower[i], best + Cs[i]) }
    for (let i = 0; i < n; i++) if (lv[i] < lower[i]) lv[i] = lower[i]
    for (let i = 1; i < n; i++) lv[i] = Math.min(lv[i], lv[i - 1] + c[i])
    for (let i = n - 2; i >= 0; i--) lv[i] = Math.min(lv[i], lv[i + 1] + c[i + 1])
    // Single-tile dips can't hold stairs both ways: fill them.
    for (let i = 1; i < n - 1; i++) if (lv[i] < lv[i - 1] && lv[i] < lv[i + 1]) lv[i] = Math.min(lv[i - 1], lv[i + 1])
    let broken = false
    for (let i = 0; i < n; i++) if (fixed[i] >= 0 && lv[i] !== fixed[i]) broken = true
    for (let i = 1; i < n; i++) if (Math.abs(lv[i] - lv[i - 1]) > 1) broken = true
    const levels = new Uint8Array(n)
    const terrain = new Uint8Array(n)
    const drawn = new Uint8Array(n)
    const stopA = a ? this.stopRadius(a) : 0, stopB = this.stopRadius(b)
    for (let i = 0; i < n; i++) {
      levels[i] = lv[i] < 0 ? 0 : lv[i]
      terrain[i] = water[i] ? (causeway ? cf.causeway : cf.bridge) : ground[i]
      const da = a ? (xs[i] - a.x) * (xs[i] - a.x) + (ys[i] - a.y) * (ys[i] - a.y) : Infinity
      const db = (xs[i] - b.x) * (xs[i] - b.x) + (ys[i] - b.y) * (ys[i] - b.y)
      drawn[i] = da > stopA * stopA && db > stopB * stopB ? 1 : 0
    }
    // Stairs on the lower tile of every level change.
    for (let i = 1; i < n; i++) {
      if (levels[i] === levels[i - 1]) continue
      const lo = levels[i] < levels[i - 1] ? i : i - 1
      terrain[lo] = cf.stairs
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i < n; i++) {
      if (xs[i] < x0) x0 = xs[i]
      if (xs[i] > x1) x1 = xs[i]
      if (ys[i] < y0) y0 = ys[i]
      if (ys[i] > y1) y1 = ys[i]
    }
    return { id, a, b, gate, xs: Int32Array.from(xs), ys: Int32Array.from(ys), levels, terrain, drawn, x0, y0, x1, y1, broken }
  }
}
