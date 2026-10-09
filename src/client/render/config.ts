// Typed access to content/render.json (every visual tunable of the HD-2D renderer) plus pure helpers
// over it: time-of-day sampling, sun path, prop style lookup and validation. No three.js here so the
// helpers run in node tests.
import renderJson from '../../../content/render.json' with { type: 'json' }
import { CONTENT, type Content } from '../../shared/content/index.ts'
import type { GameMap, Settings } from '../../shared/types.ts'
import type { GovernorConfig } from './governor.ts'
import { validatePhysics, type FootstepsConfig, type ImpactKind, type LeavesConfig, type PhysicsConfig, type ReflectionsConfig, type SnowCoverConfig, type WaterFxConfig } from './physics-config.ts'

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
export type QualityId = Settings['quality']

export interface QualityPreset {
  shadows: boolean
  shadowMapScale: number
  shadowRadius: number
  /** Shadow map redraws per second while nothing moved (0 = every frame); casters are static, only tree sway changes. */
  shadowHz: number
  /** The shadow frustum centre snaps to this many shadow texels, so walking redraws the map less often (1 = every texel). */
  shadowSnapTexels: number
  dof: boolean
  dofSamples: number
  bloom: boolean
  grassPerTile: number
  particleScale: number
  pointLights: number
  /** Chunks/blocks farther than this (world units) from the focus are hidden. */
  viewRadius: number
  propShadows: boolean
  waterSparkles: boolean
  glowSprites: boolean
  /** Procedural mesh variants generated per nature prop (the GLB, when present, is one more variant). */
  natureVariants: number
  /** Ground-decor density multiplier (0 = off). */
  decorDensity: number
  /** Soft fringes where a higher-priority terrain meets a lower one. */
  terrainFringe: boolean
  /** Snow dusting on prop / terrain tops from the climate snow field. */
  snowDust: boolean
  /** LRU cap of built terrain chunks (memory bound). */
  maxChunks: number
}

export interface PostConfig {
  focusRange: number
  focusFalloff: number
  tiltShift: number
  tiltBand: number
  bokehScale: number
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  vignette: number
  vignetteSoftness: number
  saturation: number
  contrast: number
  contrastPivot: number
  warmth: number
  warmthScale: number
  exposure: number
  toneMapping: 'neutral' | 'aces' | 'agx' | 'none'
  lift: Vec3
  gain: Vec3
  /** Split toning (LightingState.shadowTint / highlightTint / split): luminance window over which shadows blend into highlights. */
  split: { lo: number; hi: number }
  minScale: number
  flash: { color: string; ms: number; strength: number }
  shake: { frequency: number; rollDeg: number }
  transition: {
    fadeColor: string; swirlPortion: number; swirlTurns: number; shardCells: number; shardSpin: number
    shardStagger: number; battleFlash: number; irisSoftPx: number; irisMaxRadius: number
  }
}

export interface CameraRenderConfig {
  near: number; far: number; edgeMargin: number; zoomDamping: number; lookAheadDamping: number
  /** Damping while the focus slows down (stops): faster than lookAheadDamping so the lead does not outlive the walk. */
  lookAheadReleaseDamping: number
  /** Speed (tiles/s) at which the full config.camera.lookAhead lead applies; slower movement leads proportionally less. */
  lookAheadFullSpeed: number
  lookAheadMinSpeed: number; interiorMargin: number; snapDistance: number
  /** Furthest the focus may sit from the screen centre (fraction of the half height up / down, half width sideways), overriding map-edge clamping. */
  focusSafe: { north: number; south: number; side: number }
  /** Pose of overworld actor sprites against the camera pitch. */
  billboard: BillboardConfig
}

/**
 * HD-2D sprite pose: `lean` = fraction of the camera pitch the card tilts back around its feet (1 = parallel to the
 * view plane), `compensate` = fraction of the remaining foreshortening undone by stretching (1 = art proportions).
 */
export interface BillboardConfig { lean: number; compensate: number }

export interface SunConfig {
  distance: number; shadowExtent: number; shadowNear: number; shadowFar: number; bias: number; normalBias: number
  /** Squared distance between the unit sun directions of two shadow map draws that forces a new draw. */
  shadowDirEpsilon: number
  sunrise: number; sunset: number; switchFadeMinutes: number; switchFloor: number
  minElevationDeg: number; maxElevationDeg: number; azimuthRiseDeg: number; azimuthSetDeg: number
  /** The light acts as the moon between sunset and sunrise: it climbs from moonMinElevationDeg to moonMaxElevationDeg
   * and back while its azimuth sweeps moonAzimuthRiseDeg -> moonAzimuthSetDeg, so night shadows keep moving. */
  moonMinElevationDeg: number; moonMaxElevationDeg: number; moonAzimuthRiseDeg: number; moonAzimuthSetDeg: number
  /** Shadow frustum half-extent grows with camera distance by this factor. */
  extentPerDistance: number
}

/** One lighting look. Color fields are '#rrggbb' (sRGB); everything else is a scalar. */
export interface LightingState {
  skyTop: string; skyHorizon: string; skyBottom: string
  sun: string; sunIntensity: number
  hemiSky: string; hemiGround: string; hemiIntensity: number
  fog: string; fogNear: number; fogFar: number
  exposure: number; saturation: number; contrast: number; warmth: number
  bloomStrength: number; vignette: number
  /** 0..1 how much night-only lights / emissive windows are on. */
  lamps: number
  stars: number
  /** Split toning: '#rrggbb' tints (their hue only: normalised to the same luminance, so #808080 is neutral) for shadows and highlights, blended by `split` (0..1). */
  shadowTint: string; highlightTint: string; split: number
  /** Sprite-only ambient fill (so characters stay readable at night) and rim light strength (0..1). */
  spriteFill: string; spriteFillIntensity: number; rim: number
  /** 0..1 strength of cloud shadows and of light shafts at this time of day. */
  cloud: number; shaft: number
}
export interface LightingKey extends LightingState { minute: number }
export interface StaticLighting extends LightingState { sunElevationDeg: number; sunAzimuthDeg: number; ambient: string[] }

export type SurfaceKind = 'none' | 'water' | 'lava' | 'glossy' | 'wall'
export interface SurfaceDef {
  kind: SurfaceKind
  /** Texture key drawn under a liquid surface. */
  bed?: string
  /** Liquid depth below the tile top (world units). */
  depth?: number
  /** 0 = shallow look, 1 = deep look. */
  deep?: number
  /** Wall height (world units) and the height used when the wall would hide the room from the camera. */
  height?: number
  cutawayHeight?: number
  /** Side-face texture key; "$cliff" = the biome's cliff texture. Defaults to the terrain's own texture. */
  face?: string
  /** Wall top texture key (defaults to the terrain's own) and tint multiplier (defaults to terrain.wallTopColor). */
  top?: string
  topColor?: string
}

export type MapKind = GameMap['kind']
/** Per-tile UV variation: none = plain tiling, mirror = alternate flips (for non-tileable art), flip = hashed random flips. */
export type UvMode = 'none' | 'mirror' | 'flip'
export const UV_MODES: readonly UvMode[] = ['none', 'mirror', 'flip']

export interface TerrainRenderConfig {
  atlasCell: number; atlasPad: number
  uvVariation: { default: UvMode; keys: Record<string, UvMode> }
  tintVariation: number; tintScale: number; aoStrength: number; cliffBottomShade: number; cliffTopLight: number
  skirtDepth: number; presetSkirtDepth: number; liquidDrop: number; stairSteps: number; stairsInset: number; wallTopColor: string
  defaultCliff: string; fallbackColor: string
  /** Surface used for liquid terrain without an explicit entry in surfaces. */
  defaultLiquid: SurfaceDef
  glossy: { shininess: number; specular: string }
  surfaces: Record<string, SurfaceDef>
  /** Surface overrides per map kind (e.g. cave walls drawn as rock instead of masonry). */
  mapKindSurfaces: Partial<Record<MapKind, Record<string, SurfaceDef>>>
  /** Per terrain key: RGB vertex-colour multipliers reached at full strength of a climate field; `base` applies
   * everywhere (albedo correction, e.g. keeps bright snow from clipping at noon). */
  fieldTint: Record<string, Partial<Record<FieldName | 'base', Vec3>>>
  /** One-way ledge tiles (TerrainDef.ledge): overhanging lip on the drop edge (world units) and per-key face texture. */
  ledge: LedgeRenderConfig
}

export interface LedgeRenderConfig {
  /** How far the lip overhangs the drop, how far it rises above the tile top, its front height and colour multiplier. */
  lipOut: number; lipRaise: number; lipHeight: number; lipShade: number
  /** Drop-face texture per ledge terrain key (defaults to the biome cliff). */
  faces: Record<string, string>
  /** Top texture per ledge key when no flat neighbour at its level shows the ground it belongs to. */
  tops: Record<string, string>
}

/** Waterfall sheets where water drops to lower water. */
export interface FallsConfig {
  body: string; streak: string
  /** Scroll speed (world units / s), streak columns per tile, share of streak pixels (0..1). */
  speed: number; streaks: number; streakAmount: number
  /** Foam bands (world units) at the crest and at the splash, sheet alpha. */
  crestBand: number; splashBand: number; alpha: number
  /** Sheet offset in front of the bed's cliff face, how far it dips into the pool and rises above the crest. */
  offset: number; overlap: number; crest: number
}

