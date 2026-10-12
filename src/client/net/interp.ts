// Snapshot interpolation for remote players: buffer timestamped positions and render slightly in the past.

export interface Sample { t: number; x: number; y: number; vx?: number; vy?: number }

export interface InterpOptions {
  /** Drop samples older than this (ms) relative to the newest one (keeps at least two). */
  keepMs: number
  /** A jump longer than this (tiles) snaps instead of sliding across the map. */
  snapDistance: number
  /** Expected interval between server updates (ms); bridges the gap after a pause. */
  tickMs: number
  /** Optional bounded dead-reckoning window (ms) past the newest sample when velocity is known. */
  maxExtrapolateMs?: number
}

/** Adaptive jitter buffer delay: clamp(p95Jitter + tickMs, minMs, maxMs) (ADR 0001 §4.3). */
export function adaptiveInterpDelay(jitterP95Ms: number, tickMs: number, minMs: number, maxMs: number): number {
  const raw = (Number.isFinite(jitterP95Ms) && jitterP95Ms >= 0 ? jitterP95Ms : 0) + tickMs
  return Math.max(minMs, Math.min(maxMs, Math.round(raw)))
}

export function pushSample(buf: Sample[], s: Sample, o: InterpOptions): void {
  const last = buf[buf.length - 1]
  if (last) {
    if (Math.hypot(s.x - last.x, s.y - last.y) > o.snapDistance) buf.length = 0
    else if (s.t - last.t > 2 * o.tickMs) {
      // The player was idle: start the slide one tick before this update, not from the stale sample.
      buf.push({ t: s.t - o.tickMs, x: last.x, y: last.y })
    }
  }
  const tail = buf[buf.length - 1]
  if (tail && s.t <= tail.t) { tail.x = s.x; tail.y = s.y; tail.vx = s.vx; tail.vy = s.vy }
  else buf.push(s)
  const cutoff = s.t - o.keepMs
  let drop = 0
  while (drop < buf.length - 2 && buf[drop + 1].t <= cutoff) drop++
  if (drop > 0) buf.splice(0, drop)
}

/** Position at time `t` (clamped to the buffered range, or extrapolated up to `maxExtrapolateMs` when moving). */
export function sampleAt(buf: readonly Sample[], t: number, maxExtrapolateMs = 0): { x: number; y: number } | null {
  const n = buf.length
  if (n === 0) return null
  if (t <= buf[0].t) return buf[0]
  const last = buf[n - 1]
  if (t >= last.t) {
    const vx = last.vx ?? 0, vy = last.vy ?? 0
    if (maxExtrapolateMs > 0 && (vx !== 0 || vy !== 0)) {
      const dtSec = Math.min(maxExtrapolateMs, t - last.t) / 1000
      return { x: last.x + vx * dtSec, y: last.y + vy * dtSec }
    }
    return last
  }
  for (let i = n - 2; i >= 0; i--) {
    const a = buf[i]
    if (a.t <= t) {
      const b = buf[i + 1]
      const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
    }
  }
  return buf[0]
}
