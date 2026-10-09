// Typed access to content/battle-stage.json (every tunable of the battle diorama: layout, camera shots, lighting
// overrides, backdrop, ball choreography and the VFX timelines per MoveAnim) plus validation. Pure: no three.js,
// no DOM, so node tests can validate the data.
import stageJson from '../../../../content/battle-stage.json' with { type: 'json' }
import { CONTENT, type Content } from '../../../shared/content/index.ts'
import type { Dir, MoveCategory, TimeOfDay } from '../../../shared/types.ts'
import { PARTICLE_SHAPES, RENDER, isHexColor, type RenderContent } from '../config.ts'

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
/** [x0, z0, x1, z1] in tiles relative to the stage origin (x right, z toward the camera). */
export type Rect = [number, number, number, number]
export type SideIndex = 0 | 1

// ---------------------------------------------------------------------------
// VFX step DSL
// ---------------------------------------------------------------------------

/** Effect primitives implemented in battle/primitives.ts (code capabilities keyed by id). */
export const FX_PRIMITIVES = [
  'particles', 'projectile', 'beam', 'ring', 'slash', 'bolt', 'shield', 'column', 'glow', 'spikes',
  'light', 'flash', 'shake', 'camera', 'dim',
  'tint', 'lunge', 'knock', 'dodge', 'jitter', 'squash', 'sink', 'dissolve', 'reveal', 'vanish', 'enter',
] as const
export type FxPrimitive = (typeof FX_PRIMITIVES)[number]

/** Particle shapes: the renderer's shapes plus battle-only pixel squares and text glyphs. */
export const VFX_SHAPES = [...PARTICLE_SHAPES, 'square', 'glyph'] as const
export type VfxShape = (typeof VFX_SHAPES)[number]

/** Anchor points: the side the call is about ("self"), its opponent ("foe"), their midpoint, trainers, stage origin. */
export const ANCHORS = ['self', 'foe', 'mid', 'selfTrainer', 'foeTrainer', 'stage'] as const
export type AnchorId = (typeof ANCHORS)[number]

export const REVEAL_MODES = ['pop', 'silhouette', 'materialize', 'drop', 'instant'] as const
export const VANISH_MODES = ['shrink', 'dissolve', 'instant'] as const
export const DISSOLVE_MODES = ['out', 'in'] as const
export const TINT_MODES = ['blink', 'fade', 'hold', 'in'] as const
export const EMIT_DIRS = ['radial', 'up', 'down', 'inward', 'none'] as const
export const RING_ORIENTS = ['ground', 'facing', 'axis'] as const

export interface TrailDef { rate: number; size: Vec2; life: Vec2; shape: VfxShape; glow?: number; spread?: number; color?: string }

/**
 * One timeline step. `t` = start (s) relative to the timeline; `use` expands a snippet instead of `fx`.
 * Positions: anchor `on` (+ `h` creature heights up, + `off` in the local frame [toward foe, up, lateral]).
 * Colors: '#rrggbb' or '$main' / '$light' / '$dark' / '$white' (the call's tint color, see resolveColor).
 */
export interface VfxStep {
  t?: number
  fx?: FxPrimitive
  use?: string
  when?: MoveCategory[]
  on?: AnchorId
  h?: number
  off?: Vec3
  to?: AnchorId
  toH?: number
  toOff?: Vec3
  dur?: number
  color?: string
  color2?: string
  colors?: string[]
  glow?: number
  // particles / projectiles
  count?: number
  stagger?: number
  shape?: VfxShape
  chars?: string
  size?: Vec2
  life?: Vec2
  speed?: Vec2
  vel?: Vec3
  spread?: Vec3
  radius?: number
  gravity?: number
  drag?: number
  emit?: number
  orbit?: number
  /** Random spin speed (rad/s) of leaf / star / glyph particles. */
  spin?: number
  grow?: number
  blend?: 'add' | 'alpha'
  dir?: (typeof EMIT_DIRS)[number]
  trail?: TrailDef
  wobble?: Vec2
  arcHeight?: number
  // meshes
  width?: number
  radii?: Vec2
  arc?: number
  angle?: number
  segments?: number
  jitter?: number
  hz?: number
  height?: number
  spacing?: number
  orient?: (typeof RING_ORIENTS)[number]
  // actors
  who?: 'creature' | 'trainer'
  amount?: number
  distance?: number
  pulses?: number
  mode?: string
  hideAfter?: boolean
  from?: Vec3
  // camera / screen
  shot?: string
  hold?: number
  back?: number
  intensity?: number
  ms?: number
  /** Envelope fade-in / fade-out as fractions of `dur` (dim, glow, ring, beam, projectile, shield, column, light, tint). */
  inK?: number
  outK?: number
}

