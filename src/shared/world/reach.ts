// Reachability flood fills over GameMaps using the real movement rules (canStep).
import type { GameMap } from '../types.ts'
import { COLLISION_FREE, COLLISION_WATER, canStep } from './collision.ts'

let QUEUE = new Int32Array(0)

/**
 * 4-neighbour flood fill from (sx, sy); diagonals never add reachability under the corner rule.
 * Pass `seen` to extend an existing reach set in place.
 */
export function floodReach(map: GameMap, col: Uint8Array, sx: number, sy: number, surf: boolean, blocked?: Set<number>, seen?: Uint8Array): Uint8Array {
  const W = map.width, N = W * map.height
  const out = seen ?? new Uint8Array(N)
  // Shared queue: repairAccess extends a reach set hundreds of times, a fresh N-sized buffer each time dominated.
  if (QUEUE.length < N) QUEUE = new Int32Array(N)
  const queue = QUEUE
  let head = 0, tail = 0
  out[sy * W + sx] = 1
  queue[tail++] = sy * W + sx
  const opts = { surf }
  const elev = map.elevation
  // Same-level orthogonal steps only need the collision value; level changes go through canStep (stairs rule).
  while (head < tail) {
    const i = queue[head++]
    const x = i % W, y = (i - x) / W
    for (let k = 0; k < 4; k++) {
      const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x
      const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y
      if (nx < 0 || ny < 0 || nx >= W || ny >= map.height) continue
      const j = ny * W + nx
      if (out[j]) continue
      const v = col[j]
      if (v !== COLLISION_FREE && !(v === COLLISION_WATER && surf)) continue
      if (elev[i] !== elev[j] && !canStep(map, col, x, y, nx, ny, opts)) continue
      if (blocked && blocked.has(j)) continue
      out[j] = 1
      queue[tail++] = j
    }
  }
  return out
}

/** Connected walkable components (4-neighbour, canStep) of tiles not in `reach`. Largest first. */
export function pockets(map: GameMap, col: Uint8Array, reach: Uint8Array, accept: (i: number) => boolean): number[][] {
  const N = map.width * map.height
  const label = new Uint8Array(N)
  const out: number[][] = []
  for (let s = 0; s < N; s++) {
    if (reach[s] || label[s] || col[s] !== 0 || !accept(s)) continue
    const comp: number[] = [s]
    label[s] = 1
    for (let h = 0; h < comp.length; h++) {
      const i = comp[h]
      const x = i % map.width, y = (i - x) / map.width
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x
        const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue
        const j = ny * map.width + nx
        if (label[j] || reach[j] || !accept(j) || !canStep(map, col, x, y, nx, ny, { surf: false })) continue
        label[j] = 1
        comp.push(j)
      }
    }
    out.push(comp)
  }
  return out.sort((a, b) => b.length - a.length || a[0] - b[0])
}
