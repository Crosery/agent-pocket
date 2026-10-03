// Visible roaming wild creatures: spawned around the player from the local region's encounter table
// (density = config.encounters.roamingMax × region.roamingDensity), wandering / fleeing / chasing per
// content/game.json, with rarity auras and shiny sparkles. Touching one starts a battle with exactly it.
import type { BattleSideInit, Creature, GameMap, RegionDef } from '../../shared/types.ts'
import type { CreatureActor, GameContext } from '../contracts.ts'
import type { IRng } from '../../shared/contracts.ts'
import { createCreature, rollShiny } from '../../shared/creature.ts'
import { regionAt, terrainAt } from '../../shared/world/worldapi.ts'
import { GAME } from './config.ts'
import { auraColor, pickEncounter } from './encounters.ts'
import { gridField, moveBody, type MotionGrid, type MotionOpts } from './motion.ts'

type Mood = 'calm' | 'flee' | 'chase'

/** Rarity behaviour of a roamer picked by the gameplay runtime (events-runtime.ts / rarity-spawns.ts). */
export interface RoamExtra {
  /** Battle flee rule (SSR skittish / legends). */
  flee?: BattleSideInit['flee']
  /** Runs from the player once noticed (SSR). */
  avoidPlayer: boolean
  /** Multiplier on the roaming speeds. */
  speedMul: number
  /** Notice range in tiles (0 = config default). */
  noticeRadius: number
  /** Lifetime in real seconds (overrides config lifetime). */
  lifeSec?: number
  /** Cue keys (content/events/client.json cues) played on spawn / notice / despawn. */
  cues: { spawn?: string; notice?: string; flee?: string }
}

export interface RoamPick { speciesId: string; level: number; shiny: boolean; aura: string | null; rare: boolean; extra?: RoamExtra }

export interface Roamer {
  readonly id: number
  readonly creature: Creature
  readonly rare: boolean
  readonly actor: CreatureActor
  /** RegionDef.id it spawned in (it never wanders out of it). */
  readonly region: string
  x: number
  y: number
  home: { x: number; y: number }
  target: { x: number; y: number } | null
  idle: number
  life: number
  mood: Mood
  noticed: boolean
  speed: number
  /** Rarity behaviour when picked by deps.pick. */
  extra?: RoamExtra
}

export interface RoamingDeps {
  readonly ctx: GameContext
  grid(): MotionGrid | null
  rng: IRng
  /** True if a tile is a warp, NPC or otherwise reserved. */
  reserved(tx: number, ty: number): boolean
  /** Rarity-aware pick (gameplay runtime); undefined result = no spawn this attempt. Absent = local table pick. */
  pick?(region: RegionDef, x: number, y: number, present: readonly Roamer[]): RoamPick | null
  /** Plays a cue key at a position / on an actor. */
  cue?(key: string | undefined, at: { x: number; y: number; actor?: CreatureActor | null }): void
}

const range = (rng: IRng, r: [number, number]) => r[0] + rng.next() * (r[1] - r[0])