/**
 * Step fields each primitive reads as always present: every one of them must be given by `vfx.defaults[fx]`
 * (expandSteps merges the defaults under each step). Fields not listed are optional features (absent = off).
 */
export const PRIMITIVE_FIELDS: Record<FxPrimitive, readonly (keyof VfxStep)[]> = {
  particles: ['on', 'h', 'count', 'glow', 'color', 'shape', 'emit', 'speed', 'life', 'size', 'grow', 'gravity', 'drag', 'orbit', 'spin', 'dir', 'blend', 'radius'],
  projectile: ['on', 'to', 'h', 'glow', 'color', 'color2', 'dur', 'count', 'stagger', 'radius', 'size', 'arcHeight', 'inK'],
  beam: ['on', 'to', 'h', 'glow', 'color', 'color2', 'dur', 'width', 'segments', 'hz', 'inK'],
  ring: ['on', 'h', 'glow', 'color', 'color2', 'radii', 'orient', 'dur', 'count', 'stagger', 'width', 'inK'],
  slash: ['on', 'h', 'glow', 'color', 'color2', 'dur', 'arc', 'angle', 'jitter', 'count', 'stagger', 'radius', 'width', 'segments', 'spacing'],
  bolt: ['on', 'h', 'glow', 'color', 'color2', 'segments', 'dur', 'hz', 'count', 'stagger', 'spacing', 'height', 'jitter', 'width'],
  shield: ['on', 'h', 'glow', 'color', 'color2', 'amount', 'segments', 'radius', 'dur', 'inK', 'outK'],
  column: ['on', 'h', 'glow', 'color', 'color2', 'count', 'stagger', 'segments', 'hz', 'spacing', 'radius', 'height', 'dur', 'inK', 'outK'],
  glow: ['on', 'h', 'glow', 'color', 'color2', 'amount', 'width', 'size', 'dur', 'inK', 'outK'],
  spikes: ['on', 'h', 'glow', 'color', 'count', 'spacing', 'angle', 'size', 'radius', 'dur'],
  light: ['on', 'h', 'color', 'radius', 'intensity', 'dur', 'inK'],
  flash: ['color', 'ms', 'amount'],
  shake: ['intensity', 'ms'],
  camera: ['on', 'shot', 'dur', 'back'],
  dim: ['amount', 'dur', 'inK', 'outK'],
  tint: ['on', 'dur', 'amount', 'glow', 'color', 'mode', 'pulses', 'inK', 'outK'],
  lunge: ['on', 'dur', 'glow', 'distance', 'height'],
  knock: ['on', 'dur', 'glow', 'distance'],
  dodge: ['on', 'dur', 'glow', 'distance', 'height'],
  jitter: ['on', 'dur', 'amount', 'hz', 'angle', 'glow'],
  squash: ['on', 'dur', 'glow', 'amount'],
  sink: ['on', 'dur', 'glow', 'distance'],
  dissolve: ['on', 'dur', 'glow', 'mode'],
  reveal: ['on', 'dur', 'amount', 'glow', 'color', 'mode', 'height'],
  vanish: ['on', 'dur', 'amount', 'glow', 'color', 'mode'],
  enter: ['on', 'dur', 'glow', 'from'],
}

// ---------------------------------------------------------------------------
// Stage data
// ---------------------------------------------------------------------------

export interface SlotDef {
  /** Creature and trainer ground positions [x, z] relative to the origin. */
  creature: Vec2
  trainer: Vec2
  /** Creature size multiplier for this slot (the near player slot reads larger). */
  scale: number
  /** Creature art faces the opponent: true = should look toward +x. */
  facesRight: boolean
  /** Character sheet row (direction) used for this slot's trainer. */
  trainerRow: Dir
  /** Ball origin when the slot has no trainer [x, y, z]. */
  ballFrom: Vec3
}

export interface BreathDef { hz: number; squash: number; bob: number }

/** Shared billboard tunables (creatures and trainers). */
export interface SpriteCfg {
  /** Horizontal widening per unit of vertical squash (volume preservation). */
  squashWiden: number
}

export interface CreatureCfg {
  /** World height of a size-1 species. */
  height: number
  /** How much SpeciesDef.size (overworld scale) carries into battle: 1 + (size - 1) * influence, then clamped. */
  sizeInfluence: number
  sizeClamp: Vec2
  alphaTest: number
  normalTilt: number
  breath: BreathDef
  dissolveCells: number
  dissolveEdge: string
  dissolveEdgeGlow: number
  dissolveEdgeWidth: number
  /** Grass bend radius as a fraction of the sprite height. */
  bend: number
  /** Idle-breathing phase per slot (radians) so the two sides never breathe in sync. */
  breathPhase: Vec2
}

export interface TrainerCfg {
  height: number
  alphaTest: number
  normalTilt: number
  frame: number
  breath: BreathDef
  /** Ball release height as a fraction of the trainer height. */
  handH: number
  breathPhase: Vec2
}

