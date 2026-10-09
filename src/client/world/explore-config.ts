// Typed view of content/explore.json: infinite-world client tunables (object streaming, ledge hops, place
// discovery, distance milestones, region banner, fog pages, landing search, minimap / world-map rendering).
import type { WorldFx } from '../contracts.ts'
import type { TownDef } from '../../shared/types.ts'
import type { LedgeGuardRules } from './ledge-guard.ts'
import { CONTENT, type Content } from '../../shared/content/index.ts'
import exploreJson from '../../../content/explore.json' with { type: 'json' }

export type PlaceKind = NonNullable<TownDef['kind']> | 'dungeon'

export interface ExploreTuning {
  stream: {
    /** Objects anchored within this many tiles (square half-size) of the player are always live. */
    radius: number
    /** Live NPCs / items farther than this (square half-size) are dropped at the next re-query. */
    despawnRadius: number
    /** Re-query objects after the player moved this many tiles from the last query centre. */
    stepTiles: number
    /** Largest prop footprint (tiles) considered when looking up the prop covering a tile. */
    propReach: number
    /** Chunk ring around the player chunk generated ahead of time, at most `prefetchPerFrame` per frame. */
    prefetchChunks: number
    prefetchPerFrame: number
    /** Provider caches are trimmed to this radius around the player every `retainEverySec`. */
    retainTiles: number
    retainEverySec: number
  }
  ledge: {
    hopMs: number; height: number
    /** Landing point distance past the lower tile edge (tiles). */
    landingOffset: number
    sfx: string; pitch: number; volume: number; landSfx: string; landVolume: number; landFx: WorldFx
    /** Refuses drops into closed pockets (ledge-guard.ts); `hint` is a text key toasted on refusal. */
    guard: LedgeGuardRules & { hint: string; hintCooldownSec: number }
  }
  discover: { radius: number; sfx: string; announceKinds: PlaceKind[]; flyKinds: PlaceKind[]; maxSaved: number }
  milestones: { distances: number[]; sfx: string; banner: boolean }
  banner: { starOn: string; starOff: string; dangerTiers: number; wildOnly: boolean }
  fog: { pageCells: number; maxPages: number }
  landing: { searchRadius: number }
  save: { maxCoord: number }
  minimap: { chunkCache: number; bakePerFrame: number; markerRadius: number; expandedTiles: number; expandedLabels: number }
  worldMap: {
    /** CSS pixels per tile for each zoom step (largest first). */
    zooms: number[]
    initialZoom: number
    tilePx: number
    maxLod: number
    cacheTiles: number
    budgetMs: number
    panSpeed: number
    dragThreshold: number
    wheelStep: number
    snapPx: number
    provinceLabelMinZoom: number
    regionLabelMinZoom: number
    placeNameMinZoom: number
    coreFogTerrain: boolean
    unexploredColor: string
    gridColor: string
    gridEveryTiles: number
    cursorGlyph: string
    placeGlyphs: Record<PlaceKind, string>
    placePalettes: Record<'fly' | 'known' | 'locked', Record<string, string>>
    /** Teleport-anchor pins: glyph per anchor kind; "off" repaints a discovered-but-inactive anchor grey. */
    anchorGlyphs: Record<'minor' | 'grand', string>
    anchorPalettes: Record<'on' | 'off', Record<string, string>>
    /** Anchor pins of the wild closer than this (UI units; at least `pinTouchPx` CSS px with the touch pad on) to a place, a stronger pin or the map tools are hidden. */
    pinSpacingUnits: number
    pinTouchPx: number
    flyList: number
  }
}

export const EXPLORE: ExploreTuning = exploreJson as unknown as ExploreTuning

const PLACE_KINDS: readonly PlaceKind[] = ['town', 'hamlet', 'landmark', 'dungeon']
const WORLD_FX: readonly WorldFx[] = ['exclaim', 'question', 'grass', 'dust', 'sparkle', 'splash', 'heart', 'warp', 'levelup', 'shiny']

