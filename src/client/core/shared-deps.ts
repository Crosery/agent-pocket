// Bridges to shared modules owned by other agents (world generator, creature rules).
import type { Creature, World } from '../../shared/types.ts'
import type { Content } from '../../shared/content/index.ts'
import { sanitizeCreature } from '../../shared/creature.ts'
import { buildWorld } from '../../shared/world/index.ts'

/** Builds the deterministic world (only used when the save manager is not handed GameData.world). */
export function defaultBuildWorld(): World | null {
  return buildWorld()
}

export function defaultSanitizeCreature(raw: unknown, c: Content): Creature | null {
  return sanitizeCreature(raw, c)
}
