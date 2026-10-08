// Types of the world-physics sections of content/render.json (footsteps, leaves, physics tiers ...). Kept apart from
// config.ts, which only references them. The data is in render.json; every number here is tunable there.
import type { Content } from '../../shared/content/index.ts'
import type { RenderContent } from './config.ts'
type Vec2 = [number, number]

/** Per quality id: which physics effects run and how many particles they may keep alive. */
export interface PhysicsTier {
  /** Grass remembers trampled cells (off: instant bend by the nearest actors only). */
  trample: boolean
  /** "off" | "puffs" (dust / splash puffs only) | "full" (puffs, footprints, water rings). */
  footsteps: 'off' | 'puffs' | 'full'
  /** Live actor ripple rings on water (0 = none; also switches rain rings off). */
  ripples: number
  /** Mirrored actors / props in water. */
  reflections: boolean
  /** Live physical leaves / petals (0 = the old analytic leaf field stays). */
  leaves: number
  /** Rain splashes where drops land, snow flecks. */
  impacts: boolean
  /** Snow cover building up while it snows. */
  snowCover: boolean
  /** Capacity of the shared puff pool and of the footprint pool. */
  puffPool: number
  printPool: number
}

export interface PuffKind {
  count: number
  colors: string[]
  /** Horizontal speed (tiles/s), vertical launch speed, gravity (tiles/s^2, negative = rises), drag (1/s). */
  speed: Vec2; up: Vec2; gravity: number; drag: number
  life: Vec2
  /** Start / end size in world units (tiles) and peak alpha. */
  size: Vec2; grow: number; alpha: number
  /** Scale of the launch ring: 0 = spray from a point, 1 = particles start on a ring of `radius` and move outward. */
  radius: number
  /** How much the wind field pushes it (fraction of windVelocity). */
  wind: number
  /** Soft cloud or a hard bright droplet. */
  shape: 'cloud' | 'drop'
  /** Brightness multiplier on the colour (> 1 = bloom glints for droplets). */
  glow: number
}

export interface PrintKind {
  color: string
  alpha: number
  /** Foot length / width in tiles. */
  size: Vec2
  /** Sideways offset of each foot from the path centre line (tiles). */
  gap: number
  lifeSec: number
  fadeSec: number
  /** Darken (< 1) or lighten the lit ground colour by this much at full alpha. */
  rim: number
}

export interface StepClass {
  /** Puff(s) emitted per footstep (keys of footsteps.puffs). */
  puff?: string | string[]
  /** Footprint left per footstep (key of footsteps.prints). */
  print?: string
  /** Water ring per footstep: strength multiplier and rings per step. */
  ripple?: { amp: number; rings: number }
  /** A standing actor keeps stirring the surface every `idleEverySec`. */
  idleEverySec?: number
}

export interface FootstepsConfig {
  /** Actors farther than this from the focus (tiles) leave nothing. */
  maxDistance: number
  /** A move of at least this many tiles in one frame is a teleport (resets the stride). */
  teleportTiles: number
  /** Tiles per footstep for walking / running characters and per hop landing of creatures. */
  stride: { walk: number; run: number; hop: number }
  /** Characters moving faster than this (tiles/s) count as running. */
  runSpeed: number
  /** Terrain key -> step class (see classes). Unlisted terrains leave nothing. */
  terrain: Record<string, string>
  /** Terrain keys that turn into `class` where the climate snow field is above `threshold`. */
  climateSnow: { threshold: number; class: string; terrains: string[] }
  classes: Record<string, StepClass>
  puffs: Record<string, PuffKind>
  prints: Record<string, PrintKind>
  /** Liquid edge: an actor on land within `reach` tiles of water stirs it every `everySec` (strength `amp`). */
  shore: { reach: number; everySec: number; amp: number }
  /** Terrain-key independent puffs: landing from a ledge hop (land / splash). */
  land: { puff: string | string[]; splash: string | string[]; ripple: { amp: number; rings: number } }
  /** fx kinds (world.spawnFx) taken over while footsteps run: `land` plays the terrain-aware landing (dust ring, or
   * splash + rings on water), otherwise the given puffs and, where they fall on liquid, a water ring. */
  fxRoute: Record<string, { land?: boolean; puff?: string | string[]; ripple?: { amp: number; rings: number } }>
  /** Print texture: foot shape in texels (pixel art), sheet is `texels` wide. */
  printTexture: { width: number; height: number; rows: string[] }
  /** Where a print / puff sits above the ground, polygon-offset against z-fighting. */
  lift: number
}

