// Every command handler, merged; ids must match content/dev/console.json (tests/dev-api.test.ts).
import type { CommandRun } from '../registry.ts'
import { basicCommands } from './basic.ts'

export const COMMANDS: Record<string, CommandRun> = { ...basicCommands }
