// Baseline commands: where the player is, what time and weather it is. Same effects as the legacy window.__ap hooks.
import { getMap } from '../../../shared/world/worldapi.ts'
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
  'clock.set': ({ ctx }, a) => {
    ctx.clock.minutes = Math.max(0, a.minutes as number)
    return { label: ctx.clock.label(), minutes: ctx.clock.minutes }
  },
  'weather.set': ({ overworld }, a) => {
    overworld.setWeatherOverride((a.kind as string | undefined ?? null) as never)
    return { weather: a.kind ?? null }
  },
}