export interface LeavesKind {
  colors: string[]
  size: Vec2
  /** Props (content/props.json keys) whose canopies shed this kind. */
  props: string[]
  /** Airborne leaves wanted at ambient level 1, before the tier cap. */
  air: number
  /** How strongly the wind field carries it (1 = at air speed). */
  windGain: number
}

export interface LeavesConfig {
  kinds: Record<string, LeavesKind>
  /** Canopies closer than this to the focus (tiles) shed leaves; leaves farther than `cull` vanish. */
  reach: number
  cull: number
  gravity: number
  /** Fall speed of a drifting leaf (tiles/s), picked per leaf. */
  terminal: Vec2
  /** Horizontal relaxation towards the wind (1/s). */
  drag: number
  /** Flutter: swerve frequency (Hz), sideways speed (tiles/s), fall speed modulation 0..1. */
  flutter: { hz: Vec2; amp: number; fall: number }
  /** Upward speed (tiles/s) a full gust adds to the air under it: leaves lift in gusts. */
  gustLift: number
  /** Tumble rate (rad/s) while falling. */
  tumble: Vec2
  /** Seconds lying on the ground, then the fade. */
  rest: Vec2; fade: number
  /** On water: drift speed (tiles/s) and seconds afloat. */
  water: { drift: number; rest: Vec2 }
  /** Where leaves start under a canopy: fraction of its height, fraction of its radius. */
  emit: { height: Vec2; spread: number }
  /** Wind-borne leaves arriving from upwind when no canopy is near: per second at ambient 1, start height. */
  stray: { rate: number; height: Vec2 }
  /** Cap on spawns per frame. */
  spawnPerFrame: number
}

export interface ImpactKind {
  color: string
  alpha: number
  /** "ring": a splash ring widening to `size`; "fleck": a speck that settles and fades. */
  style: 'ring' | 'fleck'
  /** Seconds a splash lasts and its final diameter in world units (fleck: its size). */
  life: number
  size: number
  /** Fraction of the drops that leave a visible splash. */
  share: number
}

/** Snow that builds up on the ground while it snows and melts away afterwards. */
export interface SnowCoverConfig {
  /** Weather kind that adds snow. */
  weather: string
  /** Terrain coverage reached after `buildSec` of full snowfall (0..1) and the seconds to melt it again. */
  max: number
  buildSec: number
  meltSec: number
}

export interface ReflectionsConfig {
  alpha: number
  /** Brightness kept by the mirror image (0..1) and the water tint mixed in. */
  darken: number; tint: string; tintAmount: number
  /** Ripple distortion: sideways wobble amplitude (tiles), frequency (1/tile of depth below the waterline), speed (rad/s). */
  distort: { amp: number; freq: number; speed: number }
  /** Share of the sprite height over which the image fades out going down. */
  fade: number
  maxActors: number
  /** Actors farther than this from the focus (tiles) have no reflection. */
  maxDistance: number
  /** An actor on land mirrors in water up to this many tiles away. */
  reach: number
  /** A tile counts as the actor's water when its surface is within this many world units of the plane. */
  tolerance: number
  renderOrder: number
}

export interface WaterFxConfig {
  /** Actor / shore rings: expansion speed (tiles/s), life (s), ring half-width (tiles), brightness. */
  ripple: { speed: number; life: number; width: number; strength: number }
  /** Rain rings on the water surface. */
  rain: { cell: number; life: number; radius: number; width: number; strength: number }
  /** Foam lines washing up the shore: period (s), reach (shore units), strength. */
  wash: { period: number; width: number; strength: number }
}

export interface PhysicsConfig {
  tiers: Record<string, PhysicsTier>
}

type PhysicsData = Pick<RenderContent, 'wind' | 'grass' | 'water' | 'physics' | 'footsteps' | 'leaves' | 'impacts' | 'snowCover' | 'reflections' | 'particles' | 'weather' | 'fx' | 'quality'>

