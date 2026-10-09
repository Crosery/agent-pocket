// Condition waits for automation (window.__ap.v1.wait): no fixed sleeps, a timeout that explains itself.
import { t } from '../../shared/content/index.ts'
import type { EventLog, LoggedEvent } from './events.ts'
import { partialMatch } from './diff.ts'
import type { DevHost } from './kit.ts'

export interface WaitOpts { timeoutMs?: number }

export interface WaitConfig { timeoutMs: number; pollMs: number }

/** Polls `cond` until it returns something truthy; rejects with `what` plus `dump()` after the timeout. */
export function poll<T>(cond: () => T | null | undefined | false, what: string, cfg: WaitConfig, o: WaitOpts = {}, dump: () => string = () => ''): Promise<T> {
  const timeoutMs = o.timeoutMs ?? cfg.timeoutMs
  const end = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v: T | null | undefined | false = null
      try { v = cond() } catch (err) { reject(err); return }
      if (v) { resolve(v); return }
      if (Date.now() >= end) { reject(new Error(`${t('dev.wait.timeout', { what, ms: timeoutMs })}\n${dump()}`)); return }
      setTimeout(tick, cfg.pollMs)
    }
    tick()
  })
}

const BATTLE_CLASS = 'ap-battle-on'

export interface Waiters {
  ready(o?: WaitOpts): Promise<true>
  free(o?: WaitOpts): Promise<true>
  map(id: string, o?: WaitOpts): Promise<string>
  battle(phase: 'active' | 'idle', o?: WaitOpts): Promise<true>
  screen(id: string, o?: WaitOpts): Promise<true>
  event(name: string, match?: unknown, o?: WaitOpts): Promise<LoggedEvent>
}

export function createWaiters(host: DevHost, log: EventLog, cfg: WaitConfig, dump: () => string): Waiters {
  const ow = host.overworld
  const battleUp = () => ow.battleActive || document.documentElement.classList.contains(BATTLE_CLASS)
  return {
    ready: (o) => poll(() => ow.mapId !== null && (ow.mapId ? true : false), 'ready', cfg, o, dump) as Promise<true>,
    free: (o) => poll(() => ow.free, 'free', cfg, o, dump) as Promise<true>,
    map: (id, o) => poll(() => ow.mapId === id && id, `map ${id}`, cfg, o, dump),
    battle: (phase, o) => poll(() => (phase === 'active' ? battleUp() : !battleUp()), `battle ${phase}`, cfg, o, dump) as Promise<true>,
    screen: (id, o) => poll(() => !!document.querySelector(`.aps-${CSS.escape(id)}`), `screen ${id}`, cfg, o, dump) as Promise<true>,
    event(name, match, o) {
      const from = log.cursor()
      return poll(() => log.since(from).events.find((e) => e.type === name && (match === undefined || partialMatch(e.payload, match))), `event ${name}`, cfg, o, dump)
    },
  }
}
