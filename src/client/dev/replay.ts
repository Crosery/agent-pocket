// Input at the Input interface (ADR 0002 §4.5): records every frame's held / pressed / repeat / released sets, the
// movement axis and the frame's dt; plays recordings back, and scripted presses and holds, through a stand-in Input,
// so the game runs the same fixed steps with the same input. Wrapped around createInput in game.ts (DevKit.wrapInput).
import type { Input, InputAction } from '../contracts.ts'

const ACTION_SET: Record<InputAction, true> = {
  up: true, down: true, left: true, right: true, confirm: true, cancel: true, menu: true, run: true, map: true,
  chat: true, minimap: true, bike: true, quickSave: true, debug: true, bag: true,
}
export const ACTIONS = Object.keys(ACTION_SET) as InputAction[]
const bit = (a: InputAction): number => 1 << ACTIONS.indexOf(a)

/** [dt seconds, axis x, axis y, held mask, pressed mask, repeat-pressed mask, released mask] (masks over ACTIONS). */
export type Frame = [number, number, number, number, number, number, number]

export interface Recording {
  version: 1
  commit: string
  contentHash: string
  scenario: string | null
  /** Digest of the save when recording started: a replay from another state is reported, not refused. */
  startDigest: string
  frames: Frame[]
}

export interface InputTap extends Input {
  readonly recording: boolean
  readonly playing: boolean
  record(): void
  /** Ends recording and returns the frames. */
  stop(): Frame[]
  /** Replays frames, one per game frame; resolves with the number played when the last one has been consumed. */
  play(frames: readonly Frame[]): Promise<number>
  /** Stops playing now; resolves the pending play with the frames consumed so far. */
  cancel(): number
  /** dt of the frame being played, or null when nothing plays (the clock then decides). */
  currentDt(): number | null
  /** False while the game does not tick (paused, hidden): scripted frames wait. */
  readonly armed: boolean
  setArmed(on: boolean): void
}

export const pressFrames = (a: InputAction, dt: number): Frame[] => [
  [dt, 0, 0, bit(a), bit(a), bit(a), 0],
  [dt, 0, 0, 0, 0, 0, bit(a)],
]

/** `n` frames with the action down (pressed on the first, released after the last). */
export function holdFrames(a: InputAction, n: number, dt: number): Frame[] {
  const out: Frame[] = []
  for (let i = 0; i < n; i++) out.push([dt, 0, 0, bit(a), i === 0 ? bit(a) : 0, i === 0 ? bit(a) : 0, 0])
  out.push([dt, 0, 0, 0, 0, 0, bit(a)])
  return out
}

export const axisFrames = (x: number, y: number, n: number, dt: number): Frame[] => Array.from({ length: n }, () => [dt, x, y, 0, 0, 0, 0] as Frame)

/**
 * `dtSource` is the dt the game runs the current frame with (recorded with each frame). Scripted frames only advance
 * while the frame is armed, i.e. while the game really ticks (not while paused or hidden).
 */
export function createInputTap(real: Input, dtSource: () => number): InputTap {
  let recorded: Frame[] | null = null
  let script: Frame[] | null = null
  let at = 0
  let done: ((n: number) => void) | null = null
  let armed = true
  /** The first read of a frame snapshots it for the recording. */
  let snapped = false

  const frame = (): Frame | null => (script ? script[at] ?? null : null)

  const snapshot = (): void => {
    if (!recorded || snapped) return
    snapped = true
    const mask = (f: (a: InputAction) => boolean) => ACTIONS.reduce((m, a) => (f(a) ? m | bit(a) : m), 0)
    const ax = real.axis()
    recorded.push([dtSource(), ax.x, ax.y, mask((a) => real.held(a)), mask((a) => real.pressed(a)), mask((a) => real.pressed(a, true)), mask((a) => real.released(a))])
  }

  return {
    get recording() { return recorded !== null },
    get playing() { return script !== null },
    get armed() { return armed },
    setArmed(on) { armed = on },
    record() { recorded = []; snapped = false },
    stop() { const r = recorded ?? []; recorded = null; return r },
    play(frames) {
      if (script) return Promise.reject(new Error('already playing'))
      if (frames.length === 0) return Promise.resolve(0)
      script = frames.slice()
      at = 0
      return new Promise((ok) => { done = ok })
    },
    cancel() { const n = at; script = null; at = 0; const d = done; done = null; d?.(n); return n },
    currentDt: () => frame()?.[0] ?? null,
    axis() { const f = frame(); if (f) return { x: f[1], y: f[2] }; snapshot(); return real.axis() },
    held(a) { const f = frame(); if (f) return (f[3] & bit(a)) !== 0; snapshot(); return real.held(a) },
    pressed(a, repeat = false) { const f = frame(); if (f) return ((repeat ? f[5] : f[4]) & bit(a)) !== 0; snapshot(); return real.pressed(a, repeat) },
    released(a) { const f = frame(); if (f) return (f[6] & bit(a)) !== 0; snapshot(); return real.released(a) },
    consume(a) { if (!script) real.consume(a) },
    endFrame() {
      real.endFrame()
      snapped = false
      if (script && armed) {
        at++
        if (at >= script.length) { const n = script.length; script = null; at = 0; const d = done; done = null; d?.(n) }
      }
    },
    setTextInputActive: (on) => real.setTextInputActive(on),
    get lastDevice() { return real.lastDevice },
    setTouchControlsVisible: (v) => real.setTouchControlsVisible(v),
    refreshTouchLayout: () => real.refreshTouchLayout(),
    // World taps (tap-to-move) are DOM pointer input and are not recorded, like other mouse clicks (ADR 0002 §4.5).
    onWorldTap: (fn) => real.onWorldTap(fn),
  }
}
