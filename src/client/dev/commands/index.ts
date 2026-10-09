// Every command handler, merged; ids must match content/dev/console.json (tests/dev-api.test.ts).
import type { CommandRun } from '../registry.ts'
import { basicCommands } from './basic.ts'
import { battleCommands } from './battle.ts'
import { determinismCommands } from './determinism.ts'
import { editorCommands } from './editor.ts'
import { envCommands } from './env.ts'
import { eventCommands } from './events.ts'
import { itemCommands } from './items.ts'
import { netCommands } from './net.ts'
import { onboardingCommands } from './onboarding.ts'
import { partyCommands } from './party.ts'
import { scenarioCommands } from './scenario.ts'
import { storyCommands } from './story.ts'
import { uiCommands } from './ui.ts'
import { worldCommands } from './world.ts'

export const COMMANDS: Record<string, CommandRun> = {
  ...basicCommands, ...determinismCommands, ...scenarioCommands, ...worldCommands, ...storyCommands, ...eventCommands,
  ...partyCommands, ...itemCommands, ...battleCommands, ...envCommands, ...onboardingCommands, ...netCommands, ...editorCommands, ...uiCommands,
}
