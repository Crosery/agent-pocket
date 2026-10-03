// Follower creature: the first conscious party member walks the player's breadcrumb trail; while surfing it
// becomes the mount under the player. Hidden where content/game.json says it does not fit (indoor size cap).
import type { Creature, Dir, GameMap } from '../../shared/types.ts'
import type { CreatureActor, GameContext } from '../contracts.ts'
import { GAME } from './config.ts'
import { DIR_VEC } from './motion.ts'
import { createTrail } from './trail.ts'

export function createFollower(ctx: GameContext) {
  const F = GAME.follower
  const trail = createTrail(F.trailSpacing, F.maxTrail)
  let actor: CreatureActor | null = null
  let key = ''
  let speciesId: string | null = null
  let x = 0, y = 0
  let shown = false

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
    if (lead && k) {
      actor = ctx.world.createCreatureActor(lead.speciesId, lead.shiny)
      actor.setPosition(x, y, ctx.world.elevationAt(x, y))
    }
  }

  function reset(px: number, py: number, elev: number, facing: Dir): void {
    const v = DIR_VEC[facing]
    x = px - v.x * F.distance
    y = py - v.y * F.distance
    trail.reset({ x: px, y: py, elev }, { x, y, elev })
    actor?.setPosition(x, y, ctx.world.elevationAt(x, y))
  }

  /** mount = surfing: the creature carries the player instead of following. */
  function update(dt: number, px: number, py: number, elev: number, facing: Dir, mount: boolean): void {
    if (!actor) return
    trail.push({ x: px, y: py, elev })
    let tx: number, ty: number
    if (mount) { tx = px; ty = py }
    else {
      const s = trail.sample(F.distance)
      tx = s?.x ?? px
      ty = s?.y ?? py
    }
    if (Math.hypot(tx - x, ty - y) > F.teleportDistance) { x = tx; y = ty }
    const k = mount ? 1 : 1 - Math.exp(-dt * F.followRate)
    const nx = x + (tx - x) * k, ny = y + (ty - y) * k
    const moved = Math.hypot(nx - x, ny - y)
    if (Math.abs(nx - x) > 1e-3) actor.setFacingLeft(nx < x)
    else if (mount && (facing === 'left' || facing === 'right')) actor.setFacingLeft(facing === 'left')
    actor.setMoving(moved > F.moveEpsilon * dt * 60)
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
