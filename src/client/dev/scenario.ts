// Scenarios in the running game (ADR 0002 §4.4): build the save with the shared applier, swap it in, move the
// player, then run the scenario's commands. The same path serves ?scenario=<id> at boot and scenario.load later.
import type { SaveData } from '../../shared/types.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { applyScenario, checkExpectations, flattenScenario, type ExpectResult, type ScenarioResult } from '../../shared/dev/scenario.ts'
import type { SaveManager } from '../contracts.ts'
import type { DevHost } from './kit.ts'
import { CONSOLE, DevError } from './registry.ts'

/** A brand-new save for the first playable avatar (what the title flow's new game would start from). */
export function freshBase(saves: SaveManager): SaveData {
  const avatar = CONTENT.characters.find((c) => c.playable) ?? CONTENT.characters[0]
  return saves.newGame({ name: avatar?.nameZh ?? '', avatar: avatar?.id ?? '' })
}

export function prepareScenario(host: DevHost, id: string): ScenarioResult {
  if (!host.content.scenarios[id]) throw new DevError('dev.err.unknownScenario', { id })
  const res = applyScenario(id, {
    world: host.world, scenarios: host.content.scenarios, beats: host.content.beats, teams: host.content.teams,
    base: freshBase(host.ctx.saves), rng: host.rng.stream('debug'),
  })
  if (res.problems.length) throw new DevError('dev.err.scenarioProblems', { list: res.problems.join('; ') })
  return res
}

export function scenarioList(host: DevHost): { id: string; title: string; seed: number | null; rng: number | null }[] {
  return Object.keys(host.content.scenarios).sort().map((id) => {
    const sc = flattenScenario(id, host.content.scenarios)
    return { id, title: t(sc.titleKey), seed: sc.seed ?? null, rng: sc.rng ?? null }
  })
}

/** Runs the scenario's commands in order (a command that throws stops the sequence). */
export async function runScenarioCommands(host: DevHost, res: ScenarioResult): Promise<void> {
  for (const call of res.commands) await host.run(call)
}

/** Re-checks the expectations until they all hold or `expectSettleMs` passed; returns the last results. */
export async function settleScenario(host: DevHost): Promise<ExpectResult[]> {
  const end = Date.now() + CONSOLE.limits.expectSettleMs
  for (;;) {
    const results = checkScenario(host)
    if (results.every((r) => r.ok) || Date.now() >= end) return results
    await new Promise((r) => setTimeout(r, CONSOLE.limits.waitPollMs))
  }
}

export function checkScenario(host: DevHost): ExpectResult[] {
  const id = host.session.scenario
  if (!id) return []
  return checkExpectations(host.dump(), flattenScenario(id, host.content.scenarios).expect ?? [])
}

/** Swaps the live game over to the scenario (same world seed only: a different seed needs a reload). */
export async function loadScenario(host: DevHost, id: string): Promise<{ id: string; position: SaveData['position']; commands: number }> {
  const res = prepareScenario(host, id)
  const sc = res.scenario
  if (sc.seed !== undefined && sc.seed !== host.world.seed) throw new DevError('dev.err.scenarioSeed', { seed: sc.seed, id })
  if (sc.rng !== undefined) host.rng.reseed(sc.rng)
  const { ctx, overworld } = host
  ctx.save = { ...res.save, settings: { ...ctx.save.settings } }
  ctx.events.emit('party:changed', {})
  ctx.events.emit('bag:changed', {})
  ctx.events.emit('money:changed', { money: ctx.save.money, delta: 0 })
  const p = ctx.save.position
  await overworld.enterMap(p.map, p.x, p.y, p.facing, true)
  host.session.scenario = id
  await runScenarioCommands(host, res)
  return { id, position: p, commands: res.commands.length }
}