/** Problems in content/explore.json (unknown sfx/fx/kinds, bad numbers). Empty = consistent. */
export function validateExploreContent(e: ExploreTuning = EXPLORE, c: Content = CONTENT): string[] {
  const errs: string[] = []
  const sfx = new Set(c.audio.sfx)
  const checkSfx = (where: string, id: string) => { if (!sfx.has(id)) errs.push(`explore.json ${where}: unknown sfx "${id}"`) }
  const positive = (where: string, v: number) => { if (!(typeof v === 'number' && v > 0)) errs.push(`explore.json ${where}: must be > 0`) }
  const kinds = (where: string, list: string[]) => {
    for (const k of list) if (!PLACE_KINDS.includes(k as PlaceKind)) errs.push(`explore.json ${where}: unknown place kind "${k}"`)
  }
  positive('stream.radius', e.stream.radius)
  positive('stream.stepTiles', e.stream.stepTiles)
  if (!(e.stream.despawnRadius >= e.stream.radius + e.stream.stepTiles)) errs.push('explore.json stream.despawnRadius must be >= radius + stepTiles')
  positive('stream.propReach', e.stream.propReach)
  positive('stream.retainTiles', e.stream.retainTiles)
  positive('ledge.hopMs', e.ledge.hopMs)
  checkSfx('ledge.sfx', e.ledge.sfx)
  checkSfx('ledge.landSfx', e.ledge.landSfx)
  if (!WORLD_FX.includes(e.ledge.landFx)) errs.push(`explore.json ledge.landFx: unknown fx "${e.ledge.landFx}"`)
  positive('ledge.guard.radius', e.ledge.guard.radius)
  positive('ledge.guard.maxNodes', e.ledge.guard.maxNodes)
  positive('ledge.guard.cache', e.ledge.guard.cache)
  if (!(e.ledge.guard.flyMinSize >= 0)) errs.push('explore.json ledge.guard.flyMinSize must be >= 0')
  if (!(e.ledge.guard.hint in c.text)) errs.push(`explore.json ledge.guard.hint: unknown text key "${e.ledge.guard.hint}"`)
  positive('discover.radius', e.discover.radius)
  checkSfx('discover.sfx', e.discover.sfx)
  kinds('discover.announceKinds', e.discover.announceKinds)
  kinds('discover.flyKinds', e.discover.flyKinds)
  checkSfx('milestones.sfx', e.milestones.sfx)
  e.milestones.distances.forEach((d, i) => {
    if (!(d > 0) || (i > 0 && d <= e.milestones.distances[i - 1])) errs.push('explore.json milestones.distances must be positive and ascending')
  })
  positive('banner.dangerTiers', e.banner.dangerTiers)
  positive('fog.pageCells', e.fog.pageCells)
  if (e.fog.pageCells % 8 !== 0) errs.push('explore.json fog.pageCells must be a multiple of 8')
  positive('landing.searchRadius', e.landing.searchRadius)
  positive('save.maxCoord', e.save.maxCoord)
  positive('minimap.chunkCache', e.minimap.chunkCache)
  positive('minimap.expandedTiles', e.minimap.expandedTiles)
  const W = e.worldMap
  if (!W.zooms.length) errs.push('explore.json worldMap.zooms is empty')
  W.zooms.forEach((z, i) => { if (!(z > 0) || (i > 0 && z >= W.zooms[i - 1])) errs.push('explore.json worldMap.zooms must be positive and descending') })
  if (!(W.initialZoom >= 0 && W.initialZoom < W.zooms.length)) errs.push('explore.json worldMap.initialZoom out of range')
  positive('worldMap.tilePx', W.tilePx)
  positive('worldMap.cacheTiles', W.cacheTiles)
  positive('worldMap.budgetMs', W.budgetMs)
  for (const k of PLACE_KINDS) if (!W.placeGlyphs[k]) errs.push(`explore.json worldMap.placeGlyphs: missing "${k}"`)
  for (const k of ['minor', 'grand'] as const) if (!W.anchorGlyphs?.[k]) errs.push(`explore.json worldMap.anchorGlyphs: missing "${k}"`)
  for (const k of ['on', 'off'] as const) if (!W.anchorPalettes?.[k]) errs.push(`explore.json worldMap.anchorPalettes: missing "${k}"`)
  positive('worldMap.pinSpacingUnits', W.pinSpacingUnits)
  positive('worldMap.pinTouchPx', W.pinTouchPx)
  return errs
}