export interface ShotDef { pos: Vec3; look: Vec3; fov?: number }

export interface CameraCfg {
  fov: number
  /** Aspect the shots are framed for: on narrower screens the vertical FOV widens to keep that horizontal coverage. */
  refAspect: number
  near: number
  far: number
  /** Idle sway amplitudes / frequencies; `phase` offsets the three axes; `rate` = how fast setSway() levels ease (1/s). */
  sway: { pos: Vec3; look: Vec3; hz: Vec3; phase: number; rate: number }
  /** Shots relative to the origin; a pair is indexed by side (player 0 / opponent 1). */
  shots: Record<string, ShotDef | [ShotDef, ShotDef]>
}

export interface PostCfg { tiltShift: number; bokehScale: number; vignetteAdd: number; bloomMul: number }

export interface LightingCfg {
  /** Extra yaw (deg) applied to the sampled sun direction to give the diorama a readable shadow angle. */
  sunYawDeg: number
  propLightPool: number
  vfxLights: number
  vfxLightDecay: number
  /** Multiplier on the sky rig's fog distances (the battle camera is closer than the overworld camera). */
  fogScale: number
  /** Per time-of-day multipliers keeping battles readable (night battles are lit brighter than the overworld). */
  tod: Record<TimeOfDay, { sun: number; hemi: number; exposure: number }>
  /** Same for indoor battles. */
  indoor: { sun: number; hemi: number; exposure: number }
  /** Flicker phase step between consecutive map lamps (radians). */
  lampPhaseStep: number
  /** Seconds between terrain-atlas refresh checks while textures stream in. */
  atlasRefresh: number
}

export interface SilhouetteLayer {
  kind: 'mountains' | 'hills' | 'pines' | 'trees' | 'city' | 'spires' | 'sea' | 'wall' | 'columns'
  color: string
  /** Layer top / base heights as fractions of the texture height (0 = bottom). */
  top: number
  base: number
  amp?: number
  freq?: number
  seed?: number
  lightColor?: string
  lightDensity?: number
}
export const SILHOUETTE_KINDS: readonly SilhouetteLayer['kind'][] = ['mountains', 'hills', 'pines', 'trees', 'city', 'spires', 'sea', 'wall', 'columns']

/** Procedural shape parameters per silhouette kind (fractions of the element pitch / layer band unless noted). */
export interface SilhouetteShapes {
  /** Peak sharpness exponent. */
  mountains: { sharp: number }
  /** Swell amplitude; glint length range (px). */
  sea: { swell: number; glintPx: Vec2 }
  /** Elements per freq unit, x jitter, height / width ranges; crown centre height and radius (trees). */
  trees: { perFreq: number; jitter: number; height: Vec2; width: Vec2; crownH: number; crownR: number }
  pines: { perFreq: number; jitter: number; height: Vec2; width: Vec2 }
  /** Window grid pitch and size (px). */
  city: { perFreq: number; jitter: number; height: Vec2; width: Vec2; windowPitch: number; windowPx: number }
  /** Tip height as a multiple of the spire width. */
  spires: { perFreq: number; jitter: number; height: Vec2; width: Vec2; tip: number }
  /** Number of mortar lines over the wall height and their offset from the top (px). */
  wall: { lines: number; lineOffset: number }
  /** Shaft width; capital width multiplier and height (fraction of the shaft width). */
  columns: { width: number; capWidth: number; capHeight: number }
  /** Values used when a layer omits amp / freq / lightDensity. */
  layerDefaults: { amp: number; freq: number; lightDensity: number }
}

export interface BackdropCfg {
  radius: number
  height: number
  baseY: number
  /** Cylinder centre z relative to the origin. */
  centerZ: number
  /** Total arc covered (deg); the painting repeats mirrored beyond its natural width. */
  arcDeg: number
  segments: number
  /** Painting v range used [bottom, top] (crops the painted foreground). */
  cropV: Vec2
  tint: Record<TimeOfDay, string>
  indoorTint: string
  fogMix: number
  skyReplace: Record<TimeOfDay, number>
  skyFade: Vec2
  brightness: number
  silhouetteTex: Vec2
  silhouettes: Record<string, SilhouetteLayer[]>
  shapes: SilhouetteShapes
}

export interface PaintOp { terrain?: string; elevation?: number; rect?: Rect; ellipse?: [number, number, number, number]; noise?: number; seed?: number }
export interface GrassDef { terrain: string; density: number; rect: Rect; noise?: number }
export interface PropAt { prop: string; at: Vec2; rot?: 0 | 1 | 2 | 3; scale?: number; variant?: number }
export interface ScatterDef { props: string[]; count: number; rect: Rect; spacing?: number; scale?: Vec2 }
export interface LightAt { at: Vec2; h: number; color: string; intensity: number; radius: number; nightOnly: boolean }

