// Hydrology on a coarse lattice (stride overworld.coarse): priority-flood depression filling from the sea and
// lakes gives every cell a downstream direction (D8); drainage accumulation (weighted by moisture) selects
// river cells; deep basins become lakes. Rivers are rasterised with meander and width growing with drainage,
// and carve the continuous height field with a water level that never rises downstream (valleys follow from
// the slope envelope). 'cliff' zones keep their rivers above sea level (waterfall into the sea).
import { createNoise, fbm } from '../noise.ts'
import { seedFor } from './random.ts'
import type { OverworldSpec } from './schema.ts'

export interface HydroInput {
  seed: number
  spec: OverworldSpec
  W: number
  H: number
  C: number
  hf: Float32Array
  sea: Uint8Array
  locked: Uint8Array
  lake: Uint8Array
  lakeRim: Uint8Array
  island: Uint8Array
  moist: Float32Array
  zoneRaw: Uint8Array
  cliffZone: boolean[]
  /** Registers a new lake terrain pair; returns its lake index + 1. */
  lakeKey: () => number
}

export interface Hydrology {
  /** 1 = river channel, 2 = bank. */
  river: Uint8Array
  /** Basin lakes to flatten (lake + rim tiles at level T). */
  lockGroups: { cells: number[]; T: number }[]
  rivers: number
  lakes: number
  riverTiles: number
}

class MinHeap {
  keys: Float64Array
  vals: Int32Array
  size = 0
  constructor(cap: number) { this.keys = new Float64Array(cap); this.vals = new Int32Array(cap) }
  push(k: number, v: number): void {
    if (this.size === this.keys.length) {
      const nk = new Float64Array(this.size * 2); nk.set(this.keys); this.keys = nk
      const nv = new Int32Array(this.size * 2); nv.set(this.vals); this.vals = nv
    }
    let i = this.size++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p] < k || (this.keys[p] === k && this.vals[p] <= v)) break
      this.keys[i] = this.keys[p]; this.vals[i] = this.vals[p]
      i = p
    }
    this.keys[i] = k; this.vals[i] = v
  }
  pop(): number {
    const top = this.vals[0]
    const k = this.keys[--this.size], v = this.vals[this.size]
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      if (l >= this.size) break
      const r = l + 1
      let c = l
      if (r < this.size && (this.keys[r] < this.keys[l] || (this.keys[r] === this.keys[l] && this.vals[r] < this.vals[l]))) c = r
      if (this.keys[c] > k || (this.keys[c] === k && this.vals[c] >= v)) break
      this.keys[i] = this.keys[c]; this.vals[i] = this.vals[c]
      i = c
    }
    this.keys[i] = k; this.vals[i] = v
    return top
  }
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1]
const DY = [0, 0, 1, -1, 1, -1, 1, -1]
const EPS = 1e-3

