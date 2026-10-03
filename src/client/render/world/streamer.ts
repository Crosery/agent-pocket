// Chunk streaming scheduler (pure logic, no three.js): decides which chunks of a large map must exist around the
// focus, builds them stage by stage inside a per-frame time budget (frustum first, then by distance and movement
// direction), and evicts far chunks (hard radius + LRU cap) so memory stays bounded however far the player walks.
// cols / rows = Infinity streams an unbounded grid (infinite overworld; chunk coords may be negative).

export interface ChunkSlot<T> {
  readonly cx: number
  readonly cy: number
  readonly key: number
  /** Chunk centre (world x / z). */
  readonly x: number
  readonly z: number
  /** Next stage to run; === stage count when complete. */
  stage: number
  data: T
  wanted: boolean
  inView: boolean
  /** Time (StreamFrame.now) the chunk was last wanted (LRU). */
  lastWanted: number
}

export interface StreamFrame {
  now: number
  focusX: number
  focusZ: number
  /** Chunks whose centre lies within radius + chunk * 0.75 are wanted (built and visible). */
  radius: number
  /** Chunks beyond this distance are evicted right away; between radius and keepRadius only by the LRU cap. */
  keepRadius: number
  maxChunks: number
  budgetMs: number
  /** Budget used while a wanted chunk inside the view is incomplete (load, teleport). */
  catchUpBudgetMs: number
  disposePerFrame: number
  offscreenPenalty: number
  moveLookAhead: number
  /** Focus velocity (world units / s) for look-ahead priority. */
  velX: number
  velZ: number
  inView(cx: number, cy: number): boolean
}

export interface StreamStats {
  slots: number
  complete: number
  wanted: number
  pending: number
  /** Build time spent this frame (ms) and stage jobs run. */
  buildMs: number
  jobs: number
  disposed: number
  /** Max build time of a single frame since the last resetPeak(). */
  peakMs: number
  /** Chunks created / disposed since the streamer was made. */
  totalBuilt: number
  totalDisposed: number
  /** Running average / max cost of one job per stage (ms). */
  stageMs: number[]
  stageMaxMs: number[]
}

export interface StreamerOptions<T> {
  /** Chunk grid size; Infinity = unbounded (negative chunk coords allowed). */
  cols: number
  rows: number
  chunk: number
  create(cx: number, cy: number): T
  /** Build stages; a stage returns false when it ran out of time and must be called again. */
  stages: ((slot: ChunkSlot<T>, deadline: number) => boolean)[]
  dispose(slot: ChunkSlot<T>): void
  /** Wall clock (ms); performance.now by default. */
  clock?: () => number
}

export interface Streamer<T> {
  readonly slots: ReadonlyMap<number, ChunkSlot<T>>
  readonly stats: StreamStats
  /** Per-frame: refresh the wanted set, build within budget, evict. Returns true when the slot set changed. */
  update(f: StreamFrame): boolean
  /** Builds wanted chunks inside the view (and within `radius` of the focus) without a budget until `deadline`;
   * returns how many such chunks are still incomplete. */
  prefill(f: StreamFrame, radius: number, deadline: number): number
  /** Disposes every slot (quality change / map change). */
  clear(): void
  resetPeak(): void
}

