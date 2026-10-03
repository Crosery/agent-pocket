// NPC actors on the current map: flag-driven visibility (hiddenIfFlag / hiddenUnlessFlag + script overrides),
// tile-stepped walking (scripted paths, wandering, trainer approach), facing, occupancy and trainer sight lines.
import type { Dir, GameMap, NpcDef } from '../../shared/types.ts'
import type { Actor, GameContext } from '../contracts.ts'
import type { CollisionField, IRng } from '../../shared/contracts.ts'
import { canStep, warpAt } from '../../shared/world/worldapi.ts'
import { STORY_CONTENT } from '../../shared/world/story.ts'
import { GAME } from './config.ts'
import { DIR_VEC } from './motion.ts'
import { flagSet } from './save-ops.ts'

export interface NpcRuntime {
  readonly def: NpcDef
  actor: Actor | null
  /** Continuous centre position (tile centre = i + 0.5). */
  x: number
  y: number
  /** Logical tile (reserved while walking toward it). */
  tx: number
  ty: number
  facing: Dir
  visible: boolean
  /** Script override of flag visibility for this map visit (null = flags decide). */
  override: boolean | null
  /** In a script / approaching: no wandering. */
  busy: boolean
  /** Trainer already triggered during this visit (prevents re-triggering while the battle starts). */
  triggered: boolean
  wanderT: number
  steps: Dir[]
  stepSpeed: number
  moving: { fx: number; fy: number; t: number; dur: number } | null
  stepWaiters: (() => void)[]
  blockedFor: number
}

export interface NpcLayerDeps {
  readonly ctx: GameContext
  /** Tile the player stands on (NPCs never step onto it). */
  playerTile(): { x: number; y: number }
  /** WorldApi.collisionField of the current map (finite and infinite maps). */
  field(): CollisionField | null
  rng: IRng
}

