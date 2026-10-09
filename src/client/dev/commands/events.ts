// World events and roaming legends: the gameplay runtime's own hooks (compiled into devtools builds only).
import { GAMEPLAY } from '../../../shared/gameplay/data.ts'
import type { DevHost } from '../kit.ts'
import { DevError, type CommandRun } from '../registry.ts'

const hooks = (host: DevHost): Record<string, (...a: unknown[]) => unknown> => {
  const h = host.overworld.devHandles().gameplayHooks as Record<string, (...a: unknown[]) => unknown> | null
  if (!h) throw new DevError('dev.err.noHooks')
  return h
}

export const eventCommands: Record<string, CommandRun> = {
  /** Starts an event now, ignoring its trigger, chance and environment. */
  'event.start': (host, a) => {
    const id = String(a.event)
    if (!GAMEPLAY.eventById[id]) throw new DevError('dev.err.unknownEvent', { event: id })
    return { event: id, started: hooks(host).start(id) === true }
  },
  'event.end': (host, a) => {
    const id = String(a.event)
    if (!GAMEPLAY.eventById[id]) throw new DevError('dev.err.unknownEvent', { event: id })
    hooks(host).end(id)
    return { event: id }
  },
  /** Forgets every event state (cooldowns, counters, active runs). */
  'event.reset': ({ ctx }) => {
    const n = Object.keys(ctx.save.events ?? {}).length
    ctx.save.events = {}
    return { cleared: n }
  },
  'legend.summon': (host, a) => ({ species: a.species ?? null, summoned: hooks(host).summon(a.species) === true }),
}
