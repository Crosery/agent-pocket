// Shapes of content/world/frontier/*.json (the infinite overworld). Types only — every number lives in JSON.
import type { FieldWeatherKind, RarityBehavior, ScriptStep, Dir, NpcRole } from '../../types.ts'
import type { HamletSpec, NoiseSpec, PoiTemplate, Vec2 } from '../schema.ts'

export type Range = Vec2

/** content/world/frontier/gen.json */
export interface FrontierGen {
  /** Tiles per generated chunk side (must divide the core continent size). */
  chunkSize: number
  /** LRU capacities (entries). */
  cache: { chunks: number; sites: number; edges: number; regions: number; interiors: number; sampleChunks: number; layouts: number; sampleCounters: number }
  /** sample() builds a cached chunk-sized field sheet after this many uncached samples hit one chunk. */
  sampleSheetAfter: number
  /** Low-frequency fields are evaluated on this tile lattice and bilinearly interpolated (identical everywhere). */
  lattice: number
  continent: {
    large: NoiseSpec; mid: NoiseSpec; small: NoiseSpec
    /** Weights of the three octave bands (sum 1). */
    weights: [number, number, number]
    contrast: number
    /** cont below seaLevel is sea; seaLevel - shallowBand .. seaLevel is walkable shallows (shoals). */
    seaLevel: number
    shallowBand: number
    /** cont above seaLevel by this much counts as fully inland. */
    inlandRange: number
    /** Level-0 land closer to the sea than this inland fraction becomes the biome's beach terrain. */
    beachInland: number
    archipelago: { mask: NoiseSpec; islands: NoiseSpec; maskRange: Range; amplitude: number }
    /** Open sea around the core continent: cont -= depth * (1 - smoothstep(near, far, distanceToCore)). */
    moat: { depth: number; near: number; far: number }
  }
  height: {
    inlandLevels: number
    /** Hills/mountains fade in over this inland fraction (keeps beaches low). */
    coastRamp: number
    erosion: NoiseSpec
    erosionRange: Range
    hills: NoiseSpec
    hillAmp: number
    /** Share of the hill amplitude kept on smooth (eroded) ground. */
    hillFlat: number
    mountains: { mask: NoiseSpec; maskRange: Range; ridge: NoiseSpec; amplitude: number; pass: NoiseSpec; passRange: Range; passDepth: number }
    plateaus: { noise: NoiseSpec; threshold: number; edge: number; amplitude: number; moistureMax: number }
    canyons: { noise: NoiseSpec; threshold: number; depth: number; moistureMax: number }
    detail: NoiseSpec
    detailAmp: number
    maxLevel: number
  }
  climate: {
    temperature: { noise: NoiseSpec; contrast: number; latitude: { gain: number; scale: number }; lapse: number }
    moisture: { noise: NoiseSpec; contrast: number; coast: { range: number; boost: number } }
    weirdness: { noise: NoiseSpec; contrast: number; perThousand: number; max: number }
    volcanic: { noise: NoiseSpec; contrast: number }
    /** Small-scale climate jitter for ragged biome borders. */
    jitter: { noise: NoiseSpec; amplitude: number; weights: { t: number; m: number; w: number; volc: number } }
  }
  rivers: {
    noise: NoiseSpec
    warp: { x: NoiseSpec; y: NoiseSpec; amplitude: number }
    size: NoiseSpec
    sizeCutoff: number
    /** Size above the cutoff over which a river reaches full width / carve. */
    strengthRamp: number
    /** Valley carve share of the smallest rivers (1 at full strength). */
    carveMin: number
    /** Channel half-width range in tiles (by the size field). */
    width: Range
    /** Deep (surf) water needs at least this half-width; narrower rivers are fordable shallows. */
    deepMin: number
    bank: number
    valley: number
    valleyDepth: number
    /** Finite-difference step (tiles) for the distance-to-channel estimate. */
    gradStep: number
    moistureMin: number
    /** |river noise - 0.5| above this skips the channel test (cheap far-from-river early out). */
    rejectAbove: number
    rapidsProp: string
  }
  /** Lake noise is lowered by up to coastFade below 2 x inlandMin (fraction of inlandRange) and near gateways,
   *  so lakes shrink away from coasts instead of merging with the sea. */
  lakes: { noise: NoiseSpec; threshold: number; deep: number; blend: number; moistureMin: number; mountainMax: number; inlandMin: number; coastFade: number; levelOffset: number }
  /** Natural contour crossings: ledges (one-way drops) on the upper tile, stairs on the lower tile. */
  ledges: { noise: NoiseSpec }
  stairs: { salt: string }
  levels: {
    /** [distance from origin, mid level] points, piecewise linear; clamped to config.party.maxLevel. */
    curve: Vec2[]
    span: number
    /** Danger tier i applies from dangerDistances[i] tiles. */
    dangerDistances: number[]
    dangerLevelBonus: number[]
    rareBoost: number[]
    encounterRate: number[]
    roaming: number[]
    /** Rare-spawn nests are this many danger tiers above the region around them. */
    nestDangerBonus: number
  }
  provinces: { cell: number; jitter: number; warp: { x: NoiseSpec; y: NoiseSpec; amplitude: number } }
  roads: {
    terrain: string
    bridge: string
    stairs: string
    /** Max consecutive sea tiles a road may bridge; longer crossings drop the edge. */
    maxSeaRun: number
    /** Neighbour search: an edge skips up to this many empty cells. */
    maxGap: number
    /** Chance an otherwise valid edge is left out (less grid-like network). */
    skip: number
    /** Where the middle leg of the Z-shaped road sits between its ends. */
    bend: Range
    /** Height profile: sample every n tiles, moving-average window (tiles). */
    profileStep: number
    smooth: number
    /** No level change within this many tiles of a corner or a pad. */
    cornerFree: number
    signOffset: number
    /** Roads stop at the hamlet plaza radius + plazaPad, or `poi` tiles from other site centres. */
    stop: { plazaPad: number; poi: number }
  }
  causeways: {
    specs: { id: string; side: 'north' | 'south' | 'east' | 'west'; at: number; zones: string[]; search: number }[]
    terrain: string
    landLevelMax: number
    /** Gateway hamlets link onward to the nearest road-bearing site within this many cells ahead. */
    onwardCells: number
    /** Landing search: lanes need minRun sea tiles; score = run + offsetCost x offset; best `candidates` tried; lanes on one side at least `spacing` apart. */
    minRun: number
    offsetCost: number
    candidates: number
    spacing: number
    /** Gateway hamlet `distance` tiles beyond the core edge; landfall bump of `bump` fading from `land` to `radius`
     *  (radius wobbled by +-wobble tiles of island noise); within `core` tiles the land is at least coreInland inland. */
    gateway: { distance: number; radius: number; bump: number; land: number; wobble: number; core: number; coreInland: number }
  }
  encounters: { minSlots: number; maxSpecies: number; rareMinOrder: number; nightPhase: string }
  /** Used when content/rarities.json has no `behavior` for a tier. */
  rarityDefaults: Record<string, RarityBehavior>
  /** pathDistCap: road distance field cap (layer bands / prop keep-out); rapidsChance per river step tile. */
  decor: { seaStacks: { prop: string; density: number; minDepth: number }; rapidsChance: number; pathDistCap: number }
}