export function createNpcLayer(deps: NpcLayerDeps) {
  const { ctx } = deps
  let map: GameMap | null = null
  let list: NpcRuntime[] = []
  const byId = new Map<string, NpcRuntime>()
  /** Script visibility overrides for NPCs not streamed in yet (applied when they appear; cleared per map visit). */
  const pendingOverride = new Map<string, boolean>()
  /** Runtime NPCs added by the event layer (add/remove): kept across streaming sync() until removed. */
  const pinned = new Set<string>()

  const flagVisible = (d: NpcDef) =>
    !(d.hiddenIfFlag && flagSet(ctx.save, d.hiddenIfFlag)) && !(d.hiddenUnlessFlag && !flagSet(ctx.save, d.hiddenUnlessFlag))

  const ensureActor = (n: NpcRuntime): Actor => {
    if (n.actor) return n.actor
    const a = ctx.world.createActor({ sheet: n.def.sprite, name: GAME.npc.showNames ? n.def.nameZh : undefined, kind: 'npc' })
    a.setFacing(n.facing)
    a.setPosition(n.x, n.y, ctx.world.elevationAt(n.x, n.y))
    n.actor = a
    return a
  }

  const applyVisibility = (n: NpcRuntime) => {
    const v = n.override ?? flagVisible(n.def)
    n.visible = v
    if (v) ensureActor(n).setVisible(true)
    else n.actor?.setVisible(false)
  }

  const occupiedByNpc = (tx: number, ty: number, except?: NpcRuntime): boolean =>
    list.some((n) => n !== except && n.visible && ((n.tx === tx && n.ty === ty) || (n.moving && Math.floor(n.x) === tx && Math.floor(n.y) === ty)))

  /** Can `n` step from its tile one tile in `dir`? */
  const canNpcStep = (n: NpcRuntime, dir: Dir, ignorePlayer = false): boolean => {
    const field = deps.field()
    if (!map || !field) return false
    const v = DIR_VEC[dir]
    const nx = n.tx + v.x, ny = n.ty + v.y
    if (!canStep(map, field, n.tx, n.ty, nx, ny, { surf: false })) return false
    if (warpAt(map, nx, ny)) return false
    const p = deps.playerTile()
    if (!ignorePlayer && p.x === nx && p.y === ny) return false
    return !occupiedByNpc(nx, ny, n)
  }

  const startStep = (n: NpcRuntime, dir: Dir, speed: number): boolean => {
    n.facing = dir
    n.actor?.setFacing(dir)
    if (!canNpcStep(n, dir)) return false
    const v = DIR_VEC[dir]
    n.moving = { fx: n.x, fy: n.y, t: 0, dur: 1 / Math.max(0.1, speed) }
    n.tx += v.x
    n.ty += v.y
    return true
  }

  const finishSteps = (n: NpcRuntime) => {
    const waiters = n.stepWaiters
    n.stepWaiters = []
    for (const w of waiters) w()
  }

  const runtimeOf = (def: NpcDef): NpcRuntime => ({
    def, actor: null, x: def.x + 0.5, y: def.y + 0.5, tx: def.x, ty: def.y, facing: def.facing,
    visible: false, override: pendingOverride.get(def.id) ?? null, busy: false, triggered: false,
    wanderT: GAME.npc.wander.pauseMinSec + deps.rng.next() * (GAME.npc.wander.pauseMaxSec - GAME.npc.wander.pauseMinSec),
    steps: [], stepSpeed: GAME.npc.walkSpeed, moving: null, stepWaiters: [], blockedFor: 0,
  })

  /** Loads a map's NPCs (`defs` = the live subset when the map streams its objects). */
  function load(m: GameMap, defs: readonly NpcDef[] = m.npcs): void {
    clear()
    map = m
    list = defs.map(runtimeOf)
    for (const n of list) { byId.set(n.def.id, n); applyVisibility(n) }
  }

  /** Streaming: keeps NPCs listed in `defs` (and any busy / walking one), adds new ones, disposes the rest. */
  function sync(defs: readonly NpcDef[]): void {
    if (!map) return
    const want = new Set(defs.map((d) => d.id))
    const kept: NpcRuntime[] = []
    for (const n of list) {
      if (want.has(n.def.id) || pinned.has(n.def.id) || n.busy || n.moving || n.steps.length || n.stepWaiters.length) kept.push(n)
      else { n.actor?.dispose(); byId.delete(n.def.id) }
    }
    list = kept
    for (const def of defs) {
      if (byId.has(def.id)) continue
      const n = runtimeOf(def)
      list.push(n)
      byId.set(def.id, n)
      applyVisibility(n)
    }
  }

  function clear(): void {
    for (const n of list) { n.actor?.dispose(); finishSteps(n) }
    list = []
    byId.clear()
    pendingOverride.clear()
    pinned.clear()
    map = null
  }

  /** Adds runtime NPCs (world events) to the current map; they survive object streaming until remove(). */
  function add(defs: readonly NpcDef[]): void {
    if (!map) return
    for (const def of defs) {
      pinned.add(def.id)
      if (byId.has(def.id)) continue
      const n = runtimeOf(def)
      list.push(n)
      byId.set(def.id, n)
      applyVisibility(n)
    }
  }

  function remove(ids: readonly string[]): void {
    const drop = new Set(ids)
    for (const id of ids) pinned.delete(id)
    list = list.filter((n) => {
      if (!drop.has(n.def.id)) return true
      n.actor?.dispose()
      finishSteps(n)
      byId.delete(n.def.id)
      return false
    })
  }

  function update(dt: number, opts: { allowWander: boolean; focus: { x: number; y: number } }): void {
    const W = GAME.npc.wander
    for (const n of list) {
      if (!n.visible) {
        if (n.steps.length || n.stepWaiters.length) { n.steps = []; n.moving = null; finishSteps(n) }
        continue
      }
      if (n.moving) {
        const mv = n.moving
        mv.t = Math.min(mv.dur, mv.t + dt)
        const k = mv.t / mv.dur
        n.x = mv.fx + (n.tx + 0.5 - mv.fx) * k
        n.y = mv.fy + (n.ty + 0.5 - mv.fy) * k
        if (mv.t >= mv.dur) { n.moving = null; n.x = n.tx + 0.5; n.y = n.ty + 0.5 }
      }
      if (!n.moving && n.steps.length) {
        if (startStep(n, n.steps[0], n.stepSpeed)) { n.steps.shift(); n.blockedFor = 0 }
        else {
          n.blockedFor += dt
          if (n.blockedFor > GAME.npc.blockedRetrySec) { n.steps.shift(); n.blockedFor = 0 }
        }
        if (!n.steps.length && !n.moving) finishSteps(n)
      } else if (!n.moving && n.stepWaiters.length && !n.steps.length) finishSteps(n)
      if (!n.moving && !n.steps.length && opts.allowWander && !n.busy && (n.def.wander ?? 0) > 0) {
        n.wanderT -= dt
        if (n.wanderT <= 0) {
          n.wanderT = W.pauseMinSec + deps.rng.next() * (W.pauseMaxSec - W.pauseMinSec)
          const dirs: Dir[] = ['up', 'down', 'left', 'right']
          const dir = deps.rng.pick(dirs)
          if (deps.rng.chance(W.stepChance)) {
            const v = DIR_VEC[dir]
            const r = n.def.wander ?? 0
            const count = deps.rng.int(1, Math.max(1, W.maxStepsPerMove))
            const within = Math.abs(n.tx + v.x * count - n.def.x) <= r && Math.abs(n.ty + v.y * count - n.def.y) <= r
            if (within) { n.steps = Array.from({ length: count }, () => dir); n.stepSpeed = GAME.npc.walkSpeed }
            else { n.facing = dir; n.actor?.setFacing(dir) }
          } else { n.facing = dir; n.actor?.setFacing(dir) }
        }
      }
      const a = n.actor
      if (!a) continue
      const near = Math.hypot(n.x - opts.focus.x, n.y - opts.focus.y) < GAME.npc.cullDistance
      a.setVisible(near)
      if (!near) continue
      a.setMoving(!!n.moving, false)
      a.setPosition(n.x, n.y, ctx.world.elevationAt(n.x, n.y))
      a.update(dt)
    }
  }

  /** Walks a scripted path; resolves when finished (blocked steps are skipped after a timeout). */
  function walk(n: NpcRuntime, path: Dir[], speed: number): Promise<void> {
    if (!n.visible || !path.length) return Promise.resolve()
    n.steps.push(...path)
    n.stepSpeed = speed
    return new Promise<void>((r) => n.stepWaiters.push(r))
  }

  /** Visible, undefeated line-of-sight trainer that can see the player tile, or null. */
  function sightCheck(player: { x: number; y: number }): NpcRuntime | null {
    const field = deps.field()
    if (!map || !field) return null
    const wonPrefix = STORY_CONTENT.meta.flags.trainerWon
    for (const n of list) {
      const range = n.def.sightRange ?? 0
      if (!n.visible || n.busy || n.triggered || n.moving || !n.def.trainer || range <= 0) continue
      if (flagSet(ctx.save, wonPrefix + n.def.trainer)) continue
      const v = DIR_VEC[n.facing]
      let px = n.tx, py = n.ty
      for (let k = 1; k <= range; k++) {
        const qx = px + v.x, qy = py + v.y
        if (!canStep(map, field, px, py, qx, qy, { surf: false })) break
        if (qx === player.x && qy === player.y) return n
        if (occupiedByNpc(qx, qy, n)) break
        px = qx; py = qy
      }
    }
    return null
  }

  return {
    load,
    sync,
    clear,
    add,
    remove,
    update,
    sightCheck,
    get list(): readonly NpcRuntime[] { return list },
    get(id: string): NpcRuntime | undefined { return byId.get(id) },
    occupies(tx: number, ty: number): boolean { return occupiedByNpc(tx, ty) },
    /** Visible NPC standing on (or walking into) a tile. */
    at(tx: number, ty: number): NpcRuntime | undefined {
      return list.find((n) => n.visible && n.tx === tx && n.ty === ty)
    },
    refreshVisibility(): void { for (const n of list) applyVisibility(n) },
    setHidden(id: string, hidden: boolean): void {
      pendingOverride.set(id, !hidden)
      const n = byId.get(id)
      if (!n) return
      n.override = !hidden
      applyVisibility(n)
    },
    face(n: NpcRuntime, dir: Dir): void { n.facing = dir; n.actor?.setFacing(dir) },
    walk,
    /** Walks straight toward a tile until adjacent to it (trainer approach along its line of sight). */
    approach(n: NpcRuntime, target: { x: number; y: number }, speed: number): Promise<void> {
      const dist = Math.abs(target.x - n.tx) + Math.abs(target.y - n.ty)
      if (dist <= 1) return Promise.resolve()
      const dir: Dir = target.x !== n.tx ? (target.x < n.tx ? 'left' : 'right') : target.y < n.ty ? 'up' : 'down'
      return walk(n, Array.from({ length: dist - 1 }, () => dir), speed)
    },
    canNpcStep,
  }
}

export type NpcLayer = ReturnType<typeof createNpcLayer>
