// window.__ap.v1: the stable automation surface (ADR 0002 §4.1). Everything that changes state goes through cmd().
import { CONTENT, t } from '../../shared/content/index.ts'
import { diff, digest, describeMatcher, getPointer, matches } from '../../shared/dev/diff.ts'
import type { InputAction } from '../contracts.ts'
import type { EventLog } from './events.ts'
import type { DevHost } from './kit.ts'
import { CONSOLE, type Registry } from './registry.ts'
import { dumpState, SECTIONS, type RuntimeExtras, type Section } from './state.ts'
import { listEntries } from './lists.ts'
import { auditLayout } from './audit.ts'
import { axisFrames, holdFrames, pressFrames, type Frame, type Recording } from './replay.ts'
import { checkScenario, scenarioList } from './scenario.ts'
import { createShot } from './shot.ts'
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
  const hashOfContent = () => (contentHash ??= digest(CONTENT))
  const commit = () => (typeof __AP_COMMIT__ === 'string' ? __AP_COMMIT__ : 'unknown')
  const shot = createShot(host, () => digest(dump()), { settleFrames: L.shotSettleFrames, idleTimeoutMs: L.shotIdleTimeoutMs })
  const stepDt = L.stepDt
  /** Plays scripted frames; gives up (and says why) when the game does not tick them in time (page hidden, clock paused). */
  async function play(frames: readonly Frame[]): Promise<number> {
    if (frames.length > L.inputMaxFrames) throw new Error(t('dev.err.inputTooLong', { max: L.inputMaxFrames }))
    const timeoutMs = Math.max(L.waitTimeoutMs, frames.length * 100)
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<number>((_, bad) => { timer = setTimeout(() => { const n = host.input.cancel(); bad(new Error(t('dev.err.inputStalled', { n, total: frames.length }))) }, timeoutMs) })
    try { return await Promise.race([host.input.play(frames), guard]) } finally { clearTimeout(timer) }
  }
  let recordStart: string | null = null
  /** The start state of a recording: where the player is and whether a battle runs, not per-run ids, timers or cosmetic draws. */
  const startDigest = (): string => {
    const r = dump('runtime').runtime as Record<string, unknown>
    return digest({ position: r.position, map: r.map, mode: r.mode, battle: r.battle, scenario: r.scenario })
  }

  return {
    info: () => ({
      build: { devtools: true },
      commit: commit(),
      contentHash: hashOfContent(),
      worldSeed: host.world.seed,
      rngSeed: host.rng.seed,
      scenario: host.session.scenario,
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
    /** Pick lists: species, items, anchors, flags, ... (`query` filters by id or name, `limit` caps the result). */
    list: (source: string, query?: string, limit?: number) => listEntries(host, source, query, limit),
    scenario: {
      list: () => scenarioList(host),
      load: (id: string) => registry.run('scenario.load', { id }),
      /** Evaluates the loaded scenario's expectations against the live state. */
      check: () => checkScenario(host),
    },
    wait,
    /** Scripted and recorded input at the Input interface: fixed steps, the same frames give the same state. */
    input: {
      press: (a: InputAction) => play(pressFrames(a, stepDt)),
      hold: (a: InputAction, frames: number) => play(holdFrames(a, frames, stepDt)),
      axis: (x: number, y: number, frames: number) => play(axisFrames(x, y, frames, stepDt)),
      record() { recordStart = startDigest(); host.input.record() },
      stop(): Recording {
        return { version: 1, commit: commit(), contentHash: hashOfContent(), scenario: host.session.scenario, startDigest: recordStart ?? '', frames: host.input.stop() }
      },
      /** Refuses recordings made by another commit or content; reports whether the start state matched. */
      async replay(rec: Recording): Promise<{ frames: number; startMatches: boolean; digest: string }> {
        if (rec.version !== 1 || rec.commit !== commit() || rec.contentHash !== hashOfContent()) throw new Error(t('dev.err.replayVersion', { commit: rec.commit, now: commit() }))
        const startMatches = rec.startDigest === startDigest()
        const frames = await play(rec.frames)
        return { frames, startMatches, digest: digest(dump('save')) }
      },
    },
    /** Freezes time, hides the developer UI and lets the picture settle; call release() afterwards. */
    shot: { prepare: shot.prepare, release: shot.release },
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
      /** Throws when the visible UI has layout problems (off-screen controls, clipped text, overlaps, small touch targets). */
      layout(scope?: string): true {
        const issues = auditLayout({ scope, touchMinPx: L.touchMinPx, overlapMinArea: L.overlapMinArea, maxIssues: L.layoutIssueMax })
        if (issues.length) throw new Error(`${t('dev.expect.layoutFound', { n: issues.length })}\n${issues.slice(0, 8).map((i) => `${i.kind}: ${i.element} ${i.detail}`).join('\n')}`)
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
