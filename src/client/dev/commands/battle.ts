// Starting fights. They return at once (the battle runs on); wait.battle('active' | 'idle') follows them.
import { CONTENT } from '../../../shared/content/index.ts'
import type { DevHost } from '../kit.ts'
import { DevError, type CommandRun } from '../registry.ts'

const guard = (host: DevHost): void => { if (host.overworld.battleActive) throw new DevError('dev.err.battleBusy') }
const fire = (p: Promise<unknown>, what: string): void => { p.catch((err) => console.error(`[dev] ${what} failed`, err)) }

export const battleCommands: Record<string, CommandRun> = {
  'battle.wild': (host, a) => {
    const id = String(a.species)
    if (!CONTENT.species[id]) throw new DevError('dev.err.unknownSpecies', { species: id })
    guard(host)
    const level = Math.max(1, Math.floor((a.level as number | undefined) ?? 20))
    fire(host.overworld.startWildBattle(id, level), 'wild battle')
    return { species: id, level }
  },
  'battle.trainer': (host, a) => {
    const id = String(a.trainer)
    if (!host.world.trainers[id]) throw new DevError('dev.err.unknownTrainer', { trainer: id })
    guard(host)
    fire(host.overworld.startTrainerBattle(id), 'trainer battle')
    return { trainer: id }
  },
  /** A boss fight with the current party at the boss's level (or `level`). */
  'battle.boss': (host, a) => {
    const id = String(a.boss)
    const def = CONTENT.bosses[id]
    if (!def) throw new DevError('dev.err.unknownBoss', { boss: id })
    guard(host)
    const level = Math.max(1, Math.floor((a.level as number | undefined) ?? def.level))
    fire(host.overworld.startWildBattle(def.species, level), 'boss battle')
    return { boss: id, species: def.species, level }
  },
}