export interface WaterConfig {
  deep: string; mid: string; shallow: string; foam: string; sparkle: string
  sparkleIntensity: number; sparkleDensity: number; alphaDeep: number; alphaShallow: number
  pixelsPerTile: number; waveSpeed: number; waveScale: number; waveHeight: number
  foamWidth: number; foamSpeed: number; foamNoise: number; lightMin: number
  /** Pixel ripples: noise frequency per tile, scroll speed, trough/crest thresholds (0..1) and their strength. */
  rippleScale: number; rippleSpeed: number; troughLevel: number; troughShade: number; crestLevel: number; crestAmount: number
  falls: FallsConfig
  /** Actor / rain rings and washing foam (render.json water.interact). */
  interact: WaterFxConfig
}
export interface LavaConfig {
  hot: string; mid: string; crust: string; emissive: number; pixelsPerTile: number
  flowSpeed: number; crustAmount: number; pulseSpeed: number
}
export interface WindConfig {
  dir: Vec2; strength: number; speed: number; gust: number; swayHeight: number
  /** Extra downwind lean of swaying geometry at full gust, in units of `strength`. */
  gustLean: number
  /** Gust fronts travelling along `dir`: wavelength (tiles), front speed (tiles/s), peak sharpness (power), front
   * warp (rad), calm floor of the slow strength envelope and its rate (rad/s) and spatial phase (rad/tile). */
  field: { wavelength: number; speed: number; sharp: number; warp: number; calm: number; envelopeRate: number; envelopeSpace: number }
  /** Particle / leaf drift: base air speed (tiles/s at strength 1) and how far gusts modulate it (0..1). */
  drift: { base: number; gust: number }
}
export interface GrassConfig {
  height: number; width: number; planes: number; jitter: number; colorJitter: number; scaleJitter: number
  bendRadius: number; bendStrength: number; sway: number; texSize: number; blades: number
  rootShade: number; tipLight: number; maxBenders: number; alphaTest: number; bendSink: number; bendCore: number
  /** Lingering bend: grid cells per tile, window size (tiles) around the focus, seconds until a trampled cell is back
   * up (to ~5 %), actors stamped per frame, fade of the window edge (tiles); strength / sink / darken = tip push (tuft
   * heights), flatten and crushed-blade darkening of trampled tufts; decor = bend / flatten of ground sprigs. */
  trample: { cellsPerTile: number; window: number; recoverSec: number; maxBenders: number; edgeFade: number; strength: number; sink: number; darken: number; decor: { strength: number; sink: number } }
  /** Tall-grass keys drawn with the asset store's tuft texture (placeholder art included) instead of blades derived
   * from the ground texture's average colour. */
  assetTufts?: string[]
}
export interface LightsConfig {
  pointIntensity: number; decay: number; distanceMul: number; glowSize: number; glowIntensity: number
  reassignSeconds: number; fadeSpeed: number
  emissiveNight: number; emissiveDay: number; emissiveAlways: number; frontOffset: number
  /** Light field (overworld, quality tiers with lighting.quality.<tier>.fieldLights > 0): up to `max` world-space lights
   * evaluated in the lit materials' shaders instead of PointLights. Colour * intensity * `intensity` is the radiance
   * scale (sun-light units); `radiusMul` x a source's radius is its reach; `falloff` is the exponent of (1 - d/r);
   * `wrap` blends Lambert toward half-Lambert (0..1) so pools light up faces turned away from the lamp. */
  field: {
    max: number; intensity: number; radiusMul: number; falloff: number; wrap: number; selectRadius: number; reassignSeconds: number; fadeSpeed: number
    /** Night-only lamps follow lamps^lampsPower (they come on late and go off early); other lights keep `dayShare` by day. */
    lampsPower: number; dayShare: number
    /** Fraction of the reach inside which the falloff stays flat (no hot spot at the source). */
    core: number
    /** Surfaces that glow by themselves (lit windows) take 1 / (1 + emissive * selfLit) of the field light: they never clip. */
    selfLit: number
    /** Intensity multiplier per light kind (prop key): lights hung right in front of a facade would blow it out. */
    kindScale: Record<string, number>
  }
  /** Flicker per light kind (prop key, or "map" for map.lights); `default` for the rest. Amount = fraction of the intensity. */
  flicker: Record<string, { amount: number; speed: number }>
  /** Lights for props that have none in props.json (lit windows spill light on the street): same shape as PropLight. */
  windowLights: Record<string, { color: string; intensity: number; radius: number; h: number; nightOnly: boolean }>
}

export interface WeatherGrade {
  exposure?: number; saturation?: number; contrast?: number; warmth?: number
  fogNear?: number; fogFar?: number; sun?: number; hemi?: number; lamps?: number
  bloomStrength?: number; tint?: string; tintAmount?: number; vignette?: number
  /** Multipliers on the time-of-day cloud-shadow / light-shaft / sprite-rim / split-tone strength; `wet` = ground wetness 0..1. */
  cloud?: number; shaft?: number; rim?: number; split?: number; wet?: number
}
export interface WeatherRenderDef {
  particles: string[]; grade: WeatherGrade; wind?: number; aurora?: boolean
  /** Multiplier on biome ambient particles at full weather (fireflies hide from the rain). */
  ambientScale?: number
}
export interface AuroraConfig {
  colors: string[]; intensity: number; speed: number; bands: number; height: number; alpha: number
  distance: number; nightOnly: boolean
}

export type ParticleShape = 'dot' | 'streak' | 'hstreak' | 'ring' | 'soft' | 'leaf' | 'star'
export const PARTICLE_SHAPES: readonly ParticleShape[] = ['dot', 'streak', 'hstreak', 'ring', 'soft', 'leaf', 'star']
export interface ParticleKindDef {
  count: number
  /** Simulation box size around the focus (x, height, z). */
  box: Vec3
  /** Height range above the ground. */
  y: Vec2
  color?: string
  colors?: string[]
  alpha: number
  /** Point size in internal pixels (or world units when worldSize). */
  size: number
  shape: ParticleShape
  velocity: Vec3
  swirl: number
  swirlSpeed: number
  /** Color multiplier (> bloom threshold glows). */
  glow: number
  twinkle: number
  time: 'any' | 'day' | 'night'
  /** Lifetime for ring-shaped (respawning) particles. */
  life?: number
  windFactor: number
  worldSize?: boolean
}

/** Per actor kind: player, other characters, creatures. */
export interface ActorKinds<T> { player: T; npc: T; remote: T; creature: T; companion: T }
export interface ActorsConfig {
  height: number; width: number; alphaTest: number; walkFps: number; runFps: number
  /** Tall grass hides the body up to this fraction of `height` above the soles (eased in/out over grassCutMs;
   * a hop lifts the body out of it). */
  grassCut: number; grassCutMs: number
  /** Empty texel rows under the soles in every sheet cell (of config.sprites.sheetCell): the card pivot sits on the soles. */
  footInset: number
  /** Two cards on the same row share a depth: renderOrder draws the higher kind later and depthBias (world units
   * away from the camera, negative = toward it) settles what is left of the per-band depth error, so the player is
   * never painted over by a follower or NPC standing level with it. The companion (the player's follower) draws
   * just before the player and writes no depth, so the player always paints over it. cardSegments = horizontal
   * bands per card. */
  renderOrder: ActorKinds<number>
  depthBias: ActorKinds<number>
  cardSegments: number
  normalTilt: number; hop: { height: number; ms: number }
  bubbleMs: number; remoteAlpha: number; nameColor: string
  /** One footstep per `stride` tiles, with two footsteps per complete cycle. Rates are specified for the
   * legacy four-pose cycle and scaled to the loaded walk-pose count. Jumps >= teleportTiles are ignored. */
  walkCycle: { stride: { walk: number; run: number }; maxFps: number; teleportTiles: number }
  /** Chibi motion on top of the sheet (which already bakes a 1-texel step bob): extra step bounce (world units,
   * x runBounceMul when running) and squash per walk step (stepsPerCycle steps per sheet cycle), idle breathing
   * (scale amplitude, Hz). A hop stretches the card up by hopStretch at launch and touch-down (0 at the apex); the
   * landing is a damped spring of landSquash amplitude over landMs: landCycles oscillations, decay landDamp (e-folds
   * per landMs). snapTexels rounds every scale to whole sheet texels so the pixel art never re-samples a fraction
   * of a row (shimmer). */
  motion: {
    stepBounce: number; runBounceMul: number; stepSquash: number; stepsPerCycle: number
    breathe: number; breatheHz: number; hopStretch: number
    landSquash: number; landMs: number; landCycles: number; landDamp: number; snapTexels: boolean
  }
}
export interface CreaturesConfig {
  height: number; alphaTest: number
  /** Source creature art faces left (setFacingLeft(true) shows it unflipped). */
  artFacesLeft: boolean
  /** Empty texel rows under the feet in the creature art (of config.sprites.creatureSize). */
  footInset: number
  /** A requested mirror flip must persist this long before it shows (no flicker on corner-slip nudges). */
  flipHoldMs: number
  /** Coverage kept (0..1) where a creature stands between the camera and the player (render.json occlusion
   * ellipse, screen-door dither); 1 = never dithered. */
  occlusionKeep: number
  bob: { amp: number; hz: number; squash: number }
  /** Hopping gait: one hop per hopStride tiles travelled (minHz..maxHz); a stop finishes the current hop;
   * bob and hop cross-fade over blendMs. */
  move: { hopHeight: number; hopStride: number; minHz: number; maxHz: number; blendMs: number }
  shiny: { hue: number; saturation: number; sparkles: number; sparkleColor: string; sparkleGlow: number; sparkleSize: number; twinkleSpeed: number }
  aura: { radius: number; intensity: number; pulseHz: number; motes: number; moteHeight: number; ringInner: number; moteSpeed: number; moteSize: number }
}
export interface OverlayStyle {
  tagFontPx: number; tagPadding: string; tagBackground: string; tagRadiusPx: number; tagTextShadow: string
  /** A name tag lying over another actor's sprite fades to dimOpacity over dimMs so the actor stays readable. */
  tagDimOpacity: number; tagDimMs: number
  bubbleFontPx: number; bubblePadding: string; bubbleText: string; bubbleBackground: string; bubbleBorder: string
  bubbleBorderPx: number; bubbleRadiusPx: number; bubbleShadow: string; bubbleMaxWidthPx: number; bubbleTailPx: number; popMs: number
}
/** coverHalfWidth: half the width of an actor's on-screen sprite as a fraction of its head-to-foot height (tag overlap test). */
export interface OverlayConfig { nameOffsetPx: number; bubbleOffsetPx: number; maxDistance: number; coverHalfWidth: number; style: OverlayStyle }
export interface GroundItemsConfig { color: string; radius: number; glow: number; bobAmp: number; bobHz: number; height: number; glowSize: number }

