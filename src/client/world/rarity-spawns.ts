// Rarity-driven overworld presence on top of the shared spawn rules (src/shared/gameplay/spawns.ts):
//   - cue player: cue keys (RarityBehavior.cues, event auras/ambience) -> world fx / bubbles / sfx / flashes, all
//     defined in content/events/client.json `cues`;
//   - ambience emitter: periodic world fx around the player for active ambience cues;
//   - roam picks: pickVisibleSpawn() results converted for the regular roaming layer (roaming.ts deps.pick);
//   - special roamers: creatures placed by world events (spawn effects) and roaming UR legends — wander / stand,
//     avoid the player, carry their own battle flee parameters and are never despawned by the regular roamer rules;
//   - arrival presentation for scripted UR / MYTHIC battles.
// Map access goes through WorldApi only (finite maps and the infinite overworld). No DOM.
import type { BattleSideInit, Creature, Dir, GameMap, Rarity } from '../../shared/types.ts'
import type { CreatureActor, GameContext, WorldFx } from '../contracts.ts'
import type { IRng } from '../../shared/contracts.ts'
import { createCreature } from '../../shared/creature.ts'
import { roamingDisposition, speciesBehavior, type VisibleSpawn } from '../../shared/gameplay/spawns.ts'
import { canStep, collisionField, terrainAt } from '../../shared/world/worldapi.ts'
import { GAME } from './config.ts'
import { auraCueColor, cueDef, GPC } from './gameplay-config.ts'
import { DIR_VEC } from './motion.ts'
import type { RoamPick } from './roaming.ts'

type Bubbler = { bubble(text: string, ms?: number): void }

// ---------------------------------------------------------------------------------------------- cues

export function createCuePlayer(ctx: GameContext) {
  return {
    /** Plays a moment cue (spawn / notice / flee / arrival) at a world position (optionally on an actor). */
    play(key: string | null | undefined, at: { x: number; y: number; actor?: Bubbler | null }): void {
      const d = cueDef(key)
      if (!d) return
      const elev = ctx.world.elevationAt(at.x, at.y)
      for (const f of d.fx ?? []) ctx.world.spawnFx(f, at.x, at.y, elev)
      if (d.bubble && at.actor) at.actor.bubble(d.bubble, d.bubbleMs)
      if (d.sfx) ctx.audio.playSfx(d.sfx)
      if (d.flash) ctx.renderer.flash(d.flash.color, d.flash.ms)
      if (d.shake) ctx.renderer.shake(d.shake.intensity, d.shake.ms)
    },
  }
}

export type CuePlayer = ReturnType<typeof createCuePlayer>

