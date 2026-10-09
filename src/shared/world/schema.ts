// Shapes of the world generator's own content files (content/world/**). Types only.
import type { Dir, FieldWeatherKind } from '../types.ts'

export type Vec2 = [number, number]
export type Rot = 0 | 1 | 2 | 3

export interface NoiseSpec { scale: number; octaves: number; gain: number; lacunarity: number; salt: string }

// ---------------------------------------------------------------------------
// world.json
// ---------------------------------------------------------------------------

export interface PeakSpec {
  x: number; y: number; radius: number; height: number
  shape: 'dome' | 'cone' | 'mesa'
  /** mesa only: fraction of the radius that stays flat on top. */
  flat?: number
  crater?: { radius: number; terrain: string }
}

export interface IslandSpec { id: string; region: string; x: number; y: number; radius: number; level: number; noise: number }

export interface LakeSpec {
  id: string; x: number; y: number; radius: number; noise: number
  terrain: string; rim: number; rimTerrain: string
  /** Level relative to the terrain under the lake centre (default 0). */
  levelOffset?: number
}

export interface RiverSpec { id: string; points: Vec2[]; width: number; bank: number; terrain: string; bankTerrain: string }

export interface PathCosts {
  base: number; reuse: number; bridge: number; stairs: number; border: number
  noise: number; heuristic: number; noiseSpec: NoiseSpec
  /** Give up beyond this accumulated cost (connectors). */
  maxCost?: number
}

export interface RiverCosts {
  base: number; uphill: number; noise: number; heuristic: number; noiseSpec: NoiseSpec
  /** Control points on a locked/edge tile move to the nearest routable tile (water preferred) within this radius. */
  snap: number
  /** Half-window (path tiles) of the moving average that smooths the A* staircase before carving. */
  smooth: number
}

export interface SpotSpec { name: string; near: Vec2 }

/** Layout space: every authored coordinate (towns, region points, peaks, islands, lakes, rivers, spots, cave and
 * route hints) is written for a `width` x `height` design grid and scaled into `box` ([x0, y0, x1, y1] in
 * overworld tiles, default the whole map) when the world is built. Radii scale with the same factor. */
export interface LayoutSpace { width: number; height: number; box?: [number, number, number, number] }

export interface OceanSpec {
  /** Tiles from the map edge over which land falls off into the ocean. */
  width: number
  /** Coastline noise and its weight against the edge falloff; land where falloff + noise > threshold. */
  noise: NoiseSpec; amplitude: number; threshold: number
  /** Tiles around towns that always stay land. */
  keepClear: number
  /** Corner rounding: land also falls off towards a circle of this radius (in half-map units, 0 = off). */
  round: number
  /** Tiles from the map edge that are always sea, so the ocean ring stays connected for surfing. */
  margin: number
}

export interface ArchipelagoSpec {
  count: number; radius: Vec2; level: number; noise: number
  /** Minimum deep-water gap to the mainland and between islands (tiles). */
  minGap: number; spacing: number; tries: number
  idPrefix: string
}

export interface LandformSpec {
  /** Rolling hills everywhere (levels). */
  hills: { noise: NoiseSpec; amplitude: number }
  /** Ridged mountain ranges inside a low-frequency mask. */
  mountains: { mask: NoiseSpec; maskRange: Vec2; ridge: NoiseSpec; amplitude: number }
  /** Flat-topped plateaus: noise above `threshold` (edge width `edge`) raises `amplitude` levels. */
  plateaus: { noise: NoiseSpec; threshold: number; edge: number; amplitude: number }
  /** Narrow canyons where ridged noise exceeds `threshold[0]..[1]` inside the aridity mask. */
  canyons: { noise: NoiseSpec; threshold: Vec2; depth: number; moistureMax: number }
  /** Mountain ridge along walled zone borders (levels, falloff width in tiles). */
  borderRidge: { width: number; amplitude: number; noise: NoiseSpec }
  /** Domain warp applied to every landform field. */
  warp: { amplitude: number; noise: NoiseSpec }
}

