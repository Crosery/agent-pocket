// Developer control over game time: pause, fixed step, scale, and stepping frames by hand (ADR 0002 §4.3).
// game.ts asks frameDt() for every real animation frame; null means "do not advance the game this frame".

export interface DevClockState { paused: boolean; scale: number; fixed: number | null; stepped: number }

export interface DevClock {
  /** Seconds to simulate for a real frame of `real` seconds, or null while paused. */
  frameDt(real: number): number | null
  pause(): void
  resume(): void
  /** Multiplies real frame time (1 = normal). */
  scale(x: number): void
  /** Every real frame advances exactly `dt` seconds (null = back to real time); makes frame-based replays repeatable. */
  fixed(dt: number | null): void
  /** Runs `frames` game frames of `dt` seconds each through `tick`, regardless of pause. */
  step(frames: number, dt: number, tick: (dtSec: number) => void): number
  /** Holds the in-game day clock (the HUD clock stops advancing) while frames keep running. */
  hold(on: boolean): void
  held(): boolean
  state(): DevClockState
}

export function createDevClock(): DevClock {
  let paused = false
  let scale = 1
  let fixed: number | null = null
  let stepped = 0
  let held = false
  return {
    hold: (on) => { held = on },
    held: () => held,
    frameDt: (real) => (paused ? null : fixed ?? real * scale),
    pause: () => { paused = true },
    resume: () => { paused = false },
    scale: (x) => { scale = x },
    fixed: (dt) => { fixed = dt },
    step(frames, dt, tick) {
      for (let i = 0; i < frames; i++) tick(dt)
      stepped += frames
      return stepped
    },
    state: () => ({ paused, scale, fixed, stepped }),
  }
}