export function runHydrology(h: HydroInput): Hydrology {
  const { W, H, C, hf, sea, locked, lake, lakeRim, island, spec } = h
  const hy = spec.hydrology
  const N = W * H
  const gw = Math.ceil(W / C), gh = Math.ceil(H / C), G = gw * gh
  const ch = new Float32Array(G).fill(Infinity)
  const kind = new Uint8Array(G) // 0 land, 1 outlet (sea / lake), 2 blocked (pads, islands)
  const rain = new Float32Array(G)
  for (let y = 0; y < H; y++) {
    const cy = Math.floor(y / C)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const c = cy * gw + Math.floor(x / C)
      if (hf[i] < ch[c]) ch[c] = hf[i]
      if (sea[i] || lake[i]) kind[c] = 1
      else if (kind[c] !== 1 && ((locked[i] && !lakeRim[i]) || island[i])) kind[c] = 2
    }
  }
  for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
    const x = Math.min(W - 1, cx * C + (C >> 1)), y = Math.min(H - 1, cy * C + (C >> 1))
    rain[cy * gw + cx] = 0.4 + h.moist[y * W + x]
  }

  // Priority-flood (epsilon variant): every reached cell drains strictly downhill on the filled surface.
  const filled = new Float32Array(G)
  const dir = new Int32Array(G).fill(-1)
  const closed = new Uint8Array(G)
  const order = new Int32Array(G)
  let n = 0
  const heap = new MinHeap(4096)
  for (let c = 0; c < G; c++) {
    const cx = c % gw, cy = (c - cx) / gw
    const border = cx === 0 || cy === 0 || cx === gw - 1 || cy === gh - 1
    if (kind[c] === 1 || (border && kind[c] === 0)) { closed[c] = 1; filled[c] = ch[c]; heap.push(ch[c], c) }
  }
  while (heap.size > 0) {
    const c = heap.pop()
    order[n++] = c
    const cx = c % gw, cy = (c - cx) / gw
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k], ny = cy + DY[k]
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue
      const nb = ny * gw + nx
      if (closed[nb] || kind[nb] === 2) continue
      closed[nb] = 1
      const f = filled[c] + EPS
      filled[nb] = ch[nb] > f ? ch[nb] : f
      dir[nb] = c
      heap.push(filled[nb], nb)
    }
  }
  const acc = new Float32Array(G)
  for (let k = n - 1; k >= 0; k--) {
    const c = order[k]
    if (kind[c] === 0) acc[c] += rain[c]
    if (dir[c] >= 0) acc[dir[c]] += acc[c]
  }

  // --- basin lakes ------------------------------------------------------------------------------------
  const lockGroups: { cells: number[]; T: number }[] = []
  const basin = new Int32Array(G)
  const comps: { cells: number[]; spill: number }[] = []
  for (let c = 0; c < G; c++) {
    if (basin[c] || kind[c] !== 0 || !closed[c] || filled[c] - ch[c] < hy.lakeDepth) continue
    const id = comps.length + 1
    const cells = [c]
    basin[c] = id
    let spill = filled[c]
    for (let q = 0; q < cells.length; q++) {
      const cc = cells[q]
      const cx = cc % gw, cy = (cc - cx) / gw
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], ny = cy + DY[k]
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue
        const nb = ny * gw + nx
        if (basin[nb] || kind[nb] !== 0 || !closed[nb] || filled[nb] - ch[nb] < hy.lakeDepth) continue
        basin[nb] = id
        cells.push(nb)
        if (filled[nb] > spill) spill = filled[nb]
      }
    }
    comps.push({ cells, spill })
  }
  const lakeCell = new Uint8Array(G)
  // Basins next to blocked cells (town / site pads) would hug the pad's straight edges: skip them.
  const touchesBlocked = (cells: number[]) => cells.some((c) => {
    const cx = c % gw, cy = (c - cx) / gw
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k], ny = cy + DY[k]
      if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && kind[ny * gw + nx] === 2) return true
    }
    return false
  })
  const keepLakes = comps.map((cp, k) => ({ cp, k })).filter(({ cp }) => cp.cells.length >= hy.lakeMinCells && !touchesBlocked(cp.cells))
    .sort((a, b) => b.cp.cells.length - a.cp.cells.length || a.k - b.k).slice(0, hy.maxLakes)
  // Lake tiles: flood from the basin cells over tiles below the water line, so shores follow the terrain
  // instead of the coarse grid (bounded to a couple of cells around the basin).
  const isLakeTile = new Uint8Array(N)
  // Basin lakes are flattened too: a lake tile at level T must fit the slope envelope of the groups already
  // flattened (and the sea), or the final levels would form a cliff between them.
  const { lo: lockLo, hi: lockHi } = lockBounds(W, H, hf, locked, sea, spec.seaLevel + 0.5, spec.slope)
  // ... keeps clear of other lakes, and is dropped when it would reach a pad (it would surround a town or site).
  const padDist = chebyshevDist(W, H, (i) => locked[i] === 1 && !lake[i] && !lakeRim[i], 8)
  const lakeDist = chebyshevDist(W, H, (i) => lake[i] !== 0 || lakeRim[i] !== 0, 4)
  const near = new Uint8Array(G)
  const R = 12
  const otherLakeNear = (i: number) => {
    const x = i % W, y = (i - x) / W
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const nx = x + dx, ny = y + dy
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && (lake[ny * W + nx] !== 0 || lakeRim[ny * W + nx] !== 0)) return true
    }
    return false
  }
  for (const { cp } of keepLakes) {
    const T = Math.max(0, Math.floor(cp.spill - 0.5))
    const wl = cp.spill - 0.2
    const touched: number[] = []
    for (const c of cp.cells) {
      const cx = c % gw, cy = (c - cx) / gw
      for (let oy = -R; oy <= R; oy++) for (let ox = -R; ox <= R; ox++) {
        const nx = cx + ox, ny = cy + oy
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh || near[ny * gw + nx]) continue
        near[ny * gw + nx] = 1
        touched.push(ny * gw + nx)
      }
    }
    const tv = T + 0.5
    let reject = false
    const free = (i: number) => {
      if (locked[i] || sea[i] || lake[i] || isLakeTile[i] || hf[i] > wl || lakeDist[i] <= 3) return false
      if (tv > lockHi[i] || tv < lockLo[i] || otherLakeNear(i)) return false
      if (padDist[i] <= 6) reject = true
      return true
    }
    const cells: number[] = []
    for (const c of cp.cells) {
      const cx = c % gw, cy = (c - cx) / gw
      for (let y = cy * C; y < Math.min(H, cy * C + C); y++) for (let x = cx * C; x < Math.min(W, cx * C + C); x++) {
        const i = y * W + x
        if (!free(i)) continue
        isLakeTile[i] = 1
        cells.push(i)
      }
    }
    for (let q = 0; q < cells.length && !reject; q++) {
      const i = cells[q]
      const x = i % W, y = (i - x) / W
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0) continue
        const jx = j % W, jy = (j - jx) / W
        if (!near[Math.floor(jy / C) * gw + Math.floor(jx / C)] || !free(j)) continue
        isLakeTile[j] = 1
        cells.push(j)
      }
    }
    for (const c of touched) near[c] = 0
    if (reject || !cells.length) {
      for (const i of cells) isLakeTile[i] = 0
      continue
    }
    for (const c of cp.cells) lakeCell[c] = 1
    const key = h.lakeKey()
    for (const i of cells) lake[i] = key
    const rim: number[] = []
    for (const i of cells) {
      const x = i % W
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j < 0 || j >= N || isLakeTile[j] || lakeRim[j] || sea[j] || locked[j] || lake[j]) continue
        lakeRim[j] = key
        rim.push(j)
      }
    }
    lockGroups.push({ cells: cells.concat(rim), T })
  }

  // --- rivers ------------------------------------------------------------------------------------------
  const isRiver = new Uint8Array(G)
  for (let c = 0; c < G; c++) if (kind[c] === 0 && closed[c] && acc[c] >= hy.riverThreshold) isRiver[c] = 1
  const hasUp = new Uint8Array(G)
  for (let c = 0; c < G; c++) if (isRiver[c] && dir[c] >= 0) hasUp[dir[c]] = 1
  const traced = new Uint8Array(G)
  const chains: number[][] = []
  for (let k = n - 1; k >= 0; k--) {
    const head = order[k]
    if (!isRiver[head] || hasUp[head] || traced[head]) continue
    const chain: number[] = []
    let c = head
    while (c >= 0 && !traced[c] && kind[c] === 0) { chain.push(c); c = dir[c] }
    if (c >= 0) chain.push(c) // outlet or confluence
    if (chain.length < hy.minLength) continue
    for (const x of chain) if (kind[x] === 0) traced[x] = 1
    chains.push(chain)
  }
  // Water level per cell: never rises downstream; cliff zones stay above the sea.
  const wl = Float32Array.from(ch)
  for (let k = n - 1; k >= 0; k--) {
    const c = order[k]
    if (traced[c] && dir[c] >= 0 && wl[c] < wl[dir[c]]) wl[dir[c]] = wl[c]
  }
  const seaH = spec.seaLevel + 0.5
  const cellZoneCliff = (c: number) => {
    const cx = c % gw, cy = (c - cx) / gw
    return h.cliffZone[h.zoneRaw[Math.min(H - 1, cy * C + (C >> 1)) * W + Math.min(W - 1, cx * C + (C >> 1))]]
  }
  for (let c = 0; c < G; c++) if (traced[c] && cellZoneCliff(c) && wl[c] < seaH + 1) wl[c] = seaH + 1

  // Rasterise: meandered cell centres, smoothed along the chain, Catmull-Rom between them.
  const mn = createNoise(seedFor(h.seed, hy.meanderNoise.salt))
  const mo = { frequency: 1 / hy.meanderNoise.scale, octaves: hy.meanderNoise.octaves, gain: hy.meanderNoise.gain, lacunarity: hy.meanderNoise.lacunarity }
  const centre = (c: number) => {
    const cx = c % gw, cy = (c - cx) / gw
    const x = cx * C + C / 2, y = cy * C + C / 2
    if (kind[c] === 1) return { x, y }
    return { x: x + hy.meander * fbm(mn, x, y, mo) * 1.4, y: y + hy.meander * fbm(mn, x + 977, y + 331, mo) * 1.4 }
  }
  const carve = new Float32Array(N).fill(Infinity)
  const river = new Uint8Array(N)
  const blockedTile = (i: number) => sea[i] === 1 || lake[i] !== 0 || locked[i] === 1 || lakeRim[i] !== 0 || island[i] !== 0
  const brush = (fx: number, fy: number, width: number, level: number) => {
    const lo = -Math.floor((width - 1) / 2), hi = Math.ceil((width - 1) / 2)
    const cxp = Math.floor(fx), cyp = Math.floor(fy)
    for (let oy = lo; oy <= hi; oy++) for (let ox = lo; ox <= hi; ox++) {
      const x = cxp + ox, y = cyp + oy
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue
      const i = y * W + x
      if (blockedTile(i)) continue
      river[i] = 1
      if (level < carve[i]) carve[i] = level
    }
  }
  for (const chain of chains) {
    const raw = chain.map(centre)
    const pts = raw.map((p, k) => {
      if (k === 0 || k === raw.length - 1) return p
      let sx = 0, sy = 0, n = 0
      for (let j = Math.max(0, k - 2); j <= Math.min(raw.length - 1, k + 2); j++) { sx += raw[j].x; sy += raw[j].y; n++ }
      return { x: sx / n, y: sy / n }
    })
    for (let k = 0; k + 1 < chain.length; k++) {
      const a = chain[k], b = chain[k + 1]
      if (lakeCell[a] && lakeCell[b]) continue
      const width = Math.min(hy.maxWidth, 1 + Math.floor(acc[a] / hy.widthStep))
      const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(pts.length - 1, k + 2)]
      const len = Math.sqrt((p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y))
      const steps = Math.max(1, Math.ceil(len * 2))
      const wa = wl[a], wb = kind[b] === 1 ? Math.min(wl[a], wl[b]) : wl[b]
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, t2 = t * t, t3 = t2 * t
        const fx = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3)
        const fy = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
        brush(fx, fy, width, wa + (wb - wa) * t)
      }
    }
  }
  let riverTiles = 0
  for (let i = 0; i < N; i++) {
    if (river[i] !== 1) continue
    riverTiles++
    if (carve[i] < hf[i]) hf[i] = carve[i]
  }
  if (hy.bank > 0) {
    for (let i = 0; i < N; i++) {
      if (river[i] !== 1) continue
      const x = i % W, y = (i - x) / W
      const cap = Math.floor(hf[i]) + 0.95
      for (let oy = -hy.bank; oy <= hy.bank; oy++) for (let ox = -hy.bank; ox <= hy.bank; ox++) {
        const nx = x + ox, ny = y + oy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const j = ny * W + nx
        if (river[j] === 1 || blockedTile(j)) continue
        river[j] = 2
        if (hf[j] > cap) hf[j] = cap
      }
    }
  }
  return { river, lockGroups, rivers: chains.length, lakes: lockGroups.length, riverTiles }
}