export interface HydrologySpec {
  /** Coarse cells (lattice stride = overworld.coarse) of drainage area a river needs. */
  riverThreshold: number
  /** Extra river width per `widthStep` cells of drainage; capped at `maxWidth`. */
  widthStep: number; maxWidth: number; bank: number
  /** Minimum river length in coarse cells. */
  minLength: number
  /** Perpendicular meander of the rasterised river line (tiles). */
  meander: number; meanderNoise: NoiseSpec
  /** Basins at least `lakeDepth` levels deep and `lakeMinCells` coarse cells large become lakes. */
  lakeDepth: number; lakeMinCells: number; maxLakes: number
  riverTerrain: string; bankTerrain: string; lakeTerrain: string; lakeRimTerrain: string
  /** Blocking prop on deep water inside a zone border band (rapids), so surfing never bypasses walls. */
  rapidsProp: string
}

export interface OverworldSpec {
  id: string; nameZh: string; width: number; height: number; music: string
  layout: LayoutSpace
  /** Lattice stride of low-frequency fields (climate, hydrology). */
  coarse: number
  ocean: OceanSpec
  archipelago: ArchipelagoSpec
  landforms: LandformSpec
  hydrology: HydrologySpec
  /** Wall props on walkable sea tiles (shallows) inside a zone border band. */
  shallowBorder: { prop: string; weight: number }[]
  /**
   * Level basin around the start town: nothing above `level` within `radius` tiles (radius wobbled by `jitter` tiles of
   * Perlin noise), then the cap rises smoothly to the world's own relief over `transition` tiles. Isolated terraces under `minPatch` tiles inside that reach are levelled too.
   */
  /** Post-pass terrace compression: level `i` becomes `levelMap[i]` (non-decreasing, steps of at most one). */
  levelMap?: number[]
  startFlat?: { radius: number; transition: number; level: number; jitter: number; noise: NoiseSpec; minPatch: number }
  maxLevel: number; seaLevel: number; seaTerrain: string; seaShallowTerrain: string; seaShallowWidth: number
  outOfBounds: string
  edgeBand: number; borderRadius: number; townMargin: number; slope: number; caveSearch: number; routeRegionRadius: number
  warp: { amplitude: number; noise: NoiseSpec }
  blur: { radius: number; passes: number }
  relief: NoiseSpec
  /** Beaches: coastal land of `regions` (or any land lower than `maxRise` levels above the sea) within `width`. */
  beach: { width: number; terrain: string; rise: number; regions: string[]; maxRise: number }
  /** Zones with shore 'cliff': land within `cliffWidth` of the sea stays at least one level above it. */
  cliffWidth: number
  islandNoise: NoiseSpec
  lakeNoise: NoiseSpec
  islands: IslandSpec[]
  lakes: LakeSpec[]
  rivers: RiverSpec[]
  riverRouting: RiverCosts
  routing: PathCosts
  connector: PathCosts
  /** Route signs: first try `distance` tiles from each end, scanning `window` tiles along and up to `side` tiles beside the path. */
  routeSign: { distance: number; window: number; side: number }
  /** Cave signs stand `caveSignOffset` tiles left (else right) of the mouth front. */
  caveSignOffset: number
  /** Search radii when snapping quest spots / region anchors to reachable tiles; distance-to-path field cap. */
  snapRadius: { spot: number; region: number }
  pathDistCap: number
  /** Terrain carved through the town margin for exits no route uses. */
  exitStubTerrain: string
  /** SignDef.kind -> prop key placed under the sign. */
  signProps: Record<string, string>
  caveMouthProp: string
  /** Ranked mouth spots tried until one can be joined to a path. */
  caveMouthTries: number
  bridgeTerrain: string
  stairsTerrain: string
  /** Minimum distance between extra (non-route) stairs carved into cliffs. */
  accessStairSpacing: number
  /** Prop planted on both flanks of every extra cliff stair so it is easy to spot (omit for none). */
  accessStairMarker?: string
  /** Repair of walkable pockets cut off by cliffs, rivers or scattered props. */
  access: { minPocket: number; maxRepairs: number; propCost: number }
  trainerSpots: { minPathDist: number; maxPathDist: number; minSpacing: number }
  spots: SpotSpec[]
}

