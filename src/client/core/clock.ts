import type { SaveData, TimeOfDay } from '../../shared/types.ts'
import type { GameClock } from '../contracts.ts'
import { CONTENT, timeOfDayAt } from '../../shared/content/index.ts'
import type { Content } from '../../shared/content/index.ts'

/** Calendar structure (not tunable): minutes per in-game day. */
const MINUTES_PER_DAY = 24 * 60

/**
 * In-game clock. Minutes are mirrored into `save.clockMinutes` on every change so the save
 * object passed in always holds the current time.
 */
export function createClock(save: SaveData, c: Content = CONTENT): GameClock {
  const startMinutes = c.config.time.startMinutes
  let minutes = Number.isFinite(save.clockMinutes) && save.clockMinutes >= 0 ? save.clockMinutes : startMinutes
  save.clockMinutes = minutes

  const setMinutes = (v: number) => {
    minutes = Number.isFinite(v) && v >= 0 ? v : 0
    save.clockMinutes = minutes
  }

  return {
    get minutes() { return minutes },
    set minutes(v: number) { setMinutes(v) },
    get minutesOfDay() { return Math.floor(minutes % MINUTES_PER_DAY) },
    get timeOfDay(): TimeOfDay { return timeOfDayAt(minutes, c) },
    update(dtSec: number) {
      const daySec = c.config.time.dayRealSeconds
      if (!(dtSec > 0) || !(daySec > 0)) return
      setMinutes(minutes + (dtSec * MINUTES_PER_DAY) / daySec)
    },
    label() { return formatClock(minutes) },
  }
}

/** "HH:MM" of an absolute minute count. */
export function formatClock(minutes: number): string {
  const m = ((Math.floor(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
