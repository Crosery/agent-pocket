// The developer-mode data files (content/dev/**) loaded for the browser. Scenarios are one file each and are
// collected with Vite's glob import; Node tests read the same files from disk (tests/dev-scenarios.test.ts).
import type { DevBeat, DevScenario, DevTeam } from '../../shared/types.ts'
import beats from '../../../content/dev/beats.json' with { type: 'json' }
import teams from '../../../content/dev/teams.json' with { type: 'json' }

export interface DevContent {
  scenarios: Record<string, DevScenario>
  beats: Record<string, DevBeat>
  teams: Record<string, DevTeam>
}

export function loadDevContent(): DevContent {
  // @ts-ignore -- import.meta.glob is a Vite compile-time feature (not in the node/tsc lib types)
  const files = import.meta.glob('../../../content/dev/scenarios/*.json', { eager: true, import: 'default' }) as Record<string, DevScenario>
  const scenarios: Record<string, DevScenario> = {}
  for (const sc of Object.values(files)) scenarios[sc.id] = sc
  return { scenarios, beats: beats as unknown as Record<string, DevBeat>, teams: teams as unknown as Record<string, DevTeam> }
}