export interface EncounterRules {
  minSlots: number; maxSpecies: number; rareMinOrder: number; nightPhase: string
  /** Early-game fairness: tables whose top level is <= maxLevel only hold species of rarity order <= maxOrder and,
   * when `onlyTypes` is set, whose types are all listed (first matching entry wins). */
  rarityLevelCaps?: { maxLevel: number; maxOrder: number; onlyTypes?: string[] }[]
  /** Every non-starter base form up to this rarity order must sit in at least one wild table (see ensureEncounterCoverage). */
  coverage?: { maxOrder: number }
}

export interface WorldSpec {
  overworld: OverworldSpec
  encounters: EncounterRules
  /** Sign / name format strings with {placeholders}. */
  text: { gymSign: string; routeSign: string; caveSign: string; dungeonSign: string }
}

// ---------------------------------------------------------------------------
// regions.json / towns.json / routes.json
// ---------------------------------------------------------------------------

export interface RegionSpec {
  id: string; nameZh: string; biome: string; music: string; weather: FieldWeatherKind
  levelRange: Vec2; encounterRate: number; roamingDensity: number
  /** Macro-layout control points (tile coords); each tile belongs to the region of its nearest point. */
  points: Vec2[]
  /** Base elevation (levels) and noise relief amplitude. */
  level: number; relief: number
  /** Whole region is sea (deep water, surf only). */
  water?: boolean
  /** Walled off from neighbouring regions (default true). */
  border?: boolean
  peaks?: PeakSpec[]
  accessStairs?: number
  /** Climate bias (0..1) pulled towards around this zone: t = temperature, m = moisture. */
  climate?: { t: number; m: number; w?: number }
  /** 'cliff' keeps every coast of the zone above sea level (no landing by surf; used behind gates). */
  shore?: 'cliff' | 'beach'
}

export interface TownBuildingSpec { interior?: string; floors?: string[]; mapId?: string; nameZh?: string; prop?: string }

export interface TownGymSpec { type: string; badge: string; badgeNameZh: string; leader: string }

export interface TownSpec {
  id: string; nameZh: string; description: string; region: string
  /** Centre of the stamped template (tile coords). */
  x: number; y: number
  layout: string; mirror?: boolean; level?: number
  music: string; weather?: FieldWeatherKind
  palette: Record<string, string>
  buildings?: Record<string, TownBuildingSpec>
  signs: Record<string, string>
  gym?: TownGymSpec
  start?: boolean
  /** Building slot of the player's house (start town). */
  home?: string
}

export interface RouteSpec {
  id: string; nameZh: string
  from: string; fromExit: string; to: string; toExit: string
  via?: Vec2[]
  width: number; terrain: string; biome: string; music: string
  levelRange: Vec2; encounterRate: number; roamingDensity: number; weather?: FieldWeatherKind
  trainerSpots: number
  gate?: { name: string; region: string }
}

// ---------------------------------------------------------------------------
// layouts/*.json
// ---------------------------------------------------------------------------

/** Grid cell meaning. Values starting with '@' are palette tokens resolved per town/interior. */
export interface LegendEntry { terrain: string; prop?: string; rot?: Rot; elev?: number }
export interface GridRow { r: string }
export interface PropSpec { prop: string; x: number; y: number; rot?: Rot; scale?: number; variant?: number }

export interface TownTemplate {
  w: number; h: number
  square: Vec2
  exits: Record<string, Vec2>
  rows: GridRow[]
  buildings: { slot: string; prop: string; x: number; y: number }[]
  props: PropSpec[]
  signs: { slot: string; x: number; y: number; kind: 'sign' | 'board' | 'plaque' }[]
  anchors: Record<string, Vec2>
}

export interface InteriorLink { x: number; y: number; arrive: Vec2; facing: Dir }

export interface InteriorTemplate {
  w: number; h: number
  /** '{town}' placeholder allowed. */
  nameZh: string
  music: string
  biome?: string
  palette: Record<string, string>
  rows: GridRow[]
  props: PropSpec[]
  /** Door mat in the bottom wall (warp back outside); absent on upper floors. */
  exit?: Vec2
  /** Where the player appears when entering through the door. */
  arrive: Vec2
  anchors: Record<string, Vec2>
  links?: { up?: InteriorLink; down?: InteriorLink }
}

