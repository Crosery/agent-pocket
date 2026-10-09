// Developer tooling entry. Loaded by src/client/game.ts through a dynamic import behind DEVTOOLS, so it lives
// in its own chunk that the production build never emits. Even in a devtools build it stays dormant until
// the page is opened with ?dev=1 (readDebugParams).
import { CONTENT } from '../../shared/content/index.ts'
import { worldAnchors } from '../../shared/world/index.ts'
import { validateTutorial } from '../onboarding/config.ts'
import { GAME, validateGameContent } from '../world/config.ts'
import { RngHub } from '../core/rng-hub.ts'
import { createApiV1, mountApi } from './api.ts'
import { createDevClock } from './clock.ts'
import { COMMANDS } from './commands/index.ts'
import { ENUMS } from './enums.ts'
import { createEventLog } from './events.ts'
import type { DevHost, DevKit } from './kit.ts'
import { applyDebugStart, debugSave, installDebugHooks, installDevLog, runDebugActions } from './legacy.ts'
import { readDebugParams } from './params.ts'
import { CONSOLE, createRegistry } from './registry.ts'
import { installDevText } from './text.ts'

/** Marks the devtools bundle (content/dev/gate.json `sentinel`): required there by scripts/check-dev-gate.mjs, forbidden in the production build. */
export const DEV_SENTINEL = '__AP_DEV_SENTINEL'

export function createDevKit(search: string): DevKit | null {
  const dbg = readDebugParams(search)
  if (!dbg.dev) return null
  installDevText()
  installDevLog()
  for (const e of validateGameContent()) console.warn(`[game] ${e}`)
  const clock = createDevClock()
  /** The game's random hub, known once the overworld exists (install); a throwaway one before that. */
  let hub: RngHub | null = null
  return {
    slot: dbg.slot,
    skipTitle: dbg.skipTitle,
    worldSeed: dbg.seed,
    rngSeed: dbg.rng,
    frameDt: (real) => clock.frameDt(real),
    clockFrozen: () => dbg.time !== null && GAME.debug.freezeClockWithTime,
    afterWorld(world) {
      for (const e of validateTutorial(world, worldAnchors(world))) console.warn(`[onboarding] ${e}`)
      if (dbg.reset) localStorage.removeItem(`${CONTENT.config.save.storagePrefix}${dbg.slot}`)
    },
    newSave: (saves, world) => debugSave(saves, world, (hub ?? new RngHub()).stream('debug')),
    applyStart: (ctx, world) => applyDebugStart(ctx, world, dbg),
    install(game) {
      hub = game.overworld.devHandles().rng
      const host: DevHost = { ...game, rng: hub, clock }
      const { ctx, overworld, world, onboarding, flyTo } = host
      const w = window as unknown as Record<string, unknown>
      w.__AP = ctx
      w.__apOnboarding = onboarding
      installDebugHooks(ctx, overworld, world, { flyTo })
      ;(w.__ap as Record<string, unknown>).build = { devtools: true, sentinel: DEV_SENTINEL }
      const registry = createRegistry(host, COMMANDS, { enums: ENUMS })
      const log = createEventLog(ctx.events, CONSOLE.limits.eventBuffer)
      mountApi(createApiV1({ host, registry, log, extras: () => ({ rng: { seed: host.rng.seed, cursors: host.rng.cursors() }, time: clock.state() }) }))
    },
    runActions: (ctx, overworld, world, screens) => runDebugActions(ctx, overworld, world, dbg, screens),
  }
}