export interface DioramaDef {
  /** Base ground terrain key (defaults to the biome's groundTerrain). */
  ground?: string
  kind?: 'overworld' | 'interior'
  paint: PaintOp[]
  grass: GrassDef[]
  props: PropAt[]
  scatter: ScatterDef[]
  lights?: LightAt[]
  /** Ambient particle kinds (defaults to the biome's ambient list). */
  ambient?: string[]
  /** Silhouette set key when no painted backdrop exists (defaults to the biome id, then "default"). */
  silhouettes?: string
  seed?: number
}

export interface DioramasCfg {
  mapSize: Vec2
  origin: Vec2
  /** Keep-clear radius (tiles) around creature and trainer spots for grass and props. */
  clear: number
  /** Ground terrain key used when neither the layout nor the biome names one. */
  fallbackGround: string
  /** Rects kept free of props (camera sight lines). */
  keepOut: Rect[]
  /** Extra keep-clear padding (tiles) for scattered props. */
  scatterPad: number
  /** Placement attempts per requested scatter prop. */
  scatterTries: number
  /** Value-noise frequency (per tile) used by paint / grass edge jitter. */
  noiseScale: number
  default: DioramaDef
  indoor: DioramaDef
  biomes: Record<string, DioramaDef>
}

export interface WeatherCfg {
  fadeSeconds: number
  tintAmount: number
  particleScale: number
  /** Aurora weather level shown in daylight battles (the overworld aurora is night-only). */
  auroraDay: number
  /** Extra backdrop fog mix at full field weather. */
  backdropFog: number
  /** Time constants elapsed per fadeSeconds (exponential approach). */
  fadeRate: number
  /** Share of tintAmount applied to the sky top / hemisphere sky / painted backdrop (horizon and fog get the full amount). */
  skyTopShare: number
  hemiShare: number
  backdropShare: number
}

/** Per-primitive animation-shape constants (curve breakpoints, internal proportions) used by primitives.ts. */
export interface VfxLook {
  /** Pulse amplitude when a glow step sets `hz`. */
  glow: { pulse: number }
  /** Ring band softness param; lift above the ground for ground rings. */
  ring: { edge: number; groundLift: number }
  /** Core width; share of `dur` spent extending; when it starts thinning; width flicker amount / Hz; tip flare size, falloff and core. */
  beam: { core: number; extend: number; thinFrom: number; flicker: number; flickerHz: number; flare: number; flareFalloff: number; flareCore: number }
  /** Orb falloff / core; vertical share of the target jitter; end shrink; trail spread, velocity, drag and growth. */
  projectile: { falloff: number; core: number; jitterUp: number; shrinkFrom: number; shrinkMin: number; trailSpread: number; trailVel: number; trailDrag: number; trailGrow: number }
  /** Core sharpness; share of `dur` drawing the arc; draw overshoot; roll of alternate slashes (x PI); blade taper and tip width. */
  slash: { core: number; draw: number; overshoot: number; altRoll: number; taper: number; tip: number }
  /** Random alpha flicker share; vertical share of the jitter; minimum segment count. */
  bolt: { flicker: number; upJitter: number; minSegments: number }
  /** Share of `dur` popping in, starting scale, spin (rad/s). */
  shield: { pop: number; popFrom: number; spin: number }
  /** Share of `dur` growing, starting height, final narrowing. */
  column: { grow: number; startH: number; narrow: number }
  /** Ring angle jitter (rad), outer ring radius range, centre spike tilt share, rise share, fall start, fall shrink, min particle scale. */
  spikes: { angleJitter: number; ring: Vec2; centerTilt: number; rise: number; fallFrom: number; fallShrink: number; minScale: number }
  /** Intensity decay exponent after the attack. */
  light: { decayPow: number }
  /** Overlay decay exponent. */
  flash: { decayPow: number }
  /** Blink duty cycle and decay over the blinks. */
  tint: { duty: number; blinkDecay: number }
  /** Out-and-back peak positions (share of `dur`). */
  lunge: { peak: number }
  knock: { peak: number }
  /** Vertical share of the shake, flash level and chance per jump. */
  jitter: { up: number; flash: number; flashChance: number }
  /** Flash ramp speed while shrinking (x per `dur`). */
  vanish: { flashRise: number }
  /** Particle fade in / out as shares of each particle's life. */
  particles: { fadeIn: number; fadeOut: number }
}

export interface VfxCfg {
  pool: { add: number; alpha: number }
  glyphFont: string
  glyphCell: number
  glyphChars: string
  lightMix: number
  darkMix: number
  /** Tint used by hit/miss timelines before any attack set a type color. */
  neutral: string
  shakeScale: number
  lightScale: number
  maxEffects: number
  /** Ceiling of the summed dim amount of overlapping dim steps. */
  dimMax: number
  /** Default step fields per primitive (see PRIMITIVE_FIELDS), merged under every expanded step. */
  defaults: Record<FxPrimitive, VfxStep>
  look: VfxLook
  /** Shared mesh resolution: column radial segments, shield sphere detail, spike cone sides. */
  geometry: { columnSegments: number; sphereDetail: number; coneSides: number }
}