export interface LayoutFile<T> { legend: Record<string, LegendEntry>; palette: Record<string, string>; templates: Record<string, T> }

export interface CaveEndSpec { id: string; side: 'north' | 'south' | 'east' | 'west'; at: number; region: string; near: Vec2 }

export interface CaveSpec {
  id: string; nameZh: string; w: number; h: number
  /** Carving: cellular automata (default) or drunkard walks. */
  algo?: 'ca' | 'walk'
  walk?: { walkers: number; steps: number; radius: number; turn: number }
  biome: string; habitats: string[]; music: string; weather?: FieldWeatherKind
  levelRange: Vec2; encounterRate: number; roamingDensity: number
  floor: string; wall: string; wallElev: number; mat: string
  fill: number; iterations: number; birth: number; survive: number; tunnelRadius: number
  tunnelNoise: NoiseSpec
  /** Tunnel A* step cost: open floor / wall + noise × tunnelNoise. */
  tunnelCost: { open: number; wall: number; noise: number }
  accents: LayerRule[]
  props: PropRule[]
  ends: CaveEndSpec[]
  /** Non-colliding prop placed on an end's exit tile (e.g. stairs down). */
  endProps?: (string | null)[]
  spots: number
  items: { visible: number; hidden: number }
  /** Min share of the map that must be floor connected to the first end; below it a tunnel is carved to the
   * biggest chamber (single-end caves have no end-to-end tunnel). Unset = no check. */
  minFloor?: number
}

export interface CavesFile { caves: CaveSpec[] }

// ---------------------------------------------------------------------------
// scatter.json / items.json
// ---------------------------------------------------------------------------

export interface LayerRule {
  terrain: string
  noise: NoiseSpec
  min: number
  max?: number
  /** Only paint over these terrain keys (default: the biome ground and earlier layers). */
  on?: string[]
  /** Only within this [min,max] distance (tiles) from a route path. */
  pathDist?: Vec2
}

export interface PropRule {
  prop: string
  density: number
  noise?: NoiseSpec
  min?: number
  on?: string[]
  /** Minimum distance from route paths (default scatter.keepOutDefault). */
  avoidPath?: number
  /** Frontier only: uniform model scale range [min, max] (tint/size variants of existing models). */
  scale?: Vec2
  /** Frontier only: fixed render variant index (render.json style variants). */
  variant?: number
}

export interface BiomeScatter {
  ground: string
  layers: LayerRule[]
  props: PropRule[]
  border: { prop: string; weight: number }[]
}

export interface ScatterFile { keepOutDefault: number; biomes: Record<string, BiomeScatter> }

export interface ItemBand { maxLevel: number; maxPrice: number; weights: Record<string, number>; qty: Vec2 }

export interface GroundItemRules {
  visible: number; hidden: number; minSpacing: number
  excludeCategories: string[]
  hiddenPriceMul: number
  bands: ItemBand[]
}

// ---------------------------------------------------------------------------
// climate.json — noise-driven climate and the Whittaker-style biome table
// ---------------------------------------------------------------------------

export interface BiomeRule {
  biome: string
  /** Inclusive ranges; omitted = any. t/m/weird in 0..1, elev in levels, sea = distance to the sea (tiles). */
  t?: Vec2; m?: Vec2; weird?: Vec2; elev?: Vec2; sea?: Vec2
}

export interface ClimateFile {
  /** contrast stretches each noise field around 0.5 before the zone bias is applied. */
  temperature: { noise: NoiseSpec; contrast: number; latitude: number; lapse: number }
  moisture: { noise: NoiseSpec; contrast: number; water: { distance: number; boost: number } }
  weirdness: { noise: NoiseSpec; contrast: number }
  /** Zone climate bias: blur radius (tiles) and blend weight in the core / the wilds. */
  bias: { blur: number; core: number; wild: number; weird: number }
  /** Core (authored, story) area: wildness = smoothstep(radius[0], radius[1], distance to authored points + jitter). */
  core: { radius: Vec2; jitter: number; noise: NoiseSpec; threshold: number }
  rules: BiomeRule[]
}

