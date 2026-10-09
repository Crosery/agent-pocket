// window.__ap.v1: the stable automation surface (ADR 0002 §4.1). Everything that changes state goes through cmd().
import { CONTENT, t } from '../../shared/content/index.ts'
import { diff, digest, describeMatcher, getPointer, matches } from './diff.ts'
import type { EventLog } from './events.ts'
import type { DevHost } from './kit.ts'
import { CONSOLE, type Registry } from './registry.ts'
import { dumpState, SECTIONS, type RuntimeExtras, type Section } from './state.ts'
import { createWaiters } from './wait.ts'

declare const __AP_COMMIT__: string | undefined

export interface ApiDeps { host: DevHost; registry: Registry; log: EventLog; extras: RuntimeExtras }

const ERROR_LINE = /^(error|uncaught|rejection):|frame error/

const sectionsOf = (s?: Section | readonly Section[]): readonly Section[] => (s === undefined ? SECTIONS : typeof s === 'string' ? [s] : s)

export function createApiV1({ host, registry, log, extras }: ApiDeps) {
  const L = CONSOLE.limits
  const dump = (s?: Section | readonly Section[]) => dumpState(host, log, extras, sectionsOf(s))
  const consoleLines = (): string[] => ((window as unknown as { __AP_LOG?: string[] }).__AP_LOG ?? []).slice(-L.logLines)
  const timeoutDump = () => JSON.stringify(dump('runtime')).slice(0, L.dumpMaxChars)
  const wait = createWaiters(host, log, { timeoutMs: L.waitTimeoutMs, pollMs: L.waitPollMs }, timeoutDump)
  let contentHash: string | null = null

  return {
    info: () => ({
      build: { devtools: true },
      commit: typeof __AP_COMMIT__ === 'string' ? __AP_COMMIT__ : 'unknown',
      contentHash: (contentHash ??= digest(CONTENT)),
      worldSeed: host.world.seed,
      rngSeed: host.rng.seed,
      taint: { ...registry.taint },
    }),
    cmd: (id: string, args?: Record<string, unknown>) => registry.run(id, args),
    cmds: () => registry.describe(),
    state: {
      dump,
      diff: (a: unknown, b: unknown) => diff(a, b),
      digest: (s?: Section | readonly Section[]) => digest(dump(s)),
    },
    time: {
      pause: () => registry.run('time.pause'),
      resume: () => registry.run('time.resume'),
      /** Runs `frames` game frames of `dt` seconds (default 1/60) right now; pause first for a fully manual clock. */
      step: (frames: number, dt?: number) => registry.run('time.step', { frames, dt }),
      scale: (x: number) => registry.run('time.scale', { scale: x }),
      /** Every real frame advances exactly `dt` seconds (null = real time). */
      fixed: (dt: number | null = null) => registry.run('time.fixed', { dt }),
      state: () => host.clock.state(),
    },
    rng: {
      seed: (n: number) => registry.run('rng.seed', { seed: n }),
      /** Draws taken from each random stream since the last (re)seed. */
      cursor: () => host.rng.cursors(),
    },
    wait,
    expect: {
      /** Throws unless the value at `pointer` (e.g. /save/money) satisfies `matcher` (a bare value means eq). */
      state(pointer: string, matcher: unknown): true {
        const section = pointer.split('/')[1] as Section
        const doc = dump(SECTIONS.includes(section) ? section : undefined)
        const { found, value } = getPointer(doc, pointer)
        if (!found && !(typeof matcher === 'object' && matcher !== null && 'exists' in matcher)) throw new Error(t('dev.expect.missing', { path: pointer }))
        if (!matches(found, value, matcher)) {
          throw new Error(t('dev.expect.failed', { path: pointer, matcher: describeMatcher(matcher), actual: JSON.stringify(value) }))
        }
        return true
      },
      noErrors(): true {
        const bad = consoleLines().filter((l) => ERROR_LINE.test(l))
        if (bad.length) throw new Error(`${t('dev.expect.errorsFound', { n: bad.length })}\n${bad.slice(0, 5).join('\n')}`)
        return true
      },
    },
    events: { since: (cursor = 0) => log.since(cursor) },
    log: consoleLines,
  }
}

export type ApiV1 = ReturnType<typeof createApiV1>

/** Attaches v1 to window.__ap and flags the pre-registry hooks as deprecated (one hint per name, console.info). */
export function mountApi(api: ApiV1): void {
  const w = window as unknown as { __ap?: Record<string, unknown> }
  const root = (w.__ap ??= {})
  const warned = new Set<string>()
  for (const [name, use] of Object.entries(CONSOLE.legacy)) {
    const fn = root[name]
    if (typeof fn !== 'function') continue
    root[name] = (...args: unknown[]) => {
      if (!warned.has(name)) { warned.add(name); console.info(t('dev.deprecated', { name, use })) }
      return (fn as (...a: unknown[]) => unknown)(...args)
    }
  }
  root.version = 1
  root.v1 = api
}
