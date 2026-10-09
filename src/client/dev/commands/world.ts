// Where the player is and which world they are in: seed, anchors, places, story beats.
import { applyBeat, resolveDevPlace } from '../../../shared/dev/scenario.ts'
import { worldAnchors } from '../../../shared/world/index.ts'
import { flyLanding, resolvePlace } from '../../world/explore.ts'
import type { DevHost } from '../kit.ts'
import { CONSOLE, DevError, type CommandRun } from '../registry.ts'

/** Saves the game into the developer's reload slot and reopens the page with the new world seed (a world cannot be rebuilt under a running game). */
function reloadWith(host: DevHost, seed: number): { reloading: string } {
  const slot = CONSOLE.limits.reloadSlot
  host.ctx.persist('dev')
  host.ctx.saves.write(host.ctx.save, slot)
  const q = new URLSearchParams(location.search)
  q.set('dev', '1'); q.set('skipTitle', '1'); q.set('slot', String(slot)); q.set('seed', String(seed)); q.delete('reset'); q.delete('scenario')
  const url = `${location.pathname}?${q.toString()}`
  setTimeout(() => location.assign(url), 60)
  return { reloading: url }
}

async function goTo(host: DevHost, at: { map: string; x: number; y: number }): Promise<{ map: string; x: number; y: number }> {
  await host.overworld.enterMap(at.map, Math.floor(at.x), Math.floor(at.y), 'down', true)
  return { map: at.map, x: Math.floor(at.x), y: Math.floor(at.y) }
}

export const worldCommands: Record<string, CommandRun> = {
  'world.seed': (host, a) => {
    const seed = a.seed as number
    if (!(seed >= 0 && seed <= 0xffffffff)) throw new DevError('dev.err.badArg', { arg: 'seed', why: new DevError('dev.err.seedRange').message })
    return reloadWith(host, seed)
  },
  'world.seedRandom': (host) => reloadWith(host, Math.floor(Math.random() * 0xffffffff)),
  'tp.anchor': (host, a) => {
    const id = String(a.anchor)
    const at = worldAnchors(host.world)[id]
    if (!at) throw new DevError('dev.err.unknownAnchor', { anchor: id })
    return goTo(host, at)
  },
  'tp.place': async (host, a) => {
    const id = String(a.place)
    const place = resolvePlace(host.world, id)
    const land = place ? flyLanding(host.world, place) : null
    if (!place || !land) throw new DevError('dev.err.unknownPlace', { place: id })
    const list = host.ctx.save.discoveredPlaces ?? (host.ctx.save.discoveredPlaces = [])
    if (!list.includes(id)) list.push(id)
    return goTo(host, { map: land.map.id, x: land.x, y: land.y })
  },
  /** Applies a story beat (badges, beaten trainers, quest stages, flags) and, unless `stay`, stands at its place. */
  'beat.apply': async (host, a) => {
    const id = String(a.beat)
    const beat = host.content.beats[id]
    if (!beat) throw new DevError('dev.err.unknownBeat', { beat: id })
    applyBeat(host.ctx.save, beat)
    const { ctx } = host
    ctx.events.emit('party:changed', {})
    for (const q of Object.entries(beat.quests ?? {})) ctx.events.emit('quest:updated', { questId: q[0], stage: q[1].stage, done: q[1].done })
    const at = beat.place && !a.stay ? resolveDevPlace(host.world, beat.place) : null
    return { beat: id, at: at ? await goTo(host, at) : null, badges: ctx.save.badges.length }
  },
}