// ---------------------------------------------------------------------------
// wilds.json — procedural wilderness regions
// ---------------------------------------------------------------------------

export interface DangerTier {
  /** Minimum wildness-weighted distance (tiles) from the authored core for this tier. */
  minDist: number
  levelBonus: number; encounterRate: number; roamingDensity: number
  /** Weight multiplier of rare encounter slots. */
  rareBoost: number
}

export interface WildsFile {
  cell: number; jitter: number
  warp: { amplitude: number; noise: NoiseSpec }
  /** Fragments smaller than this (tiles) join the zone's core region. */
  minArea: number
  maxRegions: number
  idPattern: string
  names: Record<string, { prefix: string[]; suffix: string[] }>
  /** Appended (with {name}) to a region name when a pool runs dry. */
  dupPattern: string
  tiers: DangerTier[]
  levels: { span: number; perTile: number; startDistance: number; maxOver: number }
  biomeMusic: Record<string, string>
  biomeWeather: Record<string, FieldWeatherKind>
  spots: { total: number; perRegionMin: number; minSpacing: number; pathBias: number }
}

// ---------------------------------------------------------------------------
// pois.json — hamlets, points of interest, nests, lore
// ---------------------------------------------------------------------------

export type PoiPlacement =
  | { mode: 'center' }
  | { mode: 'ring'; radius: Vec2 }
  | { mode: 'scatter'; radius: number }
  | { mode: 'grid'; spacing: number; radius: number }
  | { mode: 'water' }

export interface PoiPart {
  prop: string
  count: Vec2
  place: PoiPlacement
  rot?: number
  /** Allowed ground terrain keys (default walkable dry ground). */
  on?: string[]
}

export interface PoiBlob { terrain: string; radius: number; noise: number; ring?: Vec2 }

export interface PoiTemplate {
  /** Name formats with {word} pools from lore.words plus {biome} (biome adjective) */
  names: string[]
  biomes: string[] | 'any'
  count: Vec2
  radius: number
  spacing: number
  /** 'land' (default), 'shore' (near the sea) or 'island' (procedural islands only). */
  site?: 'land' | 'shore' | 'island'
  /** Minimum wildness (0 = core allowed). */
  wildMin?: number
  ground?: PoiBlob[]
  parts: PoiPart[]
  spots: number
  sign?: string
  items?: { visible: number; hidden: number }
  landmark?: boolean
  /** Rare-spawn nest: own region with boosted rare encounters. */
  nest?: { terrain: string; byBiome?: Record<string, string>; radius: number; levelBonus: number; rareBoost: number; encounterRate: number }
}

export interface HamletSpec {
  count: Vec2; spacing: number; radius: number; minTownDist: number; wildMin: number
  houses: Vec2
  /** Chance that a hamlet has a center + shop. */
  services: number
  names: string[]
  plaza: { radius: number; terrain: string; centerProps: string[] }
  road: string
  /** Building kinds: prop + interior templates (one picked per building). */
  buildings: { house: { prop: string; interiors: string[]; weight: number }[]; center: { prop: string; interior: string }; shop: { prop: string; interior: string } }
  ring: Vec2
  fields: { count: Vec2; size: [Vec2, Vec2]; terrain: string; crops: string[]; fence: string }
  decor: { prop: string; count: Vec2 }[]
  npcSpots: number
  sign: string
  music: string
}

export interface PoisFile {
  siteStep: number
  /** Maximum height range (levels) across a site before it is flattened. */
  flatMax: number
  hamlets: HamletSpec
  templates: Record<string, PoiTemplate>
  lore: { templates: Record<string, string[]>; words: Record<string, string[]>; biomeWords: Record<string, string[]> }
}

// ---------------------------------------------------------------------------
// dungeons.json — procedural multi-floor dungeons
// ---------------------------------------------------------------------------