export interface FxIcon { type: 'icon'; glyph: string; color: string; outline: string; size: number; y: number; rise: number; life: number; pop: number }
export interface FxBurst {
  type: 'burst'; count: number; colors: string[]; speed: Vec2; up: Vec2; gravity: number; life: Vec2; size: Vec2
  glow: number; shape: ParticleShape; y: number; radius: number; drag: number
}
export interface FxRing { type: 'ring'; color: string; radius: Vec2; life: number; intensity: number; width: number; y: number }
export interface FxColumn { type: 'column'; color: string; radius: number; height: number; life: number; intensity: number }
export type FxEmitter = FxIcon | FxBurst | FxRing | FxColumn
export interface FxConfig { poolSize: number; iconFont: string; iconTexSize: number; kinds: Record<string, FxEmitter[]> }

export type PartShape = 'box' | 'cylinder' | 'cone' | 'pyramid' | 'sphere' | 'dome' | 'prism' | 'plane' | 'torus' | 'rock'
export const PART_SHAPES: readonly PartShape[] = ['box', 'cylinder', 'cone', 'pyramid', 'sphere', 'dome', 'prism', 'plane', 'torus', 'rock']

/**
 * A primitive of a procedural prop. Coordinates are normalised to the prop: x in footprint widths, z in
 * footprint depths (+z = facade), y in prop heights. `pos` is the bottom-centre anchor of the part.
 */
export interface PartDef {
  shape: PartShape
  pos: Vec3
  size: Vec3
  /** Degrees, applied X then Y then Z around the anchor (or the part centre when pivot = 'center'). */
  rot?: Vec3
  pivot?: 'base' | 'center'
  /** Which world axis the shape's own height axis is laid along (for parts rotated onto their side). */
  lengthAxis?: 'x' | 'y' | 'z'
  /** '#rrggbb' or '$paletteName'. */
  color: string
  color2?: string
  colors?: string[]
  pattern?: string
  emissive?: number
  emissiveColor?: string
  emissiveMap?: boolean
  foliage?: boolean
  glossy?: boolean
  cutout?: boolean
  opacity?: number
  segments?: number
  /** Top/bottom ratio for cylinders, cones-with-tops and boxes. */
  taper?: number
  /** Prism ridge axis: 'x' gable along x, 'z' gable along z, 'y' upright wedge pointing +z. */
  ridge?: 'x' | 'y' | 'z'
  repeat?: { count: number; step: Vec3 }
  /** Emissive regardless of time of day (otherwise follows the prop light: night-only lights glow at night). */
  alwaysOn?: boolean
}

interface StyleCommon {
  randomYaw?: boolean
  scaleJitter?: number
  tintJitter?: number
  palette?: Record<string, string>
  variants?: Record<string, string>[]
  /** Emissive weight of GLB 'EMIT_*' materials for this prop (defaults to props.modelEmissive). */
  modelEmissive?: number
}
export interface PartsStyle extends StyleCommon { builder: 'parts'; parts: PartDef[] }
export interface BillboardStyle extends StyleCommon {
  builder: 'billboard'; planes: number; pattern: string; color: string; colors?: string[]; width: number
}
export interface HouseStyle extends StyleCommon {
  builder: 'house'
  roof: 'gable' | 'hip' | 'flat'
  wallHeight: number
  overhang: number
  inset: number
  wallPattern: string
  roofPattern: string
  basePattern: string
  palette: Record<string, string>
  windows: { rows: number; perSide: number; w: number; h: number; y: number; alwaysOn?: boolean }
  chimney?: { x: number; z: number; w: number; h: number } | null
  sign?: { w: number; h: number; emissive: number; pattern: string } | null
  awning?: { color: string; color2: string; depth: number; y: number }
  doorWidth?: number
  doorHeight?: number
  doorEmissive?: number
  extraParts?: PartDef[]
}
export type PropStyle = PartsStyle | BillboardStyle | HouseStyle

export interface HouseBuilderConfig {
  plinth: number; cornerTrim: number; band: number; bandOut: number; ridgeCap: Vec2; eave: number; flatSlab: number
  parapet: Vec2; doorFrame: Vec3; doorDepth: number; doorStep: Vec3; doorWidth: number; doorHeight: number
  windowFrame: number; windowDepth: number; sill: Vec3; signGap: number; signDepth: number; chimneyRoofShare: number
  awningTilt: number; awningThickness: number; gableFill: number
}

export interface PropsRenderConfig {
  instanceBlock: number
  patternSize: number
  patternUnits: number
  /** Default emissive weight of GLB 'EMIT_*' materials (procedural parts carry their own weight). */
  modelEmissive: number
  defaultTintJitter: number
  foliageAlphaTest: number
  /** How far foliage normals bend toward "outward from the canopy centre" (0..1). */
  foliageNormalBlend: number
  rock: { jitter: number; floor: number }
  /** Construction dimensions (world units) of the parametric house builder. */
  house: HouseBuilderConfig
  patterns: { noiseAmount: number }
  default: PropStyle
  styles: Record<string, PropStyle>
}

// ---------------------------------------------------------------------------
// Large-map streaming, climate fields, terrain fringes, ground decor, procedural nature
// ---------------------------------------------------------------------------

export interface StreamingConfig {
  /** Per-frame chunk-building budget (ms). */
  budgetMs: number
  /** Budget while chunks inside the camera frustum are still missing (after a load or teleport). */
  catchUpBudgetMs: number
  /** Built chunks farther than viewRadius + keepMargin are evicted immediately; within it only by the LRU cap. */
  keepMargin: number
  /** Max chunk disposals per frame. */
  disposePerFrame: number
  /** Radius (world units) around the spawn built synchronously by loadMap, besides the camera frustum. */
  prefillRadius: number
  /** Chunks ahead of the focus movement are prioritised: distance bonus per unit of speed (world units). */
  moveLookAhead: number
  /** Priority penalty (world units) for chunks outside the camera frustum. */
  offscreenPenalty: number
  /** Height (world units) added above the top terrain level for chunk bounds (frustum tests). */
  boundsHeight: number
  /** Show a finished chunk only once its shader programs are linked (WebGLRenderer.compileAsync, parallel compile),
   * or after compileTimeoutMs. */
  compileAsync: boolean
  compileTimeoutMs: number
  /** Infinite overworld (GameMap.infinite) streaming. */
  infinite: InfiniteStreamingConfig
}

export interface InfiniteStreamingConfig {
  /** Tiles around a render chunk whose world chunks must exist before it builds (AO, cliffs, shores, decor rules,
   * prop footprints and lights read that far). */
  ensureMargin: number
  /** World-chunk prefetch ring: radius (tiles) beyond the view, max generations per frame and their budget (ms);
   * only runs in frames where no visible chunk is waiting. */
  prefetchMargin: number
  prefetchPerFrame: number
  prefetchBudgetMs: number
  /** Every retainSeconds: decoded blocks beyond viewRadius + blockMargin and provider chunks beyond providerRadius
   * (tiles from the focus) are dropped. */
  retainSeconds: number
  blockMargin: number
  providerRadius: number
  /** Toroidal heightmap (particles) and climate texture windows: texels per side (heights: tiles; climate: cells).
   * Both must cover the streamed diameter ((viewRadius + keepMargin) * 2 + 2 chunks). */
  heightWindow: number
  climateWindow: number
  /** Elevation level assumed for not-yet-built chunks in frustum tests. */
  assumedTopLevel: number
  /** Preload every prop model of the content up front (frontier props are not known at load time). */
  preloadAllModels: boolean
}

export type FieldName = 'dry' | 'lush' | 'autumn' | 'blossom' | 'snow'
export const FIELD_NAMES: readonly FieldName[] = ['dry', 'lush', 'autumn', 'blossom', 'snow']

/** Fractal noise spec (feature size `scale` in tiles) remapped by smoothstep(lo, hi). */
export interface FieldNoise { scale: number; octaves: number; gain?: number; lacunarity?: number; salt?: number; lo: number; hi: number }

export interface FieldBiome {
  /** Added to the dryness noise (-1..1). */
  dry?: number
  /** Multipliers of the autumn / blossom patch fields. */
  autumn?: number
  blossom?: number
  /** Base snow cover (0..1) and snow-line override (elevation level). */
  snow?: number
  snowLine?: number
}

export interface FieldsConfig {
  /** Tiles per field cell (CPU grid and GPU texture texel). */
  cell: number
  dry: FieldNoise
  autumn: FieldNoise
  blossom: FieldNoise
  /** Snow: cover rises from snowLine - band to snowLine (elevation levels), jittered by noise. */
  snow: { line: number; band: number; noise: FieldNoise; noiseAmount: number }
  biomes: Record<string, FieldBiome>
  /** Snow dusting shader: colour, overall amount, normal.y smoothstep range, dither pixels per tile, clump noise
   * frequency (per tile) and how much the clumps (vs per-pixel hash) decide coverage (0..1). */
  dust: { color: string; amount: number; slope: Vec2; pixels: number; clump: number; clumpMix: number }
}

