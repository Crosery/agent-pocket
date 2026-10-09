// What a place offers, for the world map's selected-place card: services (the NPC roles inside the interiors named after
// the place), the gym badge, an open quest objective nearby and the wild level range. Pure functions of world + save.
import type { BadgeDef, SaveData, TownDef, World } from '../../../shared/types.ts'
import { t } from '../../../shared/content/index.ts'
import { SCREENS } from './config.ts'
import { overworldPosition } from './logic.ts'

const PANEL = SCREENS.worldMap.panel

export interface PlaceFacts {
  /** Ids of the services (SCREENS.worldMap.panel.services) found in the place's interiors. */
  services: string[]
  gym: { badge: BadgeDef; won: boolean } | null
  quest: boolean
  levels: [number, number] | null
}

const SERVICES = new WeakMap<World, Map<string, Set<string>>>()

function servicesOf(world: World, placeId: string): Set<string> {
  let byPlace = SERVICES.get(world)
  if (!byPlace) {
    byPlace = new Map()
    SERVICES.set(world, byPlace)
  }
  let found = byPlace.get(placeId)
  if (!found) {
    found = new Set()
    const prefix = `${placeId}-`
    for (const m of Object.values(world.maps)) {
      if (m.kind !== 'interior' || !m.id.startsWith(prefix)) continue
      for (const n of m.npcs ?? []) for (const sv of PANEL.services) if (n.role === sv.npcRole) found.add(sv.id)
    }
    byPlace.set(placeId, found)
  }
  return found
}

/** Does an open quest point at (or inside) this place? */
function questHere(world: World, save: SaveData, place: TownDef): boolean {
  for (const q of world.quests) {
    const p = save.quests[q.id]
    if (!p || p.done) continue
    const target = q.stages[Math.max(0, Math.min(q.stages.length - 1, p.stage))]?.target
    if (!target) continue
    const at = overworldPosition(world, target.map, target.x, target.y)
    if (at && Math.hypot(at.x - place.x, at.y - place.y) <= PANEL.questRadius) return true
  }
  return false
}

export function placeFacts(world: World, save: SaveData, place: TownDef): PlaceFacts {
  const badge = world.badges.find((b) => b.town === place.id)
  return {
    services: PANEL.services.filter((sv) => servicesOf(world, place.id).has(sv.id)).map((sv) => sv.id),
    gym: badge ? { badge, won: save.badges.includes(badge.id) } : null,
    quest: questHere(world, save, place),
    levels: place.levelRange ?? null,
  }
}

/** "21 格", or "1.4 千格" once the distance reads better in thousands. */
export function humanDistance(tiles: number): string {
  const n = Math.max(0, Math.round(tiles))
  return n >= PANEL.farAbove ? t('screens.map.distFar', { n: (n / 1000).toFixed(1) }) : t('screens.map.distTiles', { n })
}
