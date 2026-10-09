// Canonical state export (window.__ap.v1.state): save, runtime and world sections as JSON-safe plain data.
import { worldBuildInfo } from '../../shared/world/index.ts'
import { regionAt } from '../../shared/world/worldapi.ts'
import { getMap } from '../../shared/world/worldapi.ts'
import { canonical, digest } from '../../shared/dev/diff.ts'
import type { EventLog } from './events.ts'
import type { DevHost } from './kit.ts'

export type Section = 'save' | 'runtime' | 'world'
export const SECTIONS: readonly Section[] = ['save', 'runtime', 'world']

/** Extra runtime facts owned by other dev modules (rng cursors, scenario id, ...). */
export type RuntimeExtras = () => Record<string, unknown>

const r3 = (n: number) => Math.round(n * 1000) / 1000

export function runtimeState(host: DevHost, log: EventLog, extras: RuntimeExtras = () => ({})): Record<string, unknown> {
  const { ctx, overworld: ow, world } = host
  const p = ow.player
  const map = ow.mapId ? getMap(world, ow.mapId) : null
  const region = map ? regionAt(map, p.x, p.y) : null
  const nav = ow.questNavigation
  const events = log.since(0).events
  const lastStart = [...events].reverse().find((e) => e.type === 'battle:start')
  const bossId = events.filter((e) => e.seq > (lastStart?.seq ?? 0) && e.type === 'battle:events')
    .flatMap((e) => (e.payload as { events?: { t: string; hud?: { bossId?: string } }[] }).events ?? [])
    .find((ev) => ev.t === 'boss')?.hud?.bossId ?? null
  const lastEnd = [...events].reverse().find((e) => e.type === 'battle:end')
  const html = document.documentElement
  const battleUp = ow.battleActive || html.classList.contains('ap-battle-on')
  const screens = [...document.querySelectorAll<HTMLElement>('[class*="aps-"]')]
    .map((el) => [...el.classList].find((c) => c.startsWith('aps-'))?.slice(4) ?? '')
    .filter((id, i, all) => id && all.indexOf(id) === i)
  return canonical({
    map: ow.mapId,
    position: { x: r3(p.x), y: r3(p.y), elev: r3(p.elev), facing: p.facing },
    mode: ow.mode,
    free: ow.free,
    battle: {
      active: battleUp,
      kind: battleUp ? ((lastStart?.payload as { kind?: string } | undefined)?.kind ?? null) : null,
      boss: battleUp ? bossId : null,
      lastKind: (lastEnd?.payload as { kind?: string } | undefined)?.kind ?? null,
      lastResult: (lastEnd?.payload as { result?: unknown } | undefined)?.result ?? null,
    },
    weather: ow.weather,
    clock: { minutes: r3(ctx.clock.minutes), label: ctx.clock.label(), timeOfDay: ctx.clock.timeOfDay },
    region: region ? { id: region.id, nameZh: region.nameZh, danger: region.danger ?? null } : null,
    quest: nav ? { questId: nav.questId, status: nav.status, target: nav.target, waypoint: nav.waypoint, steps: nav.steps } : null,
    onboarding: { objective: host.onboarding.objectiveId },
    ui: { blocking: ctx.ui.isBlocking(), screens },
    net: { status: ctx.net.status, online: ctx.net.online, selfId: ctx.net.selfId },
    ...extras(),
  }) as Record<string, unknown>
}

export function worldState(host: DevHost): Record<string, unknown> {
  const w = host.world
  const info = worldBuildInfo(w)
  return canonical({
    seed: w.seed,
    startMap: w.startMap,
    maps: Object.keys(w.maps).length,
    towns: w.towns.length,
    problems: info.problems.length,
  }) as Record<string, unknown>
}

export function dumpState(host: DevHost, log: EventLog, extras: RuntimeExtras, sections: readonly Section[] = SECTIONS): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const s of sections) {
    if (s === 'save') out.save = canonical(host.ctx.save)
    else if (s === 'runtime') out.runtime = runtimeState(host, log, extras)
    else if (s === 'world') out.world = worldState(host)
  }
  return out
}

export const stateDigest = (state: Record<string, unknown>): string => digest(state)