/** Bounds the locked groups put on every tile: hi = min(lock + slope * d) (sea included), lo = max(lock - slope * d). */
export function lockBounds(W: number, H: number, hf: Float32Array, locked: Uint8Array, sea: Uint8Array, seaH: number, s: number): { lo: Float32Array; hi: Float32Array } {
  const N = W * H
  const hi = new Float32Array(N), lo = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    hi[i] = locked[i] ? hf[i] : sea[i] ? seaH : Infinity
    lo[i] = locked[i] ? hf[i] : -Infinity
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    let a = hi[i], b = lo[i]
    const visit = (j: number) => { if (hi[j] + s < a) a = hi[j] + s; if (lo[j] - s > b) b = lo[j] - s }
    if (x > 0) visit(i - 1)
    if (y > 0) { visit(i - W); if (x > 0) visit(i - W - 1); if (x < W - 1) visit(i - W + 1) }
    hi[i] = a; lo[i] = b
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x
    let a = hi[i], b = lo[i]
    const visit = (j: number) => { if (hi[j] + s < a) a = hi[j] + s; if (lo[j] - s > b) b = lo[j] - s }
    if (x < W - 1) visit(i + 1)
    if (y < H - 1) { visit(i + W); if (x < W - 1) visit(i + W + 1); if (x > 0) visit(i + W - 1) }
    hi[i] = a; lo[i] = b
  }
  return { lo, hi }
}

function chebyshevDist(W: number, H: number, isSource: (i: number) => boolean, cap: number): Uint8Array {
  const N = W * H
  const dist = new Uint8Array(N).fill(cap)
  let frontier: number[] = []
  for (let i = 0; i < N; i++) if (isSource(i)) { dist[i] = 0; frontier.push(i) }
  for (let d = 1; d < cap && frontier.length; d++) {
    const next: number[] = []
    for (const i of frontier) {
      const x = i % W, y = (i - x) / W
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const j = ny * W + nx
        if (dist[j] > d) { dist[j] = d; next.push(j) }
      }
    }
    frontier = next
  }
  return dist
}
