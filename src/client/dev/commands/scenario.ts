// Scenario loading and the battle starter scenarios rely on.
import { CONTENT } from '../../../shared/content/index.ts'
import { loadScenario } from '../scenario.ts'
import { DevError, type CommandRun } from '../registry.ts'

export const scenarioCommands: Record<string, CommandRun> = {
  'scenario.load': (host, a) => loadScenario(host, String(a.id)),
  /** Starts a boss fight with the current party at the boss's level (or `level`). Returns at once; wait.battle('active') follows. */
  'battle.boss': ({ overworld }, a) => {
    const id = String(a.boss)
    const def = CONTENT.bosses[id]
    if (!def) throw new DevError('dev.err.unknownBoss', { boss: id })
    if (overworld.battleActive) throw new DevError('dev.err.battleBusy')
    const level = Math.max(1, Math.floor((a.level as number | undefined) ?? def.level))
    overworld.startWildBattle(def.species, level).catch((err) => console.error('[dev] boss battle failed', err))
    return { boss: id, species: def.species, level }
  },
}
