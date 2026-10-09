// Option lists that console.json arguments refer to by name (ArgSpec.enumRef).
import { CONTENT } from '../../shared/content/index.ts'
import { GAME } from '../world/config.ts'
import { PARTY_FIELDS } from './commands/party.ts'
import { LOD_KEYS } from './commands/env.ts'
import type { DevContent } from './content.ts'
import type { EnumRefs } from './registry.ts'

export function devEnums(content: Pick<DevContent, 'scenarios'>): EnumRefs {
  return {
    weather: () => Object.keys(GAME.region.weatherIntensity),
    boss: () => Object.keys(CONTENT.bosses),
    scenario: () => Object.keys(content.scenarios).sort(),
    partyField: () => [...PARTY_FIELDS],
    dexMode: () => ['all', 'type', 'none'],
    lodKey: () => [...LOD_KEYS],
  }
}