/** Consistency of the world-physics sections of render.json (reported as messages, see validateRenderContent). */
export function validatePhysics(r: PhysicsData, c: Content, color: (where: string, v: unknown) => void): string[] {
  const errs: string[] = []
  const num = (where: string, v: unknown, min = -Infinity, max = Infinity) => { if (!(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max)) errs.push(`${where}: must be a number in ${min}..${max}`) }
  const range = (where: string, v: unknown, min = 0) => { if (!(Array.isArray(v) && v.length === 2 && v[0] >= min && v[1] >= v[0])) errs.push(`${where}: must be [min, max] with ${min} <= min <= max`) }

  const W = r.wind.field
  num('wind.field.wavelength', W.wavelength, 1e-3); num('wind.field.speed', W.speed, 0); num('wind.field.sharp', W.sharp, 1e-3)
  num('wind.field.calm', W.calm, 0, 1); num('wind.gustLean', r.wind.gustLean, 0); num('wind.drift.base', r.wind.drift.base, 0); num('wind.drift.gust', r.wind.drift.gust, 0, 1)

  const T = r.grass.trample
  if (!(Number.isInteger(T.cellsPerTile) && T.cellsPerTile >= 1 && T.cellsPerTile <= 8)) errs.push('grass.trample.cellsPerTile: integer 1..8')
  num('grass.trample.window', T.window, 8); num('grass.trample.recoverSec', T.recoverSec, 0.05); num('grass.trample.edgeFade', T.edgeFade, 0, T.window / 2)
  num('grass.trample.maxBenders', T.maxBenders, 1); num('grass.trample.strength', T.strength, 0); num('grass.trample.sink', T.sink, 0, 1); num('grass.trample.darken', T.darken, 0, 1)
  if (T.window * T.cellsPerTile > 512) errs.push('grass.trample: window x cellsPerTile above 512 cells makes a very large texture')

  const WI = r.water.interact
  num('water.interact.ripple.speed', WI.ripple.speed, 0); num('water.interact.ripple.life', WI.ripple.life, 0.05); num('water.interact.rain.cell', WI.rain.cell, 0.1)
  num('water.interact.wash.period', WI.wash.period, 0.1)

  for (const q of Object.keys(r.quality)) {
    const t = r.physics.tiers[q]
    if (!t) { errs.push(`physics.tiers: missing quality "${q}"`); continue }
    for (const k of ['trample', 'reflections', 'impacts', 'snowCover'] as const) if (typeof t[k] !== 'boolean') errs.push(`physics.tiers.${q}.${k}: must be a boolean`)
    if (!['off', 'puffs', 'full'].includes(t.footsteps)) errs.push(`physics.tiers.${q}.footsteps: off | puffs | full`)
    for (const k of ['ripples', 'leaves', 'puffPool', 'printPool'] as const) if (!(Number.isInteger(t[k]) && t[k] >= 0)) errs.push(`physics.tiers.${q}.${k}: integer >= 0`)
    if (t.ripples > 24) errs.push(`physics.tiers.${q}.ripples: the water shader draws at most 24 rings`)
  }

  const F = r.footsteps
  num('footsteps.maxDistance', F.maxDistance, 1); num('footsteps.teleportTiles', F.teleportTiles, 1); num('footsteps.runSpeed', F.runSpeed, 0)
  for (const k of ['walk', 'run', 'hop'] as const) num(`footsteps.stride.${k}`, F.stride[k], 0.05)
  for (const [k, p] of Object.entries(F.puffs)) {
    const w = `footsteps.puffs.${k}`
    p.colors.forEach((x, i) => color(`${w}.colors[${i}]`, x))
    if (!p.colors.length) errs.push(`${w}: needs a colour`)
    range(`${w}.speed`, p.speed, 0); range(`${w}.life`, p.life, 0.05); range(`${w}.size`, p.size, 0)
    if (!['cloud', 'drop'].includes(p.shape)) errs.push(`${w}.shape: cloud | drop`)
    num(`${w}.count`, p.count, 0); num(`${w}.alpha`, p.alpha, 0, 1)
  }
  for (const [k, p] of Object.entries(F.prints)) {
    color(`footsteps.prints.${k}.color`, p.color); num(`footsteps.prints.${k}.alpha`, p.alpha, 0, 1)
    num(`footsteps.prints.${k}.lifeSec`, p.lifeSec, 0); num(`footsteps.prints.${k}.fadeSec`, p.fadeSec, 0.01)
  }
  const puffs = (where: string, v: string | string[] | undefined) => { for (const k of v === undefined ? [] : Array.isArray(v) ? v : [v]) if (!F.puffs[k]) errs.push(`${where}: unknown puff "${k}"`) }
  for (const [k, cl] of Object.entries(F.classes)) {
    puffs(`footsteps.classes.${k}.puff`, cl.puff)
    if (cl.print && !F.prints[cl.print]) errs.push(`footsteps.classes.${k}.print: unknown print "${cl.print}"`)
  }
  for (const [terrain, cl] of Object.entries(F.terrain)) {
    if (!c.terrainByKey[terrain]) errs.push(`footsteps.terrain: unknown terrain "${terrain}"`)
    if (!F.classes[cl]) errs.push(`footsteps.terrain.${terrain}: unknown class "${cl}"`)
  }
  if (!F.classes[F.climateSnow.class]) errs.push(`footsteps.climateSnow.class: unknown class "${F.climateSnow.class}"`)
  for (const t of F.climateSnow.terrains) if (!c.terrainByKey[t]) errs.push(`footsteps.climateSnow.terrains: unknown terrain "${t}"`)
  puffs('footsteps.land.puff', F.land.puff); puffs('footsteps.land.splash', F.land.splash)
  for (const [fx, e] of Object.entries(F.fxRoute)) {
    if (!r.fx.kinds[fx]) errs.push(`footsteps.fxRoute: unknown fx kind "${fx}"`)
    puffs(`footsteps.fxRoute.${fx}.puff`, e.puff)
  }
  const pt = F.printTexture
  if (pt.rows.length !== pt.height || pt.rows.some((row) => row.length !== pt.width)) errs.push(`footsteps.printTexture: rows must be ${pt.width} x ${pt.height}`)

  const L = r.leaves
  for (const [k, kind] of Object.entries(L.kinds)) {
    if (!r.particles[k]) errs.push(`leaves.kinds.${k}: no particle kind of that name (it is the ambient the biomes list)`)
    kind.colors.forEach((x, i) => color(`leaves.kinds.${k}.colors[${i}]`, x))
    range(`leaves.kinds.${k}.size`, kind.size, 0)
    for (const p of kind.props) if (!c.props[p]) errs.push(`leaves.kinds.${k}.props: unknown prop "${p}"`)
  }
  range('leaves.terminal', L.terminal, 0); range('leaves.rest', L.rest, 0); range('leaves.tumble', L.tumble, 0)
  num('leaves.gravity', L.gravity, 0); num('leaves.fade', L.fade, 0.01); num('leaves.cull', L.cull, L.reach)

  for (const [k, im] of Object.entries(r.impacts)) {
    if (!r.particles[k]) errs.push(`impacts.${k}: unknown particle kind`)
    color(`impacts.${k}.color`, im.color)
    if (!['ring', 'fleck'].includes(im.style)) errs.push(`impacts.${k}.style: ring | fleck`)
    num(`impacts.${k}.share`, im.share, 0, 1); num(`impacts.${k}.life`, im.life, 0.01)
  }
  if (!r.weather[r.snowCover.weather]) errs.push(`snowCover.weather: unknown weather "${r.snowCover.weather}"`)
  num('snowCover.max', r.snowCover.max, 0, 1); num('snowCover.buildSec', r.snowCover.buildSec, 1); num('snowCover.meltSec', r.snowCover.meltSec, 1)

  const R = r.reflections
  color('reflections.tint', R.tint)
  for (const k of ['alpha', 'darken', 'tintAmount'] as const) num(`reflections.${k}`, R[k], 0, 1)
  num('reflections.fade', R.fade, 0.05); num('reflections.maxActors', R.maxActors, 0); num('reflections.maxDistance', R.maxDistance, 1)
  num('reflections.reach', R.reach, 0, 6); num('reflections.tolerance', R.tolerance, 0)
  return errs
}