/** Periodic world fx (and screen flashes) around the player for the active ambience cues. */
export function createAmbienceEmitter(ctx: GameContext, rng: IRng) {
  let cues: string[] = []
  const timers = new Map<string, { fx: number; flash: number }>()
  return {
    set(list: readonly string[]): void {
      cues = [...new Set(list)].filter((k) => cueDef(k))
      for (const k of [...timers.keys()]) if (!cues.includes(k)) timers.delete(k)
    },
    get cues(): readonly string[] { return cues },
    update(dt: number, at: { x: number; y: number }): void {
      for (const k of cues) {
        const d = cueDef(k)!
        const tm = timers.get(k) ?? { fx: rng.next() * (d.ambient?.everySec ?? 1), flash: d.flash?.everySec ?? 0 }
        timers.set(k, tm)
        const a = d.ambient
        if (a && a.fx.length && a.everySec > 0) {
          tm.fx -= dt
          if (tm.fx <= 0) {
            tm.fx += a.everySec
            for (let i = 0; i < Math.max(1, a.count); i++) {
              const ang = rng.next() * Math.PI * 2
              const r = rng.next() * a.radius
              const x = at.x + Math.cos(ang) * r, y = at.y + Math.sin(ang) * r
              ctx.world.spawnFx(rng.pick(a.fx) as WorldFx, x, y, ctx.world.elevationAt(x, y))
            }
          }
        }
        if (d.flash?.everySec) {
          tm.flash -= dt
          if (tm.flash <= 0) { tm.flash += d.flash.everySec; ctx.renderer.flash(d.flash.color, d.flash.ms) }
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------- roam picks

const orderOf = (rarity: string, ctx: Pick<GameContext, 'data'>): number => ctx.data.rarityById[rarity]?.order ?? 0

/** A pickVisibleSpawn() result as a regular roamer (roaming.ts): aura colour, behaviour, flee and cue keys. */
export function roamPickOf(v: VisibleSpawn, ctx: Pick<GameContext, 'data'>, secPerMinute: number): RoamPick {
  return {
    speciesId: v.speciesId, level: v.level, shiny: v.shiny,
    aura: auraCueColor(v.aura, v.rarity, ctx.data),
    rare: orderOf(v.rarity, ctx) >= GPC.roaming.rareFromOrder,
    extra: {
      ...(v.flee ? { flee: v.flee } : {}),
      avoidPlayer: v.avoidPlayer, speedMul: v.roamSpeed > 0 ? v.roamSpeed : 1, noticeRadius: v.noticeRadius,
      ...(v.lifeMinutes > 0 ? { lifeSec: v.lifeMinutes * secPerMinute } : {}),
      cues: { spawn: v.cues.spawn, notice: v.cues.notice, flee: v.cues.flee },
    },
  }
}

// ---------------------------------------------------------------------------------------------- special roamers

export interface SpecialSpec {
  /** 'ev:<event>:<k>' for event spawns, 'legend:<species>' for roaming legends. */
  tag: string
  creature: Creature
  flee?: BattleSideInit['flee']
  aura: string | null
  roaming: boolean
  avoidPlayer: boolean
  speedMul: number
  noticeRadius: number
  cues: { spawn?: string; notice?: string; flee?: string }
  /** Roaming UR legend species (battle bookkeeping). */
  legend?: string
}

export interface Special extends SpecialSpec {
  readonly actor: CreatureActor
  x: number
  y: number
  home: { x: number; y: number }
  target: { x: number; y: number } | null
  idle: number
  noticed: boolean
}

export interface SpecialDeps {
  readonly ctx: GameContext
  rng: IRng
  cues: CuePlayer
  map(): GameMap | null
  /** Tile reserved by NPCs / warps / the player. */
  reserved(tx: number, ty: number): boolean
}

const range = (rng: IRng, r: [number, number]) => r[0] + rng.next() * (r[1] - r[0])
const maxPartyLevel = (ctx: Pick<GameContext, 'save'>): number =>
  ctx.save.party.reduce((max, creature) => Math.max(max, creature.level), 0)

/** Walkable, dry, flat (no stairs / ledge) free tile — where a creature may stand. */
export function standable(map: GameMap, tx: number, ty: number, ctx: Pick<GameContext, 'data'>): boolean {
  if (!map.infinite && (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height)) return false
  if (collisionField(map).at(tx, ty) !== 0) return false
  const tt = ctx.data.terrain[terrainAt(map, tx, ty)]
  return !!tt && tt.walkable && !tt.liquid && !tt.stairs && !tt.ledge && !GAME.roaming.avoidTerrain?.includes(tt.key)
}

/** 8 neighbours in ring order (clockwise from north): consecutive entries are 4-adjacent. */
const RING: readonly (readonly [number, number])[] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]

/**
 * Would a stationary blocker (event NPC / pop-up trainer) on (tx, ty) cut a walkway? True when the tiles the
 * player can step to from there split into more than one group around it — a 1-tile causeway, bridge, corridor
 * or door lane. `blocked` marks tiles already taken by other actors.
 */
export function cutsPassage(map: GameMap, tx: number, ty: number, blocked: (x: number, y: number) => boolean = () => false): boolean {
  const field = collisionField(map)
  const open = RING.map(([dx, dy]) => !blocked(tx + dx, ty + dy) && canStep(map, field, tx, ty, tx + dx, ty + dy, { surf: false }))
  let groups = 0
  for (let k = 0; k < RING.length; k++) {
    if (!open[k]) continue
    const p = (k + RING.length - 1) % RING.length
    const [ax, ay] = RING[p], [bx, by] = RING[k]
    const linked = open[p] && canStep(map, field, tx + ax, ty + ay, tx + bx, ty + by, { surf: false })
    if (!linked) groups++
  }
  // A fully open ring has no break: one group.
  return groups > 1
}

export function createSpecialLayer(deps: SpecialDeps) {
  const { ctx, rng } = deps
  const S = GPC.special
  let list: Special[] = []

  function spawn(spec: SpecialSpec, x: number, y: number, opts: { cue?: boolean } = {}): Special {
    const actor = ctx.world.createCreatureActor(spec.creature.speciesId, spec.creature.shiny)
    actor.setAura(spec.aura)
    const s: Special = { ...spec, actor, x, y, home: { x, y }, target: null, idle: range(rng, S.idleSec), noticed: false }
    actor.setPosition(x, y, ctx.world.elevationAt(x, y))
    list.push(s)
    if (opts.cue !== false) {
      deps.cues.play(spec.cues.spawn, { x, y, actor })
      if (spec.creature.shiny) deps.cues.play(S.shinyCue, { x, y })
    }
    return s
  }

  function remove(s: Special, cue?: string | null): void {
    const i = list.indexOf(s)
    if (i >= 0) list.splice(i, 1)
    if (cue) deps.cues.play(cue, { x: s.x, y: s.y })
    s.actor.dispose()
  }

  function removeWhere(pred: (s: Special) => boolean, cue = false): void {
    for (const s of list.filter(pred)) remove(s, cue ? s.cues.flee : null)
  }

  function clear(): void {
    for (const s of list) s.actor.dispose()
    list = []
  }

  /** Moves toward a point; crossing into another tile must be a legal step. False when blocked / arrived. */
  function stepToward(map: GameMap, s: Special, tx: number, ty: number, speed: number, dt: number): boolean {
    const dx = tx - s.x, dy = ty - s.y
    const len = Math.hypot(dx, dy)
    if (len < S.arriveEpsilon) return false
    const d = Math.min(len, speed * dt)
    const nx = s.x + (dx / len) * d, ny = s.y + (dy / len) * d
    const fx = Math.floor(s.x), fy = Math.floor(s.y), qx = Math.floor(nx), qy = Math.floor(ny)
    if (qx !== fx || qy !== fy) {
      if (!canStep(map, collisionField(map), fx, fy, qx, qy, { surf: false }) || !standable(map, qx, qy, ctx) || deps.reserved(qx, qy)) return false
    }
    if (Math.abs(nx - s.x) > 1e-3) s.actor.setFacingLeft(nx < s.x)
    s.x = nx
    s.y = ny
    return true
  }

  function think(map: GameMap, s: Special, dt: number, player: { x: number; y: number }): boolean {
    if (!s.roaming) return false
    const disposition = roamingDisposition(
      ctx.data.species[s.creature.speciesId]?.country,
      s.creature.level,
      maxPartyLevel(ctx),
    )
    const dist = Math.hypot(player.x - s.x, player.y - s.y)
    const notice = s.noticeRadius > 0 ? s.noticeRadius : S.noticeRange
    if (disposition === 'neutral') {
      if (s.noticed) s.target = null
      s.noticed = false
    } else if (!s.noticed && notice > 0 && dist < notice) {
      s.noticed = true
      deps.cues.play(s.cues.notice, { x: s.x, y: s.y, actor: s.actor })
    } else if (s.noticed && dist > notice * 2) s.noticed = false
    if (s.noticed && disposition === 'flee') {
      const k = 1 / Math.max(0.001, dist)
      const tx = s.x + (s.x - player.x) * k * 2, ty = s.y + (s.y - player.y) * k * 2
      if (stepToward(map, s, tx, ty, S.speed * s.speedMul * S.fleeSpeedMul, dt)) return true
      s.target = null
    } else if (s.noticed && disposition === 'chase') {
      if (stepToward(map, s, player.x, player.y, S.speed * s.speedMul * S.chaseSpeedMul, dt)) return true
      s.target = null
    }
    if (!s.target) {
      s.idle -= dt
      if (s.idle > 0) return false
      const a = rng.next() * Math.PI * 2
      const r = rng.next() * S.wanderRadius
      s.target = { x: s.home.x + Math.cos(a) * r, y: s.home.y + Math.sin(a) * r }
    }
    if (stepToward(map, s, s.target.x, s.target.y, S.speed * s.speedMul, dt)) return true
    s.target = null
    s.idle = range(rng, S.idleSec)
    return false
  }

  /** Per frame; returns the special the player touched (only while `active`). */
  function update(dt: number, player: { x: number; y: number }, active: boolean): Special | null {
    const map = deps.map()
    if (!map) return null
    let touched: Special | null = null
    for (const s of list) {
      const dist = Math.hypot(player.x - s.x, player.y - s.y)
      const moving = active && dist < S.despawnDistance ? think(map, s, dt, player) : false
      s.actor.setMoving(moving)
      const near = dist < S.cullDistance
      s.actor.setVisible(near)
      if (near) {
        s.actor.setPosition(s.x, s.y, ctx.world.elevationAt(s.x, s.y))
        s.actor.update(dt)
      }
      if (active && !touched && dist < S.touchRadius) touched = s
    }
    return touched
  }

  return {
    spawn,
    remove,
    removeWhere,
    clear,
    update,
    get list(): readonly Special[] { return list },
    find(tag: string): Special | undefined { return list.find((s) => s.tag === tag) },
  }
}

export type SpecialLayer = ReturnType<typeof createSpecialLayer>

/** Builds a special-roamer spec for a visible spawn (event 'spawn' effect or legend). */
export function specialSpecOf(tag: string, v: VisibleSpawn, rng: IRng, ctx: Pick<GameContext, 'data'>, mapId: string): SpecialSpec {
  const creature = createCreature(v.speciesId, v.level, { rng, shiny: v.shiny, caughtMap: mapId }, ctx.data)
  return {
    tag, creature,
    ...(v.flee ? { flee: v.flee } : {}),
    aura: auraCueColor(v.aura, v.rarity, ctx.data),
    roaming: v.roaming, avoidPlayer: v.avoidPlayer, speedMul: v.roamSpeed > 0 ? v.roamSpeed : 1, noticeRadius: v.noticeRadius,
    cues: { spawn: v.cues.spawn, notice: v.cues.notice, flee: v.cues.flee },
  }
}

// ---------------------------------------------------------------------------------------------- arrival

/** Rarities whose scripted battles open with the arrival presentation. */
export function presentsArrival(speciesId: string, c: Pick<GameContext, 'data'>['data']): boolean {
  const r = c.species[speciesId]?.rarity as Rarity | undefined
  return !!r && GPC.presentation.rarities.includes(r)
}

/**
 * Scripted UR / MYTHIC encounter: the creature materialises in front of the player with its tier's arrival cue and
 * aura, holds for presentation.arriveHoldMs, then vanishes as the battle transition starts.
 */
export async function presentArrival(ctx: GameContext, speciesId: string, place: { x: number; y: number; facing: Dir }, shiny = false): Promise<void> {
  if (!ctx.world?.createCreatureActor || !presentsArrival(speciesId, ctx.data)) return
  const P = GPC.presentation
  const b = speciesBehavior(speciesId, ctx.data)
  const v = DIR_VEC[place.facing]
  const x = place.x + v.x * P.arriveDistance, y = place.y + v.y * P.arriveDistance
  const actor = ctx.world.createCreatureActor(speciesId, shiny)
  try {
    actor.setAura(auraCueColor(b.cues.aura, ctx.data.species[speciesId]?.rarity ?? '', ctx.data))
    actor.setFacingLeft(v.x > 0)
    actor.setPosition(x, y, ctx.world.elevationAt(x, y))
    actor.setVisible(true)
    createCuePlayer(ctx).play(b.cues.spawn, { x, y, actor })
    const start = performance.now()
    await new Promise<void>((resolve) => {
      let last = start
      const tick = (now: number) => {
        actor.update(Math.max(0, (now - last) / 1000))
        last = now
        if (now - start >= P.arriveHoldMs) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  } finally {
    actor.dispose()
  }
}
