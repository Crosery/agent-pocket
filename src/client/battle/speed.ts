// Battle clock: one multiplier (Settings.battleSpeed, table in content/config.json battleSpeeds) shared by every
// time consumer of a battle. Pure module: no DOM, so the consumers' pacing can be tested directly.
import type { Settings } from '../../shared/types.ts'
import { CONTENT } from '../../shared/content/index.ts'

type SpeedSetting = Pick<Settings, 'battleSpeed'>

/** The multiplier in force: Settings.battleSpeed when it is a configured scale, else the default. */
export function battleSpeedScale(s: SpeedSetting): number {
  const C = CONTENT.config
  return C.battleSpeeds.includes(s.battleSpeed) ? s.battleSpeed : C.defaultSettings.battleSpeed
}

/** Real elapsed seconds -> battle seconds (message typing). */
export function battleSec(dtSec: number, s: SpeedSetting): number {
  return dtSec * battleSpeedScale(s)
}

/** Real elapsed seconds -> battle milliseconds (holds, banners, auto-advance, scene waits). */
export function battleMs(dtSec: number, s: SpeedSetting): number {
  return battleSec(dtSec, s) * 1000
}

/** Real elapsed seconds -> stage updates: the scaled frame cut into steps of at most `maxStepSec` so fast-forwarded animation stays stable. */
export function stageSteps(dtSec: number, s: SpeedSetting, maxStepSec: number): number[] {
  let left = dtSec * battleSpeedScale(s)
  const out: number[] = []
  while (left > 1e-9) {
    const step = Math.min(left, maxStepSec)
    out.push(step)
    left -= step
  }
  return out
}

/** Real seconds the battle clock may consume this frame: none while an overlay holds the battle. */
export function gatedDt(dtSec: number, held: boolean): number {
  return held ? 0 : dtSec
}

/** True when any selector matches; `matches` is the document lookup, injected so the rule stays pure. */
export function anyMatch(selectors: readonly string[], matches: (selector: string) => boolean): boolean {
  return selectors.some(matches)
}

/** Wait queue on battle time: `advance` takes real seconds, so every hold shrinks with the multiplier. */
export interface Holds {
  wait(ms: number): Promise<void>
  advance(dtSec: number, s: SpeedSetting): void
  /** Resolves everything still waiting (scene teardown). */
  flush(): void
}

export function createHolds(): Holds {
  const waits: { left: number; done: () => void }[] = []
  return {
    wait(ms) {
      if (ms <= 0) return Promise.resolve()
      return new Promise<void>((done) => waits.push({ left: ms, done }))
    },
    advance(dtSec, s) {
      const ms = battleMs(dtSec, s)
      for (let i = waits.length - 1; i >= 0; i--) {
        waits[i].left -= ms
        if (waits[i].left <= 0) waits.splice(i, 1)[0].done()
      }
    },
    flush() {
      for (const w of waits.splice(0)) w.done()
    },
  }
}