export interface FringeConfig {
  /** Fringe band width (tiles) laid over the lower-priority neighbour. */
  width: number
  /** Height above the tile top (world units). */
  lift: number
  /** Mask texture size [along, across] in pixels per tile / band. */
  mask: Vec2
  /** Jaggedness of the fringe edge (0..1) and stray-speck density. */
  jag: number
  specks: number
  alphaTest: number
  /** Terrain keys taking part in blending; a higher number spreads over lower neighbours at the same height. */
  priorities: Record<string, number>
}

export type DecorShape = 'sprig' | 'blossom' | 'pebble' | 'leaf' | 'twig' | 'shell' | 'shroom' | 'mound' | 'ember' | 'puddle' | 'bone' | 'shard'
export const DECOR_SHAPES: readonly DecorShape[] = ['sprig', 'blossom', 'pebble', 'leaf', 'twig', 'shell', 'shroom', 'mound', 'ember', 'puddle', 'bone', 'shard']

export interface DecorKind {
  shape: DecorShape
  /** Uniform scale range (world units of the unit shape). */
  size: Vec2
  /** sRGB instance colours; "$terrain" = the terrain texture average (times terrainShade). */
  colors: string[]
  terrainShade?: number
  colorJitter?: number
  pattern?: string
  emissive?: number
  glossy?: boolean
  sway?: boolean
  /** Shape variants generated (different seeds). */
  variants?: number
}

export interface DecorRule {
  kind: string
  terrain: string[]
  biomes?: string[]
  /** Expected instances per tile at decorDensity 1. */
  density: number
  /** Density multiplier from fractal noise. */
  noise?: FieldNoise
  /** Density multiplier from a climate field: smoothstep(lo, hi, field). */
  field?: { name: FieldName; lo: number; hi: number }
  /** Density multiplier 1 - smoothstep(lo, hi, field): suppressed where the field is high (no leaves on snow). */
  unless?: { name: FieldName; lo: number; hi: number }
  /** Only on tiles within `near` tiles of a terrain key in this list (e.g. shells near water). */
  near?: { terrain: string[]; dist: number }
}

export interface DecorConfig { kinds: Record<string, DecorKind>; rules: DecorRule[]; maxPerTile: number; margin: number; lift: number }

/** Material of a procedural nature part (resolved into a prop MaterialSpec). */
export interface NatureMaterial {
  pattern: string
  color: string
  color2?: string
  colors?: string[]
  emissive?: number
  emissiveColor?: string
  emissiveMap?: boolean
  glossy?: boolean
  cutout?: boolean
}

export type NatureGen = 'broadleaf' | 'conifer' | 'palm' | 'deadtree' | 'bush' | 'rock' | 'crystal' | 'cactus' | 'mushroom' | 'stump' | 'log' | 'cards'
export const NATURE_GENS: readonly NatureGen[] = ['broadleaf', 'conifer', 'palm', 'deadtree', 'bush', 'rock', 'crystal', 'cactus', 'mushroom', 'stump', 'log', 'cards']

export interface TintFieldRule {
  field: FieldName
  /** Target colour(s) (sRGB); one is picked per instance. */
  colors: string[]
  /** Weight multiplier and smoothstep window over the field value (jittered per instance by `spread`). */
  amount?: number
  lo?: number
  hi?: number
  spread?: number
}

/** Per-instance colour for a part role: ratio of a target colour to `base` (so textured parts keep their shading). */
export interface TintDef { base: string; jitter?: number; hueJitter?: number; fields?: TintFieldRule[] }

export interface NatureInstance {
  /** Uniform scale range, extra independent xz / y jitter (fractions), max lean (deg), sink into the ground (world units). */
  scale: Vec2
  scaleXZ: number
  scaleY: number
  lean: number
  sink?: number
}

export interface NatureProp {
  gen: NatureGen
  /** Generator parameters (world units; shapes per generator, see world/nature.ts). */
  params: Record<string, unknown>
  /** Weight of the GLB variant relative to one procedural variant (0 = never use the GLB). */
  glbWeight?: number
  instance: NatureInstance
  tints?: Record<string, TintDef>
}

export interface NatureConfig {
  /** GLB material-name prefix -> part role (FOLIAGE -> foliage ...). */
  roles: Record<string, string>
  /** Default per-instance brightness jitter for roles without a tint. */
  jitter: number
  /** Normal blend toward "outward from the cluster centre" for foliage (soft, rounded light). */
  foliageNormalBlend: number
  props: Record<string, NatureProp>
  /** Per-biome recolour of nature parts by tint role (frontier biomes reuse the base models: bamboo = tall reeds,
   * neon foliage in the neural woods ...): `colors` = sRGB targets (needs the prop's tints[role].base), else `mul` =
   * RGB multipliers; one entry is picked per instance and blended by `amount`. */
  biomeTints?: Record<string, Record<string, { colors?: string[]; mul?: Vec3[]; amount?: number }>>
  /** Per-biome re-modelling of a nature prop: biome -> prop key -> full recipe used for placements inside that biome
   * (acacia oaks on the savanna, bamboo culms for bamboo-grove reeds, coral for lagoon rocks, neon glitch shards ...). */
  biomeVariants?: Record<string, Record<string, NatureProp>>
}

/** Camera-occlusion cutaway around the player (world/occlusion.ts). */
export interface OcclusionConfig {
  enabled: boolean
  /** Height of the ellipse centre above the player's feet (world units). */
  lift: number
  /** Half extents across the view ray (camera right, camera up), world units. */
  radius: Vec2
  /** Soft edge as a fraction of the radius, and coverage kept at the centre (0 = fully cut away). */
  soft: number
  keep: number
  /** Only surfaces at least `near` world units closer to the camera than the player are cut, fading in over `fade`. */
  near: number
  fade: number
}

/** Per quality tier switches of the lighting effects added on top of the base renderer; `low` keeps the old look. */
export interface LightingTier {
  /** Light-field lights (0 = off: the overworld falls back to the quality.pointLights PointLight pool). */
  fieldLights: number
  cloudShadows: boolean
  /** Light shaft billboards (0 = off). */
  shafts: number
  spriteRim: boolean
  /** Sprites sample the sun shadow map under their feet. */
  spriteShadow: boolean
  /** Sprites also cast the soft silhouette shadow (the contact ellipse is always on). */
  spriteCast: boolean
  wetGround: boolean
  splitTone: boolean
}

export interface LightingConfig {
  quality: Record<QualityId, LightingTier>
  /** Cloud shadows: a tileable noise map scrolled along the wind dims the sun's direct light. `scale` = world units per
   * texture repeat, `speed` = world units / s (x wind multiplier), `coverage` / `softness` = noise threshold and edge width,
   * `strength` = how much of the sun a cloud takes (0..1), `ambient` = how much of the sky light it takes. `drift` = slow
   * swing of the coverage over `driftSeconds` (some stretches are cloudier). */
  cloud: {
    size: number; octaves: number; scale: number; speed: number; coverage: number; softness: number; strength: number
    ambient: number; drift: number; driftSeconds: number; detail: number; detailScale: number; pixels: number
  }
  /** Light shafts through tree canopies. */
  shafts: {
    /** Tree props whose placements anchor shafts, the share of them that gets one, jitter around the trunk (tiles). */
    props: string[]; density: number; jitter: number
    /** Per anchor-chunk cap, how far around the focus shafts show / fade out, and the reselection period (s). */
    perChunk: number; radius: number; fade: number; reselectSeconds: number
    /** Beam width range (world units), longest beam, base brightness, fade fractions at the canopy end and at the ground. */
    width: Vec2; maxLength: number; intensity: number; tipFade: number; footFade: number
    shimmer: number; shimmerSpeed: number; dust: number
    /** Share of the strength kept while the light is the moon, the light elevation under which beams fade out and the
     * steepest-floor elevation the beam geometry is drawn at (stylised: low suns would otherwise lay the beam flat). */
    moon: number; minElevationDeg: number; steepDeg: number
  }
  sprite: {
    /** Rim light thickness in internal pixels, strength, how far the sun side wraps, night fill share of the moon colour. */
    rimPixels: number; rimStrength: number; rimMin: number
    /** Soles shadow lookup: blur radius (world units), lift above the soles, nudge toward the light, share of the sun taken. */
    shadowRadius: number; shadowLift: number; shadowOffset: number; shadowStrength: number
  }
  /** Wet ground: albedo darkening, sky sheen strength, its fresnel power and head-on reflectance, puddle noise scale (1 / world
   * units), coverage and edge softness, how much of the sky colour puddles reflect and the sheen share left on props. */
  wet: { darken: number; sheen: number; sheenPower: number; sheenBase: number; propSheen: number; puddleScale: number; puddleCoverage: number; puddleSoftness: number; reflect: number }
}

/** Character / creature shadows (sprite-shadow.ts). */
export interface SpriteShadowConfig {
  color: string
  /** Lift above the rendered terrain (world units), polygon offset against it and how often a resting sprite re-reads the ground (s). */
  ground: { lift: number; offsetFactor: number; offsetUnits: number; refreshSeconds: number }
  /** Contact ellipse: size (world units) and strength at the soles, radial `core` (flat share) and falloff `power`,
   * how the soles are measured from the lowest `footRows` opaque rows (`footFollow` = share of the sideways offset
   * followed, `spanMul` x measured foot span, kept within `minSpan`..`maxSpan`; `width` / `depth` give the nominal size and
   * aspect; `forward` moves it toward the camera so more of it shows around the legs), shrink / fade per world unit the body is lifted (stopping at `minScale` / `minOpacity`) and the grid vertices
   * per side that hug the ground. */
  contact: {
    width: number; depth: number; opacity: number; core: number; power: number
    footRows: number; footFollow: number; spanMul: number; minSpan: number; maxSpan: number; forward: number
    liftShrink: number; minScale: number; liftFade: number; minOpacity: number; grid: number
  }
  /** Cast silhouette: strength, shadow length per unit height (`lengthMul` x cot(elevation), at most `maxSlope`), width,
   * fade toward the tip, blur radius (sprite texels) at the soles and at the head, share of the cloud shadow that removes it. */
  cast: { opacity: number; lengthMul: number; maxSlope: number; widthMul: number; tailFade: number; blurNear: number; blurFar: number; cloud: number }
  /** Light intensity range mapped to 0..1 cast strength, share kept under the moon and indoors. */
  light: { min: number; full: number; moon: number; indoor: number }
}