export interface ClimateRule {
  biome: string
  t?: Range; m?: Range; w?: Range; level?: Range; inland?: Range; rugged?: Range; volcanic?: Range; mountain?: Range
}

export interface FrontierBiomeSpec {
  /** Terrain keys. */
  beach: string
  ledge: string
  road: string
  /** Chance a lower contour tile with a clean single step becomes stairs. */
  stairs: number
  /** Ledge noise threshold (lower = more ledges; > 1 = none). */
  ledgeThreshold: number
  music: string
  weather: [FieldWeatherKind, number][]
  encounterRate: number
  roaming: number
}

/** content/world/frontier/biomes.json */
export interface FrontierBiomesFile {
  rules: ClimateRule[]
  seaRules: (ClimateRule & { shallow?: boolean })[]
  biomes: Record<string, FrontierBiomeSpec>
}

export interface SiteKindSpec {
  id: string
  type: 'hamlet' | 'poi' | 'dungeon' | 'none'
  /** POI template id or '*' (any eligible template from landmarkPool). */
  template?: string
  weight: number
  roads: boolean
  /** Listed by provider.place() / MapChunk.places. */
  place?: 'hamlet' | 'landmark'
  /** [distance, multiplier] points (piecewise linear). */
  distance?: Vec2[]
  /** Per-biome weight multipliers (default 1). */
  biomes?: Record<string, number>
  minDistance?: number
}

/** content/world/frontier/sites.json */
export interface FrontierSitesFile {
  cell: number
  /** Fraction of the cell kept free on each side of the jittered site point. */
  margin: number
  /** Land probe ring; `shore` when the sea is within radius x shoreFactor. */
  probe: { radius: number; points: number; minLand: number; shoreFactor: number }
  kinds: SiteKindSpec[]
  landmarkPool: string[]
  templates: Record<string, PoiTemplate>
  /** Merged over pois.json lore (sign templates, word pools, biome adjectives for new biomes). */
  lore: { templates: Record<string, string[]>; words: Record<string, string[]>; biomeWords: Record<string, string[]> }
  hamlet: Partial<HamletSpec> & { radius: number; window: number }
  /** exclusion: extra tiles (beyond two hamlet radii) kept free of other sites around a gateway. */
  gateway: { names: string[]; services: number; exclusion: number }
  dungeon: { radius: number; floors: Range; mouthProp: string; padTerrain: string; padRadius: number; signOffset: number; endAt: Range }
  pad: { blend: number }
  poiWindow: number
  /** POI ground items keep this Manhattan distance from the centre. */
  itemsMinDist: number
}

export interface FrontierNamesFile {
  province: { first: string[]; second: string[]; patterns: string[] }
  region: { byBiome: Record<string, string[]>; fallback: string[] }
  biomeWords: Record<string, string[]>
}

export interface NpcSpec {
  sprite: string
  nameZh: string
  role: NpcRole
  facing?: Dir
  portrait?: string
  script: ScriptStep[]
  wander?: number
}

/** content/world/frontier/decor.json */
export interface FrontierDecorFile {
  villagers: { sprites: string[]; names: string[]; lines: string[][]; perHamlet: Range; wander: number }
  signposts: { prop: string; format: string; distanceFormat: string }
  items: { perChunk: Range; hiddenChance: number; minSpacing: number; tries: number }
  services: { nurse: NpcSpec; box: NpcSpec; clerk: NpcSpec; shopTiers: { minDistance: number; items: string[] }[]; shopIntro: ScriptStep[]; shopOutro: ScriptStep[] }
  residents: { sprites: string[]; names: string[]; lines: string[][] }
  placeDescriptions: Record<string, string>
}
