// Baseline commands: where the player is, what time and weather it is. Same effects as the legacy window.__ap hooks.
import { getMap } from '../../../shared/world/worldapi.ts'
import { anchorSpotFromId, anchorsInRect } from '../../../shared/world/anchors.ts'
import { unlockAnchor, unlockedAnchors } from '../../world/anchors.ts'
import { resolvePlace } from '../../world/explore.ts'
import { DevError, type CommandRun } from '../registry.ts'

export const basicCommands: Record<string, CommandRun> = {
  /** Teleport (normal map-enter flow) to a tile of any map; the map defaults to the overworld. */
  'tp.xy': async ({ overworld, world }, a) => {
    const map = typeof a.map === 'string' ? a.map : world.startMap
    if (!getMap(world, map)) throw new DevError('dev.err.badArg', { arg: 'map', why: map })
    await overworld.enterMap(map, Math.floor(a.x as number), Math.floor(a.y as number), 'down', true)
    return { map, x: Math.floor(a.x as number), y: Math.floor(a.y as number) }
  },
  fly: async ({ flyTo, world }, a) => {
    const place = String(a.place)
    if (!resolvePlace(world, place)) throw new DevError('dev.err.unknownPlace', { place })
    await flyTo(place)
    return { place }
  },
  discover: ({ ctx, world }, a) => {
    const place = String(a.place)
    if (!resolvePlace(world, place)) throw new DevError('dev.err.unknownPlace', { place })
    const list = ctx.save.discoveredPlaces ?? (ctx.save.discoveredPlaces = [])
    if (!list.includes(place)) list.push(place)
    return { place, discovered: list.length }
  },
  /** Activates one teleport anchor by id, or every anchor within `radius` tiles of the player. */
  'anchor.unlock': ({ ctx, overworld, world }, a) => {
    const map = getMap(world, world.startMap)
    let ids: string[] = []
    if (typeof a.id === 'string' && a.id) {
      if (!anchorSpotFromId(a.id)) throw new DevError('dev.err.badArg', { arg: 'id', why: a.id })
      ids = [a.id]
    } else if (map) {
      const p = overworld.player
      const r = Math.max(0, typeof a.radius === 'number' ? a.radius : 0)
      ids = anchorsInRect(map, Math.floor(p.x - r), Math.floor(p.y - r), Math.ceil(p.x + r) + 1, Math.ceil(p.y + r) + 1).map((s) => s.id)
    }
    const fresh = ids.filter((id) => unlockAnchor(ctx.save, id)).length
    return { unlocked: fresh, total: unlockedAnchors(ctx.save).length }
  },
  'clock.set': ({ ctx }, a) => {
    ctx.clock.minutes = Math.max(0, a.minutes as number)
    return { label: ctx.clock.label(), minutes: ctx.clock.minutes }
  },
  /** Holds the in-game clock still (or releases it); time.* controls frames, this controls the day/night clock. */
  'clock.freeze': ({ clock }, a) => { clock.hold(a.on as boolean); return { held: clock.held() } },
  'weather.set': ({ overworld }, a) => {
    overworld.setWeatherOverride((a.kind as string | undefined ?? null) as never)
    return { weather: a.kind ?? null }
  },
}