export function createStreamer<T>(o: StreamerOptions<T>): Streamer<T> {
  const slots = new Map<number, ChunkSlot<T>>()
  const clock = o.clock ?? (() => performance.now())
  const nStages = o.stages.length
  const stats: StreamStats = {
    slots: 0, complete: 0, wanted: 0, pending: 0, buildMs: 0, jobs: 0, disposed: 0, peakMs: 0, totalBuilt: 0, totalDisposed: 0,
    stageMs: o.stages.map(() => 0), stageMaxMs: o.stages.map(() => 0),
  }

  const bounded = Number.isFinite(o.cols) && Number.isFinite(o.rows)
  /** Unique for |cx|, |cy| < 32768 chunks. */
  const keyOf = (cx: number, cy: number) => (cy + 0x8000) * 0x10000 + (cx + 0x8000)

  function slotAt(cx: number, cy: number, now: number): ChunkSlot<T> {
    const key = keyOf(cx, cy)
    let s = slots.get(key)
    if (!s) {
      s = { cx, cy, key, x: (cx + 0.5) * o.chunk, z: (cy + 0.5) * o.chunk, stage: 0, data: o.create(cx, cy), wanted: false, inView: false, lastWanted: now }
      slots.set(key, s)
      stats.totalBuilt++
    }
    return s
  }

  function drop(s: ChunkSlot<T>): void {
    o.dispose(s)
    slots.delete(s.key)
    stats.totalDisposed++
  }

  /** Marks wanted chunks (creating slots) and returns them. */
  function refresh(f: StreamFrame): ChunkSlot<T>[] {
    for (const s of slots.values()) { s.wanted = false; s.inView = false }
    const reach = f.radius + o.chunk * 0.75
    let c0 = Math.floor((f.focusX - reach) / o.chunk), c1 = Math.floor((f.focusX + reach) / o.chunk)
    let r0 = Math.floor((f.focusZ - reach) / o.chunk), r1 = Math.floor((f.focusZ + reach) / o.chunk)
    if (bounded) { c0 = Math.max(0, c0); c1 = Math.min(o.cols - 1, c1); r0 = Math.max(0, r0); r1 = Math.min(o.rows - 1, r1) }
    const out: ChunkSlot<T>[] = []
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
      const x = (cx + 0.5) * o.chunk, z = (cy + 0.5) * o.chunk
      if (Math.hypot(x - f.focusX, z - f.focusZ) >= reach) continue
      const s = slotAt(cx, cy, f.now)
      s.wanted = true
      s.inView = f.inView(cx, cy)
      s.lastWanted = f.now
      out.push(s)
    }
    return out
  }

  function priority(f: StreamFrame, s: ChunkSlot<T>): number {
    const dx = s.x - f.focusX, dz = s.z - f.focusZ
    const d = Math.hypot(dx, dz)
    const ahead = d > 1e-3 ? (dx * f.velX + dz * f.velZ) / d : 0
    return d + (s.inView ? 0 : f.offscreenPenalty) - ahead * f.moveLookAhead
  }

  /** Runs stages of the given slots (priority order) until the deadline. A job is not started when its running
   * average cost would overshoot the deadline (except the first job of a call, so progress is guaranteed). */
  function build(list: ChunkSlot<T>[], deadline: number): void {
    let ran = 0
    for (const s of list) {
      while (s.stage < nStages) {
        const t = clock()
        if (t > deadline || (ran > 0 && t + stats.stageMs[s.stage] > deadline)) return
        stats.jobs++
        ran++
        const k = s.stage
        const done = o.stages[k](s, deadline)
        const ms = clock() - t
        stats.stageMs[k] = stats.stageMs[k] === 0 ? ms : stats.stageMs[k] * 0.9 + ms * 0.1
        if (ms > stats.stageMaxMs[k]) stats.stageMaxMs[k] = ms
        if (!done) return
        s.stage++
      }
    }
  }

  const streamer: Streamer<T> = {
    slots,
    stats,
    update(f) {
      const before = slots.size
      const t0 = clock()
      stats.jobs = 0
      const wanted = refresh(f)
      const pending = wanted.filter((s) => s.stage < nStages)
      const catchUp = pending.some((s) => s.inView)
      pending.sort((a, b) => priority(f, a) - priority(f, b))
      build(pending, t0 + (catchUp ? f.catchUpBudgetMs : f.budgetMs))
      stats.buildMs = clock() - t0
      stats.peakMs = Math.max(stats.peakMs, stats.buildMs)
      // eviction: far chunks first, then least-recently-wanted beyond the cap
      let disposed = 0
      const idle = [...slots.values()].filter((s) => !s.wanted)
      for (const s of idle) {
        if (disposed >= f.disposePerFrame) break
        if (Math.hypot(s.x - f.focusX, s.z - f.focusZ) > f.keepRadius + o.chunk * 0.75) { drop(s); disposed++ }
      }
      if (slots.size > f.maxChunks) {
        const lru = [...slots.values()].filter((s) => !s.wanted).sort((a, b) => a.lastWanted - b.lastWanted)
        for (const s of lru) {
          if (slots.size <= f.maxChunks || disposed >= f.disposePerFrame) break
          drop(s)
          disposed++
        }
      }
      stats.disposed = disposed
      stats.slots = slots.size
      stats.wanted = wanted.length
      stats.pending = wanted.filter((s) => s.stage < nStages).length
      stats.complete = [...slots.values()].filter((s) => s.stage >= nStages).length
      return slots.size !== before || disposed > 0
    },
    prefill(f, radius, deadline) {
      const wanted = refresh(f).filter((s) => s.inView || Math.hypot(s.x - f.focusX, s.z - f.focusZ) < radius)
      const pending = wanted.filter((s) => s.stage < nStages).sort((a, b) => priority(f, a) - priority(f, b))
      build(pending, deadline)
      return pending.filter((s) => s.stage < nStages).length
    },
    clear() {
      for (const s of [...slots.values()]) drop(s)
      stats.slots = 0
      stats.complete = 0
    },
    resetPeak() { stats.peakMs = 0; stats.stageMaxMs.fill(0) },
  }
  return streamer
}