export interface BallCfg {
  radius: number
  /** Sphere width / height segments. */
  segments: Vec2
  /** Paint canvas size (px). */
  texSize: Vec2
  white: string
  band: string
  button: string
  bandWidth: number
  buttonSize: number
  /** Band-colored rim around the button (px). */
  buttonRim: number
  emissive: number
  defaultColor: string
  spin: number
  shadowSize: number
  shadowOpacity: number
  shadowLift: number
  /** Shadow fade per world unit of height, and its minimum scale. */
  shadowFade: number
  shadowMinScale: number
  throwDur: number
  throwArc: number
  hoverH: number
  absorbDur: number
  /** Scale pulse of the ball while absorbing. */
  absorbPulse: number
  dropDur: number
  /** Share of dropDur spent falling before the bounces. */
  fallShare: number
  bounceHeight: number
  /** Height ratio between consecutive bounces. */
  bounceDecay: number
  bounces: number
  preWobble: number
  wobbleDeg: number
  /** Amplitude decay over one wobble. */
  wobbleDecay: number
  wobbleDur: number
  wobblePause: number
  successHold: number
  failDur: number
  sendOutDur: number
  sendOutArc: number
  openH: number
  revealDur: number
  recallDur: number
  dimOnCatch: number
}

export interface EvolveCfg {
  /** Stage-relative spot [x, z] where the evolving creature stands. */
  spot: Vec2
  scale: number
  shot: string
  fadeActors: number
  gather: number
  swapStart: number
  swapEnd: number
  swapCount: number
  swapPulse: number
  silhouetteColor: string
  silhouetteGlow: number
  revealDur: number
  hold: number
  restore: number
  breathPhase: number
}

export interface IntroTimelines { wild: VfxStep[]; trainer: VfxStep[]; pvp: VfxStep[]; legend: VfxStep[] }

export interface Timelines {
  snippets: Record<string, VfxStep[]>
  /** Keyed by MoveAnim. */
  anims: Record<string, VfxStep[]>
  fallbackAnim: string
  hit: { normal: VfxStep[]; super: VfxStep[]; weak: VfxStep[]; immune: VfxStep[]; crit: VfxStep[] }
  miss: VfxStep[]
  faint: VfxStep[]
  status: { default: VfxStep[]; byId: Record<string, VfxStep[]> }
  stat: { up: VfxStep[]; down: VfxStep[] }
  heal: VfxStep[]
  levelUp: VfxStep[]
  shiny: VfxStep[]
  weatherStart: VfxStep[]
  intro: IntroTimelines
  sendOut: { throw: VfxStep[]; open: VfxStep[] }
  recall: VfxStep[]
  catch: { throw: VfxStep[]; absorb: VfxStep[]; land: VfxStep[]; wobble: VfxStep[]; success: VfxStep[]; fail: VfxStep[] }
  evolve: { start: VfxStep[]; swap: VfxStep[]; finish: VfxStep[]; cancel: VfxStep[] }
}

export interface BattleStageContent {
  maxDt: number
  readyTimeoutMs: number
  timeMinutes: Record<TimeOfDay, number>
  slots: [SlotDef, SlotDef]
  sprite: SpriteCfg
  creature: CreatureCfg
  trainer: TrainerCfg
  camera: CameraCfg
  post: PostCfg
  lighting: LightingCfg
  backdrop: BackdropCfg
  dioramas: DioramasCfg
  weather: WeatherCfg
  vfx: VfxCfg
  ball: BallCfg
  evolve: EvolveCfg
  timelines: Timelines
}

export const STAGE: BattleStageContent = stageJson as unknown as BattleStageContent

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const otherSide = (s: SideIndex): SideIndex => (s === 0 ? 1 : 0)

/** Diorama layout for a biome (indoor battles use the indoor layout whatever the biome). */
export function dioramaFor(biome: string, indoor: boolean, s: BattleStageContent = STAGE): DioramaDef {
  if (indoor) return s.dioramas.indoor
  return s.dioramas.biomes[biome] ?? s.dioramas.default
}

/** Shot for a side: pairs are indexed by side, single shots are shared. */
export function shotFor(name: string, side: SideIndex, s: BattleStageContent = STAGE): ShotDef | null {
  const v = s.camera.shots[name]
  if (!v) return null
  return Array.isArray(v) ? v[side] : v
}

/**
 * Expands `use` snippets (recursively, offsetting `t`, inheriting `when`) and keeps the steps whose `when`
 * includes the category (steps without `when` always run). Each result carries its primitive's defaults
 * (`vfx.defaults[fx]`) under its own fields. Returns steps sorted by start time.
 */
