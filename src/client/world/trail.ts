// Breadcrumb trail of the player's recent positions; a follower walks the trail at a fixed arc distance.
// Pure (no DOM/three) so it is unit-testable.

export interface TrailPoint { x: number; y: number; elev: number }

export interface Trail {
  /** Records the leader position (only when it moved at least `spacing` since the last point). */
  push(p: TrailPoint): void
  /** Point at arc distance `d` behind the newest point (oldest point when the trail is shorter). */
  sample(d: number): TrailPoint | null
  /** Clears the trail and seeds it with a straight segment from `behind` to `head`. */
  reset(head: TrailPoint, behind?: TrailPoint): void
  readonly length: number
}

export function createTrail(spacing: number, maxPoints: number): Trail {
  const pts: TrailPoint[] = []
  return {
    get length() { return pts.length },
    push(p) {
      const last = pts[pts.length - 1]
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < spacing) {
        last.elev = p.elev
        return
      }
      pts.push({ ...p })
      if (pts.length > maxPoints) pts.splice(0, pts.length - maxPoints)
    },
    sample(d) {
      if (!pts.length) return null
      let remaining = d
      for (let i = pts.length - 1; i > 0; i--) {
        const a = pts[i], b = pts[i - 1]
        const seg = Math.hypot(a.x - b.x, a.y - b.y)
        if (seg >= remaining && seg > 0) {
          const k = remaining / seg
          return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, elev: a.elev + (b.elev - a.elev) * k }
        }
        remaining -= seg
      }
      return { ...pts[0] }
    },
    reset(head, behind) {
      pts.length = 0
      if (behind) pts.push({ ...behind })
      pts.push({ ...head })
    },
  }
}
