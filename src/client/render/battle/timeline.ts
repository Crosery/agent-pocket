// Stage-time scheduler (promises resolved by update(dt), so choreography follows the render loop) and easing.
// Pure: runs in node tests.

export type Ease = (k: number) => number

const clamp01 = (k: number) => (k < 0 ? 0 : k > 1 ? 1 : k)

export const ease = {
  linear: (k: number) => clamp01(k),
  inQuad: (k: number) => { k = clamp01(k); return k * k },
  outQuad: (k: number) => { k = clamp01(k); return k * (2 - k) },
  inOutQuad: (k: number) => { k = clamp01(k); return k < 0.5 ? 2 * k * k : -1 + (4 - 2 * k) * k },
  inCubic: (k: number) => { k = clamp01(k); return k * k * k },
  outCubic: (k: number) => { k = clamp01(k) - 1; return k * k * k + 1 },
  inOutCubic: (k: number) => { k = clamp01(k); return k < 0.5 ? 4 * k * k * k : (k - 1) * (2 * k - 2) * (2 * k - 2) + 1 },
  inOutSine: (k: number) => -(Math.cos(Math.PI * clamp01(k)) - 1) / 2,
  outBack: (k: number) => { k = clamp01(k); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2 },
  outBounce: (k: number) => {
    k = clamp01(k)
    const n = 7.5625, d = 2.75
    if (k < 1 / d) return n * k * k
    if (k < 2 / d) return n * (k -= 1.5 / d) * k + 0.75
    if (k < 2.5 / d) return n * (k -= 2.25 / d) * k + 0.9375
    return n * (k -= 2.625 / d) * k + 0.984375
  },
  /** 0 -> 1 -> 0 hump. */
  hump: (k: number) => Math.sin(Math.PI * clamp01(k)),
}

/** Out-and-back curve: reaches 1 at `peak` (0..1) with ease-out, returns to 0 with ease-in-out. */
export function outAndBack(k: number, peak: number): number {
  k = clamp01(k)
  if (k <= peak) return ease.outCubic(k / Math.max(1e-4, peak))
  return 1 - ease.inOutQuad((k - peak) / Math.max(1e-4, 1 - peak))
}

/** Attack envelope: 0 -> 1 over `inK`, hold, 1 -> 0 over the last `outK` of the normalized time. */
export function envelope(k: number, inK: number, outK: number): number {
  k = clamp01(k)
  if (inK > 0 && k < inK) return k / inK
  if (outK > 0 && k > 1 - outK) return Math.max(0, (1 - k) / outK)
  return 1
}

interface Waiter { at: number; resolve: () => void }
interface Task { at: number; fn: () => void; seq: number }

export interface Scheduler {
  readonly now: number
  /** Advances stage time, firing due tasks (in time order) and resolving due waits. */
  advance(dt: number): void
  wait(sec: number): Promise<void>
  /** Runs fn when stage time reaches now + sec (during a later advance, or immediately when sec <= 0). */
  at(sec: number, fn: () => void): void
  /** Resolves every pending wait and drops pending tasks (dispose / skip). */
  flush(): void
  readonly pending: number
}

export function createScheduler(): Scheduler {
  let now = 0
  let seq = 0
  let waiters: Waiter[] = []
  let tasks: Task[] = []
  return {
    get now() { return now },
    get pending() { return waiters.length + tasks.length },
    advance(dt) {
      now += Math.max(0, dt)
      if (tasks.length) {
        const due = tasks.filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq)
        if (due.length) {
          tasks = tasks.filter((t) => t.at > now)
          for (const t of due) t.fn()
        }
      }
      if (waiters.length) {
        const due = waiters.filter((w) => w.at <= now)
        if (due.length) {
          waiters = waiters.filter((w) => w.at > now)
          for (const w of due) w.resolve()
        }
      }
    },
    wait(sec) {
      return new Promise<void>((resolve) => {
        if (!(sec > 0)) { resolve(); return }
        waiters.push({ at: now + sec, resolve })
      })
    },
    at(sec, fn) {
      if (!(sec > 0)) { fn(); return }
      tasks.push({ at: now + sec, fn, seq: seq++ })
    },
    flush() {
      const ws = waiters
      waiters = []
      tasks = []
      for (const w of ws) w.resolve()
    },
  }
}