export interface SkyConfig { domeRadius: number; starDensity: number; starColor: string; starIntensity: number; twinkleSpeed: number }

/** What the frame-time governor may change at one step (the keys are applied on top of the tier's preset). */
export interface GovernorStep extends Partial<Pick<QualityPreset, 'shadowHz' | 'dof' | 'bloom' | 'dofSamples' | 'particleScale'>> {
  about?: string
  /** Extra integer steps of internal pixel size (fewer pixels to fill). */
  scaleBias?: number
}

export interface RenderContent {
  quality: Record<QualityId, QualityPreset>
  /** Touch devices (coarse pointer): the tier a new save starts on and the internal height floor (crisp pixels cost little there). */
  device: { touchDefaultQuality: QualityId; touchMinInternalHeight: number }
  governor: GovernorConfig & { steps: GovernorStep[] }
  post: PostConfig
  camera: CameraRenderConfig
  sun: SunConfig
  timeOfDay: LightingKey[]
  interior: StaticLighting
  cave: StaticLighting
  sky: SkyConfig
  lighting: LightingConfig
  spriteShadow: SpriteShadowConfig
  terrain: TerrainRenderConfig
  water: WaterConfig
  lava: LavaConfig
  wind: WindConfig
  grass: GrassConfig
  /** World physics feedback (footsteps, leaves, rain splashes, reflections, quality tiers). */
  physics: PhysicsConfig
  footsteps: FootstepsConfig
  leaves: LeavesConfig
  /** Splashes where the drops of a particle field (rain, snow) land, keyed by the field's kind. */
  impacts: Record<string, ImpactKind>
  snowCover: SnowCoverConfig
  reflections: ReflectionsConfig
  lights: LightsConfig
  weather: Record<string, WeatherRenderDef>
  weatherFadeSeconds: number
  aurora: AuroraConfig
  particles: Record<string, ParticleKindDef>
  /** Particle kinds whose glow exceeds this blend additively. */
  particleAdditiveGlow: number
  ambientFadeSeconds: number
  actors: ActorsConfig
  creatures: CreaturesConfig
  overlay: OverlayConfig
  groundItems: GroundItemsConfig
  fx: FxConfig
  props: PropsRenderConfig
  streaming: StreamingConfig
  fields: FieldsConfig
  fringe: FringeConfig
  decor: DecorConfig
  nature: NatureConfig
  occlusion: OcclusionConfig
}

export const RENDER: RenderContent = renderJson as unknown as RenderContent

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/

export function isHexColor(s: unknown): s is string { return typeof s === 'string' && HEX.test(s) }