export function expandSteps(steps: readonly VfxStep[], category: MoveCategory | null, s: BattleStageContent = STAGE): VfxStep[] {
  return expandRaw(steps, category, s, 0)
    .map((st) => ({ ...(st.fx ? s.vfx.defaults[st.fx] : undefined), ...st }))
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
}

const MAX_SNIPPET_DEPTH = 8

function expandRaw(steps: readonly VfxStep[], category: MoveCategory | null, s: BattleStageContent, depth: number): VfxStep[] {
  const out: VfxStep[] = []
  for (const st of steps) {
    if (st.when && category && !st.when.includes(category)) continue
    if (st.use) {
      const snip = s.timelines.snippets[st.use]
      if (!snip || depth > MAX_SNIPPET_DEPTH) continue
      const base = st.t ?? 0
      for (const x of expandRaw(snip, category, s, depth + 1)) {
        const merged: VfxStep = { ...x, t: base + (x.t ?? 0) }
        // a referencing step may override the snippet's anchor / color
        if (st.on && !x.on) merged.on = st.on
        if (st.color && !x.color) merged.color = st.color
        out.push(merged)
      }
    } else out.push({ ...st, t: st.t ?? 0 })
  }
  return out
}

/** Seconds a single (expanded) step occupies from its start. */
export function stepDuration(st: VfxStep): number {
  const d = st.dur ?? 0
  const stag = (st.stagger ?? 0) * Math.max(0, (st.count ?? 1) - 1)
  switch (st.fx) {
    // a push's return blend runs in the background: callers continue once the hold ends
    case 'camera': return st.mode === 'cut' ? 0 : d + (st.hold ?? 0)
    case 'flash': return (st.ms ?? 0) / 1000
    case 'shake': return (st.ms ?? 0) / 1000
    // particles outlive their step: callers continue once the last one is emitted and the shortest-lived faded
    case 'particles': return Math.max(d, (st.emit ?? 0) + (st.life?.[0] ?? 0))
    case 'projectile': return d + stag
    default: return d + stag
  }
}

/** End time of an expanded timeline. */
export function timelineLength(steps: readonly VfxStep[]): number {
  let end = 0
  for (const st of steps) end = Math.max(end, (st.t ?? 0) + stepDuration(st))
  return end
}

/** Minute of day used for a battle's time-of-day lighting. */
export function minuteFor(tod: TimeOfDay, s: BattleStageContent = STAGE): number {
  return s.timeMinutes[tod] ?? s.timeMinutes.day
}

// ---------------------------------------------------------------------------
// Validation (run by tests/battle-stage.test.ts)
// ---------------------------------------------------------------------------

const COLOR_TOKENS = new Set(['$main', '$light', '$dark', '$white'])
const TODS: readonly TimeOfDay[] = ['dawn', 'day', 'dusk', 'night']
const DIRS: readonly Dir[] = ['down', 'left', 'right', 'up']
const CATEGORIES: readonly MoveCategory[] = ['physical', 'special', 'status']

