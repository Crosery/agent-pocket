// Scenario loading.
import { loadScenario } from '../scenario.ts'
import type { CommandRun } from '../registry.ts'

export const scenarioCommands: Record<string, CommandRun> = {
  'scenario.load': (host, a) => loadScenario(host, String(a.id)),
}
