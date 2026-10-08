// Types of the world-physics sections of content/render.json (footsteps, leaves, physics tiers ...). Kept apart from
// config.ts, which only references them. The data is in render.json; every number here is tunable there.
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
  /** Ripple distortion: sideways wobble amplitude (tiles), frequency (1/tile), speed (rad/s). */
  distort: { amp: number; freq: number; speed: number }
  /** Share of the sprite height over which the image fades out going down. */
  fade: number
  maxActors: number
  /** Actors farther than this from the focus (tiles) have no reflection. */
  maxDistance: number
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
