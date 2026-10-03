// Grid A* (4-neighbour) with a binary heap. Step costs come from the caller; Infinity blocks a step.
// Search state lives in a shared, generation-stamped workspace so repeated searches on a 1M-tile map cost
// O(visited) instead of allocating full-size arrays per call.

class Heap {
  private keys: Float64Array
  private vals: Int32Array
  size = 0

  constructor(cap: number) {
    this.keys = new Float64Array(cap)
    this.vals = new Int32Array(cap)
  }

  clear(): void { this.size = 0 }

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

interface Workspace { n: number; g: Float64Array; from: Int32Array; seen: Uint32Array; closed: Uint32Array; gen: number; heap: Heap }

let WS: Workspace | null = null

function workspace(n: number): Workspace {
  if (!WS || WS.n < n) {
    WS = { n, g: new Float64Array(n), from: new Int32Array(n), seen: new Uint32Array(n), closed: new Uint32Array(n), gen: 0, heap: new Heap(4096) }
  }
  WS.gen++
  if (WS.gen === 0xffffffff) { WS.seen.fill(0); WS.closed.fill(0); WS.gen = 1 }
  WS.heap.clear()
  return WS
}

export type StepCost = (from: number, to: number) => number

/**
 * Cheapest 4-neighbour path from `start` to the first tile accepted by `isGoal` (inclusive), or null.
 * `heuristic` must be a lower bound times the desired weight (0 turns this into Dijkstra).
 */
export function findPathTo(w: number, h: number, start: number, isGoal: (i: number) => boolean, cost: StepCost, heuristic: (i: number) => number, maxCost = Infinity): number[] | null {
  const ws = workspace(w * h)
  const { g, from, seen, closed, heap } = ws
  const gen = ws.gen
  g[start] = 0
  from[start] = -1
  seen[start] = gen
  heap.push(heuristic(start), start)
  let goal = -1
  while (heap.size > 0) {
    const cur = heap.pop()
    if (closed[cur] === gen) continue
    if (isGoal(cur)) { goal = cur; break }
    if (g[cur] > maxCost) break
    closed[cur] = gen
    const x = cur % w, y = (cur - x) / w
    for (let k = 0; k < 4; k++) {
      let nx = x, ny = y
      if (k === 0) ny--; else if (k === 1) ny++; else if (k === 2) nx--; else nx++
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const nb = ny * w + nx
      if (closed[nb] === gen) continue
      const c = cost(cur, nb)
      if (c === Infinity) continue
      const ng = g[cur] + c
      if (seen[nb] !== gen || ng < g[nb]) {
        seen[nb] = gen
        g[nb] = ng
        from[nb] = cur
        heap.push(ng + heuristic(nb), nb)
      }
    }
  }
  if (goal < 0) return null
  const path: number[] = []
  for (let i = goal; i !== -1; i = from[i]) path.push(i)
  path.reverse()
  return path
}

/** A* between two tiles; `minStep` is a lower bound of any step cost, `weight` inflates the heuristic. */
export function findPath(w: number, h: number, start: number, goal: number, cost: StepCost, minStep: number, weight: number, maxCost = Infinity): number[] | null {
  const gx = goal % w, gy = (goal - gx) / w
  const hScale = minStep * weight
  return findPathTo(w, h, start, (i) => i === goal, cost, (i) => {
    const x = i % w, y = (i - x) / w
    return (Math.abs(x - gx) + Math.abs(y - gy)) * hScale
  }, maxCost)
}
