// World knowledge for movement validation. The generator (src/shared/world/) and the tile rules (./geo.ts) are
// loaded lazily; when they are missing or throw, the server runs without map validation (or bounds only).
import type { Dir, World } from '../shared/types.ts'
import type { WorldGeo } from './geo.ts'

export interface MapBounds { width: number; height: number; spawn: { x: number; y: number; facing: Dir } }

export interface WorldInfo {
  /** Static (finite-array) maps of the world. Infinite maps list their core rectangle here. */
  maps: Map<string, MapBounds>
  startMap: string
  badgeIds: Set<string>
  /**
   * Tile rules of the generated world: infinite overworld (any coordinate), lazily generated frontier interiors,
   * step validation (elevation / stairs / ledges / water). Absent = bounds-only validation against `maps`.
   */
  geo?: WorldGeo
}

type WorldModule = { buildWorld?: (seed?: number) => World }
type GeoModule = { createWorldGeo?: (world: World) => WorldGeo }

export async function loadWorldInfo(log: (msg: string) => void = () => {}): Promise<WorldInfo | null> {
  let mod: WorldModule
  try {
    mod = (await import(new URL('../shared/world/index.ts', import.meta.url).href)) as WorldModule
  } catch (err) {
    log(`world module unavailable, movement bounds disabled (${(err as Error).message})`)
    return null
  }
  if (typeof mod.buildWorld !== 'function') { log('world module has no buildWorld(), movement bounds disabled'); return null }
  let world: World
  const maps = new Map<string, MapBounds>()
  try {
    world = mod.buildWorld()
    for (const [id, m] of Object.entries(world.maps)) maps.set(id, { width: m.width, height: m.height, spawn: { ...m.spawn } })
    if (!maps.has(world.startMap)) { log(`world startMap "${world.startMap}" missing, movement bounds disabled`); return null }
  } catch (err) {
    log(`buildWorld() failed, movement bounds disabled (${(err as Error).message})`)
    return null
  }
  const info: WorldInfo = { maps, startMap: world.startMap, badgeIds: new Set((world.badges ?? []).map((b) => b.id)) }
  try {
    const gm = (await import(new URL('./geo.ts', import.meta.url).href)) as GeoModule
    if (typeof gm.createWorldGeo === 'function') info.geo = gm.createWorldGeo(world)
    else log('geo module has no createWorldGeo(), tile validation disabled')
  } catch (err) {
    log(`world rules unavailable, tile validation disabled (${(err as Error).message})`)
  }
  return info
}
