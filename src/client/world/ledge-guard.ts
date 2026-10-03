// Ledge trap guard. One-way ledges (TerrainDef.ledge) can drop the player into a closed pocket — a basin ringed by
// props, cliffs or (without surf) water — that has no way back out. The frontier generator cannot rule these out
// across chunk borders, so the controller asks this guard before a drop: a bounded DFS over WorldApi.canStep from
// the landing tile decides whether the player could walk away (reach the ledge top again or get `radius` tiles
// away). Closed pockets refuse the drop, unless the player can fly out and the pocket is big enough to be worth
// exploring. Results are cached per landing tile. Pure: no DOM, no three. Tunables: content/explore.json ledge.guard.
import type { GameMap } from '../../shared/types.ts'
import type { CollisionField } from '../../shared/contracts.ts'
import { canStep, isLedgeDrop } from '../../shared/world/worldapi.ts'

export interface LedgeGuardRules {
  enabled: boolean
  /** Chebyshev distance from the landing tile that counts as "walked away". */
  radius: number
  /** Search budget; an undecided search counts as open (never blocks on uncertainty). */
  maxNodes: number
  /** Closed pockets at least this big stay enterable while the player can fly out. */
  flyMinSize: number
  /** Cached landing tiles (per map + surf ability). */
  cache: number
}

export type PocketResult = { closed: false } | { closed: true; size: number }

const STEPS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

/** Is the landing tile (tx, ty) of a drop from (fx, fy) inside a closed pocket? */
export function ledgePocket(map: GameMap, field: CollisionField, fx: number, fy: number, tx: number, ty: number, surf: boolean, r: Pick<LedgeGuardRules, 'radius' | 'maxNodes'>): PocketResult {
  const seen = new Set<string>([`${tx},${ty}`])
  const stack: [number, number][] = [[tx, ty]]
  while (stack.length) {
    const [x, y] = stack.pop()!
    for (const [dx, dy] of STEPS) {
      const nx = x + dx, ny = y + dy
      const k = `${nx},${ny}`
      if (seen.has(k) || !canStep(map, field, x, y, nx, ny, { surf })) continue
      if ((nx === fx && ny === fy) || Math.max(Math.abs(nx - tx), Math.abs(ny - ty)) > r.radius) return { closed: false }
      seen.add(k)
      if (seen.size > r.maxNodes) return { closed: false }
      stack.push([nx, ny])
    }
  }
  return { closed: true, size: seen.size }
}

export interface LedgeGuard {
  /** May the player step from (fx, fy) to (tx, ty)? Only ledge drops are ever refused. */
  allow(map: GameMap, field: CollisionField, fx: number, fy: number, tx: number, ty: number): boolean
  /** Number of refused drops so far (callers compare before/after a move to show a hint). */
  readonly refusals: number
  reset(): void
}

export function createLedgeGuard(rules: () => LedgeGuardRules, ability: { surf(): boolean; fly(): boolean }): LedgeGuard {
  const cache = new Map<string, PocketResult>()
  let refusals = 0
  return {
    allow(map, field, fx, fy, tx, ty) {
      const R = rules()
      if (!R.enabled || !isLedgeDrop(map, fx, fy, tx, ty)) return true
      const surf = ability.surf()
      const key = `${map.id}|${fx},${fy}>${tx},${ty}|${surf ? 1 : 0}`
      let res = cache.get(key)
      if (!res) {
        res = ledgePocket(map, field, fx, fy, tx, ty, surf, R)
        if (cache.size >= R.cache) cache.delete(cache.keys().next().value!)
        cache.set(key, res)
      }
      const ok = !res.closed || (res.size >= R.flyMinSize && ability.fly())
      if (!ok) refusals++
      return ok
    },
    get refusals() { return refusals },
    reset() { cache.clear() },
  }
}
