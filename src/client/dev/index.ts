// Developer tooling entry. Loaded by src/client/game.ts through a dynamic import behind __AP_DEVTOOLS__, so it lives
// in its own chunk that the production build never emits. Even in a devtools build it stays dormant until
// the page is opened with ?dev=1 or &scenario=<id> (readDebugParams).
import { CONTENT, t } from '../../shared/content/index.ts'
import { flattenScenario, type ScenarioResult } from '../../shared/dev/scenario.ts'
import { worldAnchors } from '../../shared/world/index.ts'
import type { StorageLike } from '../core/save.ts'
import { RngHub } from '../core/rng-hub.ts'
import { validateTutorial } from '../onboarding/config.ts'
import { GAME, validateGameContent } from '../world/config.ts'
import { createApiV1, mountApi } from './api.ts'
import { createDevClock } from './clock.ts'
import { COMMANDS } from './commands/index.ts'
import { loadDevContent } from './content.ts'
import { devEnums } from './enums.ts'
import { createEventLog } from './events.ts'
import type { DevHost, DevKit } from './kit.ts'
import { applyDebugStart, debugSave, installDebugHooks, installDevLog, runDebugActions } from './legacy.ts'
import { createNetSim, type SocketCtor } from './net-sim.ts'
import { NET_SIM } from './net-config.ts'
import { readDebugParams } from './params.ts'
import { CONSOLE, createRegistry } from './registry.ts'
import { prepareScenario, runScenarioCommands, settleScenario } from './scenario.ts'
import { dumpState } from './state.ts'
import { installDevText } from './text.ts'
import { mountPanel } from './ui/panel.ts'

/** Marks the devtools bundle (content/dev/gate.json `sentinel`): required there by scripts/check-dev-gate.mjs, forbidden in the production build. */
export const DEV_SENTINEL = '__AP_DEV_SENTINEL'

const memoryStorage = (): StorageLike => {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) }, removeItem: (k) => { m.delete(k) } }
}

export function createDevKit(search: string): DevKit | null {
  const dbg = readDebugParams(search)
  if (!dbg.dev) return null
  installDevText()
  installDevLog()
  for (const e of validateGameContent()) console.warn(`[game] ${e}`)
  const content = loadDevContent()
  const scenario = dbg.scenario && content.scenarios[dbg.scenario] ? flattenScenario(dbg.scenario, content.scenarios) : null
  if (dbg.scenario && !scenario) console.error(`[dev] unknown scenario "${dbg.scenario}"`)
  const clock = createDevClock()
  /** The game's random hub, known once the overworld exists (install); a throwaway one before that. */
  let hub: RngHub | null = null
  let host: DevHost | null = null
  let prepared: ScenarioResult | null = null
  /** Where the scenario puts the player: the title flow's new-game start would otherwise overwrite the save's position. */
  let placed: Pick<ScenarioResult['save'], 'position' | 'respawn'> | null = null
  return {
    slot: dbg.slot,
    skipTitle: dbg.skipTitle || !!scenario,
    storage: scenario && !dbg.slotExplicit ? memoryStorage() : null,
    worldSeed: dbg.seed ?? scenario?.seed ?? null,
    rngSeed: dbg.rng ?? scenario?.rng ?? null,
    frameDt: (real) => clock.frameDt(real),
    clockFrozen: () => clock.held() || (dbg.time !== null && GAME.debug.freezeClockWithTime),
    afterWorld(world) {
      for (const e of validateTutorial(world, worldAnchors(world))) console.warn(`[onboarding] ${e}`)
      if (dbg.reset) localStorage.removeItem(`${CONTENT.config.save.storagePrefix}${dbg.slot}`)
    },
    newSave(saves, world) {
      if (scenario && host) {
        try {
          prepared = prepareScenario(host, scenario.id)
          placed = { position: { ...prepared.save.position }, respawn: { ...prepared.save.respawn } }
          if (prepared.scenario.clock?.frozen) clock.hold(true)
          return prepared.save
        } catch (err) { console.error(`[dev] scenario ${scenario.id} could not be applied`, err) }
      }
      return debugSave(saves, world, (hub ?? new RngHub()).stream('debug'))
    },
    applyStart(ctx, world) {
      // The title flow put a new save at the start anchor; the scenario's place wins over that.
      if (placed) { ctx.save.position = { ...placed.position }; ctx.save.respawn = { ...placed.respawn } }
      applyDebugStart(ctx, world, dbg)
    },
    install(game) {
      hub = game.overworld.devHandles().rng
      const log = createEventLog(game.ctx.events, CONSOLE.limits.eventBuffer)
      // Installed before net.connect(): the client then opens DevSockets, which pass straight through until a link or the fake server is asked for.
      const net = createNetSim({
        Real: (window.WebSocket as unknown as SocketCtor | undefined) ?? null,
        config: NET_SIM,
        text: { motd: t('dev.net.motd'), peerName: (n) => t('dev.net.peerName', { n }), unsupported: t('dev.net.unsupported') },
        avatars: CONTENT.characters.filter((c) => c.playable).map((c) => c.id),
      })
      net.install(window)
      const extras = () => ({ rng: { seed: h.rng.seed, cursors: h.rng.cursors() }, time: clock.state(), scenario: h.session.scenario, netSim: net.state() })
      const h: DevHost = {
        ...game, rng: hub, clock, content, net, session: { scenario: null },
        run: (call) => registry.run(call.cmd, call.args),
        dump: (sections) => dumpState(h, log, extras, sections),
      }
      host = h
      const { ctx, overworld, world, onboarding, flyTo } = h
      const w = window as unknown as Record<string, unknown>
      w.__AP = ctx
      w.__apOnboarding = onboarding
      installDebugHooks(ctx, overworld, world, { flyTo })
      ;(w.__ap as Record<string, unknown>).build = { devtools: true, sentinel: DEV_SENTINEL }
      const registry = createRegistry(h, COMMANDS, { enums: devEnums(content) })
      mountApi(createApiV1({ host: h, registry, log, extras }))
      mountPanel(h, registry)
    },
    async runActions(ctx, overworld, world, screens) {
      if (host && prepared) {
        host.session.scenario = prepared.id
        try {
          await runScenarioCommands(host, prepared)
          const failed = (await settleScenario(host)).filter((r) => !r.ok)
          for (const f of failed) console.error(`[dev] scenario ${prepared.id}: ${f.path} expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`)
        } catch (err) { console.error(`[dev] scenario ${prepared.id} failed`, err) }
      }
      await runDebugActions(ctx, overworld, world, dbg, screens)
    },
  }
}
