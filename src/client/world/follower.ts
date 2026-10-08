// Follower creature: the first conscious party member walks the player's breadcrumb trail; while surfing it
// becomes the mount under the player. Hidden where content/game.json says it does not fit (indoor size cap).
import type { Creature, Dir, GameMap } from '../../shared/types.ts'
import type { CreatureActor, GameContext } from '../contracts.ts'
import { GAME } from './config.ts'
import { DIR_VEC } from './motion.ts'
import { createTrail } from './trail.ts'

export interface FollowerDeps {
  /** May the follower stand at (x, y) beside the player? (sidestep target check: walls, water, other levels) */
  canStand?(x: number, y: number): boolean
}

/** Moves `v` toward `to` by at most `step`. */
function approach(v: number, to: number, step: number): number {
  return v < to ? Math.min(to, v + step) : Math.max(to, v - step)
}

export function createFollower(ctx: GameContext, deps: FollowerDeps = {}) {
  const F = GAME.follower
  const trail = createTrail(F.trailSpacing, F.maxTrail)
  let actor: CreatureActor | null = null
  let key = ''
  let speciesId: string | null = null
  let x = 0, y = 0
  let shown = false
  // trail distance / personal-space radius / sideways camera clearance for the current lead (bigger creatures walk
  // further back and further aside)
  let spacing = F.distance, minGap = F.minGap, clear = 0, dropBack = 0
  let lastPx = Number.NaN, lastPy = 0, side = 1, camSide = 1, camK = 0, backK = 0

  /** Whether the lead may be shown on this map. */
  function allowedOn(map: GameMap | null, lead: Creature | null): boolean {
    if (!map || !lead || !F.mapKinds.includes(map.kind)) return false
    const size = ctx.data.species[lead.speciesId]?.size ?? 1
    return !F.sizeCapMapKinds.includes(map.kind) || size <= F.indoorMaxSize
  }

  function sync(lead: Creature | null, map: GameMap | null): void {
    const k = lead && allowedOn(map, lead) ? `${lead.speciesId}|${lead.shiny ? 1 : 0}` : ''
    if (k === key) return
    actor?.dispose()
    actor = null
    key = k
    speciesId = lead && k ? lead.speciesId : null
    const size = speciesId ? ctx.data.species[speciesId]?.size ?? 1 : 1
    const extra = F.distancePerSize * Math.max(0, size - 1)
    spacing = F.distance + extra
    minGap = F.minGap + extra
    clear = F.cameraClear.base + F.cameraClear.perSize * size
    dropBack = F.cameraClear.dropBack.base + F.cameraClear.dropBack.perSize * size
    if (lead && k) {
      actor = ctx.world.createCreatureActor(lead.speciesId, lead.shiny)
      actor.setPosition(x, y, ctx.world.elevationAt(x, y))
    }
  }

  function reset(px: number, py: number, elev: number, facing: Dir): void {
    const v = DIR_VEC[facing]
    x = px - v.x * spacing
    y = py - v.y * spacing
    lastPx = Number.NaN
    camK = 0
    backK = 0
    trail.reset({ x: px, y: py, elev }, { x, y, elev })
    actor?.setPosition(x, y, ctx.world.elevationAt(x, y))
  }

  /**
   * Personal space: the follower never comes within minGap of the player. When the player walks into it (a
   * reversal makes the trail double back through the player) it walks round the player's side, at most
   * sidestepSpeed along the circle and never past abreast, so the two pass beside each other rather than through
   * each other and it never jumps there in one frame.
   */
  function keepClear(nx: number, ny: number, px: number, py: number, mvx: number, mvy: number, dt: number): { x: number; y: number } {
    let dx = nx - px, dy = ny - py
    let d = Math.hypot(dx, dy)
    if (d >= minGap) return { x: nx, y: ny }
    const mv = Math.hypot(mvx, mvy)
    if (d < 1e-4) {
      dx = x - px; dy = y - py; d = Math.hypot(dx, dy)
      if (d < 1e-4) { dx = mv > 1e-6 ? -mvx : 0; dy = mv > 1e-6 ? -mvy : 1; d = Math.hypot(dx, dy) }
    }
    const ux = dx / d, uy = dy / d
    // back out to minGap no faster than it could walk (after being let through it eases out instead of popping)
    const r = Math.min(minGap, Math.max(d, Math.hypot(x - px, y - py)) + F.sidestepSpeed * dt + mv)
    const place = (s: number) => {
      let qx = ux, qy = uy
      if (s !== 0 && mv > 1e-6) {
        // angle off the player's heading towards side s: 0 = straight ahead, pi/2 = abreast
        const mx = mvx / mv, my = mvy / mv, ox = -my * s, oy = mx * s
        const along = qx * mx + qy * my
        if (along > 0) {
          const a = Math.min(Math.PI / 2, Math.atan2(qx * ox + qy * oy, along) + (F.sidestepSpeed * dt) / minGap)
          qx = Math.cos(a) * mx + Math.sin(a) * ox
          qy = Math.cos(a) * my + Math.sin(a) * oy
        }
      }
      return { x: px + qx * r, y: py + qy * r }
    }
    if (mv > 1e-6) {
      // keep the side it is already on; head-on, pass on the far side from the camera (north) so the player stays in front
      const cross = (mvx * dy - mvy * dx) / (mv * d)
      if (Math.abs(cross) > F.sideBias) side = Math.sign(cross)
      else if (Math.abs(mvx) > 1e-6) side = mvx > 0 ? -1 : 1
    }
    // round its side, round the other side, or straight out where it stands (s = 0)
    for (const s of [side, -side, 0]) {
      const p = place(s)
      if (!deps.canStand || deps.canStand(p.x, p.y)) { if (s) side = s; return p }
    }
    // boxed in (1-tile corridor): let it pass; the player still draws on top (render.json actors.renderOrder)
    return { x: nx, y: ny }
  }

  /**
   * Camera clearance: a follower trailing on the camera side of the player (south; the view looks north) would
   * cover its legs, a big lead all of it. Its trail target is swung round the player at the same distance until the
   * two stand at least `clear` apart sideways (it walks beside-behind instead of in front of the player). The swing
   * eases in and out (camK) and only changes sides through the trail, so the target never jumps. Where walls leave
   * no room to swing (bridges, 1-tile lanes) it drops further back along the trail instead (backK, see update).
   */
  function clearOfCamera(tx: number, ty: number, px: number, py: number, dt: number): { x: number; y: number } {
    const C = F.cameraClear
    const rx = tx - px, ry = ty - py
    const d = Math.hypot(rx, ry)
    const swung = (s: number, k: number) => {
      const need = Math.asin(Math.min(1, clear / d)), now = Math.atan2(rx * s, ry)
      if (now >= need) return { x: tx, y: ty }
      const a = now + (need - now) * k
      return { x: px + Math.sin(a) * d * s, y: py + Math.cos(a) * d }
    }
    // largest swing share on side s whose spot the follower may stand on (walls, water, other levels)
    const reach = (s: number) => {
      for (let i = 0; i < C.tries; i++) {
        const k = 1 - i / C.tries, p = swung(s, k)
        if (!deps.canStand || deps.canStand(p.x, p.y)) return k
      }
      return 0
    }
    let want = 0
    if (ry > 0 && d > 1e-4 && Math.abs(rx) < clear) {
      const side = Math.abs(rx) > C.sideDeadzone ? Math.sign(rx) : camSide
      if (side !== camSide && camK > 0) want = 0
      else {
        const here = reach(side), there = camK === 0 && here < 1 ? reach(-side) : 0
        if (there > here) { camSide = -side; want = there } else { camSide = side; want = here }
      }
    }
    camK = approach(camK, want, dt * C.blendPerSec)
    backK = approach(backK, ry > 0 && d > 1e-4 && Math.abs(rx) < clear ? 1 - want : 0, dt * C.blendPerSec)
    return camK > 0 && d > 1e-4 ? swung(camSide, camK) : { x: tx, y: ty }
  }

  /** mount = surfing: the creature carries the player instead of following. */
  function update(dt: number, px: number, py: number, elev: number, facing: Dir, mount: boolean): void {
    if (!actor) return
    trail.push({ x: px, y: py, elev })
    const mvx = Number.isNaN(lastPx) ? 0 : px - lastPx, mvy = Number.isNaN(lastPx) ? 0 : py - lastPy
    lastPx = px
    lastPy = py
    let tx: number, ty: number
    if (mount) { tx = px; ty = py }
    else {
      const s = trail.sample(spacing + backK * dropBack)
      ;({ x: tx, y: ty } = clearOfCamera(s?.x ?? px, s?.y ?? py, px, py, dt))
    }
    if (Math.hypot(tx - x, ty - y) > F.teleportDistance) { x = tx; y = ty }
    const k = mount ? 1 : 1 - Math.exp(-dt * F.followRate)
    let nx = x + (tx - x) * k, ny = y + (ty - y) * k
    if (!mount && dt > 0) {
      // never dashes: at most maxSpeed, or catchUpMul x the player's own speed when that is faster (bike)
      const step = Math.hypot(nx - x, ny - y), cap = Math.max(F.maxSpeed * dt, Math.hypot(mvx, mvy) * F.catchUpMul)
      if (step > cap) { nx = x + ((nx - x) * cap) / step; ny = y + ((ny - y) * cap) / step }
    }
    if (!mount) ({ x: nx, y: ny } = keepClear(nx, ny, px, py, mvx, mvy, dt))
    const moved = Math.hypot(nx - x, ny - y)
    if (Math.abs(nx - x) > F.flipMinSpeed * dt) actor.setFacingLeft(nx < x)
    else if (mount && (facing === 'left' || facing === 'right')) actor.setFacingLeft(facing === 'left')
    actor.setMoving(dt > 0 && moved / dt > F.moveMinSpeed)
    x = nx
    y = ny
    actor.setPosition(x, y, mount ? elev - GAME.player.surf.rideLift : ctx.world.elevationAt(x, y))
    actor.setVisible(shown)
    actor.update(dt)
  }

  return {
    sync,
    reset,
    update,
    setShown(v: boolean): void { shown = v; actor?.setVisible(v) },
    get speciesId(): string | null { return speciesId },
    get active(): boolean { return !!actor && shown },
    get x(): number { return x },
    get y(): number { return y },
    bubble(text: string, ms?: number): void { actor?.bubble(text, ms) },
    dispose(): void { actor?.dispose(); actor = null; key = ''; speciesId = null },
  }
}

export type Follower = ReturnType<typeof createFollower>
