// Rivers: downhill-preferring A* between JSON control points, smoothed, carved with a square brush + shallow banks.
import { findPath } from './astar.ts'
import { F_LAKE, F_LOCK, F_RIVER, F_SEA, F_EDGE, addFlag, hasFlag } from './grid.ts'
import { noiseField } from './random.ts'
import { tid, type OwCtx } from './ctx.ts'

export function carveRivers(ctx: OwCtx): void {
  const { d, spec } = ctx
  const rc = spec.riverRouting
  const meander = noiseField(rc.noiseSpec, ctx.seed)
  const W = d.w
  const cost = (a: number, b: number): number => {
    // Lake rims are locked (flattened) but rivers must cross them to reach the lake.
    if (hasFlag(d, b, F_SEA) || hasFlag(d, b, F_LAKE) || ctx.macro.lakeRim[b]) return rc.base * 0.5
    if (hasFlag(d, b, F_LOCK) || hasFlag(d, b, F_EDGE)) return Infinity
    const bx = b % W, by = (b - bx) / W
    let c = rc.base + rc.noise * meander.sample(bx, by)
    if (d.elevation[b] > d.elevation[a]) c += rc.uphill
    return c
  }
  const routable = (i: number) => cost(i, i) !== Infinity
  const isWater = (i: number) => hasFlag(d, i, F_SEA) || hasFlag(d, i, F_LAKE) || ctx.macro.lakeRim[i] !== 0
  // Lakes and coasts move with the seed, so a control point may land on a (locked) lake rim: BFS ring by ring
  // to the nearest routable tile, preferring open water within the first ring that has any.
  const snap = (start: number): number => {
    if (routable(start)) return start
    const seen = new Set([start])
    let ring = [start]
    for (let r = 0; r < rc.snap && ring.length; r++) {
      const next: number[] = []
      for (const i of ring) {
        const x = i % W, y = (i - x) / W
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (nx < 0 || ny < 0 || nx >= W || ny >= d.h) continue
          const j = ny * W + nx
          if (!seen.has(j)) { seen.add(j); next.push(j) }
        }
      }
      const ok = next.filter(routable)
      if (ok.length) return ok.find(isWater) ?? ok[0]
      ring = next
    }
    return start
  }
  for (const river of spec.rivers) {
    const water = tid(river.terrain), bankT = tid(river.bankTerrain)
    const lo = -Math.floor((river.width - 1) / 2), hi = Math.ceil((river.width - 1) / 2)
    const tiles: number[] = []
    for (let k = 0; k + 1 < river.points.length; k++) {
      const [ax, ay] = river.points[k], [bx, by] = river.points[k + 1]
      const seg = findPath(W, d.h, snap(ay * W + ax), snap(by * W + bx), cost, rc.base * 0.5, rc.heuristic)
      if (!seg) { ctx.problems.push(`river ${river.id}: no path for segment ${k}`); continue }
      tiles.push(...(k === 0 ? seg : seg.slice(1)))
    }
    // A* on the 4-grid gives staircases: brush along a moving average of the path instead.
    const S = rc.smooth
    const px = tiles.map((i) => i % W), py = tiles.map((i) => Math.floor(i / W))
    const centres: number[] = []
    let last = -1
    for (let k = 0; k < tiles.length; k++) {
      const a = Math.max(0, k - S), b = Math.min(tiles.length - 1, k + S)
      const r = Math.min(k - a, b - k)
      let sx = 0, sy = 0
      for (let j = k - r; j <= k + r; j++) { sx += px[j]; sy += py[j] }
      const c = Math.round(sy / (2 * r + 1)) * W + Math.round(sx / (2 * r + 1))
      if (c !== last) { centres.push(c); last = c }
    }
    const carved = new Set<number>()
    for (let k = 0; k < centres.length; k++) {
      const i = centres[k]
      const x = i % W, y = (i - x) / W
      const prev = k > 0 ? centres[k - 1] : i
      const pxv = prev % W, pyv = (prev - pxv) / W
      // Diagonal steps get one extra brush row so the channel stays 4-connected.
      const ext = pxv !== x && pyv !== y ? 1 : 0
      for (let oy = lo - ext; oy <= hi; oy++) for (let ox = lo; ox <= hi; ox++) {
        const nx = x + ox, ny = y + oy
        if (nx < 0 || ny < 0 || nx >= W || ny >= d.h) continue
        const j = ny * W + nx
        if (hasFlag(d, j, F_SEA) || hasFlag(d, j, F_LAKE) || (hasFlag(d, j, F_LOCK) && !ctx.macro.lakeRim[j])) continue
        d.terrain[j] = water
        addFlag(d, j, F_RIVER)
        carved.add(j)
      }
    }
    if (river.bank <= 0) continue
    for (const j of carved) {
      const x = j % W, y = (j - x) / W
      for (let oy = -river.bank; oy <= river.bank; oy++) for (let ox = -river.bank; ox <= river.bank; ox++) {
        const nx = x + ox, ny = y + oy
        if (nx < 0 || ny < 0 || nx >= W || ny >= d.h) continue
        const k = ny * W + nx
        if (carved.has(k) || hasFlag(d, k, F_SEA) || hasFlag(d, k, F_LAKE) || hasFlag(d, k, F_LOCK) || hasFlag(d, k, F_RIVER)) continue
        d.terrain[k] = bankT
      }
    }
  }
}