export function createRoamingLayer(deps: RoamingDeps) {
  const { ctx, rng } = deps
  const R = GAME.roaming
  const roamers: Roamer[] = []
  let nextId = 1
  let spawnT = 0
  const motion: MotionOpts = { radius: GAME.player.radius * 0.9, surf: false, cornerSlip: GAME.player.cornerSlip, cornerSlipRate: 1, substep: GAME.player.substepTiles }

  const remove = (r: Roamer, fx = true) => {
    const i = roamers.indexOf(r)
    if (i >= 0) roamers.splice(i, 1)
    if (fx) {
      ctx.world.spawnFx(R.despawnFx, r.x, r.y, ctx.world.elevationAt(r.x, r.y))
      if (r.extra?.cues.flee && deps.cue) deps.cue(r.extra.cues.flee, { x: r.x, y: r.y })
    }
    r.actor.dispose()
  }

  function clear(): void {
    for (const r of [...roamers]) remove(r, false)
    spawnT = 0
  }

  function capacityAt(map: GameMap, x: number, y: number): number {
    const region = regionAt(map, x, y)
    if (!region || !region.encounters.length || !(region.roamingDensity > 0)) return 0
    return Math.round(ctx.data.config.encounters.roamingMax * Math.min(1, region.roamingDensity))
  }

  function trySpawn(g: MotionGrid, player: { x: number; y: number }): void {
    const map = g.map
    const radius = ctx.data.config.encounters.roamingRadius
    for (let attempt = 0; attempt < R.spawnTries; attempt++) {
      const a = rng.next() * Math.PI * 2
      const d = R.minSpawnDistance + rng.next() * Math.max(0, radius - R.minSpawnDistance)
      const tx = Math.floor(player.x + Math.cos(a) * d), ty = Math.floor(player.y + Math.sin(a) * d)
      if (!map.infinite && (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height)) continue
      if (gridField(g).at(tx, ty) !== 0 || deps.reserved(tx, ty)) continue
      const terrain = ctx.data.terrain[terrainAt(map, tx, ty)]
      if (!terrain?.walkable || terrain.liquid || terrain.stairs || terrain.ledge) continue
      if (R.requireEncounterTerrain && !terrain.encounter) continue
      if (R.avoidTerrain?.includes(terrain.key)) continue
      const region = regionAt(map, tx, ty)
      if (!region || !region.encounters.length || !(region.roamingDensity > 0)) continue
      let picked: RoamPick | null
      if (deps.pick) picked = deps.pick(region, tx + 0.5, ty + 0.5, roamers)
      else {
        const p = pickEncounter(region.encounters, ctx.clock.timeOfDay, rng, ctx.data)
        picked = p ? { speciesId: p.speciesId, level: p.level, shiny: rollShiny(rng, ctx.data), aura: auraColor(p.speciesId, !!p.slot.rare, ctx.data), rare: !!p.slot.rare } : null
      }
      if (!picked) continue
      const creature = createCreature(picked.speciesId, picked.level, { rng, shiny: picked.shiny, caughtMap: map.id }, ctx.data)
      const actor = ctx.world.createCreatureActor(creature.speciesId, creature.shiny)
      const rare = picked.rare
      const extra = picked.extra
      actor.setAura(picked.aura)
      const x = tx + 0.5, y = ty + 0.5
      actor.setPosition(x, y, ctx.world.elevationAt(x, y))
      const fleeChance = rare ? R.rareFleeChance : R.fleeChance
      const roll = rng.next()
      const mood: Mood = extra?.avoidPlayer ? 'flee' : roll < fleeChance ? 'flee' : roll < fleeChance + R.chaseChance ? 'chase' : 'calm'
      roamers.push({
        id: nextId++, creature, rare, actor, region: region.id, x, y, home: { x, y }, target: null,
        idle: range(rng, R.idleSec), life: extra?.lifeSec ?? range(rng, R.lifetimeSec), mood, noticed: false,
        speed: R.speed * (extra?.speedMul ?? 1), ...(extra ? { extra } : {}),
      })
      ctx.world.spawnFx(R.spawnFx, x, y, ctx.world.elevationAt(x, y))
      if (extra?.cues.spawn && deps.cue) deps.cue(extra.cues.spawn, { x, y, actor })
      return
    }
  }

  function pickWanderTarget(r: Roamer): void {
    const a = rng.next() * Math.PI * 2
    const d = rng.next() * R.wanderRadius
    r.target = { x: r.home.x + Math.cos(a) * d, y: r.home.y + Math.sin(a) * d }
    r.speed = R.speed * (r.extra?.speedMul ?? 1)
  }

  function step(g: MotionGrid, r: Roamer, dt: number, player: { x: number; y: number }): void {
    const dist = Math.hypot(player.x - r.x, player.y - r.y)
    const noticeRange = r.extra && r.extra.noticeRadius > 0 ? r.extra.noticeRadius : R.noticeRange
    const speedMul = r.extra?.speedMul ?? 1
    if (!r.noticed && dist < noticeRange && r.mood !== 'calm') {
      r.noticed = true
      if (r.extra?.cues.notice && deps.cue) deps.cue(r.extra.cues.notice, { x: r.x, y: r.y, actor: r.actor })
      else r.actor.bubble(r.mood === 'flee' ? R.fleeBubble : R.noticeBubble, R.noticeBubbleMs)
    }
    if (r.noticed && r.mood === 'flee' && dist < noticeRange * 2) {
      const k = 1 / Math.max(0.001, dist)
      r.target = { x: r.x + (r.x - player.x) * k * 2, y: r.y + (r.y - player.y) * k * 2 }
      r.speed = R.fleeSpeed * speedMul
    } else if (r.noticed && r.mood === 'chase' && dist < noticeRange * 2) {
      r.target = { x: player.x, y: player.y }
      r.speed = R.chaseSpeed * speedMul
    } else if (!r.target) {
      r.idle -= dt
      if (r.idle <= 0) pickWanderTarget(r)
    }
    let moving = false
    if (r.target) {
      const dx = r.target.x - r.x, dy = r.target.y - r.y
      const len = Math.hypot(dx, dy)
      if (len < R.arriveEpsilon) { r.target = null; r.idle = range(rng, R.idleSec) }
      else {
        const s = Math.min(len, r.speed * dt)
        const res = moveBody(g, r.x, r.y, (dx / len) * s, (dy / len) * s, motion)
        const leftRegion = regionAt(g.map, res.x, res.y)?.id !== r.region
        const tx = Math.floor(res.x), ty = Math.floor(res.y)
        if (leftRegion || deps.reserved(tx, ty) || Math.hypot(res.x - r.x, res.y - r.y) < s * 0.2) {
          r.target = null
          r.idle = range(rng, R.idleSec)
        } else {
          if (Math.abs(res.x - r.x) > 1e-3) r.actor.setFacingLeft(res.x < r.x)
          r.x = res.x
          r.y = res.y
          moving = true
        }
      }
    }
    r.actor.setMoving(moving)
  }

  /** Per-frame: spawn/despawn/move; returns the roamer the player touched (if any). */
  function update(dt: number, player: { x: number; y: number }, active: boolean): Roamer | null {
    const g = deps.grid()
    if (!g || !R.mapKinds.includes(g.map.kind)) { if (roamers.length) clear(); return null }
    const radius = ctx.data.config.encounters.roamingRadius
    let touched: Roamer | null = null
    for (const r of [...roamers]) {
      r.life -= dt
      const dist = Math.hypot(player.x - r.x, player.y - r.y)
      if (dist > radius + R.despawnMargin || (r.life <= 0 && dist > R.minSpawnDistance)) { remove(r); continue }
      if (active) step(g, r, dt, player)
      else r.actor.setMoving(false)
      const near = dist < R.cullDistance
      r.actor.setVisible(near)
      if (near) {
        r.actor.setPosition(r.x, r.y, ctx.world.elevationAt(r.x, r.y))
        r.actor.update(dt)
      }
      if (active && !touched && dist < R.touchRadius) touched = r
    }
    if (active) {
      spawnT -= dt
      if (spawnT <= 0) {
        spawnT = R.spawnIntervalSec
        if (roamers.length < capacityAt(g.map, player.x, player.y)) trySpawn(g, player)
      }
    }
    return touched
  }

  return {
    update,
    clear,
    remove,
    get list(): readonly Roamer[] { return roamers },
  }
}

export type RoamingLayer = ReturnType<typeof createRoamingLayer>