export interface DungeonStyle {
  id: string
  biomes: string[] | 'any'
  names: string[]
  size: [Vec2, Vec2]
  algo: 'ca' | 'walk'
  floor: string; wall: string; wallElev: number; mat: string
  fill: number; iterations: number; birth: number; survive: number; tunnelRadius: number
  walk?: { walkers: number; steps: number; radius: number; turn: number }
  tunnelCost: { open: number; wall: number; noise: number }
  accents: LayerRule[]
  props: PropRule[]
  music: string
  weather?: FieldWeatherKind
  habitats: string[]
}

export interface DungeonsFile {
  count: Vec2
  floors: Vec2
  spacing: number
  minTownDist: number
  mouthProp: string
  stairsProp: string
  styles: DungeonStyle[]
  floorName: string
  levelPerFloor: number
  encounterRate: number; roamingDensity: number
  spotsPerFloor: number
  items: { visible: number; hidden: number }
  tunnelNoise: NoiseSpec
  rareBoost: number
  /** CaveSpec.minFloor for every dungeon floor (core and frontier). */
  minFloor?: number
}

// ---------------------------------------------------------------------------
// anchors.json — teleport anchors (grand landmark at every spawn, minor ones spread over the map)
// ---------------------------------------------------------------------------

export type AnchorKindId = 'grand' | 'minor'

/** Tile-flag names a placement rule can forbid (mapped to the generator's F_* bits in anchor-place.ts). */
export type AnchorFlagName = 'path' | 'road' | 'reserved' | 'gate' | 'keep' | 'bridge' | 'nest' | 'border' | 'edge' | 'river' | 'lake' | 'sea'

export interface AnchorKindSpec {
  /** props.json key (footprint = the anchor's footprint). */
  prop: string
  /** Free walkable ring kept around the footprint so an anchor never seals a passage. */
  margin: number
  /** Distance (tiles, from the footprint centre) at which walking up to it activates it. */
  unlockRadius: number
  /** Distance at which it counts as discovered (greyed pin on the map until activated). */
  seenRadius: number
  unlockFx: string
  unlockSfx: string
  travelFx: string
  travelSfx: string
  arriveFx: string
  /** render.json anchors.beacons key. */
  beacon: string
}

export interface AnchorRule {
  id: string
  source: 'spawn' | 'town' | 'hamlet' | 'dungeon' | 'poi' | 'route' | 'fill'
  kind: AnchorKindId
  /** Search band (Chebyshev tiles) around the rule's target. */
  min: number
  max: number
  /** Skip the placement when any existing anchor is closer than this (Chebyshev tiles). */
  minSpacing?: number
  /** source 'spawn': the worldAnchors name the grand anchor stands next to. */
  anchor?: string
  /** source 'poi': POI template ids that get an anchor. */
  templates?: string[]
  /** source 'route': a candidate every `spacing` path tiles, none within `edgeMargin` of either end. */
  spacing?: number
  edgeMargin?: number
  /** source 'fill': keep every walkable tile within this many steps of an anchor, probing a lattice of this stride. */
  maxWalk?: number
  lattice?: number
  /** The home anchor ("回原点"). */
  home?: boolean
}

export interface FrontierAnchorSite { kind: AnchorKindId; min: number; max: number }

export interface AnchorsFile {
  kinds: Record<AnchorKindId, AnchorKindSpec>
  preUnlock: { grandWithin: number }
  /** Caps of the ids kept in a save (older entries beyond it are dropped). */
  save: { maxUnlocked: number; maxSeen: number }
  naming: { radius: number }
  place: {
    avoidFlags: AnchorFlagName[]
    ringAvoidFlags: AnchorFlagName[]
    /** Terrain keys that cost `roadPenalty` extra squared tiles (anchors prefer verges to the road bed). */
    roadTerrain: string[]
    roadPenalty: number
    /** Rings searched past the first hit, to prefer a cheaper tile slightly farther out. */
    slack: number
    itemClearance: number
  }
  core: { rules: AnchorRule[] }
  frontier: {
    /** Per site kind id (frontier sites.json kinds + `gateway` for causeway landings). */
    sites: Record<string, FrontierAnchorSite>
    fill: { kind: AnchorKindId; cell: number; jitter: number; siteClearance: number; coreClearance: number; reachTiles: number; search: number; salt: string }
  }
}