export function validateBattleStageContent(s: BattleStageContent = STAGE, c: Content = CONTENT, r: RenderContent = RENDER): string[] {
  const errs: string[] = []
  const color = (where: string, v: unknown, tokens = false) => {
    if (tokens && typeof v === 'string' && COLOR_TOKENS.has(v)) return
    if (!isHexColor(v)) errs.push(`${where}: bad color ${JSON.stringify(v)}`)
  }
  const vec = (where: string, v: unknown, n: number) => {
    if (!Array.isArray(v) || v.length !== n || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) errs.push(`${where}: expected ${n} numbers`)
  }

  for (const t of TODS) {
    if (!s.lighting.tod[t]) errs.push(`lighting.tod.${t}: missing`)
    if (typeof s.timeMinutes[t] !== 'number') errs.push(`timeMinutes.${t}: missing`)
    color(`backdrop.tint.${t}`, s.backdrop.tint[t])
    if (typeof s.backdrop.skyReplace[t] !== 'number') errs.push(`backdrop.skyReplace.${t}: missing`)
  }
  color('backdrop.indoorTint', s.backdrop.indoorTint)
  if (s.slots.length !== 2) errs.push('slots: need exactly 2')
  s.slots.forEach((sl, i) => {
    vec(`slots[${i}].creature`, sl.creature, 2)
    vec(`slots[${i}].trainer`, sl.trainer, 2)
    vec(`slots[${i}].ballFrom`, sl.ballFrom, 3)
    if (!DIRS.includes(sl.trainerRow)) errs.push(`slots[${i}].trainerRow: bad dir "${sl.trainerRow}"`)
  })
  color('creature.dissolveEdge', s.creature.dissolveEdge)
  for (const k of ['white', 'band', 'button', 'defaultColor'] as const) color(`ball.${k}`, s.ball[k])
  color('vfx.neutral', s.vfx.neutral)
  color('evolve.silhouetteColor', s.evolve.silhouetteColor)
  if (!s.vfx.glyphChars) errs.push('vfx.glyphChars: empty')

  // camera
  for (const [name, v] of Object.entries(s.camera.shots)) {
    const list = Array.isArray(v) ? v : [v]
    list.forEach((sh, i) => { vec(`camera.shots.${name}[${i}].pos`, sh.pos, 3); vec(`camera.shots.${name}[${i}].look`, sh.look, 3) })
  }
  if (!s.camera.shots.base) errs.push('camera.shots: missing "base"')
  if (!(s.camera.refAspect > 0)) errs.push(`camera.refAspect: must be > 0, got ${s.camera.refAspect}`)
  if (!shotFor(s.evolve.shot, 0, s)) errs.push(`evolve.shot: unknown shot "${s.evolve.shot}"`)

  // backdrop silhouettes
  for (const [k, layers] of Object.entries(s.backdrop.silhouettes)) {
    layers.forEach((l, i) => {
      if (!SILHOUETTE_KINDS.includes(l.kind)) errs.push(`backdrop.silhouettes.${k}[${i}]: bad kind "${l.kind}"`)
      color(`backdrop.silhouettes.${k}[${i}].color`, l.color)
      if (l.lightColor) color(`backdrop.silhouettes.${k}[${i}].lightColor`, l.lightColor)
    })
  }
  if (!s.backdrop.silhouettes.default) errs.push('backdrop.silhouettes: missing "default"')

  // dioramas
  const terrainKey = (where: string, k: string | undefined) => { if (k !== undefined && !c.terrainByKey[k]) errs.push(`${where}: unknown terrain "${k}"`) }
  const checkDiorama = (where: string, d: DioramaDef) => {
    terrainKey(`${where}.ground`, d.ground)
    d.paint.forEach((p, i) => {
      terrainKey(`${where}.paint[${i}]`, p.terrain)
      if (!p.rect && !p.ellipse) errs.push(`${where}.paint[${i}]: needs rect or ellipse`)
    })
    d.grass.forEach((g, i) => {
      terrainKey(`${where}.grass[${i}]`, g.terrain)
      if (!c.terrainByKey[g.terrain]?.tallGrass) errs.push(`${where}.grass[${i}]: "${g.terrain}" is not a tall-grass terrain`)
    })
    d.props.forEach((p, i) => { if (!c.props[p.prop]) errs.push(`${where}.props[${i}]: unknown prop "${p.prop}"`) })
    d.scatter.forEach((sc, i) => sc.props.forEach((p) => { if (!c.props[p]) errs.push(`${where}.scatter[${i}]: unknown prop "${p}"`) }))
    d.lights?.forEach((l, i) => color(`${where}.lights[${i}].color`, l.color))
    d.ambient?.forEach((a) => { if (!r.particles[a]) errs.push(`${where}.ambient: unknown particle kind "${a}"`) })
    if (d.silhouettes && !s.backdrop.silhouettes[d.silhouettes]) errs.push(`${where}.silhouettes: unknown set "${d.silhouettes}"`)
  }
  if (!c.terrainByKey[s.dioramas.fallbackGround]) errs.push(`dioramas.fallbackGround: unknown terrain "${s.dioramas.fallbackGround}"`)
  checkDiorama('dioramas.default', s.dioramas.default)
  checkDiorama('dioramas.indoor', s.dioramas.indoor)
  for (const [k, d] of Object.entries(s.dioramas.biomes)) {
    if (!c.biomeById[k]) errs.push(`dioramas.biomes: unknown biome "${k}"`)
    checkDiorama(`dioramas.biomes.${k}`, d)
  }
  for (const b of c.biomes) {
    for (const a of b.ambient) if (!r.particles[a]) errs.push(`biome ${b.id}: ambient "${a}" has no particle definition`)
  }

  // timelines
  const T = s.timelines
  const checkSteps = (where: string, steps: VfxStep[] | undefined) => {
    if (!Array.isArray(steps)) { errs.push(`${where}: missing timeline`); return }
    steps.forEach((st, i) => {
      const w = `${where}[${i}]`
      if (st.use) { if (!T.snippets[st.use]) errs.push(`${w}: unknown snippet "${st.use}"`); return }
      if (!st.fx || !(FX_PRIMITIVES as readonly string[]).includes(st.fx)) { errs.push(`${w}: unknown fx "${st.fx}"`); return }
      if (st.when) st.when.forEach((x) => { if (!CATEGORIES.includes(x)) errs.push(`${w}: bad category "${x}"`) })
      if (st.on && !(ANCHORS as readonly string[]).includes(st.on)) errs.push(`${w}: bad anchor "${st.on}"`)
      if (st.to && !(ANCHORS as readonly string[]).includes(st.to)) errs.push(`${w}: bad anchor "${st.to}"`)
      if (st.shape && !(VFX_SHAPES as readonly string[]).includes(st.shape)) errs.push(`${w}: bad shape "${st.shape}"`)
      if (st.trail && !(VFX_SHAPES as readonly string[]).includes(st.trail.shape)) errs.push(`${w}.trail: bad shape "${st.trail.shape}"`)
      if (st.color) color(`${w}.color`, st.color, true)
      if (st.color2) color(`${w}.color2`, st.color2, true)
      st.colors?.forEach((x, j) => color(`${w}.colors[${j}]`, x, true))
      if (st.trail?.color) color(`${w}.trail.color`, st.trail.color, true)
      if (st.dir && !(EMIT_DIRS as readonly string[]).includes(st.dir)) errs.push(`${w}: bad dir "${st.dir}"`)
      if (st.orient && !(RING_ORIENTS as readonly string[]).includes(st.orient)) errs.push(`${w}: bad orient "${st.orient}"`)
      if (st.fx === 'camera' && (!st.shot || !s.camera.shots[st.shot])) errs.push(`${w}: unknown shot "${st.shot}"`)
      if (st.fx === 'reveal' && st.mode && !(REVEAL_MODES as readonly string[]).includes(st.mode)) errs.push(`${w}: bad reveal mode "${st.mode}"`)
      if (st.fx === 'vanish' && st.mode && !(VANISH_MODES as readonly string[]).includes(st.mode)) errs.push(`${w}: bad vanish mode "${st.mode}"`)
      if (st.fx === 'tint' && st.mode && !(TINT_MODES as readonly string[]).includes(st.mode)) errs.push(`${w}: bad tint mode "${st.mode}"`)
      if (st.fx === 'dissolve' && st.mode && !(DISSOLVE_MODES as readonly string[]).includes(st.mode)) errs.push(`${w}: bad dissolve mode "${st.mode}"`)
      if (st.shape === 'glyph' && !st.chars) errs.push(`${w}: glyph particles need chars`)
    })
  }
  // primitive defaults: every always-read field has a default, and the defaults themselves are valid steps
  for (const fx of FX_PRIMITIVES) {
    const d = s.vfx.defaults[fx]
    if (!d) { errs.push(`vfx.defaults.${fx}: missing`); continue }
    for (const k of PRIMITIVE_FIELDS[fx]) if (d[k] === undefined) errs.push(`vfx.defaults.${fx}.${k}: missing`)
    checkSteps(`vfx.defaults.${fx}`, [{ ...d, fx }])
  }
  for (const [k, v] of Object.entries(T.snippets)) checkSteps(`timelines.snippets.${k}`, v)
  for (const [k, v] of Object.entries(T.anims)) checkSteps(`timelines.anims.${k}`, v)
  if (!T.anims[T.fallbackAnim]) errs.push(`timelines.fallbackAnim: unknown anim "${T.fallbackAnim}"`)
  for (const m of c.moveList) if (!T.anims[m.anim]) errs.push(`move ${m.id}: anim "${m.anim}" has no battle timeline`)
  for (const k of ['normal', 'super', 'weak', 'immune', 'crit'] as const) checkSteps(`timelines.hit.${k}`, T.hit[k])
  checkSteps('timelines.miss', T.miss)
  checkSteps('timelines.faint', T.faint)
  checkSteps('timelines.status.default', T.status.default)
  for (const [k, v] of Object.entries(T.status.byId)) {
    if (!c.statusById[k]) errs.push(`timelines.status.byId: unknown status "${k}"`)
    checkSteps(`timelines.status.byId.${k}`, v)
  }
  checkSteps('timelines.stat.up', T.stat.up)
  checkSteps('timelines.stat.down', T.stat.down)
  checkSteps('timelines.heal', T.heal)
  checkSteps('timelines.levelUp', T.levelUp)
  checkSteps('timelines.shiny', T.shiny)
  checkSteps('timelines.weatherStart', T.weatherStart)
  for (const k of ['wild', 'trainer', 'pvp', 'legend'] as const) checkSteps(`timelines.intro.${k}`, T.intro[k])
  checkSteps('timelines.sendOut.throw', T.sendOut.throw)
  checkSteps('timelines.sendOut.open', T.sendOut.open)
  checkSteps('timelines.recall', T.recall)
  for (const k of ['throw', 'absorb', 'land', 'wobble', 'success', 'fail'] as const) checkSteps(`timelines.catch.${k}`, T.catch[k])
  for (const k of ['start', 'swap', 'finish', 'cancel'] as const) checkSteps(`timelines.evolve.${k}`, T.evolve[k])
  return errs
}
