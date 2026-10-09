// Time and random-seed controls. They steer the test environment, not the save, so they do not taint a session.
import { CONSOLE, DevError, type CommandRun } from '../registry.ts'

const L = CONSOLE.limits
const bad = (arg: string, key: string, params: Record<string, number>) => new DevError('dev.err.badArg', { arg, why: new DevError(key, params).message })

export const determinismCommands: Record<string, CommandRun> = {
  'time.pause': ({ clock }) => { clock.pause(); return clock.state() },
  'time.resume': ({ clock }) => { clock.resume(); return clock.state() },
  'time.scale': ({ clock }, a) => {
    const x = a.scale as number
    if (!(x >= 0 && x <= L.maxScale)) throw bad('scale', 'dev.err.scaleRange', { max: L.maxScale })
    clock.scale(x)
    return clock.state()
  },
  'time.fixed': ({ clock }, a) => {
    const dt = a.dt as number | undefined
    if (dt !== undefined && !(dt > 0 && dt <= 1)) throw bad('dt', 'dev.err.dtRange', { max: 1 })
    clock.fixed(dt ?? null)
    return clock.state()
  },
  'time.step': ({ clock, tick }, a) => {
    const frames = a.frames as number
    const dt = (a.dt as number | undefined) ?? L.stepDt
    if (!(frames >= 1 && frames <= L.maxStepFrames)) throw bad('frames', 'dev.err.framesRange', { max: L.maxStepFrames })
    if (!(dt > 0 && dt <= 1)) throw bad('dt', 'dev.err.dtRange', { max: 1 })
    clock.step(frames, dt, tick)
    return clock.state()
  },
  'rng.seed': ({ rng }, a) => {
    const seed = a.seed as number
    if (!(seed >= 0 && seed <= 0xffffffff)) throw new DevError('dev.err.badArg', { arg: 'seed', why: new DevError('dev.err.seedRange').message })
    rng.reseed(seed)
    return { seed: rng.seed, cursors: rng.cursors() }
  },
}