/** '#rrggbb' -> sRGB components 0..1. Invalid input yields magenta so mistakes are visible. */
export function hexToRgb(hex: string): Vec3 {
  if (!HEX.test(hex)) return [1, 0, 1]
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function rgbToHex(c: Vec3): string {
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`
}

export function lerpHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a), y = hexToRgb(b)
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}

/** Resolves '$name' palette references (with variant overrides) to a hex color. */
export function resolveColor(ref: string, palette: Record<string, string> | undefined): string {
  if (!ref.startsWith('$')) return ref
  const v = palette?.[ref.slice(1)]
  return v && isHexColor(v) ? v : '#ff00ff'
}

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

const MINUTES_PER_DAY = 1440
const wrapMinute = (m: number) => ((m % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY

/** Interpolates two lighting states field by field (colors in sRGB space). */
export function lerpLighting<T extends LightingState>(a: T, b: LightingState, t: number, out: LightingState = { ...a }): LightingState {
  for (const k of Object.keys(b) as (keyof LightingState)[]) {
    const va = a[k], vb = b[k]
    if (typeof va === 'number' && typeof vb === 'number') (out[k] as number) = va + (vb - va) * t
    else if (typeof va === 'string' && typeof vb === 'string') (out[k] as string) = lerpHex(va, vb, t)
  }
  return out
}

/** Lighting look at a minute of day, interpolated between the (wrapping) keys of render.json. */
export function sampleLighting(minute: number, keys: LightingKey[] = RENDER.timeOfDay): LightingState {
  const m = wrapMinute(minute)
  const n = keys.length
  if (n === 1) return { ...keys[0] }
  let i = n - 1
  for (let k = 0; k < n; k++) if (keys[k].minute <= m) i = k
  const a = keys[i]
  const b = keys[(i + 1) % n]
  const start = a.minute
  let end = b.minute
  let cur = m
  if (end <= start) end += MINUTES_PER_DAY
  if (cur < start) cur += MINUTES_PER_DAY
  const t = end > start ? (cur - start) / (end - start) : 0
  const out = lerpLighting(a, b, Math.min(1, Math.max(0, t)))
  delete (out as Partial<LightingKey>).minute
  return out
}

export interface SunState {
  /** Unit direction from the scene toward the light. */
  dir: Vec3
  /** True when the directional light acts as the moon. */
  moon: boolean
  /** 0..1 intensity factor that dips around sunrise/sunset to hide the sun/moon swap. */
  fade: number
}

const circDist = (a: number, b: number) => { const d = Math.abs(wrapMinute(a) - wrapMinute(b)); return Math.min(d, MINUTES_PER_DAY - d) }

export function dirFromAngles(elevationDeg: number, azimuthDeg: number): Vec3 {
  const el = elevationDeg * Math.PI / 180, az = azimuthDeg * Math.PI / 180
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]
}

export function sunState(minute: number, s: SunConfig = RENDER.sun): SunState {
  const m = wrapMinute(minute)
  const day = s.sunrise <= s.sunset ? m >= s.sunrise && m < s.sunset : m >= s.sunrise || m < s.sunset
  const fadeDist = Math.min(circDist(m, s.sunrise), circDist(m, s.sunset))
  const fade = s.switchFadeMinutes > 0 ? Math.min(1, Math.max(s.switchFloor, fadeDist / s.switchFadeMinutes)) : 1
  if (!day) {
    const night = wrapMinute(s.sunrise - s.sunset) || MINUTES_PER_DAY
    const mt = wrapMinute(m - s.sunset) / night
    const mel = s.moonMinElevationDeg + (s.moonMaxElevationDeg - s.moonMinElevationDeg) * Math.sin(Math.PI * mt)
    return { dir: dirFromAngles(mel, s.moonAzimuthRiseDeg + (s.moonAzimuthSetDeg - s.moonAzimuthRiseDeg) * mt), moon: true, fade }
  }
  const span = wrapMinute(s.sunset - s.sunrise) || MINUTES_PER_DAY
  const t = wrapMinute(m - s.sunrise) / span
  const el = s.minElevationDeg + (s.maxElevationDeg - s.minElevationDeg) * Math.sin(Math.PI * t)
  const az = s.azimuthRiseDeg + (s.azimuthSetDeg - s.azimuthRiseDeg) * t
  return { dir: dirFromAngles(el, az), moon: false, fade }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** The tier a save starts on for this device (coarse pointers get the lighter one). */
export function defaultQualityFor(coarsePointer: boolean, fallback: QualityId, r: RenderContent = RENDER): QualityId {
  return coarsePointer ? r.device.touchDefaultQuality : fallback
}

/** `preset` with the governor steps 1..level layered on top; level 0 returns the preset itself. Reads through to `preset` so live tuning still shows. */
export function governedPreset(preset: QualityPreset, level: number, r: RenderContent = RENDER): QualityPreset {
  if (level <= 0) return preset
  const out = Object.create(preset) as QualityPreset
  for (const step of r.governor.steps.slice(0, level)) {
    const { about: _about, scaleBias: _scaleBias, ...keys } = step
    Object.assign(out, keys)
  }
  return out
}

/** Sum of the scaleBias of steps 1..level. */
export function governedScaleBias(level: number, r: RenderContent = RENDER): number {
  let bias = 0
  for (const step of r.governor.steps.slice(0, Math.max(0, level))) bias += step.scaleBias ?? 0
  return bias
}

export function qualityPreset(q: QualityId, r: RenderContent = RENDER): QualityPreset {
  return r.quality[q] ?? r.quality.high
}

/** Lighting-effect switches of a quality tier (render.json lighting.quality). */
export function lightingTier(q: QualityId, r: RenderContent = RENDER): LightingTier {
  return r.lighting.quality[q] ?? r.lighting.quality.high
}

/** Procedural fallback style for a prop key (render.json styles, else the generic default). */
export function propStyle(key: string, r: RenderContent = RENDER): PropStyle {
  return r.props.styles[key] ?? r.props.default
}

export function surfaceOf(terrainKey: string, mapKind?: MapKind, r: RenderContent = RENDER): SurfaceDef | null {
  return (mapKind && r.terrain.mapKindSurfaces[mapKind]?.[terrainKey]) || r.terrain.surfaces[terrainKey] || null
}

export function uvModeOf(textureKey: string, r: RenderContent = RENDER): UvMode {
  return r.terrain.uvVariation.keys[textureKey] ?? r.terrain.uvVariation.default
}

/** Merges a variant's palette overrides over a style palette. */
export function stylePalette(style: PropStyle, variant: number): Record<string, string> {
  const base = style.palette ?? {}
  const vs = style.variants ?? []
  if (!vs.length || variant <= 0) return base
  return { ...base, ...vs[(variant - 1) % vs.length] }
}

/** Number of palette variants a style offers (variant 0 = base palette). */
export function styleVariantCount(style: PropStyle): number {
  return 1 + (style.variants?.length ?? 0)
}

// ---------------------------------------------------------------------------
// Validation (run by tests/render.test.ts)
// ---------------------------------------------------------------------------

export function validateRenderContent(r: RenderContent = RENDER, c: Content = CONTENT): string[] {
  const errs: string[] = []
  const color = (where: string, v: unknown, palette?: Record<string, string>) => {
    if (typeof v === 'string' && v.startsWith('$')) {
      if (palette && !(v.slice(1) in palette)) errs.push(`${where}: unknown palette color "${v}"`)
      return
    }
    if (!isHexColor(v)) errs.push(`${where}: bad color ${JSON.stringify(v)}`)
  }
  for (const q of Object.keys(c.config.render.internalHeight)) if (!r.quality[q as QualityId]) errs.push(`quality: missing preset "${q}"`)
  for (const k of ['north', 'south', 'side'] as const) {
    const v = r.camera.focusSafe?.[k]
    if (!(typeof v === 'number' && v >= 0 && v < 1)) errs.push(`camera.focusSafe.${k}: must be a screen fraction in 0..1`)
  }
  for (const k of ['lean', 'compensate'] as const) {
    const v = r.camera.billboard?.[k]
    if (!(typeof v === 'number' && v >= 0 && v <= 1)) errs.push(`camera.billboard.${k}: must be a number in 0..1`)
  }
  if (!(c.config.camera.pitchDeg > 0 && c.config.camera.pitchDeg <= 60)) errs.push('config.camera.pitchDeg: billboard pose supports 0 < pitch <= 60')
  if (!(r.camera.lookAheadReleaseDamping > 0)) errs.push('camera.lookAheadReleaseDamping: must be > 0')
  if (!(r.camera.lookAheadFullSpeed > r.camera.lookAheadMinSpeed)) errs.push('camera.lookAheadFullSpeed: must be > lookAheadMinSpeed')
  {
    const A = r.actors, C = r.creatures, nonNeg = (where: string, v: unknown) => { if (!(typeof v === 'number' && v >= 0)) errs.push(`${where}: must be a number >= 0`) }
    if (!(A.grassCut >= 0 && A.grassCut < 1)) errs.push('actors.grassCut: must be a fraction of the height in 0..1')
    nonNeg('actors.grassCutMs', A.grassCutMs)
    if (!(A.footInset >= 0 && A.footInset < c.config.sprites.sheetCell / 2)) errs.push('actors.footInset: texels in 0..sheetCell/2')
    for (const k of ['player', 'npc', 'remote', 'creature', 'companion'] as const) {
      if (!Number.isInteger(A.renderOrder?.[k])) errs.push(`actors.renderOrder.${k}: must be an integer`)
      if (!(typeof A.depthBias?.[k] === 'number' && Math.abs(A.depthBias[k]) < 0.1)) errs.push(`actors.depthBias.${k}: world units, |bias| < 0.1 (more sinks feet into the ground)`)
    }
    if (!(Number.isInteger(A.cardSegments) && A.cardSegments >= 1 && A.cardSegments <= 16)) errs.push('actors.cardSegments: integer 1..16')
    for (const k of ['stepBounce', 'runBounceMul', 'stepSquash', 'breathe', 'breatheHz', 'hopStretch', 'landSquash', 'landMs', 'landCycles', 'landDamp'] as const) nonNeg(`actors.motion.${k}`, A.motion[k])
    if (!(A.motion.stepsPerCycle >= 1)) errs.push('actors.motion.stepsPerCycle: must be >= 1')
    if (typeof A.motion.snapTexels !== 'boolean') errs.push('actors.motion.snapTexels: must be a boolean')
    if (!(A.walkCycle.stride.walk > 0 && A.walkCycle.stride.run > 0 && A.walkCycle.maxFps > 0)) errs.push('actors.walkCycle: stride and maxFps must be > 0')
    if (!(C.footInset >= 0 && C.footInset < c.config.sprites.creatureSize / 2)) errs.push('creatures.footInset: texels in 0..creatureSize/2')
    nonNeg('creatures.flipHoldMs', C.flipHoldMs)
    if (!(C.occlusionKeep >= 0 && C.occlusionKeep <= 1)) errs.push('creatures.occlusionKeep: must be in 0..1')
    const M = C.move
    if (!(M.hopStride > 0)) errs.push('creatures.move.hopStride: must be > 0')
    if (!(M.minHz > 0 && M.maxHz >= M.minHz)) errs.push('creatures.move: need 0 < minHz <= maxHz')
    nonNeg('creatures.move.hopHeight', M.hopHeight)
    nonNeg('creatures.move.blendMs', M.blendMs)
  }
  const keys = r.timeOfDay
  if (!keys.length) errs.push('timeOfDay: needs at least one key')
  keys.forEach((k, i) => {
    if (k.minute < 0 || k.minute >= MINUTES_PER_DAY) errs.push(`timeOfDay[${i}]: minute out of range`)
    if (i > 0 && keys[i - 1].minute >= k.minute) errs.push(`timeOfDay[${i}]: minutes must increase`)
    for (const f of ['skyTop', 'skyHorizon', 'skyBottom', 'sun', 'hemiSky', 'hemiGround', 'fog', 'shadowTint', 'highlightTint', 'spriteFill'] as const) color(`timeOfDay[${i}].${f}`, k[f])
    for (const f of ['split', 'cloud', 'shaft', 'rim', 'spriteFillIntensity'] as const) if (!(typeof k[f] === 'number' && k[f] >= 0)) errs.push(`timeOfDay[${i}].${f}: must be a number >= 0`)
  })
  for (const [name, s] of [['interior', r.interior], ['cave', r.cave]] as const) {
    for (const a of s.ambient) if (!r.particles[a]) errs.push(`${name}.ambient: unknown particle kind "${a}"`)
    for (const f of ['shadowTint', 'highlightTint', 'spriteFill'] as const) color(`${name}.${f}`, s[f])
    for (const f of ['split', 'cloud', 'shaft', 'rim', 'spriteFillIntensity'] as const) if (!(typeof s[f] === 'number' && s[f] >= 0)) errs.push(`${name}.${f}: must be a number >= 0`)
  }
  {
    const F = r.lights.field
    for (const k of ['max', 'intensity', 'radiusMul', 'falloff', 'wrap', 'selectRadius', 'reassignSeconds', 'fadeSpeed', 'lampsPower', 'dayShare', 'core', 'selfLit'] as const) if (!(typeof F?.[k] === 'number' && F[k] >= 0)) errs.push(`lights.field.${k}: must be a number >= 0`)
    if (!(F.max >= 1 && F.max <= 32)) errs.push('lights.field.max: 1..32 (uniform array size)')
    for (const [k, v] of Object.entries(F.kindScale ?? {})) if (!(v >= 0)) errs.push(`lights.field.kindScale.${k}: must be a number >= 0`)
    if (!(F.wrap >= 0 && F.wrap <= 1)) errs.push('lights.field.wrap: 0..1')
    if (!r.lights.flicker?.default) errs.push('lights.flicker: needs a "default" entry')
    for (const [k, f] of Object.entries(r.lights.flicker ?? {})) if (!(f.amount >= 0 && f.speed >= 0)) errs.push(`lights.flicker.${k}: amount and speed must be >= 0`)
    for (const [k, l] of Object.entries(r.lights.windowLights ?? {})) {
      if (!c.props[k]) errs.push(`lights.windowLights: unknown prop "${k}"`)
      color(`lights.windowLights.${k}.color`, l.color)
      for (const f of ['intensity', 'radius', 'h'] as const) if (!(typeof l[f] === 'number' && l[f] >= 0)) errs.push(`lights.windowLights.${k}.${f}: must be a number >= 0`)
    }
    const Lq = r.lighting.quality
    for (const q of Object.keys(r.quality)) if (!Lq[q as QualityId]) errs.push(`lighting.quality: missing tier "${q}"`)
    for (const [q, t] of Object.entries(Lq)) {
      if (!(Number.isInteger(t.fieldLights) && t.fieldLights >= 0 && t.fieldLights <= F.max)) errs.push(`lighting.quality.${q}.fieldLights: integer 0..lights.field.max`)
      if (!(Number.isInteger(t.shafts) && t.shafts >= 0)) errs.push(`lighting.quality.${q}.shafts: integer >= 0`)
      for (const k of ['cloudShadows', 'spriteRim', 'spriteShadow', 'spriteCast', 'wetGround', 'splitTone'] as const) if (typeof t[k] !== 'boolean') errs.push(`lighting.quality.${q}.${k}: must be a boolean`)
    }
    const low = Lq.low
    if (low && (low.fieldLights || low.shafts || low.cloudShadows || low.spriteRim || low.spriteShadow || low.spriteCast || low.wetGround || low.splitTone)) errs.push('lighting.quality.low: new lighting effects must be off at the lowest tier')
    for (const k of r.lighting.shafts.props) if (!r.nature.props[k]) errs.push(`lighting.shafts.props: "${k}" is not a nature prop`)
    const Cl = r.lighting.cloud
    if (!(Cl.size >= 16 && Cl.size <= 512)) errs.push('lighting.cloud.size: 16..512')
    if (!(Cl.softness > 0)) errs.push('lighting.cloud.softness: must be > 0')
    if (!(r.lighting.shafts.width[0] > 0 && r.lighting.shafts.width[1] >= r.lighting.shafts.width[0])) errs.push('lighting.shafts.width: [min, max] > 0')
  }
  {
    const S = r.spriteShadow
    color('spriteShadow.color', S?.color)
    const num = (where: string, v: unknown, lo: number, hi = Infinity) => { if (!(typeof v === 'number' && v >= lo && v <= hi)) errs.push(`spriteShadow.${where}: must be a number in ${lo}..${hi}`) }
    num('ground.lift', S.ground?.lift, 0, 0.2)
    num('ground.refreshSeconds', S.ground?.refreshSeconds, 0.05)
    for (const k of ['width', 'depth', 'core', 'power', 'footRows', 'footFollow', 'spanMul', 'minSpan', 'maxSpan', 'forward', 'liftShrink', 'liftFade'] as const) num(`contact.${k}`, S.contact?.[k], 0)
    for (const k of ['opacity', 'minScale', 'minOpacity'] as const) num(`contact.${k}`, S.contact?.[k], 0, 1)
    if (!(S.contact?.width > 0 && S.contact?.depth > 0)) errs.push('spriteShadow.contact: width and depth must be > 0')
    if (!(S.contact?.core < 1)) errs.push('spriteShadow.contact.core: must be < 1')
    if (!(S.contact?.maxSpan >= S.contact?.minSpan)) errs.push('spriteShadow.contact: maxSpan must be >= minSpan')
    if (!(Number.isInteger(S.contact?.grid) && S.contact.grid >= 2 && S.contact.grid <= 8)) errs.push('spriteShadow.contact.grid: integer 2..8')
    if (!(Number.isInteger(S.contact?.footRows) && S.contact.footRows >= 1)) errs.push('spriteShadow.contact.footRows: integer >= 1')
    for (const k of ['opacity', 'tailFade', 'cloud'] as const) num(`cast.${k}`, S.cast?.[k], 0, 1)
    for (const k of ['lengthMul', 'maxSlope', 'widthMul', 'blurNear', 'blurFar'] as const) num(`cast.${k}`, S.cast?.[k], 0)
    if (!(S.cast?.maxSlope > 0 && S.cast?.widthMul > 0)) errs.push('spriteShadow.cast: maxSlope and widthMul must be > 0')
    for (const k of ['min', 'full'] as const) num(`light.${k}`, S.light?.[k], 0)
    for (const k of ['moon', 'indoor'] as const) num(`light.${k}`, S.light?.[k], 0, 1)
    if (!(S.light?.full > S.light?.min)) errs.push('spriteShadow.light: full must be above min')
  }
  const textureKeys = new Set([...c.terrain.map((t) => t.key), ...c.biomes.map((b) => b.cliff), r.terrain.defaultCliff])
  const checkSurfaces = (where: string, list: Record<string, SurfaceDef>) => {
    for (const [key, s] of Object.entries(list)) {
      if (!c.terrainByKey[key]) errs.push(`${where}: unknown terrain key "${key}"`)
      if (s.bed && !c.terrainByKey[s.bed]) errs.push(`${where}.${key}: unknown bed terrain "${s.bed}"`)
      if (s.face && s.face !== '$cliff' && !textureKeys.has(s.face)) errs.push(`${where}.${key}: unknown face texture "${s.face}"`)
      if (s.topColor) color(`${where}.${key}.topColor`, s.topColor)
      if (s.top && !textureKeys.has(s.top)) errs.push(`${where}.${key}: unknown top texture "${s.top}"`)
      if (!['none', 'water', 'lava', 'glossy', 'wall'].includes(s.kind)) errs.push(`${where}.${key}: bad kind "${s.kind}"`)
    }
  }
  checkSurfaces('terrain.surfaces', r.terrain.surfaces)
  for (const [kind, list] of Object.entries(r.terrain.mapKindSurfaces)) {
    if (!['overworld', 'interior', 'cave'].includes(kind)) errs.push(`terrain.mapKindSurfaces: unknown map kind "${kind}"`)
    checkSurfaces(`terrain.mapKindSurfaces.${kind}`, list ?? {})
  }
  const uv = r.terrain.uvVariation
  if (!UV_MODES.includes(uv.default)) errs.push(`terrain.uvVariation.default: bad mode "${uv.default}"`)
  for (const [k, m] of Object.entries(uv.keys)) {
    if (!textureKeys.has(k)) errs.push(`terrain.uvVariation.keys: unknown texture key "${k}"`)
    if (!UV_MODES.includes(m)) errs.push(`terrain.uvVariation.keys.${k}: bad mode "${m}"`)
  }
  for (const b of c.biomes) for (const a of b.ambient) if (!r.particles[a]) errs.push(`biome ${b.id}: ambient "${a}" has no particle definition`)
  if (!r.weather.clear) errs.push('weather: missing "clear"')
  for (const w of c.weathers) if (w.fieldWeather && !r.weather[w.fieldWeather]) errs.push(`weather: no render definition for field weather "${w.fieldWeather}"`)
  for (const [k, w] of Object.entries(r.weather)) {
    for (const p of w.particles) if (!r.particles[p]) errs.push(`weather.${k}: unknown particle kind "${p}"`)
    if (w.grade.tint) color(`weather.${k}.grade.tint`, w.grade.tint)
    for (const f of ['cloud', 'shaft', 'rim', 'split', 'wet'] as const) if (w.grade[f] !== undefined && !(w.grade[f]! >= 0)) errs.push(`weather.${k}.grade.${f}: must be a number >= 0`)
  }
  for (const [k, p] of Object.entries(r.particles)) {
    if (!PARTICLE_SHAPES.includes(p.shape)) errs.push(`particles.${k}: bad shape "${p.shape}"`)
    if (!p.color && !p.colors?.length) errs.push(`particles.${k}: needs color or colors`)
    if (p.color) color(`particles.${k}.color`, p.color)
    p.colors?.forEach((x, i) => color(`particles.${k}.colors[${i}]`, x))
  }
  for (const [k, list] of Object.entries(r.fx.kinds)) {
    list.forEach((e, i) => {
      const w = `fx.${k}[${i}]`
      if (e.type === 'burst') { if (!PARTICLE_SHAPES.includes(e.shape)) errs.push(`${w}: bad shape`); e.colors.forEach((x) => color(w, x)) }
      else if (e.type === 'icon') { color(w, e.color); color(w, e.outline); if (!e.glyph) errs.push(`${w}: empty glyph`) }
      else if (e.type === 'ring' || e.type === 'column') color(w, e.color)
      else errs.push(`${w}: unknown emitter type`)
    })
  }
  const checkParts = (where: string, parts: PartDef[], palette?: Record<string, string>) => {
    parts.forEach((p, i) => {
      const w = `${where}.parts[${i}]`
      if (!PART_SHAPES.includes(p.shape)) errs.push(`${w}: bad shape "${p.shape}"`)
      if (!Array.isArray(p.pos) || p.pos.length !== 3) errs.push(`${w}: pos must be [x,y,z]`)
      if (!Array.isArray(p.size) || p.size.length !== 3) errs.push(`${w}: size must be [x,y,z]`)
      color(w, p.color, palette)
      if (p.color2) color(w, p.color2, palette)
      if (p.emissiveColor) color(w, p.emissiveColor, palette)
    })
  }
  const checkStyle = (where: string, s: PropStyle) => {
    const pal = { ...(s.palette ?? {}) }
    for (const v of s.variants ?? []) for (const [k, x] of Object.entries(v)) { color(`${where}.variants.${k}`, x); if (!(k in pal)) errs.push(`${where}.variants: "${k}" not in palette`) }
    for (const [k, x] of Object.entries(pal)) color(`${where}.palette.${k}`, x)
    if (s.builder === 'parts') checkParts(where, s.parts, pal)
    else if (s.builder === 'house') {
      for (const need of ['wall', 'roof', 'trim', 'window', 'glow', 'frame', 'door', 'base']) if (!(need in pal)) errs.push(`${where}: palette needs "${need}"`)
      if (s.sign && !('sign' in pal)) errs.push(`${where}: sign needs palette "sign"`)
      if (s.extraParts) checkParts(where, s.extraParts, pal)
    } else if (s.builder === 'billboard') { color(where, s.color); s.colors?.forEach((x) => color(where, x)) }
    else errs.push(`${where}: unknown builder`)
  }
  const G = r.governor
  if (typeof G.storageKey !== 'string' || !G.storageKey) errs.push('governor.storageKey: missing string')
  for (const k of ['windowFrames', 'skipAboveMs', 'downAboveMs', 'downWorkMs', 'hardAboveMs', 'upBelowMs', 'upBelowWorkMs', 'downWindows', 'upWindows', 'cooldownSeconds', 'upLockSeconds'] as const) {
    if (typeof G[k] !== 'number' || !(G[k] >= 0)) errs.push(`governor.${k}: missing non-negative number`)
  }
  if (G.upBelowMs >= G.downAboveMs) errs.push('governor: upBelowMs must stay under downAboveMs (else the level would flap)')
  if (G.windowFrames < 1 || G.downWindows < 1 || G.upWindows < 1) errs.push('governor: windowFrames / downWindows / upWindows must be >= 1')
  if (!Array.isArray(G.steps)) errs.push('governor.steps: missing list')
  const stepKeys = new Set(['about', 'shadowHz', 'dof', 'bloom', 'dofSamples', 'particleScale', 'scaleBias'])
  for (const [i, step] of (G.steps ?? []).entries()) for (const k of Object.keys(step)) if (!stepKeys.has(k)) errs.push(`governor.steps[${i}]: unknown key "${k}"`)
  if (!r.quality[r.device.touchDefaultQuality]) errs.push(`device.touchDefaultQuality "${r.device.touchDefaultQuality}" is not a quality tier`)
  if (!(r.device.touchMinInternalHeight > 0)) errs.push('device.touchMinInternalHeight must be positive')
  // quality presets: new large-map knobs
  for (const [id, q] of Object.entries(r.quality)) {
    for (const k of ['natureVariants', 'decorDensity', 'maxChunks', 'shadowHz', 'shadowSnapTexels'] as const) if (typeof q[k] !== 'number') errs.push(`quality.${id}.${k}: missing number`)
    if (q.shadowHz < 0 || q.shadowSnapTexels < 1) errs.push(`quality.${id}: shadowHz must be >= 0 and shadowSnapTexels >= 1`)
    for (const k of ['terrainFringe', 'snowDust'] as const) if (typeof q[k] !== 'boolean') errs.push(`quality.${id}.${k}: missing boolean`)
    const reach = q.viewRadius + c.config.world.chunk * 0.75
    const wanted = Math.PI * reach * reach / (c.config.world.chunk * c.config.world.chunk)
    if (q.maxChunks < wanted) errs.push(`quality.${id}.maxChunks ${q.maxChunks} < ~${Math.ceil(wanted)} chunks inside viewRadius`)
  }
  // climate fields / terrain tints
  const biomeIds = new Set(c.biomes.map((b) => b.id))
  for (const b of Object.keys(r.fields.biomes)) if (!biomeIds.has(b)) errs.push(`fields.biomes: unknown biome "${b}"`)
  color('fields.dust.color', r.fields.dust.color)
  for (const k of ['amount', 'pixels', 'clump', 'clumpMix'] as const) if (typeof r.fields.dust[k] !== 'number') errs.push(`fields.dust.${k}: missing number`)
  for (const [k, ft] of Object.entries(r.terrain.fieldTint)) {
    if (!c.terrainByKey[k]) errs.push(`terrain.fieldTint: unknown terrain "${k}"`)
    for (const f of Object.keys(ft)) if (f !== 'base' && !FIELD_NAMES.includes(f as FieldName)) errs.push(`terrain.fieldTint.${k}: unknown field "${f}"`)
  }
  for (const k of Object.keys(r.fringe.priorities)) if (!c.terrainByKey[k]) errs.push(`fringe.priorities: unknown terrain "${k}"`)
  for (const b of c.biomes) if (!r.fields.biomes[b.id]) errs.push(`fields.biomes: no climate entry for biome "${b.id}"`)
  for (const k of r.grass.assetTufts ?? []) if (!c.terrainByKey[k]?.tallGrass) errs.push(`grass.assetTufts: "${k}" is not a tall-grass terrain`)
  const L = r.terrain.ledge
  if (!L) errs.push('terrain.ledge: missing')
  else {
    for (const k of ['lipOut', 'lipRaise', 'lipHeight', 'lipShade'] as const) if (typeof L[k] !== 'number') errs.push(`terrain.ledge.${k}: missing number`)
    for (const part of ['faces', 'tops'] as const) for (const [k, f] of Object.entries(L[part] ?? {})) {
      if (!c.terrainByKey[k]?.ledge) errs.push(`terrain.ledge.${part}: "${k}" is not a ledge terrain`)
      if (!textureKeys.has(f)) errs.push(`terrain.ledge.${part}.${k}: unknown texture "${f}"`)
    }
  }
  const F = r.water.falls
  if (!F) errs.push('water.falls: missing')
  else {
    color('water.falls.body', F.body); color('water.falls.streak', F.streak)
    for (const k of ['speed', 'streaks', 'streakAmount', 'crestBand', 'splashBand', 'alpha', 'offset', 'overlap', 'crest'] as const) if (typeof F[k] !== 'number') errs.push(`water.falls.${k}: missing number`)
  }
  const I = r.streaming.infinite
  if (!I) errs.push('streaming.infinite: missing')
  else {
    for (const k of ['ensureMargin', 'prefetchMargin', 'prefetchPerFrame', 'prefetchBudgetMs', 'retainSeconds', 'blockMargin', 'providerRadius', 'heightWindow', 'climateWindow', 'assumedTopLevel'] as const) {
      if (!(typeof I[k] === 'number' && I[k] >= 0)) errs.push(`streaming.infinite.${k}: must be a number >= 0`)
    }
    const chunk = c.config.world.chunk
    const reach = Math.max(...Object.values(r.quality).map((q) => q.viewRadius)) + r.streaming.keepMargin + chunk * 2
    if (I.heightWindow % chunk !== 0) errs.push(`streaming.infinite.heightWindow must be a multiple of the render chunk (${chunk})`)
    if (I.heightWindow < reach * 2) errs.push(`streaming.infinite.heightWindow ${I.heightWindow} < streamed diameter ${Math.ceil(reach * 2)}`)
    if (I.climateWindow * r.fields.cell < reach * 2 + r.fields.cell * 2) errs.push(`streaming.infinite.climateWindow x fields.cell must cover the streamed diameter ${Math.ceil(reach * 2)}`)
    if (I.providerRadius < reach + I.prefetchMargin) errs.push('streaming.infinite.providerRadius must cover the streamed radius + prefetchMargin')
  }
  const oc = r.occlusion
  if (!oc || typeof oc.enabled !== 'boolean') errs.push('occlusion: missing "enabled"')
  else {
    for (const k of ['lift', 'soft', 'keep', 'near', 'fade'] as const) if (typeof oc[k] !== 'number') errs.push(`occlusion.${k}: missing number`)
    if (!Array.isArray(oc.radius) || oc.radius.length !== 2 || oc.radius.some((v) => !(v > 0))) errs.push('occlusion.radius: must be [right, up] > 0')
  }
  // ground decor
  for (const [id, k] of Object.entries(r.decor.kinds)) {
    if (!DECOR_SHAPES.includes(k.shape)) errs.push(`decor.kinds.${id}: bad shape "${k.shape}"`)
    if (!k.colors.length) errs.push(`decor.kinds.${id}: needs colors`)
    k.colors.forEach((x) => { if (x !== '$terrain') color(`decor.kinds.${id}.colors`, x) })
  }
  r.decor.rules.forEach((rule, i) => {
    const w = `decor.rules[${i}]`
    if (!r.decor.kinds[rule.kind]) errs.push(`${w}: unknown kind "${rule.kind}"`)
    for (const t of rule.terrain) if (!c.terrainByKey[t]) errs.push(`${w}: unknown terrain "${t}"`)
    for (const b of rule.biomes ?? []) if (!biomeIds.has(b)) errs.push(`${w}: unknown biome "${b}"`)
    for (const t of rule.near?.terrain ?? []) if (!c.terrainByKey[t]) errs.push(`${w}.near: unknown terrain "${t}"`)
    if (rule.field && !FIELD_NAMES.includes(rule.field.name)) errs.push(`${w}.field: unknown field "${rule.field.name}"`)
    if (rule.unless && !FIELD_NAMES.includes(rule.unless.name)) errs.push(`${w}.unless: unknown field "${rule.unless.name}"`)
  })
  // procedural nature
  for (const [key, n] of Object.entries(r.nature.props)) {
    const w = `nature.props.${key}`
    if (!c.props[key]) errs.push(`${w}: unknown prop`)
    if (!NATURE_GENS.includes(n.gen)) errs.push(`${w}: unknown generator "${n.gen}"`)
    if (!n.instance || !Array.isArray(n.instance.scale)) errs.push(`${w}: instance.scale missing`)
    for (const [role, t] of Object.entries(n.tints ?? {})) {
      color(`${w}.tints.${role}.base`, t.base)
      t.fields?.forEach((f, i) => {
        if (!FIELD_NAMES.includes(f.field)) errs.push(`${w}.tints.${role}.fields[${i}]: unknown field "${f.field}"`)
        f.colors.forEach((x) => color(`${w}.tints.${role}.fields[${i}]`, x))
      })
    }
  }
  for (const [biome, list] of Object.entries(r.nature.biomeVariants ?? {})) {
    if (!biomeIds.has(biome)) errs.push(`nature.biomeVariants: unknown biome "${biome}"`)
    for (const [key, n] of Object.entries(list)) {
      const w = `nature.biomeVariants.${biome}.${key}`
      if (!c.props[key]) errs.push(`${w}: unknown prop`)
      if (!r.nature.props[key]) errs.push(`${w}: only nature props can have biome variants`)
      if (!NATURE_GENS.includes(n.gen)) errs.push(`${w}: unknown generator "${n.gen}"`)
      if (!n.instance || !Array.isArray(n.instance.scale)) errs.push(`${w}: instance.scale missing`)
      for (const [role, t] of Object.entries(n.tints ?? {})) color(`${w}.tints.${role}.base`, t.base)
    }
  }
  for (const [biome, roles] of Object.entries(r.nature.biomeTints ?? {})) {
    if (!biomeIds.has(biome)) errs.push(`nature.biomeTints: unknown biome "${biome}"`)
    for (const [role, t] of Object.entries(roles)) {
      if (!t.mul?.length && !t.colors?.length) errs.push(`nature.biomeTints.${biome}.${role}: needs colors or mul`)
      if (t.mul?.some((m) => !Array.isArray(m) || m.length !== 3)) errs.push(`nature.biomeTints.${biome}.${role}: mul must be a list of [r,g,b]`)
      t.colors?.forEach((x) => color(`nature.biomeTints.${biome}.${role}.colors`, x))
    }
  }
  checkStyle('props.default', r.props.default)
  for (const [k, s] of Object.entries(r.props.styles)) {
    if (!c.props[k]) errs.push(`props.styles: unknown prop "${k}"`)
    checkStyle(`props.styles.${k}`, s)
  }
  errs.push(...validatePhysics(r, c, color))
  return errs
}
