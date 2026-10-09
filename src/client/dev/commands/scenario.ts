// Scenario loading.
import { checkScenario, loadScenario } from '../scenario.ts'
import { DevError, type CommandRun } from '../registry.ts'

export const scenarioCommands: Record<string, CommandRun> = {
  'scenario.load': (host, a) => loadScenario(host, String(a.id)),
  /** The scenario through its own URL: the way to enter one whose world seed differs from the running world's. */
  'scenario.open': (host, a) => {
    const id = String(a.id)
    if (!host.content.scenarios[id]) throw new DevError('dev.err.unknownScenario', { id })
    const url = `${location.pathname}?${new URLSearchParams({ dev: '1', scenario: id }).toString()}`
    setTimeout(() => location.assign(url), 60)
    return { reloading: url }
  },
  'scenario.check': (host) => {
    const results = checkScenario(host)
    return { scenario: host.session.scenario, ok: results.every((r) => r.ok), results }
  },
}
