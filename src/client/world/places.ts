// Place lookup for the gameplay runtime and map screens (finite maps and the infinite overworld) plus the map pings
// shown on the world map / minimap: roaming-legend pings, active event anchors, MYTHIC chain steps and places
// revealed by ScriptStep 'revealPlace'. DOM-free.
//
// Event conditions refer to places by template ('monolith', 'nearest:datacenter'): core POIs already have ids of the
// form '<template>-<n>', frontier landmarks ('fx:landmark:…') get one alias id '<template>-@<id>' per template they
// count as (their own + common.json templateAliases), so the shared matching (id === ref || id starts with ref + '-')
// treats both alike. realPlaceId() maps an alias back.
import type { GameMap, SaveData, TownDef, World } from '../../shared/types.ts'
import { t } from '../../shared/content/index.ts'
import { GAMEPLAY } from '../../shared/gameplay/data.ts'
import { activeEvents, eventTitle } from '../../shared/gameplay/events.ts'
import { bandOf, legendPings } from '../../shared/gameplay/spawns.ts'
import { distanceFromOrigin, worldOrigin } from '../../shared/world/worldapi.ts'
import { FRONTIER_PACK } from '../../shared/world/frontier/content/data.ts'
import { GPC, pingColor } from './gameplay-config.ts'

const ALIAS = '-@'

interface FrontierLike {
  placesIn?(x0: number, y0: number, x1: number, y1: number): TownDef[]
  place?(id: string): TownDef | null
  siteOf?(id: string): { site: { template: string }; part: string | null } | null
}

const providerOf = (map: GameMap | undefined | null): FrontierLike | null => (map?.infinite as unknown as FrontierLike | undefined) ?? null

export function realPlaceId(id: string): string {
  const i = id.indexOf(ALIAS)
  return i >= 0 ? id.slice(i + ALIAS.length) : id
}

/** A frontier place under its template alias plus the templates it also counts as (frontier-content common.json
 * templateAliases: a 'stele' is a 'monolith', a 'serverfarm' a 'datacenter', ...), so authored refs match it. */
function withAliases(p: TownDef, prov: FrontierLike | null): TownDef[] {
  const tpl = prov?.siteOf?.(p.id)?.site.template
  if (!tpl || p.id.startsWith(`${tpl}-`)) return [p]
  return [tpl, ...(FRONTIER_PACK.common.templateAliases[tpl] ?? [])].map((a) => ({ ...p, id: `${a}${ALIAS}${p.id}` }))
}

/** Places of `map` within `r` tiles of (x, y) (square), frontier landmarks aliased by template. */
export function placesNear(world: World, map: GameMap, x: number, y: number, r: number): TownDef[] {
  const prov = providerOf(map)
  if (prov?.placesIn) return prov.placesIn(Math.floor(x - r), Math.floor(y - r), Math.ceil(x + r), Math.ceil(y + r)).flatMap((p) => withAliases(p, prov))
  return world.towns.filter((tw) => tw.map === map.id && Math.abs(tw.x - x) <= r && Math.abs(tw.y - y) <= r)
}

/** A place by (real or alias) id: world.towns, else the infinite overworld's provider. */
export function placeById(world: World, id: string): TownDef | null {
  const real = realPlaceId(id)
  const core = world.towns.find((tw) => tw.id === real)
  if (core) return core
  for (const key in world.maps) {
    const p = providerOf(world.maps[key])?.place?.(real)
    if (p) return p
  }
  return null
}

/** Places revealed by events (ScriptStep / effect 'revealPlace') within the ping window, newest first. */
export function revealedPlaces(save: Pick<SaveData, 'flags'>, minutes: number): { id: string; flag: string; at: number }[] {
  const prefix = GPC.flags.revealed
  const out: { id: string; flag: string; at: number }[] = []
  for (const [flag, v] of Object.entries(save.flags)) {
    if (!flag.startsWith(prefix) || typeof v !== 'number' || minutes - v > GPC.places.revealPingMinutes) continue
    out.push({ id: flag.slice(prefix.length), flag, at: v })
  }
  return out.sort((a, b) => b.at - a.at)
}

// ---------------------------------------------------------------------------------------------- pings

export type MapPingKind = 'legend' | 'mythic' | 'event' | 'place'

export interface MapPing {
  kind: MapPingKind
  id: string
  map: string
  x: number
  y: number
  /** Fuzz radius in tiles (0 = exact). */
  radius: number
  color: string
  label: string
}

export interface PingSources {
  world: World
  save: Pick<SaveData, 'legends' | 'events' | 'flags' | 'maxDistance'>
  minutes: number
  /** Player position on the overworld (for the legend bands to show). */
  player: { x: number; y: number } | null
}

const startMapOf = (world: World): GameMap | undefined => world.maps[world.startMap]

/** Pings for the world map / minimap. Legends: bands 0..(farthest band reached + 1). */
export function mapPings(s: PingSources): MapPing[] {
  const out: MapPing[] = []
  const ow = startMapOf(s.world)
  if (!ow) return out
  const origin = worldOrigin(s.world)
  const reach = Math.max(s.save.maxDistance ?? 0, s.player ? distanceFromOrigin(s.world, s.player.x, s.player.y) : 0)
  const bands = Array.from({ length: bandOf(reach) + 2 }, (_, i) => i)
  for (const p of legendPings(origin, s.minutes, s.world.seed, s.save.legends ?? {}, bands)) {
    out.push({
      kind: 'legend', id: `legend:${p.species}`, map: ow.id, x: p.x, y: p.y, radius: p.radius,
      color: pingColor('legend', p.cue), label: t('events.ui.legendPing', { title: t(`events.legend.${p.species}.title`) }),
    })
  }
  for (const ev of activeEvents(s.save.events ?? {}, s.minutes)) {
    if (!ev.anchor || ev.def.trigger === 'legend') continue
    const chain = ev.def.chain ? GAMEPLAY.chainById[ev.def.chain] : undefined
    if (chain) {
      out.push({ kind: 'mythic', id: `event:${ev.id}`, map: ev.anchor.map, x: ev.anchor.x, y: ev.anchor.y, radius: 0, color: pingColor('mythic'), label: t(`events.chain.${chain.id}.name`) })
    } else if (!ev.def.hidden && ev.def.scope !== 'global') {
      out.push({ kind: 'event', id: `event:${ev.id}`, map: ev.anchor.map, x: ev.anchor.x, y: ev.anchor.y, radius: 0, color: pingColor('event'), label: eventTitle(ev.def) })
    }
  }
  for (const r of revealedPlaces(s.save, s.minutes)) {
    const p = placeById(s.world, r.id)
    if (p) out.push({ kind: 'place', id: `place:${p.id}`, map: p.map, x: p.x, y: p.y, radius: 0, color: pingColor('place'), label: p.nameZh })
  }
  return out
}
