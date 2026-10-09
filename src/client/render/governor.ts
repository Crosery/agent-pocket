// Frame-time governor: sheds render cost step by step when frames run long and takes it back when there is headroom.
// Pure state machine (no three.js, no DOM) so node tests drive it; the renderer applies the steps (render.json governor.steps).

export interface GovernorConfig {
  enabled: boolean
  /** localStorage key remembering the level this device settled on (device-wide, not part of a save). */
  storageKey: string
  /** Frames per measurement window. */
  windowFrames: number
  /** Intervals longer than this are not measured (tab switch, load, transition). */
  skipAboveMs: number
  /** Window mean frame interval above this, with the frame work above downWorkMs, sheds a step. */
  downAboveMs: number
  downWorkMs: number
  /** A mean interval above this sheds a step even when the work looks cheap (GPU-bound); keep it under the 30 Hz cap of power-saving modes. */
  hardAboveMs: number
  /** Window mean interval below this and work below upBelowWorkMs counts toward taking a step back. */
  upBelowMs: number
  upBelowWorkMs: number
  /** Consecutive slow windows before shedding / consecutive fast windows before restoring. */
  downWindows: number
  upWindows: number
  /** Seconds after any change before the next one. */
  cooldownSeconds: number
  /** Seconds the level may not go back up after shedding right after a restore (stops oscillation). */
  upLockSeconds: number
}

export interface Governor {
  /** Current shedding level: 0 = full quality, `steps` = everything shed. */
  readonly level: number
  /** One rendered frame: `intervalMs` since the previous one, `workMs` the main thread spent on it. Returns the new level when it changed. */
  feed(intervalMs: number, workMs: number, nowSec: number): number | null
  /** Drops the running window and cooldown (device or settings changed). */
  reset(level?: number): void
}

export function createGovernor(cfg: GovernorConfig, steps: number): Governor {
  let level = 0
  let n = 0
  let sumInterval = 0
  let sumWork = 0
  let slow = 0
  let fast = 0
  let quietUntil = 0
  let upLockedUntil = 0
  let lastRestoreAt = -Infinity

  const clearWindow = () => { n = 0; sumInterval = 0; sumWork = 0 }
  return {
    get level() { return level },
    reset(to = 0) { level = Math.max(0, Math.min(steps, to)); clearWindow(); slow = 0; fast = 0; quietUntil = 0; upLockedUntil = 0 },
    feed(intervalMs, workMs, nowSec) {
      if (!cfg.enabled || steps <= 0 || !(intervalMs > 0) || intervalMs > cfg.skipAboveMs) return null
      sumInterval += intervalMs
      sumWork += workMs
      if (++n < cfg.windowFrames) return null
      const interval = sumInterval / n
      const work = sumWork / n
      clearWindow()
      if (nowSec < quietUntil) { slow = 0; fast = 0; return null }
      const isSlow = (interval > cfg.downAboveMs && work > cfg.downWorkMs) || interval > cfg.hardAboveMs
      const isFast = interval < cfg.upBelowMs && work < cfg.upBelowWorkMs
      slow = isSlow ? slow + 1 : 0
      fast = isFast && !isSlow ? fast + 1 : 0
      if (slow >= cfg.downWindows && level < steps) {
        // shedding soon after a restore means the restore was wrong: hold the level for a while
        if (nowSec - lastRestoreAt < cfg.cooldownSeconds * 4) upLockedUntil = nowSec + cfg.upLockSeconds
        level++
        slow = 0; fast = 0
        quietUntil = nowSec + cfg.cooldownSeconds
        return level
      }
      if (fast >= cfg.upWindows && level > 0 && nowSec >= upLockedUntil) {
        level--
        slow = 0; fast = 0
        lastRestoreAt = nowSec
        quietUntil = nowSec + cfg.cooldownSeconds
        return level
      }
      return null
    },
  }
}
